// Tarea del lector (núcleo 1): PN532 por I2C con detección por IRQ (no bloqueante),
// decisión de acceso (servidor -> caché), relé, botón de salida y LEDs.
// Nunca espera a la red más de ACCESS_ONLINE_TIMEOUT_MS: si la red falla, decide con la caché local.
#include <Adafruit_PN532.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include "cache.h"
#include "config.h"
#include "lock.h"
#include "state.h"

namespace {
Adafruit_PN532 nfc(PIN_PN532_IRQ, PIN_PN532_RST, &Wire);
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
bool     s_nfcEverOk = false;

void exitButtonTick();

bool nfcInit() {
  // Adafruit_PN532::begin() hace el reset por hardware con el pin RST.
  nfc.begin();
  uint32_t v = nfc.getFirmwareVersion();
  if (!v) { log_e("PN532 no responde (revisa cableado y DIP en modo I2C)"); return false; }
  log_i("PN532 firmware %u.%u", (unsigned)((v >> 16) & 0xFF), (unsigned)((v >> 8) & 0xFF));
  nfc.SAMConfig();
  nfc.setPassiveActivationRetries(0xFF);   // espera indefinida: avisa por IRQ cuando hay tarjeta
  s_armed = false;
  return true;
}

void arm() {
  s_armed = nfc.startPassiveTargetIDDetection(PN532_MIFARE_ISO14443A);
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
        Lock::tick();               // relé, LEDs y botón de salida siguen vivos mientras esperamos
        Feedback::tick();
        exitButtonTick();
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

void readerTask(void*) {
  esp_task_wdt_add(nullptr);
  if (PIN_EXIT_BUTTON >= 0) pinMode(PIN_EXIT_BUTTON, INPUT_PULLUP);
  pinMode(PIN_PN532_IRQ, INPUT_PULLUP);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  Wire.setTimeOut(50);

  for (;;) {
    esp_task_wdt_reset();
    Lock::tick();
    Feedback::tick();
    exitButtonTick();

    uint32_t now = millis();
    if (!s_nfcOk) {
      if (!s_lastInitTry || msDiff(now, s_lastInitTry) > 5000) {
        s_lastInitTry = now;
        s_nfcOk = nfcInit();
        if (s_nfcOk) { s_nfcEverOk = true; s_nfcFailures = 0; }
        // Si el lector funcionaba y dejó de responder, el bus I2C suele quedar bloqueado: reinicio limpio.
        // (Si nunca respondió desde el arranque es un problema de cableado: no se entra en bucle de reinicios.)
        else if (s_nfcEverOk && ++s_nfcFailures >= NFC_MAX_REINIT) { log_e("PN532 sin recuperación: reiniciando"); delay(100); ESP.restart(); }
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    // Salud del PN532: los módulos I2C pueden colgarse con ruido eléctrico del solenoide.
    if (msDiff(now, s_lastHealth) > (int32_t)NFC_HEALTH_MS && !Lock::isUnlocked()) {
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
