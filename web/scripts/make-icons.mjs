// Genera icon-192/512 y apple-touch-icon (PNG) sin dependencias: dibuja con matemática de píxeles.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

function png(size, { radius }) {
  const px = Buffer.alloc(size * size * 4);
  const u = size / 64;
  const inRR = (x, y, x0, y0, w, h, r) => { const cx = Math.min(Math.max(x, x0 + r), x0 + w - r), cy = Math.min(Math.max(y, y0 + r), y0 + h - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h; };
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5) / u, y = (j + 0.5) / u;
    let col = [143, 220, 190, 255];
    if (radius && !inRR(x, y, 0, 0, 64, 64, radius)) col = [0, 0, 0, 0];
    else {
      const ink = [21, 32, 30, 255], lav = [143, 220, 190, 255];
      const body = inRR(x, y, 17, 28, 30, 22, 5);
      const d = Math.hypot(x - 32, y - 22);
      const shackle = y <= 28 && d >= 6.5 && d <= 11.5 && y <= 28.5;
      const hole = Math.hypot(x - 32, y - 38) <= 3.4 || inRR(x, y, 30.5, 38, 3, 7, 1.5);
      if (body || shackle) col = ink;
      if (body && hole) col = lav;
    }
    px.set(col, (j * size + i) * 4);
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) { raw[j * (size * 4 + 1)] = 0; px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// iOS aplica su propia máscara redondeada => apple-touch-icon e iconos "maskable" van a sangre (radius 0).
writeFileSync('public/icon-192.png', png(192, { radius: 14 }));
writeFileSync('public/icon-512.png', png(512, { radius: 0 }));
writeFileSync('public/apple-touch-icon.png', png(180, { radius: 0 }));
console.log('iconos generados');
