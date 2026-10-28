// Tarea del lector (núcleo 1): PN532 por SPI (o I2C) con detección por IRQ (no bloqueante) y
// decisión de acceso (servidor -> caché).
// Nunca espera a la red más de ACCESS_ONLINE_TIMEOUT_MS: si la red falla, decide con la caché local.
// Tarea de E/S (núcleo 1, más prioridad): relé, LEDs y botón de salida cada 10 ms. Va aparte porque
// las llamadas al PN532 pueden bloquear segundos si el lector no responde, y la cerradura
// tiene que obedecer a los comandos y al botón de salida aunque el lector esté averiado.
#include <Adafruit_PN532.h>
#include <SPI.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include "cache.h"
#include "config.h"
#include "lock.h"
#include "state.h"

namespace {
#if NFC_USE_SPI
Adafruit_PN532 nfc(PIN_SPI_SS, &SPI);
#else
Adafruit_PN532 nfc(PIN_PN532_IRQ, PIN_PN532_RST, &Wire);
#endif
bool     s_nfcOk = false;
bool     s_armed = false;
uint32_t s_lastInitTry = 0, s_lastHealth = 0, s_armedAt = 0;
uint8_t  s_lastUid[10];
uint8_t  s_lastLen = 0;
uint32_t s_lastUidAt = 0;
uint32_t s_seq = 0;

// ---- botón de salida ----
bool     s_btnStable = true, s_btnLast = true;
uint32_t s_btnChangedAt = 0;
uint8_t  s_nfcFailures = 0;
bool     s_relayWasOn = false;
uint32_t s_relayOffAt = 0;

void exitButtonTick();

bool nfcInit() {
  // Adafruit_PN532::begin() hace el reset por hardware con el pin RST.
  nfc.begin();
  uint32_t v = nfc.getFirmwareVersion();
  if (!v) {
    // Niveles del bus en reposo: deben ser 1 (pull-up a 3,3 V). Un 0 = línea a GND o PN532 sin alimentación.
#if NFC_USE_SPI
    log_e("PN532 no responde por SPI. Revisa DIP (1 OFF, 2 ON), 3,3 V, GND común y SCK=%d MOSI=%d MISO=%d SS=%d",
          PIN_SPI_SCK, PIN_SPI_MOSI, PIN_SPI_MISO, PIN_SPI_SS);
#else
    log_e("PN532 no responde (SDA=%d SCL=%d; ambos deben ser 1). Revisa 3,3 V, GND común, SDA/SCL y DIP en I2C",
          digitalRead(PIN_I2C_SDA), digitalRead(PIN_I2C_SCL));
#endif
    return false;
  }
  log_i("PN532 firmware %u.%u", (unsigned)((v >> 16) & 0xFF), (unsigned)((v >> 8) & 0xFF));
  nfc.SAMConfig();
  nfc.setPassiveActivationRetries(0xFF);   // espera indefinida: avisa por IRQ cuando hay tarjeta
  s_armed = false;
  return true;
}

/** Libera un bus I2C colgado (el PN532 sujetando SDA tras un pico): 9 pulsos de reloj + STOP. */
void i2cBusRecover() {
#if !NFC_USE_SPI
  Wire.end();
  pinMode(PIN_I2C_SDA, INPUT_PULLUP);
  pinMode(PIN_I2C_SCL, OUTPUT_OPEN_DRAIN);
  for (int i = 0; i < 9 && digitalRead(PIN_I2C_SDA) == LOW; i++) {
    digitalWrite(PIN_I2C_SCL, LOW);  delayMicroseconds(5);
    digitalWrite(PIN_I2C_SCL, HIGH); delayMicroseconds(5);
  }
  pinMode(PIN_I2C_SDA, OUTPUT_OPEN_DRAIN);
  digitalWrite(PIN_I2C_SDA, LOW);  delayMicroseconds(5);
  digitalWrite(PIN_I2C_SCL, HIGH); delayMicroseconds(5);
  digitalWrite(PIN_I2C_SDA, HIGH); delayMicroseconds(5);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  Wire.setTimeOut(50);
#endif
}

void arm() {
  // La librería devuelve false también cuando el PN532 aceptó la orden pero aún no hay tarjeta (tras el ACK
  // espera la respuesta 100 ms). La detección queda en marcha igualmente: avisará por IRQ. Un lector colgado
  // lo detecta la comprobación de salud periódica (getFirmwareVersion).
  nfc.startPassiveTargetIDDetection(PN532_MIFARE_ISO14443A);
  s_armed = true;
  s_armedAt = millis();
}

/** El servidor decide; si no responde a tiempo, decide la caché local. */
void decide(const uint8_t* uid, uint8_t len, const char* hex) {
  bool granted = false, decided = false, triedOnline = false;
  uint32_t unlockMs = Lock::defaultUnlockMs();
  const char* reason = "";
  uint32_t seq = ++s_seq;

  if (g_online) {
    triedOnline = true;
    xQueueReset(g_accessResp);
    NetRequest r{};
    r.type = ReqType::Access;
    r.seq = seq;
    r.deadlineMs = millis() + ACCESS_ONLINE_TIMEOUT_MS;
    strlcpy(r.uid, hex, sizeof r.uid);
    if (xQueueSend(g_netQueue, &r, 0) == pdTRUE) {
      AccessResponse resp;
      uint32_t t0 = millis();
      while (msDiff(millis(), t0) < (int32_t)ACCESS_ONLINE_TIMEOUT_MS) {
        esp_task_wdt_reset();
        if (xQueueReceive(g_accessResp, &resp, pdMS_TO_TICKS(40)) == pdTRUE && resp.seq == seq) {
          if (resp.ok) { decided = true; granted = resp.granted; unlockMs = resp.unlockMs; }
          break;
        }
      }
    }
  }

  if (!decided) {
    bool admin;
    granted = Cache::decide(uid, len, &admin, &reason);
    log_i("Decisión OFFLINE %s: %s %s", hex, granted ? "CONCEDIDO" : "DENEGADO", reason);
    if (triedOnline) {
      // La tarea de red sabrá si el servidor alcanzó a registrar este intento.
      NetRequest f{};
      f.type = ReqType::Fallback;
      f.seq = seq;
      f.granted = granted;
      strlcpy(f.uid, hex, sizeof f.uid);
      strlcpy(f.reason, reason, sizeof f.reason);
      xQueueSend(g_netQueue, &f, 0);
    } else {
      Cache::pushEvent("access", hex, granted, reason);
    }
  } else {
    log_i("Decisión ONLINE %s: %s", hex, granted ? "CONCEDIDO" : "DENEGADO");
  }

  if (granted) {
    Lock::pulse(unlockMs);
    Feedback::signal(Feedback::Granted);
  } else {
    Feedback::signal(Feedback::Denied);
  }
}

void onCard(const uint8_t* uid, uint8_t len) {
  // Anti-rebote: la misma tarjeta apoyada sobre el lector no genera eventos repetidos.
  if (len == s_lastLen && memcmp(uid, s_lastUid, len) == 0 && msDiff(millis(), s_lastUidAt) < (int32_t)CARD_REPEAT_MS) {
    s_lastUidAt = millis();
    return;
  }
  memcpy(s_lastUid, uid, len);
  s_lastLen = len;
  s_lastUidAt = millis();

  char hex[21];
  bytesToHex(uid, len, hex);
  Feedback::signal(Feedback::Read);

  // ---- Modo Enrolamiento: la tarjeta NO abre, se envía a la web ----
  char session[37];
  if (enrollTake(session)) {
    log_i("Enrolamiento: UID %s -> sesión %s", hex, session);
    NetRequest r{};
    r.type = ReqType::EnrollRead;
    strlcpy(r.uid, hex, sizeof r.uid);
    strlcpy(r.session, session, sizeof r.session);
    xQueueSend(g_netQueue, &r, pdMS_TO_TICKS(100));
    Feedback::signal(Feedback::EnrollSent);
    return;
  }

  decide(uid, len, hex);
}

void exitButtonTick() {
  if (PIN_EXIT_BUTTON < 0) return;
  bool raw = digitalRead(PIN_EXIT_BUTTON);   // HIGH = suelto (pull-up)
  if (raw != s_btnLast) { s_btnLast = raw; s_btnChangedAt = millis(); }
  if (raw != s_btnStable && msDiff(millis(), s_btnChangedAt) > (int32_t)EXIT_DEBOUNCE_MS) {
    s_btnStable = raw;
    if (raw == LOW) {
      // La salida SIEMPRE se permite (también en lockdown y sin red): seguridad de las personas.
      Lock::pulse(Lock::defaultUnlockMs());
      Feedback::signal(Feedback::Granted);
      Cache::pushEvent("exit_button", nullptr, true, nullptr);
    }
  }
}
}  // namespace

void ioTask(void*) {
  esp_task_wdt_add(nullptr);
  if (PIN_EXIT_BUTTON >= 0) pinMode(PIN_EXIT_BUTTON, INPUT_PULLUP);
  for (;;) {
    esp_task_wdt_reset();
    Lock::tick();
    Feedback::tick();
    exitButtonTick();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void readerTask(void*) {
  esp_task_wdt_add(nullptr);
  pinMode(PIN_PN532_IRQ, INPUT_PULLUP);
#if NFC_USE_SPI
  // Pines propios: el begin() de la librería ya no los cambia (SPI.begin() solo actúa la primera vez).
  SPI.begin(PIN_SPI_SCK, PIN_SPI_MISO, PIN_SPI_MOSI, -1);
#else
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  Wire.setTimeOut(50);
#endif

  for (;;) {
    esp_task_wdt_reset();

    uint32_t now = millis();
    // Mientras el solenoide actúa (y 1,5 s después) no se toca el I2C: su ruido cuelga al PN532.
    bool relayOn = Lock::isUnlocked();
    if (s_relayWasOn && !relayOn) s_relayOffAt = now;
    s_relayWasOn = relayOn;
    bool quiet = relayOn || (s_relayOffAt && msDiff(now, s_relayOffAt) < (int32_t)NFC_QUIET_MS);

    if (!s_nfcOk) {
      // El lector NUNCA reinicia el ESP32: la cerradura y el botón de salida siguen disponibles.
      if (!quiet && (!s_lastInitTry || msDiff(now, s_lastInitTry) > 5000)) {
        s_lastInitTry = now;
        s_nfcOk = nfcInit();
        if (s_nfcOk) s_nfcFailures = 0;
        else if (++s_nfcFailures % NFC_MAX_REINIT == 0 && !NFC_USE_SPI) { log_w("PN532 sin respuesta: liberando el bus I2C"); i2cBusRecover(); }
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    // Salud del PN532: los módulos I2C pueden colgarse con ruido eléctrico del solenoide.
    if (msDiff(now, s_lastHealth) > (int32_t)NFC_HEALTH_MS && !quiet) {
      s_lastHealth = now;
      if (!nfc.getFirmwareVersion()) { log_w("PN532 colgado: reinicializando"); s_nfcOk = false; continue; }
      s_armed = false;   // el comando de prueba cancela la detección en curso
    }

    if (!s_armed) { arm(); if (!s_armed) { s_nfcOk = false; continue; } }

    if (digitalRead(PIN_PN532_IRQ) == LOW) {
      uint8_t uid[10], len = 0;
      bool ok = nfc.readDetectedPassiveTargetID(uid, &len);
      s_armed = false;
      if (ok && len >= 4 && len <= 10) onCard(uid, len);
      vTaskDelay(pdMS_TO_TICKS(150));   // deja que la tarjeta se retire antes de rearmar
    }

    vTaskDelay(pdMS_TO_TICKS(15));
  }
}
