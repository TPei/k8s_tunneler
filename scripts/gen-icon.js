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

// Indicator dot colours (kept in sync with --green / --amber in styles.css).
const GREEN = [52, 199, 89];
const AMBER = [255, 159, 10];

// Draw the port-forward glyph. Options:
//   color: [r,g,b] for the arrows
//   dot:   [r,g,b] to paint an indicator dot of that colour in the corner
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
    // Indicator dot in the bottom-right corner, with a transparent gap so it
    // stays legible over the arrows on any menu-bar background.
    const dot = options.dot;
    const r = size * 0.28;
    const cx = size - r - 1;
    const cy = size - r - 1;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) put(x, y, dot, 255);
        else if (d <= r + 1.4) put(x, y, dot, 0); // clear ring for separation
      }
    }
  }

  return rgba;
}

// ---------------------------------------------------------------------------
// Full-colour application icon (build/icon.png -> .icns via electron-builder).
// Rendered with supersampling for smooth edges, then box-downsampled.
// ---------------------------------------------------------------------------
function drawAppIcon(finalSize, options = {}) {
  const ss = 4;
  const S = finalSize * ss;
  const big = Buffer.alloc(S * S * 4, 0);

  const put = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    big[i] = rgb[0];
    big[i + 1] = rgb[1];
    big[i + 2] = rgb[2];
    big[i + 3] = a;
  };

  // Rounded-rectangle squircle background with a vertical blue gradient.
  const margin = Math.round(S * 0.085);
  const x0 = margin;
  const y0 = margin;
  const x1 = S - margin;
  const y1 = S - margin;
  const radius = Math.round((x1 - x0) * 0.2237); // Apple-ish continuous corner
  const top = [42, 148, 255]; // #2a94ff
  const bottom = [0, 92, 214]; // #005cd6

  const insideRounded = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const rx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const ry = Math.min(Math.max(y, y0 + radius), y1 - radius);
    const dx = x - rx;
    const dy = y - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = y0; y <= y1; y += 1) {
    const tv = (y - y0) / (y1 - y0);
    const col = [
      Math.round(top[0] + (bottom[0] - top[0]) * tv),
      Math.round(top[1] + (bottom[1] - top[1]) * tv),
      Math.round(top[2] + (bottom[2] - top[2]) * tv),
    ];
    for (let x = x0; x <= x1; x += 1) {
      if (insideRounded(x, y)) put(x, y, col, 255);
    }
  }

  // White port-forward arrows glyph, centred.
  const white = [255, 255, 255];
  const cx = S / 2;
  const t = S * 0.058; // shaft thickness
  const headLen = S * 0.13;
  const half = t * 1.75;
  const left = S * 0.28;
  const right = S * 0.72;
  const topCy = S * 0.42;
  const botCy = S * 0.58;

  const rect = (ax0, ay0, ax1, ay1) => {
    for (let y = Math.round(ay0); y < Math.round(ay1); y += 1) {
      for (let x = Math.round(ax0); x < Math.round(ax1); x += 1) put(x, y, white, 255);
    }
  };
  const arrowHead = (tipX, ccy, len, hh, dir) => {
    for (let k = 0; k < len; k += 1) {
      const x = Math.round(tipX - dir * k);
      const h = Math.round((hh * (k + 1)) / len);
      for (let y = Math.round(ccy - h); y <= Math.round(ccy + h); y += 1) put(x, y, white, 255);
    }
  };

  // Top arrow -> right
  rect(left, topCy - t / 2, right - headLen * 0.4, topCy + t / 2);
  arrowHead(right, topCy, headLen, half, 1);
  // Bottom arrow -> left
  rect(left + headLen * 0.4, botCy - t / 2, right, botCy + t / 2);
  arrowHead(left, botCy, headLen, half, -1);

  if (options.dot) {
    // Indicator dot with a white separation ring, bottom-right.
    const dot = options.dot;
    const ring = [255, 255, 255];
    const r = S * 0.15;
    const dcx = x1 - r * 0.9;
    const dcy = y1 - r * 0.9;
    const outer = r + S * 0.022;
    for (let y = 0; y < S; y += 1) {
      for (let x = 0; x < S; x += 1) {
        const d = Math.hypot(x + 0.5 - dcx, y + 0.5 - dcy);
        if (d <= r) put(x, y, dot, 255);
        else if (d <= outer) put(x, y, ring, 255);
      }
    }
  }

  // Box downsample (premultiplied alpha) big -> finalSize.
  const out = Buffer.alloc(finalSize * finalSize * 4, 0);
  for (let y = 0; y < finalSize; y += 1) {
    for (let x = 0; x < finalSize; x += 1) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          const a = big[i + 3];
          ar += big[i] * a;
          ag += big[i + 1] * a;
          ab += big[i + 2] * a;
          aa += a;
        }
      }
      const o = (y * finalSize + x) * 4;
      const n = ss * ss;
      out[o + 3] = Math.round(aa / n);
      if (aa > 0) {
        out[o] = Math.round(ar / aa);
        out[o + 1] = Math.round(ag / aa);
        out[o + 2] = Math.round(ab / aa);
      }
    }
  }
  return out;
}

function main() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const buildDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const writePair = (name, options) => {
    fs.writeFileSync(
      path.join(assetsDir, `${name}.png`),
      encodePng(16, draw(16, options))
    );
    fs.writeFileSync(
      path.join(assetsDir, `${name}@2x.png`),
      encodePng(32, draw(32, options))
    );
  };

  // Idle: monochrome template icon (adapts to light/dark menu bar).
  writePair('trayTemplate', { color: [0, 0, 0] });
  // Active (non-template): black arrows for a light menu bar, white arrows for
  // a dark menu bar, both with the green indicator dot.
  writePair('trayActiveLight', { color: [0, 0, 0], dot: GREEN });
  writePair('trayActiveDark', { color: [255, 255, 255], dot: GREEN });
  // Connecting: same, with an amber dot (a forward is starting / reconnecting).
  writePair('trayConnectingLight', { color: [0, 0, 0], dot: AMBER });
  writePair('trayConnectingDark', { color: [255, 255, 255], dot: AMBER });

  // Application icon (1024x1024) for the packaged .app / .dmg / AppImage.
  fs.writeFileSync(
    path.join(buildDir, 'icon.png'),
    encodePng(1024, drawAppIcon(1024))
  );

  // Linux tray icons: colour icons (Linux panels do not support macOS template
  // auto-inversion), idle + active (green dot) + connecting (amber dot)
  // variants at 1x/2x.
  const writeAppIconPair = (name, options) => {
    fs.writeFileSync(
      path.join(assetsDir, `${name}.png`),
      encodePng(32, drawAppIcon(32, options))
    );
    fs.writeFileSync(
      path.join(assetsDir, `${name}@2x.png`),
      encodePng(64, drawAppIcon(64, options))
    );
  };
  writeAppIconPair('trayLinux', {});
  writeAppIconPair('trayLinuxActive', { dot: GREEN });
  writeAppIconPair('trayLinuxConnecting', { dot: AMBER });

  console.log(
    'Wrote tray icon assets (mac template + active/connecting variants, linux colour variants) and build/icon.png'
  );
}

if (require.main === module) main();

module.exports = { draw, drawAppIcon, encodePng, GREEN, AMBER };
