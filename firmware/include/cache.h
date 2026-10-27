#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

// Caché OFFLINE en LittleFS (memoria no volátil):
//   * Lista blanca de UIDs con vigencia y horario, sincronizada desde la nube.
//   * Cola de eventos decididos sin red, que se suben al reconectar.
namespace Cache {

void begin();

/** Decide con la lista local. reason = clave de deny_reason (o "" si concedido). */
bool decide(const uint8_t* uid, uint8_t len, bool* admin, const char** reason);

/** Reemplaza la lista (respuesta de device-ingest {type:"allowlist"}). Persiste de forma atómica. */
bool replace(JsonArrayConst entries, const char* version, int utcOffsetMin);
String version();
size_t size();

// ---- cola de eventos offline ----
void pushEvent(const char* kind, const char* uidHex, bool granted, const char* reason);
size_t pendingEvents();
/** Copia hasta `max` eventos al array JSON (sin quitarlos). Devuelve cuántos copió. */
size_t peekEvents(JsonArray out, size_t max);
void dropEvents(size_t n);

}  // namespace Cache
