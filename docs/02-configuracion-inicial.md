# Configuración inicial (Fase 1)

Objetivo: dejar Supabase listo con el esquema, el primer administrador y los secretos que usarán las Edge Functions de la Fase 2. Tiempo estimado: 20–30 min.

## 1. Crear el proyecto Supabase

1. [supabase.com](https://supabase.com) → **New project** (región cercana a ti). Guarda la contraseña de la base de datos.
2. **Authentication → Sign In / Providers → Email**: activa *Email* y **desactiva "Allow new users to sign up"** (el registro es solo por invitación; el trigger `handle_new_auth_user` vincula perfiles por email y no debe quedar abierto al público).
3. **Authentication → URL Configuration**: *Site URL* = `https://<usuario>.github.io/<repo>/` y añade la misma URL en *Redirect URLs*.
4. **Authentication → Sessions/JWT**: deja el vencimiento del JWT en 3600 s (corto).
5. **Project Settings → API**: anota *Project URL* y la clave **publishable** (o `anon`). La `service_role`/*secret* **nunca** va al frontend ni al repositorio.

## 2. Aplicar el esquema

Opción A — SQL Editor (más simple): ejecuta **en orden** el contenido de:

1. `supabase/migrations/20261026000100_core_schema.sql`
2. `supabase/migrations/20261026000200_rls_policies.sql`
3. `supabase/migrations/20261026000300_functions_cron.sql`

Opción B — CLI:
```bash
npm i -g supabase            # o: scoop/brew según tu sistema
supabase login
supabase link --project-ref <REF>
supabase db push
```

Si el paso 3 falla en `create extension pg_cron`, actívala en **Database → Extensions → pg_cron** y vuelve a ejecutar solo la sección final (bloque "Tareas programadas").

### Verificación

```sql
select count(*) from cron.job;                       -- 3 trabajos acc-*
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' order by 1;            -- rowsecurity = true en todas
select * from public.fn_rate_limit('x', 1, '1 min'); -- debe fallar con "permission denied" si lo ejecutas como authenticated
```
En **Advisors → Security** no deberían aparecer tablas sin RLS ni funciones `SECURITY DEFINER` expuestas.

## 3. Crear el primer administrador

1. **Authentication → Users → Add user → Send invitation** (o *Create new user*) con tu email. El trigger crea tu `profile` con rol `user`.
2. Promuévete **desde el SQL Editor** (rol `postgres`; el trigger de protección no aplica sin `auth.uid()`):
   ```sql
   update public.profiles set role = 'admin', full_name = 'Tu Nombre'
    where email = 'tu@email.com';
   ```
3. Después, los demás roles se gestionan desde la PWA (Fase 3) o con el mismo `update`.

## 4. Primer sitio y primer dispositivo (manual, hasta que exista `device-provision`)

```sql
insert into public.sites (name, timezone)
values ('Casa', 'America/Bogota')            -- ¡usa TU zona horaria! gobierna todos los horarios
returning id;

insert into public.devices (site_id, device_code, name, location)
values ('<SITE_ID>', 'puerta01x', 'Puerta principal', 'Entrada')   -- 6–32 chars [a-z0-9]
returning id;
```
`device_code` es público (va en URLs, tags NFC y tópicos MQTT): genera uno no adivinable, p. ej. `select lower(encode(extensions.gen_random_bytes(5),'hex'));`.

Prueba de humo del motor de decisión (como `postgres`):
```sql
-- Cerradura "online" simulada
update public.device_state set is_online = true, last_seen_at = now();
-- Tap de una tarjeta desconocida: debe devolver granted=false / unknown_credential y escribir un log
select public.fn_authorize_credential('puerta01x', 'DEADBEEF');
select * from public.access_logs order by id desc limit 1;
```

## 5. Broker MQTT

1. Crea un clúster gratuito en **EMQX Cloud Serverless** (HiveMQ Cloud también sirve).
2. Crea dos tipos de credencial:
   - `acc-publisher` (publicar en `acc/v1/#`) → solo para las Edge Functions.
   - Una por dispositivo, p. ej. `dev-puerta01x` (suscribir `acc/v1/puerta01x/cmd`). Si el plan gratuito no permite restringir por tópico, **no pasa nada grave**: los comandos van firmados (ver arquitectura §5), pero igual usa una credencial distinta por dispositivo para poder revocarla.
3. Anota: host, puerto TLS **8883** (ESP32) y puerto/URL WebSocket seguro (Edge Functions).

## 6. Secretos para las Edge Functions (se usan en la Fase 2)

Genera la clave maestra (guárdala también en tu gestor de contraseñas; **perderla = reprovisionar todos los dispositivos**):
```bash
openssl rand -hex 32
```
```bash
supabase secrets set \
  DEVICE_MASTER_KEY=<hex de 64 chars> \
  MQTT_URL=wss://<host>:<puerto-ws>/mqtt \
  MQTT_USERNAME=acc-publisher \
  MQTT_PASSWORD=<password> \
  APP_ORIGIN=https://<usuario>.github.io
```
`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya los inyecta Supabase en las Edge Functions.

## 7. Repositorio y GitHub Pages (preparación)

- Repo público o privado (Pages gratuito en privados requiere plan de pago; en público no).
- **Settings → Pages → Source: GitHub Actions** (el workflow llega en la Fase 3).
- **Settings → Secrets and variables → Actions → Variables:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Son públicas por diseño; **no** pongas `service_role` aquí.
- Añade a `.gitignore`: `.env*`, `supabase/.temp`, `*.pem`, `firmware/**/secrets.h`.

## 8. Checklist antes de pasar a la Fase 2

- [ ] Proyecto creado, registro público **desactivado**.
- [ ] Las 9 migraciones aplicadas sin errores (`supabase db push`); 3 jobs en `cron.job` (`acc-mark-offline` cada 15 s, `acc-expire-pending` y `acc-purge-rate-limits`).
- [ ] Tu usuario es `admin`; sitio con **zona horaria correcta**; un dispositivo de prueba.
- [ ] Broker creado, credenciales anotadas.
- [ ] `DEVICE_MASTER_KEY` generada y respaldada.
- [ ] Repo GitHub creado con Pages en modo *GitHub Actions*.
- [ ] Decidido el hardware: ¿PN532 por I²C o SPI? ¿Qué pines? ¿Solenoide *fail-secure* o *fail-safe*? ¿Hay pulsador de salida?

## Notas operativas

- **Plan gratuito de Supabase pausa proyectos inactivos.** Los latidos del ESP32 cuentan como actividad, pero si apagas las cerraduras más de una semana, el proyecto puede pausarse.
- **Copias de seguridad:** el plan gratuito no incluye backups descargables automáticos; programa un `pg_dump` periódico de `access_logs`, `credentials` y `access_grants` si el historial importa.
- **Retención de logs:** hay un trabajo `cron` comentado al final de la migración 3 para purgar a los 18 meses.
