// V2.4.10 — 路況工程部｜V2.4.10 TDX 國道公里數第二正向地理證據設計／施工令
// (V2_4_10_TDX_FREEWAY_KM_HSINCHU_DETERMINISTIC_GEO_FALLBACK).
//
// TDX ONLY. NEVER imported by or reused for PBS (order section 十八) — PBS
// keeps its own, completely separate service-area path
// (pbs/hsinchuFilter.js) untouched.
//
// WHY THIS EXISTS
// ----------------
// A common TDX｜高公局 event shape has road + direction + KM but NO
// coordinates and NO areaNm (e.g. real Production events "國道一號 北向
// 101K+300 施工事件-施工維護" / "國道一號 南向 100K+000 天候事件-天候
// 不佳" / "國道三號 北向 79K+000 其他異常告警-散落物" — see
// 07_KNOWN_ISSUES.md's V2.4.9 entry). hsinchuGeoResolver.js's Tier 1
// (coordinates) and Tier 2/text tier both return no verdict for these —
// they fall all the way to UNKNOWN (0 Queue/0 AI/0 LINE), even though the
// KM alone, for THESE TWO SPECIFIC ROADS, is enough to positively place
// the event inside 新竹市/新竹縣 once cross-referenced against real
// official geometry.
//
// DATA PROVENANCE (order section 五 — government open data only, never a
// web-search summary/forum/blog/AI memory as production authority)
// ---------------------------------------------------------------------
// The verified ranges below were computed by cross-referencing TWO
// independent official government datasets already bundled in this repo,
// using the SAME point-in-polygon function hsinchuGeoResolver.js's own
// Tier 1 coordinate check already trusts (never a second/different
// algorithm):
//
//   1. 國道百公尺里程樁（data.gov.tw dataset 95016，交通部高速公路局）
//      — data/road-location/generated/freeway.js. Real road-centerline
//      lat/lng at every 0.1km marker along each freeway (10,035 points
//      total, fetched 2026-08-20, dataset updated 2024-08-01).
//   2. 直轄市、縣市界線（data.gov.tw dataset 7442，內政部國土測繪中心）
//      — data/hsinchu-boundary/generated/hsinchuBoundary.js. The SAME
//      official administrative-boundary polygon already used as this
//      project's one positive coordinate authority (see that module's
//      own SOURCE_META.json for full shapefile provenance).
//
// METHOD (reproducible — see scripts/verifyHsinchuFreewayKmRanges.mjs)
// ---------------------------------------------------------------------
// Every 0.1km milestone point for 國道一號 and 國道三號 was tested with
// isPointInRings(lon, lat, HSINCHU_CITY.rings || HSINCHU_COUNTY.rings)
// (src/tdx/hsinchuGeoResolver.js's own exported function). Both roads
// produced exactly ONE contiguous "inside" span each, with a single sharp
// transition at each end (verified by inspecting every 0.1km point within
// ±1.5km of each computed boundary — no flicker/noise found):
//
//   國道一號 (Freeway 1): raw computed span 75.2K – 107.3K
//     (75.2–92.4 新竹縣, 92.5–96.6 新竹市, 96.7–105.9 新竹縣,
//      106.0–107.3 新竹市 — all immediately adjacent, zero gaps)
//   國道三號 (Freeway 3): raw computed span 74.6K – 109.4K
//     (74.6–102.7 新竹縣, 102.8–109.4 新竹市 — immediately adjacent)
//
// Sanity cross-check against the bundled official interchange dataset
// (data/road-location/generated/freewayFacilities.js, data.gov.tw
// 166496/8161, same 交通部高速公路局 agency): 湖口(83K)/竹北(91K)/新竹
// (95K)/新竹系統(99K, 國1＆國3) all fall inside the raw computed span;
// 頭份(110K)/苗栗(132K, 國1) and 竹南(119K)/後龍(130K, 國3) — all
// 苗栗縣 — correctly fall OUTSIDE it. 香山交流道(109K, 國3) — a real
// interchange known to straddle the 新竹市/苗栗縣 boundary — falls just
// inside the raw span (109.4K) but, deliberately, just OUTSIDE the
// safety-margined range below (108.9K): see "SAFETY MARGIN" next.
//
// SAFETY MARGIN (order section 六 — boundary must be conservative)
// ---------------------------------------------------------------------
// 0.5km trimmed inward from EACH end of each raw computed span before
// shipping. The underlying 0.1km-resolution data itself showed sharp,
// noise-free transitions (not an "estimated" boundary needing a large
// buffer like the pre-existing, admittedly-unverified
// traffic/hsinchuConfig.js#FREEWAY_RULES table's own 3km
// KM_BOUNDARY_BUFFER_KM) — but a modest margin is still kept as
// deliberate, honest insurance against residual milestone-marker/polygon-
// edge precision, exactly as this order's own section 六 requires. This
// margin correctly excludes 香山交流道 (109K) from the FINAL range even
// though it barely cleared the raw computed boundary — matching its real
// known status as a boundary-straddling interchange, not a genuine
// interior point. VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM = 0.5.
//
// FINAL VERIFIED RANGES (after the 0.5km safety margin)
// ---------------------------------------------------------------------
//   國道一號: 75.7K – 106.8K
//   國道三號: 75.1K – 108.9K
//
// PRODUCTION AUTHORITY BOUNDARIES (never exceeded by this module)
// ---------------------------------------------------------------------
// - Order section 三: this table is consulted ONLY when the event carries
//   NO coordinates at all (hsinchuGeoResolver.js's Tier 1 already returns
//   before this tier is ever reached whenever coordinates are present —
//   see that module's own resolveTdxHsinchuGeography()). Coordinates
//   ALWAYS win; this module is never even called when they exist.
// - Order section 十一: a KM OUTSIDE these ranges is NEVER read as
//   OUTSIDE_HSINCHU — this module returns null (→ caller falls to
//   UNKNOWN) for any non-matching road/km, exactly like "no evidence".
//   Only coordinates or explicit place-name text (hsinchuGeoResolver.js's
//   own existing tiers) may ever produce OUTSIDE_HSINCHU.
// - No KV, no I/O, no async, no network (order section 十五/十六) — this
//   whole module is a static data table plus one pure, synchronous
//   lookup function.

import { canonicalFreewayRoad } from '../traffic/roadIdentity.js';

/** order section 十七's own literal evidence-type string. */
export const FREEWAY_KM_EVIDENCE_TYPE = 'FREEWAY_KM_VERIFIED_RANGE';

export const VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM = 0.5;

const EVIDENCE_SOURCE =
  '國道百公尺里程樁 (data.gov.tw dataset 95016, 交通部高速公路局) × ' +
  '直轄市、縣市界線 (data.gov.tw dataset 7442, 內政部國土測繪中心) — ' +
  'cross-referenced via isPointInRings() at 0.1km resolution, 0.5km safety margin applied';

const VERIFIED_AT = '2026-09-04';

// order section 四 — static program data, never KV. Each road's `ranges`
// is deliberately an array (not a single min/max pair) so a future round
// covering a road with a genuine gap (e.g. a route that briefly leaves
// Hsinchu and re-enters) can add a second entry without changing this
// module's shape — 國道一號/國道三號 both currently resolve to exactly
// one contiguous span each (see this file's own header derivation).
export const HSINCHU_VERIFIED_FREEWAY_KM_RANGES = Object.freeze({
  國道一號: Object.freeze({
    ranges: [
      Object.freeze({
        minKm: 75.7,
        maxKm: 106.8,
        jurisdiction: 'HSINCHU',
        evidenceSource: EVIDENCE_SOURCE,
        verifiedAt: VERIFIED_AT,
      }),
    ],
  }),
  國道三號: Object.freeze({
    ranges: [
      Object.freeze({
        minKm: 75.1,
        maxKm: 108.9,
        jurisdiction: 'HSINCHU',
        evidenceSource: EVIDENCE_SOURCE,
        verifiedAt: VERIFIED_AT,
      }),
    ],
  }),
});

/**
 * order section 十五 — PURE, SYNCHRONOUS, ZERO I/O. Simple array lookup
 * over at most two roads × one range each (order section 十六 — no
 * interval tree/spatial DB needed at this scale).
 *
 * @param {{road: string, displayKM: number|null|undefined}} params -
 *   `road` is any raw road string (canonicalized here via the SAME
 *   traffic/roadIdentity.js#canonicalFreewayRoad() every other module in
 *   this codebase already uses — order section 八, never a second/
 *   conflicting road parser); `displayKM` MUST be the already-normalized
 *   canonical field tdx/normalize.js#normalizeRoadEvent() sets (order
 *   section 九 — never a raw re-parse of description here).
 * @returns {{road: string, km: number, matchedRange: object}|null} - a
 *   match object when `road` is a recognized 國道一號/國道三號 form AND
 *   `displayKM` falls inside one of that road's verified ranges; `null`
 *   otherwise (unrecognized road, missing/non-finite KM, or KM outside
 *   every verified range) — `null` NEVER means OUTSIDE_HSINCHU, only "this
 *   tier has no positive evidence" (order section 十一).
 */
export function resolveVerifiedHsinchuFreewayKm({ road, displayKM } = {}) {
  const canonical = canonicalFreewayRoad(road);
  if (!canonical) return null;

  const table = HSINCHU_VERIFIED_FREEWAY_KM_RANGES[canonical];
  if (!table) return null; // recognized freeway, but not one this round covers (order section 七)

  if (typeof displayKM !== 'number' || !Number.isFinite(displayKM)) return null;

  const matchedRange = table.ranges.find((r) => displayKM >= r.minKm && displayKM <= r.maxKm);
  if (!matchedRange) return null;

  return { road: canonical, km: displayKM, matchedRange };
}
