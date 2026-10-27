// Criptografía pura (solo WebCrypto, sin APIs de Deno) para poder probarla en Node.
const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(message)));
}

/** Clave de comandos de un dispositivo, derivada de la clave maestra (nunca se guarda en la base). */
export const deriveCmdKey = (master: string, deviceCode: string, keyVersion: number) =>
  hmacHex(master, `cmd|${deviceCode}|${keyVersion}`);

/** Clave API (Bearer) del dispositivo para device-ingest (Fase siguiente). */
export const deriveApiKey = (master: string, deviceCode: string, keyVersion: number) =>
  hmacHex(master, `api|${deviceCode}|${keyVersion}`);

export interface CommandBody {
  v: 1;
  id: string;
  cmd: string;
  arg: string;
  iat: number;
  exp: number;
}

/** Cadena canónica firmada. El ESP32 debe reconstruirla EXACTAMENTE igual. */
export const canonical = (c: CommandBody) => `${c.id}|${c.cmd}|${c.arg}|${c.iat}|${c.exp}`;

export async function signCommand(cmdKey: string, body: CommandBody): Promise<CommandBody & { sig: string }> {
  return { ...body, sig: await hmacHex(cmdKey, canonical(body)) };
}

/** Comparación en tiempo constante de dos cadenas hex. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
