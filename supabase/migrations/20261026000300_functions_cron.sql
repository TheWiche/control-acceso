-- =============================================================================
-- Control de Acceso IoT — FASE 1 / Migración 3 de 3: lógica de autorización y tareas programadas
--
-- Las funciones fn_* son el "motor de decisión". Las llaman SOLO las Edge Functions con la
-- clave service_role (execute revocado a anon/authenticated). Ventaja: la decisión, el
-- consumo de usos y el log ocurren en UNA transacción atómica en la base de datos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers (schema private)
-- ---------------------------------------------------------------------------

-- ¿El instante cae en los días/horas permitidos? Se evalúa en la zona horaria del sitio.
-- p_days NULL = todos los días; p_start/p_end NULL = todo el día; start > end = ventana nocturna.
create function private.schedule_allows(
  p_at timestamptz, p_tz text, p_days smallint[], p_start time, p_end time
) returns boolean
language sql stable set search_path = '' as $$
  select (p_days is null or extract(isodow from (p_at at time zone p_tz))::smallint = any (p_days))
     and (p_start is null
          or case when p_start < p_end
                  then (p_at at time zone p_tz)::time >= p_start and (p_at at time zone p_tz)::time < p_end
                  else (p_at at time zone p_tz)::time >= p_start or  (p_at at time zone p_tz)::time < p_end
             end);
$$;

-- Decide si una PERSONA puede abrir una PUERTA ahora. NULL = permitido; si no, el motivo.
create function private.check_member_access(
  p_profile_id uuid, p_device_id uuid, p_at timestamptz default now()
) returns public.deny_reason
language plpgsql stable set search_path = '' as $$
declare
  v_profile record;
  v_dev     record;
  v_grant   record;
begin
  select role, status into v_profile from public.profiles where id = p_profile_id;
  if not found or v_profile.status <> 'active' then
    return 'user_suspended';
  end if;

  select d.is_active, s.timezone into v_dev
    from public.devices d join public.sites s on s.id = d.site_id
   where d.id = p_device_id;
  if not found or not v_dev.is_active then
    return 'device_inactive';
  end if;

  if v_profile.role = 'admin' then          -- admin: acceso implícito a todas las puertas
    return null;
  end if;

  select * into v_grant from public.access_grants
   where profile_id = p_profile_id and device_id = p_device_id;
  if not found then
    return 'no_grant';
  end if;
  if (v_grant.valid_from is not null and p_at < v_grant.valid_from)
     or (v_grant.valid_until is not null and p_at >= v_grant.valid_until) then
    return 'grant_expired';
  end if;
  if not private.schedule_allows(p_at, v_dev.timezone, v_grant.allowed_days, v_grant.time_start, v_grant.time_end) then
    return 'outside_schedule';
  end if;
  return null;
end $$;

-- Inserta una fila en access_logs con "snapshots" legibles. Devuelve el id.
create function private.log_access(
  p_device_id uuid, p_result public.access_result, p_method public.access_method,
  p_reason public.deny_reason default null,
  p_profile_id uuid default null, p_credential_id uuid default null, p_credential_uid text default null,
  p_pass_id uuid default null, p_occurred_at timestamptz default now(),
  p_ip inet default null, p_ua text default null, p_meta jsonb default '{}'
) returns bigint
language plpgsql set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.access_logs (
    occurred_at, device_id, device_name, result, method, deny_reason,
    profile_id, actor_name, credential_id, credential_uid, guest_pass_id, ip_address, user_agent, meta
  ) values (
    -- el ESP32 puede reportar eventos offline: se acepta su hora pero acotada a [-7 días, ahora]
    least(greatest(coalesce(p_occurred_at, now()), now() - interval '7 days'), now()),
    p_device_id,
    (select name from public.devices where id = p_device_id),
    p_result, p_method, p_reason,
    p_profile_id,
    coalesce((select full_name from public.profiles where id = p_profile_id),
             (select label from public.guest_passes where id = p_pass_id)),
    p_credential_id, p_credential_uid, p_pass_id, p_ip, p_ua, coalesce(p_meta, '{}')
  ) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Tap de tarjeta / llavero en el lector (lo invoca device-ingest tras autenticar al ESP32)
-- ---------------------------------------------------------------------------
create function public.fn_authorize_credential(
  p_device_code text, p_uid text, p_occurred_at timestamptz default now(), p_ip inet default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_dev    record;
  v_cred   record;
  v_reason public.deny_reason;
  v_uid    text := upper(regexp_replace(coalesce(p_uid, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_log    bigint;
  v_name   text;
begin
  select id, name, unlock_ms into v_dev from devices where device_code = p_device_code;
  if not found then
    return jsonb_build_object('granted', false, 'reason', 'device_unknown');
  end if;

  select * into v_cred from credentials where uid = v_uid;
  if not found then
    v_reason := 'unknown_credential';
  elsif v_cred.status <> 'active' then
    v_reason := 'credential_inactive';
  elsif (v_cred.valid_from is not null and p_occurred_at < v_cred.valid_from)
     or (v_cred.valid_until is not null and p_occurred_at >= v_cred.valid_until) then
    v_reason := 'credential_expired';
  else
    v_reason := private.check_member_access(v_cred.profile_id, v_dev.id, p_occurred_at);
  end if;

  v_log := private.log_access(
    v_dev.id, (case when v_reason is null then 'granted' else 'denied' end)::public.access_result, 'credential', v_reason,
    p_profile_id := v_cred.profile_id, p_credential_id := v_cred.id, p_credential_uid := v_uid,
    p_occurred_at := p_occurred_at, p_ip := p_ip);

  if v_reason is null then
    update credentials set last_used_at = now() where id = v_cred.id;
    select full_name into v_name from profiles where id = v_cred.profile_id;
  end if;

  return jsonb_build_object('granted', v_reason is null, 'reason', v_reason, 'log_id', v_log,
                            'name', v_name, 'unlock_ms', v_dev.unlock_ms);
end $$;

-- ---------------------------------------------------------------------------
-- Apertura remota de un miembro autenticado (app web o tag en la puerta).
-- La Edge Function `unlock` ya verificó el JWT (y el step-up biométrico si aplica).
-- ---------------------------------------------------------------------------
create function public.fn_authorize_member_unlock(
  p_profile_id uuid, p_device_code text,
  p_method public.access_method default 'remote_app',
  p_ip inet default null, p_ua text default null, p_meta jsonb default '{}'
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_dev    record;
  v_reason public.deny_reason;
  v_log    bigint;
begin
  if p_method not in ('remote_app', 'door_tag') then
    raise exception 'método no válido para apertura remota: %', p_method;
  end if;

  select d.id, d.device_code, d.unlock_ms, coalesce(st.is_online, false) as is_online into v_dev
    from devices d left join device_state st on st.device_id = d.id
   where d.device_code = p_device_code;
  if not found then
    return jsonb_build_object('granted', false, 'reason', 'device_unknown');
  end if;

  v_reason := private.check_member_access(p_profile_id, v_dev.id);
  if v_reason is null and not v_dev.is_online then
    v_reason := 'device_offline';
  end if;

  v_log := private.log_access(
    v_dev.id, (case when v_reason is null then 'granted' else 'denied' end)::public.access_result, p_method, v_reason,
    p_profile_id := p_profile_id, p_ip := p_ip, p_ua := p_ua, p_meta := p_meta);

  return jsonb_build_object('granted', v_reason is null, 'reason', v_reason, 'log_id', v_log,
                            'device_id', v_dev.id, 'device_code', v_dev.device_code, 'unlock_ms', v_dev.unlock_ms);
end $$;

-- ---------------------------------------------------------------------------
-- Canje de pase de invitado (token del link + PIN). Atómico: valida, consume 1 uso y registra.
--   * El PIN se verifica ANTES de revelar el estado del pase.
--   * 5 PIN erróneos => bloqueo de 15 min.
--   * Solo consume un uso si el dispositivo está online (si no, no se "quema" el pase).
-- ---------------------------------------------------------------------------
create function public.fn_authorize_pass(
  p_token text, p_pin text, p_device_code text, p_ip inet default null, p_ua text default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_dev    record;
  v_sec    record;
  v_pass   record;
  v_reason public.deny_reason;
  v_hash   text := encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  v_left   integer;
  v_log    bigint;
begin
  select d.id, d.device_code, d.unlock_ms, d.is_active, si.timezone, coalesce(st.is_online, false) as is_online
    into v_dev
    from devices d
    join sites si on si.id = d.site_id
    left join device_state st on st.device_id = d.id
   where d.device_code = p_device_code;
  if not found then
    return jsonb_build_object('granted', false, 'reason', 'device_unknown');
  end if;

  select * into v_sec from guest_pass_secrets where token_hash = v_hash for update;
  if not found then
    perform private.log_access(v_dev.id, 'denied', 'guest_pass', 'pass_invalid', p_ip := p_ip, p_ua := p_ua);
    return jsonb_build_object('granted', false, 'reason', 'pass_invalid');
  end if;
  select * into v_pass from guest_passes where id = v_sec.pass_id;

  if v_sec.locked_until is not null and v_sec.locked_until > now() then
    v_reason := 'pass_locked';
  elsif crypt(coalesce(p_pin, ''), v_sec.pin_hash) <> v_sec.pin_hash then
    update guest_pass_secrets
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' end
     where pass_id = v_sec.pass_id;
    v_reason := 'pin_invalid';
  else
    update guest_pass_secrets set failed_attempts = 0, locked_until = null where pass_id = v_sec.pass_id;

    if v_pass.status = 'revoked' then
      v_reason := 'pass_revoked';
    elsif now() < v_pass.valid_from then
      v_reason := 'pass_not_yet_valid';
    elsif now() >= v_pass.valid_until then
      v_reason := 'pass_expired';
    elsif not exists (select 1 from guest_pass_devices where pass_id = v_pass.id and device_id = v_dev.id) then
      v_reason := 'pass_wrong_device';
    elsif not v_dev.is_active then
      v_reason := 'device_inactive';
    elsif not private.schedule_allows(now(), v_dev.timezone, v_pass.allowed_days, v_pass.time_start, v_pass.time_end) then
      v_reason := 'outside_schedule';
    elsif not v_dev.is_online then
      v_reason := 'device_offline';
    else
      -- consumo atómico: dos taps simultáneos no pueden superar max_uses
      update guest_passes
         set uses_count = uses_count + 1, last_used_at = now()
       where id = v_pass.id and (max_uses is null or uses_count < max_uses)
      returning max_uses - uses_count into v_left;
      if not found then
        v_reason := 'pass_exhausted';
      end if;
    end if;
  end if;

  v_log := private.log_access(
    v_dev.id, (case when v_reason is null then 'granted' else 'denied' end)::public.access_result, 'guest_pass', v_reason,
    p_pass_id := v_pass.id, p_ip := p_ip, p_ua := p_ua);

  return jsonb_build_object('granted', v_reason is null, 'reason', v_reason, 'log_id', v_log,
                            'device_id', v_dev.id, 'device_code', v_dev.device_code, 'unlock_ms', v_dev.unlock_ms,
                            'uses_left', v_left, 'guest', v_pass.label);
end $$;

-- ---------------------------------------------------------------------------
-- Alta de pase: genera token (128 bits) y PIN; devuelve ambos UNA sola vez.
--   La Edge Function `pass-create` verifica que quien llama sea staff antes de invocarla.
-- ---------------------------------------------------------------------------
create function public.fn_create_guest_pass(
  p_created_by uuid, p_label text, p_valid_until timestamptz, p_device_ids uuid[],
  p_valid_from timestamptz default now(), p_guest_phone text default null, p_notes text default null,
  p_allowed_days smallint[] default null, p_time_start time default null, p_time_end time default null,
  p_max_uses integer default null, p_pin_length integer default 6
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_id    uuid;
  v_token text;
  v_pin   text;
  b       bytea;
begin
  if p_pin_length not between 4 and 8 then
    raise exception 'p_pin_length debe estar entre 4 y 8';
  end if;
  if p_device_ids is null or cardinality(p_device_ids) = 0 then
    raise exception 'el pase necesita al menos un dispositivo';
  end if;
  if (select count(*) from devices where id = any (p_device_ids)) <> cardinality(p_device_ids) then
    raise exception 'dispositivo inexistente en p_device_ids';
  end if;

  v_token := translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_');   -- 22 chars url-safe
  b := gen_random_bytes(4);
  v_pin := lpad(((get_byte(b, 0)::bigint * 16777216 + get_byte(b, 1) * 65536 + get_byte(b, 2) * 256 + get_byte(b, 3))
                 % power(10, p_pin_length)::bigint)::text, p_pin_length, '0');

  insert into guest_passes (label, guest_phone, notes, valid_from, valid_until, allowed_days,
                            time_start, time_end, max_uses, created_by)
  values (p_label, p_guest_phone, p_notes, p_valid_from, p_valid_until, p_allowed_days,
          p_time_start, p_time_end, p_max_uses, p_created_by)
  returning id into v_id;

  insert into guest_pass_secrets (pass_id, token_hash, pin_hash)
  values (v_id, encode(digest(v_token, 'sha256'), 'hex'), crypt(v_pin, gen_salt('bf', 8)));

  insert into guest_pass_devices (pass_id, device_id)
  select v_id, unnest(p_device_ids);

  return jsonb_build_object('pass_id', v_id, 'token', v_token, 'pin', v_pin);
end $$;

-- ---------------------------------------------------------------------------
-- Latido / telemetría del ESP32. Devuelve la configuración vigente y la hora del servidor.
-- ---------------------------------------------------------------------------
create function public.fn_device_heartbeat(
  p_device_code text, p_ip inet default null, p_rssi integer default null,
  p_lock_state public.lock_state default 'unknown', p_door_closed boolean default null,
  p_firmware text default null, p_uptime bigint default null, p_free_heap integer default null,
  p_mqtt boolean default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare v_dev record;
begin
  select id, is_active, unlock_ms, key_version into v_dev from devices where device_code = p_device_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'device_unknown');
  end if;

  update device_state set
    is_online = true, last_seen_at = now(), ip_address = p_ip, rssi = p_rssi::smallint,
    lock_state = p_lock_state, door_closed = p_door_closed, firmware_version = p_firmware,
    uptime_seconds = p_uptime, free_heap_bytes = p_free_heap, mqtt_connected = p_mqtt, updated_at = now()
  where device_id = v_dev.id;

  return jsonb_build_object('ok', true, 'device_id', v_dev.id, 'is_active', v_dev.is_active,
                            'unlock_ms', v_dev.unlock_ms, 'key_version', v_dev.key_version,
                            'server_time', extract(epoch from now())::bigint);
end $$;

-- ---------------------------------------------------------------------------
-- Modo Enrolamiento: el ESP32 reporta la UID leída dentro de una sesión abierta.
-- ---------------------------------------------------------------------------
create function public.fn_enroll_capture(
  p_device_code text, p_session_id uuid, p_uid text
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_s    record;
  v_uid  text := upper(regexp_replace(coalesce(p_uid, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_old  uuid;
  v_cred uuid;
  v_new_status public.enrollment_status;
begin
  select es.id, es.device_id, es.status, es.expires_at, es.target_profile_id, es.kind, es.requested_by
    into v_s
    from enrollment_sessions es join devices d on d.id = es.device_id
   where es.id = p_session_id and d.device_code = p_device_code
     for update of es;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status <> 'waiting' then
    return jsonb_build_object('ok', false, 'error', 'session_closed');
  end if;
  if v_s.expires_at < now() then
    update enrollment_sessions set status = 'expired' where id = v_s.id;
    update device_state set enroll_mode_until = null where device_id = v_s.device_id;
    return jsonb_build_object('ok', false, 'error', 'session_expired');
  end if;
  if v_uid !~ '^[0-9A-F]{8,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_uid');
  end if;

  select id into v_old from credentials where uid = v_uid;
  if found then
    update enrollment_sessions
       set status = 'failed', error = 'uid_already_registered', captured_uid = v_uid, credential_id = v_old
     where id = v_s.id;
    update device_state set enroll_mode_until = null where device_id = v_s.device_id;
    return jsonb_build_object('ok', false, 'error', 'uid_already_registered', 'credential_id', v_old);
  end if;

  insert into credentials (uid, kind, profile_id, status, enrolled_via_device_id, created_by)
  values (v_uid, v_s.kind, v_s.target_profile_id,
          (case when v_s.target_profile_id is null then 'pending' else 'active' end)::public.credential_status,
          v_s.device_id, v_s.requested_by)
  returning id into v_cred;

  v_new_status := (case when v_s.target_profile_id is null then 'captured' else 'assigned' end)::public.enrollment_status;
  update enrollment_sessions
     set status = v_new_status, captured_uid = v_uid, credential_id = v_cred
   where id = v_s.id;
  update device_state set enroll_mode_until = null where device_id = v_s.device_id;

  return jsonb_build_object('ok', true, 'credential_id', v_cred, 'status', v_new_status, 'uid', v_uid);
end $$;

-- ---------------------------------------------------------------------------
-- Rate limit de ventana fija. true = permitido. Úsalo ANTES de fn_authorize_pass
-- (clave sugerida: 'pass:' || ip y 'pass:' || sha256(token)).
-- ---------------------------------------------------------------------------
create function public.fn_rate_limit(p_key text, p_limit integer, p_window interval)
returns boolean
language plpgsql set search_path = public, extensions, private as $$
declare v_hits integer;
begin
  insert into rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits         = case when r.window_start < now() - p_window then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución: fn_* y helpers sensibles SOLO para service_role.
-- (Postgres da EXECUTE a PUBLIC por defecto; Supabase además a anon/authenticated.)
-- ---------------------------------------------------------------------------
revoke execute on function
  public.fn_authorize_credential(text, text, timestamptz, inet),
  public.fn_authorize_member_unlock(uuid, text, public.access_method, inet, text, jsonb),
  public.fn_authorize_pass(text, text, text, inet, text),
  public.fn_create_guest_pass(uuid, text, timestamptz, uuid[], timestamptz, text, text, smallint[], time, time, integer, integer),
  public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean),
  public.fn_enroll_capture(text, uuid, text),
  public.fn_rate_limit(text, integer, interval)
  from public, anon, authenticated;
grant execute on function
  public.fn_authorize_credential(text, text, timestamptz, inet),
  public.fn_authorize_member_unlock(uuid, text, public.access_method, inet, text, jsonb),
  public.fn_authorize_pass(text, text, text, inet, text),
  public.fn_create_guest_pass(uuid, text, timestamptz, uuid[], timestamptz, text, text, smallint[], time, time, integer, integer),
  public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean),
  public.fn_enroll_capture(text, uuid, text),
  public.fn_rate_limit(text, integer, interval)
  to service_role;

-- schema private: nada ejecutable por clientes salvo los helpers que usan las políticas RLS
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.current_profile_id(), private.current_app_role(), private.is_admin(), private.is_staff()
  to authenticated;
grant execute on all functions in schema private to service_role;

-- ---------------------------------------------------------------------------
-- Tareas programadas (pg_cron). Si `create extension` falla, actívala en
-- Dashboard > Database > Extensions > pg_cron y reejecuta esta sección.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;

-- Marca OFFLINE a los ESP32 sin latido en 90 s (el UPDATE dispara Realtime hacia el panel).
select cron.schedule('acc-mark-offline', '* * * * *', $$
  update public.device_state
     set is_online = false, mqtt_connected = false, updated_at = now()
   where is_online and last_seen_at < now() - interval '90 seconds'
$$);

-- Caduca sesiones de enrolamiento y comandos que nadie atendió.
select cron.schedule('acc-expire-pending', '* * * * *', $$
  update public.enrollment_sessions set status = 'expired'
   where status = 'waiting' and expires_at < now();
  update public.device_state set enroll_mode_until = null
   where enroll_mode_until is not null and enroll_mode_until < now();
  update public.device_commands set status = 'expired'
   where status in ('pending', 'sent') and expires_at < now()
$$);

-- Limpieza diaria de contadores de rate limit.
select cron.schedule('acc-purge-rate-limits', '17 3 * * *', $$
  delete from public.rate_limits where window_start < now() - interval '1 day'
$$);

-- Retención de logs (opcional, descomenta si quieres limitar el crecimiento; free tier = 500 MB):
-- select cron.schedule('acc-purge-logs', '30 3 * * *', $$
--   delete from public.access_logs where occurred_at < now() - interval '18 months'
-- $$);
