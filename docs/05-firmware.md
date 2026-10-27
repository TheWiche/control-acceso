# Fase 4/5 — Firmware ESP32, conexiones y montaje

Código: [`firmware/`](../firmware/) — PlatformIO, plataforma `espressif32@7.0.1`, framework Arduino-ESP32 **2.0.17** fijado (`3.20017.241212`), PN532 1.3.4, BusIO 1.17.4, ArduinoJson 7.2.1.
MQTT (esp-mqtt), HTTPS (esp_http_client), LittleFS, NVS y mbedTLS vienen en el framework: no hay más dependencias.
Compila con 0 errores (RAM 14,7 %, flash 55,9 %). **Aún no se ha probado con el lector, el relé y el solenoide conectados.**

---

## 1. Materiales

| # | Pieza | Especificación | Nota |
|---|---|---|---|
| 1 | ESP32 DevKit | ESP32-WROOM-32, 4 MB flash, USB CH340/CP2102 | detectado en tu PC: ESP32-D0WD-V3, 4 MB, COM3 |
| 2 | Lector NFC | PN532 (Elechouse V3 o clon rojo) | modo I2C |
| 3 | Relé suelto de 5 patas | bobina **5 V DC** (p. ej. Songle SRD-05VDC-SL-C, ~70 Ω / ~70 mA), contactos ≥ 10 A 30 V DC | manejado por transistor NPN, **activo en HIGH** (§3) |
| 3b | Transistor relé | 2N2222A / PN2222A (o BC337) | uno más aparte del del zumbador |
| 4 | Cerradura | Solenoide 12 V DC, *fail-secure* (bloquea sin corriente) | anota su corriente (típico 0,5–1 A) |
| 5 | Diodos | 2×: **1N4007** en el solenoide (**1N5408** si pasa de 1 A) + **1N4007 o 1N4148** en la bobina del relé | protección *flyback*, ambos obligatorios |
| 6 | Fuente | 12 V DC ≥ 2 A | una sola fuente para todo |
| 7 | Reductor | LM2596 o MP1584, 12 V → **5,0 V** | **ajustar a 5,0 V antes de conectar el ESP32** |
| 8 | Condensadores | 1× 470–1000 µF/25 V, 1× 10 µF, 1× 100 nF | estabilidad ante picos del solenoide |
| 9 | Resistencias | 1× 10 kΩ, 2× 330 Ω, 2× 1 kΩ | pull-down del relé, LEDs, bases de los dos transistores |
| 10 | Interfaz | pulsador NA (salida), LED verde y rojo, zumbador activo 5 V + 2N2222, reed switch (opcional) | |

---

## 2. ESP32 ↔ PN532 (I2C)

### 2.1 Interruptores SEL0 / SEL1
El PN532 tiene un interruptor DIP de 2 palancas, rotulado **ON** y **1 2**. Las palancas se leen **al encender**: cámbialas siempre con la placa desconectada.

| Modo | Palanca 1 (SEL0) | Palanca 2 (SEL1) |
|---|---|---|
| HSU / UART | OFF | OFF |
| **I2C ← este proyecto** | **ON** (hacia la palabra «ON») | **OFF** (hacia el lado contrario) |
| SPI | OFF | ON |

```
   Vista superior del DIP en modo I2C
   ┌───────────────┐
   │  ON           │   ▲ palanca 1 arriba (hacia ON)  = SEL0 = 1
   │ [▲]  [ ]      │
   │ [ ]  [▼]      │   ▼ palanca 2 abajo              = SEL1 = 0
   │  1    2       │
   └───────────────┘
```
Si tu placa no dice «ON» sino «H/L»: SEL0 = H, SEL1 = L.

### 2.2 Cableado

| PN532 (conector I2C de 4 pines y laterales) | ESP32 | Nota |
|---|---|---|
| **VCC** | **3V3** | **3,3 V, NO 5 V**: las pull-up I2C del módulo van a VCC y los GPIO del ESP32 no toleran 5 V |
| **GND** | **GND** | |
| **SDA** | **GPIO 21** | cable < 50 cm |
| **SCL** | **GPIO 22** | trenzado con GND si es largo |
| **IRQ** | **GPIO 4** | imprescindible: el firmware detecta tarjetas por interrupción, sin bloquear |
| RSTO / RSTPDN | GPIO 33 (opcional) | Conéctalo solo si tu placa expone **RSTPDN** (p. ej. Adafruit). En la Elechouse V3 el pin **RSTO no se conecta**. Sin él, el firmware se recupera reiniciando el ESP32 si el lector se cuelga |

Junto a los pines VCC/GND del PN532: **100 nF + 10 µF** en paralelo (VCC a GND).

> Elegimos I2C porque usa 2 hilos de datos y deja libres los pines del relé y los LEDs. El firmware entregado **solo** implementa I2C.

---

## 3. ESP32 ↔ relé suelto con transistor NPN (lado de control)

El GPIO **no puede** mover la bobina directamente: da 3,3 V y ~20 mA, la bobina pide 5 V y ~70 mA. Un NPN hace de interruptor del lado de masa de la bobina. Lógica **activa en HIGH**: `RELAY_ACTIVE_LOW 0` en [`config.h`](../firmware/include/config.h) (ya configurado).

| GPIO 26 | Transistor | Bobina | Contacto COM–NO | Cerradura |
|---|---|---|---|---|
| **HIGH** (3,3 V) | conduce | activada (clic) | cerrado | **abierta** |
| **LOW** / sin programa / reinicio | cortado | en reposo | abierto | **bloqueada** |

### 3.1 Identificar las 5 patas del relé (multímetro)
Típico SRD-05VDC-SL-C visto desde abajo: 2 patas de bobina, COM, NO y NC. Confírmalo con el relé suelto:
1. **Bobina:** las dos patas que marcan **~70 Ω** entre sí (≈ 55–90 Ω). No tienen polaridad propia; la fija el diodo.
2. **COM y NC:** las dos que marcan **continuidad (0 Ω)** en reposo.
3. **NO:** la que queda; sin continuidad con COM en reposo. Aplica 5 V a la bobina: COM–NO pasa a 0 Ω y COM–NC se abre.

### 3.2 Identificar las patas del transistor
Las marcas varían: **PN2222A** (cara plana hacia ti, patas abajo) = **E-B-C**; **P2N2222A** (ON Semi) = **C-B-E**; **BC337** = **C-B-E**. Si dudas: multímetro en modo diodo, punta roja en una pata y la negra en las otras dos. La pata que da ~0,6–0,7 V hacia **las dos** es la **base**. De las otras dos, el **emisor** marca un poco más que el colector.

### 3.3 Conexiones

| Desde | Hasta | Por qué |
|---|---|---|
| **GPIO 26** | resistencia **1 kΩ** → **base** del NPN | limita la corriente de base a ~2,6 mA (de sobra para saturar ~70 mA) |
| **Base** del NPN | resistencia **10 kΩ** → **GND** | **pull-down**: mantiene el transistor cortado (relé en reposo, puerta bloqueada) mientras el ESP32 arranca, se reinicia o se programa y el GPIO queda flotando |
| **Emisor** del NPN | **GND** (punto único de masa, §5) | |
| **Colector** del NPN | **pata 2 de la bobina** | |
| **Pata 1 de la bobina** | **+5 V del reductor** | **no** desde el 3V3 del ESP32 ni desde su pin 5V si está alimentado por USB |
| Diodo **1N4007 / 1N4148** de bobina | **en paralelo con la bobina**: **franja (cátodo) → pata 1 (+5 V)**, ánodo → pata 2 (colector) | sin él, el pico de la bobina al apagar (>50 V) **destruye el transistor** en pocos ciclos |

```
            +5 V (reductor)
               │
               ├──────────┐
               │        ──┴──  1N4007/1N4148
          ┌────┴────┐    ▲     franja (cátodo) arriba, hacia +5 V
          │ BOBINA  │    │
          │  relé   │    │
          └────┬────┘    │
               ├─────────┘
               │ colector
 GPIO 26 ──[1 kΩ]──┬── base   NPN 2N2222A
                   │       emisor
                [10 kΩ]       │
                   │          │
 GND ──────────────┴──────────┴─── punto único de masa
```

> Este diodo de bobina es **adicional** al 1N4007 del solenoide (§4): uno protege el transistor, el otro el contacto del relé y la tierra.

**Si en el futuro usas un módulo relé con optoacoplador** (activo en LOW): cambia `RELAY_ACTIVE_LOW` a `1`, quita el jumper JD-VCC (VCC → 3V3, JD-VCC → 5 V) y cambia el pull-down por un **pull-up de 10 kΩ de IN a 3V3**.

---

## 4. Etapa de potencia: relé ↔ solenoide ↔ fuente 12 V

| Desde | Hasta | Calibre |
|---|---|---|
| Fuente **+12 V** | Relé **COM** | AWG 20–22 |
| Relé **NO** (normalmente abierto) | Solenoide **+** (cable rojo) | AWG 20–22 |
| Solenoide **−** (cable negro) | Fuente **−12 V (GND)** | AWG 20–22 |
| Relé **NC** | **sin conectar** | con un solenoide *fail-secure* |

### Diodo 1N4007 (dónde va exactamente)
**En paralelo con el solenoide, polarizado en inversa, soldado en los terminales del solenoide (lo más cerca posible de la bobina):**
- **Cátodo** (extremo con la **franja** gris/blanca) → terminal **+** del solenoide (el que va al NO del relé).
- **Ánodo** (extremo sin franja) → terminal **−** del solenoide (el que va al −12 V).

Con el relé cerrado, el diodo queda en inversa y no conduce. Al abrirse el relé, la bobina genera un pico negativo de cientos de voltios. El diodo lo cortocircuita a ~0,7 V dentro de la propia bobina. Sin él, ese pico salta como arco en el contacto del relé y viaja por la tierra: es lo que **reinicia el ESP32 y cuelga el PN532 al cerrar la puerta**.

**No lo pongas** sobre los contactos del relé ni al revés (al revés es un cortocircuito directo de la fuente al activar el relé).

Añade además un **condensador de 470–1000 µF/25 V** entre +12 V y −12 V, junto al relé (respetando la polaridad). Absorbe la caída de tensión al arrancar el solenoide.

---

## 5. Alimentación y tierra común

```
                     ┌─────────── FUENTE 12 V (≥2 A) ───────────┐
                     │ +12V                                −12V │
                     └───┬───────────────────────────────────┬──┘
                         │                                   │
          ┌──────────────┼──────────────┐                    │
          │              │              │                    │
          │         ┌────┴─────┐   Relé COM                  │
          │         │ REDUCTOR │   Relé NO ──┬── Solenoide + │
          │         │ 12V→5,0V │             │  [1N4007: franja aquí]
          │         └─┬──────┬─┘             └── Solenoide − ┤   ← retorno directo a la fuente
          │        5V │      │ GND                           │
          │           │      ●───────── PUNTO ÚNICO DE MASA ──┘   (−12V y GND 5V unidos aquí)
          │           │      │
          │   ESP32 VIN     ESP32 GND ── PN532 GND ── emisor NPN relé ── 10 kΩ pull-down ── LEDs/botón GND
          │   bobina relé (pata 1)
          │
     [470–1000 µF entre +12V y −12V junto al relé]
```

- **Tierra común:** los reductores LM2596/MP1584 **no son aislados**: su `IN−` y `OUT−` son el mismo conductor. Así, el −12 V de la fuente y el GND del ESP32 ya quedan unidos. Únelos en **un solo punto** (el borne `OUT−` del reductor o el −12 V de la fuente), en estrella.
- **La corriente del solenoide vuelve por su propio cable** directamente al −12 V. No la hagas pasar por los cables de GND del ESP32 ni del PN532: así el pico no "levanta" la tierra de la lógica.
- **Si usas dos fuentes** (por ejemplo, cargador USB para el ESP32 y fuente de 12 V para el solenoide): con el transistor NPN **es obligatorio unir sus GND** en un solo punto. Sin masa común, el HIGH del GPIO no tiene referencia y el relé no se activa (o lo hace de forma errática).
- **Ajusta el reductor a 5,0 V con el multímetro ANTES de conectar el ESP32.** Los LM2596 vienen de fábrica con cualquier tensión (a veces 12 V): quemarían la placa.
- **No alimentes el ESP32 por USB y por VIN a la vez** en la instalación final. Para programar, desconecta VIN o usa solo el USB.

---

## 6. Interfaz de usuario

| Elemento | ESP32 | Conexión |
|---|---|---|
| Pulsador de salida (NA) | GPIO 27 | un terminal a GPIO 27, el otro a GND (pull-up interno) |
| Reed switch (opcional) | GPIO 25 | a GND; cerrado = puerta cerrada. Si no lo usas: `PIN_DOOR_SENSOR -1` |
| LED verde | GPIO 18 | GPIO → 330 Ω → ánodo (pata larga); cátodo → GND |
| LED rojo | GPIO 19 | igual |
| Zumbador activo 5 V | GPIO 23 | GPIO → 1 kΩ → base 2N2222; emisor → GND; colector → (−) zumbador; (+) zumbador → 5 V |

Pines evitados a propósito: 0, 2, 5, 12, 15 (arranque) y 6–11 (flash interna).

### Resumen pin a pin del ESP32
| GPIO | Función | | GPIO | Función |
|---|---|---|---|---|
| 21 | PN532 SDA | | 26 | 1 kΩ → base NPN del relé (10 kΩ base → GND); HIGH = abre |
| 22 | PN532 SCL | | 27 | Pulsador de salida |
| 4 | PN532 IRQ | | 25 | Reed switch |
| 33 | PN532 RSTPDN (opcional) | | 18 / 19 | LED verde / rojo |
| 3V3 | PN532 VCC | | 23 | Zumbador (vía transistor) |
| VIN | 5 V del reductor (el mismo que la bobina del relé) | | GND | punto único de masa |

---

## 7. Compilar y cargar

```bash
cd firmware
cp include/secrets.example.h include/secrets.h      # y rellénalo (docs/06, paso 7)
pio run                                              # compilar
pio run -t upload --upload-port COM3                 # cargar (tu ESP32 está en COM3)
pio device monitor -p COM3                           # ver el log (115200 baudios). Salir: Ctrl+C
```
Si la carga se queda en `Connecting....`, mantén pulsado **BOOT** en el ESP32 hasta que empiece a escribir.

Log esperado al arrancar:
```
Control de Acceso 1.0.0 — dispositivo puerta01x
Caché: 0 UIDs (versión ), 0 eventos pendientes
PN532 firmware 1.6
WiFi conectado: 192.168.x.x  RSSI -5x
MQTT conectado
Lista blanca sincronizada: N UIDs (heap libre ...)
```

### Orden de prueba en banco (no instales en la puerta hasta pasar los 5)
1. **Solo ESP32 por USB**: carga y mira el log (WiFi y MQTT conectados, la puerta aparece **En línea** en el panel).
2. **+ PN532**: debe salir `PN532 firmware 1.6`. Acerca una tarjeta: verás la alerta roja "Tarjeta no registrada" en el panel.
3. **+ relé sin solenoide**: al encender, el relé **no** debe hacer clic (pull-down OK). Botón "Abrir puerta" en el panel → clic, LED verde 3 s y continuidad COM–NO con el multímetro; al terminar, nuevo clic y COM–NO abierto. Si el relé queda activado al arrancar o nunca se activa, revisa `RELAY_ACTIVE_LOW 0` y las patas E-B-C del transistor.
4. **+ 12 V y solenoide (con diodo)**: abrir/cerrar 20 veces seguidas sin que el ESP32 se reinicie (mira el monitor).
5. **Offline**: registra un llavero, espera 1 min, desconecta el router: el llavero debe seguir abriendo (LED rojo destella cada 3 s = sin red).

---

## 8. Diseño del firmware

```
 Núcleo 1 — "reader" (prio 3)                     Núcleo 0 — "net" (prio 2)
 PN532 por IRQ (no bloquea)                        WiFi no bloqueante + reintento cada 20 s
 anti-rebote de la misma tarjeta (2,5 s)           esp-mqtt: tarea propia, TLS, reconexión sola, LWT
 ¿modo registro? → envía UID a la web              HTTPS persistente a device-ingest (bundle de CAs)
 ¿online? → pregunta al servidor (≤ 2,5 s)  ───►   access / enroll_read / ack / heartbeat / allowlist / events
 si no hay respuesta → decide la CACHÉ             comandos MQTT firmados → HMAC, exp, anti-replay
 relé + LEDs + zumbador + botón de salida          latido 60 s: hora, lockdown, hold-open, versión de lista
 watchdog 30 s                                     sube la cola offline cada 15 s
```

- **Decisión de acceso:** con red, decide el servidor (revocación instantánea, log en vivo). Si no responde en 2,5 s o no hay red, decide la caché. Mientras espera, el relé, los LEDs y el botón de salida siguen respondiendo.
- **Caché offline (LittleFS):** hasta **400 UIDs** con vigencia, días, ventana horaria y desfase horario del sitio. Se escribe de forma atómica (`.tmp` + `rename`) y se re-sincroniza cuando cambia la huella que trae el latido: una revocación llega a la caché en ≤ 60 s.
- **Cola offline:** hasta 200 eventos en flash. Se suben al volver la red con su hora real (`meta.offline = true`).
- **Comandos** (`acc/v1/<code>/cmd`): `unlock`, `hold_open`, `release`, `lockdown_on/off`, `enroll_start/cancel`. Se verifican con HMAC-SHA256, ventana `iat/exp` ±30 s e id no repetido, y se confirman por HTTPS.
- **El servidor manda:** el latido devuelve lockdown y mantener-abierta. Un comando MQTT perdido se corrige en ≤ 60 s.
- **Recuperación:** watchdog de 30 s. El PN532 se comprueba cada 60 s; si funcionaba y deja de responder 3 veces, el ESP32 se reinicia (el relé vuelve a reposo = cerrado).

### Señales
| LEDs / zumbador | Significado |
|---|---|
| Verde fijo + bip | abierto |
| Rojo 1 s + 3 bips | denegado |
| Verde/rojo alternando | modo registro: acerca la tarjeta |
| Verde parpadeando + 2 bips | tarjeta registrada |
| Rojo 1 Hz | bloqueo total |
| Destello rojo cada 3 s | sin conexión (funciona con la caché) |
| Destello verde cada 5 s | normal |

## 9. Comportamiento ante fallos y límites

| Situación | Qué pasa |
|---|---|
| Sin internet | Tarjetas autorizadas abren con la caché. Pases de invitado y apertura remota no (el PIN se valida en el servidor). |
| Corte de luz | Cerradura **bloqueada** (fail-secure). Lockdown y caché persisten. |
| Arranque sin internet | Sin reloj con batería: hasta tener hora solo abren credenciales sin restricción horaria y admins (añade un DS3231 si lo necesitas). |
| Bloqueo total | Solo admins. **El botón de salida siempre abre.** |
| Comando con firma mala / vencido / repetido | Se ignora. |

- **Las tarjetas típicas se pueden clonar:** los llaveros azules y tarjetas blancas (MIFARE Classic) tienen un UID copiable. Para alta seguridad usa DESFire EV2/EV3.
- **Sin OTA:** el firmware se actualiza por USB.
- **Registro duplicado posible:** si el servidor responde justo después de los 2,5 s, el intento puede quedar registrado dos veces.
