#pragma once
// Pantalla TFT 1,8" 128x160 (ST7735) en su propio bus SPI (HSPI), separada del lector.
// La dibuja una tarea de baja prioridad: quien avisa de un evento nunca espera al dibujo
// (cola sin bloqueo; si se llena, se pierde el aviso visual, nunca la apertura).
#include <Arduino.h>

namespace Ui {

enum Kind : uint8_t {
  Granted,     // a = nombre de la persona (puede ir vacío) · b = "offline" si decidió la caché local
  Denied,      // a = clave deny_reason (unknown_credential, outside_schedule…) · b = UID en HEX
  Remote,      // apertura ordenada desde la app o un pase de invitado
  ExitButton,  // botón de salida
  EnrollWait,  // modo registro: esperando tarjeta
  EnrollSent,  // a = UID leído, enviado al servidor
  EnrollOk,    // a = UID registrado
  EnrollFail,  // a = código de error del servidor (o vacío si no hubo conexión)
};

void begin();   // crea la cola: llamar antes de arrancar las tareas
void event(Kind k, const char* a = nullptr, const char* b = nullptr);

}  // namespace Ui

void uiTask(void*);
