// V1.8 — a minimal, self-contained 5x7 monospace bitmap font for
// labeling the CCTV collage image (src/cctv/collage.js).
//
// Deliberately ASCII-only (digits, a small set of uppercase letters, and
// a few symbols) rather than embedding a CJK font. A real Traditional
// Chinese glyph set legible at label-bar scale needs either a genuine
// font-rasterization pipeline (a WASM SVG renderer + a subsetted CJK
// font, likely 1-3MB added to the bundle, more CPU per request) or a
// hand-authored CJK bitmap font — and unlike this Latin/digit set, CJK
// glyphs are dense enough that hand-authoring them correctly, without
// a way to proof each character at a glance, is a real correctness risk
// rather than a stylistic shortcut. This ASCII set below was authored
// and visually verified (rendered to a real JPEG and inspected) as part
// of this change; see PROJECT_HANDOFF.md's V1.8 section for the full
// rationale and the deferred follow-up to add real CJK glyphs. The
// accompanying LINE text message (a future round, not this one) is
// where the full Chinese narrative lives — this in-image text is a
// compact, unambiguous label, not the primary description.
//
// Each glyph is authored as 7 rows of 5 characters ('#' = lit, '.' =
// blank) — plain ASCII art, so every glyph's shape can be read directly
// off the source instead of decoded from a packed byte table.

const GLYPH_ROWS = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '..#..', '..#..', '..#..', '.#...', '#....'],
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;

function glyphFor(char) {
  return GLYPH_ROWS[char] ?? GLYPH_ROWS[' '];
}

/** Width in device pixels of `text` rendered at the given integer `scale` (including 1-glyph-wide spacing between characters). */
export function measureText(text, scale) {
  const chars = String(text).toUpperCase().length;
  if (chars === 0) return 0;
  return chars * (GLYPH_WIDTH * scale + scale) - scale;
}

/**
 * Draws `text` onto an RGBA Uint8ClampedArray `pixels` (canvasWidth x
 * canvasHeight) at top-left (x, y), scaled up by integer `scale`.
 * Unrecognized characters (including lowercase — this font is
 * upper-case only) render as blank space rather than throwing. Pixels
 * outside the canvas bounds are silently skipped (no exceptions on
 * text that runs off the edge).
 */
export function drawText(pixels, canvasWidth, canvasHeight, text, x, y, scale, color) {
  const [r, g, b, a = 255] = color;
  // Round to integers up front — never trust a caller-supplied x/y to
  // already be integral. A fractional py silently corrupts the render
  // rather than failing loudly: `idx = (py * canvasWidth + px) * 4` can
  // land on a perfectly valid-looking INTEGER idx whenever
  // `fractionalPart(py) * canvasWidth` itself happens to be a whole
  // number (e.g. py = N.5 with an even canvasWidth), silently wrapping
  // the write into a totally different row/column instead of throwing
  // or no-op'ing. Confirmed and fixed during V1.8 development — see
  // PROJECT_HANDOFF.md's V1.8 section.
  let cursorX = Math.round(x);
  const startY = Math.round(y);
  for (const rawChar of String(text).toUpperCase()) {
    const rows = glyphFor(rawChar);
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if (rows[row][col] !== '#') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = cursorX + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px < 0 || px >= canvasWidth || py < 0 || py >= canvasHeight) continue;
            const idx = (py * canvasWidth + px) * 4;
            pixels[idx] = r;
            pixels[idx + 1] = g;
            pixels[idx + 2] = b;
            pixels[idx + 3] = a;
          }
        }
      }
    }
    cursorX += GLYPH_WIDTH * scale + scale;
  }
}
