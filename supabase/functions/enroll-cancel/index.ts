// JWT de admin/operador. Cancela el modo registro.
import { handler, HttpError, requireRole, serviceClient } from '../_shared/common.ts';
import { sendCommand } from '../_shared/mqtt.ts';

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const caller = await requireRole(req, db, ['admin', 'operator']);
  const id = String(body.session_id ?? '');

  const { data: s } = await db.from('enrollment_sessions').select('id, device_id, status').eq('id', id).maybeSingle();
  if (!s) throw new HttpError(404, 'Sesión no encontrada');
  if (s.status !== 'waiting') return { ok: true };

  await db.from('enrollment_sessions').update({ status: 'cancelled' }).eq('id', id).eq('status', 'waiting');
  await db.from('device_state').update({ enroll_mode_until: null }).eq('device_id', s.device_id);

  const { data: dev } = await db.from('devices').select('id, device_code, key_version').eq('id', s.device_id).single();
  if (dev) await sendCommand(db, dev, 'enroll_cancel', { arg: id, issuedBy: caller.id, ttlSec: 15 }).catch((e) => console.error(e));
  return { ok: true };
}));
