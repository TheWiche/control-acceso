import type { AccessLog, CredentialKind, CredentialStatus } from './types';

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'short' });

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'nunca';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 5) return 'ahora';
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });

export function mmss(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** 04A1B2C3 -> 04:A1:B2:C3 */
export const fmtUid = (uid: string) => uid.match(/.{1,2}/g)?.join(':') ?? uid;

/** Barras de señal 1..4 a partir del RSSI (dBm). */
export function rssiBars(rssi: number | null): number {
  if (rssi == null) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

export const DENY_REASONS: Record<string, string> = {
  unknown_credential: 'Tarjeta no registrada',
  credential_inactive: 'Tarjeta desactivada',
  credential_expired: 'Tarjeta vencida',
  user_suspended: 'Persona suspendida',
  no_grant: 'Sin permiso en esta puerta',
  grant_expired: 'Permiso vencido',
  outside_schedule: 'Fuera de horario',
  device_inactive: 'Puerta deshabilitada',
  device_offline: 'Puerta sin conexión',
  lockdown: 'Bloqueo total activo',
  pass_invalid: 'Pase inválido',
  pin_invalid: 'PIN incorrecto',
  pass_locked: 'Pase bloqueado por intentos',
  pass_revoked: 'Pase revocado',
  pass_expired: 'Pase vencido',
  pass_not_yet_valid: 'Pase aún no vigente',
  pass_exhausted: 'Pase sin usos',
  pass_wrong_device: 'Pase de otra puerta',
  step_up_required: 'Falta verificación',
  rate_limited: 'Demasiados intentos',
};

export const METHOD_LABELS: Record<string, string> = {
  credential: 'Tarjeta / llavero',
  guest_pass: 'Pase de invitado',
  remote_app: 'Apertura remota',
  door_tag: 'Tag de la puerta',
  exit_button: 'Botón de salida',
  system: 'Sistema',
};

export const KIND_LABELS: Record<CredentialKind, string> = {
  rfid_card: 'Tarjeta blanca',
  nfc_keyfob: 'Llavero azul',
  other: 'Otro',
};

export const STATUS_LABELS: Record<CredentialStatus, string> = {
  pending: 'Sin asignar',
  active: 'Activa',
  suspended: 'Desactivada',
  lost: 'Extraviada',
  revoked: 'Revocada',
};

export const isUnknownCard = (l: AccessLog) => l.result === 'denied' && l.deny_reason === 'unknown_credential';

export const DAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']; // ISO 1..7
export const DAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function scheduleSummary(days: number[] | null, start: string | null, end: string | null): string {
  const d = !days || days.length === 7 ? 'Todos los días' : days.map((n) => DAY_NAMES[n - 1]!.slice(0, 3)).join(', ');
  const t = start && end ? `${start}–${end}` : 'todo el día';
  return `${d} · ${t}`;
}

export const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
