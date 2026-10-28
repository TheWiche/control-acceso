// ============================================================================
//  Control de Acceso — firmware ESP32
//    Núcleo 1: tarea de E/S (relé, botón, LEDs, cada 10 ms) y tarea del lector (PN532, decisión
//              de acceso) — el lector nunca espera a la red más de 2,5 s y no puede frenar el relé
//    Núcleo 0: tarea de red (WiFi, MQTT, HTTPS, caché)
// ============================================================================
#include <Arduino.h>
#include <esp_idf_version.h>
#include <esp_task_wdt.h>
#include "cache.h"
#include "config.h"
#include "lock.h"
#include "net.h"
#include "state.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Falta include/secrets.h: copia include/secrets.example.h y rellénalo"
#endif

void readerTask(void*);
void ioTask(void*);

void setup() {
  Serial.begin(115200);
  log_i("Control de Acceso %s — dispositivo %s", FW_VERSION, DEVICE_CODE);

  Lock::begin();        // primero: relé en reposo (cerrado) cuanto antes
  Feedback::begin();
  Cache::begin();

  // Watchdog de tareas: si el lector o la red se cuelgan, el ESP32 se reinicia (el relé vuelve a reposo).
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdt = {.timeout_ms = 30000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&wdt);
#else
  esp_task_wdt_init(30, true);
#endif

  g_netQueue = xQueueCreate(8, sizeof(NetRequest));
  g_accessResp = xQueueCreate(1, sizeof(AccessResponse));

  xTaskCreatePinnedToCore(ioTask, "io", 4096, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(readerTask, "reader", 6144, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 2, nullptr, 0);
}

void loop() {
  vTaskDelete(nullptr);   // todo el trabajo ocurre en las dos tareas
}
