// Generates desktop/icons/icon.ico (+ icon-256.png) without any dependency:
// a dark rounded tile with a 3x3 grid of LED dots. PNG encoded by hand
// (zlib from Node), wrapped in an ICO container (PNG entries are valid ICO).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x, y); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// tile: dark background, rounded corners, 3x3 dots green/blue/amber like the grid's status colours
function pixel(size) {
  const r = size * 0.18, dots = [[0x3f, 0xb9, 0x50], [0x58, 0xa6, 0xff], [0x3f, 0xb9, 0x50], [0x58, 0xa6, 0xff], [0xd2, 0x99, 0x22], [0x58, 0xa6, 0xff], [0x3f, 0xb9, 0x50], [0x58, 0xa6, 0xff], [0x3f, 0xb9, 0x50]];
  return (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r), cy = Math.min(Math.max(y, r), size - 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    const cell = size / 3.6, off = (size - 3 * cell) / 2;
    for (let i = 0; i < 9; i++) {
      const dx = off + (i % 3) * cell + cell / 2 - x, dy = off + Math.floor(i / 3) * cell + cell / 2 - y;
      const rr = cell * 0.32;
      if (dx * dx + dy * dy <= rr * rr) return [...dots[i], 255];
    }
    return [0x17, 0x1b, 0x22, 255];
  };
}
const out = path.join(__dirname, '..', 'desktop', 'icons');
fs.mkdirSync(out, { recursive: true });
const sizes = [16, 32, 48, 256];
const pngs = sizes.map(s => png(s, pixel(s)));
fs.writeFileSync(path.join(out, 'icon-256.png'), pngs[3]);
// ICO: header + directory entries + PNG blobs
const hdr = Buffer.alloc(6); hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length; const entries = [];
sizes.forEach((s, i) => { const e = Buffer.alloc(16); e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e[2] = 0; e[3] = 0; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length; entries.push(e); });
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([hdr, ...entries, ...pngs]));
// 1024x1024 source: `cargo tauri icon` generates the full cross-platform set
// from this (ico multi-size, icns, various png — icns generation is pure
// Rust in Tauri v2, works from Windows, no Mac needed for that step).
fs.writeFileSync(path.join(out, 'icon-source.png'), png(1024, pixel(1024)));
console.log('icons written to', out);
