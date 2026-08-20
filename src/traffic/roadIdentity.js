// V1.8.6.5 — road-name canonicalization for the KM Location Resolver.
//
// Deliberately its OWN module, not folded into roadSectionLabel.js: that
// file's `ROAD_ALIASES`/`resolveRoadKey` are a small, hand-curated table
// scoped ONLY to the two roads it has anchor data for (國道一號/國道三號)
// — exactly right for that narrow purpose, but not what this module needs.
// The KM Location Resolver must work for EVERY freeway and EVERY
// provincial road the imported official dataset happens to cover, without
// hardcoding a per-route special case each time one gets added — see the
// explicit instruction "國3等其他國道路線可由資料驅動，不硬寫國1 special
// case", which applies equally to every other route. So the two
// canonicalizers below are regex/data-driven: they recognize the SHAPE of
// a freeway or provincial road name (any number), not a fixed list of
// specific roads. A small alias table is still kept for the handful of
// historical/nickname forms (e.g. "中山高") that no regex could
// derive — that part stays intentionally tiny, same reasoning
// roadSectionLabel.js already documents for its own ROAD_ALIASES.
//
// Canonical output shapes (what the imported dataset's own `road` column
// must already be normalized to by the importer — see
// scripts/updateRoadLocationData.mjs):
//   freeway:    "國道一號", "國道三號", ... (Chinese-numeral form, matching
//               roadSectionLabel.js's own existing convention)
//   provincial: "台3", "台13甲", "台61", ... (bare "台<digits><suffix?>",
//               no "線" suffix, no leading zeros)
// Returns null (never a guess) when the input doesn't look like a
// recognizable freeway or provincial road name at all.

const CHINESE_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// Converts 1-99 to a Chinese numeral, e.g. 3 -> "三", 61 -> "六十一",
// 10 -> "十" (not "一十", matching how 國道十號 would actually be
// written). Freeway route numbers never exceed two digits in practice,
// but this is written generically (not a per-number lookup table) per
// the same "資料驅動" requirement above.
function arabicToChineseNumeral(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  if (n < 10) return CHINESE_DIGIT[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensPart = tens === 1 ? '十' : `${CHINESE_DIGIT[tens]}十`;
  return ones === 0 ? tensPart : `${tensPart}${CHINESE_DIGIT[ones]}`;
}

// Historical/nickname forms with no derivable numeric shape — kept small
// and local on purpose, same reasoning as roadSectionLabel.js's own
// ROAD_ALIASES comment. Extend this table, never a new hardcoded
// per-route branch in resolveKmLocation itself.
const FREEWAY_NICKNAME_ALIASES = {
  中山高: '國道一號',
  中山高速公路: '國道一號',
  福爾摩沙高速公路: '國道三號',
  二高: '國道三號',
  北二高: '國道三號',
  南二高: '國道三號',
  三高: '國道三號',
  中二高: '國道四號',
};

/**
 * @param {string} road - any raw road string ("國道1號"/"國道一號"/"中山高"/"台61線"/...)
 * @returns {string|null} canonical "國道X號" (Chinese numeral) form, or null if unrecognized as a freeway.
 */
export function canonicalFreewayRoad(road) {
  if (!road) return null;
  const trimmed = String(road).trim();

  if (FREEWAY_NICKNAME_ALIASES[trimmed]) return FREEWAY_NICKNAME_ALIASES[trimmed];

  // Already Chinese-numeral form — just normalize spacing/suffix.
  const chineseMatch = trimmed.match(/^國道\s*([一二三四五六七八九十百]+)\s*號?$/);
  if (chineseMatch) return `國道${chineseMatch[1]}號`;

  // Arabic-numeral form — convert digit(s) to Chinese numeral.
  const arabicMatch = trimmed.match(/^國道\s*(\d{1,2})\s*號?$/);
  if (arabicMatch) {
    const chinese = arabicToChineseNumeral(parseInt(arabicMatch[1], 10));
    return chinese ? `國道${chinese}號` : null;
  }

  return null;
}

/**
 * @param {string} road - any raw road string ("台3線"/"台3"/"省道台13甲線"/...)
 * @returns {string|null} canonical "台<digits><suffix?>" form (no "線"), or null if unrecognized as a provincial road.
 */
export function canonicalProvincialRoad(road) {
  if (!road) return null;
  // Strip a leading "省道" label, if present — it's a category prefix,
  // not part of the route identity itself.
  const trimmed = String(road).trim().replace(/^省道/, '');

  const match = trimmed.match(/^台(\d{1,3})([甲乙丙丁])?\s*(?:線)?$/);
  if (!match) return null;

  const digits = String(parseInt(match[1], 10)); // strips any leading zero
  return `台${digits}${match[2] || ''}`;
}
