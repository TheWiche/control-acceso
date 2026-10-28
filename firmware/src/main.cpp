// ============================================================================
//  Control de Acceso — firmware ESP32
//    Núcleo 1: tarea de E/S (relé, botón, LEDs, cada 10 ms), tarea del lector (PN532, decisión
//              de acceso; nunca espera a la red más de 2,5 s y no puede frenar el relé) y tarea
//              de la pantalla (prioridad mínima)
//    Núcleo 0: tarea de red (WiFi, MQTT, HTTPS, caché)
// ============================================================================
#include <Arduino.h>
#include <esp_idf_version.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include "cache.h"
#include "config.h"
#include "lock.h"
#include "net.h"
#include "state.h"
#include "ui.h"

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
  if (esp_reset_reason() == ESP_RST_BROWNOUT) log_e("Arranque tras BROWNOUT: la alimentación de 5 V cayó (revisa la fuente)");
  else log_i("Motivo del arranque: %s", resetReasonName());

  Lock::begin();        // primero: relé en reposo (cerrado) cuanto antes
  Feedback::begin();
  Cache::begin();
  setDeviceName(DEVICE_CODE);   // hasta que el primer latido traiga el nombre real de la puerta
  Ui::begin();

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
#if DISPLAY_ENABLED
  xTaskCreatePinnedToCore(uiTask, "ui", 4096, nullptr, 1, nullptr, 1);   // la menor prioridad: nunca frena al relé
#endif
}

void loop() {
  vTaskDelete(nullptr);   // todo el trabajo ocurre en las dos tareas
}
