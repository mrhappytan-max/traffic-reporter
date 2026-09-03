// V2.4.11 — V2_4_11_DEBRIS_SAFETY_RISK_CLASSIFICATION_AND_PUSH_PROTECTION
// (路況工程部｜V2.4.11 散落物安全風險分級／LINE Push 額度保護施工令).
//
// PROBLEM (order section 一/二十): PBS/TDX both surface 掉落物／散落物／異物／
// 輪胎皮／貨物掉落／不明物體 events under many different shapes — from a real,
// dangerous, in-lane hazard to a vague "路面發現散落物狀況" report carrying no
// object/size/quantity/lane/impact information at all. Blanket "any debris ->
// LINE Push" floods drivers with noise; blanket "suppress all debris" would
// hide a genuinely dangerous in-lane hazard. Notification eligibility must
// depend on WHERE the debris is, WHAT it is, HOW MUCH of it there is, and
// whether it already affects travel — never simply `eventType === debris`.
//
// This module is a DETERMINISTIC, pure, synchronous classifier — never a
// second AI call (order section 二/九/十九: reuse the SAME existing PBS/TDX AI
// decision call; this module only decides what gets EXCLUDED before that call,
// or what extra structured fact that call sees). It is deliberately
// self-contained: its own local keyword pattern lists, never importing
// pbs/classify.js's OBSTRUCTION_PATTERNS or traffic/anomalyClassification.js's
// NON_COLLISION_ANOMALY_RULES — same "each module stays independently
// readable" convention this repo already uses (see pbs/aiCandidate.js's own
// local OTHER_TOP_LEVEL_PLACES precedent... i.e. every module that needs a
// keyword list keeps its own, rather than sharing one whose meaning could
// silently drift for a different purpose).
//
// ZERO I/O (order section 十二/十三): no network, no KV, no D1/R2, no Durable
// Object. `resolveDebrisSafetyRisk` is safe to call for every candidate,
// every time, at zero marginal storage cost — see pbs/aiCandidate.js's own
// V2.4.11 integration (candidate.debrisRisk, "always present, null-shaped
// when absent" convention, same as displayKM/geoEvidenceType before it).
//
// CLASSIFICATION (order section 二/三/五/六/七/八/十六/十七) — priority order,
// evaluated top-to-bottom, the FIRST matching bucket wins:
//   1. HIGH_RISK — ANY of: debris in a normal travel lane (內側/中間/外側/
//      快/慢車道／車道中央／路中央／行車道) OR a large/hard/high-danger
//      object (整條輪胎／大片輪胎皮／大型金屬／鐵件／木板／棧板／梯子／
//      家具／貨物／大型紙箱or箱體／石塊／工具／車體零件／大型塑膠件) OR
//      multiple/large quantity (多塊／多個／散落多處／大量／整批貨物／多件)
//      OR an explicit traffic-safety impact statement (影響通行／車輛閃避／
//      占用or佔用車道／封閉車道／阻礙交通／危險／緊急排除中) OR a structured
//      blockedLanes>=1 fact (a more reliable signal than free text for the
//      same "traffic impact" criterion — order section 十二's own suggested
//      enhancement). Checked FIRST, unconditionally — this is what correctly
//      keeps a "路肩大型物體部分侵入外側車道" case HIGH_RISK even though the
//      word 路肩 also appears (order section 七), and keeps a lane-position
//      match authoritative over any bare "紙箱" object-type word alone
//      (order section 十六 — no fixed word list is EVER the sole decider).
//   2. LOW_RISK — reached only once none of the HIGH_RISK triggers above
//      matched: shoulder-only (路肩, order section 七's own
//      roadShoulderOnly AND noLaneIntrusion AND noMajorHazard — the last two
//      are already guaranteed true by construction at this point, since no
//      HIGH trigger fired) / off-road or non-travel-area (路外／安全島／
//      邊坡／非行車區域) / already cleared (已清除／已排除／已恢復／已移除／
//      已拖離／已無障礙, order section 十七) / explicitly small debris
//      outside the lane (小型碎屑).
//   3. AI_REVIEW — a genuinely debris-related event that matched neither
//      bucket above (order section 五's own real example: "95K+200路面發現
//      散落物狀況" — only road/direction/KM/debris, no object type, size,
//      quantity, lane, or impact). Handed to the EXISTING AI decision using
//      rawDescription + the canonical structured facts already on the
//      candidate — this module never itself decides notify=true/false here,
//      and never invents a "debris is inherently dangerous" generalization
//      (order section 五/八: AI must not invent facts absent from the raw
//      text; insufficient evidence should lean toward notify=false).
//   4. Not a debris event at all — `isDebrisEvent:false`,
//      `classification:null` — every non-debris PBS/TDX event is completely
//      unaffected by this module (order section 十九's own CASE 19).

export const DEBRIS_RISK = Object.freeze({
  HIGH_RISK: 'HIGH_RISK',
  AI_REVIEW: 'AI_REVIEW',
  LOW_RISK: 'LOW_RISK',
});

// Base vocabulary — presence of ANY of these is what makes an event
// "debris-related" at all (order section 二). Deliberately narrow and
// concrete (real PBS/TDX free-text vocabulary), never a broad word like
// "物體" alone that would over-match unrelated events.
const DEBRIS_KEYWORD_PATTERNS = [/散落物/, /輪胎皮/, /保險桿/, /布鉤繩/, /掉落物/, /異物/, /落物/, /貨物散落/];

// §三-A — normal travel lane position. Deliberately does NOT include the
// generic word "路面" — a bare "路面發現散落物狀況" (order section 五's own
// example) must fall through to AI_REVIEW, not be treated as an automatic
// lane-position match.
const TRAVEL_LANE_PATTERNS = [/內側車道/, /中間車道/, /外側車道/, /快車道/, /慢車道/, /車道中央/, /路中央/, /行車道/];

// §三-B — large/hard/high-danger object types (must have raw-text support;
// this module never infers "AI thinks it's big" — order section 三/十六).
const LARGE_HAZARD_OBJECT_PATTERNS = [
  /整條輪胎/,
  /大片輪胎皮/,
  /大型金屬/,
  /鐵件/,
  /木板/,
  /棧板/,
  /梯子/,
  /家具/,
  /貨物/,
  /大型紙箱/,
  /大型箱體/,
  /石塊/,
  /工具/,
  /車體零件/,
  /大型塑膠/,
];

// §三-C — multiple / large quantity.
const MULTIPLE_QUANTITY_PATTERNS = [/多塊/, /多個/, /散落多處/, /大量/, /整批貨物/, /多件/];

// §三-D — explicit traffic-safety impact already stated in the raw text.
const TRAFFIC_IMPACT_PATTERNS = [/影響通行/, /車輛閃避/, /占用車道/, /佔用車道/, /封閉車道/, /阻礙交通/, /危險/, /緊急排除/];

// §六/§十七 — already resolved, no continuing danger.
const CLEARED_PATTERNS = [/已清除/, /已排除/, /已恢復/, /已移除/, /已拖離/, /已無障礙/];

// §六/§七 — shoulder-only. NEVER sufficient alone for LOW_RISK if a HIGH
// trigger above already matched (checked first, by construction).
const SHOULDER_PATTERNS = [/路肩/];
// §六 — off-road / non-travel-area.
const OFF_ROAD_PATTERNS = [/路外/, /安全島/, /邊坡/, /非行車區域/];
// §六 — explicitly small debris, explicitly outside the lane.
const SMALL_DEBRIS_PATTERNS = [/小型碎屑/];

function findMatches(patterns, text) {
  const matched = [];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) matched.push(m[0]);
  }
  return matched;
}

// Merges every raw free-text field this module has ever been handed a
// shape for — `comment`/`description` (PBS/TDX candidate and normalized-
// event property names differ by caller) and `sourceDetail` — never the
// parsed/structured fields (road/direction/areaNm/displayKM), which carry
// no debris-safety information of their own. Matching against the union is
// deliberate: a real event's lane-position or hazard-object phrase can land
// in either field depending on source.
function extractRawText(event) {
  if (!event || typeof event !== 'object') return '';
  const parts = [];
  if (typeof event.comment === 'string') parts.push(event.comment);
  if (typeof event.description === 'string') parts.push(event.description);
  if (typeof event.sourceDetail === 'string') parts.push(event.sourceDetail);
  return parts.join(' ');
}

/**
 * Pure, synchronous, zero I/O. Safe to call for every PBS/TDX event handed
 * to pbs/aiCandidate.js#buildAiCandidate() (order section十二's own required
 * shape).
 *
 * @param {object} event - a normalizedEvent-shaped or candidate-shaped
 *   object carrying `comment`/`description`, `sourceDetail`, and optionally
 *   a structured `blockedLanes` number.
 * @returns {{isDebrisEvent: boolean, classification: 'HIGH_RISK'|'AI_REVIEW'|'LOW_RISK'|null, reasons: string[], evidence: {lanePosition: string|null, objectType: string|null, quantity: string|null, cleared: boolean, trafficImpact: boolean}}}
 */
export function resolveDebrisSafetyRisk(event) {
  const rawText = extractRawText(event);
  const isDebrisEvent = DEBRIS_KEYWORD_PATTERNS.some((pattern) => pattern.test(rawText));
  if (!isDebrisEvent) {
    // order section 十九 / CASE 19 — a non-debris event is completely
    // unaffected: this exact null-shaped object is what makes every
    // existing GEO/Road-Policy/AI/LINE path see "nothing here" for it.
    return { isDebrisEvent: false, classification: null, reasons: [], evidence: {} };
  }

  const laneMatches = findMatches(TRAVEL_LANE_PATTERNS, rawText);
  const hazardMatches = findMatches(LARGE_HAZARD_OBJECT_PATTERNS, rawText);
  const quantityMatches = findMatches(MULTIPLE_QUANTITY_PATTERNS, rawText);
  const textImpactMatches = findMatches(TRAFFIC_IMPACT_PATTERNS, rawText);
  // order section 十二's own bonus enhancement: TDX's own structured
  // blockedLanes field is a more reliable traffic-impact signal than free
  // text — treated as equivalent to an explicit "占用車道" statement.
  const structuredBlockedLanes = typeof event?.blockedLanes === 'number' && event.blockedLanes >= 1;
  const trafficImpactMatches = structuredBlockedLanes ? [...textImpactMatches, `blockedLanes=${event.blockedLanes}`] : textImpactMatches;

  const clearedMatches = findMatches(CLEARED_PATTERNS, rawText);
  const shoulderMatches = findMatches(SHOULDER_PATTERNS, rawText);
  const offRoadMatches = findMatches(OFF_ROAD_PATTERNS, rawText);
  const smallDebrisMatches = findMatches(SMALL_DEBRIS_PATTERNS, rawText);

  const evidence = {
    lanePosition: laneMatches[0] || null,
    objectType: hazardMatches[0] || null,
    quantity: quantityMatches[0] || null,
    cleared: clearedMatches.length > 0,
    trafficImpact: trafficImpactMatches.length > 0,
  };

  // §三 HIGH_RISK — ANY one criterion is sufficient; checked first and
  // unconditionally, regardless of what shoulder/cleared/small-debris
  // wording also appears in the same raw text (order section 七/八/十六).
  if (laneMatches.length || hazardMatches.length || quantityMatches.length || trafficImpactMatches.length) {
    const reasons = [];
    if (laneMatches.length) reasons.push(`行車道位置：${laneMatches.join('、')}`);
    if (hazardMatches.length) reasons.push(`大型／高危險物體：${hazardMatches.join('、')}`);
    if (quantityMatches.length) reasons.push(`數量／範圍：${quantityMatches.join('、')}`);
    if (trafficImpactMatches.length) reasons.push(`明確交通影響：${trafficImpactMatches.join('、')}`);
    return { isDebrisEvent: true, classification: DEBRIS_RISK.HIGH_RISK, reasons, evidence };
  }

  // §六/§七 LOW_RISK — reached only once no HIGH_RISK trigger matched, so
  // "noLaneIntrusion AND noMajorHazard" already hold by construction here;
  // the shoulder/off-road/cleared/small-debris signal supplies the third
  // (roadShoulderOnly-equivalent) condition.
  if (shoulderMatches.length || offRoadMatches.length || clearedMatches.length || smallDebrisMatches.length) {
    const reasons = [];
    if (shoulderMatches.length) reasons.push('僅路肩，且無車道侵入、無大型／高危險物體證據');
    if (offRoadMatches.length) reasons.push(`路外／非行車區域：${offRoadMatches.join('、')}`);
    if (clearedMatches.length) reasons.push(`已排除／已清除：${clearedMatches.join('、')}`);
    if (smallDebrisMatches.length) reasons.push('小型碎屑，且明確未影響車道');
    return { isDebrisEvent: true, classification: DEBRIS_RISK.LOW_RISK, reasons, evidence };
  }

  // §五 AI_REVIEW — debris-related, but not enough structured/文字 evidence
  // to determine lane position／物體大小／數量／交通影響。禁止在此直接猜測
  // notify——交給既有 AI 決策以 rawDescription + 既有結構化事實綜合研判。
  return {
    isDebrisEvent: true,
    classification: DEBRIS_RISK.AI_REVIEW,
    reasons: ['散落物相關事件，但缺乏車道位置／物體大小／數量／交通影響等具體證據，交由既有 AI 判讀綜合研判'],
    evidence,
  };
}
