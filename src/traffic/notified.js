// Tracks what has actually been PUSHED to LINE, PER TARGET — deliberately
// separate from dedupe.js's "seen" state (seen != notified, see
// broadcastPipeline.js) AND deliberately per-target rather than
// event-level, because a single event often has multiple enabled targets
// (several users + groups) and each target's own LINE Push call can
// succeed or fail independently. One key, no TTL.
//
// Schema (line:notified-state):
// {
//   "events": {
//     "highway:A123": {
//       "targets": {
//         "user:U123": { "fingerprint": "...", "notifiedAt": "..." },
//         "group:C456": { "fingerprint": "...", "notifiedAt": "..." }
//       }
//     }
//   },
//   "lastLinePushAt": "...",
//   "updatedAt": "..."
// }
//
// Target keys are namespaced ("user:<id>" / "group:<id>") so a user ID
// and a group ID can never collide.
//
// Lifecycle: this module does NOT track its own absence/missingSince —
// that would duplicate dedupe.js's machinery. Instead, whenever
// dedupe.js's commitDedupeState() genuinely, healthily prunes an event
// (source-health-aware, same 24h rule), broadcastPipeline.js removes that
// same event key from here in the same run, using the same `now` and the
// same decision — see pipeline.js's `prunedKeys`.

import { computeFingerprint } from './dedupe.js';

const NOTIFIED_KEY = 'line:notified-state';

// V1.2C: how long a target's most recent congestion notification for a
// given corridor "covers" it, regardless of the reported KM range
// wobbling every ~5 minutes (91K～82K -> 89K～82K -> ...). Congestion is
// the only event type this applies to — see
// targetNeedsCongestionNotification below and broadcastPipeline.js,
// which never routes accident/construction/closure/control/alert/other
// through this path. One named constant, not a magic number sprinkled
// around — see project convention (e.g. dedupe.js's
// ABSENCE_GRACE_PERIOD_MS).
export const CONGESTION_COOLDOWN_MS = 30 * 60 * 1000;

export function targetKey(target) {
  return `${target.kind}:${target.id}`;
}

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

/** Read-only. */
export async function readNotifiedState(kv) {
  if (!kv) {
    return {
      kvAvailable: false,
      kvError: 'TRAFFIC_KV binding not configured',
      notifiedMap: {},
      lastLinePushAt: null,
      lastPartialPushFailureCount: 0,
    };
  }

  try {
    const raw = await kv.get(NOTIFIED_KEY);
    let notifiedMap = {};
    let lastLinePushAt = null;
    let lastPartialPushFailureCount = 0;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        notifiedMap = parsed && parsed.events && typeof parsed.events === 'object' ? parsed.events : {};
        lastLinePushAt = typeof parsed?.lastLinePushAt === 'string' ? parsed.lastLinePushAt : null;
        lastPartialPushFailureCount =
          typeof parsed?.lastPartialPushFailureCount === 'number' ? parsed.lastPartialPushFailureCount : 0;
      } catch {
        notifiedMap = {};
        lastLinePushAt = null;
      }
    }
    return { kvAvailable: true, kvError: null, notifiedMap, lastLinePushAt, lastPartialPushFailureCount };
  } catch (err) {
    return {
      kvAvailable: false,
      kvError: safeErrorMessage(err),
      notifiedMap: {},
      lastLinePushAt: null,
      lastPartialPushFailureCount: 0,
    };
  }
}

/**
 * True if THIS target has never been notified of this event, or was
 * notified of a DIFFERENT fingerprint (a real content change — an
 * updatedAt-only change never changes the fingerprint, see
 * dedupe.js#computeFingerprint).
 */
export function targetNeedsNotification(eventKeyStr, target, currentFingerprint, notifiedMap) {
  const eventRecord = notifiedMap[eventKeyStr];
  const targetRecord = eventRecord && eventRecord.targets ? eventRecord.targets[targetKey(target)] : undefined;
  if (!targetRecord) return true;
  return targetRecord.fingerprint !== currentFingerprint;
}

/**
 * The congestion-specific counterpart to targetNeedsNotification — used
 * ONLY for congestion notification keys ("congestion:<road>:<direction>:
 * <corridor>", see congestionCluster.js). Deliberately time-based, not
 * fingerprint-based: a congestion cluster's KM range is expected to shift
 * every ~5 minutes without that being a "real" change a driver needs to
 * hear about again, so unlike targetNeedsNotification this never compares
 * fingerprints at all. It reuses the exact same stored
 * `{ fingerprint, notifiedAt }` target record shape — no new KV schema,
 * no new key namespace beyond the notification-key string itself — just
 * a different read rule: "has it been at least CONGESTION_COOLDOWN_MS
 * since this target was last notified for this corridor?".
 */
export function targetNeedsCongestionNotification(notificationKey, target, notifiedMap, now, cooldownMs = CONGESTION_COOLDOWN_MS) {
  const eventRecord = notifiedMap[notificationKey];
  const targetRecord = eventRecord && eventRecord.targets ? eventRecord.targets[targetKey(target)] : undefined;
  if (!targetRecord || !targetRecord.notifiedAt) return true;

  const notifiedAtMs = new Date(targetRecord.notifiedAt).getTime();
  if (!Number.isFinite(notifiedAtMs)) return true; // corrupt/unreadable timestamp -> don't get stuck silent forever

  return now.getTime() - notifiedAtMs >= cooldownMs;
}

/**
 * Pure — returns a NEW notifiedMap with the given targets marked notified
 * for this event's current fingerprint. Does not write anything; the
 * caller (broadcastPipeline.js) decides when to persist, so a single
 * event's worth of successful targets can be committed independently of
 * other events in the same run (bounds the blast radius of a write
 * failure to one event, not the whole run — see broadcastPipeline.js).
 */
export function applyNotifiedTargets(notifiedMap, eventKeyStr, fingerprint, successfulTargets, now) {
  if (successfulTargets.length === 0) return notifiedMap;

  const nowIso = now.toISOString();
  const existingEvent = notifiedMap[eventKeyStr] || { targets: {} };
  const nextTargets = { ...existingEvent.targets };
  for (const target of successfulTargets) {
    nextTargets[targetKey(target)] = { fingerprint, notifiedAt: nowIso };
  }

  return { ...notifiedMap, [eventKeyStr]: { targets: nextTargets } };
}

/** Removes event keys that dedupe.js just pruned (see pipeline.js's `prunedKeys`). */
export function removePrunedEvents(notifiedMap, prunedKeys) {
  if (!prunedKeys || prunedKeys.length === 0) return notifiedMap;
  const next = { ...notifiedMap };
  let changed = false;
  for (const key of prunedKeys) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : notifiedMap;
}

/** The only write in this module. `lastPartialPushFailureCount` is a
 * snapshot of THIS run's partial-failure event count (0 if none this run)
 * — /debug/status reads it, it does not compute it live (dry-run never
 * pushes, so it has nothing live to compute). */
export async function persistNotifiedState(kv, notifiedMap, lastLinePushAt, now = new Date(), lastPartialPushFailureCount = 0) {
  try {
    await kv.put(
      NOTIFIED_KEY,
      JSON.stringify({ events: notifiedMap, lastLinePushAt, lastPartialPushFailureCount, updatedAt: now.toISOString() })
    ); // no TTL
    return { committed: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}

/** Re-exported for callers that need to fingerprint an event without a
 * second import — same content fingerprint as the seen-dedupe layer. */
export { computeFingerprint };

// V1.5.1 hotfix — dedupe.js's computeFingerprint() deliberately includes
// `description` (the DATA layer needs to know when upstream text
// changed at all, e.g. to keep KV state fresh), but messageFormat.js
// never displays raw description text — so a wording-only upstream edit
// changed the dedupe fingerprint without changing anything a driver
// could actually see, and targetNeedsNotification (fed that fingerprint
// directly) re-notified for content that looked identical on LINE. This
// is the NOTIFICATION-layer counterpart: only fields that could
// plausibly change what's on screen or a route decision. `updatedAt`
// and raw `description` text are deliberately excluded — a
// closure/impassable signal buried in the description text still
// counts, but only as a derived boolean, never the text itself.
const CLOSURE_IMPACT_PATTERNS = [/禁止通行/, /無法通行/, /匝道封閉/, /全線封閉/, /封閉/];

function hasClosureImpactSignal(event) {
  const text = `${event.title || ''} ${event.description || ''}`;
  return CLOSURE_IMPACT_PATTERNS.some((p) => p.test(text));
}

/**
 * The fingerprint used for the per-target "have I already told this
 * target about this exact content" check (targetNeedsNotification) —
 * everywhere EXCEPT congestion, which has its own separate
 * time-cooldown path (targetNeedsCongestionNotification) that never
 * compares fingerprints at all. Deliberately a DIFFERENT, narrower field
 * set than dedupe.js's computeFingerprint(): includes `startKM`/`endKM`
 * when present, otherwise falls back to `location` as the "stable
 * position" signal (some sources — CMS, bus alerts — never carry KM).
 */
export function computeNotificationFingerprint(event) {
  const position =
    event.startKM !== undefined || event.endKM !== undefined
      ? { startKM: event.startKM ?? null, endKM: event.endKM ?? null }
      : { location: event.location || '' };

  return JSON.stringify({
    type: event.type ?? null,
    road: event.road ?? '',
    direction: event.direction ?? '',
    ...position,
    blockedLanes: event.blockedLanes ?? null,
    closureImpact: hasClosureImpactSignal(event),
  });
}
