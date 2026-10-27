// Verificador estático de integración: cruza nombres entre SQL, Edge Functions, web y firmware.
// Falla (exit 1) si algo no coincide. Ejecutar:  cd tests && npm run test:integration
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p, exts);
  return exts.some((x) => e.name.endsWith(x)) ? [p] : [];
});
const all = (re, s) => [...s.matchAll(re)];

let errors = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { errors++; console.log('FAIL', msg); } };

// ---------------------------------------------------------------- SQL
const migFiles = walk('supabase/migrations', ['.sql']).sort();
const sql = migFiles.map(read).join('\n');

const tables = {};                       // tabla -> Set(columnas)
const fks = [];                          // {from, col, to, name}
const SKIP = new Set(['check', 'unique', 'primary', 'constraint', 'foreign', 'exclude']);
for (const m of all(/create table public\.(\w+) \(([\s\S]*?)\n\);/g, sql)) {
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const c = line.match(/^\s+(\w+)\s+([\w.]+)/);
    if (!c || SKIP.has(c[1].toLowerCase())) continue;
    cols.add(c[1]);
    const r = line.match(/references public\.(\w+)/);
    if (r) fks.push({ from: m[1], col: c[1], to: r[1], name: `${m[1]}_${c[1]}_fkey` });
  }
  tables[m[1]] = cols;
}
for (const m of all(/alter table public\.(\w+)\s+([\s\S]*?);/g, sql)) {
  for (const c of all(/add column (\w+)/g, m[2])) tables[m[1]]?.add(c[1]);
  const fk = m[2].match(/add constraint (\w+)\s+foreign key \((\w+)\) references public\.(\w+)/);
  if (fk) fks.push({ from: m[1], col: fk[2], to: fk[3], name: fk[1] });
}

const fnSigs = {};                       // última definición gana
for (const m of all(/create (?:or replace )?function public\.(\w+)\(([\s\S]*?)\)\s*returns/g, sql))
  fnSigs[m[1]] = new Set(all(/(p_\w+)\s/g, m[2]).map((x) => x[1]));

const enumVals = (name) => {
  const base = sql.match(new RegExp(`create type public\\.${name}\\s+as enum \\(([\\s\\S]*?)\\);`));
  const vals = new Set(base ? all(/'(\w+)'/g, base[1]).map((x) => x[1]) : []);
  for (const m of all(new RegExp(`alter type public\\.${name}\\s+add value if not exists '(\\w+)'`, 'g'), sql)) vals.add(m[1]);
  return vals;
};
const commandTypes = enumVals('command_type');
const denyReasons = enumVals('deny_reason');

const realtime = new Set();
const pubArr = sql.match(/foreach t in array array\[([^\]]*)\]/);
if (pubArr) all(/'(\w+)'/g, pubArr[1]).forEach((x) => realtime.add(x[1]));
all(/tablename = '(\w+)'\) then\s+alter publication supabase_realtime add table public\.\w+/g, sql).forEach((x) => realtime.add(x[1]));

ok(Object.keys(tables).length >= 15, `se esperaban ≥15 tablas, encontradas ${Object.keys(tables).length}`);

// ---------------------------------------------------------------- PostgREST: .from('tabla')…  (web + funciones)
const codeFiles = [...walk('web/src', ['.ts', '.tsx']), ...walk('supabase/functions', ['.ts'])];

function splitTop(s) {               // separa por comas de primer nivel
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Claves de primer nivel de un objeto literal que empieza justo después de '{' en `s[start]`. */
function topLevelKeys(s, start) {
  const keys = []; let depth = 0, token = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && ch === ':' && /^\s*[,\s]*(\w+)\s*$/.test(token)) keys.push(token.match(/(\w+)\s*$/)[1]);
    if (depth === 0 && ch === ',') token = ''; else if (depth === 0 && ch !== ':') token += ch; else if (ch === ':') token = '';
  }
  return keys;
}

function checkSelect(table, sel, where) {
  for (let item of splitTop(sel)) {
    if (item === '*') continue;
    const emb = item.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s);
    if (emb) {
      const [, , target, hint, inner] = emb;
      ok(tables[target], `${where}: embed a tabla inexistente '${target}'`);
      if (!tables[target]) continue;
      const rels = fks.filter((f) => (f.from === table && f.to === target) || (f.from === target && f.to === table));
      if (hint) ok(rels.some((f) => f.name === hint), `${where}: la FK '${hint}' no existe entre ${table} y ${target}`);
      else ok(rels.length === 1, `${where}: embed ${table}→${target} ${rels.length ? 'AMBIGUO (' + rels.map((f) => f.name).join(', ') + '): usa !fk' : 'sin relación'}`);
      checkSelect(target, inner, where);
      continue;
    }
    const col = item.replace(/^\w+:/, '').replace(/::\w+$/, '').trim();
    ok(tables[table].has(col), `${where}: columna '${table}.${col}' no existe`);
  }
}

for (const f of codeFiles) {
  const src = read(f);
  for (const m of all(/\.from\('(\w+)'\)/g, src)) {
    const table = m[1];
    const where = `${f}:${src.slice(0, m.index).split('\n').length}`;
    ok(tables[table], `${where}: tabla '${table}' no existe`);
    if (!tables[table]) continue;
    // la cadena termina en ';', en una línea en blanco o en el siguiente .from(
    const rest = src.slice(m.index);
    const ends = [rest.indexOf(';'), rest.indexOf('\n\n'), rest.indexOf('.from(', 1)].filter((i) => i > 0);
    const stmt = rest.slice(0, Math.min(...ends));
    for (const s of all(/\.select\('([^']*)'/g, stmt)) checkSelect(table, s[1], where);
    for (const s of all(/\.(?:eq|neq|lt|lte|gt|gte|in|not|order|is)\('(\w+)'/g, stmt))
      ok(tables[table].has(s[1]), `${where}: filtro sobre columna inexistente '${table}.${s[1]}'`);
    for (const s of all(/\.(?:update|insert|upsert)\(\{/g, stmt))
      for (const k of topLevelKeys(stmt, s.index + s[0].length)) ok(tables[table].has(k), `${where}: escribe columna inexistente '${table}.${k}'`);
    for (const s of all(/onConflict: '([\w,]+)'/g, stmt))
      s[1].split(',').forEach((c) => ok(tables[table].has(c), `${where}: onConflict con columna inexistente '${c}'`));
  }
  // RPC: función y nombres de parámetros
  for (const m of all(/\.rpc\('(\w+)'(?:,\s*\{([\s\S]*?)\}\s*\))?/g, src)) {
    const where = `${f}:${src.slice(0, m.index).split('\n').length}`;
    ok(fnSigs[m[1]], `${where}: RPC '${m[1]}' no existe en las migraciones`);
    if (fnSigs[m[1]] && m[2]) for (const k of all(/(p_\w+)\s*:/g, m[2])) ok(fnSigs[m[1]].has(k[1]), `${where}: '${m[1]}' no tiene parámetro '${k[1]}'`);
  }
  // Realtime: tablas suscritas deben estar en la publicación
  for (const m of all(/table: '(\w+)'/g, src)) ok(realtime.has(m[1]), `${f}: Realtime sobre '${m[1]}' pero no está en supabase_realtime`);
}

// ---------------------------------------------------------------- Edge Functions invocadas por la web
const fnDirs = fs.readdirSync(path.join(ROOT, 'supabase/functions'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
const webSrc = walk('web/src', ['.ts', '.tsx']).map(read).join('\n');
const invoked = new Set([...all(/call<[^>]*>\('([\w-]+)'/g, webSrc), ...all(/call\('([\w-]+)'/g, webSrc), ...all(/functions\/v1\/([\w-]+)/g, webSrc)].map((x) => x[1]));
for (const n of invoked) ok(fnDirs.includes(n), `la web invoca la función '${n}' que no existe en supabase/functions`);

// ---------------------------------------------------------------- MQTT, mensajes y comandos (Edge ↔ firmware)
const mqttTs = read('supabase/functions/_shared/mqtt.ts');
const netCpp = read('firmware/src/net.cpp');
const ingest = read('supabase/functions/device-ingest/index.ts');
ok(mqttTs.includes('`acc/v1/${dev.device_code}/cmd`'), 'Edge: tópico de comandos distinto de acc/v1/<code>/cmd');
ok(netCpp.includes('"acc/v1/%s/cmd"'), 'Firmware: no se suscribe a acc/v1/<code>/cmd');
ok(netCpp.includes('"acc/v1/%s/status"'), 'Firmware: no publica acc/v1/<code>/status');
ok(read('supabase/functions/_shared/crypto.ts').includes('`${c.id}|${c.cmd}|${c.arg}|${c.iat}|${c.exp}`') && netCpp.includes('"%s|%s|%s|%lu|%lu", id, cmd, arg'),
  'La cadena firmada (id|cmd|arg|iat|exp) no coincide entre Edge y firmware');

const cmdTypes = new Set(all(/'(\w+)'/g, mqttTs.match(/export type CmdType = ([^;]+);/)[1]).map((x) => x[1]));
const fwCmds = new Set(all(/cmd == "(\w+)"/g, netCpp).map((x) => x[1]));
for (const c of cmdTypes) {
  ok(fwCmds.has(c), `el firmware no maneja el comando '${c}'`);
  ok(commandTypes.has(c), `command_type (SQL) no tiene '${c}'`);
}
const webActions = all(/'(\w+)'/g, read('web/src/lib/types.ts').match(/export type DeviceAction = ([^;]+);/)[1]).map((x) => x[1]);
for (const a of webActions) ok(cmdTypes.has(a), `la web usa la acción '${a}' que no es un CmdType`);

const ingestTypes = new Set(all(/case '(\w+)'/g, ingest).map((x) => x[1]));
for (const m of all(/req\["type"\] = "(\w+)"/g, netCpp)) ok(ingestTypes.has(m[1]), `el firmware envía type '${m[1]}' que device-ingest no maneja`);

// claves de respuesta que lee el firmware deben existir en el servidor
const serverText = sql + ingest;
for (const m of new Set(all(/res\["(\w+)"\]/g, netCpp).map((x) => x[1])))
  ok(serverText.includes(`'${m}'`) || new RegExp(`\\b${m}\\s*:`).test(ingest), `el firmware lee res["${m}"] pero el servidor no lo envía`);
// claves que envía el firmware y lee device-ingest
for (const m of new Set(all(/req\["(\w+)"\]/g, netCpp).map((x) => x[1]).filter((k) => k !== 'type' && k !== 'events')))
  ok(ingest.includes(`body.${m}`), `el firmware envía "${m}" pero device-ingest no lo lee`);

// motivos de denegación del firmware deben existir en el enum
const cacheCpp = read('firmware/src/cache.cpp');
for (const m of new Set(all(/\*reason = "(\w+)"/g, cacheCpp).map((x) => x[1]))) ok(denyReasons.has(m), `el firmware usa el motivo '${m}' que no está en deny_reason`);

// ---------------------------------------------------------------- Variables de entorno y despliegue
const injected = new Set(['SUPABASE_URL', 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY']);
const envExample = read('supabase/.env.example');
const fnSrc = walk('supabase/functions', ['.ts']).map(read).join('\n');
for (const m of new Set(all(/Deno\.env\.get\('(\w+)'\)/g, fnSrc).map((x) => x[1])))
  ok(injected.has(m) || new RegExp(`^${m}=`, 'm').test(envExample), `la variable '${m}' no está en supabase/.env.example`);

const webEnvExample = read('web/.env.example');
const deployYml = read('.github/workflows/deploy.yml');
for (const m of new Set(all(/import\.meta\.env\.(VITE_\w+)/g, webSrc).map((x) => x[1]).filter((v) => v !== 'VITE_DEMO'))) {
  ok(new RegExp(`^${m}=`, 'm').test(webEnvExample), `'${m}' no está en web/.env.example`);
  ok(deployYml.includes(`${m}: \${{ vars.${m} }}`), `'${m}' no se pasa al build en .github/workflows/deploy.yml`);
}

const configToml = read('supabase/config.toml');
const noJwt = new Set(all(/\[functions\.([\w-]+)\]\s*\nverify_jwt = false/g, configToml).map((x) => x[1]));
const deploySb = read('.github/workflows/deploy-supabase.yml');
const deployed = new Set(all(/functions deploy ([\w\s-]+?) --project-ref/g, deploySb).flatMap((x) => x[1].trim().split(/\s+/)));
const deployedNoJwt = new Set((deploySb.match(/functions deploy ([\w\s-]+?) --project-ref "\$PROJECT_REF" --no-verify-jwt/)?.[1] ?? '').trim().split(/\s+/));
for (const d of fnDirs) ok(deployed.has(d), `la función '${d}' no se despliega en deploy-supabase.yml`);
for (const d of ['pass', 'device-ingest']) {
  ok(noJwt.has(d), `config.toml: '${d}' debe tener verify_jwt = false`);
  ok(deployedNoJwt.has(d), `deploy-supabase.yml: '${d}' debe desplegarse con --no-verify-jwt`);
}
for (const d of deployedNoJwt) ok(noJwt.has(d), `'${d}' se despliega sin JWT pero config.toml no lo declara`);

const secretsEx = read('firmware/include/secrets.example.h');
const fwSrc = walk('firmware/src', ['.cpp']).map(read).join('\n');
for (const m of all(/#define (\w+)\s/g, secretsEx)) ok(new RegExp(`\\b${m[1]}\\b`).test(fwSrc), `secrets.example.h define ${m[1]} pero el firmware no lo usa`);

console.log(errors ? `\n${errors} INCOHERENCIAS en ${checks} comprobaciones` : `\nIntegración OK (${checks} comprobaciones)`);
process.exit(errors ? 1 : 0);
