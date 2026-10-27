#include "net.h"
#include <WiFi.h>
#include <esp_task_wdt.h>
#include <esp_http_client.h>
#include <esp_idf_version.h>
#include <mbedtls/md.h>
#include <mqtt_client.h>
#include <sys/time.h>
#include <string>
#include "cache.h"
#include "config.h"
#include "lock.h"
#include "secrets.h"
#include "state.h"

// Bundle de CAs raíz de ESP-IDF (CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL en el core Arduino).
// Se declara a mano porque el <esp_crt_bundle.h> de la librería WiFiClientSecure de Arduino oculta el de IDF.
extern "C" esp_err_t esp_crt_bundle_attach(void* conf);

// ============================================================================
//  Verificación de comandos
// ============================================================================
namespace {
char     s_seen[CMD_REPLAY_SLOTS][37];
uint8_t  s_seenIdx = 0;

bool hmacHex(const char* msg, char out[65]) {
  uint8_t mac[32];
  const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (mbedtls_md_hmac(md, (const uint8_t*)DEVICE_CMD_KEY, strlen(DEVICE_CMD_KEY), (const uint8_t*)msg, strlen(msg), mac) != 0) return false;
  static const char* H = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { out[2 * i] = H[mac[i] >> 4]; out[2 * i + 1] = H[mac[i] & 0xF]; }
  out[64] = 0;
  return true;
}

bool constEq(const char* a, const char* b, size_t n) {
  uint8_t d = 0;
  for (size_t i = 0; i < n; i++) d |= (uint8_t)a[i] ^ (uint8_t)b[i];
  return d == 0;
}
}  // namespace

bool verifyCommand(JsonDocument& doc, const char** err) {
  const char* id  = doc["id"]  | "";
  const char* cmd = doc["cmd"] | "";
  const char* arg = doc["arg"] | "";
  const char* sig = doc["sig"] | "";
  uint32_t iat = doc["iat"] | 0u;
  uint32_t exp = doc["exp"] | 0u;

  if ((doc["v"] | 0) != 1 || strlen(id) != 36 || !*cmd || strlen(sig) != 64) { *err = "formato"; return false; }
  if (!timeValid()) { *err = "sin_hora"; return false; }            // sin hora no se puede comprobar exp: se rechaza
  uint32_t now = nowEpoch();
  if (now + CMD_SKEW_S < iat || now > exp + CMD_SKEW_S || exp < iat || exp - iat > 300) { *err = "vencido"; return false; }

  char msg[160], mac[65];
  snprintf(msg, sizeof msg, "%s|%s|%s|%lu|%lu", id, cmd, arg, (unsigned long)iat, (unsigned long)exp);
  if (!hmacHex(msg, mac) || !constEq(mac, sig, 64)) { *err = "firma"; return false; }

  for (auto& s : s_seen) if (strcmp(s, id) == 0) { *err = "repetido"; return false; }
  strlcpy(s_seen[s_seenIdx], id, 37);
  s_seenIdx = (s_seenIdx + 1) % CMD_REPLAY_SLOTS;
  return true;
}

// ============================================================================
//  HTTPS a device-ingest (esp_http_client: conexión persistente + bundle de CAs)
// ============================================================================
namespace {
esp_http_client_handle_t s_http = nullptr;
std::string              s_resp;
uint32_t                 s_lastApiOk = 0;

esp_err_t httpEvent(esp_http_client_event_t* e) {
  if (e->event_id == HTTP_EVENT_ON_DATA && s_resp.size() + e->data_len <= HTTP_MAX_RESPONSE)
    s_resp.append((const char*)e->data, e->data_len);
  return ESP_OK;
}

void httpInit() {
  esp_http_client_config_t c = {};
  c.url = INGEST_URL;
  c.method = HTTP_METHOD_POST;
  c.timeout_ms = HTTP_TIMEOUT_MS;
  c.event_handler = httpEvent;
  c.crt_bundle_attach = esp_crt_bundle_attach;   // valida el certificado del servidor (nunca "insecure")
  c.keep_alive_enable = true;
  c.buffer_size = 2048;
  c.buffer_size_tx = 1024;
  s_http = esp_http_client_init(&c);
  esp_http_client_set_header(s_http, "Content-Type", "application/json");
  esp_http_client_set_header(s_http, "x-device-code", DEVICE_CODE);
  esp_http_client_set_header(s_http, "Authorization", "Bearer " DEVICE_API_KEY);
  esp_http_client_set_header(s_http, "apikey", SUPABASE_KEY);
}

/** POST JSON. Devuelve el código HTTP (o -1 si no hubo conexión) y la respuesta parseada en `res`. */
int apiPost(JsonDocument& req, JsonDocument& res) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  if (!s_http) httpInit();
  std::string body;
  serializeJson(req, body);
  s_resp.clear();
  esp_http_client_set_post_field(s_http, body.c_str(), body.size());
  esp_err_t err = esp_http_client_perform(s_http);
  if (err != ESP_OK) {
    log_w("HTTPS falló: %s", esp_err_to_name(err));
    esp_http_client_cleanup(s_http);   // fuerza una conexión nueva en el próximo intento
    s_http = nullptr;
    return -1;
  }
  int status = esp_http_client_get_status_code(s_http);
  res.clear();
  if (deserializeJson(res, s_resp.data(), s_resp.size()) != DeserializationError::Ok) res.clear();
  if (status == 200) s_lastApiOk = millis();
  if (status == 401) log_e("device-ingest rechazó las credenciales: revisa DEVICE_CODE / DEVICE_API_KEY / key_version");
  return status;
}

void updateOnline() {
  g_online = WiFi.status() == WL_CONNECTED && s_lastApiOk && msDiff(millis(), s_lastApiOk) < (int32_t)API_STALE_MS;
}

bool ack(const char* commandId, bool ok, const char* error = nullptr) {
  JsonDocument req, res;
  req["type"] = "ack";
  req["command_id"] = commandId;
  req["ok"] = ok;
  if (error) req["error"] = error;
  return apiPost(req, res) == 200;
}

// ============================================================================
//  Hora: SNTP y, como respaldo autenticado, la hora del servidor en cada latido
// ============================================================================
void maybeSetClock(uint32_t serverEpoch) {
  if (serverEpoch < 1700000000) return;
  int32_t drift = (int32_t)(serverEpoch - nowEpoch());
  if (!timeValid() || drift > 10 || drift < -10) {
    timeval tv{(time_t)serverEpoch, 0};
    settimeofday(&tv, nullptr);
    log_i("Reloj ajustado con la hora del servidor (deriva %ld s)", (long)drift);
  }
}

// ============================================================================
//  MQTT (esp-mqtt: tarea propia, reconexión automática, nunca bloquea al lector)
// ============================================================================
struct MqttMsg { uint16_t len; char data[512]; };
QueueHandle_t            s_cmdQueue = nullptr;
esp_mqtt_client_handle_t s_mqtt = nullptr;
char                     s_topicCmd[64], s_topicStatus[64];

void mqttEvent(void*, esp_event_base_t, int32_t eventId, void* data) {
  auto* e = (esp_mqtt_event_handle_t)data;
  switch ((esp_mqtt_event_id_t)eventId) {
    case MQTT_EVENT_CONNECTED:
      g_mqttUp = true;
      esp_mqtt_client_subscribe(s_mqtt, s_topicCmd, 1);
      esp_mqtt_client_publish(s_mqtt, s_topicStatus, "online", 0, 1, 1);
      log_i("MQTT conectado");
      break;
    case MQTT_EVENT_DISCONNECTED:
      g_mqttUp = false;
      log_w("MQTT desconectado (reintenta solo)");
      break;
    case MQTT_EVENT_DATA:
      // Solo mensajes completos y pequeños del tópico de comandos.
      if (e->topic_len == (int)strlen(s_topicCmd) && strncmp(e->topic, s_topicCmd, e->topic_len) == 0 &&
          e->data_len > 0 && e->data_len < (int)sizeof(MqttMsg::data) && e->total_data_len == e->data_len) {
        MqttMsg m;
        m.len = e->data_len;
        memcpy(m.data, e->data, e->data_len);
        m.data[m.len] = 0;
        xQueueSend(s_cmdQueue, &m, 0);
      }
      break;
    default:
      break;
  }
}

void mqttStart() {
  snprintf(s_topicCmd, sizeof s_topicCmd, "acc/v1/%s/cmd", DEVICE_CODE);
  snprintf(s_topicStatus, sizeof s_topicStatus, "acc/v1/%s/status", DEVICE_CODE);
  esp_mqtt_client_config_t c = {};
#if ESP_IDF_VERSION_MAJOR >= 5
  c.broker.address.uri = MQTT_URI;
  c.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
  c.credentials.username = MQTT_USER;
  c.credentials.authentication.password = MQTT_PASS;
  c.credentials.client_id = DEVICE_CODE;
  c.session.last_will.topic = s_topicStatus;
  c.session.last_will.msg = "offline";
  c.session.last_will.qos = 1;
  c.session.last_will.retain = 1;
  c.session.keepalive = 30;
  c.network.reconnect_timeout_ms = 5000;
  c.network.timeout_ms = 8000;
  c.task.stack_size = 6144;
#else
  c.uri = MQTT_URI;
  c.crt_bundle_attach = esp_crt_bundle_attach;
  c.username = MQTT_USER;
  c.password = MQTT_PASS;
  c.client_id = DEVICE_CODE;
  c.lwt_topic = s_topicStatus;
  c.lwt_msg = "offline";
  c.lwt_qos = 1;
  c.lwt_retain = 1;
  c.keepalive = 30;
  c.reconnect_timeout_ms = 5000;
  c.network_timeout_ms = 8000;
  c.task_stack = 6144;
#endif
  s_mqtt = esp_mqtt_client_init(&c);
  esp_mqtt_client_register_event(s_mqtt, (esp_mqtt_event_id_t)ESP_EVENT_ANY_ID, mqttEvent, nullptr);
  esp_mqtt_client_start(s_mqtt);
}

/** Ejecuta un comando ya verificado y envía el ACK por HTTPS. */
void handleCommand(const MqttMsg& m) {
  JsonDocument doc;
  if (deserializeJson(doc, m.data, m.len) != DeserializationError::Ok) return;
  const char* err = nullptr;
  if (!verifyCommand(doc, &err)) {
    log_w("Comando rechazado (%s)", err);
    return;   // sin ACK: el servidor lo marcará como expirado
  }
  const char* id = doc["id"];
  String cmd = doc["cmd"].as<const char*>();
  const char* arg = doc["arg"] | "";
  log_i("Comando %s (%s)", cmd.c_str(), arg);

  bool ok = true;
  if (cmd == "unlock") {
    uint32_t ms = strtoul(arg, nullptr, 10);
    Lock::pulse(ms ? ms : Lock::defaultUnlockMs());
    Feedback::signal(Feedback::Granted);
  } else if (cmd == "hold_open") {
    uint32_t minutes = constrain(strtoul(arg, nullptr, 10), 1UL, 240UL);
    Lock::holdOpenUntil(nowEpoch() + minutes * 60);
  } else if (cmd == "release") {
    Lock::holdOpenUntil(0);
  } else if (cmd == "lockdown_on") {
    Lock::setLockdown(true);
  } else if (cmd == "lockdown_off") {
    Lock::setLockdown(false);
  } else if (cmd == "enroll_start") {
    enrollStart(arg);
    Feedback::signal(Feedback::EnrollArmed);
  } else if (cmd == "enroll_cancel") {
    enrollCancel(arg);
  } else {
    ok = false;
  }
  ack(id, ok, ok ? nullptr : "comando desconocido");
}

// ============================================================================
//  Peticiones del lector
// ============================================================================
struct { uint32_t seq; bool httpOk; } s_lastAccess = {0, false};

void handleRequest(const NetRequest& r) {
  if (r.type == ReqType::Access) {
    AccessResponse resp{};
    resp.seq = r.seq;
    s_lastAccess = {r.seq, false};
    if (msDiff(millis(), r.deadlineMs) >= 0) return;           // el lector ya decidió con la caché
    JsonDocument req, res;
    req["type"] = "access";
    req["uid"] = r.uid;
    int st = apiPost(req, res);
    if (st == 200 && res["ok"] == true) {
      s_lastAccess.httpOk = true;
      resp.ok = true;
      resp.granted = res["granted"] | false;
      resp.unlockMs = res["unlock_ms"] | Lock::defaultUnlockMs();
      strlcpy(resp.reason, res["reason"] | "", sizeof resp.reason);
    }
    xQueueOverwrite(g_accessResp, &resp);
  } else if (r.type == ReqType::Fallback) {
    // Si la petición online llegó al servidor, este ya registró el intento: no duplicar.
    if (!(s_lastAccess.seq == r.seq && s_lastAccess.httpOk)) Cache::pushEvent("access", r.uid, r.granted, r.reason);
  } else if (r.type == ReqType::EnrollRead) {
    JsonDocument req, res;
    req["type"] = "enroll_read";
    req["session_id"] = r.session;
    req["uid"] = r.uid;
    int st = apiPost(req, res);
    bool ok = st == 200 && res["ok"] == true;
    Feedback::signal(ok ? Feedback::EnrollOk : Feedback::EnrollFail);
    if (!ok) log_w("Registro fallido: %s", res["error"] | "sin conexión");
  }
}

// ============================================================================
//  Tareas periódicas
// ============================================================================
uint32_t s_lastHeartbeat = 0, s_lastSync = 0, s_lastFlush = 0;
bool     s_syncNeeded = true;

void heartbeat() {
  JsonDocument req, res;
  bool known;
  bool closed = Lock::doorClosed(&known);
  req["type"] = "heartbeat";
  req["ip"] = WiFi.localIP().toString();
  req["rssi"] = WiFi.RSSI();
  req["lock_state"] = Lock::isUnlocked() ? "unlocked" : "locked";
  if (known) req["door_closed"] = closed;
  req["fw"] = FW_VERSION;
  req["uptime"] = (uint32_t)(millis() / 1000);
  req["heap"] = ESP.getFreeHeap();
  req["mqtt"] = g_mqttUp.load();
  if (apiPost(req, res) != 200 || res["ok"] != true) return;

  maybeSetClock(res["server_time"] | 0u);
  g_disabled = !(res["is_active"] | true);
  Lock::setDefaultUnlockMs(res["unlock_ms"] | DEFAULT_UNLOCK_MS);
  // El servidor es la fuente de verdad: si se perdió un comando MQTT, el latido lo corrige.
  Lock::setLockdown(res["lockdown"] | false);
  Lock::holdOpenUntil(res["hold_open_until"].isNull() ? 0 : res["hold_open_until"].as<uint32_t>());
  const char* v = res["allowlist_version"] | "";
  if (*v && Cache::version() != v) s_syncNeeded = true;
}

void syncAllowlist() {
  JsonDocument req, res;
  req["type"] = "allowlist";
  int st = apiPost(req, res);
  if (st != 200 || res["ok"] != true) {
    if (st == 200 && s_resp.size() >= HTTP_MAX_RESPONSE) log_e("Lista blanca demasiado grande para la RAM (> %u bytes)", (unsigned)HTTP_MAX_RESPONSE);
    return;
  }
  JsonArrayConst entries = res["entries"].as<JsonArrayConst>();
  bool saved = Cache::replace(entries, res["version"] | "", res["utc_offset_min"] | 0);
  s_syncNeeded = !saved;
  s_lastSync = millis();
  if (entries.size() > ALLOWLIST_MAX_ENTRIES) log_w("La lista tiene %u UIDs; la caché offline guarda solo %u", (unsigned)entries.size(), (unsigned)ALLOWLIST_MAX_ENTRIES);
  log_i("Lista blanca sincronizada: %u UIDs%s (heap libre %u)", (unsigned)entries.size(), saved ? "" : " (NO se pudo guardar en flash)", ESP.getFreeHeap());
}

void flushEvents() {
  if (!Cache::pendingEvents()) return;
  JsonDocument req, res;
  req["type"] = "events";
  size_t n = Cache::peekEvents(req["events"].to<JsonArray>(), EVENTS_BATCH);
  if (apiPost(req, res) == 200 && res["ok"] == true) {
    Cache::dropEvents(n);
    log_i("Subidos %u eventos offline", (unsigned)n);
  }
}

// ============================================================================
//  WiFi no bloqueante
// ============================================================================
uint32_t s_wifiAttempt = 0;
bool     s_wasConnected = false;
bool     s_sntpStarted = false;

void wifiTick() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up && !s_wasConnected) {
    log_i("WiFi conectado: %s  RSSI %d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!s_sntpStarted) { configTime(0, 0, "pool.ntp.org", "time.google.com"); s_sntpStarted = true; }
    if (!s_mqtt) mqttStart();
    s_lastHeartbeat = 0;   // latido inmediato tras reconectar
  }
  if (!up && s_wasConnected) log_w("WiFi perdido: modo offline con caché local");
  s_wasConnected = up;
  if (!up && msDiff(millis(), s_wifiAttempt) > (int32_t)WIFI_RETRY_MS) {
    s_wifiAttempt = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);   // no bloquea: el resultado se ve en el siguiente tick
  }
}

}  // namespace

// ============================================================================
//  Bucle de la tarea
// ============================================================================
void netTask(void*) {
  esp_task_wdt_add(nullptr);
  s_cmdQueue = xQueueCreate(6, sizeof(MqttMsg));

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // menor latencia para comandos y peticiones
  WiFi.setAutoReconnect(true);
  WiFi.setHostname(DEVICE_CODE);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  s_wifiAttempt = millis();

  for (;;) {
    esp_task_wdt_reset();
    wifiTick();
    updateOnline();

    MqttMsg m;
    while (xQueueReceive(s_cmdQueue, &m, 0) == pdTRUE) handleCommand(m);   // comandos primero (apertura remota)

    NetRequest r;
    if (xQueueReceive(g_netQueue, &r, pdMS_TO_TICKS(100)) == pdTRUE) { handleRequest(r); continue; }

    if (WiFi.status() != WL_CONNECTED) continue;
    uint32_t now = millis();
    if (!s_lastHeartbeat || msDiff(now, s_lastHeartbeat) > (int32_t)HEARTBEAT_MS) { s_lastHeartbeat = now; heartbeat(); continue; }
    bool syncDue = s_syncNeeded ? (!s_lastSync || msDiff(now, s_lastSync) > (int32_t)SYNC_RETRY_MS)
                                : msDiff(now, s_lastSync) > (int32_t)ALLOWLIST_REFRESH_MS;
    if (syncDue) { s_lastSync = now; syncAllowlist(); continue; }
    if (msDiff(now, s_lastFlush) > (int32_t)EVENTS_FLUSH_MS) { s_lastFlush = now; flushEvents(); }
  }
}
