-- =============================================================================
-- Alta inicial: administrador, sitio y cerradura.  Ejecutar en Supabase → SQL Editor.
-- Cambia los 4 valores marcados con <<< antes de ejecutar.
-- =============================================================================

-- 1) Hazte administrador (antes invita/crea tu usuario en Authentication → Users)
update public.profiles
   set role = 'admin', full_name = 'Tu Nombre'               -- <<< tu nombre
 where lower(email) = lower('tu@correo.com');                  -- <<< tu correo

-- 2) Sitio con TU zona horaria (gobierna todos los horarios). Lista: select name from pg_timezone_names;
insert into public.sites (name, timezone)
select 'Casa', 'America/Bogota'                                -- <<< zona horaria
 where not exists (select 1 from public.sites where name = 'Casa');   -- re-ejecutable sin duplicar

-- 3) Cerradura. device_code: 6-32 caracteres [a-z0-9], NO adivinable (va en URLs y tópicos MQTT).
--    Genera uno con:  select 'puerta' || lower(encode(extensions.gen_random_bytes(3), 'hex'));
insert into public.devices (site_id, device_code, name, location, unlock_ms)
select id, 'puerta01x', 'Puerta principal', 'Entrada', 3000    -- <<< device_code
  from public.sites where name = 'Casa'
 limit 1
on conflict (device_code) do nothing
returning id, device_code, key_version;

-- 4) Comprobación
select d.device_code, d.name, s.timezone, st.is_online, st.last_seen_at
  from public.devices d join public.sites s on s.id = d.site_id
  left join public.device_state st on st.device_id = d.id;

-- Siguiente: genera las claves del ESP32 con
--   node firmware/tools/provision.mjs --master <DEVICE_MASTER_KEY> --code <device_code>
