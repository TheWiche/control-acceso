import { DEMO } from './index';
import { demoPasses } from './demoStore';

export type PreviewStatus = 'active' | 'outside_schedule' | 'not_yet' | 'expired' | 'revoked' | 'exhausted' | 'locked' | 'invalid';

export interface PassPreview {
  status: PreviewStatus;
  guest?: string;
  valid_from?: string;
  valid_until?: string;
  allowed_days?: number[] | null;
  time_start?: string | null;
  time_end?: string | null;
  timezone?: string;
  max_uses?: number | null;
  uses_left?: number | null;
  pin_length?: number;
  devices?: { code: string; name: string }[];
}

export type RedeemResult =
  | { granted: true; unlock_ms: number; uses_left: number | null; guest: string }
  | { granted: false; reason: string; attempts_left?: number };

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(`${url}/functions/v1/pass`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key ?? '' }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 429) return { granted: false, reason: 'rate_limited' } as T;
  if (!res.ok || j.ok === false) throw new Error(j.error ?? 'No se pudo contactar al servidor');
  return j as T;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scheduleOk(days: number[] | null, start: string | null, end: string | null): boolean {
  const d = new Date();
  const iso = d.getDay() === 0 ? 7 : d.getDay();
  if (days && !days.includes(iso)) return false;
  if (!start || !end) return true;
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** Estado y reglas del pase (vista previa, antes del PIN). El token de 128 bits es la credencial de esta consulta. */
export async function previewPass(token: string): Promise<PassPreview> {
  if (DEMO) {
    await wait(500);
    const p = demoPasses.find((x) => x.token === token);
    if (!p) return { status: 'invalid' };
    const now = Date.now();
    let status: PreviewStatus = 'active';
    if (p.status === 'revoked') status = 'revoked';
    else if (new Date(p.valid_until).getTime() <= now) status = 'expired';
    else if (new Date(p.valid_from).getTime() > now) status = 'not_yet';
    else if (p.max_uses !== null && p.uses_count >= p.max_uses) status = 'exhausted';
    else if (!scheduleOk(p.allowed_days, p.time_start, p.time_end)) status = 'outside_schedule';
    return {
      status, guest: p.label, valid_from: p.valid_from, valid_until: p.valid_until, allowed_days: p.allowed_days,
      time_start: p.time_start, time_end: p.time_end, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      max_uses: p.max_uses, uses_left: p.max_uses === null ? null : Math.max(0, p.max_uses - p.uses_count),
      pin_length: p.pin.length, devices: [{ code: 'puerta01x', name: 'Puerta principal' }],
    };
  }
  return post<PassPreview>({ action: 'preview', token });
}

/** Canje: el servidor valida PIN, vigencia, horario y usos, y espera la confirmación física de la cerradura. */
export async function redeemPass(token: string, pin: string, deviceCode: string): Promise<RedeemResult> {
  if (DEMO) {
    await wait(700);
    const p = demoPasses.find((x) => x.token === token);
    if (!p) return { granted: false, reason: 'pass_invalid' };
    if (p.failed >= 5) return { granted: false, reason: 'pass_locked' };
    if (pin !== p.pin) { p.failed++; return { granted: false, reason: 'pin_invalid', attempts_left: Math.max(0, 5 - p.failed) }; }
    p.failed = 0;
    const pv = await previewPass(token);
    if (pv.status !== 'active') {
      const map: Record<string, string> = { revoked: 'pass_revoked', expired: 'pass_expired', not_yet: 'pass_not_yet_valid', exhausted: 'pass_exhausted', outside_schedule: 'outside_schedule' };
      return { granted: false, reason: map[pv.status] ?? 'pass_invalid' };
    }
    await wait(900);
    p.uses_count++;
    return { granted: true, unlock_ms: 3000, uses_left: p.max_uses === null ? null : p.max_uses - p.uses_count, guest: p.label };
  }
  void deviceCode;
  return post<RedeemResult>({ action: 'redeem', token, pin, device_code: deviceCode });
}
