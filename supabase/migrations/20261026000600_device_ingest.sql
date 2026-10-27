-- =============================================================================
-- Control de Acceso IoT — FASE 4 / Migración 6: soporte para el firmware (device-ingest)
--
--   fn_device_allowlist          : lista blanca para la caché OFFLINE del ESP32
--   fn_device_allowlist_version  : huella (md5) para que el ESP32 sepa cuándo re-sincronizar
--   fn_device_ack                : confirmación de un comando (unlock, enroll_start, …)
--   fn_log_device_event          : eventos decididos por el ESP32 sin red (se suben al reconectar)
--                                  y botón de salida
-- Solo service_role (las invoca la Edge Function device-ingest tras autenticar al dispositivo).
-- =============================================================================

-- Entradas de la lista blanca de UNA puerta. Los pases de invitado NO se cachean (requieren PIN y servidor).
--   days  : máscara de bits ISO (bit0 = lunes … bit6 = domingo); 127 = todos
--   start/end : minutos desde 00:00 en hora local del sitio; null = todo el día
--   from/until: epoch UTC; null = sin límite
--   admin : true => válido incluso en lockdown y sin horario
create function private.device_allowlist(p_device_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(e order by e ->> 'uid'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'uid',   c.uid,
      'admin', p.role = 'admin',
      'from',  extract(epoch from case when p.role = 'admin' then c.valid_from
                                       else greatest(c.valid_from, g.valid_from) end)::bigint,
      'until', extract(epoch from case when p.role = 'admin' then c.valid_until
                                       else least(c.valid_until, g.valid_until) end)::bigint,
      'days',  case when p.role = 'admin' or g.allowed_days is null then 127
                    else (select sum(1 << (d - 1))::int from unnest(g.allowed_days) d) end,
      'start', case when p.role = 'admin' or g.time_start is null then null
                    else (extract(hour from g.time_start) * 60 + extract(minute from g.time_start))::int end,
      'end',   case when p.role = 'admin' or g.time_end is null then null
                    else (extract(hour from g.time_end) * 60 + extract(minute from g.time_end))::int end
    ) as e
    from public.credentials c
    join public.profiles p on p.id = c.profile_id and p.status = 'active'
    left join public.access_grants g on g.profile_id = p.id and g.device_id = p_device_id
    where c.status = 'active'
      and (p.role = 'admin' or g.id is not null)
      and (c.valid_until is null or c.valid_until > now())
      and (p.role = 'admin' or g.valid_until is null or g.valid_until > now())
  ) s;
$$;

-- Desfase actual (minutos) de la zona del sitio respecto a UTC. Se re-sincroniza tras un cambio de horario de verano.
create function private.site_utc_offset_min(p_tz text) returns integer
language sql stable set search_path = '' as $$
  select (extract(epoch from (now() at time zone p_tz) - (now() at time zone 'UTC')) / 60)::int;
$$;

create function public.fn_device_allowlist(p_device_code text) returns jsonb
language plpgsql stable set search_path = public, extensions, private as $$
declare
  v_dev     record;
  v_entries jsonb;
  v_offset  integer;
begin
  select d.id, d.lockdown, s.timezone into v_dev
    from devices d join sites s on s.id = d.site_id where d.device_code = p_device_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'device_unknown');
  end if;
  v_entries := private.device_allowlist(v_dev.id);
  v_offset := private.site_utc_offset_min(v_dev.timezone);
  return jsonb_build_object(
    'ok', true,
    'version', md5(v_entries::text || '|' || v_offset),
    'utc_offset_min', v_offset,
    'lockdown', v_dev.lockdown,
    'entries', v_entries);
end $$;

create function public.fn_device_allowlist_version(p_device_code text) returns text
language sql stable set search_path = public, extensions, private as $$
  select md5(private.device_allowlist(d.id)::text || '|' || private.site_utc_offset_min(s.timezone))
    from devices d join sites s on s.id = d.site_id where d.device_code = p_device_code;
$$;

-- ACK de comando. Solo cambia comandos de ESE dispositivo que sigan pendientes/enviados.
create function public.fn_device_ack(
  p_device_code text, p_command_id uuid, p_ok boolean, p_error text default null
) returns boolean
language plpgsql set search_path = public, extensions, private as $$
begin
  update device_commands c
     set status = case when p_ok then 'acked' else 'failed' end::public.command_status,
         acked_at = now(), error = left(p_error, 300)
    from devices d
   where c.id = p_command_id and d.id = c.device_id and d.device_code = p_device_code
     and c.status in ('pending', 'sent');
  return found;
end $$;

-- Evento decidido localmente por el ESP32 (sin red) o botón de salida. Queda marcado meta.offline.
create function public.fn_log_device_event(
  p_device_code text, p_kind text, p_uid text, p_granted boolean,
  p_reason text default null, p_occurred_at timestamptz default now()
) returns bigint
language plpgsql set search_path = public, extensions, private as $$
declare
  v_dev    uuid;
  v_uid    text := upper(regexp_replace(coalesce(p_uid, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_cred   record;
  v_reason public.deny_reason;
begin
  select id into v_dev from devices where device_code = p_device_code;
  if not found then
    raise exception 'device_unknown';
  end if;

  if p_kind = 'exit_button' then
    return private.log_access(v_dev, 'granted', 'exit_button', null, p_occurred_at := p_occurred_at,
                              p_meta := '{"offline_capable":true}');
  end if;
  if p_kind <> 'access' then
    raise exception 'kind inválido: %', p_kind;
  end if;

  select id, profile_id into v_cred from credentials where uid = v_uid;
  if not p_granted then
    v_reason := case
      when p_reason is not null and exists (select 1 from unnest(enum_range(null::public.deny_reason)) r where r::text = p_reason)
        then p_reason::public.deny_reason
      when v_cred.id is null then 'unknown_credential'
      else 'credential_inactive'
    end;
  end if;

  return private.log_access(
    v_dev, (case when p_granted then 'granted' else 'denied' end)::public.access_result, 'credential', v_reason,
    p_profile_id := v_cred.profile_id, p_credential_id := v_cred.id, p_credential_uid := nullif(v_uid, ''),
    p_occurred_at := p_occurred_at, p_meta := '{"offline":true}');
end $$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.current_profile_id(), private.current_app_role(), private.is_admin(), private.is_staff()
  to authenticated;
grant execute on all functions in schema private to service_role;

revoke execute on function
  public.fn_device_allowlist(text), public.fn_device_allowlist_version(text),
  public.fn_device_ack(text, uuid, boolean, text),
  public.fn_log_device_event(text, text, text, boolean, text, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.fn_device_allowlist(text), public.fn_device_allowlist_version(text),
  public.fn_device_ack(text, uuid, boolean, text),
  public.fn_log_device_event(text, text, text, boolean, text, timestamptz)
  to service_role;
