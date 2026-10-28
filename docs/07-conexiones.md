# Conexiones físicas, una a una (montaje actual)

Este documento describe **exactamente** el montaje que funciona hoy:

- ESP32 DevKit con firmware **1.3.0**.
- Lector **PN532 por SPI**.
- Cerradura solenoide de 12 V conmutada por un **MOSFET IRFZ44N** con **dos transistores 2N2222A** delante.
- **LEDs** verde y rojo y **pantalla TFT 1,8"**.
- Todo alimentado por **un único módulo de pared** (3,3 V, 5 V y 12 V).

La explicación de por qué cada pieza va así está en [05-firmware.md](05-firmware.md). Aquí solo está **qué va con qué**.

**Cómo leerlo.** Las conexiones están agrupadas por **puntos de unión**. Un punto es un sitio donde se juntan varios cables o patas: todo lo que aparece en la lista de un punto va unido entre sí, y **con nada más**. En una protoboard, un punto es una fila; en una placa soldada, una pista o una isla de estaño.

---

## 0. Antes de empezar

### 0.1 Piezas
| Cantidad | Pieza | Nombre en este documento |
|---|---|---|
| 1 | ESP32 DevKit (ESP32-WROOM-32, 4 MB) | ESP32 |
| 1 | Lector NFC PN532 (placa roja «PN532 NFC RFID V3») | PN532 |
| 1 | Pantalla TFT 1,8" 128×160 (chip ST7735), pines GND · VCC · SCL · SDA · RST · DC · CS · BLK | pantalla |
| 1 | Cerradura solenoide 12 V DC, *fail-secure* (bloquea sin corriente) | solenoide |
| 1 | MOSFET **IRFZ44N** (encapsulado TO-220) | MOSFET |
| 2 | Transistores NPN **2N2222A** | Q1 y Q2 |
| 1 | Diodo **1N4007** | diodo |
| 1 | Condensador electrolítico **1000 µF / 25 V** | C1 |
| 1 | Resistencia **1 kΩ** | R1 |
| 4 | Resistencias **10 kΩ** | R2, R3, R4, R5 |
| 2 | Resistencias **330 Ω** | R6, R7 |
| 1 + 1 | LED verde y LED rojo | LED V, LED R |
| 1 | Módulo de pared multivoltaje: salidas **+3,3 V, +5 V, +12 V y GND** | módulo |
| — | Opcional: condensadores 100 nF y 10 µF (PN532), 470 µF (ESP32) | |
| — | Opcional: pulsador de salida, sensor magnético de puerta (reed), zumbador activo 5 V + otro 2N2222A + 1 kΩ | |

### 0.2 Cómo identificar cada pata
| Pieza | Cómo reconocer sus patas |
|---|---|
| **ESP32** | Cada pin tiene su nombre impreso: **D13, D14, D15, D16, D17, D18, D19, D21, D22, D26, D32, D33, D4**, VIN y GND. En este documento "D26" = GPIO 26. |
| **IRFZ44N** | Cara impresa hacia ti, patas hacia abajo, de izquierda a derecha: **1 = G (Gate) · 2 = D (Drain) · 3 = S (Source)**. La **pestaña metálica es el Drain**. |
| **2N2222A** | Depende del fabricante: **PN2222A** = E · B · C y **P2N2222A** = C · B · E (cara plana hacia ti). **Compruébalo con el multímetro en modo diodo:** la pata que marca ~0,6–0,7 V hacia **las otras dos** es la **base (B)**, y de las otras dos el **emisor (E)** marca un poco más que el colector (C). |
| **Diodo 1N4007** | La **franja gris o blanca** es el **cátodo**. El otro extremo es el ánodo. |
| **Condensador electrolítico** | La pata **larga** es el **+**. La franja con signos **−** marca la pata negativa. **Al revés se calienta y puede reventar.** |
| **LED** | La pata **larga** es el **+** (ánodo). La **corta**, o el lado plano del borde, es el **−** (cátodo). |
| **Resistencias** | 330 Ω = naranja · naranja · **marrón** · 1 kΩ = marrón · negro · **rojo** · 10 kΩ = marrón · negro · **naranja**. **Mídelas con el multímetro antes de soldar:** confundir colores fue la causa de uno de los fallos (§12). |
| **PN532** | Conector de 4 pines (GND · VCC · SDA · SCL) y conector lateral de 8 pines (SCK · MISO · MOSI · SS · VCC · GND · IRQ · RSTO). Interruptor de 2 palancas con una tabla impresa al lado. |

---

## 1. Fuente de alimentación
Todo sale del **módulo de pared**:

| Salida del módulo | Alimenta a |
|---|---|
| **+12 V** | solenoide y la puerta del MOSFET (a través de R3 y R5) |
| **+5 V** | ESP32 (pin VIN) |
| **+3,3 V** | PN532 y pantalla |
| **GND** | todo; es el punto común de tierra |

**El ESP32 nunca se alimenta por USB y por VIN a la vez.** Para cargar firmware por USB, **quita antes el cable de VIN**. El resto puede seguir alimentado por el módulo, siempre que el GND siga unido.

---

## 2. Puntos de alimentación

**Punto 1: +12 V**
1. Borne **+12 V** del módulo
2. Cable **rojo (+)** del solenoide
3. **Extremo con franja** del diodo 1N4007
4. Pata **+** (larga) del condensador C1
5. Una pata de **R3** (10 kΩ)
6. Una pata de **R5** (10 kΩ)

**Punto 2: +5 V**
1. Borne **+5 V** del módulo
2. Pin **VIN** del ESP32
3. *(opcional)* pata **+** del condensador de 470 µF
4. *(opcional)* **+** del zumbador

**Punto 3: +3,3 V**
1. Borne **+3,3 V** del módulo
2. Pin **VCC** del PN532
3. Pin **VCC** de la pantalla
4. Pin **BLK** de la pantalla (luz de fondo siempre encendida)
5. *(opcional)* una pata del condensador de 100 nF y la pata + del de 10 µF, ambos junto al PN532

---

## 3. Mando de la cerradura (ESP32 → Q1 → Q2 → MOSFET → solenoide)

**Por qué hay dos transistores.** El IRFZ44N necesita bastante más de 3,3 V en la puerta para conducir. Con solo los 3,3 V del ESP32 el solenoide no se mueve; lo comprobamos midiendo 11,8 V entre D y S. Q1 y Q2 le dan **12 V a la puerta** sin invertir la lógica: **D26 en alto abre**, y en el arranque o un reinicio **la puerta sigue cerrada**.

| D26 | Q1 | Q2 | Puerta del MOSFET | Solenoide |
|---|---|---|---|---|
| **Alto (3,3 V)**: orden de abrir | conduce | apagado | 12 V (por R5) | **activado (abre)** |
| **Bajo**, o ESP32 arrancando o reiniciándose | apagado (R2 lo mantiene) | conduce | 0 V | **en reposo (cerrado)** |

**Punto 4: control**
1. Pin **D26** del ESP32
2. Una pata de **R1** (1 kΩ)

**Punto 5: base de Q1**
1. La otra pata de **R1**
2. **Base (B)** de Q1
3. Una pata de **R2** (10 kΩ). La otra pata de R2 va al **punto 11**.

**Punto 6: colector de Q1**
1. **Colector (C)** de Q1
2. La otra pata de **R3** (la primera está en el punto 1, +12 V)
3. Una pata de **R4** (10 kΩ)

**Punto 7: base de Q2**
1. La otra pata de **R4**
2. **Base (B)** de Q2

**Punto 8: Gate**
1. **Colector (C)** de Q2
2. La otra pata de **R5** (la primera está en el punto 1, +12 V)
3. **Pata 1 (G)** del MOSFET

**Punto 9: Drain**
1. **Pata 2 (D)** del MOSFET
2. Cable **negro (−)** del solenoide
3. **Extremo sin franja** del diodo 1N4007

Etapa 1 (Q1):
```
                          +12 V
                            │
                         [R3 10k]
                            │
 D26 ──[R1 1k]──┬── B  Q1   C ──── hacia R4 (etapa 2)
                │       E
             [R2 10k]   │
                │       │
               GND     GND
```

Etapa 2 (Q2):
```
                                     +12 V
                                       │
                                    [R5 10k]
                                       │
 (colector de Q1) ──[R4 10k]── B  Q2   C ──── Gate (pata 1) del IRFZ44N
                                   E
                                   │
                                  GND
```

Etapa 3 (potencia):
```
 +12 V (punto 1)
   ├── Solenoide (+) ──┐
   │                   ├── diodo 1N4007 (franja hacia el +12 V)
   │   Solenoide (−) ──┘
   │        │
   │   Drain (pata 2) ── IRFZ44N ── Gate (pata 1) ← colector de Q2
   │                        │
   │                   Source (pata 3)
   │                        │
   └── C1 (+)    C1 (−) ────┴──── GND de potencia (punto 10) → borne GND del módulo
```

La **pestaña metálica** del MOSFET es el Drain: que **no toque** GND, otros cables ni otro disipador.

---

## 4. Tierras: dos grupos que solo se unen en el módulo

**Punto 10: GND de potencia** (por aquí vuelve la corriente del solenoide)
1. **Pata 3 (S)** del MOSFET
2. Pata **−** del condensador C1
3. **Un cable** directo al borne **GND del módulo**

**Punto 11: GND de control** (todo lo demás)
1. Pin **GND** del ESP32
2. Pin **GND** del PN532
3. Pin **GND** de la pantalla
4. **Emisor (E)** de Q1
5. **Emisor (E)** de Q2
6. La otra pata de **R2**
7. **Pata corta** del LED verde y **pata corta** del LED rojo
8. *(opcional)* la otra pata del condensador de 100 nF, la pata − del de 10 µF y la pata − del de 470 µF
9. *(opcional)* un lado del pulsador, un lado del sensor de puerta y el emisor del transistor del zumbador
10. **Otro cable** al borne **GND del módulo**

Los puntos 10 y 11 **no se unen en la placa**: cada uno llega con **su propio cable** al borne GND del módulo, y ahí quedan unidos. Así el pico del solenoide no llega al ESP32 ni al lector.

---

## 5. Lector PN532 (SPI)

**Interruptor de modo**, con la placa apagada: **palanca 1 en OFF** (lejos de «ON») y **palanca 2 en ON** (hacia «ON»). Coincide con la fila **SPI = 0 1** de la tabla impresa. El PN532 solo lee el interruptor al encenderse: si lo cambias con la placa alimentada, quítale la corriente unos segundos.

| Pin del PN532 (conector lateral de 8 pines) | Va a |
|---|---|
| **SCK** | **D22** del ESP32 |
| **MOSI** | **D21** del ESP32 |
| **MISO** | **D32** del ESP32 |
| **SS** | **D33** del ESP32 |
| **IRQ** | **D4** del ESP32 |
| **VCC** | **punto 3** (+3,3 V). **Nunca 5 V.** |
| **GND** | **punto 11** |
| RSTO | **sin conectar** |
| SDA y SCL (conector de 4 pines) | **sin conectar**: solo se usan en modo I2C |

Lleva estos cables **cortos (menos de 20 cm)** y **lejos** de los del solenoide.

---

## 6. Pantalla TFT 1,8"
Aunque los pines digan SCL y SDA, **es SPI** (SCL = reloj, SDA = dato). Va en su propio bus, separado del lector.

| Pin de la pantalla | Va a |
|---|---|
| **GND** | **punto 11** |
| **VCC** | **punto 3** (+3,3 V) |
| **SCL** | **D14** del ESP32 |
| **SDA** | **D13** del ESP32 |
| **RST** | **D16** del ESP32 |
| **DC** | **D17** del ESP32 |
| **CS** | **D15** del ESP32 |
| **BLK** | **punto 3** (+3,3 V) |

---

## 7. LEDs

**Punto 12:** pin **D18** del ESP32 y una pata de **R6** (330 Ω).
**Punto 13:** la otra pata de **R6** y la **pata larga** del **LED verde**.
**Punto 14:** pin **D19** del ESP32 y una pata de **R7** (330 Ω).
**Punto 15:** la otra pata de **R7** y la **pata larga** del **LED rojo**.

Las **patas cortas** de los dos LEDs van al **punto 11**.

---

## 8. Opcionales

| Elemento | Conexión |
|---|---|
| **Pulsador de salida** | un terminal a **D27**, el otro al **punto 11**. Abre siempre, incluso en bloqueo total y sin red |
| **Sensor magnético de puerta (reed)** | un terminal a **D25**, el otro al **punto 11** (cerrado = puerta cerrada) |
| **Zumbador activo 5 V** | **D23** → 1 kΩ → **base** de un tercer 2N2222A; **emisor** → punto 11; **colector** → **−** del zumbador; **+** del zumbador → **punto 2** (+5 V) |

---

## 9. Resumen pin a pin del ESP32
| Pin | Va a | | Pin | Va a |
|---|---|---|---|---|
| **VIN** | punto 2 (+5 V) | | **D26** | R1 (mando de la cerradura) |
| **GND** | punto 11 | | **D18** | R6 → LED verde |
| **D22** | PN532 SCK | | **D19** | R7 → LED rojo |
| **D21** | PN532 MOSI | | **D14** | pantalla SCL |
| **D32** | PN532 MISO | | **D13** | pantalla SDA |
| **D33** | PN532 SS | | **D15** | pantalla CS |
| **D4** | PN532 IRQ | | **D16** | pantalla RST |
| *(opcional)* **D27** | pulsador de salida | | **D17** | pantalla DC |
| *(opcional)* **D25** | sensor de puerta | | *(opcional)* **D23** | zumbador (vía transistor) |
| **3V3** | **no se usa** | | **0, 2, 5, 12** | **no usar** (pines de arranque) |

Estos pines están definidos en [`firmware/include/config.h`](../firmware/include/config.h). Si cambias un cable de pin, cambia allí la línea correspondiente y vuelve a cargar el firmware.

---

## 10. Revisión con el multímetro, ANTES de enchufar
Todo desenchufado. Multímetro en continuidad, el modo que pita:

| Entre… | Debe… | Si no… |
|---|---|---|
| Punto 1 (+12 V) y punto 10 u 11 (GND) | **no** pitar | hay un corto en los 12 V |
| Punto 2 (+5 V) y punto 11 | **no** pitar | corto en los 5 V |
| Punto 3 (+3,3 V) y punto 11 | **no** pitar | corto en los 3,3 V |
| Punto 10 y punto 11 | **sí** pitar | falta uno de los dos cables al borne GND del módulo |
| Pin GND del ESP32 y el emisor de Q1, el emisor de Q2 y la pata corta de cada LED | **sí** pitar | ese punto no está unido al GND de control |

En ohmios:

| Entre… | Debe dar |
|---|---|
| Punto 4 (D26) y punto 11 | **unos 11 kΩ** (R1 + R2). Si da casi 0, hay un corto: fue el fallo del §12 |
| Las dos patas de cada resistencia | su valor (330 Ω, 1 kΩ, 10 kΩ) |

---

## 11. Prueba de encendido, paso a paso
1. **Enchufa el módulo.** El solenoide **no** debe activarse. Si se activa, desenchufa y revisa Q1, Q2 y R2.
2. **A los ~10 s:** la pantalla muestra la hora y "Acerque su tarjeta", el LED verde da un **destello corto cada 5 s**, y el panel muestra la puerta **En línea**.
3. **Panel → Abrir puerta:** el solenoide golpea durante **3 s** y suelta. Pantalla en verde ("Abierto") y LED verde fijo.
4. **Llavero registrado:** "Bienvenido" con tu nombre, bip y apertura.
5. **Tarjeta sin registrar:** "Denegado · Tarjeta no registrada" con su UID, LED rojo y alerta en el panel.
6. **Mantener abierta → 30 s:** el solenoide queda activado, la pantalla muestra "Puerta abierta · Cierra en 0:29…" y se cierra solo.
7. **Medida de control,** durante "Mantener abierta":
   - Pata **G** del MOSFET contra GND: unos **12 V**.
   - Entre las patas **D y S**: **menos de 0,3 V**.

Si el MOSFET se calienta o D–S marca más de 1 V, no está conduciendo del todo: revisa Q1 y Q2.

---

## 12. Problemas que ya nos pasaron y cómo se resolvieron
| Síntoma | Causa real | Solución |
|---|---|---|
| El log decía `Relé ACTIVADO pero GPIO 26 lee 0` y D26 marcaba ~0,2 V | **Cortocircuito a GND** en el circuito conectado a D26 (la protoboard) | Se rehízo en placa. Comprueba que entre el punto 4 y el punto 11 haya **~11 kΩ** |
| Chispa al activar y el módulo intentaba apagarse | El solenoide pedía más corriente de golpe de la que daba el módulo en ese montaje | Condensador C1 de 1000 µF y **tierras separadas** (puntos 10 y 11). Si vuelve a pasar, alimenta el solenoide con un **adaptador de 12 V aparte** (§13) |
| El MOSFET no movía el solenoide (11,8 V entre D y S) | El IRFZ44N **no conduce con 3,3 V** en la puerta | Q1 + Q2 dan 12 V a la puerta (§3), o se cambia por un **IRLZ44N** (§13) |
| D18 daba 3,3 V pero el LED no encendía | LED al revés o dañado, o resistencia de valor equivocado | Pata larga hacia la resistencia; mide las resistencias; prueba el LED en modo diodo |
| `PN532 no responde` con `Error 263` y SCL en 0 | Modo **I2C** con el ESP32: el PN532 bloquea la línea SCL | Pasar a **SPI** (§5): interruptor en 1 OFF / 2 ON y cables al conector de 8 pines |
| `PN532 no responde por SPI` | Interruptor sin reiniciar el lector, o un cable suelto | Quita la corriente al PN532 después de mover el interruptor; revisa SCK, MOSI, MISO y SS |
| El solenoide abría al conectar los 12 V y se quedaba abierto (montaje con relé) | El + del solenoide estaba en **NC** en vez de **NO** | Ya no aplica: el relé se sustituyó por el MOSFET |

---

## 13. Variantes
| Variante | Qué cambia |
|---|---|
| **IRLZ44N** en lugar de IRFZ44N | Conduce con 3,3 V: **sobran Q1, Q2, R3, R4 y R5**. D26 → R1 (1 kΩ) → G, y R2 (10 kΩ) de G al punto 10. Mismas patas G · D · S y mismo firmware |
| **Adaptador de 12 V aparte para el solenoide** | El **+12 V** del adaptador sustituye al del módulo en el **punto 1**, y el **−** del adaptador va al **punto 10**. La salida de 12 V del módulo queda sin usar |
| **Sin pantalla** | `DISPLAY_ENABLED 0` en `config.h` y no se conecta |
| **Pantalla vertical** | `TFT_ROTATION 0` en `config.h` |
| **Colores de la pantalla cambiados** o basura en los bordes | `TFT_TAB INITR_GREENTAB` (o `INITR_REDTAB`) en `config.h` |
