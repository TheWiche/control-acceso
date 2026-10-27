// Endpoint HTTPS del ESP32 (sin JWT; se despliega con --no-verify-jwt).
// Autenticación: cabeceras  x-device-code: <code>  +  Authorization: Bearer <api_key>
//   api_key = HMAC-SHA256(DEVICE_MASTER_KEY, "api|<code>|<key_version>")  — se calcula aquí, nunca se guarda.
//
// Tipos (campo "type" del JSON):
//   heartbeat  {ip, rssi, lock_state, door_closed, fw, uptime, heap, mqtt}
//   access     {uid}                         -> decisión online (autoritativa)
//   enroll_read{session_id, uid}
//   ack        {command_id, ok, error?}
//   events     {events:[{kind:'access'|'exit_button', uid?, granted, reason?, ts}]}   (cola offline, máx. 50)
//   allowlist  {}                            -> lista blanca para la caché offline
import { clientIp, handler, HttpError, serviceClient } from '../_shared/common.ts';
import { deriveApiKey, safeEqual } from '../_shared/crypto.ts';

const LOCK_STATES = ['locked', 'unlocked', 'unknown'];
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 64) => (typeof v === 'string' ? v.slice(0, max) : null);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const isUid = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Fa-f:]{8,29}$/.test(v);
const ipv4 = (v: unknown) => (typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : null);

/** epoch (s) enviado por el ESP32 -> ISO. Si no hay hora válida, ahora. El SQL lo acota a [-7 días, ahora]. */
const tsIso = (v: unknown) => {
  const n = num(v);
  return n && n > 1_600_000_000 ? new Date(n * 1000).toISOString() : new Date().toISOString();
};

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const master = Deno.env.get('DEVICE_MASTER_KEY');
  if (!master) throw new HttpError(500, 'Servidor sin DEVICE_MASTER_KEY');

  // ---------- autenticación del dispositivo ----------
  const code = req.headers.get('x-device-code') ?? '';
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!/^[a-z0-9]{6,32}$/.test(code) || !bearer) throw new HttpError(401, 'unauthorized');
  const { data: dev } = await db.from('devices').select('id, key_version, is_active').eq('device_code', code).maybeSingle();
  // misma respuesta para "no existe" y "clave mala": no revela qué códigos existen
  if (!dev || !safeEqual(bearer, await deriveApiKey(master, code, dev.key_version))) throw new HttpError(401, 'unauthorized');

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw error;
    return data;
  };

  switch (body.type) {
    case 'heartbeat': {
      const hb = await rpc('fn_device_heartbeat', {
        p_device_code: code, p_ip: ipv4(body.ip), p_rssi: num(body.rssi),
        p_lock_state: LOCK_STATES.includes(String(body.lock_state)) ? body.lock_state : 'unknown',
        p_door_closed: typeof body.door_closed === 'boolean' ? body.door_closed : null,
        p_firmware: str(body.fw, 32), p_uptime: num(body.uptime), p_free_heap: num(body.heap),
        p_mqtt: typeof body.mqtt === 'boolean' ? body.mqtt : null,
      });
      const version = await rpc('fn_device_allowlist_version', { p_device_code: code });
      return { ...hb, allowlist_version: version };
    }

    case 'access': {
      if (!isUid(body.uid)) throw new HttpError(400, 'uid inválido');
      const r = await rpc('fn_authorize_credential', { p_device_code: code, p_uid: body.uid, p_ip: clientIp(req) });
      return { ok: true, granted: r.granted, reason: r.reason, name: r.name, unlock_ms: r.unlock_ms };
    }

    case 'enroll_read': {
      if (!isUuid(body.session_id) || !isUid(body.uid)) throw new HttpError(400, 'datos inválidos');
      return await rpc('fn_enroll_capture', { p_device_code: code, p_session_id: body.session_id, p_uid: body.uid });
    }

    case 'ack': {
      if (!isUuid(body.command_id)) throw new HttpError(400, 'command_id inválido');
      const ok = await rpc('fn_device_ack', {
        p_device_code: code, p_command_id: body.command_id, p_ok: body.ok !== false, p_error: str(body.error, 300),
      });
      return { ok: true, updated: ok };
    }

    case 'events': {
      const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
      let stored = 0;
      for (const e of events as Record<string, unknown>[]) {
        const kind = e.kind === 'exit_button' ? 'exit_button' : e.kind === 'access' ? 'access' : null;
        if (!kind || (kind === 'access' && !isUid(e.uid))) continue;
        await rpc('fn_log_device_event', {
          p_device_code: code, p_kind: kind, p_uid: kind === 'access' ? e.uid : null,
          p_granted: e.granted === true, p_reason: str(e.reason, 40), p_occurred_at: tsIso(e.ts),
        });
        stored++;
      }
      return { ok: true, stored };
    }

    case 'allowlist':
      return await rpc('fn_device_allowlist', { p_device_code: code });

    default:
      throw new HttpError(400, 'type desconocido');
  }
}));
