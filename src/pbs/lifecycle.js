// PBS events need a real lifecycle, not just "UID present = active": the
// same UID's `comment` gets updated in place, and a comment like "北控:
// 排除" means the event is over even though the UID never disappears from
// the feed. This tracks active/cleared/stale, backed by its own dedicated
// TRAFFIC_KV key (`pbs:lifecycle-state`) — deliberately separate from
// TDX's `traffic:dedupe-state` so nothing about this brand-new, unverified
// PBS logic can affect the already-working TDX LINE-push pipeline. No TTL
// on the key; lifecycle is managed by lastSeenAt/missingSince inside the
// blob, same principle as dedupe.js.

import { CLEARED_COMMENT_PATTERNS, PBS_STALE_THRESHOLD_MS, PBS_ABSENCE_GRACE_PERIOD_MS } from './pbsConfig.js';

const PBS_STATE_KEY = 'pbs:lifecycle-state';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

export function isClearedComment(comment) {
  if (!comment) return false;
  return CLEARED_COMMENT_PATTERNS.some((p) => p.test(comment));
}

/** modDttm, falling back to happenedAt — "too old and not explicitly cleared" -> stale. */
export function isStalePbsEvent(event, now = new Date()) {
  const referenceIso = event.updatedAt || event.happenedAt;
  if (!referenceIso) return true; // no time info at all -> conservatively stale
  const ms = new Date(referenceIso).getTime();
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms >= PBS_STALE_THRESHOLD_MS;
}

/** Content fingerprint — deliberately excludes updatedAt/modDttm, same rule as dedupe.js. */
export function computePbsFingerprint(event) {
  return JSON.stringify({
    type: event.type,
    road: event.road,
    direction: event.direction,
    description: event.description,
  });
}

/** Read-only. */
export async function readPbsLifecycleState(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', pbsMap: {} };
  }
  try {
    const raw = await kv.get(PBS_STATE_KEY);
    let pbsMap = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        pbsMap = parsed && parsed.events && typeof parsed.events === 'object' ? parsed.events : {};
      } catch {
        pbsMap = {};
      }
    }
    return { kvAvailable: true, kvError: null, pbsMap };
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), pbsMap: {} };
  }
}

/**
 * Pure — no I/O. Splits Hsinchu-filtered PBS events into cleared / stale /
 * active. Order matters: an explicit "排除" comment always wins over
 * staleness (a just-cleared event isn't "stale", it's resolved).
 */
export function classifyPbsLifecycle(events, now = new Date()) {
  const clearedEvents = [];
  const staleEvents = [];
  const activeEvents = [];
  const seenIds = new Set();

  for (const event of events) {
    seenIds.add(event.rawId);
    if (isClearedComment(event.description)) {
      clearedEvents.push(event);
    } else if (isStalePbsEvent(event, now)) {
      staleEvents.push(event);
    } else {
      activeEvents.push(event);
    }
  }

  return { clearedEvents, staleEvents, activeEvents, seenIds };
}

/**
 * The only function in this module allowed to write. Never touches the
 * KV state if `pbsOk` is false (this run's PBS fetch failed) — a source
 * failure must never be misread as "every PBS event resolved", same
 * source-health principle already established for TDX.
 */
export async function commitPbsLifecycleState(kv, pbsMap, { clearedEvents, activeEvents, seenIds }, pbsOk, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  if (!pbsOk) return { committed: false, reason: 'source-unhealthy' };

  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const nextMap = { ...pbsMap };
  let changed = false;

  for (const event of activeEvents) {
    const fingerprint = computePbsFingerprint(event);
    const existing = nextMap[event.rawId];
    if (!existing || existing.fingerprint !== fingerprint || existing.lifecycle !== 'active' || existing.missingSince) {
      nextMap[event.rawId] = { fingerprint, lifecycle: 'active', lastSeenAt: nowIso, missingSince: null };
      changed = true;
    }
  }

  for (const event of clearedEvents) {
    const existing = nextMap[event.rawId];
    if (!existing || existing.lifecycle !== 'cleared') {
      nextMap[event.rawId] = {
        fingerprint: computePbsFingerprint(event),
        lifecycle: 'cleared',
        lastSeenAt: nowIso,
        missingSince: null,
        clearedAt: nowIso,
      };
      changed = true;
    }
  }

  // Absence handling for UIDs stored previously but entirely missing from
  // this run's (healthy) PBS fetch — same consecutive-absence-then-prune
  // rule as TDX's dedupe.js.
  for (const [uid, record] of Object.entries(nextMap)) {
    if (seenIds.has(uid)) continue;
    if (!record.missingSince) {
      nextMap[uid] = { ...record, missingSince: nowIso };
      changed = true;
    } else if (nowMs - new Date(record.missingSince).getTime() >= PBS_ABSENCE_GRACE_PERIOD_MS) {
      delete nextMap[uid];
      changed = true;
    }
  }

  if (!changed) return { committed: false, reason: 'no-changes' };

  try {
    await kv.put(PBS_STATE_KEY, JSON.stringify({ events: nextMap, updatedAt: nowIso })); // no TTL
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}
