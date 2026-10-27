#include "lock.h"
#include <Preferences.h>
#include <atomic>
#include "config.h"
#include "state.h"

namespace {
std::atomic<uint32_t> s_pulseUntilMs{0};
std::atomic<uint32_t> s_holdUntil{0};
std::atomic<bool>     s_lockdown{false};
std::atomic<uint32_t> s_unlockMs{DEFAULT_UNLOCK_MS};
std::atomic<bool>     s_relayOn{false};
Preferences           s_prefs;

inline void writeRelay(bool on) {
  digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
  s_relayOn = on;
}
}  // namespace

namespace Lock {

void begin() {
  // Fija el nivel de reposo ANTES de configurar la salida: evita un "clic" del relé al arrancar.
  digitalWrite(PIN_RELAY, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PIN_RELAY, OUTPUT);
  writeRelay(false);
  if (PIN_DOOR_SENSOR >= 0) pinMode(PIN_DOOR_SENSOR, INPUT_PULLUP);

  s_prefs.begin("acc", false);
  s_lockdown = s_prefs.getBool("lockdown", false);
  s_unlockMs = s_prefs.getUInt("unlock_ms", DEFAULT_UNLOCK_MS);
}

void tick() {
  bool pulseOn = s_pulseUntilMs.load() && msDiff(s_pulseUntilMs.load(), millis()) > 0;
  if (!pulseOn) s_pulseUntilMs = 0;
  uint32_t hold = s_holdUntil.load();
  bool holdOn = hold && timeValid() && nowEpoch() < hold && !s_lockdown;  // lockdown anula "mantener abierta"
  if (hold && timeValid() && nowEpoch() >= hold) s_holdUntil = 0;
  bool want = pulseOn || holdOn;
  if (want != s_relayOn.load()) writeRelay(want);
}

void pulse(uint32_t ms) {
  ms = constrain(ms, 500UL, 30000UL);
  uint32_t until = millis() + ms;
  s_pulseUntilMs = until ? until : 1;
}

void holdOpenUntil(uint32_t epoch) { s_holdUntil = epoch; }

// setLockdown / setDefaultUnlockMs solo se llaman desde la tarea de red: NVS sin concurrencia.
void setLockdown(bool on) {
  if (s_lockdown.exchange(on) == on) return;
  s_prefs.putBool("lockdown", on);
  if (on) s_holdUntil = 0;
}

bool lockdown() { return s_lockdown; }

void setDefaultUnlockMs(uint32_t ms) {
  ms = constrain(ms, 500UL, 30000UL);
  if (s_unlockMs.exchange(ms) != ms) s_prefs.putUInt("unlock_ms", ms);
}

uint32_t defaultUnlockMs() { return s_unlockMs; }
bool isUnlocked() { return s_relayOn; }

bool doorClosed(bool* known) {
  if (PIN_DOOR_SENSOR < 0) { *known = false; return true; }
  *known = true;
  return digitalRead(PIN_DOOR_SENSOR) == LOW;
}

}  // namespace Lock

// ============================================================================
//  LEDs y zumbador (no bloqueante, lo avanza la tarea del lector)
// ============================================================================
namespace {
std::atomic<uint8_t>  s_event{Feedback::None};
std::atomic<uint32_t> s_eventAt{0};

inline void leds(bool g, bool r) {
  digitalWrite(PIN_LED_GREEN, g);
  digitalWrite(PIN_LED_RED, r);
}
inline void buzz(bool on) {
  if (PIN_BUZZER >= 0) digitalWrite(PIN_BUZZER, on);
}
}  // namespace

namespace Feedback {

void begin() {
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  if (PIN_BUZZER >= 0) pinMode(PIN_BUZZER, OUTPUT);
  leds(false, false);
  buzz(false);
}

void signal(Event e) {
  s_eventAt = millis();
  s_event = e;
}

void tick() {
  uint32_t now = millis();
  uint32_t t = now - s_eventAt.load();
  Event e = (Event)s_event.load();

  // 1) Evento puntual (tiene prioridad durante su duración)
  switch (e) {
    case Read:        if (t < 60)   { leds(false, false); buzz(true); return; } break;
    case Granted:     if (t < 1500) { leds(true, false); buzz(t < 120); return; } break;
    case Denied:      if (t < 1200) { leds(false, true); buzz((t / 120) % 2 == 0 && t < 600); return; } break;
    case EnrollSent:  if (t < 1500) { leds((t / 150) % 2, (t / 150) % 2); buzz(t < 60); return; } break;
    case EnrollOk:    if (t < 1500) { leds((t / 200) % 2 == 0, false); buzz(t < 80 || (t > 160 && t < 240)); return; } break;
    case EnrollFail:  if (t < 1500) { leds(false, true); buzz(t < 500); return; } break;
    case EnrollArmed: if (t < 200)  { buzz(true); } break;
    default: break;
  }
  if (e != None && t >= 1500) s_event = None;
  buzz(false);

  // 2) Estado de fondo
  if (Lock::isUnlocked())  { leds(true, false); return; }                       // abierta: verde fijo
  if (enrollActive())      { bool p = (now / 250) % 2; leds(p, !p); return; }   // registro: alterna
  if (Lock::lockdown())    { leds(false, (now % 1000) < 500); return; }         // bloqueo: rojo 1 Hz
  if (!g_online)           { leds(false, (now % 3000) < 80); return; }          // sin red: destello rojo
  leds((now % 5000) < 40, false);                                               // normal: latido verde
}

}  // namespace Feedback
