// JWT de admin. Bloqueo total y "mantener abierta".
// El estado se guarda en la base (autoritativo): el ESP32 lo recibe en cada latido aunque el MQTT falle.
import { handler, HttpError, requireRole, serviceClient } from '../_shared/common.ts';
import { sendCommand, type CmdType } from '../_shared/mqtt.ts';

const ACTIONS = ['lockdown_on', 'lockdown_off', 'hold_open', 'release'] as const;

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const caller = await requireRole(req, db, ['admin']);
  const action = body.action as (typeof ACTIONS)[number];
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Acción inválida');

  const { data: dev } = await db.from('devices').select('id, device_code, key_version')
    .eq('device_code', String(body.device_code ?? '')).maybeSingle();
  if (!dev) throw new HttpError(404, 'Puerta no encontrada');

  let minutes = 0;
  const patch: Record<string, unknown> = {};
  if (action === 'lockdown_on') patch.lockdown = true;
  if (action === 'lockdown_off') patch.lockdown = false;
  if (action === 'release') patch.hold_open_until = null;
  if (action === 'hold_open') {
    minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new HttpError(400, 'Minutos inválidos (1-240)');
    patch.hold_open_until = new Date(Date.now() + minutes * 60_000).toISOString();
  }
  const { error } = await db.from('devices').update(patch).eq('id', dev.id);
  if (error) throw error;

  try {
    await sendCommand(db, dev, action as CmdType, { arg: minutes || '', issuedBy: caller.id, ttlSec: 30 });
    return { ok: true, delivered: true };
  } catch (e) {
    console.error(e);
    return { ok: true, delivered: false }; // el dispositivo lo aplicará en su próximo latido
  }
}));
