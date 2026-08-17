// V1.8/V1.8.3 — src/cctv/collage.js: pure compositing engine tests. Uses
// the REAL @jsquash/jpeg WASM codecs (via test/testJpegCodec.js's
// Node-compatible loader — see that file's module comment) — no mocking
// of decode/encode — since this module has zero TDX/KV/fetch
// dependencies of its own; every test here is a real JPEG round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeQuadrantCollage,
  COLLAGE_WIDTH,
  COLLAGE_HEIGHT,
  HEADER_HEIGHT,
  CELL_WIDTH,
  CELL_HEIGHT,
  IMAGE_AREA_HEIGHT,
} from '../src/cctv/collage.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';
import { drawText } from '../src/cctv/bitmapFont.js';

async function makeSolidJpeg(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  const encoded = await encodeJpeg({ data, width, height }, { quality: 85 });
  return new Uint8Array(encoded);
}

// Sample point near the top-left of a quadrant's image area — clear of
// the centered placeholder text, and safe for any solid-color test photo.
function sampleImageAreaPixel(decoded, quadrantIndex) {
  const col = quadrantIndex % 2;
  const row = Math.floor(quadrantIndex / 2);
  const x = col * CELL_WIDTH + 20;
  const y = HEADER_HEIGHT + row * CELL_HEIGHT + 20;
  const idx = (y * decoded.width + x) * 4;
  return [decoded.data[idx], decoded.data[idx + 1], decoded.data[idx + 2]];
}

function closeTo(actual, expected, tolerance = 20) {
  return Math.abs(actual - expected) <= tolerance;
}

function assertColorClose(actual, expected, label) {
  assert.ok(
    closeTo(actual[0], expected[0]) && closeTo(actual[1], expected[1]) && closeTo(actual[2], expected[2]),
    `${label}: expected ~${expected}, got ${actual}`
  );
}

const RED = [200, 60, 60];
const GREEN = [60, 160, 60];
const BLUE = [60, 60, 200];
const YELLOW = [200, 200, 60];
const EMPTY_TILE_BG = [70, 74, 82];
const FAILED_TILE_BG = [92, 40, 40];

function baseCell(overrides) {
  return { slotLabel: 'X', locationLabel: null, distanceLabel: null, jpegBytes: null, status: 'empty', ...overrides };
}

// --- 1. all 4 succeed -> a single valid collage ---

test('1. all 4 quadrants succeed -> produces exactly 1 collage JPEG', async () => {
  const cells = [
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, RED) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, GREEN) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, BLUE) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, YELLOW) }),
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, true);
  assert.equal(result.filledCount, 4);
  assert.equal(result.contentType, 'image/jpeg');
  const bytes = new Uint8Array(result.bytes);
  assert.equal(bytes[0], 0xff); // JPEG SOI marker
  assert.equal(bytes[1], 0xd8);
});

// --- 2. fixed positions: S前 top-left / S後 top-right / N前 bottom-left / N後 bottom-right ---

test('2. quadrants render in the fixed ratified order: index0=top-left, index1=top-right, index2=bottom-left, index3=bottom-right', async () => {
  const cells = [
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, RED) }), // S前
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, GREEN) }), // S後
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, BLUE) }), // N前
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, YELLOW) }), // N後
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, true);
  const decoded = await decodeJpeg(new Uint8Array(result.bytes));
  assert.equal(decoded.width, COLLAGE_WIDTH);
  assert.equal(decoded.height, COLLAGE_HEIGHT);

  assertColorClose(sampleImageAreaPixel(decoded, 0), RED, 'index0 (top-left, S前)');
  assertColorClose(sampleImageAreaPixel(decoded, 1), GREEN, 'index1 (top-right, S後)');
  assertColorClose(sampleImageAreaPixel(decoded, 2), BLUE, 'index2 (bottom-left, N前)');
  assertColorClose(sampleImageAreaPixel(decoded, 3), YELLOW, 'index3 (bottom-right, N後)');
});

// --- 3. one failure -> the rest still succeed, failed cell shows a placeholder ---

test('3. one quadrant failed -> the other 3 still render; the failed cell shows the "暫無畫面" placeholder', async () => {
  const cells = [
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, RED) }),
    baseCell({ status: 'failed', locationLabel: '85K+500', distanceLabel: '3.40KM' }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, BLUE) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, YELLOW) }),
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, true);
  assert.equal(result.filledCount, 3);
  const decoded = await decodeJpeg(new Uint8Array(result.bytes));
  assertColorClose(sampleImageAreaPixel(decoded, 0), RED, 'index0 still renders');
  assertColorClose(sampleImageAreaPixel(decoded, 1), FAILED_TILE_BG, 'index1 shows the failed-tile background');
  assertColorClose(sampleImageAreaPixel(decoded, 2), BLUE, 'index2 still renders');
  assertColorClose(sampleImageAreaPixel(decoded, 3), YELLOW, 'index3 still renders');
});

// --- 4. quadrant = null (empty) -> "NO CAMERA" placeholder, visually distinct from a failure ---

test('4. an empty quadrant (no candidate) shows the distinct "無符合鏡頭" placeholder background', async () => {
  const cells = [
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, RED) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, GREEN) }),
    baseCell({ status: 'empty' }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, YELLOW) }),
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, true);
  assert.equal(result.filledCount, 3);
  const decoded = await decodeJpeg(new Uint8Array(result.bytes));
  assertColorClose(sampleImageAreaPixel(decoded, 2), EMPTY_TILE_BG, 'index2 shows the empty-tile background');
  // Empty (no camera) and failed (no signal) must use visually distinct backgrounds.
  assert.notDeepEqual(EMPTY_TILE_BG, FAILED_TILE_BG);
});

// --- 5. all 4 fail/empty -> no fake collage ---

test('5. all 4 quadrants empty or failed -> ok:false, no image produced', async () => {
  const cells = [baseCell({ status: 'empty' }), baseCell({ status: 'failed' }), baseCell({ status: 'empty' }), baseCell({ status: 'failed' })];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-frames');
  assert.equal(result.filledCount, 0);
  assert.equal(result.bytes, undefined);
});

// --- 6. malformed input never throws ---

test('6. a cells array that is not exactly length 4 is rejected without throwing', async () => {
  const result = await composeQuadrantCollage([baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(10, 10, RED) })], { decodeJpeg, encodeJpeg });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-cells');
});

// --- 7. a corrupt/undecodable JPEG in one slot degrades to a placeholder, not a thrown error ---

test('7. an undecodable jpegBytes value degrades that one cell to a placeholder instead of throwing', async () => {
  const cells = [
    baseCell({ status: 'ok', jpegBytes: new Uint8Array([0xff, 0xd8, 1, 2, 3]) }), // not a real JPEG
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(200, 150, GREEN) }),
    baseCell({ status: 'empty' }),
    baseCell({ status: 'empty' }),
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, true);
  const decoded = await decodeJpeg(new Uint8Array(result.bytes));
  assertColorClose(sampleImageAreaPixel(decoded, 0), FAILED_TILE_BG, 'undecodable frame degrades to the failed-tile placeholder');
  assertColorClose(sampleImageAreaPixel(decoded, 1), GREEN, 'the other good frame still renders');
});

// --- 7b. regression: 4 fetched OK but 0 decode successfully -> no fake collage ---
//
// Root-caused post-review: filledCount was originally computed from
// fetch status alone, BEFORE decode was ever attempted — so "4 fetched
// OK, 4 undecodable" could still return ok:true/filledCount:4 with a
// collage that was actually 4 "NO SIGNAL" placeholders wearing a JPEG
// extension. composeQuadrantCollage must gate on REAL decode success
// (successfulDecodedFrames), never on fetch status.

test('7b. regression: all 4 candidates fetched OK but ALL 4 fail to decode -> ok:false, no collage produced (not a fake all-placeholder image)', async () => {
  const notActuallyJpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3]); // has the SOI marker but is not a real JPEG
  const cells = [
    baseCell({ status: 'ok', jpegBytes: notActuallyJpeg }),
    baseCell({ status: 'ok', jpegBytes: notActuallyJpeg }),
    baseCell({ status: 'ok', jpegBytes: notActuallyJpeg }),
    baseCell({ status: 'ok', jpegBytes: notActuallyJpeg }),
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-frames');
  assert.equal(result.filledCount, 0);
  assert.equal(result.bytes, undefined);
});

// --- 8. output size stays well under the <=5MB guideline ---

test('8. a full 4-photo collage stays well under the 5MB guideline', async () => {
  const cells = [
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(640, 480, RED) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(640, 480, GREEN) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(640, 480, BLUE) }),
    baseCell({ status: 'ok', jpegBytes: await makeSolidJpeg(640, 480, YELLOW) }),
  ];
  const result = await composeQuadrantCollage(cells, { decodeJpeg, encodeJpeg, titleLine: 'T', subtitleLine: 'S' });
  assert.equal(result.ok, true);
  assert.ok(result.bytes.byteLength < 5 * 1024 * 1024, `expected < 5MB, got ${result.bytes.byteLength} bytes`);
});

// --- 9. regression: bitmapFont.drawText must never silently misplace pixels on a fractional y ---
//
// Root-caused during V1.8 development: `idx = (py * canvasWidth + px) * 4`
// can land on a perfectly valid INTEGER idx even when py itself is
// fractional (e.g. py = N.5 with an even canvasWidth, since
// 0.5 * canvasWidth is then itself a whole number) — silently wrapping
// the write into a totally different row/column instead of throwing or
// no-op'ing. drawText must round x/y internally so no caller can trigger
// this by passing a fractional coordinate.
test('9. regression: drawText with a fractional y renders in the correct column, not silently wrapped', async () => {
  const width = 1200;
  const height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 235;
    data[i * 4 + 1] = 236;
    data[i * 4 + 2] = 240;
    data[i * 4 + 3] = 255;
  }
  // Intentionally fractional y (mirrors collage.js's own placeholder
  // label math, which can end in .5). '8' is a digit glyph (present in
  // the V1.8.3 font's ASCII16 table) — any glyph with at least one lit
  // pixel works for this test.
  drawText(data, width, height, '8', 900, 100.5, 4, [255, 0, 0, 255]);

  // The glyph must land in the RIGHT half (x >= 600) — never wrap into
  // the left half the way the pre-fix bug did.
  let litPixelInRightHalf = false;
  let litPixelInLeftHalf = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      if (data[idx] === 255 && data[idx + 1] === 0 && data[idx + 2] === 0) {
        if (x >= 600) litPixelInRightHalf = true;
        else litPixelInLeftHalf = true;
      }
    }
  }
  assert.equal(litPixelInRightHalf, true, 'expected the glyph to render in the right half');
  assert.equal(litPixelInLeftHalf, false, 'the glyph must never wrap into the left half');
});

// --- 10. V1.8.3: every CJK glyph this round's display text actually
// uses must render as a real shape — never a blank box, never silently
// dropped. This is the automatable half of "中文 glyph 不可出現空白方塊
// 或亂碼" (a rendered "garbled" glyph isn't something a pixel-count
// assertion alone can rule out — that was verified visually, by
// rendering the real proof sheet and the real mixed-text strings this
// round produces and inspecting them — but "did every character
// actually draw SOMETHING, and is no two characters drawing the exact
// same shape" is directly testable and is exactly what this covers).

test('10. every CJK character used by V1.8.3 display text renders a non-blank, distinct glyph', async () => {
  const { drawText: draw } = await import('../src/cctv/bitmapFont.js');
  // The exact closed character set this round's display text needs:
  // title ("國1 …附近監視畫面"), quadrant labels (南前/南後/北前/北後),
  // the combined info line ("距事故 … 公里"), and the two placeholders
  // (無符合鏡頭 / 暫無畫面).
  const REQUIRED_CHARS = '國附近監視畫面更新南前後北距事故公里無符合鏡頭暫'.split('');
  assert.equal(REQUIRED_CHARS.length, 24, 'sanity check on the required character count');

  const shapes = new Map();
  for (const ch of REQUIRED_CHARS) {
    const width = 16;
    const height = 16;
    const data = new Uint8ClampedArray(width * height * 4);
    draw(data, width, height, ch, 0, 0, 1, [255, 255, 255, 255]);
    let litCount = 0;
    let signature = '';
    for (let i = 0; i < width * height; i += 1) {
      const lit = data[i * 4] === 255 ? '1' : '0';
      signature += lit;
      if (lit === '1') litCount += 1;
    }
    assert.ok(litCount > 0, `character "${ch}" rendered as a completely blank box`);
    // A real 16x16 CJK glyph should have a reasonable amount of ink —
    // catches a glyph that's accidentally almost-empty (e.g. a single
    // stray pixel from a typo) without requiring exact stroke fidelity.
    assert.ok(litCount >= 8, `character "${ch}" rendered suspiciously few pixels (${litCount}) — likely a broken glyph`);
    if (shapes.has(signature)) {
      assert.fail(`character "${ch}" renders IDENTICALLY to "${shapes.get(signature)}" — glyphs must be visually distinct`);
    }
    shapes.set(signature, ch);
  }
});
