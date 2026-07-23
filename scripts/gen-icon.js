'use strict';

// Dependency-free generator for the monochrome menu-bar (template) icon.
// Draws two opposing horizontal arrows (a "port-forward" glyph) in black with
// alpha, which macOS renders correctly as a template image.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw image data with a filter byte (0) per scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = 0;
    rgba[i + 1] = 0;
    rgba[i + 2] = 0;
    rgba[i + 3] = Math.max(rgba[i + 3], a);
  };
  const rect = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0); y < Math.round(y1); y += 1) {
      for (let x = Math.round(x0); x < Math.round(x1); x += 1) set(x, y, 255);
    }
  };
  // filled triangle arrowhead. dir: +1 points right, -1 points left
  const arrowHead = (tipX, cy, len, half, dir) => {
    for (let k = 0; k < len; k += 1) {
      const x = tipX - dir * k;
      const h = Math.round((half * (k + 1)) / len);
      for (let y = cy - h; y <= cy + h; y += 1) set(x, Math.round(y), 255);
    }
  };

  const t = Math.max(2, Math.round(size * 0.12)); // bar thickness
  const margin = Math.round(size * 0.16);
  const headLen = Math.round(size * 0.24);
  const half = Math.round(t * 1.6);

  const topCy = Math.round(size * 0.36);
  const botCy = Math.round(size * 0.64);

  // Top arrow -> points right
  rect(margin, topCy - t / 2, size - margin - headLen * 0.4, topCy + t / 2);
  arrowHead(size - margin, topCy, headLen, half, 1);

  // Bottom arrow -> points left
  rect(margin + headLen * 0.4, botCy - t / 2, size - margin, botCy + t / 2);
  arrowHead(margin, botCy, headLen, half, -1);

  return rgba;
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

fs.writeFileSync(path.join(assetsDir, 'trayTemplate.png'), encodePng(16, draw(16)));
fs.writeFileSync(
  path.join(assetsDir, 'trayTemplate@2x.png'),
  encodePng(32, draw(32))
);

console.log('Wrote assets/trayTemplate.png and assets/trayTemplate@2x.png');
