// A very small in-memory cache holding at most the last successful PBS
// upstream response. Deliberately not persisted anywhere (no KV/Redis/
// disk) — this Relay is minimal, disposable infra; if the process
// restarts, the cache just starts cold again, and the next /pbs request
// re-fetches upstream.

export const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

export function createPbsCache({ ttlMs = CACHE_TTL_MS } = {}) {
  let entry = null; // { rawText, fetchedAt }

  return {
    /** The last successfully cached entry, or null if nothing has ever succeeded. */
    get() {
      return entry;
    },
    /** True if there is an entry and it's within ttlMs of `now`. */
    isFresh(now = Date.now()) {
      return entry != null && now - entry.fetchedAt < ttlMs;
    },
    /** Store a fresh successful upstream response, replacing any prior one. */
    set(rawText, now = Date.now()) {
      entry = { rawText, fetchedAt: now };
    },
  };
}
