// V2.4.5 — V2_4_5_TDX_ROAD_MANAGEMENT_POLICY_GATE (supplement to
// V2_4_5_TDX_HSINCHU_GEO_RESOLVER, same version, TDX ONLY — PBS
// completely untouched by this module).
//
// WHAT THIS DECIDES
// -------------------
// A deterministic, pre-AI eligibility gate for TWO narrow TDX event
// classes that don't need a Workers AI call to judge at all — order
// section 八's own "車道數判斷屬於 deterministic data...不需要問AI":
//
//   1. 機動路肩開放／機動路肩關閉 (dynamic shoulder open/close) — never
//      eligible. This is a planned, structural road-capacity status
//      change, not an acute event — the SAME judgment V2.4.4's own AI
//      prompt anchor already reaches semantically (aiDecisionEngine.js's
//      SYSTEM_PROMPT anchor 四), now enforced deterministically ahead of
//      it as well (order section 九: "先保留...作為第二層 safety net" —
//      that prompt anchor is NOT removed this round).
//   2. 一般施工／例行施工 (routine construction) — eligible ONLY when the
//      event's own structured `blockedLanes` count is >= 2. 0 or 1 blocked
//      lanes, or a missing/unparseable/untrustworthy count, is NOT
//      eligible. Reaching this threshold does NOT mean notify — it only
//      means the event may proceed to the AI, which still makes the real
//      driver-impact judgment (order section 二: "只是取得進入AI的資
//      格... 不是直接LINE").
//
// WHAT THIS DELIBERATELY NEVER BLOCKS (order section 四/五)
// -----------------------------------------------------------
// A genuine major incident — 車禍事故／道路完全封閉／坍方／落石／大型掉落
// 物／嚴重道路障礙／突發重大危害／既有其他重大事故類型 — must reach the AI
// regardless of what `event.type` happens to be, including when it is
// ALSO classified 'construction' (order section 五's own explicit example:
// "施工造成雙向完全封閉...仍應進AI"). This is checked via an ESCAPE VALVE
// built from THREE signals, none of them a new large keyword system:
//   - ACCIDENT_KEYWORD_PATTERNS — a verbatim copy of tdx/classify.js's own
//     KEYWORD_RULES 'accident' pattern list (事故/車禍/追撞/翻覆/自撞).
//     Duplicated, not called through classifyByKeyword(), because that
//     function returns only its OWN single highest-priority match, and a
//     text containing BOTH "施工" and a closure phrase would legitimately
//     classify as 'construction' there (construction is checked before
//     closure in that shared table) — masking exactly the signal this
//     escape valve needs. Reading the accident sub-list directly avoids
//     depending on that function's internal priority order.
//   - MAJOR_CLOSURE_KEYWORD_PATTERNS — deliberately NARROWER than tdx/
//     classify.js's own generic 'closure' pattern list (which includes
//     bare "封閉" — matching, for example, entirely ordinary construction
//     text like "外側車道封閉", which must NOT escape the lane-count gate
//     below). Scoped to TOTAL/SEVERE blockage phrasing only (完全封閉/
//     全線封閉/禁止通行/無法通行) — the same narrower "is this actually
//     worse than routine" signal traffic/incidentSuppression.js's own
//     CLOSURE_ESCALATION_PATTERNS already uses for an analogous purpose
//     (that module's own list additionally includes 匝道封閉, deliberately
//     OMITTED here — a single ramp closure during construction is
//     ordinary maintenance, not evidence of a major event, for THIS
//     gate's purpose).
//   - traffic/anomalyClassification.js#detectNonCollisionAnomaly — the
//     same 落石/坍方/掉落物/道路中斷/... table messageFormat.js's own
//     resolveOtherAnomalyDetail and tdx/normalize.js's own
//     mapRoadEventType override already share (called directly, not
//     duplicated — its own output is unambiguous).
// Deliberately NOT a new, third large keyword table (order's own "不要建
// 立第二套決策系統" discipline, restated in the original V2.4.5 order's
// section 二 for the geo resolver and equally applicable here) — every
// pattern above is either a direct reuse or a narrower subset of an
// existing, already-canonical list.
//
// WHERE THIS RUNS (order section 六/十二)
// ------------------------------------------
// AFTER the Hsinchu geography gate (tdx/hsinchuGeoResolver.js), BEFORE
// Queue.send() — see tdx/tdxQueueIngress.js's own V2.4.5 comment. An
// event that fails the geography gate never reaches this module at all.

import { detectNonCollisionAnomaly } from '../traffic/anomalyClassification.js';

// See this module's own header for exactly what these are and why.
const ACCIDENT_KEYWORD_PATTERNS = [/事故/, /車禍/, /追撞/, /翻覆/, /自撞/];
const MAJOR_CLOSURE_KEYWORD_PATTERNS = [/完全封閉/, /全線封閉/, /禁止通行/, /無法通行/];

export const ROAD_MANAGEMENT_GATE_REASON = Object.freeze({
  SHOULDER_OPEN: 'road-shoulder-open',
  SHOULDER_CLOSE: 'road-shoulder-close',
  CONSTRUCTION_INSUFFICIENT_LANES: 'construction-insufficient-blocked-lanes',
  CONSTRUCTION_UNKNOWN_LANES: 'construction-unknown-blocked-lanes',
  CONSTRUCTION_SUFFICIENT_LANES: 'construction-sufficient-blocked-lanes',
  MAJOR_EVENT_ESCAPE_VALVE: 'major-event-not-routine-management',
  NOT_ROAD_MANAGEMENT: 'not-road-management-event',
});

const MIN_BLOCKED_LANES_FOR_AI_ELIGIBILITY = 2;

/**
 * `event.blockedLanes` (tdx/normalize.js) may be absent, a string, or
 * (defensively) some other raw shape — never trusted as-is. Returns a
 * non-negative integer, or `null` when the value is missing, non-numeric,
 * negative, or fractional (order section 三: "值不可信...必須UNKNOWN").
 * Same numeric-parsing discipline messageFormat.js's own
 * buildBlockedLanesLine already uses, extended to also reject a
 * non-integer count as untrustworthy (a lane count is a whole number by
 * construction).
 *
 * @returns {number|null}
 */
export function parseTrustedBlockedLanesCount(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Reuses (never duplicates) two already-canonical, shared keyword/pattern
 * detectors — see this module's own header for exactly which and why.
 * True means "this event's own text independently reads as a real
 * accident, complete-closure-grade, or hazard-anomaly event", regardless
 * of what `event.type` classification it happens to carry.
 *
 * @returns {boolean}
 */
function isTextuallyAMajorEvent(event) {
  const text = `${event.title || ''} ${event.description || ''}`.trim();
  if (!text) return false;
  if (ACCIDENT_KEYWORD_PATTERNS.some((p) => p.test(text))) return true;
  if (MAJOR_CLOSURE_KEYWORD_PATTERNS.some((p) => p.test(text))) return true;
  return Boolean(detectNonCollisionAnomaly(text));
}

/**
 * @param {object} event - a tdx/normalize.js-shaped normalized event that
 *   has ALREADY passed the Hsinchu geography gate.
 * @returns {{eligible: boolean, reason: string, evidence: object}}
 */
export function resolveTdxRoadManagementEligibility(event) {
  if (!event || typeof event !== 'object') {
    return { eligible: false, reason: ROAD_MANAGEMENT_GATE_REASON.NOT_ROAD_MANAGEMENT, evidence: {} };
  }

  // Dynamic shoulder open/close — order section 2, unconditional (no
  // escape valve requested or needed: detectDynamicShoulder's own pattern
  // list requires 路肩 to co-occur with an explicit open/stop verb, which
  // a genuine accident/hazard description has no structural reason to
  // contain — see dynamicShoulderClassification.js's own header).
  if (event.dynamicShoulder && event.dynamicShoulder.state === 'OPEN') {
    return { eligible: false, reason: ROAD_MANAGEMENT_GATE_REASON.SHOULDER_OPEN, evidence: { dynamicShoulder: event.dynamicShoulder } };
  }
  if (event.dynamicShoulder && event.dynamicShoulder.state === 'STOPPED') {
    return { eligible: false, reason: ROAD_MANAGEMENT_GATE_REASON.SHOULDER_CLOSE, evidence: { dynamicShoulder: event.dynamicShoulder } };
  }

  // Routine construction — order section 2/3, scoped ONLY to
  // type==='construction' (the supplement never mentions 'closure' or any
  // other type; leaving every other type completely untouched by this
  // gate is the minimal, literal reading of its own stated scope).
  if (event.type === 'construction') {
    if (isTextuallyAMajorEvent(event)) {
      return {
        eligible: true,
        reason: ROAD_MANAGEMENT_GATE_REASON.MAJOR_EVENT_ESCAPE_VALVE,
        evidence: { title: event.title, description: event.description },
      };
    }

    const blockedLanes = parseTrustedBlockedLanesCount(event.blockedLanes);
    if (blockedLanes === null) {
      return {
        eligible: false,
        reason: ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_UNKNOWN_LANES,
        evidence: { rawBlockedLanes: event.blockedLanes },
      };
    }
    if (blockedLanes < MIN_BLOCKED_LANES_FOR_AI_ELIGIBILITY) {
      return {
        eligible: false,
        reason: ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_INSUFFICIENT_LANES,
        evidence: { blockedLanes },
      };
    }
    return {
      eligible: true,
      reason: ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_SUFFICIENT_LANES,
      evidence: { blockedLanes },
    };
  }

  // Every other event class (accident, closure, control, congestion,
  // other, ...) is NOT in this gate's scope at all — order section 四's
  // own explicit "本施工政策只處理：機動路肩開放／關閉／一般施工" — proceeds
  // to the AI exactly as before this round, untouched.
  return { eligible: true, reason: ROAD_MANAGEMENT_GATE_REASON.NOT_ROAD_MANAGEMENT, evidence: {} };
}
