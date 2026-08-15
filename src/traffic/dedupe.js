// KV-backed dedup for normalized events. Key = `source:rawId`, per the
// agreed design — same (source, rawId) seen again within the TTL window
// is treated as a duplicate and dropped from the "pending to broadcast"
// list. The very first run naturally becomes the baseline: everything
// currently open gets recorded, and only genuinely new events (or ones
// whose TTL has expired) show up as pending afterwards.
//
// This module only computes and records dedup state — it does not send
// anything anywhere (no LINE, no push). That's intentionally out of scope
// for this round.

const DEDUP_TTL_SECONDS = 60 * 60 * 24; // 24h, per the agreed default

function dedupeKey(event) {
  return `dedup:${event.source}:${event.rawId}`;
}

/**
 * @param {KVNamespace|undefined} kv - the TRAFFIC_KV binding; may be
 *   undefined in local/test environments without it configured.
 * @param {object[]} events - normalized events already filtered to
 *   Hsinchu-relevant / non-noise records.
 * @returns {{ pending: object[], duplicates: object[], kvAvailable: boolean, kvError: string|null }}
 */
export async function filterNewEvents(kv, events) {
  if (!kv) {
    return { pending: events, duplicates: [], kvAvailable: false, kvError: null };
  }

  const pending = [];
  const duplicates = [];
  let kvError = null;

  for (const event of events) {
    // Without a rawId we can't safely dedupe (every such event would
    // collide on the same key) — always treat as pending rather than risk
    // silently swallowing distinct events.
    if (!event.rawId) {
      pending.push(event);
      continue;
    }

    const key = dedupeKey(event);
    try {
      const existing = await kv.get(key);
      if (existing) {
        duplicates.push(event);
        continue;
      }

      pending.push(event);

      const record = JSON.stringify({
        updatedAt: event.updatedAt ?? null,
        seenAt: new Date().toISOString(),
      });
      await kv.put(key, record, { expirationTtl: DEDUP_TTL_SECONDS });
    } catch (err) {
      // A KV outage should degrade to "treat as pending" rather than
      // silently dropping a real event — surface the error for visibility
      // instead of failing the whole pipeline.
      kvError = err && err.message ? err.message : 'Unknown KV error';
      pending.push(event);
    }
  }

  return { pending, duplicates, kvAvailable: true, kvError };
}
