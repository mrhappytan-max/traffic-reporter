// V1.7 next stage — one-time Production CCTV feasibility probe, targeted
// at a fixed incident location: 國道1號 82K+100 (targetKm = 82.1).
// Admin Auth gated (see index.js's ADMIN_PATHS / security/adminAuth.js).
// Same PRE-ARM one-time-use principle as tdx/cctvProbe.js, but scoped to
// its own independent KV keys so a bug here can never affect that
// module's guard (or vice versa) — see module-isolation convention used
// throughout this project (dedupe.js vs. notified.js vs. pbs lifecycle
// vs. tdxEventCache.js, etc.).
//
// Four endpoints, four concerns, cleanly separated:
//   - GET /admin/cctv-hsinchu-probe        — STEP 1+2+4: the ONE allowed
//     TDX CCTV metadata call (only on the very first, never-attempted
//     request), local four-quadrant selection, persisting up to 4
//     candidates to KV, and rendering the mobile HTML page. On every
//     later request it only ever reads the candidates KV — see below,
//     this file's import graph makes a second TDX call structurally
//     impossible once the guard is armed/completed.
//   - GET /admin/cctv-hsinchu-frame/0..3    — STEP 3: fetches ONE JPEG
//     frame from the CCTV's own VideoStreamURL (a freeway.gov.tw MJPEG
//     stream), never touching TDX at all. This handler does not import
//     getAccessToken/fetchTdxJson/anything TDX-related — "0 TDX calls"
//     is enforced by the import graph itself, not just by convention.
//   - GET /admin/cctv-hsinchu-collage       — V1.8: composes the (up to)
//     4 quadrant frames into a single 2x2 collage JPEG (see
//     cctv/collage.js). Strictly read-only against the candidates KV —
//     never triggers /admin/cctv-hsinchu-probe, never rebuilds the
//     candidate list, and (like the frame endpoint above) never calls
//     getAccessToken/fetchTdxJson: 0 TDX calls, same guarantee, same
//     reasoning. If the candidates KV is absent/expired, responds with a
//     clear "CCTV candidate cache unavailable" message rather than
//     silently calling TDX to repopulate it.
//   - GET /admin/cctv-hsinchu-publish-test — V1.8.4, REPAIRED 2026-08-30
//     (CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR — real incident
//     EVENT_ID=11508310005-5: LINE delivered a broken image, and this
//     was the one diagnostic tool that could have directly verified
//     "does /cctv/image/:id genuinely return 200+JPEG right after
//     publish" — but it depended on CANDIDATES_KEY, a cache ONLY
//     /admin/cctv-hsinchu-probe can (re)populate, and that probe makes a
//     real TDX API call, which this project's own TRAFFIC_SOURCE_MODE=
//     PBS_ONLY governance forbids spending on a diagnostic run). Now
//     composes from the SAME cctv:freeway-metadata:v1 inventory cache
//     the real per-accident dynamic broadcast path already reads
//     cache-only (see cctv/freewayCctvMetadataCache.js and
//     cctv/dynamicCollage.js) — composeCollageFromFreewayMetadata below
//     calls readFreewayCctvMetadataCache (never TDX) +
//     selectFourQuadrantCandidates (the SAME quadrant-selection function
//     the fixed-target admin probe path already uses, at its own fixed
//     TARGET_ROAD_ID/TARGET_KM defaults — no new selection policy) +
//     the SAME composeCollageFromCandidates fetch/compose core every
//     other collage path already shares (never a second, divergent
//     orchestration path) — then publishes the JPEG to R2
//     (env.CCTV_IMAGES — see cctv/publishedImage.js's module comment for
//     why R2, not KV: strong read-after-write consistency, needed
//     because a future LINE push could fetch the URL from a different
//     Cloudflare location almost immediately) under a fresh opaque id,
//     returning a short-lived public HTTPS URL a future LINE Messaging
//     API call could use directly. TDX_CALLS_PER_TEST = 0 — this
//     handler's own import graph never reaches getAccessToken/
//     fetchTdxJson, same structural guarantee the frame/collage
//     endpoints above already rely on. Never calls PBS, the AI decision
//     path, the Queue, or LINE. CCTV candidate storage (CANDIDATES_KEY
//     below) is entirely unrelated to this endpoint now — it stays on
//     TRAFFIC_KV, read only by the fixed-target probe/collage pair
//     above; published-image storage uses R2. See
//     cctv/publishedImage.js's module comment for the public GET
//     /cctv/image/:id read path this feeds — that route lives in a
//     separate module and is deliberately NOT in ADMIN_PATHS, since
//     LINE's servers cannot carry our Basic Auth. On any failure, the
//     JSON response's own `step` field distinguishes exactly which stage
//     failed (METADATA_CACHE_MISSING / NO_CCTV_CANDIDATES /
//     SNAPSHOT_FETCH_FAILED / COMPOSE_FAILED / R2_PUBLISH_FAILED) —
//     never a single opaque "CCTV candidate cache unavailable" for every
//     possible cause, which was the old failure mode's own diagnostic
//     dead end.
//
// V1.7 CCTV 四象限選鏡規則 / 4-camera cross-direction search — RATIFIED,
// see PROJECT_HANDOFF.md section 14 for the full rationale. Supersedes
// the earlier "nearest 5 CCTV by KM distance" approach. Given the fixed
// incident point TARGET_KM, this module searches exactly 4 fixed
// quadrants — never more, single first pass, never a second TDX call:
//   1. S, km < TARGET_KM — nearest southbound camera BEFORE the incident.
//   2. S, km > TARGET_KM — nearest southbound camera AFTER the incident.
//   3. N, km < TARGET_KM — nearest northbound camera BEFORE the incident.
//   4. N, km > TARGET_KM — nearest northbound camera AFTER the incident.
// Rationale: national freeway PTZ CCTV units are steerable and are
// frequently panned by 交控中心 to point at an incident regardless of
// which carriageway they're physically mounted on — a southbound
// incident may in practice be best seen by a northbound camera turned to
// face across the median. A same-direction-only or plain-nearest-N
// selector can silently miss the camera that actually shows the scene.
// Distance strategy per quadrant, independently: prefer a candidate
// within +/-2km of TARGET_KM; if none, widen to +/-4km for that quadrant
// only; if still none, leave that quadrant empty (index stays null) —
// never reach further just to fill the slot, and never exceed 4 cameras
// total in this first pass.
//
// V1.8.1/V1.8.2 hard rule (post-Production-testing fixes): the
// four-quadrant search runs ONLY over an "eligible mainline CCTV pool"
// — records for a device physically INSIDE a service area/rest stop
// (服務區/休息站/服務站) are excluded BEFORE distance ranking, never
// merely deprioritized after the fact. Detection keys off the device's
// OWN identifier (CCTVID) and LocationType-as-literal-text only — NOT
// RoadSection/RoadName, which describe a road segment that can
// legitimately mention a service area as one of its endpoints without
// the camera being inside it (a mainline camera near 湖口服務區 was a
// real false-positive caught in V1.8.2). See isServiceAreaCctv's own
// comment for the full rationale and why LocationType's numeric
// semantics are deliberately NOT assumed.
//
// PRE-ARM guard (admin:cctv-hsinchu-probe-used:v1) — identical ordering
// principle to tdx/cctvProbe.js's V1.7 fix:
//   1. Read KV state before any TDX call at all. 'armed' or 'completed'
//      -> stop, 0 TDX calls.
//   2. (absent) -> write 'armed' BEFORE getAccessToken(). Write failure
//      -> fail closed 503, 0 TDX calls, no retry.
//   3. OAuth failure -> KV stays 'armed', locked, no auto-retry.
//   4. The ONE CCTV metadata call. Failure -> KV stays 'armed', locked,
//      no retry.
//   5. Success -> four-quadrant select (at most 4 candidates, some slots
//      possibly null) -> persist candidates (own key, 1h TTL) -> flip
//      'armed' -> 'completed'. If that last write fails, KV simply stays
//      'armed' (a failed put never partially commits) — still fully
//      locked either way.
// No auto-reset, no reset endpoint — a human must manually delete
// admin:cctv-hsinchu-probe-used:v1 (and, if desired,
// admin:cctv-hsinchu-candidates:v1) to run this again.
//
// Never placed anywhere in any response: TDX_CLIENT_ID/TDX_CLIENT_SECRET
// /the OAuth access token/any Authorization header value.

import { getAccessToken } from './auth.js';
import { fetchTdxJson, TdxApiError } from './client.js';
import { parseKM } from '../traffic/roadSectionLabel.js';
import { toTaipeiParts } from '../traffic/broadcastHours.js';
import { composeQuadrantCollage } from '../cctv/collage.js';
import { publishCollageImage } from '../cctv/publishedImage.js';
import { writeFreewayCctvMetadataCache, readFreewayCctvMetadataCache } from '../cctv/freewayCctvMetadataCache.js';

// cctv/jpegCodecWorker.js does a top-level `import ... from '*.wasm'` —
// the only WASM-loading mechanism Cloudflare Workers actually supports
// (see that file's module comment). Plain Node has no ESM loader for
// `.wasm` files, and every test file in this project imports
// src/index.js (which imports this file) at the top level — so a static
// top-level import of jpegCodecWorker.js here would break the ENTIRE
// test suite the instant any test file loads, not just the new
// collage tests. Loaded lazily instead, via dynamic import() ONLY
// inside handleHsinchuCctvCollage, and only when actually needed (see
// below) — merely parsing/loading this file never touches it. Tests
// exercise the real orchestration logic either via the `codecOverride`
// parameter (see handleHsinchuCctvCollage's own doc comment) or via
// paths that never need a codec at all (0 successful fetches).
function loadProductionJpegCodec() {
  return import('../cctv/jpegCodecWorker.js');
}

// V1.8.3 — Traditional Chinese quadrant labels for the collage image
// (see bitmapFont.js's module comment for the hand-authored CJK glyph
// set). Index-aligned with QUADRANTS below — never reordered; this is
// purely a display-string change, not a selection-logic change.
// Exported for direct unit testing (image text isn't OCR-able).
export const CJK_QUADRANT_LABELS = ['南前', '南後', '北前', '北後'];

export const PROBE_USED_KEY = 'admin:cctv-hsinchu-probe-used:v1';
export const CANDIDATES_KEY = 'admin:cctv-hsinchu-candidates:v1';
const CANDIDATES_TTL_SECONDS = 3600; // 1 hour

// Full freeway CCTV list — deliberately NO $top here (unlike
// tdx/cctvProbe.js's $top=1) because four-quadrant selection needs to
// compare across every record on the target road to find the nearest
// candidate in each of the 4 quadrants around the target KM; filtering
// happens locally in this Worker, per spec. Exported so
// cctv/dynamicCollage.js's shared metadata cache fetches the exact same
// endpoint — never a second, possibly-drifting URL literal.
export const CCTV_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$format=JSON';

// V1.8.5: exported (with the road-name pattern alongside it) so
// cctv/dynamicCollage.js's per-accident CCTV_SUPPORTED_ROADS registry can
// reuse the SAME Production-confirmed 國道一號 CCTV RoadID/RoadName match
// this module has used since V1.7, rather than re-deriving/guessing a
// second copy of it. These three (TARGET_ROAD_ID/TARGET_ROAD_NAME_PATTERN/
// TARGET_KM) remain this module's own DEFAULTS for the fixed-target admin
// probe/collage/publish-test endpoints below — unchanged behavior for
// every existing caller.
export const TARGET_ROAD_ID = '000010';
export const TARGET_ROAD_NAME_PATTERN = /國道1號|國道一號/;
export const TARGET_KM = 82.1; // 國道1號 82K+100
const NEAR_RADIUS_KM = 2; // preferred radius per quadrant
const WIDE_RADIUS_KM = 4; // fallback radius per quadrant if the near radius is empty
const CANDIDATE_COUNT = 4; // fixed: S-before, S-after, N-before, N-after — never more

// Quadrant slot definitions, index-aligned with the persisted candidates
// array and with /admin/cctv-hsinchu-frame/<index>. `direction` matches
// against a normalized S/N form of the record's RoadDirection/Direction
// field; `side` picks which side of TARGET_KM this slot covers.
const QUADRANTS = [
  { label: 'S前', direction: 'S', side: 'before' },
  { label: 'S後', direction: 'S', side: 'after' },
  { label: 'N前', direction: 'N', side: 'before' },
  { label: 'N後', direction: 'N', side: 'after' },
];

const TRUSTED_IMAGE_HOST_SUFFIX = 'freeway.gov.tw';
export const MAX_FRAME_BYTES = 2 * 1024 * 1024; // 2 MB
export const FRAME_TIMEOUT_MS = 5000; // ~5 seconds

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function firstDefinedField(record, candidateNames) {
  for (const name of candidateNames) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name];
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// V1.8.5: parameterized (was hardcoded to the fixed 國道一號 test
// target) so selectFourQuadrantCandidates below can match against ANY
// road this app has a confirmed CCTV roadId/roadNamePattern for — see
// cctv/dynamicCollage.js's CCTV_SUPPORTED_ROADS. Defaults preserve the
// exact original behavior for every existing (fixed-target) caller.
// V1.8.7.5 — RoadID is now AUTHORITATIVE whenever present, never merely
// one of two OR'd alternatives. Real Production metadata (confirmed via
// a read-only Production TRAFFIC_KV inspection, cited in
// cctv/dynamicCollage.js's CCTV_SUPPORTED_ROADS comment) contains a
// small number of genuinely dirty records — a structured RoadID that
// disagrees with its own free-text RoadName (e.g. RoadID:'000030' paired
// with RoadName:'國道1號', or the reverse). Under the OLD pure-OR rule,
// such a record could leak into BOTH roads' candidate pools at once
// (matching one road by RoadID, the other by RoadName) — real
// cross-road contamination risk now that this registry covers more than
// one road, not merely a hypothetical. RoadID is the more specific,
// structured field, so it wins outright whenever present: a record
// whose RoadID clearly names a DIFFERENT road is excluded even if its
// RoadName happens to match, rather than being rescued by that
// mismatched text. RoadName-pattern matching is now used ONLY as a
// fallback for the (today, apparently rare or nonexistent per this same
// audit) case where a record carries no RoadID at all. This is a general
// rule, not scoped to any specific road/KM — it changes how EVERY road's
// pool is built, including the pre-existing 國1 fixed-target admin
// endpoints, which is safe: no existing test or real 國1 record has ever
// depended on the OR-fallback actually firing (RoadID:'000010' has
// always been present and correct for real 國1 records).
function isTargetRoad(record, { roadId = TARGET_ROAD_ID, roadNamePattern = TARGET_ROAD_NAME_PATTERN } = {}) {
  const recordRoadId = firstDefinedField(record, ['RoadID', 'RoadId']);
  if (recordRoadId !== null) return recordRoadId === roadId;
  const roadName = firstDefinedField(record, ['RoadName']);
  return typeof roadName === 'string' && roadNamePattern.test(roadName);
}

// V1.8.1 hard rule (post-Production-testing fix): a CCTV physically
// physically INSIDE a service area / rest stop (服務區/休息站/服務站 —
// e.g. a camera pointed at 湖口服務區's own parking lot or fuel station)
// must NEVER be selected as an incident camera, no matter how close its
// KM is to the incident — such a camera cannot be assumed to show the
// freeway mainline at all. See PROJECT_HANDOFF.md's V1.8 section for
// the full rationale.
//
// V1.8.2 correction: the first version of this rule scanned EVERY
// string-valued field on the record — including RoadSection — for the
// keywords below. That was too broad and produced false positives: a
// genuine MAINLINE camera's RoadSection can legitimately read something
// like "湖口交流道-湖口服務區" or "湖口服務區-竹北交流道" (the service
// area is simply one of the two endpoints describing which stretch of
// mainline the camera covers) — mentioning a service area in a road
// SEGMENT description is not the same as the camera being INSIDE that
// service area. Excluding on RoadSection alone would have thrown out
// real mainline cameras near 湖口服務區. Narrowed to the two fields that
// actually identify what the DEVICE ITSELF is/is at, not what stretch
// of road it covers:
//   1. CCTVID/CCTVId/ID — device identifiers observed in the real
//      Production feed encode the camera's own siting directly, e.g.
//      `CCTV-N1-N-86-R-湖口(北)服務區-停車場-1` ("停車場" = parking lot)
//      unambiguously names the camera's own location, not a road-segment
//      description.
//   2. LocationType — ONLY if its value is itself a literal, human-
//      readable string that names a service area/rest stop (e.g. a
//      value that IS "服務區"). This is not a numeric/enum assumption:
//      TDX's live API and documentation are both unreachable from this
//      development sandbox (network egress to tdx.transportdata.tw is
//      blocked, reconfirmed this round via curl and WebFetch), so
//      LocationType's actual value set has never been observed here —
//      "不要猜 LocationType 數值代表什麼" is honored by only ever
//      matching it as literal text, exactly like CCTVID, never as a
//      guessed code.
// RoadSection and RoadName are deliberately EXCLUDED from this check —
// they describe a road SEGMENT (which may legitimately span or border a
// service area) and are not reliable evidence the device itself is
// inside one. If TDX ever exposes another field that reliably describes
// the DEVICE's own siting (not the segment it covers), it can be added
// here — but only with the same reasoning documented, never as a blanket
// scan of every field again.
//
// Deliberately narrow scope, unchanged from V1.8.1: only 服務區/休息站/
// 服務站. Interchanges, ramps, system interchanges, tunnels, and bridges
// are NOT excluded by this rule — a separate, not-yet-made decision.
const SERVICE_AREA_KEYWORDS = ['服務區', '休息站', '服務站'];

function isServiceAreaCctv(record) {
  const deviceId = firstDefinedField(record, ['CCTVID', 'CCTVId', 'ID']);
  if (typeof deviceId === 'string' && SERVICE_AREA_KEYWORDS.some((keyword) => deviceId.includes(keyword))) return true;

  const locationType = record.LocationType;
  if (typeof locationType === 'string' && SERVICE_AREA_KEYWORDS.some((keyword) => locationType.includes(keyword))) return true;

  return false;
}

/** Normalizes a raw RoadDirection/Direction field value to 'S', 'N', or
 * null (unrecognized). Accepts TDX's short codes ('S'/'N') as well as
 * common textual variants defensively — TDX field content has been
 * observed to vary in casing/verbosity across endpoints.
 *
 * V1.8.7.0: exported so cctv/dynamicCollage.js's single-camera Dynamic
 * Shoulder selector can normalize an EVENT's own `direction` field
 * ('南向'/'北向'/etc, the SAME free-text shape this function already
 * accepts) to the identical S/N form the CCTV metadata pool uses —
 * never a second, independently-written direction parser. */
export function normalizeDirection(rawDirection) {
  if (typeof rawDirection !== 'string') return null;
  const value = rawDirection.trim().toUpperCase();
  if (value === 'S' || value === '南' || value === '南向' || value.startsWith('SOUTH')) return 'S';
  if (value === 'N' || value === '北' || value === '北向' || value.startsWith('NORTH')) return 'N';
  return null;
}

/**
 * V1.7 four-quadrant selector — see module comment and
 * PROJECT_HANDOFF.md section 14 for the ratified rule. Returns a fixed
 * CANDIDATE_COUNT-length array, index-aligned to QUADRANTS (S前/S後/N前/
 * N後); any quadrant with no eligible candidate within +/-WIDE_RADIUS_KM
 * is `null` at that index — never omitted, never backfilled from another
 * quadrant, never more than 4 entries total.
 *
 * V1.8.5: `roadId`/`roadNamePattern`/`targetKm` are now parameters (were
 * hardcoded module constants) so this SAME selector — same four-quadrant
 * rule, same ±2km/±4km/null distance strategy, same service-area
 * exclusion, completely unchanged — can be reused for a dynamic
 * accident's own road/KM (see cctv/dynamicCollage.js) instead of only
 * ever running against the fixed 國道一號 82K+100 test target. Defaults
 * preserve the exact original fixed-target behavior for every existing
 * caller (handleHsinchuCctvProbe below).
 */
// V1.8.7.0 — extracted, UNCHANGED, from selectFourQuadrantCandidates'
// own former inline loop, specifically so cctv/dynamicCollage.js's
// single-camera Dynamic Shoulder selector (selectSingleShoulderCandidate
// below) can reuse the EXACT SAME "eligible mainline CCTV pool" build —
// same road-match, same service-area exclusion (checked BEFORE any
// distance/range comparison, for the same reason documented on
// isServiceAreaCctv), same required-field checks — rather than a second,
// independently-maintained copy that could quietly drift (e.g. one day
// stop excluding service-area cameras from the single-camera path only).
// `targetKm` is optional here (unlike the 4-quadrant caller, which always
// has one fixed incident point) because the single-camera selector below
// ranks primarily by RANGE membership, not distance-to-a-point — when
// omitted, `distanceKm` is simply absent from each pool entry.
function buildEligibleCctvPool(records, { roadId, roadNamePattern, targetKm }) {
  const usable = [];
  for (const record of records) {
    if (!isTargetRoad(record, { roadId, roadNamePattern })) continue;
    if (isServiceAreaCctv(record)) continue; // 服務區/休息站/服務站 — never a mainline incident camera, regardless of KM proximity
    const cctvId = firstDefinedField(record, ['CCTVID', 'CCTVId', 'ID']);
    const videoStreamUrl = firstDefinedField(record, ['VideoStreamURL']);
    const locationMile = firstDefinedField(record, ['LocationMile']);
    if (!cctvId || !videoStreamUrl) continue; // unusable without an ID or an image URL
    const km = parseKM(locationMile);
    if (km === null) continue; // can't place into a quadrant/range without a parseable KM
    const direction = normalizeDirection(firstDefinedField(record, ['RoadDirection', 'Direction']));
    if (direction === null) continue; // can't place into a quadrant/range without a known direction
    usable.push({
      cctvId,
      roadDirection: direction,
      locationMile,
      positionLon: firstDefinedField(record, ['PositionLon']),
      positionLat: firstDefinedField(record, ['PositionLat']),
      videoStreamUrl,
      km,
      ...(typeof targetKm === 'number' ? { distanceKm: Math.abs(km - targetKm) } : {}),
    });
  }
  return usable;
}

export function selectFourQuadrantCandidates(
  records,
  { roadId = TARGET_ROAD_ID, roadNamePattern = TARGET_ROAD_NAME_PATTERN, targetKm = TARGET_KM } = {}
) {
  // Step 1: build the eligible MAINLINE CCTV pool first — wrong-road and
  // service-area records are excluded here, BEFORE any distance
  // comparison happens. This ordering is deliberate and required: if
  // exclusion happened AFTER picking "nearest," a nearby service-area
  // camera could still win a quadrant before being caught — see
  // isServiceAreaCctv's module comment.
  const usable = buildEligibleCctvPool(records, { roadId, roadNamePattern, targetKm });

  return QUADRANTS.map((quadrant) => {
    const inDirection = usable.filter((c) => c.roadDirection === quadrant.direction);
    const inSide = inDirection.filter((c) => (quadrant.side === 'before' ? c.km < targetKm : c.km > targetKm));

    const nearest = (maxRadiusKm) => {
      const withinRadius = inSide.filter((c) => c.distanceKm <= maxRadiusKm);
      if (withinRadius.length === 0) return null;
      return withinRadius.reduce((best, c) => (c.distanceKm < best.distanceKm ? c : best));
    };

    return nearest(NEAR_RADIUS_KM) ?? nearest(WIDE_RADIUS_KM);
  });
}

// V1.8.7.0 — Dynamic Shoulder single-camera selector. Reuses
// buildEligibleCctvPool (the SAME road-match/service-area-exclusion/
// required-field pool selectFourQuadrantCandidates itself builds from —
// see that function's own comment), applying a DIFFERENT ranking rule
// suited to "one representative camera for a KM RANGE, same direction as
// the event" rather than "four fixed points around one incident KM":
//
//   1. Same direction AND within [startKm, endKm] (inclusive) — of those,
//      the one closest to the range's own MIDPOINT ("最具代表性的一支").
//      A camera physically inside the affected range is definitionally
//      the most representative view of it, regardless of exactly how far
//      from the midpoint it sits within that range.
//   2. No in-range candidate — falls back to the SAME nearest-by-distance
//      rule used everywhere else in this module (±NEAR_RADIUS_KM first,
///     widening to ±WIDE_RADIUS_KM), ranked against the range midpoint,
//      same direction only ("使用既有可靠距離規則找最近的同方向鏡頭").
//   3. Still nothing — null. The caller (dynamicCollage.js) treats this
//      exactly like any other CCTV failure: text-only push, never a
//      reason to withhold the notification itself.
//
// Returns a SINGLE candidate object (or null) — the same per-candidate
// shape (`{cctvId, roadDirection, locationMile, positionLon, positionLat,
// videoStreamUrl}`) selectFourQuadrantCandidates' own entries have, minus
// the fixed 4-slot array wrapper, since there is exactly one slot here.
//
// @param {object[]} records - raw CCTV metadata records (same shape as
//   selectFourQuadrantCandidates' own `records` parameter).
// @param {{roadId?:string, roadNamePattern?:RegExp, direction:string,
//   startKm:number|null, endKm:number|null}} options - `direction` is the
//   EVENT's own free-text direction ('南向' etc — normalized internally
//   via normalizeDirection, same as every CCTV metadata record's own
//   direction field); at least one of startKm/endKm must be a finite
//   number, or this returns null immediately (no reliable position to
//   search around).
// @returns {{cctvId:string, roadDirection:'S'|'N', locationMile:string,
//   positionLon:*, positionLat:*, videoStreamUrl:string}|null}
export function selectSingleShoulderCandidate(
  records,
  { roadId = TARGET_ROAD_ID, roadNamePattern = TARGET_ROAD_NAME_PATTERN, direction, startKm, endKm } = {}
) {
  const wantDirection = normalizeDirection(direction);
  if (wantDirection === null) return null;

  const hasStart = typeof startKm === 'number' && Number.isFinite(startKm);
  const hasEnd = typeof endKm === 'number' && Number.isFinite(endKm);
  if (!hasStart && !hasEnd) return null;

  const rangeLo = hasStart && hasEnd ? Math.min(startKm, endKm) : hasStart ? startKm : endKm;
  const rangeHi = hasStart && hasEnd ? Math.max(startKm, endKm) : hasStart ? startKm : endKm;
  const midpointKm = (rangeLo + rangeHi) / 2;

  const pool = buildEligibleCctvPool(records, { roadId, roadNamePattern, targetKm: midpointKm }).filter(
    (c) => c.roadDirection === wantDirection
  );
  if (pool.length === 0) return null;

  // Priority 1: physically inside the event's own range — closest to the
  // midpoint wins ("最具代表性的一支").
  const inRange = pool.filter((c) => c.km >= rangeLo && c.km <= rangeHi);
  if (inRange.length > 0) {
    return inRange.reduce((best, c) => (c.distanceKm < best.distanceKm ? c : best));
  }

  // Priority 2: same fallback distance strategy used throughout this
  // module — nearest within NEAR_RADIUS_KM, else nearest within
  // WIDE_RADIUS_KM, else give up (never reach further to force a match).
  const nearest = (maxRadiusKm) => {
    const withinRadius = pool.filter((c) => c.distanceKm <= maxRadiusKm);
    if (withinRadius.length === 0) return null;
    return withinRadius.reduce((best, c) => (c.distanceKm < best.distanceKm ? c : best));
  };

  return nearest(NEAR_RADIUS_KM) ?? nearest(WIDE_RADIUS_KM);
}

// Only these 6 fields are ever persisted — per spec, "只保存". distanceKm
// is re-derived from locationMile at render time instead (same "derive
// human-readable info at render time, not bake-time" convention this
// project already uses — see health.js). `null` (an empty quadrant slot)
// passes through unchanged so the persisted array stays a fixed
// CANDIDATE_COUNT-length, index-aligned-to-quadrant array.
function toStorableCandidate(c) {
  if (c === null) return null;
  return {
    cctvId: c.cctvId,
    roadDirection: c.roadDirection,
    locationMile: c.locationMile,
    positionLon: c.positionLon,
    positionLat: c.positionLat,
    videoStreamUrl: c.videoStreamUrl,
  };
}

async function persistCandidates(kv, candidates, now) {
  try {
    await kv.put(
      CANDIDATES_KEY,
      JSON.stringify({ generatedAt: now.toISOString(), candidates: candidates.map(toStorableCandidate) }),
      { expirationTtl: CANDIDATES_TTL_SECONDS }
    );
    return { committed: true };
  } catch {
    return { committed: false };
  }
}

/** Read-only. Never calls TDX. Returns null on missing/expired/corrupt (KV's own TTL already expires the key server-side). */
async function readCandidates(kv) {
  if (!kv) return null;
  try {
    const raw = await kv.get(CANDIDATES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.candidates)) return null;
    return parsed.candidates;
  } catch {
    return null;
  }
}

function candidateDistanceLabel(candidate, targetKm = TARGET_KM) {
  const km = parseKM(candidate.locationMile);
  return km === null ? '未知' : `${Math.abs(km - targetKm).toFixed(3)} 公里`;
}

/** Bare distance number (3 decimals, per instruction "距離固定顯示 3 位
 * 小數"), for the V1.8.3 collage image's combined info line — collage.js
 * wraps this with "距事故 … 公里" itself, so this returns just the
 * number, e.g. "0.080", "0.800", "1.000". Exported for direct unit
 * testing (image text isn't OCR-able, so pure string builders like this
 * one are tested directly rather than via pixel inspection).
 *
 * V1.8.5: `targetKm` is now a parameter (default TARGET_KM preserves the
 * fixed-target admin endpoints' original behavior) so a dynamic
 * accident's own KM can be used instead — see cctv/dynamicCollage.js.
 */
export function candidateDistanceLabelForCollage(candidate, targetKm = TARGET_KM) {
  const km = parseKM(candidate.locationMile);
  return km === null ? null : Math.abs(km - targetKm).toFixed(3);
}

/**
 * Builds the collage's Traditional-Chinese title/subtitle lines, e.g.
 * titleLine "國1 82K+100 附近監視畫面", subtitleLine "更新 21:00" —
 * per instruction, replacing the earlier ASCII "NH1 82K+100 CCTV" /
 * "UPDATED HH:MM". Exported and taking `now` as a parameter so it's
 * directly unit-testable with a fixed Date, without needing to OCR the
 * rendered collage image.
 *
 * V1.8.5: `roadShortName`/`targetKm` are now optional overrides
 * (defaults '國1'/TARGET_KM preserve the exact original fixed-target
 * title for every existing admin-endpoint caller) so a dynamic accident
 * can render its OWN road/KM instead — e.g. "國3 95K+200 附近監視畫面"
 * — see cctv/dynamicCollage.js. This function itself has no opinion on
 * which roads are "supported"; that decision lives entirely in the
 * caller (dynamicCollage.js's CCTV_SUPPORTED_ROADS / fail-closed
 * eligibility check) — never guessed here.
 */
export function buildCollageHeaderLines(now, { roadShortName = '國1', targetKm = TARGET_KM } = {}) {
  const { hour, minute } = toTaipeiParts(now);
  return {
    titleLine: `${roadShortName} ${formatKmAscii(targetKm)} 附近監視畫面`,
    subtitleLine: `更新 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/** Formats a KM float as TDX-style ASCII, e.g. 82.1 -> "82K+100". */
function formatKmAscii(km) {
  const whole = Math.floor(km);
  const meters = Math.round((km - whole) * 1000);
  return `${whole}K+${String(meters).padStart(3, '0')}`;
}

function renderPage(bodyHtml) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>國1 82K+100 CCTV Test</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; max-width: 700px; margin-left: auto; margin-right: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 17px; line-height: 1.5; background: #f4f5f7; color: #1a1a1a;
  }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .card { background: #fff; border-radius: 12px; padding: 14px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .card h2 { font-size: 16px; margin: 0 0 8px; }
  img { max-width: 100%; border-radius: 8px; display: block; background: #eee; }
  .stats { font-size: 14px; color: #333; white-space: pre-line; }
  .note { font-size: 14px; color: #1a7f37; margin-top: 8px; }
  .warn { font-size: 14px; color: #c31c1c; }
</style>
</head>
<body>
  <h1>國1 82K+100 CCTV Test</h1>
  ${bodyHtml}
</body>
</html>`;
}

// Four fixed quadrant cards, index-aligned with QUADRANTS/CANDIDATE_COUNT
// and /admin/cctv-hsinchu-frame/<index>. An empty quadrant is rendered
// explicitly ("無符合鏡頭") rather than being silently skipped — per the
// ratified rule (PROJECT_HANDOFF.md section 14), a missing camera is an
// honest, visible result, not something to hide or backfill.
function renderCandidateCards(candidates) {
  return QUADRANTS.map((quadrant, i) => {
    const c = candidates[i];
    if (!c) {
      return `<div class="card">
    <h2>${escapeHtml(quadrant.label)}</h2>
    <p class="warn">此象限 &plusmn;${WIDE_RADIUS_KM}km 內無符合鏡頭。</p>
  </div>`;
    }
    return `<div class="card">
    <h2>${escapeHtml(quadrant.label)} / ${escapeHtml(c.locationMile || '未知里程')} / 距事故 ${candidateDistanceLabel(c)}</h2>
    <img src="/admin/cctv-hsinchu-frame/${i}" alt="CCTV ${escapeHtml(c.cctvId)}" loading="lazy">
  </div>`;
  }).join('\n');
}

function renderStats({ metadataCalls, candidates }) {
  const filledCount = candidates.filter(Boolean).length;
  const note = `${filledCount} 張 CCTV 圖片皆直接由高速公路局影像主機取得，未呼叫 TDX CCTV API。`;
  return `<div class="card">
    <h2>統計</h2>
    <div class="stats">TDX CCTV metadata calls: ${metadataCalls}
CCTV quadrants filled: ${filledCount} / ${CANDIDATE_COUNT}
CCTV image fetches: ${filledCount}
CCTV image TDX Authorization: none
CCTV image source: *.freeway.gov.tw</div>
    <p class="note">${escapeHtml(note)}</p>
  </div>`;
}

export async function handleHsinchuCctvProbe(env) {
  // 0. Read the current KV state — BEFORE any TDX call whatsoever.
  if (env.TRAFFIC_KV === undefined) {
    return htmlResponse(renderPage('<div class="card"><p class="warn">TRAFFIC_KV binding not configured; refusing to call TDX.</p></div>'), 503);
  }

  let state;
  try {
    state = await env.TRAFFIC_KV.get(PROBE_USED_KEY);
  } catch {
    return htmlResponse(renderPage('<div class="card"><p class="warn">Could not verify one-time-use state; refusing to call TDX.</p></div>'), 503);
  }

  if (state === 'armed') {
    return htmlResponse(
      renderPage('<div class="card"><p class="warn">Probe locked; a previous attempt has already been armed. Manual reset required.</p></div>'),
      200
    );
  }

  if (state === 'completed') {
    const candidates = await readCandidates(env.TRAFFIC_KV);
    if (!candidates || candidates.length === 0) {
      return htmlResponse(
        renderPage(
          '<div class="card"><p class="warn">Probe already completed, but the cached candidate list has expired (1h TTL). The one-time-use guard remains locked — no further TDX calls will be made.</p></div>'
        ),
        200
      );
    }
    return htmlResponse(renderPage(renderCandidateCards(candidates) + renderStats({ metadataCalls: 0, candidates })), 200);
  }

  // 1. PRE-ARM — write 'armed' BEFORE any TDX-related call at all.
  try {
    await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'armed');
  } catch {
    return htmlResponse(renderPage('<div class="card"><p class="warn">Could not arm the one-time-use guard; refusing to call TDX.</p></div>'), 503);
  }

  // V1.8.6 used to commit this whole probe's `tdxUsageSink` into the TDX
  // usage ledger at every exit point below (context='admin-cctv'). V1.9.2
  // (TDX Usage Summary retirement) removed that KV write: the raw ledger
  // existed solely to feed the now-retired tdx:usage:summary:v1
  // compaction/health-page dashboard (see usageLedger.js's own header
  // comment) and had no other reader — TDX quota/usage is now checked
  // directly on TDX's own official back-office dashboard. `tdxUsageSink`
  // below is harmless, unpersisted in-memory bookkeeping — kept only
  // because getAccessToken/fetchTdxJson still accept it as an optional
  // parameter.
  const tdxUsageSink = [];

  // 2. OAuth token — reuses the project's existing cache-first flow.
  // On failure, KV stays 'armed' — never auto-cleared, never auto-retried.
  let accessToken;
  try {
    accessToken = await getAccessToken(env, tdxUsageSink);
  } catch {
    return htmlResponse(
      renderPage('<div class="card"><p class="warn">probe locked after failed attempt; manual reset required (OAuth failed)</p></div>'),
      502
    );
  }

  // 3. The ONE allowed CCTV metadata call. No retry, no pagination, no
  // second call. On failure, KV stays 'armed'.
  let cctvJson;
  try {
    cctvJson = await fetchTdxJson(CCTV_URL, accessToken, { source: 'cctv-hsinchu-probe', usageSink: tdxUsageSink });
  } catch (err) {
    return htmlResponse(
      renderPage(
        `<div class="card"><p class="warn">probe locked after failed attempt; manual reset required (CCTV metadata failed${err instanceof TdxApiError && err.status ? `, HTTP ${err.status}` : ''})</p></div>`
      ),
      502
    );
  }

  const records = Array.isArray(cctvJson) ? cctvJson : cctvJson.CCTVs || cctvJson.Data || [];
  const candidates = selectFourQuadrantCandidates(records);

  await persistCandidates(env.TRAFFIC_KV, candidates, new Date());

  // V1.8.5 correction: also seed the SHARED broadcast-facing freeway
  // metadata cache (cctv/freewayCctvMetadataCache.js) from this SAME
  // already-fetched `records` — zero additional TDX calls. The real
  // broadcast pipeline (cctv/dynamicCollage.js) is cache-only and must
  // NEVER call TDX itself; this is how that cache actually gets
  // populated/refreshed in practice (an Admin manually running this
  // probe). Best-effort: a failure here must never affect this probe's
  // own response/guard state.
  await writeFreewayCctvMetadataCache(env.TRAFFIC_KV, records, new Date());

  // Metadata call genuinely succeeded — flip armed -> completed. If this
  // write fails, KV simply stays 'armed' — still fully locked either way.
  try {
    await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'completed');
  } catch {
    // completionWriteFailed — guard stays 'armed', which is still fully
    // locked (0 TDX calls on every future request) — see module comment.
  }

  // Always render all 4 quadrant slots (renderCandidateCards already
  // shows an explicit "no candidate" state per empty slot) — an all-empty
  // result is still shown honestly rather than replaced with a single
  // generic warning, per the ratified rule.
  return htmlResponse(renderPage(renderCandidateCards(candidates) + renderStats({ metadataCalls: 1, candidates })), 200);
}

// --- STEP 3: single-frame MJPEG capture. Imports NOTHING TDX-related. ---

function isTrustedImageUrl(url) {
  if (url.protocol !== 'https:') return false;
  return url.hostname === TRUSTED_IMAGE_HOST_SUFFIX || url.hostname.endsWith(`.${TRUSTED_IMAGE_HOST_SUFFIX}`);
}

function findMarker(buf, b1, b2, from = 0) {
  for (let i = from; i < buf.length - 1; i += 1) {
    if (buf[i] === b1 && buf[i + 1] === b2) return i;
  }
  return -1;
}

// V1.8.7.7 — real Production incident (08:00 Asia/Taipei, 國3 南向 two
// dynamic-shoulder events: 77K+150～78K+570 and 79K+250～89K+830): LINE
// text broadcast normally, but the attached CCTV image rendered as a gray
// broken-image icon — the image WAS attached (imagePrepared:true, a real
// R2 object existed), it just wasn't a valid/complete JPEG.
//
// ROOT CAUSE: extractFirstJpegFrame previously located a frame's end by
// scanning raw bytes for the FIRST 0xFFD9 (EOI) anywhere after the FIRST
// 0xFFD8 (SOI) — see the old `findMarker(buf, 0xff, 0xd9, soiIndex + 2)`
// call this function replaces. That is unsafe: a real camera JPEG very
// commonly embeds a full EXIF thumbnail (itself a complete, tiny, nested
// SOI...EOI JPEG) inside its APP1 segment, near the very start of the
// file, well before the real image's own compressed scan data even
// begins. A naive scan finds the THUMBNAIL's own EOI first and returns a
// tiny, truncated slice of the real frame — headers + thumbnail only —
// which is exactly the "gray broken image" symptom: a 200 response, a
// successful R2 publish, a real imageUrl, but corrupt/incomplete bytes.
//
// This is why the accident (quad) collage path was NEVER at risk of
// showing this to a user: composeQuadrantCollage decodes every fetched
// frame through a real JPEG decoder (see cctv/jpegCodecWorker.js) before
// ever drawing it, and that module's own comment already documents "a
// cell can fetch a 200 response that isn't actually a valid/decodable
// JPEG" as an anticipated case, falling back to a placeholder tile. The
// V1.8.7.0 dynamic-shoulder SINGLE path was deliberately built to skip
// that decode/encode round-trip entirely for performance ("one frame IS
// the final image", see dynamicCollage.js's module comment) — which also
// meant it published extractFirstJpegFrame's raw output completely
// unvalidated. 國3 is not the cause; it is simply the first real camera
// hardware whose frames happen to embed a thumbnail large/early enough to
// trigger this — the underlying defect is general and was equally latent
// for 國1, just not yet observed.
//
// FIX: findJpegImageEnd walks the JPEG marker structure starting at SOI
// — skipping every header segment by its own declared length (so any
// embedded thumbnail's internal SOI/EOI bytes are skipped OVER, never
// scanned into) — until it reaches SOS (Start of Scan), then scans the
// following entropy-coded scan data for the next GENUINE marker. Per the
// JPEG spec's own mandatory byte-stuffing rule, a compliant encoder always
// follows a literal 0xFF byte inside scan data with either a 0x00 stuff
// byte or a restart marker (0xD0-0xD7) — so once past SOS, any 0xFF
// followed by something else provably IS a real marker, never scan-data
// content, which is what makes the ORIGINAL naive-scan idea safe again
// once it's correctly scoped to start AFTER the header segments instead
// of right after SOI. Operates correctly on a still-growing streamed
// buffer: returns {complete:false} (never throws, never guesses) whenever
// it needs bytes that haven't arrived yet, so the existing read loop
// below simply tries again on the next chunk — the exact same "keep
// reading until MAX_FRAME_BYTES/timeout" bounds as before are unchanged.
// Never reads past this SAME frame's own real EOI — the existing
// "stop and cancel the stream the instant a complete frame is found,
// never peek into the next MJPEG frame" behavior (see this module's own
// test coverage) is fully preserved.
//
// `findJpegImageEnd` (below walkJpegMarkers) additionally falls back to
// the OLD pre-V1.8.7.7 plain "first FFD9 after SOI" scan whenever the
// buffer does not decode as real marker-segment structure at a position
// we've already fully received (walkJpegMarkers returns `null` for that
// case specifically — genuinely malformed/non-marker bytes, never merely
// "more data is still arriving," which always resolves to
// `{complete:false}` instead, see each early-return above). This matters
// because it's the only way to distinguish "not enough bytes yet" from
// "this isn't real JPEG marker structure" — a real freeway.gov.tw camera
// frame is always the latter case's opposite (well-formed), so this
// fallback path is not expected to ever fire in Production; it exists so
// callers/tests that intentionally use a simplified, non-marker-
// structured byte sequence to stand in for "a complete JPEG frame" (this
// module's own test suite does exactly that) keep working unchanged.
function walkJpegMarkers(buf, soiIndex) {
  let pos = soiIndex + 2;
  while (true) {
    if (pos + 1 >= buf.length) return { complete: false };
    if (buf[pos] !== 0xff) return null; // genuinely not marker-structured at an already-received position — not a "wait for more data" case

    // Marker codes may legitimately be preceded by 0xFF fill bytes.
    let markerPos = pos;
    while (markerPos + 1 < buf.length && buf[markerPos + 1] === 0xff) markerPos += 1;
    if (markerPos + 1 >= buf.length) return { complete: false };
    const marker = buf[markerPos + 1];
    const afterMarker = markerPos + 2;

    if (marker === 0xd9) return { complete: true, eoiIndex: markerPos };

    // Standalone markers with no length field: TEM (0x01), RSTn (0xD0-0xD7).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos = afterMarker;
      continue;
    }

    if (marker === 0xda) {
      // Start of Scan — length-prefixed header, then entropy-coded scan
      // data (NOT length-prefixed) follows until the next genuine marker.
      if (afterMarker + 1 >= buf.length) return { complete: false };
      const segLen = (buf[afterMarker] << 8) | buf[afterMarker + 1];
      if (segLen < 2) return null; // an SOS segment length must be >= 2 (it includes itself) — not real marker structure
      let i = afterMarker + segLen;
      let resumeAt = null;
      while (true) {
        if (i + 1 >= buf.length) return { complete: false };
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const next = buf[i + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          i += 2; // byte-stuffing or a restart marker — still scan data
          continue;
        }
        if (next === 0xff) {
          i += 1; // fill byte before a real marker — recheck from here
          continue;
        }
        if (next === 0xd9) return { complete: true, eoiIndex: i };
        // Some other marker (e.g. a progressive JPEG's next scan) —
        // resume the outer marker walk from here rather than assuming EOI.
        resumeAt = i;
        break;
      }
      pos = resumeAt;
      continue;
    }

    // Generic length-prefixed segment (APPn/EXIF, DQT, DHT, SOFn, COM, DRI, ...).
    if (afterMarker + 1 >= buf.length) return { complete: false };
    const segLen = (buf[afterMarker] << 8) | buf[afterMarker + 1];
    if (segLen < 2) return null; // a marker segment length must be >= 2 (it includes itself) — not real marker structure
    pos = afterMarker + segLen;
  }
}

/**
 * Public entry point — see walkJpegMarkers' own comment for the real
 * fix and the fallback's rationale. `{complete:true, eoiIndex}` |
 * `{complete:false}` (need more buffered bytes; caller's existing
 * MAX_FRAME_BYTES/timeout bounds decide when to give up — never guessed
 * here).
 */
function findJpegImageEnd(buf, soiIndex) {
  const walked = walkJpegMarkers(buf, soiIndex);
  if (walked) return walked;
  // Fallback for non-marker-structured input only (see walkJpegMarkers'
  // own comment) — the exact pre-V1.8.7.7 behavior.
  const eoiIndex = findMarker(buf, 0xff, 0xd9, soiIndex + 2);
  return eoiIndex === -1 ? { complete: false } : { complete: true, eoiIndex };
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function isAbortLike(err) {
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Fetches the MJPEG stream directly — deliberately NO Authorization
 * header, no TDX call of any kind. Reads at most MAX_FRAME_BYTES, waits
 * at most ~FRAME_TIMEOUT_MS, and stops (cancels the stream) the instant
 * a complete JPEG frame (FFD8 ... FFD9) is found. Never reads further —
 * this is a single-frame capture, not an MJPEG player.
 */
export async function extractFirstJpegFrame(streamUrl, { timeoutMs = FRAME_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = new URL(streamUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!isTrustedImageUrl(url)) {
    return { ok: false, reason: 'untrusted-hostname' };
  }

  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) }); // no Authorization header, intentionally
  } catch (err) {
    return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'network-error' };
  }

  if (!res.ok || !res.body) {
    try {
      res.body?.cancel?.();
    } catch {
      // best-effort
    }
    return { ok: false, reason: 'http-error', httpStatus: res.status };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let soiIndex = -1;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;

      if (totalBytes > MAX_FRAME_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too-large' };
      }

      const buf = concatChunks(chunks);
      if (soiIndex === -1) soiIndex = findMarker(buf, 0xff, 0xd8);
      if (soiIndex !== -1) {
        // V1.8.7.7 — findJpegImageEnd (not a naive first-FFD9 scan) — see
        // its own comment for the real Production symptom this fixes.
        const end = findJpegImageEnd(buf, soiIndex);
        if (end.complete) {
          await reader.cancel().catch(() => {});
          return { ok: true, bytes: buf.slice(soiIndex, end.eoiIndex + 2), contentType: res.headers.get('content-type') };
        }
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
    return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'stream-error' };
  }

  return { ok: false, reason: 'no-complete-frame' };
}

const FRAME_ERROR_STATUS = {
  'invalid-url': 400,
  'untrusted-hostname': 400,
};

export async function handleHsinchuCctvFrame(env, index) {
  if (!Number.isInteger(index) || index < 0 || index >= CANDIDATE_COUNT) {
    return jsonResponse({ status: 'error', message: 'Invalid CCTV frame index.' }, 404);
  }

  const candidates = await readCandidates(env.TRAFFIC_KV);
  if (!candidates || !candidates[index]) {
    return jsonResponse(
      { status: 'error', message: 'No cached CCTV candidate at this index. Run /admin/cctv-hsinchu-probe first.' },
      404
    );
  }

  const result = await extractFirstJpegFrame(candidates[index].videoStreamUrl);
  if (!result.ok) {
    return jsonResponse(
      { status: 'error', reason: result.reason, httpStatus: result.httpStatus ?? null },
      FRAME_ERROR_STATUS[result.reason] ?? 502
    );
  }

  return new Response(result.bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
  });
}

// --- V1.8: STEP 5 — compose the 4 quadrant frames into one collage. ---
// Strictly read-only against the candidates KV; never touches TDX (no
// getAccessToken/fetchTdxJson import above is ever called from this
// function), never triggers the probe, never rebuilds the candidate
// list. See module comment and PROJECT_HANDOFF.md's V1.8 section.

/**
 * Shared collage-compose core, extracted in V1.8.4 (and further split in
 * V1.8.5 — see composeCollageFromCandidates below) so
 * GET /admin/cctv-hsinchu-collage (V1.8), GET
 * /admin/cctv-hsinchu-publish-test (V1.8.4), AND the new dynamic
 * per-accident broadcast path (V1.8.5 — see cctv/dynamicCollage.js) can
 * never drift into fetching/composing the collage differently — all
 * three ultimately call composeCollageFromCandidates. This function
 * itself is specifically the FIXED-TARGET admin flow: reads the
 * one-time-probe's CANDIDATES_KEY cache, then delegates.
 *
 * @param {object} env
 * @param {{decodeJpeg: Function, encodeJpeg: Function}} [codecOverride] —
 *   TEST-ONLY. Production callers never pass this; the real Workers WASM
 *   codec is lazily loaded on demand (see loadProductionJpegCodec
 *   above). Tests that need a real decoded image pass
 *   test/testJpegCodec.js's Node-compatible codec here instead of going
 *   through the real `.wasm` import, which plain Node cannot load — see
 *   this file's module comment.
 * @returns {Promise<{ok:true, bytes:ArrayBuffer, contentType:'image/jpeg'}|{ok:false, reason:'no-kv'|'no-cache'|'no-frames', message:string}>}
 */
export async function composeCollageFromCache(env, codecOverride) {
  if (env.TRAFFIC_KV === undefined) {
    return { ok: false, reason: 'no-kv', message: 'TRAFFIC_KV binding not configured.' };
  }

  const candidates = await readCandidates(env.TRAFFIC_KV);
  if (!candidates) {
    return { ok: false, reason: 'no-cache', message: 'CCTV candidate cache unavailable' };
  }

  return composeCollageFromCandidates(candidates, buildCollageHeaderLines(new Date()), { codecOverride });
}

/**
 * The actual fetch-frames-and-compose core (extracted out of
 * composeCollageFromCache in V1.8.5 so a caller with its OWN
 * dynamically-selected candidates — not the fixed-target admin probe's
 * KV cache — can reuse the exact same frame-fetch/cell-building/
 * composeQuadrantCollage orchestration; see
 * cctv/dynamicCollage.js:prepareCctvImageForEvent). Fetches all (up to
 * 4) candidate frames in parallel — capped at 4 by construction (exactly
 * one fetch attempt per quadrant slot, never more) — and composes them
 * into a single 2x2 collage JPEG via cctv/collage.js. One or more
 * successfully DECODED frames is enough to produce a valid collage
 * (collage.js's own successfulDecodedFrames count is the source of
 * truth — a 200 response that isn't actually a valid JPEG does not
 * count); only when every quadrant has neither a candidate nor a usable
 * frame does this fail.
 *
 * @param {Array} candidates - EXACTLY 4 entries, index-aligned to
 *   QUADRANTS, `null` for an empty slot — same shape
 *   selectFourQuadrantCandidates returns (after toStorableCandidate,
 *   i.e. {cctvId, roadDirection, locationMile, videoStreamUrl, ...}).
 * @param {{titleLine: string, subtitleLine: string}} headerLines - see
 *   buildCollageHeaderLines.
 * @param {{targetKm?: number, codecOverride?: {decodeJpeg,encodeJpeg}, frameTimeoutMs?: number}} [options]
 *   `frameTimeoutMs` — V1.8.5: overrides extractFirstJpegFrame's own
 *   default FRAME_TIMEOUT_MS per-frame timeout. Used by
 *   cctv/dynamicCollage.js to bound each frame fetch to whatever's left
 *   of its overall CCTV_PREPARE_BUDGET_MS hard time budget, instead of
 *   always spending up to the full default regardless of how much
 *   budget remains. Fixed-target admin callers never pass this — they
 *   keep the original default.
 * @returns {Promise<{ok:true, bytes:ArrayBuffer, contentType:'image/jpeg', frameFetchElapsedMs:number, collageElapsedMs:number, successfulFrameCount:number, failedFrameCount:number}|{ok:false, reason:'no-frames', message:string, frameFetchElapsedMs:number, collageElapsedMs:number, successfulFrameCount:number, failedFrameCount:number}>}
 *   V1.9.0 (root-cause forensics, 國3 96K+700 2026-08-26) — the four
 *   timing/count fields are ADDITIVE instrumentation only, on every
 *   outcome (never just the success path): plain numbers, never a
 *   stream URL, candidate record, or frame byte. They exist so a
 *   caller racing this against a hard time budget (dynamicCollage.js)
 *   can tell, after the fact, whether a timeout happened during the
 *   frame-fetch batch or during compose — something no caller of this
 *   function could previously observe at all when the OUTER race
 *   discarded this result for arriving too late.
 */
export async function composeCollageFromCandidates(candidates, headerLines, { targetKm = TARGET_KM, codecOverride, frameTimeoutMs } = {}) {
  const frameFetchStartedAt = Date.now();
  const frameResults = await Promise.all(
    candidates.map(async (candidate) => {
      if (!candidate) return null;
      try {
        return await extractFirstJpegFrame(candidate.videoStreamUrl, frameTimeoutMs !== undefined ? { timeoutMs: frameTimeoutMs } : undefined);
      } catch {
        // extractFirstJpegFrame never throws in practice (every failure
        // path returns a typed {ok:false,...} result) — this catch is
        // defense-in-depth only, so one unexpected error can never take
        // down the whole collage (see module comment: 1-4 successes
        // still produce a valid collage).
        return { ok: false, reason: 'stream-error' };
      }
    })
  );
  // V1.9.0 — this covers the WHOLE batch (all 4 parallel fetches — see
  // dynamicCollage.js's own test D, which proved this is Promise.all,
  // not a serial loop), not any one candidate. A single slow/hung
  // candidate is exactly what stretches this number, since Promise.all
  // does not resolve until every candidate has either succeeded or hit
  // its own per-candidate AbortSignal.timeout — proved by that same
  // round's tests B/C.
  const frameFetchElapsedMs = Date.now() - frameFetchStartedAt;

  const cells = QUADRANTS.map((quadrant, i) => {
    const candidate = candidates[i];
    const slotLabel = CJK_QUADRANT_LABELS[i];
    if (!candidate) {
      return { slotLabel, locationLabel: null, distanceLabel: null, jpegBytes: null, status: 'empty' };
    }
    const locationLabel = candidate.locationMile || null;
    const distanceLabel = candidateDistanceLabelForCollage(candidate, targetKm);
    const frame = frameResults[i];
    if (frame && frame.ok) {
      return { slotLabel, locationLabel, distanceLabel, jpegBytes: frame.bytes, status: 'ok' };
    }
    return { slotLabel, locationLabel, distanceLabel, jpegBytes: null, status: 'failed' };
  });

  // Only load a real codec when there's at least one fetched frame to
  // decode — composeQuadrantCollage's own pre-check short-circuits to
  // ok:false/no-frames without ever calling decodeJpeg/encodeJpeg when
  // nothing fetched successfully, so there's no need to pay the WASM
  // init cost (or, in tests with no override, hit the Node-incompatible
  // dynamic import) for a request that can't produce an image anyway.
  const anyFetchedOk = cells.some((c) => c.status === 'ok' && c.jpegBytes);
  const codec = anyFetchedOk ? codecOverride || (await loadProductionJpegCodec()) : { decodeJpeg: undefined, encodeJpeg: undefined };

  // V1.9.0 — separately timed from frame-fetch above: covers codec
  // load (WASM instantiate, on a cold path — see this function's own
  // lazy-load comment just above) plus SERIAL per-cell JPEG decode/
  // encode (collage.js's composeQuadrantCollage decodes one candidate
  // at a time, in a plain for-loop — proved by that round's test E,
  // which showed a slow decodeJpeg alone is enough to exhaust the same
  // budget this function's caller races against).
  const collageStartedAt = Date.now();
  const result = await composeQuadrantCollage(cells, {
    decodeJpeg: codec.decodeJpeg,
    encodeJpeg: codec.encodeJpeg,
    titleLine: headerLines.titleLine,
    subtitleLine: headerLines.subtitleLine,
  });
  const collageElapsedMs = Date.now() - collageStartedAt;

  // V1.9.0 — out of the candidates that existed at all (a `null` slot
  // was never a candidate and never a "failure"): how many produced a
  // genuinely DECODED frame (composeQuadrantCollage's own
  // successfulDecodedFrames, returned here as filledCount — the single
  // source of truth already established; a 200 response that isn't a
  // valid JPEG does NOT count) versus how many did not.
  const attemptedCandidateCount = candidates.filter((c) => c !== null).length;
  const successfulFrameCount = result.filledCount ?? 0;
  const failedFrameCount = attemptedCandidateCount - successfulFrameCount;
  // 2026-08-30 — CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR: ADDITIVE only,
  // on every outcome (same "on every outcome" convention V1.9.0's own
  // timing fields above already established) — reuses `anyFetchedOk`
  // (already computed above for codec-loading) rather than recomputing
  // anything. Distinguishes "not even one candidate frame was fetched at
  // all" from "frames were fetched but every one failed to decode/
  // compose" — a distinction no existing caller of this function needed
  // before (all three either only care about the final ok/fail, or
  // already have their own frame-level detail from `cells`), but the new
  // diagnostic publish-test endpoint below does, to report a specific
  // failed STEP rather than one opaque reason for every possible cause.
  const timing = { frameFetchElapsedMs, collageElapsedMs, successfulFrameCount, failedFrameCount, anyFrameFetchSucceeded: anyFetchedOk };

  if (!result.ok) {
    return { ok: false, reason: 'no-frames', message: 'No CCTV footage available for any quadrant.', ...timing };
  }

  return { ok: true, bytes: result.bytes, contentType: result.contentType, ...timing };
}

const COMPOSE_FAILURE_STATUS = { 'no-kv': 503, 'no-cache': 404, 'no-frames': 502 };

export async function handleHsinchuCctvCollage(env, codecOverride) {
  const composed = await composeCollageFromCache(env, codecOverride);
  if (!composed.ok) {
    return jsonResponse({ status: 'error', message: composed.message }, COMPOSE_FAILURE_STATUS[composed.reason] ?? 502);
  }
  return new Response(composed.bytes, {
    status: 200,
    headers: { 'Content-Type': composed.contentType, 'Cache-Control': 'no-store' },
  });
}

// --- 2026-08-30 (CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR) — the
// TDX-free composer the publish-test endpoint below now uses. Same
// three ingredients every other collage path in this file already uses,
// just sourced from the freeway metadata CACHE instead of the fixed-
// target admin probe's own CANDIDATES_KEY:
//   1. readFreewayCctvMetadataCache — cache-only, never TDX (see
//      cctv/freewayCctvMetadataCache.js; falls back to the bundled
//      official inventory if KV has nothing, so this step can only
//      genuinely fail if even that bundle were empty).
//   2. selectFourQuadrantCandidates — the SAME quadrant-selection
//      function the fixed-target admin probe path uses, at its own
//      TARGET_ROAD_ID/TARGET_ROAD_NAME_PATTERN/TARGET_KM defaults (國道1號
//      82K+100) — no new selection policy, no camera-ranking change.
//   3. composeCollageFromCandidates — the SAME frame-fetch/compose core
//      every collage path (fixed-target probe, this endpoint, and the
//      real per-accident dynamic broadcast path) already shares.
//
// Returns a `step` on every failure so the caller can report EXACTLY
// which stage failed, never one opaque message for every possible cause
// — see this file's own module comment on why that mattered for
// EVENT_ID=11508310005-5's own diagnosis.
//
// @returns {Promise<{ok:true, bytes:ArrayBuffer, contentType:'image/jpeg'}|
//   {ok:false, step:'METADATA_CACHE_MISSING'|'NO_CCTV_CANDIDATES'|'SNAPSHOT_FETCH_FAILED'|'COMPOSE_FAILED', message:string}>}
export async function composeCollageFromFreewayMetadata(env, codecOverride) {
  const records = await readFreewayCctvMetadataCache(env.TRAFFIC_KV);
  if (!records) {
    // Structurally possible (a caller with no TRAFFIC_KV binding at all
    // still gets the bundled inventory — see readFreewayCctvMetadataCache
    // — so this only fires if even that bundle were empty, which should
    // never happen in practice) but handled explicitly rather than
    // falling through to a less specific failure, same fail-closed
    // discipline the rest of this module already follows.
    return { ok: false, step: 'METADATA_CACHE_MISSING', message: 'Freeway CCTV metadata cache unavailable (no KV record and no bundled fallback).' };
  }

  const candidates = selectFourQuadrantCandidates(records);
  if (candidates.every((c) => c === null)) {
    return { ok: false, step: 'NO_CCTV_CANDIDATES', message: 'No eligible CCTV candidates found for the fixed test target (國1 82K+100).' };
  }

  const composed = await composeCollageFromCandidates(candidates, buildCollageHeaderLines(new Date()), { codecOverride });
  if (!composed.ok) {
    // anyFrameFetchSucceeded (see composeCollageFromCandidates' own
    // ADDITIVE field above) is what actually tells these two apart: no
    // candidate frame fetched at all vs. frames fetched fine but every
    // one failed to decode/compose.
    const step = composed.anyFrameFetchSucceeded ? 'COMPOSE_FAILED' : 'SNAPSHOT_FETCH_FAILED';
    return { ok: false, step, message: composed.message };
  }

  return { ok: true, bytes: composed.bytes, contentType: composed.contentType };
}

const PUBLISH_TEST_FAILURE_STATUS = {
  METADATA_CACHE_MISSING: 404,
  NO_CCTV_CANDIDATES: 404,
  SNAPSHOT_FETCH_FAILED: 502,
  COMPOSE_FAILED: 502,
  R2_PUBLISH_FAILED: 502,
};

// --- V1.8.4, REPAIRED 2026-08-30: publish the composed collage to a
// short-lived, opaque, unauthenticated public URL (see
// cctv/publishedImage.js) — a future LINE Messaging API image message
// can reference the URL directly without ever carrying our Admin Basic
// Auth (LINE cannot attach it). Admin-Auth-gated (see index.js's
// ADMIN_PATHS) — this endpoint does NOT call LINE, does NOT trigger PBS/
// the AI decision path/the Queue, and does NOT trigger a TDX probe; it
// only composes (0 TDX calls — see composeCollageFromFreewayMetadata
// above's own comment for why) and publishes to R2 (env.CCTV_IMAGES).
// Fail-closed at every stage, per instruction ("不發布 URL" / "不要建立
// 假 image entry"): a missing CCTV_IMAGES binding, a missing/empty
// metadata cache, 0 eligible candidates, 0 usable frames, an encode
// failure, or an R2 write failure all end in a JSON error response with
// a specific `step`, never a URL and never one opaque message for every
// possible cause.
//
// `codecOverride` is the same TEST-ONLY parameter
// composeCollageFromFreewayMetadata takes (see its own doc comment) —
// threaded through so tests can supply test/testJpegCodec.js's
// Node-compatible codec instead of hitting the real `.wasm` import,
// which plain Node cannot load.
export async function handleHsinchuCctvPublishTest(env, request, codecOverride) {
  // Fail fast, BEFORE composing (which fetches up to 4 CCTV frames) —
  // if there's nowhere to publish to, there's no point spending those
  // fetches. Same fail-closed reasoning as every other stage below.
  if (env.CCTV_IMAGES === undefined) {
    return jsonResponse({ status: 'error', step: 'R2_PUBLISH_FAILED', message: 'CCTV_IMAGES (R2) binding not configured.' }, 503);
  }

  const composed = await composeCollageFromFreewayMetadata(env, codecOverride);
  if (!composed.ok) {
    return jsonResponse({ status: 'error', step: composed.step, message: composed.message }, PUBLISH_TEST_FAILURE_STATUS[composed.step] ?? 502);
  }

  const now = new Date();
  const published = await publishCollageImage(env.CCTV_IMAGES, composed.bytes, now);
  if (!published.ok) {
    return jsonResponse({ status: 'error', step: 'R2_PUBLISH_FAILED', message: 'Failed to publish image to R2.' }, 502);
  }

  const origin = new URL(request.url).origin;
  return jsonResponse(
    {
      status: 'ok',
      published: true,
      contentType: composed.contentType,
      bytes: published.sizeBytes,
      createdAt: published.createdAt,
      expiresAt: published.expiresAt,
      expiresIn: published.expiresIn,
      imageUrl: `${origin}/cctv/image/${published.id}`,
    },
    200
  );
}
