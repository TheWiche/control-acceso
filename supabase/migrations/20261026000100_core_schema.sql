-- =============================================================================
-- Control de Acceso IoT — FASE 1 / Migración 1 de 3: esquema base
-- Ejecutar en orden: 000100 -> 000200 -> 000300  (SQL Editor o `supabase db push`)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensiones y schema privado
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- `private` NO está expuesto por PostgREST: aquí viven helpers que no deben ser RPC públicos.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role          as enum ('admin', 'operator', 'user');
create type public.profile_status    as enum ('active', 'suspended');
create type public.credential_kind   as enum ('rfid_card', 'nfc_keyfob', 'other');
create type public.credential_status as enum ('pending', 'active', 'suspended', 'lost', 'revoked');
create type public.enrollment_status as enum ('waiting', 'captured', 'assigned', 'expired', 'cancelled', 'failed');
create type public.command_type      as enum ('unlock', 'enroll_start', 'enroll_cancel', 'reboot', 'sync_config');
create type public.command_status    as enum ('pending', 'sent', 'acked', 'failed', 'expired');
create type public.lock_state        as enum ('locked', 'unlocked', 'unknown');
create type public.pass_status       as enum ('active', 'revoked');
create type public.door_tag_kind     as enum ('static_ndef', 'ntag424_sdm', 'qr');
create type public.access_result     as enum ('granted', 'denied');
create type public.access_method     as enum ('credential', 'guest_pass', 'remote_app', 'door_tag', 'exit_button', 'system');
create type public.deny_reason       as enum (
  'unknown_credential', 'credential_inactive', 'credential_expired',
  'user_suspended', 'no_grant', 'grant_expired', 'outside_schedule',
  'device_inactive', 'device_offline',
  'pass_invalid', 'pin_invalid', 'pass_locked', 'pass_revoked', 'pass_expired',
  'pass_not_yet_valid', 'pass_exhausted', 'pass_wrong_device',
  'step_up_required', 'rate_limited'
);

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function private.is_valid_tz(p_tz text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz);
$$;

-- ---------------------------------------------------------------------------
-- Sitios (multi-sede; la zona horaria gobierna los horarios permitidos)
-- ---------------------------------------------------------------------------
create table public.sites (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  timezone   text not null default 'UTC' check (private.is_valid_tz(timezone)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Perfiles (personas). auth_user_id es NULL para quien tiene tarjeta pero no cuenta web.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  email        text,
  full_name    text not null,
  phone        text,
  role         public.app_role not null default 'user',
  status       public.profile_status not null default 'active',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email)) where email is not null;
create index profiles_role_idx on public.profiles (role) where status = 'active';

-- Crea/vincula el perfil al registrarse un usuario en Auth.
-- IMPORTANTE: mantener el registro público DESACTIVADO (solo invitaciones), ver docs.
create function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles
     set auth_user_id = new.id
   where auth_user_id is null and lower(email) = lower(new.email);
  if not found then
    insert into public.profiles (auth_user_id, email, full_name)
    values (new.id, new.email,
            coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)));
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Solo un admin puede cambiar rol/estado/vinculo. (auth.uid() nulo = service_role/SQL editor.)
create function private.protect_profile_columns() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and not (select private.is_admin())
     and (new.role is distinct from old.role
          or new.status is distinct from old.status
          or new.auth_user_id is distinct from old.auth_user_id
          or new.email is distinct from old.email) then
    raise exception 'solo un administrador puede modificar rol, estado o email' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers de rol (SECURITY DEFINER en schema no expuesto; usados por las políticas RLS)
-- ---------------------------------------------------------------------------
create function private.current_profile_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.profiles
   where auth_user_id = (select auth.uid()) and status = 'active';
$$;

create function private.current_app_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles
   where auth_user_id = (select auth.uid()) and status = 'active';
$$;

create function private.is_admin() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select private.current_app_role()) = 'admin', false);
$$;

create function private.is_staff() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select private.current_app_role()) in ('admin', 'operator'), false);
$$;

create trigger profiles_protect before update on public.profiles
  for each row execute function private.protect_profile_columns();

-- ---------------------------------------------------------------------------
-- Dispositivos (cerraduras / ESP32)
--   * device_code: identificador PÚBLICO (URL, tags NFC, tópicos MQTT). No es secreto.
--   * Las claves del dispositivo NO se guardan: se derivan en las Edge Functions con
--     HMAC(MASTER_KEY, 'api|cmd' + device_code + key_version). Subir key_version = rotar.
-- ---------------------------------------------------------------------------
create table public.devices (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites (id) on delete restrict,
  device_code text not null unique check (device_code ~ '^[a-z0-9]{6,32}$'),
  name        text not null,
  location    text,
  unlock_ms   integer not null default 3000 check (unlock_ms between 500 and 30000),
  key_version integer not null default 1 check (key_version > 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index devices_site_idx on public.devices (site_id);

-- Telemetría "última conocida" (1 fila por dispositivo). Se separa de `devices` para que el
-- latido (cada ~60 s) no ensucie la auditoría de configuración y Realtime emita solo esto.
create table public.device_state (
  device_id       uuid primary key references public.devices (id) on delete cascade,
  is_online       boolean not null default false,
  last_seen_at    timestamptz,
  ip_address      inet,
  rssi            smallint,
  lock_state      public.lock_state not null default 'unknown',
  door_closed     boolean,                 -- sensor magnético opcional
  firmware_version text,
  uptime_seconds  bigint,
  free_heap_bytes integer,
  mqtt_connected  boolean,
  enroll_mode_until timestamptz,
  updated_at      timestamptz not null default now()
);
create index device_state_online_idx on public.device_state (last_seen_at) where is_online;

create function private.create_device_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.device_state (device_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger devices_create_state after insert on public.devices
  for each row execute function private.create_device_state();

-- ---------------------------------------------------------------------------
-- Permisos de acceso de miembros (persona -> puerta, con vigencia y horario)
-- Los admins tienen acceso implícito a todas las puertas.
-- ---------------------------------------------------------------------------
create table public.access_grants (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  device_id   uuid not null references public.devices (id) on delete cascade,
  valid_from  timestamptz,
  valid_until timestamptz,
  allowed_days smallint[],                 -- ISO: 1=lunes ... 7=domingo; NULL = todos
  time_start  time,                        -- ventana horaria en la zona del sitio; NULL = todo el día
  time_end    time,                        -- start > end => ventana nocturna (22:00-06:00)
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (profile_id, device_id),
  check (valid_until is null or valid_from is null or valid_until > valid_from),
  check (allowed_days is null or (cardinality(allowed_days) > 0 and allowed_days <@ array[1,2,3,4,5,6,7]::smallint[])),
  check ((time_start is null) = (time_end is null)),
  check (time_start is null or time_start <> time_end)
);
create index access_grants_device_idx on public.access_grants (device_id);

-- ---------------------------------------------------------------------------
-- Credenciales físicas (tarjetas blancas RFID / llaveros azules NFC)
--   uid en HEX mayúsculas sin separadores (4, 7 o 10 bytes => 8, 14 o 20 chars).
--   status 'pending' = leída en enrolamiento pero aún sin dueño.
-- ---------------------------------------------------------------------------
create table public.credentials (
  id          uuid primary key default gen_random_uuid(),
  uid         text not null unique check (uid ~ '^[0-9A-F]{8,20}$'),
  kind        public.credential_kind not null default 'rfid_card',
  label       text,
  profile_id  uuid references public.profiles (id) on delete cascade,
  status      public.credential_status not null default 'pending',
  valid_from  timestamptz,
  valid_until timestamptz,
  enrolled_via_device_id uuid references public.devices (id) on delete set null,
  last_used_at timestamptz,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (status in ('pending', 'revoked', 'lost') or profile_id is not null),
  check (valid_until is null or valid_from is null or valid_until > valid_from)
);
create index credentials_profile_idx on public.credentials (profile_id);
create index credentials_enrolled_device_idx on public.credentials (enrolled_via_device_id);

-- ---------------------------------------------------------------------------
-- Modo Enrolamiento: la web abre una sesión, el ESP32 lee la tarjeta y la reporta.
-- ---------------------------------------------------------------------------
create table public.enrollment_sessions (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references public.devices (id) on delete cascade,
  requested_by      uuid references public.profiles (id) on delete set null,
  target_profile_id uuid references public.profiles (id) on delete set null,  -- opcional: asignar al instante
  kind              public.credential_kind not null default 'rfid_card',
  status            public.enrollment_status not null default 'waiting',
  expires_at        timestamptz not null default now() + interval '60 seconds',
  captured_uid      text,
  credential_id     uuid references public.credentials (id) on delete set null,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Una sola sesión "waiting" por dispositivo.
create unique index enrollment_one_waiting_per_device on public.enrollment_sessions (device_id) where status = 'waiting';
create index enrollment_requested_by_idx on public.enrollment_sessions (requested_by);
create index enrollment_target_idx on public.enrollment_sessions (target_profile_id);
create index enrollment_credential_idx on public.enrollment_sessions (credential_id);

-- Al asignar un dueño a una credencial "pending", cierra la sesión que la capturó.
create function private.close_enrollment_on_assign() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.profile_id is null and new.profile_id is not null then
    update public.enrollment_sessions
       set status = 'assigned', updated_at = now()
     where credential_id = new.id and status = 'captured';
  end if;
  return new;
end $$;

create trigger credentials_close_enrollment after update of profile_id on public.credentials
  for each row execute function private.close_enrollment_on_assign();

-- ---------------------------------------------------------------------------
-- Comandos hacia el dispositivo (auditoría + ACK; MQTT QoS1 no garantiza entrega con el ESP32 caído)
-- ---------------------------------------------------------------------------
create table public.device_commands (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references public.devices (id) on delete cascade,
  type          public.command_type not null,
  payload       jsonb not null default '{}',
  status        public.command_status not null default 'pending',
  issued_by     uuid references public.profiles (id) on delete set null,
  access_log_id bigint,                    -- se enlaza en la migración 3 (FK diferida)
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '15 seconds',
  sent_at       timestamptz,
  acked_at      timestamptz,
  error         text
);
create index device_commands_device_idx on public.device_commands (device_id, issued_at desc);
create index device_commands_issued_by_idx on public.device_commands (issued_by);

-- ---------------------------------------------------------------------------
-- Pases temporales de invitado (link único + PIN)
-- ---------------------------------------------------------------------------
create table public.guest_passes (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,              -- nombre del invitado
  guest_phone  text,
  notes        text,
  valid_from   timestamptz not null default now(),
  valid_until  timestamptz not null,
  allowed_days smallint[],
  time_start   time,
  time_end     time,
  max_uses     integer check (max_uses is null or max_uses > 0),   -- NULL = ilimitado hasta expirar
  uses_count   integer not null default 0 check (uses_count >= 0),
  status       public.pass_status not null default 'active',
  revoked_at   timestamptz,
  revoked_by   uuid references public.profiles (id) on delete set null,
  last_used_at timestamptz,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (valid_until > valid_from),
  check (allowed_days is null or (cardinality(allowed_days) > 0 and allowed_days <@ array[1,2,3,4,5,6,7]::smallint[])),
  check ((time_start is null) = (time_end is null)),
  check (time_start is null or time_start <> time_end),
  check (max_uses is null or uses_count <= max_uses)
);
create index guest_passes_created_by_idx on public.guest_passes (created_by);
create index guest_passes_revoked_by_idx on public.guest_passes (revoked_by);
create index guest_passes_valid_until_idx on public.guest_passes (valid_until) where status = 'active';

-- Secretos del pase en tabla aparte SIN acceso desde la Data API (solo service_role).
--   token_hash = sha256(token) ; el token (128 bits) viaja en el fragmento #/p/<token> de la URL.
--   pin_hash   = bcrypt(pin)   ; contador de fallos + bloqueo temporal.
create table public.guest_pass_secrets (
  pass_id         uuid primary key references public.guest_passes (id) on delete cascade,
  token_hash      text not null unique,
  pin_hash        text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz
);

create table public.guest_pass_devices (
  pass_id   uuid not null references public.guest_passes (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  primary key (pass_id, device_id)
);
create index guest_pass_devices_device_idx on public.guest_pass_devices (device_id);

-- ---------------------------------------------------------------------------
-- Tags NFC / QR fijos en la puerta (ver estrategia móvil)
-- ---------------------------------------------------------------------------
create table public.door_tags (
  id               uuid primary key default gen_random_uuid(),
  device_id        uuid not null references public.devices (id) on delete cascade,
  tag_code         text not null unique check (tag_code ~ '^[A-Za-z0-9_-]{8,32}$'),
  kind             public.door_tag_kind not null default 'static_ndef',
  label            text,
  is_active        boolean not null default true,
  last_sdm_counter bigint not null default 0,   -- anti-replay para NTAG 424 DNA (SDM)
  created_at       timestamptz not null default now()
);
create index door_tags_device_idx on public.door_tags (device_id);

-- ---------------------------------------------------------------------------
-- Passkeys / biometría (WebAuthn) para "step-up" antes de abrir desde el celular
-- ---------------------------------------------------------------------------
create table public.webauthn_credentials (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  credential_id text not null unique,          -- base64url
  public_key    text not null,                 -- base64url (COSE)
  sign_count    bigint not null default 0,
  transports    text[],
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index webauthn_profile_idx on public.webauthn_credentials (profile_id);

-- ---------------------------------------------------------------------------
-- Registro de accesos (inmutable). Escribe SOLO service_role (Edge Functions / fn_*).
--   Se guardan "snapshots" (device_name, actor_name, credential_uid) para que el historial
--   sobreviva al borrado de personas/dispositivos.
-- ---------------------------------------------------------------------------
create table public.access_logs (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),      -- instante del evento (el del ESP32 si fue offline)
  received_at    timestamptz not null default now(),
  device_id      uuid references public.devices (id) on delete set null,
  device_name    text,
  result         public.access_result not null,
  method         public.access_method not null,
  deny_reason    public.deny_reason,
  profile_id     uuid references public.profiles (id) on delete set null,
  actor_name     text,
  credential_id  uuid references public.credentials (id) on delete set null,
  credential_uid text,
  guest_pass_id  uuid references public.guest_passes (id) on delete set null,
  ip_address     inet,
  user_agent     text,
  meta           jsonb not null default '{}',
  check ((result = 'granted') = (deny_reason is null))
);
create index access_logs_time_idx    on public.access_logs (occurred_at desc);
create index access_logs_device_idx  on public.access_logs (device_id, occurred_at desc);
create index access_logs_profile_idx on public.access_logs (profile_id, occurred_at desc);
create index access_logs_denied_idx  on public.access_logs (occurred_at desc) where result = 'denied';
create index access_logs_pass_idx    on public.access_logs (guest_pass_id) where guest_pass_id is not null;
create index access_logs_credential_idx on public.access_logs (credential_id) where credential_id is not null;

alter table public.device_commands
  add constraint device_commands_access_log_fk
  foreign key (access_log_id) references public.access_logs (id) on delete set null;
create index device_commands_log_idx on public.device_commands (access_log_id) where access_log_id is not null;

create function private.block_log_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'access_logs es inmutable' using errcode = '42501';
end $$;

create trigger access_logs_immutable before update on public.access_logs
  for each row execute function private.block_log_update();

-- ---------------------------------------------------------------------------
-- Bitácora de cambios administrativos (quién cambió qué)
-- ---------------------------------------------------------------------------
create table public.admin_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_auth_id uuid,                       -- NULL = service_role / Edge Function / SQL editor
  actor_profile_id uuid,
  table_name text not null,
  op         text not null,
  row_id     text,
  old_data   jsonb,
  new_data   jsonb
);
create index admin_audit_at_idx on public.admin_audit (at desc);
create index admin_audit_table_idx on public.admin_audit (table_name, at desc);

create function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  insert into public.admin_audit (actor_auth_id, actor_profile_id, table_name, op, row_id, old_data, new_data)
  values ((select auth.uid()), (select private.current_profile_id()), tg_table_name, tg_op,
          coalesce(v_new ->> 'id', v_old ->> 'id'), v_old, v_new);
  return coalesce(new, old);
end $$;

create trigger audit_profiles    after insert or update or delete on public.profiles      for each row execute function private.audit_row();
create trigger audit_sites       after insert or update or delete on public.sites         for each row execute function private.audit_row();
create trigger audit_devices     after insert or update or delete on public.devices       for each row execute function private.audit_row();
create trigger audit_grants      after insert or update or delete on public.access_grants for each row execute function private.audit_row();
create trigger audit_credentials after insert or update or delete on public.credentials   for each row execute function private.audit_row();
create trigger audit_passes      after insert or update or delete on public.guest_passes  for each row execute function private.audit_row();
create trigger audit_door_tags   after insert or update or delete on public.door_tags     for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Rate limiting (ventana fija) para endpoints públicos (canje de pases, etc.)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);

-- ---------------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------------
create trigger touch_sites         before update on public.sites                for each row execute function private.touch_updated_at();
create trigger touch_profiles      before update on public.profiles             for each row execute function private.touch_updated_at();
create trigger touch_devices       before update on public.devices              for each row execute function private.touch_updated_at();
create trigger touch_grants        before update on public.access_grants        for each row execute function private.touch_updated_at();
create trigger touch_credentials   before update on public.credentials          for each row execute function private.touch_updated_at();
create trigger touch_enrollment    before update on public.enrollment_sessions  for each row execute function private.touch_updated_at();
create trigger touch_passes        before update on public.guest_passes         for each row execute function private.touch_updated_at();
