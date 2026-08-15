// Baseline + dedup + "did anything meaningful change" state, backed by
// TRAFFIC_KV. Deliberately just 2 KV keys total (not one key per event) —
// "儘量少量 key" — and writes only happen when something actually needs to
// change (baseline seeding, or a run with at least one new/updated event).
// A run where everything is a duplicate writes nothing.
//
// This module is split into a pure read (readDedupeState), a pure
// computation (classifyEvents — no I/O at all), and a write
// (commitDedupeState) specifically so /debug/status can read + classify
// without ever being able to write, by construction (it just never calls
// commitDedupeState) — see src/traffic/pipeline.js.

const BASELINE_KEY = 'traffic:baseline';
const STATE_KEY = 'traffic:dedupe-state';

// Per-event dedup window (agreed default). Enforced by pruning entries
// from the state blob on write, not by KV's own per-key TTL, since we only
// have one blob for all events.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Safety-net TTL on the blob itself so abandoned state doesn't linger in
// KV forever if Cron ever stops firing for a long time. This is NOT the
// per-event dedup window — that's pruneExpired() below.
const STATE_KEY_SAFETY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

function eventKey(event) {
  return `${event.source}:${event.rawId}`;
}

// Only fields that actually matter to a driver go into the fingerprint.
// updatedAt is deliberately excluded — a timestamp-only change must never
// count as a "major update" on its own.
export function computeFingerprint(event) {
  return JSON.stringify({
    type: event.type ?? null,
    description: event.description ?? '',
    direction: event.direction ?? '',
    startKM: event.startKM ?? null,
    endKM: event.endKM ?? null,
    blockedLanes: event.blockedLanes ?? null,
  });
}

function pruneExpired(map, nowMs) {
  const pruned = {};
  for (const [key, record] of Object.entries(map || {})) {
    const lastSeenMs = record && record.lastSeenAt ? new Date(record.lastSeenAt).getTime() : 0;
    if (nowMs - lastSeenMs < DEDUP_WINDOW_MS) pruned[key] = record;
  }
  return pruned;
}

/**
 * Read-only — never writes. Safe to call as many times as you like (e.g.
 * from /debug/status on every request) with no effect on future Cron runs.
 *
 * kvAvailable=false covers BOTH "no TRAFFIC_KV binding at all" and "a
 * kv.get() call threw" — both mean we cannot reliably tell new from
 * duplicate, so both must fail closed the same way.
 */
export async function readDedupeState(kv) {
  if (!kv) {
    return {
      kvAvailable: false,
      kvError: 'TRAFFIC_KV binding not configured',
      baselineInitialized: false,
      dedupeMap: {},
    };
  }

  try {
    const [baselineRaw, stateRaw] = await Promise.all([kv.get(BASELINE_KEY), kv.get(STATE_KEY)]);

    let dedupeMap = {};
    if (stateRaw) {
      try {
        const parsed = JSON.parse(stateRaw);
        dedupeMap = parsed && parsed.events && typeof parsed.events === 'object' ? parsed.events : {};
      } catch {
        // Corrupt blob — treat as empty rather than crash; the next
        // successful commit will overwrite it with valid JSON.
        dedupeMap = {};
      }
    }

    return { kvAvailable: true, kvError: null, baselineInitialized: Boolean(baselineRaw), dedupeMap };
  } catch (err) {
    return {
      kvAvailable: false,
      kvError: safeErrorMessage(err),
      baselineInitialized: false,
      dedupeMap: {},
    };
  }
}

/**
 * Pure — no I/O. Given events fetched this run and the state read from KV,
 * decides new / updated / duplicate / baseline-seed. When the baseline
 * hasn't been initialized yet, EVERY event is a baseline seed and none of
 * them are ever new/updated/pushable — this is what stops the first-ever
 * run from flooding a future LINE push with every currently-open event.
 */
export function classifyEvents(events, { baselineInitialized, dedupeMap }) {
  if (!baselineInitialized) {
    return {
      baselineSeedEvents: events,
      newEvents: [],
      updatedEvents: [],
      duplicateEvents: [],
      pushableEvents: [],
    };
  }

  const newEvents = [];
  const updatedEvents = [];
  const duplicateEvents = [];

  for (const event of events) {
    const existing = dedupeMap[eventKey(event)];
    if (!existing) {
      newEvents.push(event);
    } else if (existing.fingerprint !== computeFingerprint(event)) {
      updatedEvents.push(event);
    } else {
      duplicateEvents.push(event);
    }
  }

  return {
    baselineSeedEvents: [],
    newEvents,
    updatedEvents,
    duplicateEvents,
    pushableEvents: [...newEvents, ...updatedEvents],
  };
}

/**
 * The only function in this module allowed to write. Only ever called from
 * the Cron path (src/traffic/scheduled.js via pipeline.js) — /debug/status
 * must never call this.
 *
 * - Baseline run: seeds the state blob with every fetched event and marks
 *   the baseline key, in one write each (2 KV writes total, one-time).
 * - Normal run with 0 new/updated events: writes nothing at all.
 * - Normal run with >=1 new/updated event: one write of the whole blob,
 *   refreshing lastSeenAt for everything seen this run (including
 *   duplicates) so a long-running-but-unchanged event doesn't fall out of
 *   the 24h dedup window while unrelated events keep triggering writes.
 *   (Known residual edge case: if literally nothing changes anywhere for
 *   >24h, an unchanged event's lastSeenAt won't get refreshed either,
 *   since no write happens at all — it could then reappear as "new" once
 *   the window passes. Same 24h-window tradeoff already agreed upon;
 *   documented rather than solved with more writes.)
 */
export async function commitDedupeState(kv, { baselineInitialized, dedupeMap, classification }) {
  if (!kv) return { committed: false, reason: 'no-kv' };

  const now = new Date();
  const nowIso = now.toISOString();

  try {
    if (!baselineInitialized) {
      const nextMap = {};
      for (const event of classification.baselineSeedEvents) {
        nextMap[eventKey(event)] = { fingerprint: computeFingerprint(event), lastSeenAt: nowIso };
      }
      await kv.put(STATE_KEY, JSON.stringify({ events: nextMap, updatedAt: nowIso }), {
        expirationTtl: STATE_KEY_SAFETY_TTL_SECONDS,
      });
      await kv.put(BASELINE_KEY, JSON.stringify({ initialized: true, initializedAt: nowIso }));
      return { committed: true, baselineJustInitialized: true };
    }

    const toWrite = [...classification.newEvents, ...classification.updatedEvents];
    if (toWrite.length === 0) {
      return { committed: false, reason: 'no-changes' };
    }

    const nextMap = pruneExpired(dedupeMap, now.getTime());
    for (const event of [...toWrite, ...classification.duplicateEvents]) {
      nextMap[eventKey(event)] = { fingerprint: computeFingerprint(event), lastSeenAt: nowIso };
    }

    await kv.put(STATE_KEY, JSON.stringify({ events: nextMap, updatedAt: nowIso }), {
      expirationTtl: STATE_KEY_SAFETY_TTL_SECONDS,
    });
    return { committed: true, baselineJustInitialized: false };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}
