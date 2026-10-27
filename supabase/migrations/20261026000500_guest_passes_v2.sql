-- =============================================================================
-- Control de Acceso IoT — FASE 3 / Migración 5: accesos de invitado v2
--
--   * PIN personalizado o automático (+ pin_length para que la vista pública sepa cuántos dígitos pedir)
--   * fn_rotate_guest_pass : regenera link y PIN de un pase existente
--   * fn_pass_preview      : estado del pase ANTES del PIN (para mostrar "expirado/revocado…")
--                            y registra el intento denegado (deduplicado, 1 cada 10 min por pase/estado)
--   * fn_refund_pass_use   : devuelve el uso si la cerradura no llegó a abrir
--
-- Todas ejecutables SOLO por service_role (las llaman las Edge Functions `pass` y `pass-manage`).
-- =============================================================================

alter table public.guest_pass_secrets
  add column pin_length smallint not null default 6 check (pin_length between 4 and 8);

-- ---------------------------------------------------------------------------
-- Helpers privados
-- ---------------------------------------------------------------------------
create function private.gen_token() returns text
language sql volatile set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/=', '-_');   -- 22 chars url-safe
$$;

create function private.gen_pin(p_len integer) returns text
language plpgsql volatile set search_path = '' as $$
declare b bytea := extensions.gen_random_bytes(4);
begin
  return lpad(((get_byte(b, 0)::bigint * 16777216 + get_byte(b, 1) * 65536 + get_byte(b, 2) * 256 + get_byte(b, 3))
               % power(10, p_len)::bigint)::text, p_len, '0');
end $$;

-- Valida PIN personalizado: 4-8 dígitos, no todos iguales ("0000").
create function private.check_pin(p_pin text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'el PIN debe tener entre 4 y 8 dígitos';
  end if;
  if p_pin ~ '^(.)\1+$' then
    raise exception 'el PIN es demasiado simple (todos los dígitos iguales)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Alta de pase (reemplaza la versión de la migración 3: añade p_pin)
-- ---------------------------------------------------------------------------
drop function public.fn_create_guest_pass(uuid, text, timestamptz, uuid[], timestamptz, text, text, smallint[], time, time, integer, integer);

create function public.fn_create_guest_pass(
  p_created_by uuid, p_label text, p_valid_until timestamptz, p_device_ids uuid[],
  p_valid_from timestamptz default now(), p_guest_phone text default null, p_notes text default null,
  p_allowed_days smallint[] default null, p_time_start time default null, p_time_end time default null,
  p_max_uses integer default null, p_pin_length integer default 6, p_pin text default null
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_id    uuid;
  v_token text := private.gen_token();
  v_pin   text;
begin
  if p_pin is not null then
    perform private.check_pin(p_pin);
    v_pin := p_pin;
  else
    if p_pin_length not between 4 and 8 then
      raise exception 'p_pin_length debe estar entre 4 y 8';
    end if;
    v_pin := private.gen_pin(p_pin_length);
  end if;
  if p_device_ids is null or cardinality(p_device_ids) = 0 then
    raise exception 'el pase necesita al menos un dispositivo';
  end if;
  if (select count(*) from devices where id = any (p_device_ids)) <> cardinality(p_device_ids) then
    raise exception 'dispositivo inexistente en p_device_ids';
  end if;

  insert into guest_passes (label, guest_phone, notes, valid_from, valid_until, allowed_days,
                            time_start, time_end, max_uses, created_by)
  values (trim(p_label), p_guest_phone, p_notes, p_valid_from, p_valid_until, p_allowed_days,
          p_time_start, p_time_end, p_max_uses, p_created_by)
  returning id into v_id;

  insert into guest_pass_secrets (pass_id, token_hash, pin_hash, pin_length)
  values (v_id, encode(digest(v_token, 'sha256'), 'hex'), crypt(v_pin, gen_salt('bf', 8)), length(v_pin));

  insert into guest_pass_devices (pass_id, device_id) select v_id, unnest(p_device_ids);

  return jsonb_build_object('pass_id', v_id, 'token', v_token, 'pin', v_pin);
end $$;

-- ---------------------------------------------------------------------------
-- Regenerar link y PIN (el link anterior deja de funcionar al instante)
-- ---------------------------------------------------------------------------
create function public.fn_rotate_guest_pass(
  p_pass_id uuid, p_pin text default null, p_pin_length integer default 6
) returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_token text := private.gen_token();
  v_pin   text;
begin
  if p_pin is not null then
    perform private.check_pin(p_pin);
    v_pin := p_pin;
  else
    v_pin := private.gen_pin(p_pin_length);
  end if;
  update guest_pass_secrets
     set token_hash = encode(digest(v_token, 'sha256'), 'hex'),
         pin_hash = crypt(v_pin, gen_salt('bf', 8)), pin_length = length(v_pin),
         failed_attempts = 0, locked_until = null
   where pass_id = p_pass_id;
  if not found then
    raise exception 'pase inexistente';
  end if;
  return jsonb_build_object('pass_id', p_pass_id, 'token', v_token, 'pin', v_pin);
end $$;

-- ---------------------------------------------------------------------------
-- Vista previa del pase (antes del PIN). El token de 128 bits ES la credencial de esta consulta.
-- No consume usos ni cuenta intentos de PIN. Si el pase no es utilizable, registra el intento.
-- ---------------------------------------------------------------------------
create function public.fn_pass_preview(p_token text, p_ip inet default null, p_ua text default null)
returns jsonb
language plpgsql set search_path = public, extensions, private as $$
declare
  v_sec    record;
  v_pass   record;
  v_dev    record;
  v_devs   jsonb;
  v_status text;
  v_reason public.deny_reason;
begin
  select * into v_sec from guest_pass_secrets
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_pass from guest_passes where id = v_sec.pass_id;

  select d.id as id, si.timezone as tz into v_dev
    from guest_pass_devices gd join devices d on d.id = gd.device_id join sites si on si.id = d.site_id
   where gd.pass_id = v_pass.id order by d.name limit 1;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select jsonb_agg(jsonb_build_object('code', d.device_code, 'name', d.name) order by d.name) into v_devs
    from guest_pass_devices gd join devices d on d.id = gd.device_id where gd.pass_id = v_pass.id;

  v_status := case
    when v_pass.status = 'revoked'                                              then 'revoked'
    when now() >= v_pass.valid_until                                            then 'expired'
    when now() <  v_pass.valid_from                                             then 'not_yet'
    when v_pass.max_uses is not null and v_pass.uses_count >= v_pass.max_uses  then 'exhausted'
    when v_sec.locked_until is not null and v_sec.locked_until > now()          then 'locked'
    when not private.schedule_allows(now(), v_dev.tz, v_pass.allowed_days, v_pass.time_start, v_pass.time_end)
                                                                                then 'outside_schedule'
    else 'active'
  end;

  if v_status <> 'active' then
    v_reason := (case v_status
      when 'revoked' then 'pass_revoked' when 'expired' then 'pass_expired' when 'not_yet' then 'pass_not_yet_valid'
      when 'exhausted' then 'pass_exhausted' when 'locked' then 'pass_locked' else 'outside_schedule'
    end)::public.deny_reason;
    -- deduplicado: 1 registro por pase y estado cada 10 minutos
    if public.fn_rate_limit('prev:' || v_pass.id || ':' || v_status, 1, interval '10 minutes') then
      perform private.log_access(v_dev.id, 'denied', 'guest_pass', v_reason, p_pass_id := v_pass.id,
                                 p_ip := p_ip, p_ua := p_ua, p_meta := '{"stage":"preview"}');
    end if;
  end if;

  return jsonb_build_object(
    'status', v_status, 'guest', v_pass.label,
    'valid_from', v_pass.valid_from, 'valid_until', v_pass.valid_until,
    'allowed_days', v_pass.allowed_days, 'time_start', v_pass.time_start, 'time_end', v_pass.time_end,
    'timezone', v_dev.tz, 'max_uses', v_pass.max_uses,
    'uses_left', case when v_pass.max_uses is null then null else greatest(v_pass.max_uses - v_pass.uses_count, 0) end,
    'pin_length', v_sec.pin_length, 'devices', v_devs);
end $$;

-- ---------------------------------------------------------------------------
-- Devuelve el uso consumido cuando la cerradura NO abrió (comando expirado sin ACK).
-- Idempotente y acotado a 2 minutos desde el canje.
-- ---------------------------------------------------------------------------
create function public.fn_refund_pass_use(p_log_id bigint) returns boolean
language plpgsql set search_path = public, extensions, private as $$
declare v_log record;
begin
  select * into v_log from access_logs
   where id = p_log_id and method = 'guest_pass' and result = 'granted'
     and guest_pass_id is not null and received_at > now() - interval '2 minutes'
     for update;
  if not found then return false; end if;
  if exists (select 1 from access_logs where meta ->> 'refund_of' = p_log_id::text) then return false; end if;

  update guest_passes set uses_count = greatest(uses_count - 1, 0) where id = v_log.guest_pass_id;
  perform private.log_access(v_log.device_id, 'denied', 'guest_pass', 'device_offline',
                             p_pass_id := v_log.guest_pass_id,
                             p_meta := jsonb_build_object('refund_of', p_log_id, 'note', 'la cerradura no confirmó la apertura'));
  return true;
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
  public.fn_create_guest_pass(uuid, text, timestamptz, uuid[], timestamptz, text, text, smallint[], time, time, integer, integer, text),
  public.fn_rotate_guest_pass(uuid, text, integer),
  public.fn_pass_preview(text, inet, text),
  public.fn_refund_pass_use(bigint)
  from public, anon, authenticated;
grant execute on function
  public.fn_create_guest_pass(uuid, text, timestamptz, uuid[], timestamptz, text, text, smallint[], time, time, integer, integer, text),
  public.fn_rotate_guest_pass(uuid, text, integer),
  public.fn_pass_preview(text, inet, text),
  public.fn_refund_pass_use(bigint)
  to service_role;
