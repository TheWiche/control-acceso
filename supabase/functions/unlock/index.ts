// JWT de admin. Apertura remota desde el panel.
import { clientIp, handler, HttpError, requireRole, serviceClient } from '../_shared/common.ts';
import { sendCommand } from '../_shared/mqtt.ts';

const REASONS: Record<string, string> = {
  device_offline: 'La cerradura está desconectada', lockdown: 'Bloqueo total activo', device_inactive: 'La puerta está deshabilitada',
  device_unknown: 'Puerta desconocida', no_grant: 'No tienes permiso en esta puerta',
};

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const caller = await requireRole(req, db, ['admin']);
  const code = typeof body.device_code === 'string' ? body.device_code : '';

  const { data: r, error } = await db.rpc('fn_authorize_member_unlock', {
    p_profile_id: caller.id, p_device_code: code, p_method: 'remote_app', p_ip: clientIp(req), p_ua: req.headers.get('user-agent')?.slice(0, 200) ?? null,
  });
  if (error) throw error;
  if (!r.granted) throw new HttpError(409, REASONS[r.reason] ?? `Acceso denegado (${r.reason})`);

  const { data: dev } = await db.from('devices').select('id, device_code, key_version, unlock_ms').eq('id', r.device_id).single();
  if (!dev) throw new HttpError(404, 'Puerta no encontrada');
  try {
    const { commandId } = await sendCommand(db, dev, 'unlock', { arg: dev.unlock_ms, issuedBy: caller.id, accessLogId: r.log_id });
    return { ok: true, command_id: commandId };
  } catch (e) {
    console.error(e);
    throw new HttpError(502, 'No se pudo contactar al broker MQTT');
  }
}));
