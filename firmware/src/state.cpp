#include "state.h"
#include <esp_system.h>
#include "config.h"

const char* resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "power_on";
    case ESP_RST_BROWNOUT:  return "brownout";   // la alimentación cayó (típico: fuente débil al activar el solenoide)
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:       return "watchdog";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_SW:        return "software";
    case ESP_RST_EXT:       return "external";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    default:                return "other";
  }
}

QueueHandle_t g_netQueue = nullptr;
QueueHandle_t g_accessResp = nullptr;

std::atomic<bool>     g_online{false};
std::atomic<bool>     g_mqttUp{false};
std::atomic<bool>     g_disabled{false};
std::atomic<uint32_t> g_enrollUntilMs{0};
std::atomic<uint32_t> g_displayMs{UI_EVENT_MS};

static portMUX_TYPE s_nameMux = portMUX_INITIALIZER_UNLOCKED;
static char s_deviceName[33] = "";

void setDeviceName(const char* name) {
  portENTER_CRITICAL(&s_nameMux);
  strlcpy(s_deviceName, name, sizeof s_deviceName);
  portEXIT_CRITICAL(&s_nameMux);
}

void deviceName(char* out, size_t n) {
  portENTER_CRITICAL(&s_nameMux);
  strlcpy(out, s_deviceName, n);
  portEXIT_CRITICAL(&s_nameMux);
}

static portMUX_TYPE s_enrollMux = portMUX_INITIALIZER_UNLOCKED;
static char s_enrollSession[37] = {0};

void enrollStart(const char* sessionId) {
  portENTER_CRITICAL(&s_enrollMux);
  strlcpy(s_enrollSession, sessionId, sizeof(s_enrollSession));
  uint32_t until = millis() + ENROLL_WINDOW_MS;
  g_enrollUntilMs = until ? until : 1;
  portEXIT_CRITICAL(&s_enrollMux);
}

bool enrollActive() {
  uint32_t until = g_enrollUntilMs.load();
  if (!until) return false;
  if (msDiff(until, millis()) <= 0) { g_enrollUntilMs = 0; return false; }
  return true;
}

bool enrollTake(char out[37]) {
  bool ok = false;
  portENTER_CRITICAL(&s_enrollMux);
  if (enrollActive() && s_enrollSession[0]) {
    strlcpy(out, s_enrollSession, 37);
    s_enrollSession[0] = 0;
    g_enrollUntilMs = 0;
    ok = true;
  }
  portEXIT_CRITICAL(&s_enrollMux);
  return ok;
}

void enrollCancel(const char* sessionId) {
  portENTER_CRITICAL(&s_enrollMux);
  if (!sessionId || !sessionId[0] || strcmp(sessionId, s_enrollSession) == 0) {
    s_enrollSession[0] = 0;
    g_enrollUntilMs = 0;
  }
  portEXIT_CRITICAL(&s_enrollMux);
}

void bytesToHex(const uint8_t* in, size_t len, char* out) {
  static const char* H = "0123456789ABCDEF";
  for (size_t i = 0; i < len; i++) { out[2 * i] = H[in[i] >> 4]; out[2 * i + 1] = H[in[i] & 0xF]; }
  out[2 * len] = 0;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

size_t hexToBytes(const char* hex, uint8_t* out, size_t max) {
  size_t n = 0;
  int hi = -1;
  for (const char* p = hex; *p && n < max; p++) {
    int v = hexNibble(*p);
    if (v < 0) continue;                 // ignora ':' u otros separadores
    if (hi < 0) hi = v; else { out[n++] = (uint8_t)((hi << 4) | v); hi = -1; }
  }
  return n;
}
