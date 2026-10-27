// deno test tests/functions/crypto_test.ts
// Garantiza que Edge Functions, firmware (mbedTLS) y tools/provision.mjs derivan y firman igual.
import { createHash, createHmac } from 'node:crypto';
import { assert, assertEquals } from 'jsr:@std/assert@1.0.13';
import {
  canonical, deriveApiKey, deriveCmdKey, safeEqual, sha256Hex, signCommand,
} from '../../supabase/functions/_shared/crypto.ts';

const MASTER = 'a'.repeat(64);
// Mismo algoritmo que firmware/tools/provision.mjs
const ref = (purpose: string, code: string, v: number) => createHmac('sha256', MASTER).update(`${purpose}|${code}|${v}`).digest('hex');

Deno.test('derivación de claves = provision.mjs', async () => {
  assertEquals(await deriveCmdKey(MASTER, 'puerta01x', 1), ref('cmd', 'puerta01x', 1));
  assertEquals(await deriveApiKey(MASTER, 'puerta01x', 1), ref('api', 'puerta01x', 1));
  assert((await deriveCmdKey(MASTER, 'puerta01x', 2)) !== (await deriveCmdKey(MASTER, 'puerta01x', 1)), 'rotar key_version cambia la clave');
});

Deno.test('firma de comando = la que verifica el ESP32', async () => {
  const key = await deriveCmdKey(MASTER, 'puerta01x', 1);
  const body = { v: 1 as const, id: '6f1c2a7e-0000-4000-8000-000000000001', cmd: 'unlock', arg: '3000', iat: 1766000000, exp: 1766000008 };
  assertEquals(canonical(body), '6f1c2a7e-0000-4000-8000-000000000001|unlock|3000|1766000000|1766000008');
  // El ESP32 usa la clave HEX como bytes ASCII (strlen(DEVICE_CMD_KEY)) y compara hex en minúsculas.
  const expected = createHmac('sha256', Buffer.from(key, 'ascii')).update(canonical(body)).digest('hex');
  assertEquals((await signCommand(key, body)).sig, expected);
});

Deno.test('sha256 y comparación en tiempo constante', async () => {
  assertEquals(await sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
  assert(safeEqual('ab', 'ab'));
  assert(!safeEqual('ab', 'ac'));
  assert(!safeEqual('ab', 'abc'));
});
