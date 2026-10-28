#pragma once
// Estado compartido entre la tarea del lector (núcleo 1) y la de red (núcleo 0).
#include <Arduino.h>
#include <atomic>
#include <ctime>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

// ---------------- Mensajes lector -> red ----------------
enum class ReqType : uint8_t { Access, Fallback, EnrollRead };

struct NetRequest {
  ReqType  type;
  uint32_t seq;           // empareja petición/respuesta
  uint32_t deadlineMs;    // pasado este instante la petición ya no sirve (el lector decidió con la caché)
  char     uid[21];       // UID en HEX mayúsculas
  bool     granted;       // Fallback: decisión que tomó la caché
  char     reason[24];
  char     session[37];   // EnrollRead
};

struct AccessResponse {
  uint32_t seq;
  bool     ok;            // el servidor respondió
  bool     granted;
  uint32_t unlockMs;
  char     reason[24];
};

extern QueueHandle_t g_netQueue;    // lector -> red
extern QueueHandle_t g_accessResp;  // red -> lector (longitud 1)

// ---------------- Estado global ----------------
extern std::atomic<bool>     g_online;        // WiFi + HTTPS respondiendo recientemente
extern std::atomic<bool>     g_mqttUp;
extern std::atomic<bool>     g_disabled;      // devices.is_active = false
extern std::atomic<uint32_t> g_enrollUntilMs; // 0 = sin modo registro

void enrollStart(const char* sessionId);
bool enrollActive();
bool enrollTake(char out[37]);   // consume la sesión (el lector lee UNA tarjeta)
void enrollCancel(const char* sessionId);

inline bool timeValid() { return time(nullptr) > 1700000000; }
inline uint32_t nowEpoch() { return (uint32_t)time(nullptr); }

/** a - b para millis() tolerante al desbordamiento. */
inline int32_t msDiff(uint32_t a, uint32_t b) { return (int32_t)(a - b); }

/** Motivo del último arranque: power_on, brownout, watchdog, panic, software, external, deep_sleep, other. */
const char* resetReasonName();

void bytesToHex(const uint8_t* in, size_t len, char* out);   // out >= 2*len+1
size_t hexToBytes(const char* hex, uint8_t* out, size_t max);
