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
// The canonical area in hsinchuConfig.js already covers the four places
// the product serves — verified against real coordinates: 新竹市
// (24.804/120.965), 竹北 (24.839/121.013), 竹南 (24.686/120.876) and 頭份
// (24.688/120.908) all fall inside HSINCHU_BOUNDING_BOX, while 八堵
// (25.103/121.718) falls outside. So nothing here needed to change to
// satisfy "新竹／竹北／竹南／頭份", and nothing was changed.
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
