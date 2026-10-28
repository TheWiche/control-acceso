import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { Api, Unsub } from './api';
import type {
  AccessLog, CommandStatus, Credential, DeviceView, EnrollmentSession, Grant, GuestPass, PassSecret, PersonLite, Profile, Site,
} from './types';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isConfigured = Boolean(url && key);

// La clave publishable es pública por diseño: la seguridad real la dan RLS y las Edge Functions.
const sb = createClient(url ?? 'http://localhost:54321', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

/** Invoca una Edge Function y traduce errores HTTP a mensajes legibles. */
async function call<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await sb.functions.invoke(name, { body: body as Record<string, unknown> });
  if (error) {
    let msg = error.message;
    try {
      const res = (error as { context?: Response }).context;
      const j = res ? await res.json() : null;
      if (j?.error) msg = String(j.error);
    } catch { /* cuerpo no JSON */ }
    throw new Error(msg);
  }
  if (data && (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error ?? 'Error del servidor');
  return data as T;
}

function channel(name: string, specs: { table: string; filter?: string; event?: 'INSERT' | 'UPDATE' | '*' }[],
  handler: (table: string, payload: { eventType: string; new: Record<string, unknown> }) => void): Unsub {
  let ch: RealtimeChannel = sb.channel(`${name}-${Math.random().toString(36).slice(2, 8)}`);
  for (const s of specs) {
    ch = ch.on('postgres_changes', { event: s.event ?? '*', schema: 'public', table: s.table, ...(s.filter ? { filter: s.filter } : {}) },
      (p) => handler(s.table, p as unknown as { eventType: string; new: Record<string, unknown> }));
  }
  ch.subscribe();
  return () => { void sb.removeChannel(ch); };
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

export const liveApi: Api = {
  mode: 'live',

  auth: {
    async getProfile() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      const { data, error } = await sb.from('profiles')
        .select('id, auth_user_id, full_name, email, role, status')
        .eq('auth_user_id', session.user.id).maybeSingle();
      fail(error);
      return (data as Profile | null);
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      fail(error);
    },
    async signOut() { await sb.auth.signOut(); },
    onChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') cb();
      });
      return () => data.subscription.unsubscribe();
    },
  },

  async listDevices() {
    const { data, error } = await sb.from('devices').select('*, device_state(*)').order('name');
    fail(error);
    return (data ?? []).map((d) => {
      const { device_state, ...device } = d as Record<string, unknown>;
      return { ...device, state: one(device_state as DeviceView['state'] | DeviceView['state'][]) } as DeviceView;
    });
  },

  subscribeDevices(cb) {
    return channel('devices', [{ table: 'device_state' }, { table: 'devices', event: 'UPDATE' }], (table, p) => {
      const row = p.new as Record<string, unknown>;
      if (table === 'device_state') cb({ id: row.device_id as string, state: row as never });
      else cb({ id: row.id as string, device: row as never });
    });
  },

  async listLogs(limit) {
    const { data, error } = await sb.from('access_logs').select('*').order('occurred_at', { ascending: false }).limit(limit);
    fail(error);
    return (data ?? []) as AccessLog[];
  },

  subscribeLogs(cb) {
    return channel('logs', [{ table: 'access_logs', event: 'INSERT' }], (_t, p) => cb(p.new as unknown as AccessLog));
  },

  async activitySince(hours) {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const { data, error } = await sb.from('access_logs').select('occurred_at, result')
      .gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(5000);
    fail(error);
    return (data ?? []) as { occurred_at: string; result: 'granted' | 'denied' }[];
  },

  async metrics() {
    const today = startOfToday();
    const nowIso = new Date().toISOString();
    const count = (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) =>
      q.then((r) => { fail(r.error); return r.count ?? 0; });
    const [grantedToday, deniedToday, activePeople, activePasses] = await Promise.all([
      count(sb.from('access_logs').select('id', { count: 'exact', head: true }).eq('result', 'granted').gte('occurred_at', today)),
      count(sb.from('access_logs').select('id', { count: 'exact', head: true }).eq('result', 'denied').gte('occurred_at', today)),
      count(sb.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'active')),
      count(sb.from('guest_passes').select('id', { count: 'exact', head: true })
        .eq('status', 'active').lte('valid_from', nowIso).gt('valid_until', nowIso)),
    ]);
    return { grantedToday, deniedToday, activePeople, activePasses };
  },

  async listCredentials() {
    const { data, error } = await sb.from('credentials')
      // credentials tiene DOS FK a profiles (profile_id y created_by): hay que nombrar la relación.
      .select('*, owner:profiles!credentials_profile_id_fkey(id, full_name)').order('created_at', { ascending: false });
    fail(error);
    return (data ?? []).map((c) => ({ ...c, owner: one((c as { owner: unknown }).owner as Credential['owner']) })) as Credential[];
  },

  subscribeCredentials(cb) {
    return channel('creds', [{ table: 'credentials' }], () => cb());
  },

  async updateCredential(id, patch) {
    const { error } = await sb.from('credentials').update(patch).eq('id', id);
    fail(error);
  },

  async deleteCredential(id) {
    const { error } = await sb.from('credentials').delete().eq('id', id);
    fail(error);
  },

  async listPeople() {
    const { data, error } = await sb.from('profiles').select('id, full_name, email, status').order('full_name');
    fail(error);
    return (data ?? []) as PersonLite[];
  },

  async createPerson(fullName) {
    const { data, error } = await sb.from('profiles').insert({ full_name: fullName.trim() })
      .select('id, full_name, email, status').single();
    fail(error);
    return data as PersonLite;
  },

  async getGrants(profileId) {
    const { data, error } = await sb.from('access_grants')
      .select('device_id, allowed_days, time_start, time_end').eq('profile_id', profileId);
    fail(error);
    return (data ?? []).map((g) => ({
      device_id: g.device_id as string,
      allowed_days: (g.allowed_days as number[] | null) ?? null,
      time_start: g.time_start ? String(g.time_start).slice(0, 5) : null,
      time_end: g.time_end ? String(g.time_end).slice(0, 5) : null,
    })) as Grant[];
  },

  async saveGrants(profileId, deviceIds, rule) {
    const { data: me } = await sb.auth.getUser();
    const { data: meProfile } = await sb.from('profiles').select('id').eq('auth_user_id', me.user?.id ?? '').maybeSingle();
    if (deviceIds.length) {
      const rows = deviceIds.map((device_id) => ({
        profile_id: profileId, device_id, created_by: meProfile?.id ?? null,
        allowed_days: rule.allowed_days, time_start: rule.time_start, time_end: rule.time_end,
      }));
      const { error } = await sb.from('access_grants').upsert(rows, { onConflict: 'profile_id,device_id' });
      fail(error);
    }
    // Quita permisos de puertas desmarcadas
    let del = sb.from('access_grants').delete().eq('profile_id', profileId);
    if (deviceIds.length) del = del.not('device_id', 'in', `(${deviceIds.join(',')})`);
    const { error } = await del;
    fail(error);
  },

  async grantDoor(profileId, deviceId) {
    const { error } = await sb.from('access_grants').upsert(
      { profile_id: profileId, device_id: deviceId }, { onConflict: 'profile_id,device_id', ignoreDuplicates: true });
    fail(error);
  },

  async listPasses() {
    const { data, error } = await sb.from('guest_passes')
      .select('*, guest_pass_devices(device_id)').order('created_at', { ascending: false }).limit(200);
    fail(error);
    return (data ?? []).map((p) => {
      const { guest_pass_devices, ...pass } = p as Record<string, unknown>;
      return {
        ...pass,
        time_start: pass.time_start ? String(pass.time_start).slice(0, 5) : null,
        time_end: pass.time_end ? String(pass.time_end).slice(0, 5) : null,
        device_ids: ((guest_pass_devices as { device_id: string }[]) ?? []).map((d) => d.device_id),
      } as GuestPass;
    });
  },

  subscribePasses(cb) {
    return channel('passes', [{ table: 'guest_passes' }], () => cb());
  },

  async createPass(input) {
    return await call<PassSecret>('pass-manage', { action: 'create', ...input });
  },

  async rotatePass(passId, pin) {
    return await call<PassSecret>('pass-manage', { action: 'rotate', pass_id: passId, pin });
  },

  async revokePass(passId) {
    const { error } = await sb.from('guest_passes')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', passId);
    fail(error);
  },

  async unlock(deviceCode) {
    const r = await call<{ command_id: string }>('unlock', { device_code: deviceCode });
    return { commandId: r.command_id };
  },

  waitCommand(commandId, timeoutMs) {
    return new Promise<CommandStatus>((resolve) => {
      const final = (s: string) => s === 'acked' || s === 'failed' || s === 'expired';
      let done = false;
      const finish = (s: CommandStatus) => { if (done) return; done = true; clearInterval(poll); clearTimeout(to); off(); resolve(s); };
      const off = channel('cmd', [{ table: 'device_commands', filter: `id=eq.${commandId}` }], (_t, p) => {
        const s = String(p.new.status);
        if (final(s)) finish(s as CommandStatus);
      });
      // Respaldo por si Realtime se retrasa
      const poll = setInterval(async () => {
        const { data } = await sb.from('device_commands').select('status').eq('id', commandId).maybeSingle();
        if (data && final(String(data.status))) finish(data.status as CommandStatus);
      }, 1500);
      const to = setTimeout(() => finish('expired'), timeoutMs);
    });
  },

  async updateDevice(id, patch) {
    const { error } = await sb.from('devices').update(patch).eq('id', id);
    fail(error);
  },

  async getSite() {
    const { data, error } = await sb.from('sites').select('id, name, timezone').order('created_at').limit(1).maybeSingle();
    fail(error);
    return (data as Site | null) ?? null;
  },

  async updateSite(id, patch) {
    const { error } = await sb.from('sites').update(patch).eq('id', id);
    fail(error);
  },

  async deviceControl(deviceCode, action, seconds) {
    const r = await call<{ delivered?: boolean }>('device-control', { device_code: deviceCode, action, seconds });
    return { delivered: r.delivered !== false };
  },

  async enrollStart(deviceCode, kind) {
    const r = await call<{ session: EnrollmentSession }>('enroll-start', { device_code: deviceCode, kind });
    return r.session;
  },

  async enrollCancel(sessionId) {
    await call('enroll-cancel', { session_id: sessionId });
  },

  subscribeEnrollment(sessionId, cb) {
    const fetchOnce = async () => {
      const { data } = await sb.from('enrollment_sessions')
        .select('id, device_id, status, expires_at, captured_uid, credential_id, error').eq('id', sessionId).maybeSingle();
      if (data) cb(data as EnrollmentSession);
    };
    const off = channel('enroll', [{ table: 'enrollment_sessions', filter: `id=eq.${sessionId}` }],
      (_t, p) => cb(p.new as unknown as EnrollmentSession));
    const poll = setInterval(fetchOnce, 2000); // respaldo
    return () => { clearInterval(poll); off(); };
  },
};
