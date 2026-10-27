// JWT de admin. Pone el lector en modo registro durante 60 s.
import { handler, HttpError, requireRole, serviceClient } from '../_shared/common.ts';
import { sendCommand } from '../_shared/mqtt.ts';

const KINDS = ['rfid_card', 'nfc_keyfob', 'other'];

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const caller = await requireRole(req, db, ['admin', 'operator']);
  const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : 'rfid_card';

  const { data: dev } = await db.from('devices').select('id, device_code, key_version, is_active')
    .eq('device_code', String(body.device_code ?? '')).maybeSingle();
  if (!dev || !dev.is_active) throw new HttpError(404, 'Puerta no encontrada o deshabilitada');
  const { data: st } = await db.from('device_state').select('is_online').eq('device_id', dev.id).maybeSingle();
  if (!st?.is_online) throw new HttpError(409, 'El lector está desconectado');

  // libera sesiones vencidas (el índice único permite una sola "waiting" por dispositivo)
  await db.from('enrollment_sessions').update({ status: 'expired' })
    .eq('device_id', dev.id).eq('status', 'waiting').lt('expires_at', new Date().toISOString());

  const expires = new Date(Date.now() + 60_000).toISOString();
  const { data: session, error } = await db.from('enrollment_sessions')
    .insert({ device_id: dev.id, requested_by: caller.id, kind, expires_at: expires })
    .select('id, device_id, status, expires_at, captured_uid, credential_id, error').single();
  if (error) throw new HttpError(409, 'Ya hay un registro en curso en esta puerta');

  await db.from('device_state').update({ enroll_mode_until: expires }).eq('device_id', dev.id);
  try {
    await sendCommand(db, dev, 'enroll_start', { arg: session.id, issuedBy: caller.id, ttlSec: 15 });
  } catch (e) {
    console.error(e);
    await db.from('enrollment_sessions').update({ status: 'cancelled', error: 'broker_unreachable' }).eq('id', session.id);
    await db.from('device_state').update({ enroll_mode_until: null }).eq('device_id', dev.id);
    throw new HttpError(502, 'No se pudo contactar al broker MQTT');
  }
  return { ok: true, session };
}));
