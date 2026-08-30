// V1.8.6.5 — KM Location Resolver: turns a raw event's KM value(s) into a
// driver-readable official location + (when available) a coordinate/Google
// Maps link, sourced ONLY from `data/road-location/generated/*.js` —
// itself compiled offline by scripts/updateRoadLocationData.mjs from
// official open data (see raw/README.md). ZERO runtime network calls:
// this module never fetches anything, ever — the generated datasets are
// bundled with the Worker at deploy time, same as e.g.
// congestionSeverity.js's own static tables.
//
// Display/provenance-ONLY. Never called anywhere near fingerprint /
// incident-suppression-key / dedupe-identity / CCTV-eligibility logic —
// those all keep using event.startKM/endKM/displayKM exactly as before
// this module exists. See messageFormat.js and broadcastProvenance.js for
// the two (and only two) call sites.
//
// Fail-closed by construction: every failure mode below (unrecognized
// road, unparsable KM, no matching dataset, nearest point too far, or any
// unexpected internal error) is caught and converted to
// `{resolved:false, reason:'...'}` — this function is written to NEVER
// throw, so a caller can invoke it unconditionally without its own
// try/catch. When `resolved` is false, callers fall back to whatever
// they'd have shown anyway (V1.8.6.4 behavior, unchanged) — never a
// guess, never a blocked Cron tick.

import { parseKM } from './roadSectionLabel.js';
import { canonicalFreewayRoad, canonicalProvincialRoad } from './roadIdentity.js';
import provincialDatasetDefault from '../../data/road-location/generated/provincial.js';
import freewayDatasetDefault from '../../data/road-location/generated/freeway.js';
import freewayFacilitiesDatasetDefault from '../../data/road-location/generated/freewayFacilities.js';

// Tolerances, verified against the real imported datasets (data.gov.tw
// 7040 provincial + 95016 freeway milestones — see raw/README.md and
// PROJECT_HANDOFF.md's V1.8.6.5 section for the full import). Real
// provincial marker spacing measures ~100m/500m/1000m depending on
// location, PLUS the as-installed chainage offset from the round KM value
// documented on the source itself (e.g. a "9K" sign pair actually sitting
// at 9K+015/9K+022 — see raw/provincial/SOURCE_META.json's own notes);
// real freeway milestone spacing measures ~100m throughout. These
// constants were kept at their pre-import values because they already
// comfortably cover that real-world spacing+offset — same "recalibrate
// here once real data shows a mismatch" caveat roadSectionLabel.js's own
// ROAD_ANCHORS table already carries — never widened just to force a
// match where the real data doesn't support one.
export const PROVINCIAL_TOLERANCE_KM = 0.6;
export const FREEWAY_MILESTONE_TOLERANCE_KM = 0.15;
// Facilities (交流道/服務區) are sparse by nature (tens of km apart) — this
// only guards against matching a facility from a wildly different part of
// the same route when the dataset for that route is mostly empty.
export const FREEWAY_FACILITY_MAX_GAP_KM = 60;

function failClosed(reason, extra = {}) {
  return { resolved: false, reason, ...extra };
}

// Priority, per the round's own spec — structured start/end midpoint wins
// (most precise: the actual affected range), a single structured end
// point next, and event.displayKM (PBS free-text-derived, already the
// LOWEST-authority KM everywhere else in this codebase — see
// pbs/normalize.js's own module comment) only as a last resort. Never
// grants displayKM any more authority here than it already has elsewhere.
function selectTargetKm({ startKM, endKM, displayKM }) {
  const start = parseKM(startKM);
  const end = parseKM(endKM);
  if (start !== null && end !== null) return (start + end) / 2;
  if (start !== null) return start;
  if (end !== null) return end;
  if (typeof displayKM === 'number' && Number.isFinite(displayKM)) return displayKM;
  return null;
}

function nearestPoint(points, targetKm) {
  if (!points || points.length === 0) return null;
  let best = points[0];
  let bestDist = Math.abs(points[0].km - targetKm);
  for (const point of points) {
    const dist = Math.abs(point.km - targetKm);
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  }
  return { point: best, dist: bestDist };
}

// V1.8.6.5 UI hotfix — short-form Google Maps URL. `https://maps.google.com/?q=<lat>,<lng>`
// is a shorter, equally stable/public/documented URL form than the
// `?api=1&query=` shape used at launch — no API key, no shortener, still
// opens the exact coordinate in any client. Coordinates are fixed to 5
// decimal places (~1.1m precision at these latitudes — plenty for "which
// interchange/village this is near", never claimed as survey-grade) so
// the URL itself stays short and doesn't leak the dataset's own raw
// (much longer) float precision into a LINE message.
function buildMapUrl(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
}

// 2026-08-30 — DIRECT_COORDINATE_MAP_FALLBACK hotfix (order:
// PBS_COORDINATE_DIRECT_MAP_FALLBACK). Real incident: EVENT_ID=
// 11508260158-0, a 竹60線 (county road) landslide-closure event in
// 新竹縣尖石鄉 — PBS/Windows/Cloudflare all carried valid raw x1/y1
// coordinates the whole way through, but the LINE message had NO map
// link at all, because BOTH resolveKmLocation() (road+KM path) and
// resolveCoordinateLocation() (coordinate path, above) require the
// event's `road` to canonicalize to a recognized 國道/省道 name before
// either one will even attempt a dataset lookup — a county/township road
// like 竹60 never can, since this project only bundles official
// freeway (95016) and provincial (7040) KM-marker datasets, never
// county/township ones. The coordinate fallback above therefore
// discarded a perfectly valid coordinate purely because the ROAD wasn't
// recognized, not because the coordinate itself was bad.
//
// This is a map-LINK-only escape hatch, added as messageFormat.js's own
// LAST resort (only reached once both resolveKmLocation and
// resolveCoordinateLocation have already failed) — it deliberately does
// NOT attempt to name a place, resolve a road, or produce a
// locationLabel/sectionLabel: an unrecognized road still shows no
// location text, exactly as before this round (order section 一's own
// explicit boundary — "不得藉此猜測 road/sectionLabel/locationLabel/
// 鄉道名稱/公里位置"). It only decides whether the trailing "📍 地圖" line
// gets a pin at all.
//
// VALID_COORDINATES_REQUIRED (order section 二): finite numbers only,
// within real latitude/longitude range, and never the exact (0,0) "null
// island" sentinel a missing/placeholder GPS field sometimes carries —
// none of those are a genuine location, so none may produce a map link.
const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;
const MIN_LONGITUDE = -180;
const MAX_LONGITUDE = 180;

function isValidRawCoordinate(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < MIN_LATITUDE || lat > MAX_LATITUDE) return false;
  if (lng < MIN_LONGITUDE || lng > MAX_LONGITUDE) return false;
  if (lat === 0 && lng === 0) return false; // never a real Taiwan location — treated as missing
  return true;
}

/**
 * DIRECT_COORDINATE_MAP_FALLBACK — the event's own raw latitude/longitude,
 * straight into the same short-form Google Maps URL every other
 * resolution tier already produces (`buildMapUrl`), with NO road
 * recognition, NO dataset lookup, and NO label of any kind attached.
 * Returns null for anything that isn't a genuinely valid coordinate pair
 * — never guesses, never partially trusts a malformed value.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string|null}
 */
export function buildDirectCoordinateMapUrl(latitude, longitude) {
  if (!isValidRawCoordinate(latitude, longitude)) return null;
  return buildMapUrl(latitude, longitude);
}

function buildProvincialLabel(point) {
  if (point.label) return point.label;
  return [point.county, point.township, point.village].filter(Boolean).join('');
}

function resolveProvincial({ road, targetKm, datasetOverride }) {
  const dataset = (datasetOverride && datasetOverride.provincial) || provincialDatasetDefault;
  const allPoints = (dataset && Array.isArray(dataset.points)) ? dataset.points : [];
  const points = allPoints.filter((p) => p.road === road);
  if (points.length === 0) return failClosed('no-data', { dataset: 'provincial', road });

  const nearest = nearestPoint(points, targetKm);
  if (!nearest || nearest.dist > PROVINCIAL_TOLERANCE_KM) {
    return failClosed('too-far', { dataset: 'provincial', road, targetKm });
  }

  const label = buildProvincialLabel(nearest.point);
  if (!label) return failClosed('no-label', { dataset: 'provincial', road, targetKm });

  const coordinate = buildMapUrl(nearest.point.lat, nearest.point.lng)
    ? { lat: nearest.point.lat, lng: nearest.point.lng }
    : null;

  return {
    resolved: true,
    dataset: 'provincial',
    road,
    targetKm,
    resolvedKm: nearest.point.km,
    locationLabel: label,
    segmentFrom: null,
    segmentTo: null,
    coordinate,
    mapUrl: coordinate ? buildMapUrl(coordinate.lat, coordinate.lng) : null,
  };
}

// Direction-aware ordering, per spec: 南/東 = ascending KM order (lower KM
// first), 北/西 = descending KM order (higher KM first), any other/
// unrecognized direction = neutral ascending fallback — NEVER guessed
// from anything other than the literal `direction` string.
function isDescendingDirection(direction) {
  return direction === '北向' || direction === '西向';
}

function buildFreewaySegment(facilities, targetKm, direction) {
  let before = null; // largest km <= targetKm
  let after = null; // smallest km >= targetKm
  for (const f of facilities) {
    if (f.km <= targetKm && (!before || f.km > before.km)) before = f;
    if (f.km >= targetKm && (!after || f.km < after.km)) after = f;
  }
  if (before && Math.abs(targetKm - before.km) > FREEWAY_FACILITY_MAX_GAP_KM) before = null;
  if (after && Math.abs(after.km - targetKm) > FREEWAY_FACILITY_MAX_GAP_KM) after = null;

  if (before && after && before.km !== after.km) {
    const descending = isDescendingDirection(direction);
    const from = descending ? after : before;
    const to = descending ? before : after;
    return { label: `${from.name}－${to.name}路段`, from: from.name, to: to.name };
  }

  const single = before || after;
  if (single) return { label: `${single.name}附近`, from: single.name, to: null };

  return null;
}

function resolveFreeway({ road, direction, targetKm, datasetOverride }) {
  const facilitiesDataset = (datasetOverride && datasetOverride.freewayFacilities) || freewayFacilitiesDatasetDefault;
  const milestonesDataset = (datasetOverride && datasetOverride.freeway) || freewayDatasetDefault;

  const facilities = ((facilitiesDataset && Array.isArray(facilitiesDataset.facilities)) ? facilitiesDataset.facilities : [])
    .filter((f) => f.road === road);
  const milestones = ((milestonesDataset && Array.isArray(milestonesDataset.points)) ? milestonesDataset.points : [])
    .filter((p) => p.road === road);

  if (facilities.length === 0 && milestones.length === 0) return failClosed('no-data', { dataset: 'freeway', road });

  const segment = buildFreewaySegment(facilities, targetKm, direction);
  const nearestMilestone = nearestPoint(milestones, targetKm);
  const coordinate =
    nearestMilestone && nearestMilestone.dist <= FREEWAY_MILESTONE_TOLERANCE_KM
      ? { lat: nearestMilestone.point.lat, lng: nearestMilestone.point.lng }
      : null;

  if (!segment && !coordinate) return failClosed('too-far', { dataset: 'freeway', road, targetKm });

  return {
    resolved: true,
    dataset: 'freeway',
    road,
    targetKm,
    resolvedKm: nearestMilestone ? nearestMilestone.point.km : null,
    locationLabel: segment ? segment.label : null,
    segmentFrom: segment ? segment.from : null,
    segmentTo: segment ? segment.to : null,
    coordinate,
    mapUrl: coordinate ? buildMapUrl(coordinate.lat, coordinate.lng) : null,
  };
}

/**
 * @param {{road:string, direction?:string, startKM?:string|number, endKM?:string|number, displayKM?:number}} input
 * @param {{datasetOverride?: {provincial?:object, freeway?:object, freewayFacilities?:object}}} [options]
 *   datasetOverride is TEST-ONLY (see e.g. broadcastPipeline.js's own
 *   cctvCodecOverride precedent) — Production code never passes it; tests
 *   inject synthetic TEST-FIXTURE datasets shaped exactly like the real
 *   generated/*.js default exports, without ever touching those files.
 * @returns {{resolved:boolean, reason?:string, dataset?:string, road?:string,
 *   targetKm?:number, resolvedKm?:number|null, locationLabel?:string|null,
 *   segmentFrom?:string|null, segmentTo?:string|null,
 *   coordinate?:{lat:number,lng:number}|null, mapUrl?:string|null}}
 *   Never throws.
 */
export function resolveKmLocation(input, { datasetOverride } = {}) {
  try {
    const { road, direction, startKM, endKM, displayKM } = input || {};
    const targetKm = selectTargetKm({ startKM, endKM, displayKM });
    if (targetKm === null) return failClosed('no-km');

    const freewayRoad = canonicalFreewayRoad(road);
    if (freewayRoad) return resolveFreeway({ road: freewayRoad, direction, targetKm, datasetOverride });

    const provincialRoad = canonicalProvincialRoad(road);
    if (provincialRoad) return resolveProvincial({ road: provincialRoad, targetKm, datasetOverride });

    return failClosed('unknown-road');
  } catch {
    // Never let a resolver bug reach the caller — same isolation
    // principle as broadcastProvenance.js's recordBroadcastProvenance.
    return failClosed('resolver-error');
  }
}

// V1.8.7.0 — Dynamic Shoulder range → human-readable section name
// ("○○交流道－○○交流道路段"). Deliberately a THIN wrapper over
// resolveKmLocation, NOT a second resolution engine: resolveKmLocation's
// own selectTargetKm() already averages startKM/endKM into the range's
// MIDPOINT when both are present, and buildFreewaySegment() already
// brackets that midpoint with the nearest facility BEFORE it and the
// nearest facility AFTER it (direction-aware ordering, same official
// generated freewayFacilities.js dataset, same fail-closed "too-far"/
// "no-data" reasons) — which is exactly "the two interchanges bracketing
// this whole range," not just "the interchange nearest one endpoint."
// Reusing it here means: zero new facility-matching logic, zero new
// direction-ordering logic, and zero risk of this function's own
// section-name text ever drifting from what resolveKmLocation would
// independently produce for the same input.
//
// This function only RESHAPES the result into the range-shaped contract
// this round's task spec asks for (`resolveKmRange({road, direction,
// startKM, endKM}) -> {resolved, road, direction, startKm, endKm,
// segmentFrom, segmentTo, locationLabel, representativeCoordinate,
// mapUrl}`) — `startKm`/`endKm` are the PARSED numeric values (via the
// same parseKM already used everywhere else in this codebase), so a
// caller never needs to re-parse the original TDX-formatted strings
// itself. Never guesses a facility, never calls Google/TDX at runtime
// (see resolveKmLocation's own module comment) — fails closed
// (`resolved:false`) for exactly the same reasons resolveKmLocation
// itself does: unrecognized road, no matching dataset, or nearest
// facility beyond FREEWAY_FACILITY_MAX_GAP_KM.
//
// @param {{road:string, direction?:string, startKM?:string|number, endKM?:string|number}} input
// @param {{datasetOverride?: object}} [options] - TEST-ONLY, see resolveKmLocation.
// @returns {{resolved:boolean, reason?:string, road?:string, direction?:string,
//   startKm?:number|null, endKm?:number|null, segmentFrom?:string|null,
//   segmentTo?:string|null, locationLabel?:string|null,
//   representativeCoordinate?:{lat:number,lng:number}|null, mapUrl?:string|null}}
//   Never throws (resolveKmLocation itself never throws).
export function resolveKmRange(input, options = {}) {
  const { road, direction, startKM, endKM } = input || {};
  const resolution = resolveKmLocation({ road, direction, startKM, endKM }, options);

  const startKm = parseKM(startKM);
  const endKm = parseKM(endKM);

  if (!resolution.resolved) {
    return { resolved: false, reason: resolution.reason, road, direction, startKm, endKm };
  }

  return {
    resolved: true,
    road: resolution.road,
    direction,
    startKm,
    endKm,
    segmentFrom: resolution.segmentFrom,
    segmentTo: resolution.segmentTo,
    locationLabel: resolution.locationLabel,
    representativeCoordinate: resolution.coordinate,
    mapUrl: resolution.mapUrl,
  };
}

// 2026-08-24 — COORDINATE → LOCATION (reverse of resolveKmLocation).
//
// WHY THIS EXISTS
// ---------------
// A real Production LINE push read, in full:
//
//   🚨 交通事故 / 台68 西向 / （南寮竹東）-台68線 / 事故影響通行…
//
// "（南寮竹東）-台68線" is not a location at all — it is PBS's official
// ROUTE NAME for the whole of 台68 (the same string this repo already
// documents as a real areaNm example in pbs/roadName.js), spanning KM 0
// 南寮 to KM 22.9 竹東. A driver cannot act on it.
//
// The reason the message had nothing better is structural, not
// accidental. A PBS record carries `x1`/`y1` coordinates, and
// pbs/normalize.js faithfully keeps them as latitude/longitude — but
// until now NOTHING on the display side ever read them: resolveKmLocation
// above starts from a KM value (selectTargetKm), and PBS has no
// structured KM at all, only the free-text `displayKM` its `comment`
// sometimes yields. So a PBS event WITH exact coordinates and a PBS event
// with none produced byte-identical output. That is "we already had the
// precise data and threw it away", and it is fixed here rather than
// papered over by blocking the event.
//
// WHAT IT DOES
// ------------
// The inverse lookup of resolveProvincial/resolveFreeway, over the SAME
// bundled official datasets, with the SAME fail-closed contract: find the
// nearest milestone ON THIS ROAD to the given coordinate. The road is
// always already known from the event, so this never asks the much harder
// "which road is this point on" question — only "where along this road",
// which the milestone data answers directly.
//
// Zero network, zero TDX: same bundled generated/*.js datasets, same
// never-throws discipline as resolveKmLocation.
const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. Plain haversine — no dependencies. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Measured against the real bundled datasets, not guessed: consecutive
// milestones sit ~100m apart on both the provincial (7040) and freeway
// (95016 points) sets, so a coordinate genuinely on this road is at most
// ~50m from the nearest one plus whatever positional error the upstream
// report carries. 0.5 km leaves generous room for that error while still
// being far tighter than the length of any road segment a human would
// call "整條路" — and because the candidate set is already restricted to
// THIS road, a wider tolerance can only ever mis-place a point ALONG the
// correct road, never onto a different one.
export const COORDINATE_MATCH_TOLERANCE_KM = 0.5;

// The coordinate path is the only one that runs for EVERY event on the
// eligibility gate (see locationQuality.js), and 國道一號 alone has ~10k
// milestones, so re-filtering the whole dataset per call is wasted CPU on
// the Cron hot path. Keyed by the dataset OBJECT so a test's
// datasetOverride never pollutes the Production datasets' entry, and
// WeakMap so an override is collected with the test that made it.
const pointsByRoadCache = new WeakMap();
function pointsForRoad(dataset, road) {
  let byRoad = pointsByRoadCache.get(dataset);
  if (!byRoad) {
    byRoad = new Map();
    for (const point of dataset.points) {
      const list = byRoad.get(point.road);
      if (list) list.push(point);
      else byRoad.set(point.road, [point]);
    }
    pointsByRoadCache.set(dataset, byRoad);
  }
  return byRoad.get(road) || [];
}

function nearestPointToCoordinate(points, latitude, longitude) {
  let best = null;
  let bestDist = Infinity;
  for (const point of points) {
    if (typeof point.lat !== 'number' || typeof point.lng !== 'number') continue;
    const dist = haversineKm(latitude, longitude, point.lat, point.lng);
    if (dist < bestDist) {
      best = point;
      bestDist = dist;
    }
  }
  return best ? { point: best, dist: bestDist } : null;
}

/**
 * Turn an event's own coordinates into the same kind of driver-readable
 * location resolveKmLocation produces from a KM value.
 *
 * @param {{road:string, direction?:string, latitude?:number, longitude?:number}} input
 * @param {{datasetOverride?: {provincial?:object, freeway?:object, freewayFacilities?:object}}} [options]
 *   TEST-ONLY, exactly as on resolveKmLocation.
 * @returns {{resolved:boolean, reason?:string, dataset?:string, road?:string,
 *   resolvedKm?:number|null, distanceKm?:number, locationLabel?:string|null,
 *   segmentFrom?:string|null, segmentTo?:string|null,
 *   coordinate?:{lat:number,lng:number}|null, mapUrl?:string|null}}
 *   Never throws.
 */
export function resolveCoordinateLocation(input, { datasetOverride } = {}) {
  try {
    const { road, direction, latitude, longitude } = input || {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return failClosed('no-coordinate');

    const freewayRoad = canonicalFreewayRoad(road);
    const provincialRoad = freewayRoad ? null : canonicalProvincialRoad(road);
    if (!freewayRoad && !provincialRoad) return failClosed('unknown-road');

    const dataset = freewayRoad
      ? (datasetOverride && datasetOverride.freeway) || freewayDatasetDefault
      : (datasetOverride && datasetOverride.provincial) || provincialDatasetDefault;
    const canonicalRoad = freewayRoad || provincialRoad;
    const points = dataset && Array.isArray(dataset.points) ? pointsForRoad(dataset, canonicalRoad) : [];
    if (points.length === 0) {
      return failClosed('no-data', { dataset: freewayRoad ? 'freeway' : 'provincial', road: canonicalRoad });
    }

    const nearest = nearestPointToCoordinate(points, latitude, longitude);
    if (!nearest || nearest.dist > COORDINATE_MATCH_TOLERANCE_KM) {
      return failClosed('too-far', {
        dataset: freewayRoad ? 'freeway' : 'provincial',
        road: canonicalRoad,
        distanceKm: nearest ? Number(nearest.dist.toFixed(3)) : null,
      });
    }

    // The coordinate has now been placed at a real KM on this road, so
    // the EXISTING KM-based resolvers own everything downstream — the
    // 交流道－交流道 segment naming for a freeway, the 縣市/鄉鎮/里 label
    // for a 省道. No second labelling engine, and no chance of this path
    // ever naming a place differently from the KM path for the same spot.
    const viaKm = resolveKmLocation(
      { road: canonicalRoad, direction, startKM: nearest.point.km },
      { datasetOverride }
    );

    const coordinate = { lat: nearest.point.lat, lng: nearest.point.lng };
    return {
      resolved: true,
      dataset: freewayRoad ? 'freeway' : 'provincial',
      road: canonicalRoad,
      resolvedKm: nearest.point.km,
      distanceKm: Number(nearest.dist.toFixed(3)),
      locationLabel: viaKm.resolved ? viaKm.locationLabel : null,
      segmentFrom: viaKm.resolved ? viaKm.segmentFrom : null,
      segmentTo: viaKm.resolved ? viaKm.segmentTo : null,
      coordinate,
      mapUrl: buildMapUrl(coordinate.lat, coordinate.lng),
    };
  } catch {
    return failClosed('resolver-error');
  }
}
