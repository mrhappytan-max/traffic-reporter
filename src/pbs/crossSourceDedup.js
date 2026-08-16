// Matches PBS events against this run's TDX (freeway/highway) events that
// might describe the SAME real-world incident, and merges matches into a
// single canonical event so the same accident is never counted or (in a
// future round) pushed twice. Pure computation — no I/O, no KV.
//
// This is deliberately independent from dedupe.js's "seen before" concept
// (same rawId across runs) — cross-source dedup is about two DIFFERENT
// rawIds (one TDX, one PBS) from the SAME point in time describing one
// real event, decided fresh every run.

import {
  CROSS_SOURCE_MAX_DISTANCE_METERS,
  CROSS_SOURCE_MAX_TIME_DIFF_MS,
  CROSS_SOURCE_MAX_KM_DIFF,
} from './pbsConfig.js';

// PBS types collapse several distinct real categories into "other" — two
// "other" events should still be allowed to match each other (e.g. PBS
// obstruction vs a hypothetical TDX "other"), but accident must never
// merge with construction, etc.
function typesCompatible(a, b) {
  return a === b;
}

function roadIdentity(road) {
  if (!road) return '';
  // "國道一號"/"國道1號"/"國1" -> "國道1"; "台68線"/"台68" -> "台68" —
  // strips 線/號 suffixes and unifies numeral forms so PBS's "台68" and
  // TDX's "台68線" (or "國道一號" vs a hypothetical "國道1號") compare equal.
  const numeralMap = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
  let normalized = road;
  for (const [numeral, digit] of Object.entries(numeralMap)) {
    normalized = normalized.replace(numeral, digit);
  }
  return normalized.replace(/線$/, '').replace(/號$/, '');
}

function roadsMatch(roadA, roadB) {
  if (!roadA || !roadB) return false;
  return roadIdentity(roadA) === roadIdentity(roadB);
}

function directionsMatch(dirA, dirB) {
  if (!dirA || !dirB) return false; // no directional info on one side -> don't guess
  return dirA === dirB;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function midKm(event) {
  const start = typeof event.startKM === 'number' ? event.startKM : parseFloat(event.startKM);
  const end = typeof event.endKM === 'number' ? event.endKM : parseFloat(event.endKM);
  const vals = [start, end].filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function positionOrKmMatch(pbsEvent, tdxEvent) {
  const pbsHasCoords = pbsEvent.latitude != null && pbsEvent.longitude != null;
  const tdxHasCoords = tdxEvent.latitude != null && tdxEvent.longitude != null;

  if (pbsHasCoords && tdxHasCoords) {
    return haversineMeters(pbsEvent.latitude, pbsEvent.longitude, tdxEvent.latitude, tdxEvent.longitude) <= CROSS_SOURCE_MAX_DISTANCE_METERS;
  }

  const pbsKm = midKm(pbsEvent) ?? parseKmFromDescription(pbsEvent.description);
  const tdxKm = midKm(tdxEvent);
  if (pbsKm == null || tdxKm == null) return false; // no shared positional signal -> don't guess a match

  return Math.abs(pbsKm - tdxKm) <= CROSS_SOURCE_MAX_KM_DIFF;
}

function parseKmFromDescription(text) {
  if (!text) return null;
  const kPlusMatch = text.match(/(\d+(?:\.\d+)?)\s*K\s*\+\s*(\d+)/i);
  if (kPlusMatch) return parseFloat(kPlusMatch[1]) + parseInt(kPlusMatch[2], 10) / 1000;
  const plainKmMatch = text.match(/(\d+(?:\.\d+)?)\s*公里/);
  if (plainKmMatch) return parseFloat(plainKmMatch[1]);
  return null;
}

function timesMatch(pbsEvent, tdxEvent) {
  const pbsMs = new Date(pbsEvent.updatedAt || pbsEvent.happenedAt).getTime();
  const tdxMs = new Date(tdxEvent.updatedAt || tdxEvent.startTime).getTime();
  if (!Number.isFinite(pbsMs) || !Number.isFinite(tdxMs)) return false;
  return Math.abs(pbsMs - tdxMs) <= CROSS_SOURCE_MAX_TIME_DIFF_MS;
}

/** Finds the first TDX event (if any) that plausibly describes the same real incident as `pbsEvent`. */
export function findCrossSourceMatch(pbsEvent, tdxEvents) {
  for (const tdxEvent of tdxEvents) {
    if (!typesCompatible(pbsEvent.type, tdxEvent.type)) continue;
    if (!roadsMatch(pbsEvent.road, tdxEvent.road)) continue;
    if (!directionsMatch(pbsEvent.direction, tdxEvent.direction)) continue;
    if (!positionOrKmMatch(pbsEvent, tdxEvent)) continue;
    if (!timesMatch(pbsEvent, tdxEvent)) continue;
    return tdxEvent;
  }
  return null;
}

/**
 * TDX's structured fields (road/direction/KM/EventType/BlockedLanes) stay
 * primary; PBS contributes ride-along detail (backup, reporter detail).
 *
 * V1.4: this is now a FULL unified-event object (source/rawId/type/title/
 * description/road/direction/location/startTime/endTime/updatedAt/
 * startKM/endKM) — deliberately keeping the ORIGINAL TDX event's
 * `source`/`rawId` identity, so a canonical (merged) event flows through
 * every existing TDX-shaped mechanism completely unchanged: V1.2C
 * congestion clustering, effectiveWindow.js, and — most importantly —
 * notified.js/dedupe.js's own per-event bookkeeping (no new key scheme,
 * no risk of re-notifying a target for an event they already saw). See
 * mergeForBroadcast() below for how this plugs into broadcastPipeline.js.
 *
 * A driver never sees "tdx"/"pbs" anywhere — messageFormat.js only ever
 * reads road/direction/startKM/endKM/location/type/updatedAt, never
 * `.description`/`.pbsDetail`/`.sources`, which exist here purely for
 * /debug/pbs's crossSourceSample observability.
 */
export function buildCanonicalEvent(tdxEvent, pbsEvent) {
  return {
    source: tdxEvent.source,
    rawId: tdxEvent.rawId,
    type: tdxEvent.type,
    title: tdxEvent.title || pbsEvent.title,
    // 資訊較完整優先: TDX's road/direction/KM are structured and already
    // required to agree with PBS's during matching (see
    // findCrossSourceMatch) — location/description only fall back to PBS
    // when TDX's own side is empty. updatedAt takes whichever source most
    // recently confirmed this is still happening.
    road: tdxEvent.road,
    direction: tdxEvent.direction,
    location: tdxEvent.location || pbsEvent.location,
    description: tdxEvent.description || pbsEvent.description,
    startKM: tdxEvent.startKM,
    endKM: tdxEvent.endKM,
    startTime: tdxEvent.startTime || pbsEvent.startTime || pbsEvent.happenedAt || null,
    endTime: tdxEvent.endTime ?? pbsEvent.endTime ?? null,
    updatedAt: [tdxEvent.updatedAt, pbsEvent.updatedAt].filter(Boolean).sort().at(-1) || null,
    // Debug/observability only (see /debug/pbs's crossSourceSample) —
    // never read by broadcastPipeline.js/messageFormat.js.
    primarySource: 'tdx',
    sources: ['tdx', 'pbs'],
    pbsDetail: pbsEvent.description,
    tdxRawId: tdxEvent.rawId,
    pbsRawId: pbsEvent.rawId,
  };
}

/**
 * Folds this run's TDX events and PBS's cross-source dedup result
 * (crossSourceDedup()'s output, restricted to ACTIVE PBS events per the
 * caller — see pipeline.js) into ONE list for broadcastPipeline.js, so
 * the same real-world incident never produces two LINE messages:
 *
 *   - a TDX event whose rawId got matched (present in `canonicalEvents`)
 *     is REPLACED by its canonical/merged version — same source:rawId
 *     identity, so it keeps its existing notified-state/dedupe/
 *     congestion-cluster behavior;
 *   - a TDX event with no match passes through untouched;
 *   - `uniquePbsEvents` (active, Hsinchu-filtered, no TDX match) are
 *     appended as-is — already unified-event-shaped (source:'pbs',
 *     rawId: the PBS UID) via normalizePbsEvent, so each gets its own
 *     independent notified-state identity.
 *
 * If two PBS events somehow match the same TDX rawId in one run, only
 * the last `canonicalEvents` entry for that key is kept — still exactly
 * one message goes out either way, just with one PBS detail attached
 * instead of two; not worth more complexity for this Alpha round.
 *
 * Pure — no I/O. If `canonicalEvents`/`uniquePbsEvents` are both empty
 * (PBS pipeline unavailable/failed this run), this returns `tdxEvents`
 * completely unchanged, so a PBS outage can never alter TDX's own
 * broadcast.
 */
export function mergeForBroadcast(tdxEvents, canonicalEvents, uniquePbsEvents) {
  const canonicalByKey = new Map(canonicalEvents.map((c) => [`${c.source}:${c.rawId}`, c]));
  const merged = tdxEvents.map((event) => canonicalByKey.get(`${event.source}:${event.rawId}`) || event);
  return [...merged, ...uniquePbsEvents];
}

/**
 * @param {object[]} pbsEvents - active (non-cleared, non-stale), Hsinchu-
 *   filtered PBS events
 * @param {object[]} tdxEvents - this run's Hsinchu-filtered TDX events
 * @returns {{ canonicalEvents: object[], duplicatePbsEvents: object[], uniquePbsEvents: object[] }}
 */
export function crossSourceDedup(pbsEvents, tdxEvents) {
  const canonicalEvents = [];
  const duplicatePbsEvents = [];
  const uniquePbsEvents = [];

  for (const pbsEvent of pbsEvents) {
    const match = findCrossSourceMatch(pbsEvent, tdxEvents);
    if (match) {
      canonicalEvents.push(buildCanonicalEvent(match, pbsEvent));
      duplicatePbsEvents.push(pbsEvent);
    } else {
      uniquePbsEvents.push(pbsEvent);
    }
  }

  return { canonicalEvents, duplicatePbsEvents, uniquePbsEvents };
}
