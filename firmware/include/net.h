#pragma once
#include <ArduinoJson.h>

// Tarea de red (núcleo 0): WiFi no bloqueante, MQTT asíncrono (esp-mqtt), HTTPS a device-ingest,
// latidos, sincronización de la lista blanca y subida de la cola offline.
void netTask(void*);

/**
 * Verifica un comando firmado recibido por MQTT:
 *   sig = HMAC-SHA256(DEVICE_CMD_KEY, "id|cmd|arg|iat|exp")  (hex en minúsculas)
 * Exige hora válida, ventana [iat - skew, exp + skew] e id no repetido.
 */
bool verifyCommand(JsonDocument& doc, const char** err);
