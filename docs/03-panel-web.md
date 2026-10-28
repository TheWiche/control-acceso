# Fase 2 — Panel de administración (PWA)

Código en [`web/`](../web/). Stack: **Vite + React + TypeScript**, CSS propio (sin framework), `react-router` con **HashRouter**, `@supabase/supabase-js`, `vite-plugin-pwa`, `lucide-react`.

## Arranque

```bash
cd web
npm install
npm run demo                 # UI con datos simulados, sin Supabase
cp .env.example .env.local   # rellena URL y clave publishable
npm run dev                  # contra tu Supabase
npm run build                # tsc + vite build -> web/dist
```

Antes de usarlo contra Supabase aplica también `supabase/migrations/20261026000400_lockdown_hold_open.sql`.

## Despliegue en GitHub Pages
1. Repo → **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Push a `main`: `.github/workflows/deploy.yml` compila con `VITE_BASE=/<repo>/` y publica. Hay que commitear `web/package-lock.json` (el workflow usa `npm ci`).
4. En Supabase, añade `https://<usuario>.github.io/<repo>/` a *Redirect URLs*.

## Tarjeta de la puerta: reglas de los botones
El panel y el servidor aplican las mismas reglas; el servidor es el que decide, así que no se pueden saltar desde el navegador.

| Situación | Qué pasa |
|---|---|
| Hay una orden en curso | **Todos los botones quedan bloqueados** hasta tener el estado nuevo |
| La puerta ya está abierta (pulso, «mantener abierta» o salida activa) | **Abrir puerta** se desactiva y muestra «Puerta liberada · se cierra en m:ss» |
| Bloqueo total activo | **Mantener abierta** no está disponible («Quita primero el bloqueo total»); activar el bloqueo **cierra** una puerta liberada |
| Cerradura desconectada | **Abrir** y **Mantener abierta** no están disponibles |
| Puerta ya liberada | **Mantener abierta** pasa a **Cambiar tiempo** (cuenta desde ahora) |

- **Duración libre:** de **5 s a 4 h**, escrita en segundos, minutos u horas, además de los atajos (30 s, 1 min, 5, 15, 30 min, 1 h). Por encima de 5 min avisa del calentamiento del solenoide.
- **«Desconectado»** aparece a los 45 s sin latido del ESP32 (el latido es cada 15 s).
- **Telemetría:** señal, último latido, IP y versión del firmware, cuánto lleva encendida la cerradura y **el motivo del último reinicio** («caída de tensión» en rojo delata una fuente débil).
- **«Mantener abierta» y los accesos con tarjeta o pase** aparecen en el registro; el primero con su duración.

## Página «Ajustes»
Un administrador cambia desde el panel lo que antes exigía tocar el código. Cada cambio se valida en el formulario **y** en la base de datos (restricciones `check` y RLS: un usuario normal no puede escribir).

| Ajuste | Rango | Qué controla |
|---|---|---|
| **Tiempo que se mantiene abierta** | 0,5 a 30 s (admite coma decimal) | cuánto abre la cerradura con tarjeta, desde la app, con un pase de invitado y con el botón de salida (`devices.unlock_ms`) |
| **Mensajes en la pantalla** | 1 a 10 s | cuánto se ve «Bienvenido» o «Denegado» (`devices.display_msg_s`); si la puerta sigue abierta, se ve hasta que cierre |
| **Nombre** y **ubicación** | nombre no vacío | cómo se llama la puerta en el panel y en la pantalla |
| **Puerta habilitada** | sí / no | deshabilitada, ninguna tarjeta ni pase abre; el botón de salida sí |
| **Zona horaria** (del lugar) | lista IANA | horarios de tarjetas e invitados y hora de la pantalla (`sites.timezone`) |

Los cambios llegan a la cerradura con el siguiente latido (≤ 15 s). «Mantener abierta» no se configura aquí: su duración se elige cada vez, de 5 s a 4 h.

## Estructura
```
web/src/
  lib/        types.ts · api.ts (contrato) · liveApi.ts (Supabase) · demoApi.ts · format.ts
  context/    Auth.tsx          (sesión + exige rol admin)
  components/ DoorCard · ActivityFeed · Metrics · EnrollModal · CardEditor · Shell · ui
  pages/      Login · Dashboard · Cards
```
La UI solo conoce la interfaz `Api`; `liveApi` y `demoApi` la implementan.

## Qué funciona sin Edge Functions y qué no

| Función | Depende de |
|---|---|
| Login, listas, métricas, feed en vivo, telemetría | Solo Supabase (RLS + Realtime) |
| Activar/desactivar/editar/eliminar tarjetas, asignar personas, horarios | Solo Supabase |
| **Abrir puerta, Bloqueo total, Mantener abierta, Modo registro** | Edge Functions (escritas en la Fase 3, ver `docs/04-invitados.md`) + firmware/`device-ingest` |

## Contrato de las Edge Functions que el panel invoca
Todas: `POST`, JWT del usuario, verifican `profiles.role = 'admin'`, responden JSON con `ok:false,error` en fallo.

| Función | Body | Respuesta | Efecto |
|---|---|---|---|
| `unlock` | `{device_code}` | `{ok, command_id}` | `fn_authorize_member_unlock` + fila en `device_commands` + MQTT `unlock`. El ESP32 hace ACK y la fila pasa a `acked`. |
| `device-control` | `{device_code, action, seconds?}`, `action` ∈ `lockdown_on`, `lockdown_off`, `hold_open`, `release` (`minutes` sigue aceptándose por compatibilidad) | `{ok, delivered, hold_open_until}` | Valida en el servidor, actualiza `devices.lockdown` / `hold_open_until`, deja `hold_open` en el registro (`fn_log_hold_open`) y publica el comando MQTT con la hora absoluta de cierre. |
| `enroll-start` | `{device_code, kind}` | `{ok, session}` (fila de `enrollment_sessions`) | Expira sesiones viejas, inserta sesión `waiting` (60 s), MQTT `enroll_start`. El ESP32 reporta la UID por HTTPS y `fn_enroll_capture` la guarda. |
| `enroll-cancel` | `{session_id}` | `{ok}` | Sesión → `cancelled`, MQTT `enroll_cancel`. |

## Decisiones de diseño
- **Solo admin** entra al panel (los operadores no pueden crear personas por RLS). La seguridad real es RLS; la UI solo es comodidad.
- **Horario por persona, no por tarjeta:** el esquema guarda horarios en `access_grants` (persona→puerta). El editor lo indica explícitamente.
- Revocar con el interruptor pone la tarjeta en `suspended`; el ESP32 consulta al servidor en cada tap, así que el efecto es inmediato (en modo degradado dependería de la lista blanca sincronizada).
- Tras enrolar se ofrece dar acceso 24 h a la puerta; sin `access_grants` una tarjeta activa igualmente sería denegada (`no_grant`).
- Bundle ≈ 155 kB gzip. Para reducirlo, `React.lazy` por página.
