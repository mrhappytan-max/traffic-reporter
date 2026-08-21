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
