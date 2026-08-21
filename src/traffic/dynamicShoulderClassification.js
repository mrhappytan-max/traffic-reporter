// V1.8.7.0 — Dynamic Shoulder semantic classification. Same data-driven,
// evidence-based pattern as anomalyClassification.js's
// NON_COLLISION_ANOMALY_RULES (the SINGLE source of truth for two
// different consumers that must never independently drift apart — see
// that module's own header) — this module is the analogous single source
// of truth for "does this event describe TDX's own 機動開放路肩 (dynamic
// shoulder) mechanism, and if so, is it OPEN or STOPPED right now."
//
// WHY NOT JUST `EventSubType === '498'`
// --------------------------------------
// The task's own instruction is explicit: "不要只 hardcode
// EventSubType=498". A raw numeric TDX EventType/EventSubType code
// carries no meaning on its own in this codebase (see tdx/normalize.js's
// EVENT_TYPE_TEXT_MAP — it maps CHINESE TEXT, never a bare numeric
// string), and this project has no independently-confirmed mapping from
// TDX's numeric EventSubType codes to their meanings (network egress to
// tdx.transportdata.tw is blocked from this development sandbox — same
// caveat as hsinchuCctvProbe.js's LocationType note). Hardcoding "498
// means dynamic shoulder" would be exactly the kind of guess this
// project's "不要猜" rule forbids the moment TDX assigns a different code
// to the same real-world mechanism, or reuses 498 for something else.
//
// Instead: classify from the actual TEXT evidence TDX already supplies
// (EventType/EventSubType/Category/Description — whichever of these
// happens to carry Chinese text on a given record), the same "check every
// candidate field, in priority order" idiom tdx/normalize.js's own
// mapRoadEventType already uses. A record's raw numeric EventType/
// EventSubType are still passed in as candidate fields (in case TDX ever
// starts publishing a textual value there instead of a numeric code) —
// they simply won't match anything on a purely-numeric value, which is
// the correct, safe outcome (no evidence -> no classification), not a
// hardcoded shortcut.
//
// WHY THIS NEVER CHANGES `event.type`
// ------------------------------------
// Dynamic-shoulder detection is purely ADDITIVE — attached as its own
// `event.dynamicShoulder = {state, evidence}` field (see
// tdx/normalize.js's call site), never a replacement for the existing
// accident/construction/closure/control/congestion/other classification.
// This keeps broadcastRules.js's eligibility gate, and every OTHER
// control-typed event's existing behavior, completely untouched — a
// dynamic-shoulder event just happens to ALSO carry this extra tag
// wherever the evidence genuinely supports it. "只有足夠 semantic
// evidence...才分類成 dynamic shoulder；其他管制事件維持原行為" is
// satisfied structurally: an event with no matching text simply never
// gets `dynamicShoulder` set at all, and every downstream consumer
// (messageFormat.js, dynamicCollage.js, dedupe.js, notified.js) only
// ever branches on this field's PRESENCE, never assumes it.
//
// STOPPED patterns are checked BEFORE OPEN patterns (both per-field and
// across the whole scan) so a real closing announcement — which often
// itself contains the substring "開放" ("路肩『停止』開放"/"恢復禁止
// 『行駛』路肩") — is never misread as an OPEN announcement. Every STOPPED
// pattern requires 路肩 to co-occur with an explicit STOP/RESTORE verb
// (停止開放/恢復禁止), and every OPEN pattern requires 路肩 to co-occur
// with an explicit OPEN verb (開放) — a bare "路肩" mention alone (e.g.
// "路肩施工"/"路肩維修") matches neither list, which is the correct
// fail-closed outcome ("不能因 EventType=4 就把所有 control 都當 dynamic
// shoulder").

const DYNAMIC_SHOULDER_STOPPED_PATTERNS = [
  /機動路肩停止開放/,
  /路肩停止開放/,
  /停止開放路肩/,
  /恢復禁止(?:通行|行駛)路肩/,
  /路肩恢復禁止(?:通行|行駛)/,
  /關閉機動(?:開放)?路肩/,
  /取消(?:機動)?開放路肩/,
];

const DYNAMIC_SHOULDER_OPEN_PATTERNS = [
  /機動開放路肩/,
  /開放機動路肩/,
  /路肩開放/,
  /開放路肩/,
];

const EVIDENCE_VALUE_MAX_CHARS = 80; // same debug-record cap tdx/normalize.js's truncateForDebug already uses

function truncate(value, maxChars) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * @param {string} text - a single raw field's own text (never a
 *   pre-composed multi-field blob — see detectDynamicShoulder, which
 *   scans fields independently so the winning FIELD can be recorded as
 *   evidence, not just the winning STATE).
 * @returns {'OPEN'|'STOPPED'|null}
 */
function classifyShoulderStateFromText(text) {
  if (!text || typeof text !== 'string') return null;
  if (DYNAMIC_SHOULDER_STOPPED_PATTERNS.some((p) => p.test(text))) return 'STOPPED';
  if (DYNAMIC_SHOULDER_OPEN_PATTERNS.some((p) => p.test(text))) return 'OPEN';
  return null;
}

/**
 * Checks EventType, then EventSubType, then Category, then Description —
 * independently, first field to carry recognizable evidence wins — same
 * "check every candidate, don't stop at the first PRESENT field" idiom as
 * tdx/normalize.js's mapRoadEventType (a broad EventType bucket must never
 * shadow a more specific EventSubType/Description that actually carries
 * the real signal).
 *
 * @param {{eventType?:string|number|null, eventSubType?:string|number|null,
 *   category?:string|number|null, description?:string|null}} fields
 * @returns {{state:'OPEN'|'STOPPED', evidence:{field:string, value:string}}|null}
 */
export function detectDynamicShoulder({ eventType = null, eventSubType = null, category = null, description = null } = {}) {
  const fieldCandidates = [
    ['EventType', eventType],
    ['EventSubType', eventSubType],
    ['Category', category],
    ['Description', description],
  ];

  for (const [field, rawValue] of fieldCandidates) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const text = String(rawValue);
    const state = classifyShoulderStateFromText(text);
    if (state) {
      return { state, evidence: { field, value: truncate(text, EVIDENCE_VALUE_MAX_CHARS) } };
    }
  }

  return null;
}

// Exported for direct unit testing of the pattern lists themselves,
// independent of detectDynamicShoulder's field-priority scan.
export { classifyShoulderStateFromText };
