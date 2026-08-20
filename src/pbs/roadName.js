// PBS's `road` field is frequently an empty string — the real road name
// usually lives in `areaNm` instead (e.g. "中山高速公路-國道１號",
// "(南寮竹東)-台68線"). This derives a road name in the same style TDX
// already uses ("國道一號" — confirmed real TDX field value; "台68" for
// province/expressway roads per the confirmed real PBS example).

const FULLWIDTH_DIGITS = '０１２３４５６７８９';
const HALFWIDTH_DIGITS = '0123456789';

const CHINESE_NUMERALS = {
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '七',
  8: '八',
  9: '九',
  10: '十',
};

export function toHalfwidthDigits(str) {
  let out = '';
  for (const ch of str) {
    const idx = FULLWIDTH_DIGITS.indexOf(ch);
    out += idx >= 0 ? HALFWIDTH_DIGITS[idx] : ch;
  }
  return out;
}

function normalizeFreewayName(text) {
  // "中山高速公路-國道１號" / "福爾摩沙高速公路-國道3號" -> "國道一號" / "國道三號"
  const match = toHalfwidthDigits(text).match(/國道\s*(\d+)\s*號/);
  if (!match) return null;
  const numeral = CHINESE_NUMERALS[match[1]];
  return numeral ? `國道${numeral}號` : `國道${match[1]}號`;
}

function normalizeHighwayName(text) {
  // "(南寮竹東)-台68線" / "(西濱快速)-台61線" -> "台68" / "台61"
  const match = toHalfwidthDigits(text).match(/台\s*(\d+)\s*線/);
  if (!match) return null;
  return `台${match[1]}`;
}

/**
 * @param {string} road - PBS's `road` field (often empty)
 * @param {string} areaNm - PBS's `areaNm` field, used as fallback
 */
export function normalizePbsRoad(road, areaNm) {
  const trimmedRoad = (road || '').trim();
  if (trimmedRoad) {
    // Even a populated `road` might itself be areaNm-style text.
    return normalizeFreewayName(trimmedRoad) || normalizeHighwayName(trimmedRoad) || toHalfwidthDigits(trimmedRoad);
  }

  const trimmedAreaNm = (areaNm || '').trim();
  if (!trimmedAreaNm) return '';

  return normalizeFreewayName(trimmedAreaNm) || normalizeHighwayName(trimmedAreaNm) || toHalfwidthDigits(trimmedAreaNm);
}

// V57.2 — "is this an already-normalized 國道 (freeway) road name" — the
// SAME canonical shape normalizeFreewayName() above always produces
// ("國道X號"), formalized as a reusable predicate so callers (see
// crossSourceDedup.js's freeway-gate) reuse this module's own existing
// classification instead of inventing a second, parallel road-name
// pattern. Deliberately only ever tested against an ALREADY-normalized
// road (i.e. the output of normalizePbsRoad, or TDX's own real
// "國道一號"-shaped Road field) — never re-parses raw areaNm/road text
// itself, so this can never drift from what normalizePbsRoad already
// decided for a given event.
export function isFreewayRoadName(road) {
  return /^國道.+號$/.test((road || '').trim());
}
