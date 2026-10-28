# Control de Acceso IoT

Cerradura inteligente: **ESP32 + PN532 + solenoide**, panel web **PWA en GitHub Pages**, backend **Supabase** y **MQTT** para comandos en tiempo real. Tarjetas/llaveros con caché offline, apertura remota, bloqueo total, modo registro de tarjetas y pases de invitado con enlace + PIN por WhatsApp.

```
docs/        01 arquitectura · 02 config. inicial · 03 panel web · 04 invitados · 05 firmware · 06 guía manual · 07 conexiones físicas
supabase/    migrations/ (6) · functions/ (7 Edge Functions + _shared) · config.toml · .env.example
web/         PWA (Vite + React + TS)                → GitHub Pages
firmware/    ESP32 (PlatformIO, versiones fijadas)  → la cerradura
tests/       integración entre capas · SQL en Postgres real · criptografía (Deno)
scripts/     supabase-setup.sh (backend en 1 comando) · new-device.sql (admin, sitio, cerradura)
.github/     deploy (Pages, auto) · ci (pruebas, auto) · firmware-ci (auto) · deploy-supabase (manual)
```

## Empezar
**Sigue [docs/06-guia-manual.md](docs/06-guia-manual.md)**: Supabase → EMQX → backend → GitHub Pages → firmware → prueba con el llavero.
**Montaje eléctrico, conexión por conexión:** [docs/07-conexiones.md](docs/07-conexiones.md) (el porqué de cada parte está en [docs/05-firmware.md](docs/05-firmware.md)).

Ver la web sin backend: `cd web && npm install && npm run demo`.

## Pruebas
```bash
cd tests && npm ci && npm test                               # integración (365 checks) + SQL (90 pruebas)
deno check supabase/functions/*/index.ts                     # tipos de las Edge Functions
deno test --allow-read tests/functions/                      # cripto Edge ↔ firmware ↔ aprovisionamiento
cd web && npm run build                                      # tsc + build
cd firmware && cp include/secrets.example.h include/secrets.h && pio run
```
Todo esto corre en GitHub Actions en cada push (`ci.yml`, `firmware-ci.yml`).

## Estado de verificación
| Parte | Verificado | Pendiente |
|---|---|---|
| SQL (9 migraciones) | 90 pruebas en Postgres (PGlite): reglas, RLS, permisos, caché, pases, latido y registro | — (aplicadas en tu proyecto) |
| Integración entre capas | 365 comprobaciones automáticas (tablas, columnas, embeds, RPC, MQTT, comandos, env) | — |
| Edge Functions | `deno check` de las 7; desplegadas y usadas desde el panel real; MQTT por WSS contra tu EMQX | — |
| Web | typecheck + build con base `/<repo>/`; flujos en navegador (Edge, modo demo); publicada en GitHub Pages y usada con tu Supabase | — |
| Firmware 1.3.0 | compila 0 errores; **probado en el hardware**: PN532 por SPI, tarjetas, cerradura con MOSFET, apertura desde el panel, LEDs | confirmar la pantalla TFT montada |
