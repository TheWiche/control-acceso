-- =============================================================================
-- Presencia más rápida y motivo del último reinicio del ESP32
--   * El firmware late cada 15 s (antes 60 s) y además al cambiar el estado del relé.
--     Una puerta pasa a "desconectada" a los 45 s sin latido (antes 90 s), revisado cada 15 s.
--   * device_state.last_reset_reason: por qué arrancó el ESP32 la última vez
--     (power_on, brownout, watchdog, panic, software, external, other). Un "brownout"
--     repetido delata una fuente que cae al activar el solenoide.
-- =============================================================================

alter table public.device_state add column if not exists last_reset_reason text
  check (last_reset_reason is null or last_reset_reason ~ '^[a-z_]{1,24}$');

-- Nueva firma (un parámetro más): se elimina la anterior para que PostgREST no vea dos sobrecargas.
drop function if exists public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean);

create function public.fn_device_heartbeat(
  p_device_code text, p_ip inet default null, p_rssi integer default null,
  p_lock_state public.lock_state default 'unknown', p_door_closed boolean default null,
  p_firmware text default null, p_uptime bigint default null, p_free_heap integer default null,
  p_mqtt boolean default null, p_reset_reason text default null
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
    uptime_seconds = p_uptime, free_heap_bytes = p_free_heap, mqtt_connected = p_mqtt,
    last_reset_reason = case when p_reset_reason ~ '^[a-z_]{1,24}$' then p_reset_reason else last_reset_reason end,
    updated_at = now()
  where device_id = v_dev.id;

  return jsonb_build_object('ok', true, 'device_id', v_dev.id, 'is_active', v_dev.is_active,
                            'unlock_ms', v_dev.unlock_ms, 'key_version', v_dev.key_version,
                            'lockdown', v_dev.lockdown,
                            'hold_open_until', case when v_dev.hold_open_until > now()
                                                    then extract(epoch from v_dev.hold_open_until)::bigint end,
                            'server_time', extract(epoch from now())::bigint);
end $$;

revoke execute on function
  public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean, text)
  from public, anon, authenticated;
grant execute on function
  public.fn_device_heartbeat(text, inet, integer, public.lock_state, boolean, text, bigint, integer, boolean, text)
  to service_role;

-- Mismo nombre de trabajo: pg_cron lo reemplaza. Programación en segundos (pg_cron >= 1.5).
select cron.schedule('acc-mark-offline', '15 seconds', $$
  update public.device_state
     set is_online = false, mqtt_connected = false, updated_at = now()
   where is_online and last_seen_at < now() - interval '45 seconds'
$$);
