// Baseline + dedup + "did anything meaningful change" state, backed by
// TRAFFIC_KV. Deliberately just 2 KV keys total (not one key per event) —
// "儘量少量 key" — and writes only happen when something actually needs to
// change (baseline seeding, a new/updated event, or an event's
// presence/absence status changing). A run where every event is an
// unchanged, continuously-present duplicate writes nothing at all.
//
// Neither `traffic:baseline` nor `traffic:dedupe-state` carries an
// expirationTtl — no blanket KV-key TTL on either. An event's lifecycle in
// the dedupe-state blob is managed entirely by its own `lastSeenAt` /
// `missingSince` fields: it is only pruned once it has been *consecutively
// absent from the live TDX feed* for ABSENCE_GRACE_PERIOD_MS. An event that
// keeps appearing in every fetch — even for days — is never pruned and
// therefore never reclassified as "new", no matter how much wall-clock
// time passes. This is presence-based, not calendar-time-based.
//
// This module is split into a pure read (readDedupeState), a pure
// computation (classifyEvents — no I/O at all), and a write
// (commitDedupeState) specifically so /debug/status can read + classify
// without ever being able to write, by construction (it just never calls
// commitDedupeState) — see src/traffic/pipeline.js.

const BASELINE_KEY = 'traffic:baseline';
const STATE_KEY = 'traffic:dedupe-state';

// How long an event may be *consecutively missing* from the live TDX feed
// before it's pruned from the dedupe-state blob. Reuses the previously
// agreed 24h number, but the meaning changed: this now measures absence,
// not "time since we last happened to write this key".
const ABSENCE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

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
 * Pure — no I/O, no wall-clock reads. Given events fetched this run and the
 * state read from KV, decides new / updated / duplicate / baseline-seed,
 * plus which stored keys are missing from this run's fetch (candidates for
 * the absence clock in commitDedupeState). When the baseline hasn't been
 * initialized yet, EVERY event is a baseline seed and none of them are
 * ever new/updated/pushable — this is what stops the first-ever run from
 * flooding a future LINE push with every currently-open event.
 *
 * `sourceHealth` = { [sourceId]: boolean } for this run (see
 * fetchAllSources' per-source `ok`). A stored key only becomes a
 * "missingKey" candidate if ITS source reported ok===true this run — if
 * the source failed (429/5xx/timeout/token error/etc.), we genuinely don't
 * know whether that source's existing events are still there or not, so
 * they are left completely untouched: not new, not updated, not missing,
 * not pruned. "Source failed" must never be misread as "event resolved".
 */
export function classifyEvents(events, { baselineInitialized, dedupeMap, sourceHealth = {} }) {
  if (!baselineInitialized) {
    return {
      baselineSeedEvents: events,
      newEvents: [],
      updatedEvents: [],
      duplicateEvents: [],
      pushableEvents: [],
      missingKeys: [],
    };
  }

  const seenKeys = new Set();
  const newEvents = [];
  const updatedEvents = [];
  const duplicateEvents = [];

  for (const event of events) {
    const key = eventKey(event);
    seenKeys.add(key);
    const existing = dedupeMap[key];
    if (!existing) {
      newEvents.push(event);
    } else if (existing.fingerprint !== computeFingerprint(event)) {
      updatedEvents.push(event);
    } else {
      duplicateEvents.push(event);
    }
  }

  const missingKeys = Object.keys(dedupeMap || {}).filter((key) => {
    if (seenKeys.has(key)) return false;
    const source = key.slice(0, key.indexOf(':'));
    return sourceHealth[source] === true; // unhealthy/unknown source -> not a candidate
  });

  return {
    baselineSeedEvents: [],
    newEvents,
    updatedEvents,
    duplicateEvents,
    pushableEvents: [...newEvents, ...updatedEvents],
    missingKeys,
  };
}

/**
 * The only function in this module allowed to write. Only ever called from
 * the Cron path (src/traffic/scheduled.js via pipeline.js) — /debug/status
 * must never call this.
 *
 * `now` defaults to the real clock; tests pass an explicit Date to
 * simulate many Cron ticks without actually sleeping.
 *
 * - Baseline run: seeds the state blob with every fetched event
 *   (missingSince: null) and marks the baseline key. No TTL on either key.
 * - New/updated events: (re)written with a fresh fingerprint and
 *   missingSince cleared.
 * - A duplicate that was previously flagged missing (a transient feed
 *   blip) has its missingSince cleared on reappearance.
 * - A stored event absent from this run's fetch: on its first missing run,
 *   its absence clock (missingSince) starts. Once ABSENCE_GRACE_PERIOD_MS
 *   of *consecutive* absence has elapsed, it's pruned from the blob.
 * - A run where none of the above applies (every event present and
 *   unchanged) writes nothing at all — this is the common steady state.
 */
export async function commitDedupeState(kv, { baselineInitialized, dedupeMap, classification }, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };

  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  try {
    if (!baselineInitialized) {
      const nextMap = {};
      for (const event of classification.baselineSeedEvents) {
        nextMap[eventKey(event)] = { fingerprint: computeFingerprint(event), lastSeenAt: nowIso, missingSince: null };
      }
      // No expirationTtl on either key — lifecycle is managed entirely by
      // missingSince/ABSENCE_GRACE_PERIOD_MS inside the blob itself.
      await kv.put(STATE_KEY, JSON.stringify({ events: nextMap, updatedAt: nowIso }));
      await kv.put(BASELINE_KEY, JSON.stringify({ initialized: true, initializedAt: nowIso }));
      return { committed: true, baselineJustInitialized: true };
    }

    const nextMap = { ...dedupeMap };
    let changed = false;

    for (const event of [...classification.newEvents, ...classification.updatedEvents]) {
      nextMap[eventKey(event)] = { fingerprint: computeFingerprint(event), lastSeenAt: nowIso, missingSince: null };
      changed = true;
    }

    for (const event of classification.duplicateEvents) {
      const key = eventKey(event);
      const existing = nextMap[key];
      if (existing && existing.missingSince) {
        nextMap[key] = { ...existing, lastSeenAt: nowIso, missingSince: null };
        changed = true;
      }
    }

    for (const key of classification.missingKeys) {
      const existing = nextMap[key];
      if (!existing) continue;
      if (!existing.missingSince) {
        nextMap[key] = { ...existing, missingSince: nowIso };
        changed = true;
      } else if (nowMs - new Date(existing.missingSince).getTime() >= ABSENCE_GRACE_PERIOD_MS) {
        delete nextMap[key];
        changed = true;
      }
    }

    if (!changed) {
      return { committed: false, reason: 'no-changes' };
    }

    await kv.put(STATE_KEY, JSON.stringify({ events: nextMap, updatedAt: nowIso }));
    return { committed: true, baselineJustInitialized: false };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}
