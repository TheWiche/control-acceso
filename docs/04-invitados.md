# Fase 3 — Accesos de invitado y vista pública

## Piezas

| Capa | Archivo | Qué hace |
|---|---|---|
| SQL | `supabase/migrations/20261026000500_guest_passes_v2.sql` | PIN personalizado, `fn_rotate_guest_pass`, `fn_pass_preview` (estado + log del intento), `fn_refund_pass_use`. |
| Edge (pública) | `supabase/functions/pass` | `preview` y `redeem` del invitado. Sin JWT. |
| Edge (staff) | `supabase/functions/pass-manage` | `create` y `rotate`. JWT admin/operador. |
| Edge (admin) | `unlock`, `device-control`, `enroll-start`, `enroll-cancel` | Las 4 funciones que el panel de la Fase 2 ya invocaba. |
| Compartido | `supabase/functions/_shared/` | `crypto.ts` (HMAC, probado contra Node), `mqtt.ts` (comando firmado + espera de ACK), `common.ts` (CORS, roles, rate limit). |
| Panel | `web/src/pages/Guests.tsx`, `components/PassForm.tsx`, `PassShare.tsx` | Lista, alta, WhatsApp, regenerar, revocar. |
| Invitado | `web/src/pages/GuestKey.tsx` | Ruta pública `#/p/<token>[?d=<puerta>]`. |

## Por qué no se puede burlar desde el navegador

El navegador solo envía `token + PIN + puerta`. Todo lo demás se decide en el servidor, en una transacción SQL:

1. **Token de 128 bits** (22 caracteres), guardado solo como `sha256`. No se adivina; va en el fragmento `#`, que no llega al hosting ni a `Referer`.
2. **PIN con bcrypt**; 5 fallos bloquean el pase 15 min, y el 5.º ya responde "bloqueado". El PIN se verifica **antes** de revelar el estado en el canje.
3. **Rate limit** por IP (60/5 min) y por token (12/10 min) antes de tocar la lógica; lo bloqueado no escribe logs (no se puede inundar el registro).
4. **Vigencia, días, horario, puerta, revocación y usos** se evalúan con la hora del servidor y la zona horaria del sitio. Cambiar el reloj del teléfono no sirve.
5. **El uso se consume de forma atómica** (`UPDATE … WHERE uses_count < max_uses`): dos taps simultáneos no pasan de `max_uses`.
6. **La apertura exige un comando MQTT firmado** (su argumento lleva también el nombre del invitado, que la pantalla de la cerradura muestra) (HMAC con clave derivada por dispositivo, `exp` 8 s). El navegador nunca ve ni la clave ni el broker.
7. **Confirmación física:** la función espera el ACK del ESP32. Si no llega, devuelve el uso (`fn_refund_pass_use`, idempotente, ventana de 2 min). Es seguro porque a los 8 s el ESP32 ya rechazaría ese comando.
8. **Nada en el cliente es autoridad:** la vista pública solo muestra lo que responde `pass`. Revocar desde el panel surte efecto en el siguiente intento.

### Registro de intentos fallidos
- Con PIN: `fn_authorize_pass` escribe en `access_logs` cada intento (PIN malo, expirado, revocado, agotado, fuera de horario, bloqueado…).
- Sin PIN (solo abrir el enlace de un pase no usable): `fn_pass_preview` registra `pass_expired`, `pass_revoked`, etc., **1 vez cada 10 min por pase y estado** (`meta.stage = "preview"`).
- Token inexistente: no se registra (no hay a quién atribuirlo) pero sí cuenta para el rate limit.
- Aparecen en el feed del panel con el nombre del invitado.

## Sticker NFC
- URL por puerta: `https://<usuario>.github.io/<repo>/#/p/<token>?d=<device_code>` (el modal de compartir la muestra; en Android + Chrome, botón **Escribir** con Web NFC; en iPhone usa «NFC Tools»).
- Acercar el teléfono abre la vista, que pide el PIN y abre. iOS lee NDEF en segundo plano (iPhone XS o posterior) y lo abre en Safari: no requiere instalar la PWA.
- El sticker **no contiene el PIN**. Si se pierde o lo fotografían, el atacante aún necesita el PIN (5 intentos) y puedes revocar o regenerar.
- Un sticker por pase: el token identifica al pase. Para "un sticker permanente de la puerta" con PIN distinto por invitado hace falta el modelo de *tag de puerta* (Fase 4: NTAG 424 DNA).

## Despliegue

```bash
supabase db push                                   # aplica la migración 5
supabase secrets set \
  DEVICE_MASTER_KEY=<hex64> MQTT_URL=wss://<host>:<puerto>/mqtt \
  MQTT_USERNAME=acc-publisher MQTT_PASSWORD=<pwd> \
  APP_ORIGIN=https://<usuario>.github.io,http://localhost:5173
supabase functions deploy pass --no-verify-jwt     # pública: autentica por token + PIN
supabase functions deploy pass-manage unlock device-control enroll-start enroll-cancel
```

`APP_ORIGIN` es una lista separada por comas (se usa para CORS). Las funciones con JWT lo verifican en el gateway **y** de nuevo contra `profiles.role`.

## Límites conocidos (léelos antes de usar en producción)
- **Estado actual:** `device-ingest` y el firmware existen y están desplegados. El ESP32 confirma cada apertura (ACK) por HTTPS, y las Edge Functions funcionan contra tu Supabase y tu broker EMQX: la apertura desde el panel y los comandos se probaron con la cerradura real.
- **Sin ACK el invitado no entra:** si el ESP32 no confirma en el plazo, `pass` devuelve «la cerradura no respondió» y le **devuelve el uso**. Es lo esperado cuando la cerradura está desconectada.
- **Pendiente de probar con el hardware:** el flujo completo de un pase de invitado en la puerta física (enlace + PIN desde un móvil real).
- El mensaje de WhatsApp por defecto lleva enlace **y** PIN juntos (como pediste); si lo reenvían, quien lo reciba puede entrar. La casilla «PIN en mensaje aparte» lo evita.
- `wa.me` requiere el número en formato internacional (con código de país).
- El enlace y el PIN no se pueden recuperar (solo hash): se **regeneran**, lo que invalida el anterior.
- Un admin puede ver quién usó cada pase, pero no reenviar el mismo enlace: es una decisión de seguridad, no un olvido.
