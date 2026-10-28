#pragma once
#include <Arduino.h>

// Control del relé/solenoide. Cualquier tarea puede pedir cambios (atómicos);
// SOLO Lock::tick() (tarea del lector) toca el GPIO.
//   Fail-secure: sin alimentación o tras reinicio el relé queda en reposo => cerradura bloqueada.
namespace Lock {
void begin();
void tick();

void pulse(uint32_t ms);              // apertura temporal
void holdOpenUntil(uint32_t epoch);   // 0 = asegurar de nuevo
uint32_t holdUntil();                 // epoch de cierre de "mantener abierta" (0 = no hay)
void setLockdown(bool on);            // se guarda en NVS: sobrevive a reinicios sin red
bool lockdown();
void setDefaultUnlockMs(uint32_t ms); // devices.unlock_ms (NVS)
uint32_t defaultUnlockMs();

bool isUnlocked();                    // estado real del relé
bool doorClosed(bool* known);         // sensor magnético (si existe)
}  // namespace Lock

namespace Feedback {
enum Event : uint8_t { None, Read, Granted, Denied, EnrollArmed, EnrollSent, EnrollOk, EnrollFail };
void begin();
void signal(Event e);
void tick();
}  // namespace Feedback
