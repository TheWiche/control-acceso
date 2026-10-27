# Guía paso a paso (lo que requiere tus cuentas o tus manos)

Tiempo total aproximado: 1,5–2 h. Sigue el orden: cada paso usa datos del anterior.
Los nombres de menús son los de las consolas a octubre de 2026; si alguno cambió de sitio, busca el mismo texto.

Lleva una nota segura (gestor de contraseñas) donde irás pegando estos 10 valores:

| Valor | De dónde sale | Dónde se usa |
|---|---|---|
| `SUPABASE_PROJECT_REF` | paso A3 | script de despliegue, GitHub |
| `SUPABASE_DB_PASSWORD` | paso A1 | script de despliegue, GitHub |
| `VITE_SUPABASE_URL` | paso A2 | GitHub, firmware |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | paso A2 | GitHub, firmware |
| `SUPABASE_ACCESS_TOKEN` | paso A5 | script de despliegue, GitHub |
| `MQTT_HOST` | paso B2 | Edge Functions, firmware |
| `MQTT_PASSWORD` (acc-publisher) | paso B3 | Edge Functions |
| `MQTT_DEVICE_PASSWORD` | paso B3 | firmware |
| `DEVICE_MASTER_KEY` | paso C1 | Edge Functions, aprovisionamiento |
| `GITHUB_PAGES_URL` | paso D6 | Supabase Auth, CORS |

---

## A. Supabase

1. **Crear el proyecto**: entra en <https://supabase.com/dashboard> → **New project**.
   - *Organization*: la tuya. *Project name*: `control-acceso`.
   - *Database Password*: pulsa **Generate a password** y cópiala → `SUPABASE_DB_PASSWORD`.
   - *Region*: la más cercana (p. ej. *South America (São Paulo)*). *Plan*: Free → **Create new project**. Espera ~2 min.
2. **URL y clave pública**: **Project Settings** (engranaje) → **API Keys**.
   - Copia la **Publishable key** (`sb_publishable_…`) → `VITE_SUPABASE_PUBLISHABLE_KEY`.
   - En **Project Settings → Data API** (o el botón **Connect** arriba) copia la **Project URL** (`https://<ref>.supabase.co`) → `VITE_SUPABASE_URL`.
   - La **Secret key** (`sb_secret_…`) **no la copies a ningún sitio**: las Edge Functions la reciben solas.
3. **Project ref**: es el texto entre `/project/` y la siguiente `/` en la URL del navegador → `SUPABASE_PROJECT_REF`.
4. **Autenticación**: **Authentication → Sign In / Providers**:
   - *Email*: activado.
   - **Allow new users to sign up: DESACTIVADO** (solo entrarás tú y quien invites) → **Save**.
5. **Token para la CLI**: <https://supabase.com/dashboard/account/tokens> → **Generate new token** → nombre `control-acceso` (si ofrece permisos, limítalo a este proyecto) → copia el `sbp_…` → `SUPABASE_ACCESS_TOKEN`. Solo se muestra una vez.

## B. Broker MQTT (HiveMQ Cloud, gratis, con WSS)

1. <https://console.hivemq.cloud> → **Sign up** → **Create cluster** → **Serverless (Free)** → elige nube y región → **Create**.
2. Abre el clúster → pestaña **Overview** y anota:
   - **Host**: `xxxxxxxx.s1.eu.hivemq.cloud` → `MQTT_HOST`
   - **Port (TLS MQTT)**: `8883` — lo usa el ESP32
   - **Port (TLS WebSocket)**: `8884`, ruta `/mqtt` — lo usan las Edge Functions
3. Pestaña **Access Management** → **Credentials** → **Add credentials**, dos veces:
   - Usuario `acc-publisher` + contraseña larga, permiso **Publish and Subscribe** → `MQTT_PASSWORD`.
   - Usuario `dev-puerta01x` (usa tu device_code) + otra contraseña, permiso **Publish and Subscribe** → `MQTT_DEVICE_PASSWORD`.
   - Si el plan permite restringir tópicos: `acc-publisher` publica en `acc/v1/#`; el dispositivo se suscribe a `acc/v1/puerta01x/cmd` y publica en `acc/v1/puerta01x/status`. Si no lo permite, no es grave: los comandos van firmados.
4. Los valores finales quedan así:
   - Edge Functions: `MQTT_URL=wss://<MQTT_HOST>:8884/mqtt`
   - Firmware: `MQTT_URI "mqtts://<MQTT_HOST>:8883"`

## C. Desplegar el backend (desde tu PC, Git Bash)

1. Clave maestra de los dispositivos:
   ```bash
   openssl rand -hex 32
   ```
   Copia el resultado (64 caracteres) → `DEVICE_MASTER_KEY`. **Si la pierdes, tendrás que reprogramar cada cerradura.**
2. Secretos de las funciones:
   ```bash
   cd "E:/Proyectos/Proyectos Universidad/Pedidos/Control-Acceso"
   cp supabase/.env.example supabase/.env
   ```
   Edita `supabase/.env` (no se sube a git): `DEVICE_MASTER_KEY`, `MQTT_URL`, `MQTT_USERNAME=acc-publisher`, `MQTT_PASSWORD`. En `APP_ORIGIN` pon por ahora `https://<tu-usuario-github>.github.io,http://localhost:5173`, sin barra final.
3. Todo el backend en un comando (migraciones + secretos + 7 Edge Functions):
   ```bash
   export SUPABASE_ACCESS_TOKEN=sbp_...
   export SUPABASE_DB_PASSWORD='...'
   bash scripts/supabase-setup.sh <SUPABASE_PROJECT_REF>
   ```
   Debe terminar en `Listo.`. Si `db push` pregunta "Do you want to push these migrations?", responde `Y`.
4. **Tu usuario administrador**: Supabase → **Authentication → Users → Add user → Create new user** → tu correo + contraseña, marca **Auto Confirm User** → **Create user**.
5. **Sitio y cerradura**: **SQL Editor → New query** → pega `scripts/new-device.sql`, cambia los 4 valores marcados con `<<<` (tu nombre, tu correo, tu zona horaria y el device_code) → **Run**. La última consulta debe mostrar tu puerta.
6. **Comprobación**: **Database → Extensions** → `pg_cron` activado. **Integrations → Cron** (o `select * from cron.job;`) → 3 trabajos `acc-*`. **Edge Functions** → 7 funciones: `pass`, `pass-manage`, `device-ingest`, `unlock`, `device-control`, `enroll-start`, `enroll-cancel`.

## D. GitHub y la web

1. <https://github.com/new> → *Repository name*: `control-acceso` → **Public** (Pages gratis requiere repositorio público) → **sin** README, .gitignore ni licencia → **Create repository**.
2. Sube el código (el repositorio local ya tiene los commits):
   ```bash
   cd "E:/Proyectos/Proyectos Universidad/Pedidos/Control-Acceso"
   git remote add origin https://github.com/<tu-usuario>/control-acceso.git
   git push -u origin main
   ```
3. En el repositorio → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Settings → Secrets and variables → Actions → pestaña Variables → New repository variable** (dos veces):
   - `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`
5. Misma pantalla, **pestaña Secrets → New repository secret** (tres veces; los usa el workflow manual *Deploy Supabase*):
   - `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`
6. **Actions → "Deploy web (GitHub Pages)" → Run workflow → main**. Al terminar (≈1 min) el resumen muestra la URL, `https://<usuario>.github.io/control-acceso/` → `GITHUB_PAGES_URL`. Desde ahora, cada push a `main` que toque `web/` la vuelve a publicar sola.
7. Supabase → **Authentication → URL Configuration**:
   - *Site URL* = `GITHUB_PAGES_URL`
   - *Redirect URLs* → **Add URL** → `GITHUB_PAGES_URL` y `http://localhost:5173/`
8. Si tu usuario de GitHub difiere de lo que pusiste en `APP_ORIGIN`, corrígelo en `supabase/.env` y ejecuta `npx supabase secrets set --env-file supabase/.env --project-ref <ref>`.
9. Abre `GITHUB_PAGES_URL`, entra con tu correo: debes ver el panel con tu puerta **Desconectado** (aún no hay ESP32). En el móvil: menú del navegador → **Añadir a pantalla de inicio** para instalarla como app.

## E. Firmware

1. Claves de la cerradura:
   ```bash
   node firmware/tools/provision.mjs --master <DEVICE_MASTER_KEY> --code puerta01x
   ```
2. `cp firmware/include/secrets.example.h firmware/include/secrets.h` y rellena:
   - `WIFI_SSID` / `WIFI_PASS`: **red de 2,4 GHz** (el ESP32 no ve redes de 5 GHz).
   - Las 3 líneas que imprimió el paso 1 (`DEVICE_CODE`, `DEVICE_API_KEY`, `DEVICE_CMD_KEY`).
   - `INGEST_URL` = `https://<ref>.supabase.co/functions/v1/device-ingest`
   - `SUPABASE_KEY` = la publishable.
   - `MQTT_URI` = `mqtts://<MQTT_HOST>:8883`, `MQTT_USER` = `dev-puerta01x`, `MQTT_PASS` = `MQTT_DEVICE_PASSWORD`.
3. Monta el circuito siguiendo [docs/05](05-firmware.md) §2–§6 **sin conectar todavía la fuente de 12 V**. Ajusta antes el reductor a **5,0 V**.
4. Carga el firmware (ESP32 por USB):
   ```bash
   cd firmware
   pio run -t upload --upload-port COM3
   pio device monitor -p COM3
   ```
   Debes ver `WiFi conectado`, `MQTT conectado` y `Lista blanca sincronizada`. En el panel la puerta pasa a **En línea** en menos de 1 minuto.

## F. Primera prueba con el llavero azul y la tarjeta blanca

1. Panel → **Tarjetas → Registrar nueva** → *Tipo*: **Llavero azul** → **Iniciar registro**. El LED de la cerradura alterna verde/rojo.
2. Acerca el llavero al PN532 (≈2 cm, plano). En la web aparece el UID; escribe tu nombre → deja activado **Dar acceso a «Puerta principal»** → **Guardar y activar**.
3. Acerca el llavero de nuevo: bip, LED verde y clic del relé; el feed del panel muestra tu nombre en verde.
4. Acerca la **tarjeta blanca sin registrar**: LED rojo + 3 bips y **alerta roja "Tarjeta no registrada"** con su UID en el panel.
5. Botón **Abrir puerta** del panel: el relé abre 3 s. Prueba **Bloqueo total**: el llavero deja de abrir (salvo que seas admin) y el botón de salida sigue abriendo. Quítalo.
6. **Invitados → Nuevo acceso** → 1 solo uso → **Compartir por WhatsApp** a tu propio número → abre el enlace en el móvil, escribe el PIN: la puerta abre. Ábrelo otra vez: "Sin usos disponibles".
7. **Prueba offline**: espera 1 minuto (sincroniza la caché), desenchufa el router: el llavero sigue abriendo (destello rojo cada 3 s = sin red). Reconecta: en ≤ 15 s los accesos offline aparecen en el feed.
8. Solo ahora conecta la fuente de 12 V y el solenoide (con el diodo) y repite el paso 3 veinte veces mirando el monitor: el ESP32 no debe reiniciarse.

## G. Si algo falla

| Síntoma | Causa probable | Solución |
|---|---|---|
| Monitor: `device-ingest rechazó las credenciales` | claves o `key_version` distintas | repite E1 con la misma `DEVICE_MASTER_KEY` que está en `supabase/.env` |
| Monitor: `PN532 no responde` | DIP mal puesto, SDA/SCL invertidos o VCC a 5 V | §2 de docs/05; apaga antes de mover el DIP |
| `WiFi perdido` constante | red de 5 GHz o señal débil | usa 2,4 GHz; acerca el router |
| `MQTT desconectado` en bucle | puerto 8883, usuario o contraseña | revisa B2/B3 y `MQTT_URI` con `mqtts://` |
| Panel: «Falta la configuración» | variables de GitHub vacías | D4 y vuelve a ejecutar el workflow |
| Panel: «Esta cuenta no tiene permisos de administrador» | rol no asignado | C5 (el `update … role = 'admin'`) |
| Panel: botones dan error de red/CORS | `APP_ORIGIN` no coincide con tu URL | D8 (solo `https://usuario.github.io`, sin ruta) |
| GitHub Pages da 404 | *Source* no está en *GitHub Actions* | D3 y re-ejecuta el workflow |
| El invitado ve «La cerradura no respondió» | el ESP32 no confirmó la apertura | monitor serie; revisa MQTT del dispositivo |
| El ESP32 se reinicia al cerrar la puerta | diodo ausente o al revés | §4 de docs/05 |
