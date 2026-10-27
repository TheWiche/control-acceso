#!/usr/bin/env bash
# Configura el backend completo en un proyecto Supabase ya creado:
#   vincula, aplica las migraciones, sube los secretos y despliega las Edge Functions.
# Uso (Git Bash en Windows, o cualquier shell POSIX):
#   export SUPABASE_ACCESS_TOKEN=sbp_...      # token personal (Account → Access Tokens)
#   export SUPABASE_DB_PASSWORD=...           # contraseña de la base (la elegiste al crear el proyecto)
#   bash scripts/supabase-setup.sh <project-ref>
# Requiere: Supabase CLI (npx supabase funciona) y supabase/.env relleno (copia de supabase/.env.example).
set -euo pipefail

REF="${1:-}"
cd "$(dirname "$0")/.."

[[ -n "$REF" ]] || { echo "Uso: bash scripts/supabase-setup.sh <project-ref>"; exit 1; }
[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || { echo "Falta SUPABASE_ACCESS_TOKEN"; exit 1; }
[[ -n "${SUPABASE_DB_PASSWORD:-}" ]] || { echo "Falta SUPABASE_DB_PASSWORD"; exit 1; }
[[ -f supabase/.env ]] || { echo "Falta supabase/.env (copia supabase/.env.example y rellénalo)"; exit 1; }

# Comprobaciones del .env antes de tocar nada
grep -qE '^DEVICE_MASTER_KEY=[0-9a-f]{64}$' supabase/.env || { echo "DEVICE_MASTER_KEY debe ser 64 hex (openssl rand -hex 32)"; exit 1; }
grep -qE '^MQTT_URL=wss://.+' supabase/.env || { echo "MQTT_URL debe empezar por wss://"; exit 1; }
grep -qE '^MQTT_PASSWORD=.+' supabase/.env || { echo "Falta MQTT_PASSWORD"; exit 1; }
grep -qE '^APP_ORIGIN=https://' supabase/.env || { echo "APP_ORIGIN debe empezar por https://"; exit 1; }

SB="supabase"
command -v supabase >/dev/null 2>&1 || SB="npx --yes supabase"

echo "==> Vinculando proyecto $REF"
$SB link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD"

echo "==> Aplicando migraciones"
$SB db push --password "$SUPABASE_DB_PASSWORD"

echo "==> Subiendo secretos de las funciones"
$SB secrets set --env-file supabase/.env --project-ref "$REF"

echo "==> Desplegando Edge Functions"
$SB functions deploy pass device-ingest --project-ref "$REF" --no-verify-jwt
$SB functions deploy pass-manage unlock device-control enroll-start enroll-cancel --project-ref "$REF"

echo
echo "Listo. Siguiente: crea tu usuario admin, el sitio y el dispositivo (scripts/new-device.sql)."
