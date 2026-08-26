// V1.5.1 hotfix — production repro (2026-08-16): the SAME real 國1 南向
// 97K+700 accident notified twice 10 minutes apart. Root cause: the
// existing per-target dedup (notified.js's targetNeedsNotification) is
// keyed on `source:rawId` and compares dedupe.js's computeFingerprint(),
// which includes `description` — a field messageFormat.js never
// displays. So (a) a wording-only description update from
// TDX/PBS, or (b) TDX/PBS reissuing the SAME real accident under a
// DIFFERENT rawId, both look like "new content" even though the LINE
// text a driver actually sees is byte-for-byte identical, and both
// bypass the source:rawId-keyed lookup entirely in case (b).
//
// This module adds an INCIDENT-LEVEL suppression layer for
// type==='accident' ONLY (see broadcastPipeline.js — every other type
// keeps its original per-target fingerprint behavior, just now using
// notified.js's new description-free computeNotificationFingerprint
// instead of dedupe.js's computeFingerprint; congestion's own separate
// cooldown path, see targetNeedsCongestionNotification, is untouched).
// It answers a different question than the per-target fingerprint check:
// not "is this exact source:rawId's fingerprint new to this target" but
// "has this target already been told about the SAME REAL accident
// recently, regardless of which rawId/source reported it this time".
//
// Deliberately its own KV key (line:incident-suppression-state) — same
// isolation principle as pbs:lifecycle-state vs traffic:dedupe-state
// (see lifecycle.js's own header comment): a bug in this brand-new logic
// must never affect the already-working per-target fingerprint dedup for
// every other event type, and vice versa.

import { parseKM } from './roadSectionLabel.js';
import { contentEqual } from '../util/contentEqual.js';

const INCIDENT_STATE_KEY = 'line:incident-suppression-state';

// "同一路、同方向、KM 約 ±1～2 km" — the generous end of the requested
// range. A pairwise proximity comparison against stored incident
// records (same idiom already used by crossSourceDedup.js's
// positionOrKmMatch and vdSpeed.js's findNearbySpeedKph), not a fixed
// KM bucket grid — avoids the exact boundary-hysteresis problem
// roadSectionLabel.js's CORRIDOR_BOUNDARIES comment documents for
// congestion clustering (a report landing just across a bucket edge
// must not look like a "different" incident).
export const INCIDENT_MAX_KM_DIFF = 1.5;

// How long a matched-but-unescalated incident record stays "alive" with
// no new sighting before it's forgotten. Deliberately NOT a "re-notify
// after N minutes" timer — see isMaterialEscalation below, which is the
// ONLY thing allowed to unlock a second notification ("不要只用粗暴 60
// 分鐘鎖死" — a bare timer expiry must never be enough on its own). This
// window exists purely so a genuinely unrelated LATER accident at the
// same coincidental spot, long after the first one cleared, isn't
// wrongly suppressed by stale history.
export const INCIDENT_SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;

// "從可通行變成禁止/無法通行" / a fresh road-closure-grade signal on an
// event that's still nominally type==='accident'. Deliberately a small,
// closure-specific list — NOT reused from broadcastRules.js's
// construction-impact/other-anomaly keyword lists, which answer a
// different question (should this even broadcast) rather than this
// module's question (did an ALREADY-notified accident just get worse).
const CLOSURE_ESCALATION_PATTERNS = [/禁止通行/, /無法通行/, /匝道封閉/, /全線封閉/];

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

function roadDirectionGroupKey(event) {
  return `${event.road || ''}|${event.direction || ''}`;
}

/** "在97.7公里" / "97K+700" style mentions in free text — same regex idiom already used by crossSourceDedup.js/hsinchuFilter.js for PBS events, which never carry structured startKM/endKM. */
function parseKmFromDescription(text) {
  if (!text) return null;
  const kPlusMatch = text.match(/(\d+(?:\.\d+)?)\s*K\s*\+\s*(\d+)/i);
  if (kPlusMatch) return parseFloat(kPlusMatch[1]) + parseInt(kPlusMatch[2], 10) / 1000;
  const plainKmMatch = text.match(/(\d+(?:\.\d+)?)\s*公里/);
  if (plainKmMatch) return parseFloat(plainKmMatch[1]);
  return null;
}

/**
 * Midpoint KM as a plain number, or null if nothing usable at all — same
 * fallback shape used throughout this codebase (crossSourceDedup.js,
 * congestionValidation.js). Falls back to parsing the description text
 * (PBS events never carry structured startKM/endKM — see
 * pbs/normalize.js) so a PBS-sourced accident can still be placed in the
 * same incident family as a TDX one.
 */
function midKm(event) {
  const start = parseKM(event.startKM);
  const end = parseKM(event.endKM);
  const vals = [start, end].filter((v) => v !== null);
  if (vals.length > 0) return vals.reduce((a, b) => a + b, 0) / vals.length;
  return parseKmFromDescription(event.description);
}

function hasClosureEscalationSignal(event) {
  const text = `${event.title || ''} ${event.description || ''}`;
  return CLOSURE_ESCALATION_PATTERNS.some((p) => p.test(text));
}

/** What we compare across sightings to decide "material escalation" — deliberately NOT the raw description, see module comment. */
function computeEscalationSnapshot(event) {
  return {
    type: event.type,
    blockedLanes: typeof event.blockedLanes === 'number' ? event.blockedLanes : null,
    closureSignal: hasClosureEscalationSignal(event),
  };
}

/**
 * @returns {boolean} true only for a change that could plausibly change a
 *   driver's route decision — type escalating away from plain 'accident'
 *   (e.g. TDX/PBS reclassifies it as closure/control), a newly-gained
 *   closure/impassable text signal, or blockedLanes genuinely increasing.
 *   `previous === null` (first-ever sighting) is never itself an
 *   "escalation" — it's just the initial notification.
 */
function isMaterialEscalation(previous, current) {
  if (!previous) return false;
  if (current.type !== previous.type) return true;
  if (current.closureSignal && !previous.closureSignal) return true;
  if (typeof current.blockedLanes === 'number' && typeof previous.blockedLanes === 'number' && current.blockedLanes > previous.blockedLanes) {
    return true;
  }
  return false;
}

/**
 * Read-only.
 *
 * V1.9.2 — `existed` additionally reports whether this key currently
 * holds a VALID, already-persisted incidentsByGroup (raw found AND
 * parsed successfully) — used only by persistIncidentSuppressionState's
 * own WRITE_ON_CHANGE gate below, so a first-ever write (or a write after
 * a corrupt blob) is never skipped just because {} happens to
 * content-equal an empty comparison target. Purely additive; every
 * existing caller that only reads kvAvailable/incidentsByGroup is
 * unaffected.
 */
export async function readIncidentSuppressionState(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', incidentsByGroup: {}, existed: false };
  }
  try {
    const raw = await kv.get(INCIDENT_STATE_KEY);
    let incidentsByGroup = {};
    let existed = false;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.incidents && typeof parsed.incidents === 'object') {
          incidentsByGroup = parsed.incidents;
          existed = true;
        }
      } catch {
        incidentsByGroup = {};
      }
    }
    return { kvAvailable: true, kvError: null, incidentsByGroup, existed };
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), incidentsByGroup: {}, existed: false };
  }
}

/**
 * Pure — no I/O. For each type==='accident' event this run, decides
 * whether it's part of an already-notified, unescalated incident family
 * (suppressed) or should proceed to the normal per-target fingerprint
 * check — and if proceeding, which notificationKey to use (the
 * ORIGINAL incident's key when this is the same family under a new
 * rawId, not necessarily this event's own source:rawId).
 *
 * On no reliable KM for an event (can't confidently place it), this
 * NEVER suppresses — same "fail toward delivering important content,
 * not toward silence" principle broadcastPipeline.js's own
 * effectiveContentSince already documents.
 *
 * @param {object[]} accidentEvents - this run's broadcast-relevant,
 *   type==='accident' events only.
 * @param {object} incidentsByGroup - as read from
 *   readIncidentSuppressionState.
 * @param {Date} now
 * @returns {{
 *   results: Array<{ event: object, notificationKey: string,
 *     suppressed: boolean,
 *     reason: 'new-incident'|'material-escalation'|'same-incident-no-escalation' }>,
 *   nextIncidentsByGroup: object,
 * }}
 */
export function resolveIncidentNotifications(accidentEvents, incidentsByGroup, now) {
  const nextIncidentsByGroup = {};
  for (const [group, records] of Object.entries(incidentsByGroup || {})) {
    const alive = (records || []).filter(
      (r) => r && r.lastSeenAt && now.getTime() - new Date(r.lastSeenAt).getTime() < INCIDENT_SUPPRESSION_WINDOW_MS
    );
    if (alive.length > 0) nextIncidentsByGroup[group] = alive;
  }

  const results = [];

  for (const event of accidentEvents) {
    const group = roadDirectionGroupKey(event);
    const km = midKm(event);
    const escalation = computeEscalationSnapshot(event);
    const eventKeyStr = `${event.source}:${event.rawId}`;
    const groupRecords = nextIncidentsByGroup[group] || [];

    const match = km === null ? null : groupRecords.find((r) => r.km !== null && Math.abs(r.km - km) <= INCIDENT_MAX_KM_DIFF);

    if (!match) {
      results.push({ event, notificationKey: eventKeyStr, suppressed: false, reason: 'new-incident' });
      nextIncidentsByGroup[group] = [...groupRecords, { notificationKey: eventKeyStr, km, lastSeenAt: now.toISOString(), escalation }];
      continue;
    }

    const escalated = isMaterialEscalation(match.escalation, escalation);
    match.lastSeenAt = now.toISOString(); // keep the family "alive" regardless of whether this sighting itself notifies
    match.km = km; // track (small, within-tolerance) drift so later matches compare against the latest known position
    match.escalation = escalation;

    results.push({
      event,
      notificationKey: match.notificationKey,
      suppressed: !escalated,
      reason: escalated ? 'material-escalation' : 'same-incident-no-escalation',
    });
  }

  return { results, nextIncidentsByGroup };
}

/**
 * The only write in this module.
 *
 * V1.9.2 WRITE_ON_CHANGE — real Cloudflare alert (see this module's own
 * V1.9.2 note in the header comment... actually see usageLedger.js's
 * fuller write-up, this is the same gate). `options.previousIncidentsByGroup`
 * / `options.previousStateExisted` are OPTIONAL and default to "no
 * previous known" (always write) — every existing caller that doesn't
 * pass them (every test written before this round) keeps writing
 * unconditionally, byte-for-byte the old behavior.
 *
 * Deliberately compares `incidentsByGroup` in full, INCLUDING each
 * record's own `lastSeenAt` — unlike the top-level `updatedAt` this
 * wrapper adds below, `lastSeenAt` is real functional state
 * (resolveIncidentNotifications advances it on every matched sighting,
 * and a later tick's alive-window pruning depends on that value staying
 * accurate), never a "purely generated, safe to ignore" timestamp. A
 * quiet tick with zero accident events, and nothing aging out of the
 * suppression window, is the ONLY case this actually skips — exactly the
 * common case on a low-traffic day, and precisely why this key was being
 * rewritten every 10 minutes for no informational gain. The
 * suppression/escalation/TTL logic in resolveIncidentNotifications above
 * is completely untouched; this only ever changes whether the already-
 * computed result gets written.
 */
export async function persistIncidentSuppressionState(kv, incidentsByGroup, now, options = {}) {
  const { previousIncidentsByGroup, previousStateExisted = false } = options;
  try {
    if (previousStateExisted && contentEqual(previousIncidentsByGroup, incidentsByGroup)) {
      return { committed: true, written: false };
    }
    await kv.put(INCIDENT_STATE_KEY, JSON.stringify({ incidents: incidentsByGroup, updatedAt: now.toISOString() })); // no TTL, same pattern as every other state key in this project
    return { committed: true, written: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}
