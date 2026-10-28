-- =============================================================================
-- El latido devuelve también el nombre de la puerta: la pantalla del ESP32 lo muestra en reposo.
-- Misma firma que en presence_reset_reason (CREATE OR REPLACE conserva los permisos).
-- =============================================================================

create or replace function public.fn_device_heartbeat(
  p_device_code text, p_ip inet default null, p_rssi integer default null,
  p_lock_state public.lock_state default 'unknown', p_door_closed boolean default null,
  p_firmware text default null, p_uptime bigint default null, p_free_heap integer default null,
  p_mqtt boolean default null, p_reset_reason text default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare v_dev record;
begin
  select id, name, is_active, unlock_ms, key_version, lockdown, hold_open_until
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

  return jsonb_build_object('ok', true, 'device_id', v_dev.id, 'name', v_dev.name, 'is_active', v_dev.is_active,
                            'unlock_ms', v_dev.unlock_ms, 'key_version', v_dev.key_version,
                            'lockdown', v_dev.lockdown,
                            'hold_open_until', case when v_dev.hold_open_until > now()
                                                    then extract(epoch from v_dev.hold_open_until)::bigint end,
                            'server_time', extract(epoch from now())::bigint);
end $$;
