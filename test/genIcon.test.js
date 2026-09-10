'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { draw, drawAppIcon, encodePng, GREEN, AMBER } = require('../scripts/gen-icon');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pixelAt(rgba, size, x, y) {
  const i = (y * size + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

/** Count fully opaque pixels of exactly this colour. */
function countColor(rgba, [r, g, b]) {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] === r && rgba[i + 1] === g && rgba[i + 2] === b && rgba[i + 3] === 255) n += 1;
  }
  return n;
}

describe('gen-icon colours', () => {
  test('GREEN / AMBER match the renderer palette', () => {
    assert.deepEqual(GREEN, [52, 199, 89]); // #34c759
    assert.deepEqual(AMBER, [255, 159, 10]); // #ff9f0a
  });
});

describe('draw (menu bar glyph)', () => {
  const size = 32;
  // Dot centre as computed in draw(): r = size*0.28, cx = cy = size - r - 1.
  const r = size * 0.28;
  const c = Math.floor(size - r - 1);

  test('idle icon has no indicator dot', () => {
    const rgba = draw(size, { color: [0, 0, 0] });
    assert.equal(countColor(rgba, GREEN), 0);
    assert.equal(countColor(rgba, AMBER), 0);
  });

  test('draws arrows in the requested colour', () => {
    const white = draw(size, { color: [255, 255, 255] });
    assert.ok(countColor(white, [255, 255, 255]) > 0);
    assert.equal(countColor(white, [0, 0, 0]), 0);
  });

  test('active variant has a green dot in the bottom-right', () => {
    const rgba = draw(size, { color: [0, 0, 0], dot: GREEN });
    assert.deepEqual(pixelAt(rgba, size, c, c), [...GREEN, 255]);
    assert.ok(countColor(rgba, GREEN) > 50);
    assert.equal(countColor(rgba, AMBER), 0);
  });

  test('connecting variant has an amber dot in the bottom-right', () => {
    const rgba = draw(size, { color: [255, 255, 255], dot: AMBER });
    assert.deepEqual(pixelAt(rgba, size, c, c), [...AMBER, 255]);
    assert.ok(countColor(rgba, AMBER) > 50);
    assert.equal(countColor(rgba, GREEN), 0);
  });

  test('dot has a transparent separation ring', () => {
    const rgba = draw(size, { color: [0, 0, 0], dot: GREEN });
    // Just outside the dot radius, on the diagonal towards the centre of the
    // icon, the pixel must be fully transparent.
    const off = Math.ceil((r + 0.7) / Math.SQRT2);
    const [, , , a] = pixelAt(rgba, size, c - off, c - off);
    assert.equal(a, 0);
  });
});

describe('drawAppIcon (colour app / Linux tray icon)', () => {
  const size = 32;

  test('has a blue background and white glyph, no dot when idle', () => {
    const rgba = drawAppIcon(size);
    assert.ok(countColor(rgba, [255, 255, 255]) > 0, 'white glyph pixels');
    assert.equal(countColor(rgba, GREEN), 0);
    assert.equal(countColor(rgba, AMBER), 0);
  });

  test('active / connecting variants carry the dot colour', () => {
    const active = drawAppIcon(size, { dot: GREEN });
    const connecting = drawAppIcon(size, { dot: AMBER });
    assert.ok(countColor(active, GREEN) > 20);
    assert.equal(countColor(active, AMBER), 0);
    assert.ok(countColor(connecting, AMBER) > 20);
    assert.equal(countColor(connecting, GREEN), 0);
  });

  test('corners outside the squircle are transparent', () => {
    const rgba = drawAppIcon(size);
    assert.equal(pixelAt(rgba, size, 0, 0)[3], 0);
    assert.equal(pixelAt(rgba, size, size - 1, size - 1)[3], 0);
  });
});

describe('encodePng', () => {
  test('produces a PNG with the right signature and dimensions', () => {
    const size = 16;
    const png = encodePng(size, draw(size, { color: [0, 0, 0] }));
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    // IHDR: length(4) type(4) then width/height as big-endian u32.
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
  });
});
