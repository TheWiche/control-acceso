-- =============================================================================
-- Control de Acceso IoT — FASE 1 / Migración 2 de 3: RLS, grants, Realtime
--
-- Modelo de acceso:
--   admin     : todo (dispositivos, roles, sitios, borrado de pases, audit)
--   operator  : personal de operación: credenciales, permisos, pases, enrolamiento, ver logs
--   user      : solo ve lo suyo (perfil, credenciales, permisos, dispositivos asignados, sus logs)
--   anon      : NADA. Los invitados y los ESP32 entran por Edge Functions (service_role).
--   service_role (Edge Functions): BYPASSRLS; es el único que escribe logs, telemetría y comandos.
-- =============================================================================

-- Los helpers de rol se invocan desde las políticas => el rol authenticated necesita ejecutarlos.
grant usage on schema private to authenticated, service_role;
grant execute on function
  private.current_profile_id(), private.current_app_role(), private.is_admin(), private.is_staff(),
  private.is_valid_tz(text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS ON en todo
-- ---------------------------------------------------------------------------
alter table public.sites                enable row level security;
alter table public.profiles             enable row level security;
alter table public.devices              enable row level security;
alter table public.device_state         enable row level security;
alter table public.access_grants        enable row level security;
alter table public.credentials          enable row level security;
alter table public.enrollment_sessions  enable row level security;
alter table public.device_commands      enable row level security;
alter table public.guest_passes         enable row level security;
alter table public.guest_pass_secrets   enable row level security;   -- sin políticas: solo service_role
alter table public.guest_pass_devices   enable row level security;
alter table public.door_tags            enable row level security;
alter table public.webauthn_credentials enable row level security;
alter table public.access_logs          enable row level security;
alter table public.admin_audit          enable row level security;
alter table public.rate_limits          enable row level security;   -- sin políticas: solo service_role

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
create policy sites_select on public.sites for select to authenticated
  using ((select private.current_profile_id()) is not null);
create policy sites_insert on public.sites for insert to authenticated
  with check ((select private.is_admin()));
create policy sites_update on public.sites for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy sites_delete on public.sites for delete to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select private.is_staff()));
create policy profiles_insert on public.profiles for insert to authenticated
  with check ((select private.is_admin()));
create policy profiles_update on public.profiles for update to authenticated
  using (auth_user_id = (select auth.uid()) or (select private.is_admin()))
  with check (auth_user_id = (select auth.uid()) or (select private.is_admin()));
  -- trigger profiles_protect impide que un no-admin cambie role/status/email/auth_user_id
create policy profiles_delete on public.profiles for delete to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- devices / device_state
-- ---------------------------------------------------------------------------
create policy devices_select on public.devices for select to authenticated
  using (
    (select private.is_staff())
    or exists (select 1 from public.access_grants g
               where g.device_id = devices.id and g.profile_id = (select private.current_profile_id()))
  );
create policy devices_insert on public.devices for insert to authenticated
  with check ((select private.is_admin()));
create policy devices_update on public.devices for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy devices_delete on public.devices for delete to authenticated
  using ((select private.is_admin()));

-- device_state hereda la visibilidad de `devices` (la subconsulta aplica la RLS de devices)
create policy device_state_select on public.device_state for select to authenticated
  using (exists (select 1 from public.devices d where d.id = device_state.device_id));

-- ---------------------------------------------------------------------------
-- access_grants
-- ---------------------------------------------------------------------------
create policy grants_select on public.access_grants for select to authenticated
  using ((select private.is_staff()) or profile_id = (select private.current_profile_id()));
create policy grants_insert on public.access_grants for insert to authenticated
  with check ((select private.is_staff()));
create policy grants_update on public.access_grants for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy grants_delete on public.access_grants for delete to authenticated
  using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- credentials
-- ---------------------------------------------------------------------------
create policy credentials_select on public.credentials for select to authenticated
  using ((select private.is_staff()) or profile_id = (select private.current_profile_id()));
create policy credentials_insert on public.credentials for insert to authenticated
  with check ((select private.is_staff()));
create policy credentials_update on public.credentials for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy credentials_delete on public.credentials for delete to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- enrollment_sessions / device_commands: lectura para el staff; escribe solo service_role
-- ---------------------------------------------------------------------------
create policy enrollment_select on public.enrollment_sessions for select to authenticated
  using ((select private.is_staff()));
create policy commands_select on public.device_commands for select to authenticated
  using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- guest_passes (se CREAN vía Edge Function pass-create => fn_create_guest_pass)
-- ---------------------------------------------------------------------------
create policy passes_select on public.guest_passes for select to authenticated
  using ((select private.is_staff()));
create policy passes_update on public.guest_passes for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy passes_delete on public.guest_passes for delete to authenticated
  using ((select private.is_admin()));

create policy pass_devices_select on public.guest_pass_devices for select to authenticated
  using ((select private.is_staff()));
create policy pass_devices_insert on public.guest_pass_devices for insert to authenticated
  with check ((select private.is_staff()));
create policy pass_devices_delete on public.guest_pass_devices for delete to authenticated
  using ((select private.is_staff()));

-- ---------------------------------------------------------------------------
-- door_tags
-- ---------------------------------------------------------------------------
create policy door_tags_select on public.door_tags for select to authenticated
  using ((select private.is_staff()));
create policy door_tags_insert on public.door_tags for insert to authenticated
  with check ((select private.is_admin()));
create policy door_tags_update on public.door_tags for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy door_tags_delete on public.door_tags for delete to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- webauthn_credentials: cada persona ve/borra las suyas; el alta la hace la Edge Function
-- ---------------------------------------------------------------------------
create policy webauthn_select on public.webauthn_credentials for select to authenticated
  using (profile_id = (select private.current_profile_id()));
create policy webauthn_delete on public.webauthn_credentials for delete to authenticated
  using (profile_id = (select private.current_profile_id()));

-- ---------------------------------------------------------------------------
-- access_logs / admin_audit: solo lectura
-- ---------------------------------------------------------------------------
create policy logs_select on public.access_logs for select to authenticated
  using ((select private.is_staff()) or profile_id = (select private.current_profile_id()));
create policy audit_select on public.admin_audit for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- GRANTS explícitos (la Data API puede no exponer tablas nuevas automáticamente).
-- anon no recibe nada; authenticated recibe lo mínimo (RLS filtra filas).
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select, insert, update, delete on public.sites, public.profiles, public.devices,
  public.access_grants, public.credentials, public.door_tags to authenticated;
grant select, update, delete on public.guest_passes to authenticated;
grant select, insert, delete on public.guest_pass_devices to authenticated;
grant select on public.device_state, public.enrollment_sessions, public.device_commands,
  public.access_logs, public.admin_audit to authenticated;
grant select, delete on public.webauthn_credentials to authenticated;
-- guest_pass_secrets y rate_limits: ningún grant a authenticated/anon.

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Realtime (respeta RLS): el panel recibe logs, telemetría y enrolamiento en vivo
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['access_logs', 'device_state', 'enrollment_sessions', 'device_commands', 'guest_passes', 'credentials']
  loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
