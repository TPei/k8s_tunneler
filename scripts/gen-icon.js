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

// Draw the port-forward glyph. Options:
//   color: [r,g,b] for the arrows
//   dot:   when true, paint a green "active" indicator in the corner
function draw(size, options = {}) {
  const color = options.color || [0, 0, 0];
  const rgba = Buffer.alloc(size * size * 4, 0);
  const put = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = rgb[0];
    rgba[i + 1] = rgb[1];
    rgba[i + 2] = rgb[2];
    rgba[i + 3] = a;
  };
  const set = (x, y) => put(x, y, color, 255);
  const rect = (x0, y0, x1, y1) => {
    for (let y = Math.round(y0); y < Math.round(y1); y += 1) {
      for (let x = Math.round(x0); x < Math.round(x1); x += 1) set(x, y);
    }
  };
  // filled triangle arrowhead. dir: +1 points right, -1 points left
  const arrowHead = (tipX, cy, len, half, dir) => {
    for (let k = 0; k < len; k += 1) {
      const x = tipX - dir * k;
      const h = Math.round((half * (k + 1)) / len);
      for (let y = cy - h; y <= cy + h; y += 1) set(x, Math.round(y));
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

  if (options.dot) {
    // Green "active" dot in the bottom-right corner, with a transparent gap so
    // it stays legible over the arrows on any menu-bar background.
    const green = [52, 199, 89];
    const r = size * 0.28;
    const cx = size - r - 1;
    const cy = size - r - 1;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) put(x, y, green, 255);
        else if (d <= r + 1.4) put(x, y, green, 0); // clear ring for separation
      }
    }
  }

  return rgba;
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

function writePair(name, options) {
  fs.writeFileSync(
    path.join(assetsDir, `${name}.png`),
    encodePng(16, draw(16, options))
  );
  fs.writeFileSync(
    path.join(assetsDir, `${name}@2x.png`),
    encodePng(32, draw(32, options))
  );
}

// Idle: monochrome template icon (adapts to light/dark menu bar).
writePair('trayTemplate', { color: [0, 0, 0] });
// Active (non-template): black arrows for a light menu bar, white arrows for a
// dark menu bar, both with the green indicator dot.
writePair('trayActiveLight', { color: [0, 0, 0], dot: true });
writePair('trayActiveDark', { color: [255, 255, 255], dot: true });

console.log('Wrote tray icon assets (template + active light/dark variants)');
