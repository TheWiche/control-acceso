-- =============================================================================
-- Control de Acceso IoT — FASE 2 / Migración 4: Lockdown y "mantener abierta"
--
--   lockdown        : bloqueo total. Niega TODO (tarjetas, pases, apertura remota)
--                     salvo a los administradores.
--   hold_open_until : puerta liberada hasta esa hora (la cerradura queda abierta).
--
-- Los cambia la Edge Function `device-control` (admin), que además avisa al ESP32 por MQTT.
-- El ESP32 recibe el estado vigente en cada latido (fn_device_heartbeat), así sobrevive a reinicios.
-- =============================================================================

alter type public.command_type add value if not exists 'hold_open';
alter type public.command_type add value if not exists 'release';
alter type public.command_type add value if not exists 'lockdown_on';
alter type public.command_type add value if not exists 'lockdown_off';
alter type public.deny_reason  add value if not exists 'lockdown';

alter table public.devices
  add column lockdown        boolean not null default false,
  add column hold_open_until timestamptz;

-- El panel recibe cambios de `devices` (lockdown, hold_open) en vivo.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'devices') then
    alter publication supabase_realtime add table public.devices;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- check_member_access: añade lockdown (admin exento)
-- ---------------------------------------------------------------------------
create or replace function private.check_member_access(
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

  select d.is_active, d.lockdown, s.timezone into v_dev
    from public.devices d join public.sites s on s.id = d.site_id
   where d.id = p_device_id;
  if not found or not v_dev.is_active then
    return 'device_inactive';
  end if;

  if v_profile.role = 'admin' then          -- admin: acceso implícito, incluso en lockdown
    return null;
  end if;
  if v_dev.lockdown then
    return 'lockdown';
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

-- ---------------------------------------------------------------------------
-- fn_authorize_pass: añade lockdown (los invitados nunca son admin)
-- ---------------------------------------------------------------------------
create or replace function public.fn_authorize_pass(
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
  select d.id, d.device_code, d.unlock_ms, d.is_active, d.lockdown, si.timezone,
         coalesce(st.is_online, false) as is_online
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
    elsif v_dev.lockdown then
      v_reason := 'lockdown';
    elsif not private.schedule_allows(now(), v_dev.timezone, v_pass.allowed_days, v_pass.time_start, v_pass.time_end) then
      v_reason := 'outside_schedule';
    elsif not v_dev.is_online then
      v_reason := 'device_offline';
    else
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
-- fn_device_heartbeat: el ESP32 aprende lockdown / hold_open en cada latido
-- ---------------------------------------------------------------------------
create or replace function public.fn_device_heartbeat(
  p_device_code text, p_ip inet default null, p_rssi integer default null,
  p_lock_state public.lock_state default 'unknown', p_door_closed boolean default null,
  p_firmware text default null, p_uptime bigint default null, p_free_heap integer default null,
  p_mqtt boolean default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare v_dev record;
begin
  select id, is_active, unlock_ms, key_version, lockdown, hold_open_until
    into v_dev from devices where device_code = p_device_code;
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
                            'lockdown', v_dev.lockdown,
                            'hold_open_until', case when v_dev.hold_open_until > now()
                                                    then extract(epoch from v_dev.hold_open_until)::bigint end,
                            'server_time', extract(epoch from now())::bigint);
end $$;

-- Los grants de execute se conservan con CREATE OR REPLACE; por seguridad se reafirman.
revoke execute on function
  public.fn_authorize_pass(text, text, text, inet, text),
  public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean)
  from public, anon, authenticated;
grant execute on function
  public.fn_authorize_pass(text, text, text, inet, text),
  public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean)
  to service_role;
