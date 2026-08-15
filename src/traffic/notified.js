// Tracks what has actually been PUSHED to LINE — deliberately separate
// from dedupe.js's "seen" state. An event can be seen by Cron for hours
// before it's ever notified (e.g. it appeared at 07:30, outside broadcast
// hours) — seen != notified. One KV key, no TTL.
//
// identity: source+rawId, same as dedupe.js. "Has this exact content
// already been told to someone?" is answered by comparing the SAME kind
// of content fingerprint (see dedupe.js's computeFingerprint) against what
// was stored the last time we successfully notified this rawId.

import { computeFingerprint } from './dedupe.js';

const NOTIFIED_KEY = 'line:notified-state';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

function eventKey(event) {
  return `${event.source}:${event.rawId}`;
}

/** Read-only. */
export async function readNotifiedState(kv) {
  if (!kv) {
    return {
      kvAvailable: false,
      kvError: 'TRAFFIC_KV binding not configured',
      notifiedMap: {},
      lastLinePushAt: null,
    };
  }

  try {
    const raw = await kv.get(NOTIFIED_KEY);
    let notifiedMap = {};
    let lastLinePushAt = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        notifiedMap = parsed && parsed.events && typeof parsed.events === 'object' ? parsed.events : {};
        lastLinePushAt = typeof parsed?.lastLinePushAt === 'string' ? parsed.lastLinePushAt : null;
      } catch {
        notifiedMap = {};
        lastLinePushAt = null;
      }
    }
    return { kvAvailable: true, kvError: null, notifiedMap, lastLinePushAt };
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), notifiedMap: {}, lastLinePushAt: null };
  }
}

/**
 * True if this event's current content has never been successfully
 * notified, or has changed (a real content fingerprint change, NOT an
 * updatedAt-only change — same rule as dedupe.js) since it last was.
 */
export function needsNotification(event, notifiedMap) {
  const existing = notifiedMap[eventKey(event)];
  if (!existing) return true;
  return existing.fingerprint !== computeFingerprint(event);
}

/**
 * Only ever called after a push has actually, successfully gone out — see
 * broadcastPipeline.js. Never called speculatively.
 */
export async function markNotified(kv, notifiedMap, events, now = new Date(), lastLinePushAt = now.toISOString()) {
  if (!kv || events.length === 0) return { committed: false, reason: events.length === 0 ? 'nothing-to-mark' : 'no-kv' };

  const nowIso = now.toISOString();
  const nextMap = { ...notifiedMap };
  for (const event of events) {
    nextMap[eventKey(event)] = { fingerprint: computeFingerprint(event), notifiedAt: nowIso };
  }

  try {
    await kv.put(NOTIFIED_KEY, JSON.stringify({ events: nextMap, lastLinePushAt, updatedAt: nowIso })); // no TTL
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}
