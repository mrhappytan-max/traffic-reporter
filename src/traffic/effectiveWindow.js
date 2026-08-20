// Computes when an event actually affects the road, as opposed to when
// TDX happened to publish/update the record. PublishTime/SrcUpdateTime/
// our own `startTime` (TDX's EffectiveTime) are never assumed to equal
// "the moment traffic is actually affected" for anything that could be a
// pre-announced future event (construction/closure/control/other).
//
// Two families of events, treated differently:
//
// 1. "Live" events — CMS signboards, Bus Alerts, and Freeway/Highway
//    accident/congestion records. These describe the current state of the
//    road (a sign showing "壅塞" right now, a live incident feed entry
//    that still exists) rather than a future plan, so their presence in
//    this run's data IS the evidence of current impact. effectiveEnd is
//    left open (null) — they're "ongoing" until they drop out of the feed.
//
// 2. "Announced" events — Freeway/Highway construction/closure/control/
//    other. These are often published ahead of time with a real schedule
//    embedded in the description text ("8月27日8時至24時" etc.). We try to
//    parse that; if parsing fails, we do NOT assume "now" — see
//    TDX_SOURCE_AUDIT.md / the project's "寧可少播" principle. Returning
//    effectiveStart=null tells isBroadcastRelevant() to exclude it.

import { parseChineseDateRange } from './parseChineseDate.js';

const LIVE_SOURCES = new Set(['cms', 'bus-hsinchu', 'bus-hsinchu-county']);
const LIVE_TYPES = new Set(['accident', 'congestion']);

// V1.8.6.6 integration follow-up — real regression found while building
// this round's Fixture B (國1 南向 92.8K "其他異常告警－行人誤闖"): the
// non-collision-anomaly override (tdx/normalize.js's mapRoadEventType,
// pbs/classify.js's classifyPbsEvent — see anomalyClassification.js)
// downgrades `type` from 'accident' to 'other' for a pedestrian/animal
// intrusion report, but 'other' is NOT a LIVE_TYPE above — it falls into
// the "announced" bucket below, which requires a parseable Chinese date
// range in the description (see test 5 in broadcastEligibility.test.js
// for why that requirement is correct for a genuinely pre-announced
// 'other' event, e.g. a flooding advisory that also carries a schedule).
// A pedestrian-intrusion report has no such schedule — it is exactly as
// "right now" as the collision report it was reclassified from, and
// requiring a schedule string here would silently make the reclassified
// event unbroadcastable, turning "wrong text" into "never sent" instead
// of the correct fix. The override attaches `nonCollisionAnomalyDetail`
// as its own marker for exactly this situation — checked here (not by
// widening LIVE_TYPES to include all of 'other', which would change the
// deliberately-tested flooding/rockslide/etc. announced-other behavior)
// so ONLY an event that started life as a live accident-shaped report
// keeps being treated as live after the type downgrade.
function isLiveNonCollisionAnomaly(event) {
  return Boolean(event && event.nonCollisionAnomalyDetail);
}

function isValidDateString(value) {
  if (!value) return false;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms);
}

/**
 * @param {object} event - a normalized unified event (source, type,
 *   description, startTime, endTime, ...)
 * @param {Date} now
 * @returns {{
 *   effectiveStart: string|null, effectiveEnd: string|null,
 *   timeSource: 'structured'|'description'|'fallback',
 *   confidence: 'high'|'medium'|'low',
 * }}
 */
export function computeEffectiveWindow(event, now = new Date()) {
  const isLive = LIVE_SOURCES.has(event.source) || LIVE_TYPES.has(event.type) || isLiveNonCollisionAnomaly(event);

  if (isLive) {
    const effectiveStart = isValidDateString(event.startTime) ? event.startTime : now.toISOString();
    const effectiveEnd = isValidDateString(event.endTime) ? event.endTime : null;
    return { effectiveStart, effectiveEnd, timeSource: 'structured', confidence: 'high' };
  }

  const parsed = parseChineseDateRange(event.description, { referenceDate: now });
  if (parsed) {
    return {
      effectiveStart: parsed.start.toISOString(),
      effectiveEnd: parsed.end.toISOString(),
      timeSource: 'description',
      confidence: parsed.confidence,
    };
  }

  // Can't reliably tell when this actually starts — better to miss it
  // than to broadcast a multi-day-early guess.
  return { effectiveStart: null, effectiveEnd: null, timeSource: 'fallback', confidence: 'low' };
}
