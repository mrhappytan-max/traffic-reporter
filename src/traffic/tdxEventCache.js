// V1.6.2 — PBS-only tick cross-source dedup fix. TDX (freeway+highway) is
// only fetched every 20 minutes now (see tdxSchedule.js); a PBS-only tick
// (08:10/08:30/08:50 etc.) has summary.allEvents === [] this run, so PBS
// could never cross-source-dedup against a TDX event seen 10-20 minutes
// ago — the SAME real incident TDX already saw at :00 would look "new"
// again from PBS at :10, and get broadcast a second time.
//
// This module is the minimal fix: a small, isolated KV cache of the LAST
// SUCCESSFUL scheduled TDX fetch's normalized, Hsinchu-relevant,
// production (freeway+highway) events. It is:
//   - written ONLY by scheduled.js, ONLY right after a genuinely
//     successful scheduled TDX fetch (at least one source ok);
//   - read ONLY to feed crossSourceDedup's MATCHING step on a tick that
//     didn't fetch TDX itself (see scheduled.js) — it never creates a
//     TDX new/updated event (dedupe.js's own classification already
//     happened, entirely from this run's real `summary`, before this
//     cache is even consulted), never touches dedupe.js's own
//     lifecycle/KV state, and never re-enters mergeForBroadcast as if it
//     were "this run's TDX event" — mergeForBroadcast still only ever
//     receives THIS run's real summary.allEvents (empty on a skip tick),
//     so a cache-matched PBS event is correctly suppressed as an
//     already-seen duplicate, not re-broadcast as new;
//   - self-expiring by AGE, not a KV TTL: a cache older than
//     TDX_EVENT_CACHE_MAX_AGE_MS is simply not used (degrades to "no
//     cross-source dedup input this tick"), so TDX's overnight sleep
//     (22:00–08:00) can never have a stale multi-hour-old cache silently
//     suppress a genuinely new PBS report.
//
// Isolated KV key (tdx:last-production-events:v1), independent of every
// other state key in this project. Stores only the same normalized event
// fields already public via GET /debug/tdx and GET /debug/status — no
// raw upstream response, no token, no secret.

const TDX_EVENT_CACHE_KEY = 'tdx:last-production-events:v1';
export const TDX_EVENT_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

/**
 * Only ever call this after a scheduled TDX fetch where at least one
 * source succeeded — see scheduled.js. `events` should be this run's
 * `summary.allEvents` (already normalized + Hsinchu-filtered, freeway+
 * highway only). Never throws — a failure here must never break the
 * Cron run (same convention as healthSnapshot.js's persist function).
 */
export async function persistProductionTdxEventCache(kv, events, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    await kv.put(TDX_EVENT_CACHE_KEY, JSON.stringify({ lastFetchedAt: now.toISOString(), events }));
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/**
 * Read-only. Returns `{ events, lastFetchedAt, stale }`:
 *   - `lastFetchedAt`: when the cache was written (null if never written,
 *     unreadable, or corrupt) — purely informational, safe to surface on
 *     a debug page.
 *   - `stale`: true when the cache is missing, corrupt, or older than
 *     TDX_EVENT_CACHE_MAX_AGE_MS as of `now`.
 *   - `events`: the cached event list when NOT stale; an empty array
 *     when stale — callers should always use `events` directly (never
 *     read a stale cache's events by mistake), this function already
 *     enforces the age cutoff.
 * Never throws.
 */
export async function readProductionTdxEventCache(kv, now = new Date()) {
  if (!kv) return { events: [], lastFetchedAt: null, stale: true };
  try {
    const raw = await kv.get(TDX_EVENT_CACHE_KEY);
    if (!raw) return { events: [], lastFetchedAt: null, stale: true };

    const parsed = JSON.parse(raw);
    const lastFetchedAt = parsed && typeof parsed.lastFetchedAt === 'string' ? parsed.lastFetchedAt : null;
    const rawEvents = parsed && Array.isArray(parsed.events) ? parsed.events : [];
    if (!lastFetchedAt) return { events: [], lastFetchedAt: null, stale: true };

    const ageMs = now.getTime() - new Date(lastFetchedAt).getTime();
    const isStale = !Number.isFinite(ageMs) || ageMs < 0 || ageMs > TDX_EVENT_CACHE_MAX_AGE_MS;
    return { events: isStale ? [] : rawEvents, lastFetchedAt, stale: isStale };
  } catch {
    return { events: [], lastFetchedAt: null, stale: true }; // corrupt blob/KV error -> treat as no cache
  }
}
