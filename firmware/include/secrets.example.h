#pragma once
// ============================================================================
//  Copia este archivo a  include/secrets.h  (está en .gitignore) y rellénalo.
//  Las claves del dispositivo se generan con:
//     node tools/provision.mjs --master <DEVICE_MASTER_KEY> --code <device_code> [--version 1]
// ============================================================================

#define WIFI_SSID      "MiRedWiFi"
#define WIFI_PASS      "contraseña-wifi"

// Identidad del dispositivo (devices.device_code en Supabase)
#define DEVICE_CODE    "puerta01x"
// Derivadas de DEVICE_MASTER_KEY (64 caracteres hex cada una)
#define DEVICE_API_KEY "0000000000000000000000000000000000000000000000000000000000000000"
#define DEVICE_CMD_KEY "0000000000000000000000000000000000000000000000000000000000000000"

// Supabase
#define INGEST_URL     "https://<ref>.supabase.co/functions/v1/device-ingest"
#define SUPABASE_KEY   "sb_publishable_xxx"   // clave PUBLISHABLE (pública); nunca la service_role

// Broker MQTT (TLS). Usuario propio del dispositivo; solo necesita suscribirse a acc/v1/<code>/cmd
// y publicar en acc/v1/<code>/status.
#define MQTT_URI       "mqtts://<host>.emqxsl.com:8883"
#define MQTT_USER      "dev-puerta01x"
#define MQTT_PASS      "contraseña-mqtt"
