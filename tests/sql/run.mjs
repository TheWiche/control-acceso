import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
// Pruebas de las migraciones en un Postgres real (PGlite, WASM) con los roles/esquemas de Supabase simulados.
// Ejecutar:  cd tests && npm ci && npm run test:sql
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const db = new PGlite({ extensions: { pgcrypto } });

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth; create schema cron;
  create extension pgcrypto with schema extensions;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ select 1::bigint $$;
  create publication supabase_realtime;
  grant usage on schema public, extensions, auth to anon, authenticated, service_role;
  grant all on all tables in schema public to postgres;
`);

for (const f of fs.readdirSync(dir).sort()) {
  let sql = fs.readFileSync(dir + f, 'utf8').replace(/create extension if not exists pg_cron[^;]*;/, '');
  try { await db.exec(sql); console.log('OK  ', f); }
  catch (e) { console.log('FAIL', f, '\n', e.message, e.position ?? ''); process.exit(1); }
}

const q = async (sql, params) => (await db.query(sql, params)).rows;
let fails = 0;
const check = (name, cond, extra = '') => { if (!cond) fails++; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); };
const as = async (role, sub, fn) => {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
};
const fails_with = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// ---- datos base (como postgres) ----
const [adm] = await q(`insert into auth.users(email) values ('admin@x.com') returning id`);
const [usr] = await q(`insert into auth.users(email) values ('user@x.com') returning id`);
const [usr2] = await q(`insert into auth.users(email) values ('user2@x.com') returning id`);
await db.exec(`update public.profiles set role='admin' where email='admin@x.com'`);
const prof = Object.fromEntries((await q(`select email, id from public.profiles`)).map(r => [r.email, r.id]));
check('trigger crea perfiles', Object.keys(prof).length === 3);

const [site] = await q(`insert into sites(name, timezone) values ('Casa','America/Bogota') returning id`);
const [d1] = await q(`insert into devices(site_id, device_code, name) values ($1,'door001','Puerta 1') returning id`, [site.id]);
const [d2] = await q(`insert into devices(site_id, device_code, name) values ($1,'door002','Puerta 2') returning id`, [site.id]);
check('device_state auto', (await q(`select count(*)::int c from device_state`))[0].c === 2);
check('timezone invalida rechazada', !!(await fails_with(() => db.query(`insert into sites(name,timezone) values ('x','Mars/Base')`))));

// grants: user1 tiene puerta 1, L-V 08:00-18:00
await db.query(`insert into access_grants(profile_id, device_id, allowed_days, time_start, time_end) values ($1,$2,'{1,2,3,4,5}','08:00','18:00')`, [prof['user@x.com'], d1.id]);
await db.query(`insert into credentials(uid, kind, profile_id, status) values ('04A1B2C3','rfid_card',$1,'active')`, [prof['user@x.com']]);

// ---- horario (Bogotá = UTC-5) ----
const tap = (uid, at, dev = 'door001') => as('service_role', null, async () => (await q(`select public.fn_authorize_credential($1,$2,$3::timestamptz) r`, [dev, uid, at]))[0].r);
// "ahora" se acota a <= now(), por eso usamos fechas pasadas (<7 días no necesario: probamos schedule_allows directo)
const sched = async (at) => (await q(`select private.schedule_allows($1::timestamptz,'America/Bogota','{1,2,3,4,5}'::smallint[],'08:00','18:00') r`, [at]))[0].r;
check('lunes 10:00 Bogotá permitido', await sched('2026-10-26T15:00:00Z') === true);
check('lunes 20:00 Bogotá denegado', await sched('2026-10-27T01:00:00Z') === false);
check('sábado 10:00 denegado', await sched('2026-10-24T15:00:00Z') === false);
check('ventana nocturna 23:00 ok', (await q(`select private.schedule_allows('2026-10-27T04:00:00Z','America/Bogota',null,'22:00','06:00') r`))[0].r === true);
check('ventana nocturna 12:00 no', (await q(`select private.schedule_allows('2026-10-27T17:00:00Z','America/Bogota',null,'22:00','06:00') r`))[0].r === false);

// ---- tap de tarjeta ----
let r = await tap('04a1b2c3', new Date().toISOString());
const nowOk = r.granted || r.reason === 'outside_schedule';
check('tap conocido evalua (granted u outside_schedule)', nowOk, r);
r = await tap('DEADBEEF', new Date().toISOString());
check('tap desconocido denegado', r.granted === false && r.reason === 'unknown_credential', r);
r = await tap('04A1B2C3', new Date().toISOString(), 'door002');
check('sin grant en puerta 2', r.reason === 'no_grant', r);
await db.exec(`update credentials set status='lost' where uid='04A1B2C3'`);
r = await tap('04A1B2C3', new Date().toISOString());
check('credencial perdida denegada', r.reason === 'credential_inactive', r);
await db.exec(`update credentials set status='active' where uid='04A1B2C3'`);

// ---- pases de invitado ----
const mk = (extra = '') => as('service_role', null, async () => (await q(
  `select public.fn_create_guest_pass($1, 'Invitado', now() + interval '1 day', array[$2::uuid], now() - interval '1 minute', null, null, null, null, null, ${extra || 'null'}, 6) r`,
  [prof['admin@x.com'], d1.id]))[0].r);
const redeem = (t, pin, dev = 'door001') => as('service_role', null, async () => (await q(`select public.fn_authorize_pass($1,$2,$3) r`, [t, pin, dev]))[0].r);
await db.exec(`update device_state set is_online=true, last_seen_at=now()`);

const p1 = await mk('1');   // un solo uso
check('token 22 chars y pin 6 digitos', p1.token.length === 22 && /^\d{6}$/.test(p1.pin), p1);
r = await redeem(p1.token, '000000'); check('pin malo', r.reason === 'pin_invalid', r);
r = await redeem(p1.token, p1.pin);   check('pase 1 uso: primera vez ok', r.granted === true && r.uses_left === 0, r);
r = await redeem(p1.token, p1.pin);   check('pase 1 uso: segunda agotado', r.reason === 'pass_exhausted', r);
r = await redeem('x'.repeat(22), '123456'); check('token inventado', r.reason === 'pass_invalid', r);

const p2 = await mk();      // ilimitado
for (let i = 0; i < 3; i++) r = await redeem(p2.token, p2.pin);
check('pase ilimitado multiples usos', r.granted === true && r.uses_left === null, r);
r = await redeem(p2.token, p2.pin, 'door002'); check('pase en otra puerta', r.reason === 'pass_wrong_device', r);
for (let i = 0; i < 5; i++) await redeem(p2.token, '999999');
r = await redeem(p2.token, p2.pin); check('bloqueo tras 5 pins malos (aun con pin bueno)', r.reason === 'pass_locked', r);

const p3 = await mk();
await db.exec(`update device_state set is_online=false`);
r = await redeem(p3.token, p3.pin); check('dispositivo offline no consume uso', r.reason === 'device_offline', r);
check('uses_count sigue en 0', (await q(`select uses_count from guest_passes where id=$1`, [p3.pass_id]))[0].uses_count === 0);
await db.exec(`update device_state set is_online=true`);
await db.exec(`update guest_passes set status='revoked' where id='${p3.pass_id}'`);
r = await redeem(p3.token, p3.pin); check('pase revocado', r.reason === 'pass_revoked', r);

// ---- enrolamiento ----
const [es] = await q(`insert into enrollment_sessions(device_id, requested_by) values ($1,$2) returning id`, [d1.id, prof['admin@x.com']]);
check('segunda sesion waiting rechazada', !!(await fails_with(() => db.query(`insert into enrollment_sessions(device_id) values ($1)`, [d1.id]))));
const cap = (uid) => as('service_role', null, async () => (await q(`select public.fn_enroll_capture('door001',$1,$2) r`, [es.id, uid]))[0].r);
r = await cap('04A1B2C3'); check('uid duplicada falla', r.ok === false && r.error === 'uid_already_registered', r);
const [es2] = await q(`insert into enrollment_sessions(device_id, requested_by) values ($1,$2) returning id`, [d1.id, prof['admin@x.com']]);
es.id = es2.id;
r = await cap('04:FF:EE:DD'); check('captura nueva => pending', r.ok === true && r.status === 'captured', r);
const cred = (await q(`select * from credentials where uid='04FFEEDD'`))[0];
check('credencial pending sin dueño', cred.status === 'pending' && cred.profile_id === null);
await db.query(`update credentials set profile_id=$1, status='active' where id=$2`, [prof['user2@x.com'], cred.id]);
check('asignar cierra sesion', (await q(`select status from enrollment_sessions where id=$1`, [es.id]))[0].status === 'assigned');

// ---- apertura remota ----
const unlock = (pid) => as('service_role', null, async () => (await q(`select public.fn_authorize_member_unlock($1,'door001') r`, [pid]))[0].r);
r = await unlock(prof['admin@x.com']); check('admin abre cualquier puerta', r.granted === true, r);
r = await unlock(prof['user2@x.com']); check('user2 sin grant', r.reason === 'no_grant', r);

// ---- RLS ----
const asUser = (email, fn) => as('authenticated', email === 'admin@x.com' ? adm.id : email === 'user@x.com' ? usr.id : usr2.id, fn);
check('anon no ve nada', !!(await as('anon', null, () => fails_with(() => db.query(`select * from access_logs`)))));
check('user ve solo sus logs', await asUser('user@x.com', async () => (await q(`select count(*)::int c from access_logs where profile_id <> $1`, [prof['user@x.com']]))[0].c === 0));
check('user ve su perfil solo', await asUser('user@x.com', async () => (await q(`select count(*)::int c from profiles`))[0].c === 1));
check('user ve solo puerta asignada', await asUser('user@x.com', async () => (await q(`select count(*)::int c from devices`))[0].c === 1));
check('user2 sin puertas', await asUser('user2@x.com', async () => (await q(`select count(*)::int c from devices`))[0].c === 0));
check('admin ve todo', await asUser('admin@x.com', async () => (await q(`select count(*)::int c from profiles`))[0].c === 3));
check('user no puede autopromoverse', !!(await asUser('user@x.com', () => fails_with(() => db.query(`update profiles set role='admin' where auth_user_id=$1`, [usr.id])))));
check('user puede cambiar su nombre', await asUser('user@x.com', async () => { await db.query(`update profiles set full_name='Nuevo' where auth_user_id=$1`, [usr.id]); return (await q(`select full_name from profiles where auth_user_id=$1`, [usr.id]))[0].full_name === 'Nuevo'; }));
check('user no ve secretos de pases', !!(await asUser('user@x.com', () => fails_with(() => db.query(`select * from guest_pass_secrets`)))));
check('admin tampoco lee secretos via API', !!(await asUser('admin@x.com', () => fails_with(() => db.query(`select * from guest_pass_secrets`)))));
check('user no puede insertar logs', !!(await asUser('user@x.com', () => fails_with(() => db.query(`insert into access_logs(result,method) values ('granted','system')`)))));
check('user no ejecuta fn_authorize_pass', !!(await asUser('user@x.com', () => fails_with(() => db.query(`select public.fn_authorize_pass('a','b','door001')`)))));
check('user no ejecuta private.log_access', !!(await asUser('user@x.com', () => fails_with(() => db.query(`select private.log_access(null,'granted','system')`)))));
check('logs inmutables (update)', !!(await fails_with(() => db.query(`update access_logs set meta='{}'`))));
check('user no lee audit', await asUser('user@x.com', async () => { try { return (await q(`select count(*)::int c from admin_audit`))[0].c === 0; } catch { return true; } }));
check('admin lee audit', await asUser('admin@x.com', async () => (await q(`select count(*)::int c from admin_audit`))[0].c > 0));
check('admin edita dispositivo', await asUser('admin@x.com', async () => { await db.query(`update devices set name='P1' where id=$1`, [d1.id]); return true; }));
check('user no edita dispositivo', await asUser('user@x.com', async () => (await db.query(`update devices set name='hack' where id=$1`, [d1.id])).affectedRows === 0));

// rate limit
const rl = async () => as('service_role', null, async () => (await q(`select public.fn_rate_limit('k', 3, interval '1 minute') r`))[0].r);
const seq = [await rl(), await rl(), await rl(), await rl()];
check('rate limit 3 ok, 4to bloquea', JSON.stringify(seq) === '[true,true,true,false]', seq);


// ---- lockdown (migración 4) ----
await db.exec(`update devices set lockdown=true where id='${d1.id}'`);
r = await tap('04A1B2C3', new Date().toISOString());
check('lockdown niega a miembro', r.reason === 'lockdown', r);
r = await unlock(prof['admin@x.com']); check('lockdown: admin abre', r.granted === true, r);
const p4 = await mk();
r = await redeem(p4.token, p4.pin); check('lockdown niega pase', r.reason === 'lockdown', r);
const hb = await as('service_role', null, async () => (await q(`select public.fn_device_heartbeat('door001') r`))[0].r);
check('heartbeat informa lockdown', hb.lockdown === true && hb.hold_open_until === null, hb);

// ---- motivo de reinicio (migración presence_reset_reason) ----
const resetOf = async () => (await q(`select last_reset_reason r from device_state where device_id='${d1.id}'`))[0].r;
await as('service_role', null, () => q(`select public.fn_device_heartbeat('door001', p_reset_reason => 'brownout')`));
check('heartbeat guarda motivo de reinicio', (await resetOf()) === 'brownout');
await as('service_role', null, () => q(`select public.fn_device_heartbeat('door001', p_reset_reason => 'X; drop')`));
check('motivo inválido no sobrescribe', (await resetOf()) === 'brownout');
await as('service_role', null, () => q(`select public.fn_device_heartbeat('door001')`));
check('latido sin motivo conserva el último', (await resetOf()) === 'brownout');

// ---- "mantener abierta" en el registro (migración log_hold_open) ----
const holdLogId = await as('service_role', null, async () =>
  (await q(`select public.fn_log_hold_open($1, $2, 300) r`, [d1.id, prof['admin@x.com']]))[0].r);
const holdLog = (await q(`select result, method, actor_name, meta from access_logs where id = $1`, [holdLogId]))[0];
check('hold_open queda en el registro', holdLog.result === 'granted' && holdLog.method === 'remote_app'
  && holdLog.meta.action === 'hold_open' && holdLog.meta.seconds === 300 && !!holdLog.actor_name, holdLog);
check('authenticated no puede escribir en el registro', !!(await fails_with(() =>
  as('authenticated', prof['admin@x.com'], () => q(`select public.fn_log_hold_open($1, $2, 60)`, [d1.id, prof['admin@x.com']])))));
await db.exec(`update devices set lockdown=false where id='${d1.id}'`);
r = await redeem(p4.token, p4.pin); check('sin lockdown, pase abre', r.granted === true, r);

// ---- accesos v2 (migración 5) ----
const svc = (sql, params) => as('service_role', null, async () => (await q(sql, params))[0].r);
const mk2 = (pin) => svc(`select public.fn_create_guest_pass($1,'V2', now()+interval '1 day', array[$2::uuid], now()-interval '1 minute', null,null,null,null,null,1,6,$3) r`, [prof['admin@x.com'], d1.id, pin]);
let v2 = await mk2('4821');
check('PIN personalizado respetado', v2.pin === '4821', v2);
check('PIN 0000 rechazado', !!(await fails_with(() => mk2('0000'))));
check('PIN corto rechazado', !!(await fails_with(() => mk2('12'))));
let pv = await svc(`select public.fn_pass_preview($1) r`, [v2.token]);
check('preview activo + pin_length 4', pv.status === 'active' && pv.pin_length === 4 && pv.devices.length === 1 && pv.uses_left === 1, pv);
r = await redeem(v2.token, '4821'); check('canje con PIN custom', r.granted === true, r);
pv = await svc(`select public.fn_pass_preview($1) r`, [v2.token]);
check('preview tras 1 uso = exhausted', pv.status === 'exhausted', pv);
let nlog = (await q(`select count(*)::int c from access_logs where meta->>'stage'='preview'`))[0].c;
pv = await svc(`select public.fn_pass_preview($1) r`, [v2.token]);
check('preview denegado se deduplica', (await q(`select count(*)::int c from access_logs where meta->>'stage'='preview'`))[0].c === nlog && nlog === 1, nlog);
check('refund devuelve el uso', (await svc(`select public.fn_refund_pass_use((select max(id) from access_logs where result='granted' and guest_pass_id=$1)) r`, [v2.pass_id])) === true);
check('refund idempotente', (await svc(`select public.fn_refund_pass_use((select max(id) from access_logs where result='granted' and guest_pass_id=$1)) r`, [v2.pass_id])) === false);
check('uses_count vuelve a 0', (await q(`select uses_count from guest_passes where id=$1`, [v2.pass_id]))[0].uses_count === 0);
const rot = await svc(`select public.fn_rotate_guest_pass($1) r`, [v2.pass_id]);
pv = await svc(`select public.fn_pass_preview($1) r`, [v2.token]);
check('rotar invalida el link viejo', pv.status === 'invalid', pv);
r = await redeem(rot.token, rot.pin); check('link nuevo funciona', r.granted === true, r);
check('preview token inexistente', (await svc(`select public.fn_pass_preview('nope') r`)).status === 'invalid');
await db.exec(`update guest_passes set valid_until = now() - interval '1 minute', valid_from = now() - interval '1 day' where id='${v2.pass_id}'`);
pv = await svc(`select public.fn_pass_preview($1) r`, [rot.token]);
check('preview expirado', pv.status === 'expired', pv);
check('anon no ejecuta preview', !!(await as('anon', null, () => fails_with(() => db.query(`select public.fn_pass_preview('x')`)))));

// ---- device-ingest (migración 6) ----
await db.exec(`update devices set lockdown=false`);
await db.query(`update credentials set status='active' where uid='04A1B2C3'`);
let al = await svc(`select public.fn_device_allowlist('door001') r`);
const e1 = al.entries.find((e) => e.uid === '04A1B2C3');
check('allowlist: user con horario L-V 8-18', e1 && e1.days === 31 && e1.start === 480 && e1.end === 1080 && e1.admin === false, al);
check('allowlist: offset Bogotá -300', al.utc_offset_min === -300, al.utc_offset_min);
check('allowlist: version estable', (await svc(`select public.fn_device_allowlist_version('door001') r`)) === al.version);
await db.query(`update credentials set status='suspended' where uid='04A1B2C3'`);
const al2 = await svc(`select public.fn_device_allowlist('door001') r`);
check('allowlist: suspendida excluida y version cambia', !al2.entries.some((e) => e.uid === '04A1B2C3') && al2.version !== al.version);
await db.query(`update credentials set status='active' where uid='04A1B2C3'`);
// admin con tarjeta: aparece sin restricciones aunque no tenga grant
await db.query(`insert into credentials(uid, profile_id, status) values ('AABBCCDD', $1, 'active')`, [prof['admin@x.com']]);
const al3 = await svc(`select public.fn_device_allowlist('door002') r`);
const ad = al3.entries.find((e) => e.uid === 'AABBCCDD');
check('allowlist: admin en todas las puertas sin horario', ad && ad.admin === true && ad.days === 127 && ad.start === null, al3);
check('allowlist puerta2 no incluye user sin grant', !al3.entries.some((e) => e.uid === '04A1B2C3'));
// ack
const [cmd] = await q(`insert into device_commands(device_id, type, status) values ($1,'unlock','sent') returning id`, [d1.id]);
check('ack desde otro dispositivo rechazado', (await svc(`select public.fn_device_ack('door002',$1,true) r`, [cmd.id])) === false);
check('ack ok', (await svc(`select public.fn_device_ack('door001',$1,true) r`, [cmd.id])) === true);
check('ack idempotente', (await svc(`select public.fn_device_ack('door001',$1,true) r`, [cmd.id])) === false);
check('status acked', (await q(`select status from device_commands where id=$1`, [cmd.id]))[0].status === 'acked');
// eventos offline
const lid = await svc(`select public.fn_log_device_event('door001','access','04:a1:b2:c3',true,null, now() - interval '1 hour') r`);
const lg = (await q(`select * from access_logs where id=$1`, [lid]))[0];
check('evento offline: granted con nombre y meta.offline', lg.result === 'granted' && lg.actor_name === 'Nuevo' && lg.meta.offline === true, lg);
const lid2 = await svc(`select public.fn_log_device_event('door001','access','DEAD0001',false) r`);
check('evento offline denegado desconocido', (await q(`select deny_reason from access_logs where id=$1`, [lid2]))[0].deny_reason === 'unknown_credential');
const lid3 = await svc(`select public.fn_log_device_event('door001','exit_button',null,true) r`);
check('boton de salida', (await q(`select method from access_logs where id=$1`, [lid3]))[0].method === 'exit_button');
check('reason invalido no rompe', typeof (await svc(`select public.fn_log_device_event('door001','access','DEAD0002',false,'inventado') r`)) === 'number');
check('authenticated no ejecuta allowlist', !!(await asUser('admin@x.com', () => fails_with(() => db.query(`select public.fn_device_allowlist('door001')`)))));

console.log(fails ? `\n${fails} FALLOS` : '\nTODO OK');
process.exit(fails ? 1 : 0);
