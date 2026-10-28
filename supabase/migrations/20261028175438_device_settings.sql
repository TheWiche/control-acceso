-- =============================================================================
-- Ajustes editables desde el panel (página «Ajustes»)
--   * devices.display_msg_s : segundos que la pantalla del ESP32 muestra cada mensaje (1-10).
--     Llega al ESP32 en el latido.
--   * devices.name no puede quedar vacío (la pantalla y el panel lo muestran).
--   unlock_ms (500-30000 ms), is_active, location y sites.timezone ya existían con sus restricciones;
--   RLS ya limita su escritura a administradores.
-- =============================================================================

alter table public.devices add column display_msg_s smallint not null default 3
  check (display_msg_s between 1 and 10);

alter table public.devices add constraint devices_name_not_blank check (char_length(btrim(name)) > 0);

create or replace function public.fn_device_heartbeat(
  p_device_code text, p_ip inet default null, p_rssi integer default null,
  p_lock_state public.lock_state default 'unknown', p_door_closed boolean default null,
  p_firmware text default null, p_uptime bigint default null, p_free_heap integer default null,
  p_mqtt boolean default null, p_reset_reason text default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare v_dev record;
begin
  select id, name, is_active, unlock_ms, display_msg_s, key_version, lockdown, hold_open_until
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
                            'unlock_ms', v_dev.unlock_ms, 'display_msg_s', v_dev.display_msg_s,
                            'key_version', v_dev.key_version, 'lockdown', v_dev.lockdown,
                            'hold_open_until', case when v_dev.hold_open_until > now()
                                                    then extract(epoch from v_dev.hold_open_until)::bigint end,
                            'server_time', extract(epoch from now())::bigint);
end $$;
