import mqtt from 'npm:mqtt@5.10.1';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { deriveCmdKey, signCommand, type CommandBody } from './crypto.ts';

export type CmdType = 'unlock' | 'hold_open' | 'release' | 'lockdown_on' | 'lockdown_off' | 'enroll_start' | 'enroll_cancel';

export interface DeviceRef { id: string; device_code: string; key_version: number }

/**
 * Registra el comando en device_commands, lo firma y lo publica por MQTT (QoS 1).
 * Lanza error si el broker no acepta el mensaje (la fila queda `failed`).
 * El ESP32 confirma con un ACK HTTPS que pasa la fila a `acked`.
 */
export async function sendCommand(db: SupabaseClient, dev: DeviceRef, type: CmdType, opts: {
  arg?: string | number; issuedBy?: string | null; accessLogId?: number | null; ttlSec?: number;
} = {}): Promise<{ commandId: string }> {
  const master = Deno.env.get('DEVICE_MASTER_KEY');
  if (!master) throw new Error('DEVICE_MASTER_KEY no configurada');

  const ttl = opts.ttlSec ?? 10;
  const iat = Math.floor(Date.now() / 1000);
  const body: CommandBody = { v: 1, id: crypto.randomUUID(), cmd: type, arg: String(opts.arg ?? ''), iat, exp: iat + ttl };

  const { error: insErr } = await db.from('device_commands').insert({
    id: body.id, device_id: dev.id, type, payload: { arg: body.arg },
    issued_by: opts.issuedBy ?? null, access_log_id: opts.accessLogId ?? null,
    expires_at: new Date((iat + ttl) * 1000).toISOString(),
  });
  if (insErr) throw insErr;

  const signed = await signCommand(await deriveCmdKey(master, dev.device_code, dev.key_version), body);

  let client: mqtt.MqttClient | null = null;
  try {
    client = await mqtt.connectAsync(Deno.env.get('MQTT_URL')!, {
      username: Deno.env.get('MQTT_USERNAME'), password: Deno.env.get('MQTT_PASSWORD'),
      clientId: `edge-${crypto.randomUUID().slice(0, 8)}`, connectTimeout: 5000, reconnectPeriod: 0, clean: true,
      forceNativeWebSocket: true,   // WebSocket nativo de Deno (no depende del paquete `ws` de Node)
    });
    await client.publishAsync(`acc/v1/${dev.device_code}/cmd`, JSON.stringify(signed), { qos: 1, retain: false });
    // Solo si sigue 'pending': el ACK del ESP32 puede llegar ANTES que esta línea y no debe pisarse.
    await db.from('device_commands').update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', body.id).eq('status', 'pending');
  } catch (e) {
    await db.from('device_commands').update({ status: 'failed', error: String((e as Error).message ?? e).slice(0, 300) })
      .eq('id', body.id).eq('status', 'pending');
    throw e;
  } finally {
    try { await client?.endAsync(true); } catch { /* ignore */ }
  }
  return { commandId: body.id };
}

/** Espera el ACK del ESP32 (device_commands.status = acked). Devuelve el estado final. */
export async function waitForAck(db: SupabaseClient, commandId: string, timeoutMs: number): Promise<'acked' | 'failed' | 'expired' | 'timeout'> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { data } = await db.from('device_commands').select('status').eq('id', commandId).maybeSingle();
    if (data?.status === 'acked' || data?.status === 'failed' || data?.status === 'expired') return data.status;
    await new Promise((r) => setTimeout(r, 400));
  }
  return 'timeout';
}
