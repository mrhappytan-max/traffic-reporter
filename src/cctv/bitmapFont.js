// V1.8.3 — bitmap font for labeling the CCTV collage image
// (src/cctv/collage.js), rendering Traditional Chinese so a taxi/for-
// hire driver can read the label at a glance in LINE ("讓計程車／營業車
// 司機在 LINE 上一眼就看懂").
//
// CORRECTION (post-Production-visual-review): the first version of this
// font hand-authored 16x16 1-bit CJK glyphs by hand, character by
// character. Production visual review found the result insufficiently
// legible — a real font conveys stroke shape, proportion, and (critically)
// anti-aliased edges in ways a手繪 16x16 bitmap cannot approximate at a
// glance, no matter how many correction passes it goes through. Rather
// than continue hand-tuning individual glyphs, this file now blits
// PRE-RASTERIZED grayscale alpha masks produced from a real font — see
// src/cctv/generated/cjkGlyphRaster.js's module comment for exactly how
// (Playwright + a real headless Chromium canvas rendering 'Noto Sans TC'
// at development/build time; only the resulting per-character alpha
// masks are committed, never the font file itself, never as a runtime
// dependency, never shipped to Production in any form). The closed
// 24-character CJK set this round's text needs is unchanged:
// 國附近監視畫面更新南前後北距事故公里無符合鏡頭暫 — plus digits 0-9,
// K, +, :, /, ., space, all rendered through the SAME real-font pipeline
// (not hand-drawn) so mixed CJK+digit text has consistent, matching
// anti-aliasing rather than crisp hand-drawn digits next to a different
// glyph style.
//
// Two raster tables at a SHARED row height (32px), so mixed CJK+ASCII
// text (e.g. "82K+900 / 距事故 0.800 公里") lines up on one baseline —
// the standard "full-width CJK / half-width Latin" convention used by
// any monospace font that mixes the two:
//   - CJK_RASTER: 32x32 ("full-width") — the 24-character set above.
//   - HALF_RASTER: 16x32 ("half-width") — digits 0-9, K, +, :, /, .,
//     space.
//
// Runtime cost: this module only ever decodes base64 -> bytes (`atob` +
// a byte loop) and alpha-blends pixels into the destination RGBA buffer
// — no font parsing, no TTF/OTF decoding, no WASM, at Worker runtime.
// Every glyph's raw alpha bytes are memoized (decoded once per glyph,
// lazily, on first use) rather than decoded on every drawText() call.
//
// See PROJECT_HANDOFF.md's V1.8.3 section for the full before/after,
// the rasterization pipeline, and the licensing note (Noto Sans TC is
// OFL-1.1 licensed — the alpha-mask *data* derived from it, containing
// no font program/hinting/outline data, is committed here).

import { CJK_RASTER, HALF_RASTER } from './generated/cjkGlyphRaster.js';

export const LINE_HEIGHT = 32; // shared row height for both tables
export const FULL_WIDTH = 32; // CJK glyph width
export const HALF_WIDTH = 16; // ASCII/digit glyph width

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Lazily decoded, memoized per glyph — avoids paying the atob() cost for
// glyphs a given collage never actually uses (e.g. digits '3'/'5'/'7'
// might never appear in a given request's LocationMile/distance values).
const decodedCache = new Map();

function decodedAlpha(entry) {
  let bytes = decodedCache.get(entry);
  if (!bytes) {
    bytes = base64ToBytes(entry.alphaBase64);
    decodedCache.set(entry, bytes);
  }
  return bytes;
}

/** Returns {alpha, width, height} for `char` — full-width (32) if it's
 * a known CJK glyph, half-width (16) otherwise. Unrecognized characters
 * fall back to a blank half-width space rather than throwing. */
function glyphFor(char) {
  const cjkEntry = CJK_RASTER[char];
  if (cjkEntry) return { alpha: decodedAlpha(cjkEntry), width: cjkEntry.width, height: cjkEntry.height };
  const halfEntry = HALF_RASTER[char] ?? HALF_RASTER[' '];
  return { alpha: decodedAlpha(halfEntry), width: halfEntry.width, height: halfEntry.height };
}

/** Width in device pixels of `text` rendered at the given integer `scale`. */
export function measureText(text, scale) {
  let width = 0;
  for (const char of String(text)) width += glyphFor(char).width * scale;
  return width;
}

/**
 * Draws `text` onto an RGBA Uint8ClampedArray `pixels` (canvasWidth x
 * canvasHeight) at top-left (x, y), scaled up by integer `scale`. Mixes
 * full-width CJK and half-width ASCII/digit glyphs on one baseline,
 * alpha-blending each glyph's rasterized mask into the destination
 * (nearest-neighbor scaling of the mask itself — the mask was rasterized
 * at a fixed size, so `scale` blows up each mask pixel into a scale x
 * scale block, same as the project's existing nearest-neighbor image
 * blit in collage.js's drawImageCover). Unrecognized characters render
 * as blank space rather than throwing. Pixels outside the canvas bounds
 * are silently skipped.
 *
 * `scale` MUST be a positive integer — never trust a fractional scale
 * here. This was root-caused twice in this project already: a
 * fractional pixel coordinate can silently corrupt the render instead
 * of failing loudly (`idx = (py * canvasWidth + px) * 4` can land on a
 * perfectly valid-looking INTEGER idx whenever the fractional part of
 * py times canvasWidth is itself a whole number, wrapping the write
 * into a totally different row/column) — see PROJECT_HANDOFF.md's V1.8
 * section. x/y are still defensively rounded below even though scale
 * itself is asserted integer, since a caller could still pass a
 * fractional x/y independent of scale.
 */
export function drawText(pixels, canvasWidth, canvasHeight, text, x, y, scale, color) {
  if (!Number.isInteger(scale) || scale <= 0) {
    throw new Error(`drawText: scale must be a positive integer, got ${scale}`);
  }
  const [r, g, b] = color;
  let cursorX = Math.round(x);
  const startY = Math.round(y);
  for (const char of String(text)) {
    const { alpha, width, height } = glyphFor(char);
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const a = alpha[row * width + col];
        if (a === 0) continue;
        const alphaFrac = a / 255;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = cursorX + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px < 0 || px >= canvasWidth || py < 0 || py >= canvasHeight) continue;
            const idx = (py * canvasWidth + px) * 4;
            // Alpha-blend onto whatever is already there (the tile/
            // header background), rather than a hard overwrite — this
            // is what gives the anti-aliased glyph edges their smooth
            // look instead of a jagged 1-bit outline.
            pixels[idx] = Math.round(pixels[idx] * (1 - alphaFrac) + r * alphaFrac);
            pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - alphaFrac) + g * alphaFrac);
            pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - alphaFrac) + b * alphaFrac);
            pixels[idx + 3] = 255;
          }
        }
      }
    }
    cursorX += width * scale;
  }
}
