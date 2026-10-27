#!/usr/bin/env node
// Genera las claves de un dispositivo a partir de DEVICE_MASTER_KEY (las mismas que calculan las Edge Functions).
//   node tools/provision.mjs --master <hex64> --code puerta01x [--version 1]
// Rotar: sube devices.key_version en Supabase y vuelve a ejecutar con --version N.
import { createHmac } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));

const master = args.master ?? process.env.DEVICE_MASTER_KEY;
const code = args.code;
const version = Number(args.version ?? 1);

if (!master || !/^[a-z0-9]{6,32}$/.test(code ?? '') || !Number.isInteger(version) || version < 1) {
  console.error('Uso: node tools/provision.mjs --master <DEVICE_MASTER_KEY> --code <device_code> [--version 1]');
  process.exit(1);
}

const derive = (purpose) => createHmac('sha256', master).update(`${purpose}|${code}|${version}`).digest('hex');

console.log(`// ---- pegar en include/secrets.h (dispositivo ${code}, key_version ${version}) ----`);
console.log(`#define DEVICE_CODE    "${code}"`);
console.log(`#define DEVICE_API_KEY "${derive('api')}"`);
console.log(`#define DEVICE_CMD_KEY "${derive('cmd')}"`);
