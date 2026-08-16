// V1.4.1: the "second opinion" that lets a congestion report actually
// become "🐢 嚴重壅塞" — see congestionSeverity.js for why a bare
// RoadEvent/PBS "壅塞"/"車多" keyword alone is no longer enough. This is
// the ONLY place allowed to set an event's congestionSeverity to
// 'severe' anywhere in the codebase.
//
// Scope: ONLY type==='congestion' events go through this at all.
// Accident/construction/closure/control/alert/other are never touched —
// they don't need a speed check, and skipping them entirely is also
// what keeps this lazy (see below).
//
// Lazy by design: fetchFreewayVdSpeeds() (an extra TDX API call, see
// vdSpeed.js) only ever runs when this run's broadcast list actually
// contains at least one congestion event — a run with none makes zero
// extra TDX calls, see D. in the round's report.
//
// Fail-safe by design: ANY failure (VD fetch/parse error, no nearby
// reading, ambiguous KM) leaves an event's congestionSeverity exactly as
// it already was (from congestionSeverity.js's keyword classification —
// 'moderate'/'congested'/null) — this module only ever RAISES severity,
// never lowers it, never removes/blocks the event, and never touches
// non-congestion events at all. See requirement: "Traffic validation
// failure 時 fail-safe，不影響事故等事件播報".

import { fetchFreewayVdSpeeds, findNearbySpeedKph } from '../tdx/vdSpeed.js';
import { parseKM } from './roadSectionLabel.js';

// Sustained freeway speed below this is treated as genuinely severe
// congestion — a conservative, commonly-used threshold (well below
// typical freeway design/limit speeds), not calibrated against live TDX
// VD data yet (this sandbox cannot reach tdx.transportdata.tw — see
// vdSpeed.js's module comment). Recalibrate here once real VD readings
// are visible via GET /debug/tdx-vd.
export const SEVERE_CONGESTION_MAX_KPH = 40;

function eventKm(event) {
  // Prefer the true start/end (a cluster candidate's numeric startKM/
  // endKM, or a plain RoadEvent's "NNK+NNN" string) — fall back to
  // parsing a KM mention out of the description text (same approach
  // crossSourceDedup.js already uses for PBS events with no structured
  // KM at all).
  const start = parseKM(event.startKM);
  const end = parseKM(event.endKM);
  if (start !== null || end !== null) {
    const vals = [start, end].filter((v) => v !== null);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const match = String(event.description || '').match(/(\d+(?:\.\d+)?)\s*(?:K\s*\+\s*(\d+)|公里)/i);
  if (!match) return null;
  const km = parseFloat(match[1]);
  const meters = match[2] ? parseInt(match[2], 10) / 1000 : 0;
  return km + meters;
}

/**
 * @param {object[]} events - this run's merged broadcast event list (see
 *   crossSourceDedup.mergeForBroadcast) — BEFORE congestionCluster.js
 *   clustering, so an individual member's confirmed 'severe' correctly
 *   propagates through congestionCluster.js's own severity merge.
 * @param {object} env
 * @returns {Promise<object[]>} a NEW array — events are never mutated in
 *   place, matching this codebase's existing pure-transform style
 *   (dedupe.js/notified.js/crossSourceDedup.js all do the same).
 */
export async function applyCongestionSeverityValidation(events, env) {
  const hasCongestion = events.some((e) => e.type === 'congestion');
  if (!hasCongestion) return events; // lazy — no VD call at all this run

  const vd = await fetchFreewayVdSpeeds(env);
  if (!vd.ok || vd.records.length === 0) return events; // fail-safe — leave every severity exactly as-is

  return events.map((event) => {
    if (event.type !== 'congestion') return event;

    const km = eventKm(event);
    const speedKph = findNearbySpeedKph(vd.records, { road: event.road, direction: event.direction, km });
    if (speedKph === null || speedKph >= SEVERE_CONGESTION_MAX_KPH) return event; // not confirmed -> unchanged

    return { ...event, congestionSeverity: 'severe' };
  });
}
