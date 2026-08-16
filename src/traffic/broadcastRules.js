// The 60-minute relevance rule for a driving audience: only "happening
// now" or "about to happen very soon" is worth an interruption.

const SIXTY_MINUTES_MS = 60 * 60 * 1000;

/**
 * @param {{ effectiveStart: string|null, effectiveEnd: string|null }} window
 *   - output of computeEffectiveWindow()
 * @param {Date} now
 */
export function isBroadcastRelevant(window, now = new Date()) {
  if (!window || !window.effectiveStart) return false; // can't tell -> don't broadcast

  const startMs = new Date(window.effectiveStart).getTime();
  if (!Number.isFinite(startMs)) return false;

  const nowMs = now.getTime();

  if (window.effectiveEnd) {
    const endMs = new Date(window.effectiveEnd).getTime();
    if (Number.isFinite(endMs) && endMs <= nowMs) return false; // already ended
  }

  if (startMs <= nowMs) return true; // already started (and not ended)

  return startMs <= nowMs + SIXTY_MINUTES_MS; // starts within 60 minutes
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
const OTHER_ANOMALY_PATTERNS = [
  /淹水/, /積水/, /涵洞/, /落石/, /坍方/, /路基流失/, /樹倒/, /電線掉落/, /電線桿倒/,
  /掉落物/, /貨物散落/, /火災/, /橋梁封閉/, /橋梁異常/, /河川暴漲/, /溪水暴漲/,
  /道路中斷/, /無法通行/,
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
