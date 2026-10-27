// Tipos que reflejan el esquema de Supabase (supabase/migrations).

export type Role = 'admin' | 'operator' | 'user';
export type CredentialKind = 'rfid_card' | 'nfc_keyfob' | 'other';
export type CredentialStatus = 'pending' | 'active' | 'suspended' | 'lost' | 'revoked';
export type LockState = 'locked' | 'unlocked' | 'unknown';
export type AccessMethod = 'credential' | 'guest_pass' | 'remote_app' | 'door_tag' | 'exit_button' | 'system';
export type CommandStatus = 'pending' | 'sent' | 'acked' | 'failed' | 'expired';
export type EnrollmentStatus = 'waiting' | 'captured' | 'assigned' | 'expired' | 'cancelled' | 'failed';

export interface Profile {
  id: string;
  auth_user_id: string | null;
  full_name: string;
  email: string | null;
  role: Role;
  status: 'active' | 'suspended';
}

export interface DeviceState {
  device_id: string;
  is_online: boolean;
  last_seen_at: string | null;
  ip_address: string | null;
  rssi: number | null;
  lock_state: LockState;
  door_closed: boolean | null;
  firmware_version: string | null;
  uptime_seconds: number | null;
  enroll_mode_until: string | null;
}

export interface Device {
  id: string;
  device_code: string;
  name: string;
  location: string | null;
  unlock_ms: number;
  is_active: boolean;
  lockdown: boolean;
  hold_open_until: string | null;
}

export interface DeviceView extends Device {
  state: DeviceState;
}

export interface AccessLog {
  id: number;
  occurred_at: string;
  device_id: string | null;
  device_name: string | null;
  result: 'granted' | 'denied';
  method: AccessMethod;
  deny_reason: string | null;
  profile_id: string | null;
  actor_name: string | null;
  credential_id: string | null;
  credential_uid: string | null;
  guest_pass_id: string | null;
}

export interface Credential {
  id: string;
  uid: string;
  kind: CredentialKind;
  label: string | null;
  profile_id: string | null;
  status: CredentialStatus;
  valid_from: string | null;
  valid_until: string | null;
  last_used_at: string | null;
  created_at: string;
  owner: { id: string; full_name: string } | null;
}

export interface PersonLite {
  id: string;
  full_name: string;
  email: string | null;
  status: 'active' | 'suspended';
}

/** Regla horaria (access_grants). allowed_days: ISO 1=lunes … 7=domingo; null = todos. */
export interface ScheduleRule {
  allowed_days: number[] | null;
  time_start: string | null; // 'HH:MM'
  time_end: string | null;
}

export interface Grant extends ScheduleRule {
  device_id: string;
}

export interface EnrollmentSession {
  id: string;
  device_id: string;
  status: EnrollmentStatus;
  expires_at: string;
  captured_uid: string | null;
  credential_id: string | null;
  error: string | null;
}

export interface Metrics {
  grantedToday: number;
  deniedToday: number;
  activePeople: number;
  activePasses: number;
}

export interface ActivityPoint {
  occurred_at: string;
  result: 'granted' | 'denied';
}

export type DeviceAction = 'lockdown_on' | 'lockdown_off' | 'hold_open' | 'release';

export interface GuestPass {
  id: string;
  label: string;
  guest_phone: string | null;
  valid_from: string;
  valid_until: string;
  allowed_days: number[] | null;
  time_start: string | null;
  time_end: string | null;
  max_uses: number | null;
  uses_count: number;
  status: 'active' | 'revoked';
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  device_ids: string[];
}

export interface NewPassInput {
  label: string;
  guest_phone: string;
  valid_from: string;
  valid_until: string;
  device_codes: string[];
  allowed_days: number[] | null;
  time_start: string | null;
  time_end: string | null;
  max_uses: number | null;
  pin?: string;
}

/** Devuelto UNA sola vez al crear o regenerar: en la base solo queda el hash. */
export interface PassSecret { pass_id: string; token: string; pin: string }

export type PassState = 'active' | 'scheduled' | 'expired' | 'exhausted' | 'revoked';

export function passState(p: GuestPass, now = Date.now()): PassState {
  if (p.status === 'revoked') return 'revoked';
  if (new Date(p.valid_until).getTime() <= now) return 'expired';
  if (p.max_uses !== null && p.uses_count >= p.max_uses) return 'exhausted';
  if (new Date(p.valid_from).getTime() > now) return 'scheduled';
  return 'active';
}
