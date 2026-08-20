// The 60-minute relevance rule for a driving audience: only "happening
// now" or "about to happen very soon" is worth an interruption.

import { NON_COLLISION_ANOMALY_RULES } from './anomalyClassification.js';
import { classifyEventTimeStatus } from './effectiveWindow.js';

const SIXTY_MINUTES_MS = 60 * 60 * 1000;

/**
 * V1.8.6.8 — thin wrapper over effectiveWindow.js's classifyEventTimeStatus
 * (the single authoritative "is the event's own window active" check;
 * see that function's own comment), adding ONLY this rule's own 60-minute
 * forecast leniency on top of the 'not-started' case — never a second,
 * independent start/end comparison. Pipeline Trace's `eventActive` field
 * reads classifyEventTimeStatus() directly, so its reasoning always
 * matches this function's exactly.
 *
 * @param {{ effectiveStart: string|null, effectiveEnd: string|null }} window
 *   - output of computeEffectiveWindow()
 * @param {Date} now
 */
export function isBroadcastRelevant(window, now = new Date()) {
  const status = classifyEventTimeStatus(window, now);
  if (status === 'active') return true;
  if (status !== 'not-started') return false; // 'no-data' or 'ended'

  const startMs = new Date(window.effectiveStart).getTime();
  return startMs <= now.getTime() + SIXTY_MINUTES_MS; // starts within 60 minutes
}

// V1.5: product repositioning — "路況播報員" only interrupts a
// professional driver for a sudden abnormality that might force an
// immediate route change. NOT ordinary traffic flow (they already have
// Google Maps/1968 for that — congestion is never eligible, any
// severity), and NOT every 'other'/'construction' record either — a
// whitelist/conditional rule per type, not a blanket "anything not
// congestion goes out":
//
//   accident / closure / control -> always eligible.
//   construction                 -> only if its own text signals real
//                                    通行影響 (lane/road actually
//                                    blocked), not routine paving work.
//   other                        -> only if its own text hits a known
//                                    abnormality keyword (flooding,
//                                    rockslide, fallen tree/power line,
//                                    debris, fire, bridge closure, river
//                                    surge, road cut off, impassable) —
//                                    an unrecognized 'other' record
//                                    stays silent, same "寧可少播"
//                                    principle used throughout this
//                                    project (see e.g. effectiveWindow.js).
//   congestion / alert           -> never eligible by default.
//
// None of this touches data collection anywhere — TDX/PBS still fetch/
// normalize/classify/cluster/VD-validate every event exactly as before,
// and everything still fully appears in GET /debug/status/GET
// /debug/pbs; only this one broadcast-eligibility gate is conditional.
//
// If the SAME real incident is independently reported as BOTH
// congestion/an-ineligible-'other' AND accident/closure/etc (two
// different source records — same-source-different-type records are
// never merged into one, and PBS+TDX cross-source dedup only ever
// merges matching-type pairs), the ineligible record is excluded here
// while the accident/closure/etc record broadcasts normally on its own
// — so the incident still reaches LINE exactly once, framed by its more
// informative type.

const ALWAYS_ELIGIBLE_TYPES = new Set(['accident', 'closure', 'control']);
const NEVER_ELIGIBLE_TYPES = new Set(['congestion', 'alert']);

// construction: only "this actually blocks/changes how you drive
// through here" text, not routine maintenance announcements.
const CONSTRUCTION_IMPACT_PATTERNS = [
  /封閉/, /車道封閉/, /占用車道/, /佔用車道/, /禁止通行/, /無法通行/, /改道/, /交通管制/,
];

// other: only recognized real-world abnormalities — see requirement
// list. 無法通行 is deliberately also here (not just under construction)
// since an 'other'-classified record can describe the same impassable-
// road situation without ever mentioning construction at all.
// V1.8.6.6 — 行人闖入/動物闖入 patterns are pulled directly from
// anomalyClassification.js's own NON_COLLISION_ANOMALY_RULES (never a
// third, independently-typed copy) so a pedestrian/animal-on-roadway
// advisory — correctly downgraded from 'accident' to 'other' by this
// round's classification fix — still passes eligibility instead of
// going silent. "eligibility 只決定要不要播，不能改事件類型" — this list
// still only ever gates BROADCAST-WORTHINESS; it never touches `type`
// itself (that's decided once, upstream, in tdx/normalize.js/
// pbs/classify.js).
const PEDESTRIAN_ANIMAL_INTRUSION_PATTERNS = NON_COLLISION_ANOMALY_RULES
  .filter((rule) => rule.label === '行人闖入' || rule.label === '動物闖入')
  .flatMap((rule) => rule.patterns);

const OTHER_ANOMALY_PATTERNS = [
  /淹水/, /積水/, /涵洞/, /落石/, /坍方/, /路基流失/, /樹倒/, /電線掉落/, /電線桿倒/,
  /掉落物/, /貨物散落/, /火災/, /橋梁封閉/, /橋梁異常/, /河川暴漲/, /溪水暴漲/,
  /道路中斷/, /無法通行/,
  ...PEDESTRIAN_ANIMAL_INTRUSION_PATTERNS,
];

function broadcastText(event) {
  return `${(event && event.title) || ''} ${(event && event.description) || ''}`;
}

/**
 * @param {{ type: string, title?: string, description?: string }} event
 * @returns {{ eligible: boolean, reason: string }} `reason` is always
 *   set (on both the eligible and ineligible paths) so callers can
 *   aggregate WHY events were excluded — see broadcastPipeline.js's
 *   `ineligibleByReason` debug counts.
 */
export function getBroadcastEligibility(event) {
  const type = event && event.type;

  if (NEVER_ELIGIBLE_TYPES.has(type)) {
    return { eligible: false, reason: type === 'congestion' ? 'congestion-excluded' : 'alert-excluded' };
  }
  if (ALWAYS_ELIGIBLE_TYPES.has(type)) {
    return { eligible: true, reason: 'eligible-type' };
  }
  if (type === 'construction') {
    const matched = CONSTRUCTION_IMPACT_PATTERNS.some((p) => p.test(broadcastText(event)));
    return matched
      ? { eligible: true, reason: 'construction-impact-keyword' }
      : { eligible: false, reason: 'construction-no-impact-keyword' };
  }
  if (type === 'other') {
    const matched = OTHER_ANOMALY_PATTERNS.some((p) => p.test(broadcastText(event)));
    return matched
      ? { eligible: true, reason: 'other-anomaly-keyword' }
      : { eligible: false, reason: 'other-no-anomaly-keyword' };
  }

  // Any type this rule doesn't explicitly recognize fails closed —
  // never guess an unfamiliar type is broadcast-worthy.
  return { eligible: false, reason: 'unrecognized-type' };
}

/** @param {{ type: string }} event */
export function isBroadcastEligibleType(event) {
  return getBroadcastEligibility(event).eligible;
}
