# Fase 4/5 — Firmware ESP32, conexiones y montaje

Código: [`firmware/`](../firmware/). PlatformIO, plataforma `espressif32@7.0.1`, framework Arduino-ESP32 **2.0.17** fijado (`3.20017.241212`).
Librerías fijadas: PN532 1.3.4, BusIO 1.17.4, ArduinoJson 7.2.1, Adafruit GFX 1.12.6 y Adafruit ST7735 1.11.0.
MQTT (esp-mqtt), HTTPS (esp_http_client), LittleFS, NVS y mbedTLS vienen en el framework.

**Estado:** firmware **1.4.0**, compila con 0 errores (RAM 14,8 %, flash 57,4 %).

| Componente | ¿Probado en el hardware real? |
|---|---|
| Lector PN532 por SPI | **Sí**: lee y registra tarjetas |
| Cerradura con MOSFET IRFZ44N y driver Q1/Q2 | **Sí**: abre y cierra desde el panel y con el llavero |
| LEDs | **Sí** |
| Pantalla TFT | firmware cargado; falta confirmarla montada |

> **Conexiones una a una:** [07-conexiones.md](07-conexiones.md). Es la hoja de montaje. Este documento explica **por qué** cada parte va así.

---

## 1. Materiales
| Pieza | Especificación | Nota |
|---|---|---|
| ESP32 DevKit | ESP32-WROOM-32, 4 MB, USB CH340 | el tuyo: ESP32-D0WD-V3, 4 MB |
| Lector NFC | PN532 (placa roja «PN532 NFC RFID V3») | **en modo SPI** (§2) |
| Pantalla | TFT 1,8" 128×160, chip ST7735 | SPI en bus propio (§6) |
| Cerradura | solenoide 12 V DC, *fail-secure* | anota su corriente (típico 0,5–1 A) |
| Conmutación | MOSFET **IRFZ44N** + 2× **2N2222A** | o un **IRLZ44N** solo (§3.3) |
| Protección | diodo **1N4007**, condensador **1000 µF / 25 V** | obligatorios |
| Resistencias | 1× 1 kΩ, 4× 10 kΩ, 2× 330 Ω | **mídelas antes de soldar** |
| Indicadores | LED verde, LED rojo | |
| Alimentación | módulo de pared multivoltaje: **3,3 V, 5 V y 12 V** con GND común | §4 |
| Opcionales | pulsador de salida, sensor magnético de puerta, zumbador activo 5 V + 2N2222A | |

---

## 2. Lector PN532 (SPI)

> **Por qué SPI y no I2C.** Por I2C, el PN532 retiene la línea SCL mientras procesa (*clock stretching*) y el
> controlador I2C del ESP32 se queda en timeout (`i2cRead returned Error 263`, con SCL medido en 0), sobre todo
> con el ruido del solenoide. Por SPI ese problema no existe. El firmware sigue admitiendo I2C con
> `NFC_USE_SPI 0` en [`config.h`](../firmware/include/config.h).

- **Interruptor de modo:** **palanca 1 OFF, palanca 2 ON** (fila «SPI 0 1» de la tabla impresa). Solo se lee al encender.
- **Cables:**
  - SCK → D22
  - MOSI → D21
  - MISO → D32
  - SS → D33
  - IRQ → D4
  - VCC → **3,3 V** (nunca 5 V)
  - GND
- **El firmware detecta las tarjetas por interrupción (IRQ):** la tarea del lector no se queda esperando.
- **Recuperación:** si el lector deja de responder, se reintenta cada 5 s. **El lector nunca reinicia el ESP32**: la cerradura y el botón de salida siguen funcionando aunque el lector falle.
- Log esperado: `PN532 firmware 1.6`.

---

## 3. Mando de la cerradura

### 3.1 Por qué un MOSFET (y no el relé)
El relé de 5 patas con un 2N2222A también funciona, pero tiene contactos mecánicos que se desgastan y hacen chispa, y su bobina añade carga a los 5 V. Un MOSFET conmuta el solenoide **sin piezas móviles**, en silencio y sin arco.

**El solenoide va por el lado de GND** (*low-side*):
- +12 V → solenoide → Drain.
- Source → GND.
- El MOSFET abre o cierra el retorno a tierra.

### 3.2 Por qué el IRFZ44N necesita dos transistores delante
| MOSFET | Voltaje de puerta para conducir del todo | Con los 3,3 V del ESP32 |
|---|---|---|
| **IRFZ44N** | **10 V** (puede no empezar a conducir hasta 4 V) | **no conduce**: lo medimos, 11,8 V entre D y S y el solenoide quieto |
| **IRLZ44N** ("L" de lógica) | 3–5 V | conduce |

Con el IRFZ44N, **Q1 y Q2** (2N2222A) ponen **12 V en la puerta**. Son dos etapas inversoras seguidas, así que la lógica **no se invierte**: D26 en alto abre (`RELAY_ACTIVE_LOW 0`, sin cambios en el código).

| D26 | Q1 | Q2 | Puerta | Solenoide |
|---|---|---|---|---|
| alto | conduce | apagado | 12 V (por R5) | **abre** |
| bajo, arranque o reinicio | apagado (R2 a GND) | conduce (por R3 + R4) | 0 V | **cerrado** |

Esto es **seguro ante fallos**: mientras el ESP32 arranca, se reinicia o se programa, D26 queda flotando, R2 mantiene Q1 apagado y la puerta **sigue cerrada**.

Que el IRFZ44N se active con un solo NPN es posible, pero la lógica quedaría invertida y la puerta se abriría un instante en cada reinicio. Por eso no se hace así.

### 3.3 Variante más simple: IRLZ44N
Con un IRLZ44N sobran Q1, Q2, R3, R4 y R5:
- D26 → 1 kΩ → G.
- 10 kΩ de G a GND.
- Mismas patas G · D · S y mismo firmware.

### 3.4 Diodo y condensador
- **Diodo 1N4007 en paralelo con el solenoide,** con la **franja hacia el +12 V**. Al apagarse, la bobina del solenoide genera un pico de cientos de voltios. El diodo lo descarga en la propia bobina. Sin él, ese pico destruye el MOSFET y reinicia el ESP32.
- **Condensador de 1000 µF** entre +12 V y GND de potencia. Absorbe el arranque del solenoide, que pide mucha corriente de golpe.

---

## 4. Alimentación y tierras
Un único **módulo de pared** alimenta todo:
- **12 V:** solenoide y puerta del MOSFET.
- **5 V:** VIN del ESP32.
- **3,3 V:** PN532 y pantalla.

- **Dos tierras que solo se unen en el módulo.** El **GND de potencia** (Source del MOSFET, − del condensador) y el **GND de control** (ESP32, PN532, pantalla, Q1, Q2 y LEDs) van **cada uno con su propio cable** al borne GND del módulo. Así la corriente del solenoide no pasa por los cables del ESP32 ni del lector, y su pico no "levanta" la tierra de la lógica.
- **El PN532 y la pantalla van a los 3,3 V del módulo,** no al pin 3V3 del ESP32. El regulador del ESP32 es pequeño y el PN532 llega a ~150 mA al leer.
- **Si el módulo se apaga o el ESP32 se reinicia al abrir,** el módulo no da la corriente del solenoide. Alimenta el solenoide con un **adaptador de 12 V aparte** (variantes en [07 §13](07-conexiones.md)). El panel muestra el motivo del último reinicio: «caída de tensión» delata la fuente.
- **Ciclo de trabajo del solenoide:** la mayoría no está hecha para estar energizada mucho tiempo y se calienta. Los pulsos de 3 s están bien. Con **«Mantener abierta» largo** (el panel avisa a partir de 5 min), revisa su ficha.
- **No alimentes el ESP32 por USB y por VIN a la vez.** Para programar, quita el cable de VIN.

---

## 5. LEDs y opcionales
| Elemento | ESP32 | Conexión |
|---|---|---|
| LED verde | D18 | D18 → 330 Ω → pata larga; pata corta → GND |
| LED rojo | D19 | igual |
| Pulsador de salida (opcional) | D27 | a GND; abre siempre, también en bloqueo total y sin red |
| Sensor de puerta (opcional) | D25 | a GND; cerrado = puerta cerrada. Sin él: `PIN_DOOR_SENSOR -1` |
| Zumbador activo 5 V (opcional) | D23 | D23 → 1 kΩ → base de un 2N2222A; emisor → GND; colector → − del zumbador; + → 5 V |

Pines que se evitan a propósito: 0, 2, 5 y 12 (arranque) y 6–11 (flash interna). El 15 solo se usa como CS de la pantalla.

---

## 6. Pantalla TFT 1,8" 128×160 (ST7735)
Va por **SPI en su propio bus (HSPI)**:
- SCL → D14
- SDA → D13
- CS → D15
- DC → D17
- RST → D16
- VCC y BLK → 3,3 V
- GND

Aunque los pines digan SCL y SDA, **no es I2C**. El lector usa el otro bus (VSPI), así que **nunca comparten bus** y no hacen falta cerrojos entre tareas.

**Qué muestra:**
- **En reposo:** nombre de la puerta y conexión, **hora local** y una barra de estado:
  - "Acerque su tarjeta"
  - "BLOQUEO TOTAL"
  - "Puerta abierta · Cierra en 4:32"
  - "Modo registro"
  - "Sin conexión · Funciona en modo local"
- **2,5 s tras cada evento:**
  - **Verde:** "Bienvenido" + nombre de la persona.
  - **Rojo:** "Denegado" + motivo ("Fuera de horario", "Tarjeta no registrada"…) + UID.
  - **Azul:** modo registro, con cuenta atrás.
  - **Verde:** «Bienvenido» + nombre del invitado cuando entra con un pase; «Abierto · Desde la app» si lo abre un administrador; «Salida» con el botón.
  - **Cuenta atrás:** bajo los mensajes de apertura y en la barra de reposo se lee «Cierra en 7 s» (o «4:32», en «mantener abierta»). El mensaje no desaparece mientras la puerta siga abierta.

Si los colores salen cambiados o hay basura en los bordes, cambia `TFT_TAB` a `INITR_GREENTAB` o `INITR_REDTAB`. Para usarla vertical, `TFT_ROTATION 0`. Sin pantalla, `DISPLAY_ENABLED 0`. Todo en [`config.h`](../firmware/include/config.h).

---

## 7. Compilar y cargar
```bash
cd firmware
cp include/secrets.example.h include/secrets.h      # y rellénalo (docs/06, paso E2)
pio run                                              # compilar
pio run -t upload --upload-port COM3                 # cargar (quita antes el cable de VIN)
pio device monitor -p COM3                           # ver el log (115200 baudios). Salir: Ctrl+C
```
Si la carga se queda en `Connecting....`, mantén pulsado **BOOT** en el ESP32 hasta que empiece a escribir. Si COM3 aparece "ocupado", cierra el monitor serie que tengas abierto.

Log esperado al arrancar:
```
Control de Acceso 1.3.0 — dispositivo puerta01x
Motivo del arranque: power_on
Relé DESACTIVADO (GPIO 26 = 0)
Caché: N UIDs (versión …), 0 eventos pendientes
PN532 firmware 1.6
WiFi conectado: 192.168.x.x  RSSI -5x
MQTT conectado
Lista blanca sincronizada: N UIDs (heap libre …)
```
En el log, "Relé" es la salida que gobierna la cerradura (D26), aunque ahora sea un MOSFET.

**Diagnóstico del pin de la cerradura:** en cada apertura el firmware lee el nivel real de D26. Si ves `Relé ACTIVADO pero GPIO 26 lee 0`, algo externo tira el pin a GND (cortocircuito). Si sale `Relé ACTIVADO (GPIO 26 = 1)` y la cerradura no se mueve, el fallo está en el driver o el MOSFET.

### Orden de prueba en banco
Sigue [07 §10–§11](07-conexiones.md):
1. Revisión con el multímetro.
2. Encendido **sin que el solenoide se active**.
3. Abrir desde el panel.
4. Llavero registrado.
5. Tarjeta sin registrar.
6. Mantener abierta.
7. Medida D–S < 0,3 V.

---

## 8. Diseño del firmware
```
 Núcleo 1 — "io" (prio 4): salida de la cerradura, LEDs, zumbador y botón de salida cada 10 ms (nada la bloquea)
 Núcleo 1 — "reader" (prio 3): PN532 por IRQ, anti-rebote de la misma tarjeta (2,5 s), modo registro,
                               decisión de acceso (servidor ≤ 2,5 s; si no, la caché)
 Núcleo 1 — "ui" (prio 1): pantalla; recibe los eventos por una cola sin bloqueo
 Núcleo 0 — "net" (prio 2): WiFi no bloqueante · esp-mqtt (TLS, reconexión, LWT) · HTTPS persistente a device-ingest
                            latido cada 15 s y al cambiar la salida · comandos MQTT firmados · cola offline cada 15 s
 Watchdog de 30 s sobre io, reader y net
```

- **Decisión de acceso:** con red, decide el servidor (revocación instantánea, registro en vivo y nombre de la persona para la pantalla). Si no responde en 2,5 s o no hay red, decide la caché.
- **Caché offline (LittleFS):** hasta **400 UIDs** con vigencia, días, ventana horaria y desfase horario del sitio. Se escribe de forma atómica y se re-sincroniza cuando cambia la huella que trae el latido: una revocación llega a la caché en ≤ 15 s.
- **Cola offline:** hasta 200 eventos en flash. Se suben al volver la red con su hora real (`meta.offline = true`).
- **Comandos** (`acc/v1/<code>/cmd`): `unlock`, `hold_open` (con la hora absoluta de cierre), `release`, `lockdown_on/off` y `enroll_start/cancel`. Se verifican con HMAC-SHA256, ventana `iat/exp` ±30 s e id no repetido, y se confirman por HTTPS.
- **El servidor manda:** el latido devuelve bloqueo total, "mantener abierta" y el nombre de la puerta. Un comando MQTT perdido se corrige en ≤ 15 s.
- **Presencia:** latido cada 15 s; el servidor marca la puerta desconectada tras 45 s sin latido. El latido informa también del **motivo del último arranque** (normal, caída de tensión, watchdog…).

### Señales de los LEDs
| LEDs / zumbador | Significado |
|---|---|
| Destello verde cada 5 s | normal, en línea |
| Destello rojo cada 3 s | sin conexión (funciona con la caché) |
| Verde fijo | puerta abierta |
| Verde 1,5 s + bip | acceso concedido |
| Rojo 1,2 s + 3 bips | denegado |
| Verde y rojo alternando | modo registro: acerca la tarjeta |
| Rojo 1 vez por segundo | bloqueo total |

## 9. Comportamiento ante fallos y límites
| Situación | Qué pasa |
|---|---|
| Sin internet | Las tarjetas autorizadas abren con la caché. Los pases de invitado y la apertura remota no (el PIN se valida en el servidor). |
| Corte de luz | Cerradura **bloqueada** (*fail-secure*). El bloqueo total y la caché se conservan. |
| Arranque sin internet | Sin reloj con batería: hasta tener hora, solo abren las credenciales sin restricción horaria y los administradores. Para evitarlo, añade un DS3231. |
| Bloqueo total | Solo administradores. **El botón de salida siempre abre.** |
| Comando con firma mala, vencido o repetido | Se ignora. |
| El lector falla | La cerradura, el panel y el botón de salida siguen funcionando; el lector se reintenta cada 5 s. |

- **Las tarjetas típicas se pueden clonar.** Los llaveros azules y las tarjetas blancas (MIFARE Classic) tienen un UID copiable. Para alta seguridad, usa DESFire EV2/EV3.
- **Sin OTA:** el firmware se actualiza por USB.
