// LINE PUSH POLICY — 重大事故限定主動播報 (2026-08-23).
//
// WHY THIS EXISTS
// ---------------
// The LINE Official Account's monthly proactive-Push allowance is
// limited. The product decision is to temporarily narrow what earns an
// unsolicited push, then observe one month of real usage:
//
//   只有真正值得司機立即注意、會影響道路通行的重大事故才主動 LINE Push。
//
// It is deliberately a GATE layered AFTER the existing V1.5 eligibility
// whitelist (broadcastRules.js), not a rewrite of it, and not a second
// parallel classification system. Nothing here changes `event.type`,
// nothing here touches data collection, and every excluded event still
// appears in full in GET /debug/status and the Pipeline Trace. Reverting
// the policy is a one-line change to DEFAULT_LINE_PUSH_POLICY (or the
// LINE_PUSH_POLICY var), never a re-implementation.
//
// WHAT "重大事故" ACTUALLY MEANS HERE — the verifiable definition
// -----------------------------------------------------------
// The order asked for "會明顯影響道路通行的重大事故", and in the same
// breath forbade inventing the missing half of that: "不要為了符合文字
// 要求硬猜 severity。若現有 PBS 資料不足以可靠判定某一條件，必須使用現有
// 最可信的事故 eligibility 規則，而不是自行臆測。" Those two sentences
// decide this module's shape, so the reasoning is written down here
// rather than left to be re-derived.
//
// There is NO severity score anywhere in this codebase, and a PBS record
// carries no structured impact field at all — pbs/normalize.js returns
// road/direction/roadtype/comment and nothing else. The only structured
// impact signal that exists, `event.blockedLanes` (TDX's
// Impact.BlockedLanes), is TDX-only and therefore dormant while
// TRAFFIC_SOURCE_MODE=PBS_ONLY.
//
// So the ONLY candidate for "major" on live data would have been keyword
// matching over the free-text comment. That was implemented first and
// then rejected on evidence, because deciding that 拖吊 or 回堵 means
// "major" while a bare "國道一號南下100公里處發生事故" does not is
// precisely the severity guess the order forbids — and it errs in the
// dangerous direction, silently withholding a genuinely serious crash
// whose dispatcher simply didn't type a blockage word. It also showed up
// structurally: gating accidents that way broke 47 existing tests that
// use a plain accident as the canonical broadcastable event, i.e. it
// demoted "accident" from the thing this product exists to report.
//
// THE ADOPTED RULE, therefore, is built only on fields that can actually
// be verified:
//
//   an event is pushed  <=>  it already passes broadcastRules.js's V1.5
//                            whitelist  AND  type === 'accident'
//                            AND  it is not a dynamic-shoulder event.
//
// `type === 'accident'` is not a new judgement — it is the existing,
// already-shipped classifier decision (pbs/classify.js's ACCIDENT_PATTERNS
// with its non-collision-anomaly override, tdx/normalize.js's own map),
// which is exactly the "現有最可信的事故 eligibility 規則" the order
// pointed at.
//
// The volume reduction this buys is real and is the point: closure,
// control, construction-with-impact, and every 'other' anomaly (落石/
// 淹水/掉落物/故障車/危險駕駛 …) all stop pushing proactively, as does
// dynamic shoulder. What it does NOT do is claim to rank one accident
// above another on evidence that does not exist.
//
// HONEST GAP, and how to close it with data instead of guesswork:
// this means every PBS 事故 that passes the existing whitelist still
// pushes, which is narrower than today but broader than the literal
// reading of "不是所有 PBS 車禍都 Push". Rather than guess, resolveRoadImpact()
// below still computes and records WHICH accidents state real road impact,
// on both the pushed and the withheld side. After the one-month
// observation the review can read those counts off real traffic and
// tighten the rule to impact-only if the numbers justify it — a
// one-line change here, made against evidence. See 07_KNOWN_ISSUES.md.
//
// WHY DYNAMIC SHOULDER IS BLOCKED SEPARATELY
// -------------------------------------------
// 機動路肩 announcements are high-frequency and, under this policy, are
// never accidents — so the accident rule below would already exclude
// them. They still get their OWN explicit check, first, for two reasons:
// the exclusion is a standing product decision rather than an accident of
// how the accident rule happens to be written, and it must survive a
// future policy loosening. Detection itself is untouched: parser,
// classifier, resolver, formatter, CCTV single-camera strategy and every
// historical test all remain exactly as they were — the capability is
// preserved, only the proactive product is withheld.

import { CONSTRUCTION_IMPACT_PATTERNS } from './broadcastRules.js';

export const LINE_PUSH_POLICY_MAJOR_ACCIDENT_ONLY = 'MAJOR_ACCIDENT_ONLY';
export const LINE_PUSH_POLICY_ALL_ELIGIBLE = 'ALL_ELIGIBLE';

// The deployed default. ALL_ELIGIBLE restores the pre-policy behaviour
// (whatever broadcastRules.js's V1.5 whitelist allows) without deleting
// anything in this module.
export const DEFAULT_LINE_PUSH_POLICY = LINE_PUSH_POLICY_MAJOR_ACCIDENT_ONLY;

// Accident-specific obstruction wording. Deliberately additions ONLY —
// the shared 封閉/占用車道/禁止通行/無法通行/改道/交通管制 vocabulary comes
// from broadcastRules.js's CONSTRUCTION_IMPACT_PATTERNS above, so the two
// gates can never drift into disagreeing about what "通行受影響" means.
const ACCIDENT_IMPACT_PATTERNS = [
  /車道阻塞/, /阻塞車道/, /車道封閉/, /封閉車道/,
  /占用/, /佔用/,
  /道路中斷/, /交通中斷/, /雙向中斷/,
  /回堵/, /壅塞/,
  /翻覆/, /火燒車/, /追撞/, /連環/,
  /人員受困/, /受困/, /傷亡/, /死亡/, /重傷/,
  /搶修/, /吊掛/, /拖吊/,
];

const ROAD_IMPACT_PATTERNS = [...CONSTRUCTION_IMPACT_PATTERNS, ...ACCIDENT_IMPACT_PATTERNS];

/** Same title+description text every other gate in this pipeline reads. */
function impactText(event) {
  return `${(event && event.title) || ''} ${(event && event.description) || ''}`;
}

/** True only for a real, positive, numeric blocked-lane count. */
function hasStructuredLaneBlockage(event) {
  const raw = event && event.blockedLanes;
  if (raw === undefined || raw === null || raw === '') return false;
  const count = Number(raw);
  return Number.isFinite(count) && count > 0;
}

/** @param {object} event */
export function isDynamicShoulderEvent(event) {
  return Boolean(event && event.dynamicShoulder && event.dynamicShoulder.state);
}

/**
 * Does this record itself state that road passage is actually affected?
 * Returns the winning evidence so the decision is auditable in
 * ineligibleByReason / the Pipeline Trace, never a bare boolean.
 *
 * @param {object} event
 * @returns {{impacted:true, evidence:'blocked-lanes'|'impact-keyword'}|{impacted:false}}
 */
export function resolveRoadImpact(event) {
  if (hasStructuredLaneBlockage(event)) return { impacted: true, evidence: 'blocked-lanes' };
  if (ROAD_IMPACT_PATTERNS.some((p) => p.test(impactText(event)))) {
    return { impacted: true, evidence: 'impact-keyword' };
  }
  return { impacted: false };
}

/**
 * Resolve the active push policy. Strict on purpose, and mirroring
 * sourceMode.js's resolver: only the exact string ALL_ELIGIBLE lifts the
 * restriction, and an unrecognised NON-EMPTY value is logged loudly and
 * falls back to the RESTRICTIVE default — the opposite bias to
 * sourceMode.js, because here the expensive failure is pushing too much,
 * not too little.
 */
export function resolveLinePushPolicy(env) {
  const raw = env && typeof env.LINE_PUSH_POLICY === 'string' ? env.LINE_PUSH_POLICY.trim().toUpperCase() : '';
  if (raw === LINE_PUSH_POLICY_ALL_ELIGIBLE) return LINE_PUSH_POLICY_ALL_ELIGIBLE;
  if (raw !== '' && raw !== LINE_PUSH_POLICY_MAJOR_ACCIDENT_ONLY) {
    console.warn(
      `[push-policy] unrecognised LINE_PUSH_POLICY=${JSON.stringify(env.LINE_PUSH_POLICY)} — ` +
        `falling back to ${DEFAULT_LINE_PUSH_POLICY} (the restrictive default).`
    );
  }
  return DEFAULT_LINE_PUSH_POLICY;
}

/**
 * The policy gate itself. Applied AFTER broadcastRules.js's
 * getBroadcastEligibility has already said yes — this only ever removes
 * events, never adds one back that the V1.5 whitelist rejected.
 *
 * @param {object} event
 * @param {object} env
 * @returns {{allowed:boolean, reason:string}} `reason` is always set, on
 *   both paths, so broadcastPipeline.js can aggregate it into
 *   ineligibleByReason exactly like the existing eligibility reasons.
 */
export function getLinePushPolicyDecision(event, env) {
  if (resolveLinePushPolicy(env) === LINE_PUSH_POLICY_ALL_ELIGIBLE) {
    return { allowed: true, reason: 'policy-all-eligible' };
  }

  // First and unconditional — see the module comment.
  if (isDynamicShoulderEvent(event)) {
    return { allowed: false, reason: `policy-dynamic-shoulder-${String(event.dynamicShoulder.state).toLowerCase()}` };
  }

  if (!event || event.type !== 'accident') {
    return { allowed: false, reason: 'policy-not-accident' };
  }

  // Impact evidence is RECORDED, never REQUIRED — see the module comment
  // on why requiring it would be a severity guess. The distinct reasons
  // are what make the one-month review measurable:
  // ineligibleByReason/the Pipeline Trace will show how many pushes
  // stated real road impact and how many did not.
  const impact = resolveRoadImpact(event);
  return {
    allowed: true,
    reason: impact.impacted ? `policy-major-accident-${impact.evidence}` : 'policy-accident-no-stated-impact',
  };
}
