#pragma once
// ============================================================================
//  Configuración de hardware y tiempos (los secretos van en secrets.h)
// ============================================================================

#define FW_VERSION "1.0.0"

// ---------------- Pines (ESP32 DevKit / WROOM-32) ----------------
// Evitados a propósito: 0, 2, 5, 12, 15 (strapping) y 6-11 (flash).
#define PIN_I2C_SDA      21
#define PIN_I2C_SCL      22
#define PIN_PN532_IRQ     4   // salida IRQ del PN532 (activa en LOW)
#define PIN_PN532_RST    33   // RSTPDN del PN532 (reset por hardware si se cuelga)

#define PIN_RELAY        26   // base del NPN que maneja la bobina del relé (1 kΩ en serie, 10 kΩ a GND)
#define RELAY_ACTIVE_LOW  0   // relé suelto con transistor NPN: HIGH = bobina activada. Módulo con optoacoplador: 1

#define PIN_EXIT_BUTTON  27   // pulsador de salida a GND (INPUT_PULLUP). -1 si no hay
#define PIN_DOOR_SENSOR  25   // reed switch a GND (cerrado = LOW). -1 si no hay

#define PIN_LED_GREEN    18
#define PIN_LED_RED      19
#define PIN_BUZZER       23   // zumbador ACTIVO vía transistor. -1 si no hay

// ---------------- Tiempos ----------------
#define HEARTBEAT_MS              60000UL   // latido HTTPS (también trae la versión de la lista blanca)
#define ALLOWLIST_REFRESH_MS   (6UL * 3600UL * 1000UL)  // re-sincronización forzada aunque no cambie la versión
#define SYNC_RETRY_MS             30000UL   // reintento si la sincronización falla (no martillear el servidor)
#define EVENTS_FLUSH_MS           15000UL   // subida de la cola offline
#define ACCESS_ONLINE_TIMEOUT_MS   2500UL   // si el servidor no decide en este tiempo => caché local
#define HTTP_TIMEOUT_MS            4000
#define HTTP_MAX_RESPONSE        (48 * 1024)   // ~400 UIDs; con 2 sesiones TLS abiertas no hay heap para más
#define API_STALE_MS             150000UL   // sin respuestas HTTPS en 2,5 min => modo offline
#define WIFI_RETRY_MS             20000UL
#define CARD_REPEAT_MS             2500UL   // ignora la misma tarjeta dentro de este intervalo
#define NFC_HEALTH_MS             60000UL   // comprobación periódica del PN532
#define ENROLL_WINDOW_MS          60000UL
#define DEFAULT_UNLOCK_MS          3000UL
#define EXIT_DEBOUNCE_MS             60UL

// ---------------- Seguridad / límites ----------------
#define CMD_SKEW_S                   30     // tolerancia de reloj para iat/exp de los comandos
#define CMD_REPLAY_SLOTS             32
#define EVENTS_MAX                  200     // eventos offline guardados (los más antiguos se descartan)
#define EVENTS_BATCH                 20
#define ALLOWLIST_MAX_ENTRIES       400     // coherente con HTTP_MAX_RESPONSE
#define NFC_MAX_REINIT                 3     // reinicializaciones fallidas seguidas => reinicio del ESP32
