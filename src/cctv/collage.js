// V1.8 — CCTV 四宮格事故播報: composes the 4 fixed-quadrant CCTV frames
// (see tdx/hsinchuCctvProbe.js's V1.7 four-quadrant selector,
// PROJECT_HANDOFF.md section 14) into a single 2x2 collage JPEG.
//
// Deliberately pure: this module never touches TDX, KV, or `fetch` at
// all — it only turns already-fetched JPEG bytes (or the absence of
// them) into one composited image. All I/O (reading the candidates KV,
// fetching each CCTV's frame) stays in tdx/hsinchuCctvProbe.js's
// handleHsinchuCctvCollage, exactly like the existing per-candidate
// frame endpoint. JPEG decode/encode is injected via `decodeJpeg`/
// `encodeJpeg` (see cctv/jpegCodec.js) rather than imported directly
// here, so this module has zero WASM-loading concerns of its own and is
// trivially unit-testable.
//
// Fixed layout — top-left/top-right/bottom-left/bottom-right MUST stay
// S前/S後/N前/N後 in that order; this is the ratified V1.7 rule, not a
// display choice (PROJECT_HANDOFF.md section 14: "不可修改").
//
//   ┌────────────┬────────────┐
//   │   S前      │   S後      │   index 0        index 1
//   ├────────────┼────────────┤
//   │   N前      │   N後      │   index 2        index 3
//   └────────────┴────────────┘
//
// A quadrant with no candidate (the ratified rule's "leave it empty")
// renders as an explicit "無符合鏡頭" placeholder tile; a candidate whose
// frame fetch failed (timeout, too-large, etc.) renders as "暫無畫面" —
// visually distinct states, matching the frame endpoint's own
// null-vs-failed distinction. One or more successful frames is enough to
// produce a valid collage; only when ALL 4 quadrants have no image at
// all does this module report `ok: false` — see composeQuadrantCollage's
// doc comment.
//
// V1.8.3 — labels are Traditional Chinese, per instruction ("讓計程車／
// 營業車司機在 LINE 上一眼就看懂"). See bitmapFont.js's module comment
// for the CJK glyph set and why it's hand-authored rather than a
// font-rasterization pipeline.

import { drawText, measureText, LINE_HEIGHT } from './bitmapFont.js';

export const COLLAGE_WIDTH = 1200;
export const COLLAGE_HEIGHT = 900;
// Exported for tests — lets test code compute exact per-quadrant sample
// coordinates from the real layout instead of duplicating magic numbers.
// Sized for the larger 16px-tall CJK/digit glyphs (vs. the old 7px-tall
// ASCII-only font) — both HEADER_HEIGHT and LABEL_HEIGHT grew from V1.8
// to keep the bigger text comfortably spaced, per instruction ("標題文
// 字不要太小").
export const HEADER_HEIGHT = 100;
export const CELL_WIDTH = COLLAGE_WIDTH / 2; // 600
export const CELL_HEIGHT = (COLLAGE_HEIGHT - HEADER_HEIGHT) / 2; // 400
const LABEL_HEIGHT = 110;
export const IMAGE_AREA_HEIGHT = CELL_HEIGHT - LABEL_HEIGHT; // 290

// Fixed quadrant grid positions, index-aligned with the V1.7 four-
// quadrant candidate order [S前, S後, N前, N後] — never reordered.
const QUADRANT_POSITIONS = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 },
];

const COLOR = {
  headerBg: [20, 24, 32, 255],
  headerTitle: [255, 255, 255, 255],
  headerSubtitle: [190, 200, 215, 255],
  pageBg: [235, 236, 240, 255],
  gridLine: [235, 236, 240, 255],
  labelBg: [20, 24, 32, 255],
  labelText: [255, 255, 255, 255],
  labelSubtext: [170, 205, 255, 255],
  emptyTileBg: [70, 74, 82, 255],
  emptyTileText: [200, 205, 212, 255],
  failedTileBg: [92, 40, 40, 255],
  failedTileText: [255, 190, 190, 255],
};

function fillRect(pixels, canvasWidth, canvasHeight, x, y, w, h, color) {
  const [r, g, b, a = 255] = color;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvasWidth, x + w);
  const y1 = Math.min(canvasHeight, y + h);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const idx = (py * canvasWidth + px) * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = a;
    }
  }
}

function drawTextCentered(pixels, canvasWidth, canvasHeight, text, centerX, y, scale, color) {
  const width = measureText(text, scale);
  drawText(pixels, canvasWidth, canvasHeight, text, Math.round(centerX - width / 2), y, scale, color);
}

/**
 * Nearest-neighbor "cover" blit: scales `src` (an ImageData-shaped
 * {data,width,height}) so it entirely fills the destination box
 * (boxWidth x boxHeight), cropping any excess on whichever axis
 * overflows, and centers the crop — the same visual behavior as CSS
 * `object-fit: cover`. Nearest-neighbor (not bilinear) is a deliberate
 * simplicity/CPU tradeoff: this is a small diagnostic thumbnail grid,
 * not a photo-quality render, and nearest-neighbor is more than
 * sufficient at these sizes while keeping the per-request CPU cost low.
 */
function drawImageCover(destPixels, destWidth, destHeight, destX, destY, boxWidth, boxHeight, src) {
  if (!src || !src.width || !src.height) return;
  const scale = Math.max(boxWidth / src.width, boxHeight / src.height);
  const scaledWidth = src.width * scale;
  const scaledHeight = src.height * scale;
  const cropX = (scaledWidth - boxWidth) / 2;
  const cropY = (scaledHeight - boxHeight) / 2;

  for (let py = 0; py < boxHeight; py += 1) {
    const srcY = Math.min(src.height - 1, Math.max(0, Math.floor((py + cropY) / scale)));
    const destPy = destY + py;
    if (destPy < 0 || destPy >= destHeight) continue;
    for (let px = 0; px < boxWidth; px += 1) {
      const srcX = Math.min(src.width - 1, Math.max(0, Math.floor((px + cropX) / scale)));
      const destPx = destX + px;
      if (destPx < 0 || destPx >= destWidth) continue;
      const srcIdx = (srcY * src.width + srcX) * 4;
      const destIdx = (destPy * destWidth + destPx) * 4;
      destPixels[destIdx] = src.data[srcIdx];
      destPixels[destIdx + 1] = src.data[srcIdx + 1];
      destPixels[destIdx + 2] = src.data[srcIdx + 2];
      destPixels[destIdx + 3] = 255;
    }
  }
}

function drawPlaceholderTile(pixels, canvasWidth, canvasHeight, x, y, w, h, label, isFailure) {
  fillRect(pixels, canvasWidth, canvasHeight, x, y, w, h, isFailure ? COLOR.failedTileBg : COLOR.emptyTileBg);
  drawTextCentered(pixels, canvasWidth, canvasHeight, label, x + w / 2, y + h / 2 - Math.round((LINE_HEIGHT * 3) / 2), 3, isFailure ? COLOR.failedTileText : COLOR.emptyTileText);
}

/**
 * @param {Array<{
 *   slotLabel: string,          // e.g. '南前' — fixed per quadrant, Traditional Chinese
 *   locationLabel: string|null, // e.g. '82K+900' — null when the quadrant has no candidate
 *   distanceLabel: string|null, // e.g. '0.800' — just the number, 3 decimals; null when unavailable
 *   jpegBytes: Uint8Array|ArrayBuffer|null,
 *   status: 'ok'|'empty'|'failed',
 * }>} cells - EXACTLY 4 entries, index-aligned [S前, S後, N前, N後]. A
 *   'status' of 'empty' means the quadrant had no candidate at all (the
 *   ratified rule's "leave it empty"); 'failed' means a candidate
 *   existed but its frame fetch/extract failed (timeout, too-large,
 *   etc.); 'ok' requires jpegBytes to be present.
 * @param {{
 *   decodeJpeg: (bytes: Uint8Array) => Promise<{data:Uint8ClampedArray,width:number,height:number}>,
 *   encodeJpeg: (imageData: {data:Uint8ClampedArray,width:number,height:number}, options?: object) => Promise<ArrayBuffer>,
 *   titleLine: string,
 *   subtitleLine: string,
 *   quality?: number,
 * }} options
 * @returns {Promise<{ok:true, bytes:ArrayBuffer, contentType:'image/jpeg', filledCount:number}|{ok:false, reason:'no-frames', filledCount:0}|{ok:false, reason:'invalid-cells'}>}
 */
export async function composeQuadrantCollage(cells, options) {
  if (!Array.isArray(cells) || cells.length !== 4) {
    return { ok: false, reason: 'invalid-cells' };
  }
  const { decodeJpeg, encodeJpeg, titleLine = '', subtitleLine = '', quality = 85 } = options;

  // Cheap pre-check on fetch status alone, BEFORE touching decodeJpeg at
  // all — lets a caller with nothing fetched skip loading/providing a
  // codec entirely (see hsinchuCctvProbe.js's lazy production-codec
  // loading). This is NOT the final filledCount: a cell can fetch fine
  // and still fail to decode, and that must not count as "filled" —
  // see successfulDecodedFrames below, which is the real source of
  // truth for whether a usable collage was produced.
  const anyFetchedOk = cells.some((c) => c.status === 'ok' && c.jpegBytes);
  if (!anyFetchedOk) {
    return { ok: false, reason: 'no-frames', filledCount: 0 };
  }

  const pixels = new Uint8ClampedArray(COLLAGE_WIDTH * COLLAGE_HEIGHT * 4);
  fillRect(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, 0, 0, COLLAGE_WIDTH, COLLAGE_HEIGHT, COLOR.pageBg);

  // Header. Title at scale 3 (48px-tall glyphs) — deliberately large,
  // per instruction ("標題文字不要太小") — subtitle at scale 2 (32px).
  fillRect(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, 0, 0, COLLAGE_WIDTH, HEADER_HEIGHT, COLOR.headerBg);
  drawText(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, titleLine, 16, 10, 3, COLOR.headerTitle);
  drawText(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, subtitleLine, 16, 60, 2, COLOR.headerSubtitle);

  // The real source of truth for "how many quadrants actually produced
  // a usable image" — counted only when decode (AND the subsequent
  // draw) genuinely succeeds, never from fetch status alone. A cell can
  // fetch a 200 response that isn't actually a valid/decodable JPEG;
  // that must render as a "暫無畫面" placeholder and must NOT count
  // toward filledCount, exactly like an outright fetch failure.
  let successfulDecodedFrames = 0;

  for (let i = 0; i < 4; i += 1) {
    const cell = cells[i];
    const { col, row } = QUADRANT_POSITIONS[i];
    const cellX = col * CELL_WIDTH;
    const cellY = HEADER_HEIGHT + row * CELL_HEIGHT;
    const imageY = cellY;
    const labelY = cellY + IMAGE_AREA_HEIGHT;

    if (cell.status === 'ok' && cell.jpegBytes) {
      try {
        const bytes = cell.jpegBytes instanceof Uint8Array ? cell.jpegBytes : new Uint8Array(cell.jpegBytes);
        const decoded = await decodeJpeg(bytes);
        drawImageCover(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, cellX, imageY, CELL_WIDTH, IMAGE_AREA_HEIGHT, decoded);
        successfulDecodedFrames += 1;
      } catch {
        // A frame that fetched OK but fails to decode is treated the
        // same as a fetch failure — never lets one bad JPEG break the
        // whole collage (see module comment: 1-4 successes still
        // produce a valid collage) — but it does NOT count toward
        // successfulDecodedFrames.
        drawPlaceholderTile(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, cellX, imageY, CELL_WIDTH, IMAGE_AREA_HEIGHT, '暫無畫面', true);
      }
    } else if (cell.status === 'failed') {
      drawPlaceholderTile(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, cellX, imageY, CELL_WIDTH, IMAGE_AREA_HEIGHT, '暫無畫面', true);
    } else {
      drawPlaceholderTile(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, cellX, imageY, CELL_WIDTH, IMAGE_AREA_HEIGHT, '無符合鏡頭', false);
    }

    // Label bar. Quadrant name (南前/南後/北前/北後) at scale 3, one
    // combined info line "82K+900 / 距事故 0.800 公里" at scale 2 below
    // it — a single line per instruction ("避免塞太多資訊"), not the
    // separate location/distance lines V1.8 originally used.
    fillRect(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, cellX, labelY, CELL_WIDTH, LABEL_HEIGHT, COLOR.labelBg);
    drawText(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, cell.slotLabel, cellX + 14, labelY + 6, 3, COLOR.labelText);
    if (cell.locationLabel) {
      const infoLine = cell.distanceLabel ? `${cell.locationLabel} / 距事故 ${cell.distanceLabel} 公里` : cell.locationLabel;
      drawText(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, infoLine, cellX + 14, labelY + 62, 2, COLOR.labelSubtext);
    }
  }

  // Only now — after actually attempting to decode every fetched frame
  // — do we know whether this is a real collage or 4 placeholders
  // wearing a JPEG extension. All 4 candidates fetching a 200 response
  // that turns out to be undecodable must behave exactly like all 4
  // fetches failing outright: no image, reason 'no-frames'. Never
  // encode/return a collage built entirely from placeholders.
  if (successfulDecodedFrames === 0) {
    return { ok: false, reason: 'no-frames', filledCount: 0 };
  }

  // Thin separators between the 4 cells (and around the outer edge) so
  // adjacent photos of differing brightness don't visually bleed together.
  const SEP = 3;
  fillRect(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, CELL_WIDTH - Math.floor(SEP / 2), HEADER_HEIGHT, SEP, COLLAGE_HEIGHT - HEADER_HEIGHT, COLOR.gridLine);
  fillRect(pixels, COLLAGE_WIDTH, COLLAGE_HEIGHT, 0, HEADER_HEIGHT + CELL_HEIGHT - Math.floor(SEP / 2), COLLAGE_WIDTH, SEP, COLOR.gridLine);

  const encoded = await encodeJpeg({ data: pixels, width: COLLAGE_WIDTH, height: COLLAGE_HEIGHT }, { quality });
  return { ok: true, bytes: encoded, contentType: 'image/jpeg', filledCount: successfulDecodedFrames };
}
