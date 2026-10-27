import type { GuestPass } from './types';

/** Pases simulados (con su token y PIN en claro, solo en modo demo). Compartido entre demoApi y guestApi. */
export interface DemoPass extends GuestPass { token: string; pin: string; failed: number }

const h = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();
const base = { guest_phone: null, allowed_days: null, time_start: null, time_end: null, revoked_at: null, last_used_at: null, device_ids: ['d1'] };

export const demoPasses: DemoPass[] = [
  { ...base, id: 'g1', label: 'Plomero · Pedro', token: 'demo-activo-00000000001', pin: '123456', failed: 0, valid_from: h(-2), valid_until: h(30), max_uses: null, uses_count: 3, status: 'active', created_at: h(-3) },
  { ...base, id: 'g2', label: 'Visita · Sofía', token: 'demo-un-uso-00000000001', pin: '4821', failed: 0, valid_from: h(-1), valid_until: h(8), max_uses: 1, uses_count: 0, status: 'active', created_at: h(-1) },
  { ...base, id: 'g3', label: 'Limpieza semanal', token: 'demo-horario-0000000001', pin: '654321', failed: 0, valid_from: h(-72), valid_until: h(24 * 60), max_uses: null, uses_count: 11, status: 'active', created_at: h(-72), allowed_days: [2, 4], time_start: '09:00', time_end: '13:00' },
  { ...base, id: 'g4', label: 'Fiesta · DJ', token: 'demo-expirado-000000001', pin: '111222', failed: 0, valid_from: h(-48), valid_until: h(-2), max_uses: null, uses_count: 2, status: 'active', created_at: h(-50) },
  { ...base, id: 'g5', label: 'Ex inquilino', token: 'demo-revocado-000000001', pin: '999888', failed: 0, valid_from: h(-100), valid_until: h(100), max_uses: null, uses_count: 8, status: 'revoked', revoked_at: h(-5), created_at: h(-100) },
  { ...base, id: 'g6', label: 'Paquetería', token: 'demo-agotado-0000000001', pin: '246810', failed: 0, valid_from: h(-6), valid_until: h(6), max_uses: 1, uses_count: 1, status: 'active', created_at: h(-6) },
];
