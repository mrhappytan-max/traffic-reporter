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
// No new geographic engine, no new bounding box, no new KM table, and no
// widening or narrowing of the service area. This dispatches to the
// resolvers the product already trusts:
//
//   PBS events    -> pbs/hsinchuFilter.js's isPbsEventHsinchuRelevant
//                    (coordinates first, then road+KM, then place names
//                     only as a corroborated fallback)
//   TDX events    -> traffic/hsinchuFilter.js's isHsinchuRelevant
//                    (FREEWAY_RULES / HIGHWAY_RULES + the bounding box in
//                     traffic/hsinchuConfig.js)
//
// The canonical area in hsinchuConfig.js covers 新竹市 (24.804/120.965)
// and 竹北 (24.839/121.013), while 八堵 (25.103/121.718) falls outside.
// HISTORICAL NOTE (superseded by V2.4.4, see this file's own V2.4.4
// comment below) — this paragraph originally also listed 竹南
// (24.686/120.876) and 頭份 (24.688/120.908) as intentionally covered;
// both are Miaoli County towns, and a direct 2026-09-01 human order now
// states the current, highest-priority canonical service area as EXACTLY
// 新竹市／新竹縣 — 頭份／竹南 are no longer in scope. HSINCHU_BOUNDING_BOX
// itself (a secondary, KM-unparseable-only fallback) is UNCHANGED this
// round and may still geometrically include them; the new
// resolveHsinchuOnlyProductionEligibility() hard gate is what actually
// excludes them from a real LINE send now, by name, regardless of which
// coordinate/KM path admitted the event.
//
// WHY PBS AND TDX ARE TREATED DIFFERENTLY (this is not an oversight)
// -------------------------------------------------------------------
// A PBS event carries its own geography all the way to the broadcast
// layer — latitude/longitude, normalized road, and the description the
// ingestion filter itself reads. So this gate can re-run the EXACT
// function ingestion ran and reach the same verdict. For PBS the gate is
// therefore FAIL-CLOSED: unplaceable means blocked.
//
// A normalized TDX event does not. tdx/normalize.js keeps road/KM but not
// the raw `Positions`, and ingestion (traffic/hsinchuFilter.js) admits an
// event on EITHER coordinates OR road+KM. So a TDX event admitted at
// ingestion on its coordinates arrives here with the deciding evidence
// already discarded. Re-judging it fail-closed would silently stop
// broadcasting perfectly valid TDX traffic the moment KM is missing —
// a bigger bug than the one this module exists to fix, and one that would
// only appear after TDX is restored, i.e. exactly when nobody is looking
// for it. (Measured, not assumed: doing so broke 35 existing tests whose
// TDX fixtures carry a road but no KM.)
//
// So for TDX sources the gate blocks only on POSITIVE evidence of being
// outside — a road+KM that the canonical rules place outside the area.
// An unplaceable TDX event is left to the layer that still has the
// evidence: ingestion, which is fail-closed and unchanged.
//
// That asymmetry is safe because the two layers compose:
//   ingestion        — fail-closed admission, sees ALL the evidence
//   this gate        — catches anything that reaches broadcast while
//                      demonstrably outside the area (the 八堵 shape)
//
// This gate only ever SUBTRACTS. It can never make something eligible
// that the existing rules rejected.

import { isPbsEventHsinchuRelevant } from '../pbs/hsinchuFilter.js';
import { isHsinchuRelevant } from './hsinchuFilter.js';

/** TDX-side sources whose geography traffic/hsinchuFilter.js knows how to resolve. */
const TDX_SOURCE_KINDS = new Set(['freeway', 'highway']);

/**
 * Does this TDX event carry geography this gate can actually judge?
 * True only when there is a usable coordinate pair or a real KM value —
 * i.e. when "not inside" genuinely means "outside" rather than "unknown".
 */
function hasPlaceableTdxGeography(event) {
  if (event.latitude != null && event.longitude != null) return true;
  const km = [event.startKM, event.endKM];
  return km.some((v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(String(v).replace(/[^0-9.\-]/g, ''))));
}

/**
 * Is this event inside the product's service area?
 *
 * Pure and synchronous — no I/O, no env, no TDX. Safe to call from the
 * broadcast gate, a dry run, or a test.
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
    // isHsinchuRelevant takes the raw record purely to read coordinates;
    // a normalized TDX event has none, so coordinates are supplied only
    // when the event itself happens to carry them.
    const raw =
      event.latitude != null && event.longitude != null
        ? { Positions: [{ PositionLon: event.longitude, PositionLat: event.latitude }] }
        : {};
    if (isHsinchuRelevant(event, raw)) return { eligible: true, reason: 'service-area-tdx' };

    // Not confirmed inside. Only BLOCK when we can positively place it
    // outside; otherwise defer to ingestion, which still had the evidence
    // this event no longer carries. See the header for why this is not
    // fail-closed.
    return hasPlaceableTdxGeography(event)
      ? { eligible: false, reason: 'outside-service-area' }
      : { eligible: true, reason: 'service-area-deferred-to-ingestion' };
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
// This round narrows the most exposed ranges (see hsinchuConfig.js's own
// V2.4.4 comment) as a partial mitigation, but this session still has NO
// live mapping/official-mileage data access to fully re-verify every
// range with confidence — so KM/coordinate resolution ALONE is no longer
// treated as sufficient at the one point that actually gates a real LINE
// send.
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
