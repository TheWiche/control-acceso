// JWT de admin. Bloqueo total y "mantener abierta".
// El estado se guarda en la base (autoritativo): el ESP32 lo recibe en cada latido aunque el MQTT falle.
// Por eso la base se actualiza ANTES de publicar el comando: un latido nunca devuelve un estado más viejo.
import { handler, HttpError, requireRole, serviceClient } from '../_shared/common.ts';
import { sendCommand, type CmdType } from '../_shared/mqtt.ts';

const ACTIONS = ['lockdown_on', 'lockdown_off', 'hold_open', 'release'] as const;
const HOLD_MIN_S = 5;
const HOLD_MAX_S = 4 * 3600;

/** Duración pedida en segundos. Acepta `minutes` (panel anterior, aún en caché en algunos móviles). */
function holdSeconds(body: Record<string, unknown>): number {
  const s = body.seconds !== undefined ? Number(body.seconds) : Number(body.minutes) * 60;
  if (!Number.isInteger(s) || s < HOLD_MIN_S || s > HOLD_MAX_S) {
    throw new HttpError(400, `Duración inválida (${HOLD_MIN_S} s a ${HOLD_MAX_S / 3600} h)`);
  }
  return s;
}

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const caller = await requireRole(req, db, ['admin']);
  const action = body.action as (typeof ACTIONS)[number];
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Acción inválida');

  const { data: dev } = await db.from('devices').select('id, device_code, key_version, lockdown, device_state(is_online)')
    .eq('device_code', String(body.device_code ?? '')).maybeSingle();
  if (!dev) throw new HttpError(404, 'Puerta no encontrada');
  const st = Array.isArray(dev.device_state) ? dev.device_state[0] : dev.device_state;

  let arg = '';
  let holdUntil: string | null = null;
  const patch: Record<string, unknown> = {};
  if (action === 'lockdown_on') { patch.lockdown = true; patch.hold_open_until = null; }   // el bloqueo anula "mantener abierta"
  if (action === 'lockdown_off') patch.lockdown = false;
  if (action === 'release') patch.hold_open_until = null;
  if (action === 'hold_open') {
    if (dev.lockdown) throw new HttpError(409, 'Quita primero el bloqueo total');
    // Si la cerradura no está conectada, la puerta se abriría sola al volver la conexión: se rechaza.
    if (!st?.is_online) throw new HttpError(409, 'La cerradura está desconectada');
    const untilEpoch = Math.floor(Date.now() / 1000) + holdSeconds(body);
    holdUntil = new Date(untilEpoch * 1000).toISOString();
    patch.hold_open_until = holdUntil;
    arg = String(untilEpoch);   // hora absoluta de cierre (epoch, s): la misma que guarda la base
  }
  const { error } = await db.from('devices').update(patch).eq('id', dev.id);
  if (error) throw error;

  try {
    await sendCommand(db, dev, action as CmdType, { arg, issuedBy: caller.id, ttlSec: 30 });
    return { ok: true, delivered: true, hold_open_until: holdUntil };
  } catch (e) {
    console.error(e);
    return { ok: true, delivered: false, hold_open_until: holdUntil }; // el dispositivo lo aplicará en su próximo latido
  }
}));
