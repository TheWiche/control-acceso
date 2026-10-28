import type { Api, Unsub } from './api';
import { demoPasses } from './demoStore';
import type {
  AccessLog, ActivityPoint, CommandStatus, Credential, CredentialKind, DeviceView, EnrollmentSession,
  Grant, PersonLite, Profile, ScheduleRule,
} from './types';

// Backend simulado en memoria para ver y probar la interfaz sin Supabase (VITE_DEMO=true).
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomUUID();
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const me: Profile = { id: 'p-admin', auth_user_id: 'u-admin', full_name: 'Administrador Demo', email: 'admin@demo.local', role: 'admin', status: 'active' };
let signedIn = (() => { try { return sessionStorage.getItem('demo-auth') === '1'; } catch { return false; } })();
const authListeners = new Set<() => void>();

const people: PersonLite[] = [
  { id: 'p1', full_name: 'Laura Mendoza', email: null, status: 'active' },
  { id: 'p2', full_name: 'Carlos Ruiz', email: null, status: 'active' },
  { id: 'p3', full_name: 'Ana Torres', email: null, status: 'active' },
  { id: 'p4', full_name: 'Diego Salazar', email: null, status: 'active' },
];
const nameOf = (id: string | null) => people.find((p) => p.id === id)?.full_name ?? null;

const devices: DeviceView[] = [
  {
    id: 'd1', device_code: 'puerta01x', name: 'Puerta principal', location: 'Entrada · Planta baja', unlock_ms: 3000,
    is_active: true, lockdown: false, hold_open_until: null,
    state: { device_id: 'd1', is_online: true, last_seen_at: ago(4), ip_address: '192.168.1.42', rssi: -58, lock_state: 'locked', door_closed: true, firmware_version: '0.4.1', uptime_seconds: 188_000, last_reset_reason: 'power_on', enroll_mode_until: null },
  },
  {
    id: 'd2', device_code: 'bodega02y', name: 'Bodega', location: 'Sótano', unlock_ms: 4000,
    is_active: true, lockdown: false, hold_open_until: null,
    state: { device_id: 'd2', is_online: false, last_seen_at: ago(1260), ip_address: '192.168.1.57', rssi: -81, lock_state: 'locked', door_closed: true, firmware_version: '0.4.1', uptime_seconds: null, last_reset_reason: null, enroll_mode_until: null },
  },
];

const credentials: Credential[] = [
  { id: 'c1', uid: '04A1B2C3', kind: 'rfid_card', label: 'Tarjeta blanca #1', profile_id: 'p1', status: 'active', valid_from: null, valid_until: null, last_used_at: ago(600), created_at: ago(86400 * 30), owner: null },
  { id: 'c2', uid: '04A7D9E1F2B380', kind: 'nfc_keyfob', label: 'Llavero azul', profile_id: 'p2', status: 'active', valid_from: null, valid_until: null, last_used_at: ago(3600 * 5), created_at: ago(86400 * 20), owner: null },
  { id: 'c3', uid: '5C0D11F8', kind: 'nfc_keyfob', label: 'Llavero azul #2', profile_id: 'p3', status: 'suspended', valid_from: null, valid_until: null, last_used_at: ago(86400 * 3), created_at: ago(86400 * 15), owner: null },
  { id: 'c4', uid: '9E22AB07', kind: 'rfid_card', label: 'Tarjeta blanca #2', profile_id: 'p4', status: 'active', valid_from: null, valid_until: ago(-86400 * 20), last_used_at: ago(86400), created_at: ago(86400 * 9), owner: null },
  { id: 'c5', uid: '31F0C4D2', kind: 'rfid_card', label: null, profile_id: null, status: 'pending', valid_from: null, valid_until: null, last_used_at: null, created_at: ago(7200), owner: null },
  { id: 'c6', uid: '77AA0912', kind: 'nfc_keyfob', label: 'Llavero (extraviado)', profile_id: 'p2', status: 'lost', valid_from: null, valid_until: null, last_used_at: ago(86400 * 40), created_at: ago(86400 * 60), owner: null },
];
const grants: (Grant & { profile_id: string })[] = [
  { profile_id: 'p1', device_id: 'd1', allowed_days: null, time_start: null, time_end: null },
  { profile_id: 'p1', device_id: 'd2', allowed_days: [1, 2, 3, 4, 5], time_start: '08:00', time_end: '18:00' },
  { profile_id: 'p2', device_id: 'd1', allowed_days: [1, 2, 3, 4, 5], time_start: '07:00', time_end: '20:00' },
];

let logSeq = 1000;
const logs: AccessLog[] = [];
const logListeners = new Set<(l: AccessLog) => void>();
const credListeners = new Set<() => void>();
const passListeners = new Set<() => void>();
const devListeners = new Set<(p: { id: string; device?: Partial<DeviceView>; state?: Partial<DeviceView['state']> }) => void>();
const emitCreds = () => credListeners.forEach((f) => f());

function pushLog(partial: Partial<AccessLog> & Pick<AccessLog, 'result' | 'method'>, at = new Date().toISOString(), silent = false) {
  const dev = devices[0];
  const l: AccessLog = {
    id: ++logSeq, occurred_at: at, device_id: dev.id, device_name: dev.name, deny_reason: null, profile_id: null,
    actor_name: null, credential_id: null, credential_uid: null, guest_pass_id: null, ...partial,
  };
  logs.unshift(l);
  if (!silent) logListeners.forEach((f) => f(l));
  return l;
}

// Historial inicial (últimas 24 h)
(() => {
  const rnd = [
    () => pushLog({ result: 'granted', method: 'credential', profile_id: 'p1', actor_name: 'Laura Mendoza', credential_uid: '04A1B2C3' }, ago(Math.random() * 86000), true),
    () => pushLog({ result: 'granted', method: 'credential', profile_id: 'p2', actor_name: 'Carlos Ruiz', credential_uid: '04A7D9E1F2B380' }, ago(Math.random() * 86000), true),
    () => pushLog({ result: 'granted', method: 'guest_pass', actor_name: 'Invitado · Plomero' }, ago(Math.random() * 86000), true),
    () => pushLog({ result: 'denied', method: 'credential', deny_reason: 'unknown_credential', credential_uid: hex(8) }, ago(Math.random() * 86000), true),
    () => pushLog({ result: 'denied', method: 'credential', deny_reason: 'outside_schedule', actor_name: 'Carlos Ruiz', credential_uid: '04A7D9E1F2B380' }, ago(Math.random() * 86000), true),
  ];
  for (let i = 0; i < 46; i++) rnd[Math.floor(Math.random() * rnd.length)]!();
  logs.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
})();

// Actividad simulada + latidos
setInterval(() => {
  const d = devices[0]!;
  const rssi = Math.max(-80, Math.min(-45, (d.state.rssi ?? -60) + Math.round((Math.random() - 0.5) * 6)));
  Object.assign(d.state, { last_seen_at: new Date().toISOString(), rssi, is_online: true });
  devListeners.forEach((f) => f({ id: d.id, state: { last_seen_at: d.state.last_seen_at, rssi, is_online: true } }));
}, 5000);

setInterval(() => {
  if (!signedIn) return;
  const r = Math.random();
  if (r < 0.45) pushLog({ result: 'granted', method: 'credential', profile_id: 'p1', actor_name: 'Laura Mendoza', credential_uid: '04A1B2C3' });
  else if (r < 0.7) pushLog({ result: 'granted', method: 'credential', profile_id: 'p2', actor_name: 'Carlos Ruiz', credential_uid: '04A7D9E1F2B380' });
  else if (r < 0.85) pushLog({ result: 'denied', method: 'credential', deny_reason: 'unknown_credential', credential_uid: hex(8) });
  else pushLog({ result: 'denied', method: 'credential', deny_reason: 'credential_inactive', actor_name: 'Ana Torres', credential_uid: '5C0D11F8' });
}, 11000);

const resolveOwners = () => credentials.forEach((c) => { c.owner = c.profile_id ? { id: c.profile_id, full_name: nameOf(c.profile_id) ?? '—' } : null; });
const subs = <T,>(set: Set<T>, fn: T): Unsub => { set.add(fn); return () => { set.delete(fn); }; };
const patchDevice = (id: string, device: Partial<DeviceView>) => {
  const d = devices.find((x) => x.id === id)!; Object.assign(d, device);
  devListeners.forEach((f) => f({ id, device }));
};

const commands = new Map<string, CommandStatus>();
const sessions = new Map<string, { s: EnrollmentSession; cbs: Set<(s: EnrollmentSession) => void> }>();
const setSession = (id: string, patch: Partial<EnrollmentSession>) => {
  const e = sessions.get(id); if (!e) return;
  e.s = { ...e.s, ...patch }; e.cbs.forEach((f) => f(e.s));
};

export const demoApi: Api = {
  mode: 'demo',

  auth: {
    async getProfile() { return signedIn ? me : null; },
    async signIn() {
      await wait(500); signedIn = true;
      try { sessionStorage.setItem('demo-auth', '1'); } catch { /* ignore */ }
      authListeners.forEach((f) => f());
    },
    async signOut() {
      signedIn = false;
      try { sessionStorage.removeItem('demo-auth'); } catch { /* ignore */ }
      authListeners.forEach((f) => f());
    },
    onChange(cb) { return subs(authListeners, cb); },
  },

  async listDevices() { await wait(250); return structuredClone(devices); },
  subscribeDevices(cb) { return subs(devListeners, cb); },

  async listLogs(limit) { await wait(200); return logs.slice(0, limit); },
  subscribeLogs(cb) { return subs(logListeners, cb); },
  async activitySince(hours) {
    const since = Date.now() - hours * 3600_000;
    return logs.filter((l) => new Date(l.occurred_at).getTime() >= since).map<ActivityPoint>((l) => ({ occurred_at: l.occurred_at, result: l.result }));
  },
  async metrics() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = logs.filter((l) => new Date(l.occurred_at) >= start);
    return {
      grantedToday: today.filter((l) => l.result === 'granted').length,
      deniedToday: today.filter((l) => l.result === 'denied').length,
      activePeople: people.filter((p) => p.status === 'active').length + 1,
      activePasses: 2,
    };
  },

  async listCredentials() { await wait(200); resolveOwners(); return structuredClone(credentials); },
  subscribeCredentials(cb) { return subs(credListeners, cb); },
  async updateCredential(id, patch) {
    await wait(150);
    const c = credentials.find((x) => x.id === id); if (!c) throw new Error('No existe');
    Object.assign(c, patch); resolveOwners(); emitCreds();
  },
  async deleteCredential(id) {
    const i = credentials.findIndex((x) => x.id === id); if (i >= 0) credentials.splice(i, 1); emitCreds();
  },

  async listPeople() { return structuredClone(people); },
  async createPerson(fullName) {
    const p: PersonLite = { id: rid(), full_name: fullName.trim(), email: null, status: 'active' };
    people.push(p); return p;
  },
  async getGrants(profileId) {
    return grants.filter((g) => g.profile_id === profileId).map(({ profile_id: _p, ...g }) => g);
  },
  async saveGrants(profileId, deviceIds, rule: ScheduleRule) {
    await wait(200);
    for (let i = grants.length - 1; i >= 0; i--) if (grants[i]!.profile_id === profileId) grants.splice(i, 1);
    deviceIds.forEach((device_id) => grants.push({ profile_id: profileId, device_id, ...rule }));
  },
  async grantDoor(profileId, deviceId) {
    if (!grants.some((g) => g.profile_id === profileId && g.device_id === deviceId))
      grants.push({ profile_id: profileId, device_id: deviceId, allowed_days: null, time_start: null, time_end: null });
  },

  async listPasses() {
    await wait(200);
    return demoPasses.map(({ token: _t, pin: _p, failed: _f, ...pass }) => ({ ...pass })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  subscribePasses(cb) { return subs(passListeners, cb); },
  async createPass(input) {
    await wait(500);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 22);
    const pin = input.pin || String(Math.floor(100000 + Math.random() * 900000));
    const ids = devices.filter((d) => input.device_codes.includes(d.device_code)).map((d) => d.id);
    const id = rid();
    demoPasses.unshift({
      id, label: input.label, guest_phone: input.guest_phone || null, valid_from: input.valid_from, valid_until: input.valid_until,
      allowed_days: input.allowed_days, time_start: input.time_start, time_end: input.time_end, max_uses: input.max_uses,
      uses_count: 0, status: 'active', revoked_at: null, last_used_at: null, created_at: new Date().toISOString(),
      device_ids: ids, token, pin, failed: 0,
    });
    passListeners.forEach((f) => f());
    return { pass_id: id, token, pin };
  },
  async rotatePass(passId, pin) {
    await wait(300);
    const p = demoPasses.find((x) => x.id === passId); if (!p) throw new Error('Pase inexistente');
    p.token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 22);
    p.pin = pin || String(Math.floor(100000 + Math.random() * 900000)); p.failed = 0;
    return { pass_id: p.id, token: p.token, pin: p.pin };
  },
  async revokePass(passId) {
    await wait(200);
    const p = demoPasses.find((x) => x.id === passId); if (!p) return;
    p.status = 'revoked'; p.revoked_at = new Date().toISOString();
    passListeners.forEach((f) => f());
  },

  async unlock(deviceCode) {
    const d = devices.find((x) => x.device_code === deviceCode);
    await wait(350);
    if (!d || !d.state.is_online) throw new Error('El dispositivo está desconectado');
    const id = rid(); commands.set(id, 'sent');
    setTimeout(() => {
      commands.set(id, 'acked');
      patchDevice(d.id, {}); d.state.lock_state = 'unlocked';
      devListeners.forEach((f) => f({ id: d.id, state: { lock_state: 'unlocked' } }));
      pushLog({ result: 'granted', method: 'remote_app', profile_id: me.id, actor_name: me.full_name });
      setTimeout(() => {
        d.state.lock_state = 'locked';
        devListeners.forEach((f) => f({ id: d.id, state: { lock_state: 'locked' } }));
      }, d.unlock_ms);
    }, 900);
    return { commandId: id };
  },
  async waitCommand(commandId, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = commands.get(commandId);
      if (s === 'acked' || s === 'failed') return s;
      await wait(150);
    }
    return 'expired';
  },
  async deviceControl(deviceCode, action, seconds) {
    const d = devices.find((x) => x.device_code === deviceCode);
    await wait(400);
    if (!d) throw new Error('Dispositivo desconocido');
    if (action === 'lockdown_on') patchDevice(d.id, { lockdown: true, hold_open_until: null });
    if (action === 'lockdown_off') patchDevice(d.id, { lockdown: false });
    if (action === 'hold_open') {
      if (d.lockdown) throw new Error('Quita primero el bloqueo total');
      if (!d.state.is_online) throw new Error('La cerradura está desconectada');
      patchDevice(d.id, { hold_open_until: new Date(Date.now() + (seconds ?? 300) * 1000).toISOString() });
    }
    if (action === 'release') patchDevice(d.id, { hold_open_until: null });
    return { delivered: d.state.is_online };
  },

  async enrollStart(deviceCode, kind: CredentialKind) {
    const d = devices.find((x) => x.device_code === deviceCode);
    await wait(400);
    if (!d || !d.state.is_online) throw new Error('El dispositivo está desconectado');
    const s: EnrollmentSession = {
      id: rid(), device_id: d.id, status: 'waiting', expires_at: new Date(Date.now() + 60_000).toISOString(),
      captured_uid: null, credential_id: null, error: null,
    };
    sessions.set(s.id, { s, cbs: new Set() });
    // Simula que el usuario acerca el llavero al PN532 tras ~6 s
    setTimeout(() => {
      const e = sessions.get(s.id); if (!e || e.s.status !== 'waiting') return;
      const uid = kind === 'nfc_keyfob' ? hex(14) : hex(8);
      const c: Credential = { id: rid(), uid, kind, label: null, profile_id: null, status: 'pending', valid_from: null, valid_until: null, last_used_at: null, created_at: new Date().toISOString(), owner: null };
      credentials.unshift(c); emitCreds();
      setSession(s.id, { status: 'captured', captured_uid: uid, credential_id: c.id });
    }, 6000);
    return s;
  },
  async enrollCancel(sessionId) { setSession(sessionId, { status: 'cancelled' }); },
  subscribeEnrollment(sessionId, cb) {
    const e = sessions.get(sessionId); if (!e) return () => {};
    e.cbs.add(cb); cb(e.s);
    return () => e.cbs.delete(cb);
  },
};
