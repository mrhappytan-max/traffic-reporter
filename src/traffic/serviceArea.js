// SERVICE AREA GATE — the Producer's last, always-on geographic check
// before anything can be broadcast (2026-08-24).
//
// WHY THIS EXISTS
// ---------------
// Production shipped a LINE push for a PBS 國道1號南向 accident at 八堵
// (基隆), roughly 25.10288 / 121.71801 — far outside this product's
// service area. That must never happen.
//
// Geographic filtering already existed, but at exactly ONE point: PBS
// ingestion (pbs/pipeline.js's `normalized.filter(isPbsEventHsinchuRelevant)`).
// Downstream, broadcastPipeline.js merely DOCUMENTED the assumption — its
// own JSDoc says "every currently Hsinchu-relevant ... event" — and then
// never checked it. A documented assumption is not a gate: anything that
// reaches the broadcast layer by any other path inherits broadcast rights
// it was never granted.
//
// That exposure grew on 2026-08-24, when the V57.2 國道 gate was correctly
// bypassed in PBS_ONLY mode (see pbs/crossSourceDedup.js). V57.2 had been
// incidentally catching every unmatched 國道 PBS event, geography or not.
// Removing its veto removed that accidental safety net too — so the real
// geographic rule now has to be stated explicitly, where it belongs.
//
// THE TWO GATES ARE INDEPENDENT, AND MUST STAY THAT WAY
// -----------------------------------------------------
//   TDX_CORROBORATION_REQUIRED      -> false in PBS_ONLY (TDX is off)
//   SERVICE_AREA_ELIGIBILITY_REQUIRED -> ALWAYS true, in every mode
//
// "We no longer need TDX to confirm it" must never be allowed to become
// "so anything anywhere can broadcast". This module is that separation,
// written down and enforced rather than assumed.
//
// IT REUSES THE EXISTING CANONICAL DEFINITION — IT DOES NOT INVENT ONE
// --------------------------------------------------------------------
// No new geographic engine invented HERE, no widening or narrowing of the
// service area. This dispatches to the ONE canonical resolver each source
// trusts:
//
//   PBS events    -> pbs/hsinchuFilter.js's isPbsEventHsinchuRelevant
//                    (coordinates first, then road+KM, then place names
//                     only as a corroborated fallback) — UNCHANGED by
//                     V2.4.5; see that round's own explicit "PBS 與 TDX
//                     的服務區判定必須分開" boundary.
//   TDX events    -> tdx/hsinchuGeoResolver.js's
//                    resolveTdxHsinchuGeography() (V2.4.5) — coordinates
//                    checked against real official 新竹市／新竹縣 polygons
//                    first, then (observability-only) the KM heuristic,
//                    then explicit administrative-region text. See that
//                    module's own header for the full design and
//                    07_KNOWN_ISSUES.md's V2.4.5 entry for why this
//                    replaced the OLD traffic/hsinchuFilter.js#
//                    isHsinchuRelevant() dispatch below.
//
// HISTORICAL NOTE — PRE-V2.4.5 TDX DESIGN, SUPERSEDED
// -----------------------------------------------------
// Before V2.4.5, this TDX branch called traffic/hsinchuFilter.js's own
// isHsinchuRelevant() (the SAME resolver TDX ingestion already used at
// fetch time — see tdx/sources.js), backed only by hsinchuConfig.js's own
// admittedly "best-effort, NOT verified against official 公路局/國道局
// 里程樁 data" KM ranges and a loose HSINCHU_BOUNDING_BOX. When neither a
// coordinate nor a KM survived normalization onto the event (which was
// EVERY TDX event, structurally — tdx/normalize.js never carried
// latitude/longitude forward before V2.4.5), this branch FAIL-OPENED
// ("service-area-deferred-to-ingestion") rather than re-confirming
// anything, "trusting" ingestion's own earlier admission. A real
// Production leak (台61線 39K+600, actually 桃園市觀音區— not that
// fail-open branch specifically, but the same wrong-KM-table root cause;
// see 07_KNOWN_ISSUES.md's V2.4.4 entry) proved the underlying KM table
// itself is not trustworthy enough to be the sole authority either way.
// V2.4.5's own direct human order: "TDX 對TDX必須取消這種Production
// fail-open行為... 沒有證據=UNKNOWN=不通知" (PBS's own behavior explicitly
// UNCHANGED by that same order). This paragraph is kept as a historical
// record of why the design changed, same convention as this file's own
// V2.4.4 HISTORICAL NOTE below.
//
// WHY PBS AND TDX WERE (AND STILL ARE) TREATED DIFFERENTLY
// -------------------------------------------------------------------
// A PBS event carries its own geography all the way to the broadcast
// layer — latitude/longitude, normalized road, and the description the
// ingestion filter itself reads. So this gate can re-run the EXACT
// function ingestion ran and reach the same verdict. For PBS the gate is
// therefore FAIL-CLOSED: unplaceable means blocked — UNCHANGED by V2.4.5.
//
// A TDX event, as of V2.4.5, ALSO carries its own coordinate evidence all
// the way to this gate (tdx/normalize.js now preserves `positions`/
// `latitude`/`longitude` — see that module's own V2.4.5 comment), closing
// the exact gap that used to force the fail-open branch above. TDX is
// therefore now ALSO effectively fail-closed in practice: no reliable
// coordinate/KM/text evidence either way resolves to
// resolveTdxHsinchuGeography()'s own UNKNOWN state, which this gate maps
// to `eligible:false` — the same outcome as a confirmed OUTSIDE_HSINCHU,
// per that module's own explicit design (UNKNOWN never gets more trust
// than a confirmed negative).
//
// This gate only ever SUBTRACTS. It can never make something eligible
// that the existing rules rejected.

import { isPbsEventHsinchuRelevant } from '../pbs/hsinchuFilter.js';
import { resolveTdxHsinchuGeography, HSINCHU_GEO_STATUS } from '../tdx/hsinchuGeoResolver.js';

/** TDX-side sources whose geography tdx/hsinchuGeoResolver.js knows how to resolve. */
const TDX_SOURCE_KINDS = new Set(['freeway', 'highway']);

/**
 * Is this event inside the product's service area?
 *
 * Pure and synchronous — no I/O, no env, no TDX network call. Safe to
 * call from the broadcast gate, a dry run, or a test.
 *
 * @param {object} event - a normalized unified event
 * @returns {{eligible: boolean, reason: string}} `reason` is always set on
 *   both paths so broadcastPipeline.js can aggregate it into
 *   ineligibleByReason and the Pipeline Trace exactly like every other
 *   gate's reason.
 */
export function resolveServiceAreaEligibility(event) {
  if (!event || typeof event !== 'object') {
    return { eligible: false, reason: 'service-area-unresolvable' };
  }

  if (event.source === 'pbs') {
    return isPbsEventHsinchuRelevant(event)
      ? { eligible: true, reason: 'service-area-pbs' }
      : { eligible: false, reason: 'outside-service-area' };
  }

  if (TDX_SOURCE_KINDS.has(event.source)) {
    // V2.4.5 — delegates entirely to the ONE canonical TDX geography
    // authority (tdx/hsinchuGeoResolver.js), never a second/parallel
    // judgment. CONFIRMED_HSINCHU -> eligible; OUTSIDE_HSINCHU and
    // UNKNOWN both -> ineligible (order section 十一/十三: "沒有證據=
    // UNKNOWN=不通知" — UNKNOWN is never treated as a pass here).
    const geo = resolveTdxHsinchuGeography(event);
    return geo.status === HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU
      ? { eligible: true, reason: `service-area-tdx:${geo.reason}` }
      : { eligible: false, reason: `service-area-tdx:${geo.reason}` };
  }

  // An unrecognised source cannot be placed by either resolver. Fail
  // closed rather than guess — see the header.
  return { eligible: false, reason: 'service-area-unknown-source' };
}

/** Thin boolean wrapper for call sites that don't need the reason. */
export function isWithinServiceArea(event) {
  return resolveServiceAreaEligibility(event).eligible;
}

// V2.4.4 — V2_4_4_TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX (order section
// 一/七). Production repro (2026-09-01): a TDX highway event —
// 台61線／桃園市觀音區白玉里／39K+600／雙向道路封閉 — reached real LINE.
//
// ROOT CAUSE (confirmed by reading the code, not guessed): 台61線's own
// canonical KM range in hsinchuConfig.js (`minKM:35, maxKM:75`, labeled
// "新豐 一帶 -> 香山/新竹市 一帶") was WRONG for this event — 39K+600 fell
// inside that range, so traffic/hsinchuFilter.js#isHsinchuRelevant
// legitimately (per its own, inaccurate, table) returned `true` at BOTH
// TDX ingestion (src/tdx/sources.js's own `filter: isHsinchuRelevant`)
// AND resolveServiceAreaEligibility() above (same resolver, reused) — the
// event was never in the "no evidence, defer" branch this module's own
// header already flags as a known asymmetry; it had CONFIDENT, POSITIVE,
// but factually incorrect evidence. hsinchuConfig.js's own header has
// always disclosed these KM ranges as "best-effort... NOT verified
// against official 公路局/國道局 里程樁 data" — this is the first
// confirmed case of that disclosed risk actually firing in Production.
// CORRECTION (V2.4.5) — this paragraph previously claimed "This round
// narrows the most exposed ranges" as V2.4.4's own fix; that was never
// true of what actually shipped and contradicted hsinchuConfig.js's own
// V2.4.4 comment, which explicitly documents that an early attempt to
// narrow those ranges was REVERTED (it broke ~30 existing tests) and the
// numbers were deliberately left unchanged, relying on THIS gate's text
// denylist instead. V2.4.5 has since replaced KM/coordinate resolution
// for TDX with a real official-boundary-backed resolver (tdx/
// hsinchuGeoResolver.js) as the actual positive authority — this gate's
// own denylist below is now a SECOND, independent safety net on top of
// that (order section 十六: kept deliberately, not merged or removed).
//
// THIS is the "geographic hard gate" order section 七 explicitly asks
// for and explicitly permits ("不是 semantic judgement，而是產品服務區
// 域，這一層允許 hard gate") — a SECOND, INDEPENDENT signal, checked
// immediately before LINE (traffic/aiApprovedPbsBroadcast.js), not
// merely once at candidate-build time (pbs/aiCandidate.js's own
// isWindowsPbsAiCandidateEligible, unchanged, still the first gate). It
// never widens eligibility — only narrows it further:
//
//   eligible  <=>  resolveServiceAreaEligibility(event).eligible
//                  AND NOT (a non-Hsinchu county/city/township name is
//                  positively named in the event's own text)
//
// PRODUCT SCOPE (order section 一, explicit, highest-priority, this
// round's own instruction): the current canonical service area is
// EXACTLY 新竹市／新竹縣 — nothing else. 頭份／竹南／三灣 (Miaoli County
// towns) are explicitly named in this round's order as no longer in
// scope, even though hsinchuConfig.js's own pre-V2.4.4 KM ranges/
// HSINCHU_BOUNDING_BOX comment treated 頭份 as covered ("頭份
// (24.688/120.908)... falls inside HSINCHU_BOUNDING_BOX") — recorded
// here as a deliberate product-scope NARROWING, not a bug fix to a prior
// mistake: an earlier round's own service-area definition was broader
// than what this round's direct human order now states as the current
// requirement.
//
// WHY A DENYLIST OF OTHER PLACES, NOT A WHITELIST OF HSINCHU PLACES —
// many genuine Hsinchu TDX/PBS events carry NO place name at all (only
// road+KM, e.g. "南向97K處車輛事故") — a whitelist requiring an
// affirmative Hsinchu place name would wrongly block those. A denylist
// only ever SUBTRACTS: it fires only when the event's own text
// positively names a DIFFERENT county/city/township, which a genuinely
// Hsinchu-relevant TDX/PBS record has no legitimate reason to state
// (same "only block on positive evidence" principle this module already
// uses for KM/coordinates — extended to text, which is exactly the
// signal that would have caught today's leak: the raw TDX text itself
// said 桃園市觀音區). Deliberately NOT a large event-type/keyword
// whitelist or blacklist (order section 二's own prohibition) — this is
// pure geography, a fixed, short list of Taiwan's OTHER top-level
// administrative divisions plus the two specifically-named Miaoli towns,
// never event semantics.
//
// KNOWN TRADE-OFF, accepted deliberately: an event that IS genuinely in
// Hsinchu but whose own text happens to name another place only as a
// travel direction (e.g. "新竹路段往桃園方向") would also be blocked by
// this gate. Given this round's own explicit priority ("除此之外全部不
// 得主動LINE" / "LINE 必須 = 0"), under-broadcasting a rare edge case is
// the correct, ordered bias over ever repeating today's leak.
const NON_HSINCHU_PLACE_TOKENS = [
  // Other cities/counties (short forms — the forms TDX/PBS free text
  // actually uses; none is a substring of any Hsinchu place name).
  '台北', '新北', '桃園', '台中', '台南', '高雄', '基隆', '嘉義',
  '苗栗', '彰化', '南投', '雲林', '屏東', '宜蘭', '花蓮', '台東',
  '澎湖', '金門', '連江',
  // Miaoli townships explicitly named in this round's order as no
  // longer in scope (adjacent to, but administratively outside, Hsinchu).
  '頭份', '竹南', '三灣',
];

function collectEventPlaceText(event) {
  if (!event) return '';
  return [event.description, event.locationDescription, event.location, event.title]
    .filter((v) => typeof v === 'string' && v)
    .join(' ');
}

/**
 * The Production notify hard gate (order section 七) — call this
 * immediately before a real LINE send is even considered, for EVERY
 * source, never only TDX. Purely SUBTRACTS from resolveServiceAreaEligibility's
 * own verdict; can never make something eligible that resolver rejected.
 *
 * @param {object} event - a normalized unified event
 * @returns {{eligible: boolean, reason: string}}
 */
export function resolveHsinchuOnlyProductionEligibility(event) {
  const base = resolveServiceAreaEligibility(event);
  if (!base.eligible) return base;

  const text = collectEventPlaceText(event);
  const matchedToken = NON_HSINCHU_PLACE_TOKENS.find((token) => text.includes(token));
  if (matchedToken) {
    return { eligible: false, reason: `hsinchu-only-gate-non-hsinchu-place:${matchedToken}` };
  }

  return { eligible: true, reason: 'hsinchu-only-gate-pass' };
}
