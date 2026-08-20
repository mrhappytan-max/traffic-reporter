// Shared, data-driven "this is a real roadway hazard, but NOT a vehicle
// collision" keyword table — the SINGLE source of truth for two
// different consumers that must never independently drift apart:
//   1. Classification (tdx/normalize.js's mapRoadEventType,
//      pbs/classify.js's classifyPbsEvent) — decides `event.type`.
//   2. Display (messageFormat.js's resolveOtherAnomalyDetail) — decides
//      the specific emoji/label shown for an already-'other'-classified
//      event, instead of the generic "路況異常".
//
// V1.8.6.6 — root-cause fix, real Production incident (2026-08-20,
// ~20:13 Asia/Taipei): the official 高速公路 App showed 國1 南向 92.8K
// "其他異常告警－行人誤闖" (a pedestrian-on-freeway advisory); this
// Worker instead broadcast "🚨 交通事故／事故影響通行／請提前避開" — the
// full accident template, template implying a vehicle collision.
//
// Root cause (see tdx/normalize.js's mapRoadEventType for the exact
// mechanism): TDX's own RoadEvent schema uses a BROAD top-level
// `EventType` bucket plus a more SPECIFIC `EventSubType` (confirmed real
// shape — see test/fixtures.js's `EventType:'事故'`/
// `EventSubType:'一般事故'`). `EVENT_TYPE_TEXT_MAP`'s blunt exact-string
// match on a broad "事故" bucket previously won immediately, the instant
// ANY field matched — including EventType alone — WITHOUT ever
// re-checking whether a more specific field (EventSubType/Category/
// Description) contradicted it with a non-collision hazard signal. A
// pedestrian/animal-on-roadway advisory reasonably lives under the same
// broad "事故" bucket as a real collision (both are lane-impacting
// hazards from TDX's own point of view) — that is TDX's own legitimate,
// working convention, NOT upstream's mistake; discarding the more
// specific subtype once the broad bucket matched is THIS project's own
// classification defect, now fixed by checking every candidate field for
// one of the patterns below whenever the initial classification landed
// on 'accident', and downgrading to 'other' (with the matched hazard's
// own label) when one is found — see mapRoadEventType/classifyPbsEvent's
// own call sites for the exact override logic.
//
// Deliberately data-driven by CATEGORY, not a single hardcoded phrase:
// covers 行人/動物 intrusion generically (誤闖/闖入/侵入/穿越/逗留/遊蕩/
// 游蕩 — whichever specific wording TDX/PBS happen to use), not just the
// one exact string "行人誤闖" from this incident.

export const NON_COLLISION_ANOMALY_RULES = [
  { emoji: '🌊', label: '道路積水', patterns: [/淹水/, /積水/, /涵洞/, /河川暴漲/, /溪水暴漲/] },
  { emoji: '⛰️', label: '落石', patterns: [/落石/] },
  { emoji: '⛰️', label: '邊坡坍方', patterns: [/坍方/, /路基流失/] },
  { emoji: '🌳', label: '路樹倒塌', patterns: [/樹倒/] },
  { emoji: '⚡', label: '電線倒塌', patterns: [/電線掉落/, /電線桿倒/] },
  { emoji: '⚠️', label: '掉落物', patterns: [/掉落物/, /貨物散落/] },
  { emoji: '🔥', label: '火災', patterns: [/火災/] },
  { emoji: '⚠️', label: '橋梁異常', patterns: [/橋梁封閉/, /橋梁異常/] },
  { emoji: '⚠️', label: '道路中斷', patterns: [/道路中斷/] },
  // V1.8.6.6 — the two categories this incident was actually missing.
  { emoji: '🚶', label: '行人闖入', patterns: [/行人.{0,4}(誤闖|闖入|侵入|穿越|逗留|遊蕩|游蕩)/, /(誤闖|闖入).{0,4}行人/] },
  { emoji: '🐾', label: '動物闖入', patterns: [/動物.{0,4}(誤闖|闖入|侵入|逗留|遊蕩|游蕩)/, /(誤闖|闖入).{0,4}動物/, /牲畜/] },
];

/**
 * @param {string} text - free text to scan (a single raw field's own
 *   text, or an already-composed title+description string — caller's
 *   choice; this function does no field-composition of its own).
 * @returns {{emoji:string, label:string}|null}
 */
export function detectNonCollisionAnomaly(text) {
  if (!text || typeof text !== 'string') return null;
  for (const rule of NON_COLLISION_ANOMALY_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return { emoji: rule.emoji, label: rule.label };
  }
  return null;
}
