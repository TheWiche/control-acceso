// PÚBLICA (sin JWT): la usan los invitados. Se despliega con --no-verify-jwt.
// La seguridad NO depende del navegador: token de 128 bits + PIN (bcrypt, 5 intentos -> bloqueo 15 min),
// rate limit por IP y por token, y TODA la decisión (vigencia, horario, usos, revocación) en SQL atómico.
import { clientIp, handler, HttpError, rateLimit, serviceClient } from '../_shared/common.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { sendCommand, waitForAck } from '../_shared/mqtt.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const ip = clientIp(req);
  const ua = req.headers.get('user-agent')?.slice(0, 200) ?? null;
  const action = body.action;
  const token = typeof body.token === 'string' ? body.token : '';

  if (!TOKEN_RE.test(token)) return { ok: true, status: 'invalid' };

  // Frena el barrido de tokens y el spam, ANTES de tocar la lógica de pases (y sin escribir logs).
  if (!(await rateLimit(db, `pass-ip:${ip ?? 'x'}`, 60, '5 minutes'))) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
  const tokenHash = await sha256Hex(token);

  if (action === 'preview') {
    const { data, error } = await db.rpc('fn_pass_preview', { p_token: token, p_ip: ip, p_ua: ua });
    if (error) throw error;
    return { ok: true, ...data };
  }

  if (action === 'redeem') {
    const pin = typeof body.pin === 'string' ? body.pin : '';
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
    if (!/^[0-9]{4,8}$/.test(pin)) throw new HttpError(400, 'PIN inválido');
    if (!/^[a-z0-9]{6,32}$/.test(deviceCode)) throw new HttpError(400, 'Puerta inválida');
    if (!(await rateLimit(db, `pass-tok:${tokenHash}`, 12, '10 minutes'))) throw new HttpError(429, 'Demasiados intentos con este acceso. Espera unos minutos.');

    const { data: r, error } = await db.rpc('fn_authorize_pass', { p_token: token, p_pin: pin, p_device_code: deviceCode, p_ip: ip, p_ua: ua });
    if (error) throw error;

    if (!r.granted) {
      let attemptsLeft: number | undefined;
      if (r.reason === 'pin_invalid') {
        const { data: s } = await db.from('guest_pass_secrets').select('failed_attempts').eq('token_hash', tokenHash).maybeSingle();
        attemptsLeft = Math.max(0, 5 - (s?.failed_attempts ?? 0));
      }
      return { ok: true, granted: false, reason: r.reason, attempts_left: attemptsLeft };
    }

    // Autorizado: publica el comando firmado y espera la confirmación física de la cerradura.
    const { data: dev } = await db.from('devices').select('id, device_code, key_version, unlock_ms').eq('id', r.device_id).single();
    if (!dev) throw new HttpError(500, 'Dispositivo no encontrado');

    let commandId: string;
    try {
      ({ commandId } = await sendCommand(db, dev, 'unlock', { arg: dev.unlock_ms, accessLogId: r.log_id, ttlSec: 8 }));
    } catch (e) {
      console.error('MQTT publish falló', e);
      await db.rpc('fn_refund_pass_use', { p_log_id: r.log_id });
      return { ok: true, granted: false, reason: 'device_unreachable' };
    }

    // exp = 8 s: pasado ese plazo el ESP32 rechaza el comando, así que devolver el uso es seguro.
    const ack = await waitForAck(db, commandId, 10_000);
    if (ack !== 'acked') {
      await db.rpc('fn_refund_pass_use', { p_log_id: r.log_id });
      return { ok: true, granted: false, reason: 'door_no_response' };
    }
    return { ok: true, granted: true, unlock_ms: r.unlock_ms, uses_left: r.uses_left, guest: r.guest };
  }

  throw new HttpError(400, 'Acción desconocida');
}));
