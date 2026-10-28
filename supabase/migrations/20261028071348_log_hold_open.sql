-- =============================================================================
-- "Mantener abierta" aparece en el registro de accesos (antes solo lo hacía "Abrir").
-- La invoca la Edge Function device-control tras validar al administrador.
-- =============================================================================

create function public.fn_log_hold_open(
  p_device_id uuid, p_profile_id uuid, p_seconds integer,
  p_ip inet default null, p_ua text default null
) returns bigint
language plpgsql set search_path = public, extensions, private as $$
begin
  if p_seconds is null or p_seconds < 1 then
    raise exception 'p_seconds inválido' using errcode = '22023';
  end if;
  return private.log_access(
    p_device_id, 'granted', 'remote_app',
    p_profile_id := p_profile_id, p_ip := p_ip, p_ua := p_ua,
    p_meta := jsonb_build_object('action', 'hold_open', 'seconds', p_seconds));
end $$;

revoke execute on function public.fn_log_hold_open(uuid, uuid, integer, inet, text) from public, anon, authenticated;
grant execute on function public.fn_log_hold_open(uuid, uuid, integer, inet, text) to service_role;
