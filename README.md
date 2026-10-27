# Control de Acceso IoT

Cerradura inteligente: **ESP32 + PN532 + solenoide**, panel web **PWA en GitHub Pages**, backend **Supabase** y **MQTT** para comandos en tiempo real. Tarjetas/llaveros con caché offline, apertura remota, bloqueo total, modo registro de tarjetas y pases de invitado con enlace + PIN por WhatsApp.

```
docs/        01 arquitectura · 02 config. inicial · 03 panel web · 04 invitados · 05 firmware y montaje · 06 guía manual
supabase/    migrations/ (6) · functions/ (7 Edge Functions + _shared) · config.toml · .env.example
web/         PWA (Vite + React + TS)                → GitHub Pages
firmware/    ESP32 (PlatformIO, versiones fijadas)  → la cerradura
tests/       integración entre capas · SQL en Postgres real · criptografía (Deno)
scripts/     supabase-setup.sh (backend en 1 comando) · new-device.sql (admin, sitio, cerradura)
.github/     deploy (Pages, auto) · ci (pruebas, auto) · firmware-ci (auto) · deploy-supabase (manual)
```

## Empezar
**Sigue [docs/06-guia-manual.md](docs/06-guia-manual.md)**: Supabase → HiveMQ → backend → GitHub Pages → firmware → prueba con el llavero.
Montaje eléctrico pin a pin: [docs/05-firmware.md](docs/05-firmware.md).

Ver la web sin backend: `cd web && npm install && npm run demo`.

## Pruebas
```bash
cd tests && npm ci && npm test                               # integración (353 checks) + SQL (84 pruebas)
deno check supabase/functions/*/index.ts                     # tipos de las Edge Functions
deno test --allow-read tests/functions/                      # cripto Edge ↔ firmware ↔ aprovisionamiento
cd web && npm run build                                      # tsc + build
cd firmware && cp include/secrets.example.h include/secrets.h && pio run
```
Todo esto corre en GitHub Actions en cada push (`ci.yml`, `firmware-ci.yml`).

## Estado de verificación
| Parte | Verificado | Pendiente |
|---|---|---|
| SQL (6 migraciones) | 84 pruebas en Postgres (PGlite): reglas, RLS, permisos, caché, pases | aplicar en tu proyecto real |
| Integración entre capas | 353 comprobaciones automáticas (tablas, columnas, embeds, RPC, MQTT, comandos, env) | — |
| Edge Functions | `deno check` de las 7; MQTT por WSS desde Deno probado contra un broker HiveMQ real; firma verificada | ejecución contra tu Supabase |
| Web | typecheck + build de producción con base `/<repo>/`; todos los flujos en navegador (demo) | contra tu Supabase |
| Firmware | compila 0 errores con versiones fijadas; ESP32-D0WD-V3 4 MB detectado en COM3 | cargar con tus credenciales y probar con el hardware |
