// Maps a raw PBS record onto the unified-ish PBS event schema. PBS-
// specific extra fields (latitude/longitude/sourceDetail/happenedAt/
// roadtype/pbsCategory) ride alongside the common source/type/title/
// description/road/direction/location/startTime/endTime/updatedAt shape
// used elsewhere in this project.
//
// Time format assumption (unverified live — see pbsConfig.js's module
// comment): happendate ("2026-08-15") + happentime ("22:14:00") and
// modDttm are both Asia/Taipei local time, "YYYY-MM-DD HH:MM:SS"-shaped.

import { normalizePbsRoad } from './roadName.js';
import { classifyPbsEvent } from './classify.js';
import { classifyCongestionSeverity } from '../traffic/congestionSeverity.js';
import { buildUpstreamSnapshot } from '../traffic/pipelineTrace.js';
// V1.8.6.8 — moved to its own module (directionEquivalence.js) so
// traffic/pipelineTrace.js can reuse the SAME table without a circular
// import (this file already imports FROM pipelineTrace.js above) — see
// that module's own comment. Re-exported here unchanged so every
// existing importer of `normalizePbsDirection` from this file (this
// module's own use below, test/pbsNormalize.test.js) keeps working.
export { normalizePbsDirection } from '../traffic/directionEquivalence.js';
import { normalizePbsDirection } from '../traffic/directionEquivalence.js';

/** Asia/Taipei is fixed UTC+8 (no DST) — same approach used throughout this project. */
function taipeiPartsToUtcIso(year, month, day, hour, minute, second) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second)).toISOString();
}

/** happendate ("2026-08-15") + happentime ("22:14:00") -> ISO instant. */
export function parseHappenedAt(happendate, happentime) {
  if (!happendate) return null;
  const dateMatch = String(happendate).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return null;
  const timeMatch = String(happentime || '00:00:00').match(/(\d{2}):(\d{2}):(\d{2})/);
  const [, y, m, d] = dateMatch;
  const [, hh, mm, ss] = timeMatch || [null, '00', '00', '00'];
  return taipeiPartsToUtcIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
}

/** modDttm ("2026-08-15 22:20:00" or "2026-08-15T22:20:00") -> ISO instant. */
export function parsePbsDateTime(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return taipeiPartsToUtcIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
}

function toFiniteNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// V1.8.5.1 — production repro (2026-08-18): a real 17:05 accident LINE
// message showed no KM at all, only a route-name string ("中山高速公路-
// 國道1號") on the second line. Root cause: PBS never carries a
// structured KM field (see module comment — road/direction/areaNm/
// roadtype/comment/dates/x1/y1/srcdetail is the ENTIRE raw shape), so
// `startKM`/`endKM` are simply never set on a PBS event — but PBS's own
// `comment` free text frequently DOES state an official kilometer marker
// (the already-confirmed real fixture below: "西行在8.1公里處內側車道發生
// 交通事故"). This extracts that as a DISPLAY-ONLY value.
//
// `displayKM` is deliberately NEVER treated as reliable positional data:
// - CHANGED 2026-08-25, by explicit human order (PBS_ACCIDENT_CCTV_
//   ENRICHMENT_FIX). This used to read: "cctv/dynamicCollage.js's
//   eventTargetKm() reads ONLY startKM/endKM — never displayKM — so a PBS
//   accident can never gain CCTV eligibility just because its comment
//   happened to mention a kilometer." That boundary made sense while TDX
//   was the 國道 feed; under TRAFFIC_SOURCE_MODE=PBS_ONLY it meant no PBS
//   accident could EVER get a camera, and a real 國3 96K+700 accident was
//   pushed image-less because of it. eventTargetKm() now accepts
//   displayKM as its LAST tier, after structured KM. What has not changed
//   is why that is safe: this parser is strict (an explicit K/公里 marker
//   is required), and traffic/locationQuality.js has already accepted the
//   same value as this event's proof of a broadcastable position.
// - notified.js's computeNotificationFingerprint() and
//   incidentSuppression.js's own (separate, pre-existing,
//   parseKmFromDescription) free-text KM parser are BOTH untouched by
//   this field — deliberately two independent parsers reading the same
//   comment text for two different purposes, so a bug in the new
//   display-only parser can never change what already-working
//   suppression/fingerprint logic decides.
//
// Deliberately strict: only digits immediately followed by a "K"/
// "K+NNN" unit or "公里" count — a bare number in unrelated text (e.g.
// "2車事故、3人受傷、17:05") must never be misread as a kilometer.
const DISPLAY_KM_K_PLUS_PATTERN = /(\d+(?:\.\d+)?)\s*K\s*\+\s*(\d{1,3})/i; // "93K+300"
const DISPLAY_KM_BARE_K_PATTERN = /(\d+(?:\.\d+)?)\s*K(?!\s*\+)\b/i; // "93K", "93.3K"
const DISPLAY_KM_PLAIN_PATTERN = /(\d+(?:\.\d+)?)\s*公里/; // "93公里", "93.3公里", "8.1公里處"

/**
 * Parses a single official kilometer marker out of PBS free text, for
 * DISPLAY ONLY — never returns a range (PBS comment text was never
 * observed to state a range, only a single point). Returns a plain
 * number (km, e.g. 93.3) or null if nothing recognizable is present.
 */
/**
 * V1.8.6.4 (provenance gap, follow-up round) — same parsing as
 * extractDisplayKmFromText below (that function is now a thin wrapper
 * around this one, single source of truth, no duplicate regex logic),
 * but also returns the raw MATCHED SUBSTRING (`matchedText`, e.g.
 * "8.1公里") for debug provenance — never the full comment text, just the
 * few characters that actually decided the value.
 */
export function extractDisplayKmMatch(text) {
  if (!text) return null;

  const kPlusMatch = text.match(DISPLAY_KM_K_PLUS_PATTERN);
  if (kPlusMatch) return { value: parseFloat(kPlusMatch[1]) + parseInt(kPlusMatch[2], 10) / 1000, matchedText: kPlusMatch[0] };

  const bareKMatch = text.match(DISPLAY_KM_BARE_K_PATTERN);
  if (bareKMatch) return { value: parseFloat(bareKMatch[1]), matchedText: bareKMatch[0] };

  const plainKmMatch = text.match(DISPLAY_KM_PLAIN_PATTERN);
  if (plainKmMatch) return { value: parseFloat(plainKmMatch[1]), matchedText: plainKmMatch[0] };

  return null;
}

export function extractDisplayKmFromText(text) {
  const match = extractDisplayKmMatch(text);
  return match ? match.value : null;
}

// V1.8.6.4 (provenance gap) — same 80-char debug-value cap used by
// tdx/normalize.js and pbs/classify.js, duplicated locally per this
// project's existing convention (see e.g. broadcastPipeline.js's own
// local safeErrorMessage) rather than a shared cross-module import.
const PROVENANCE_VALUE_MAX_CHARS = 80;
function truncateForDebug(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > PROVENANCE_VALUE_MAX_CHARS ? `${text.slice(0, PROVENANCE_VALUE_MAX_CHARS)}…` : text;
}

export function normalizePbsEvent(raw) {
  const road = normalizePbsRoad(raw.road, raw.areaNm);
  const direction = normalizePbsDirection(raw.direction);
  const description = (raw.comment || '').trim();
  const happenedAt = parseHappenedAt(raw.happendate, raw.happentime);
  const updatedAt = parsePbsDateTime(raw.modDttm);
  const { type, pbsCategory, classificationSource, nonCollisionAnomaly } = classifyPbsEvent({
    roadtype: raw.roadtype,
    comment: description,
  });
  const displayKmMatch = extractDisplayKmMatch(description);
  const displayKM = displayKmMatch ? displayKmMatch.value : null;

  // V1.8.6.4 (provenance gap) — debug-only origin metadata, mirroring
  // tdx/normalize.js's own `provenance` field. `locationSource` is fixed
  // (PBS only ever has one location field, `areaNm` — unlike TDX's
  // several location-text candidates, there's no "which one won"
  // ambiguity here, just whether it's present at all).
  const provenance = {
    classificationSource,
    ...(raw.areaNm ? { locationSource: { field: 'areaNm', value: truncateForDebug(raw.areaNm) } } : {}),
    ...(displayKmMatch ? { displayKMSource: { field: 'comment', value: truncateForDebug(displayKmMatch.matchedText) } } : {}),
  };

  return {
    source: 'pbs',
    rawId: String(raw.UID ?? ''),
    type,
    title: description ? description.slice(0, 30) : 'PBS 路況通報',
    description,
    road,
    direction,
    location: raw.areaNm || '',
    startTime: happenedAt,
    endTime: null,
    updatedAt,
    latitude: toFiniteNumberOrNull(raw.y1),
    longitude: toFiniteNumberOrNull(raw.x1),
    sourceDetail: raw.srcdetail || '',
    // V1.8.6.6 — see tdx/normalize.js's own nonCollisionAnomalyDetail
    // comment: set only when classifyPbsEvent's non-collision-anomaly
    // override fired; messageFormat.js's resolveOtherAnomalyDetail reads
    // it directly, same reasoning as the TDX side (the raw `roadtype`
    // field that may have carried the anomaly text isn't part of
    // `title`/`description` alone).
    ...(nonCollisionAnomaly ? { nonCollisionAnomalyDetail: nonCollisionAnomaly } : {}),
    // Extra fields beyond the base schema example, used by lifecycle/
    // cross-source-dedup — kept on the event rather than re-deriving them
    // repeatedly downstream.
    happenedAt,
    roadtype: raw.roadtype || '',
    pbsCategory,
    // V1.4.1 — same 車多(moderate)/壅塞(congested) distinction as TDX's
    // RoadEvent normalizer, see congestionSeverity.js. `roadtype`+
    // `description` is the same text classifyPbsEvent() itself just used
    // to decide `type === 'congestion'`.
    ...(type === 'congestion'
      ? { congestionSeverity: classifyCongestionSeverity(`${raw.roadtype || ''} ${description}`) }
      : {}),
    // V1.8.5.1 — see the module comment above this function. Named
    // `displayKM` because display was its only consumer at birth; since
    // 2026-08-25 it is also the last-tier CCTV target kilometre (still
    // never the fingerprint or the suppression parser — those keep their
    // own independent readers).
    ...(displayKM !== null ? { displayKM } : {}),
    // V1.8.6.4 (provenance gap) — never read by the formatter/fingerprint/
    // eligibility/dedupe/CCTV-eligibility, debug-only (see
    // broadcastProvenance.js).
    provenance,
    // V1.8.6.7 (Pipeline Trace) — same debug-only boundary as `provenance`
    // above. PBS's raw shape has no EventSubType/Category analogue — only
    // `roadtype` (mapped to the shared `EventType` field name, so the
    // trace schema doesn't fork by source) and `direction`/`comment` are
    // available; `road`/`direction` here are `raw.road`/`raw.direction`
    // straight from the record, deliberately BEFORE
    // normalizePbsRoad/normalizePbsDirection ran, so a genuine upstream-
    // vs-normalized mismatch stays visible to the trace view.
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: raw.roadtype || null,
      rawDirection: raw.direction || null,
      upstreamUpdatedAt: updatedAt,
      description,
    }),
  };
}
