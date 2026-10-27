import type {
  GuestPass, NewPassInput, PassSecret,
  AccessLog, ActivityPoint, CommandStatus, Credential, CredentialKind, CredentialStatus, DeviceAction,
  DeviceView, EnrollmentSession, Grant, Metrics, PersonLite, Profile, ScheduleRule,
} from './types';

export type Unsub = () => void;

/** Contrato único de datos. Lo implementan `liveApi` (Supabase) y `demoApi` (en memoria). */
export interface Api {
  mode: 'live' | 'demo';

  auth: {
    getProfile(): Promise<Profile | null>;
    signIn(email: string, password: string): Promise<void>;
    signOut(): Promise<void>;
    onChange(cb: () => void): Unsub;
  };

  listDevices(): Promise<DeviceView[]>;
  subscribeDevices(cb: (patch: { id: string; device?: Partial<DeviceView>; state?: Partial<DeviceView['state']> }) => void): Unsub;

  listLogs(limit: number): Promise<AccessLog[]>;
  subscribeLogs(cb: (log: AccessLog) => void): Unsub;
  activitySince(hours: number): Promise<ActivityPoint[]>;
  metrics(): Promise<Metrics>;

  listCredentials(): Promise<Credential[]>;
  /** Avisa de cualquier cambio en credenciales (el consumidor vuelve a listar). */
  subscribeCredentials(cb: () => void): Unsub;
  updateCredential(id: string, patch: Partial<{
    label: string | null; kind: CredentialKind; status: CredentialStatus; profile_id: string | null;
    valid_from: string | null; valid_until: string | null;
  }>): Promise<void>;
  deleteCredential(id: string): Promise<void>;

  listPeople(): Promise<PersonLite[]>;
  createPerson(fullName: string): Promise<PersonLite>;
  getGrants(profileId: string): Promise<Grant[]>;
  /** Reemplaza los permisos de la persona: una regla horaria para el conjunto de puertas. */
  saveGrants(profileId: string, deviceIds: string[], rule: ScheduleRule): Promise<void>;
  /** Añade acceso a una puerta SIN tocar los demás permisos (24/7). */
  grantDoor(profileId: string, deviceId: string): Promise<void>;

  listPasses(): Promise<GuestPass[]>;
  subscribePasses(cb: () => void): Unsub;
  createPass(input: NewPassInput): Promise<PassSecret>;
  /** Regenera link y PIN (el link anterior deja de funcionar). */
  rotatePass(passId: string, pin?: string): Promise<PassSecret>;
  /** Revocación inmediata. */
  revokePass(passId: string): Promise<void>;

  unlock(deviceCode: string): Promise<{ commandId: string }>;
  waitCommand(commandId: string, timeoutMs: number): Promise<CommandStatus>;
  deviceControl(deviceCode: string, action: DeviceAction, minutes?: number): Promise<void>;

  enrollStart(deviceCode: string, kind: CredentialKind): Promise<EnrollmentSession>;
  enrollCancel(sessionId: string): Promise<void>;
  subscribeEnrollment(sessionId: string, cb: (s: EnrollmentSession) => void): Unsub;
}
