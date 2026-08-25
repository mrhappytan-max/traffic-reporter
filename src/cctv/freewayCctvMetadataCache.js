// Shared freeway CCTV metadata store. Read CACHE-ONLY by the broadcast
// path (cctv/dynamicCollage.js); written by tdx/hsinchuCctvProbe.js's
// admin probe, which already makes the ONE allowed TDX CCTV metadata call
// for its own purpose and seeds this store from the same response at zero
// additional TDX cost. Living in its own tiny module (rather than either
// of those two importing from the other) avoids a circular import.
//
// THE DEADLOCK THIS MODULE USED TO CREATE (2026-08-25)
// ----------------------------------------------------
// A real 國道1號 93K accident on 2026-08-25 19:01 was pushed to LINE with
// correct text and NO image. The reason was not the camera selector, the
// frame fetch, or R2 — it was `metadata-cache-unavailable`: the KV key
// simply no longer existed.
//
// It no longer existed because this module wrote it with a 7-day
// `expirationTtl`, and its ONLY writer is an admin probe that cannot run
// while TRAFFIC_SOURCE_MODE=PBS_ONLY (tdx/auth.js refuses to issue a
// token). So seven days after the last probe, KV deleted the inventory and
// nothing was permitted to put it back. Every accident from that moment on
// lost its picture, silently, with no way out that did not involve turning
// TDX back on.
//
// The TTL was a category error. A live camera FRAME is volatile and is
// always fetched fresh from freeway.gov.tw on every use — it is never
// cached here or anywhere else. The camera INVENTORY is the opposite:
// near-static reference data that changes when the highway authority
// builds or moves a camera, published on a 24-hour update interval. Aging
// reference data out on a timer, with no guaranteed way to refill it,
// converts "slightly stale" into "completely gone".
//
// THE THREE THINGS THAT CHANGED
// ------------------------------
//   1. No expirationTtl. The key persists until something deliberately
//      overwrites it.
//   2. A write must be an UPGRADE, never a downgrade. An empty or
//      malformed record set is refused, so a failed or truncated refresh
//      leaves the last good inventory exactly where it was. Nothing in
//      this module can ever delete the inventory.
//   3. A bundled official fallback. data/cctv/generated/ carries the
//      交通部高速公路局 (NFB) open-data inventory, so even a completely
//      empty KV yields a usable camera list. That is what breaks the
//      deadlock for good: the inventory no longer depends on TDX being
//      switched on, or on KV having survived.
//
// Still zero TDX calls, from any path in this file. The fallback is
// compiled into the bundle at build time (scripts/build-cctv-inventory.mjs)
// and read from memory.

import bundledInventory from '../../data/cctv/generated/freewayCctvInventory.js';

export const FREEWAY_METADATA_KEY = 'cctv:freeway-metadata:v1';

/**
 * The official inventory shipped with this Worker. Read-only, in-memory,
 * always present — this is the floor below which the camera list cannot
 * fall, whatever happens to KV.
 */
export const BUNDLED_INVENTORY_RECORDS = Object.freeze(bundledInventory.records);
export const BUNDLED_INVENTORY_METADATA = Object.freeze(bundledInventory.metadata);

/** Minimum shape a record needs before it is worth storing at all. */
function isUsableRecordSet(records) {
  return Array.isArray(records) && records.length > 0;
}

/**
 * Read-only. NEVER calls TDX, never calls the network.
 *
 * KV first (it is the freshest thing available, and is what an admin probe
 * refreshes); the bundled official inventory when KV has nothing usable.
 * Returns records or null — null now means only "not even the bundle is
 * readable", which should be impossible, and is still handled fail-closed
 * by every caller.
 */
export async function readFreewayCctvMetadataCache(kv) {
  const described = await describeFreewayCctvMetadata(kv);
  return described.records.length > 0 ? described.records : null;
}

/**
 * Same read, but reporting WHERE the records came from and how old they
 * are — for /health and the admin pages, so a missing or ancient inventory
 * is visible before the next accident finds it the hard way.
 *
 * Never throws; a broken KV degrades to the bundled inventory.
 *
 * @returns {{records: object[], source: 'kv'|'bundled'|'none', fetchedAt: string|null,
 *   sourceName: string|null, sourceUpdatedAt: string|null, kvAvailable: boolean}}
 */
export async function describeFreewayCctvMetadata(kv) {
  const bundled = () => ({
    records: BUNDLED_INVENTORY_RECORDS,
    source: 'bundled',
    fetchedAt: null,
    sourceName: BUNDLED_INVENTORY_METADATA.sourceAgency || null,
    sourceUpdatedAt: BUNDLED_INVENTORY_METADATA.sourceUpdatedAt || null,
  });

  if (!kv) return { ...bundled(), kvAvailable: false };

  try {
    const raw = await kv.get(FREEWAY_METADATA_KEY);
    if (!raw) return { ...bundled(), kvAvailable: true };
    const parsed = JSON.parse(raw);
    if (!isUsableRecordSet(parsed && parsed.records)) return { ...bundled(), kvAvailable: true };
    return {
      records: parsed.records,
      source: 'kv',
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
      sourceName: typeof parsed.source === 'string' ? parsed.source : null,
      sourceUpdatedAt: typeof parsed.sourceUpdatedAt === 'string' ? parsed.sourceUpdatedAt : null,
      kvAvailable: true,
    };
  } catch {
    return { ...bundled(), kvAvailable: false };
  }
}

/**
 * Best-effort write. A failure here must NEVER fail the caller's own
 * primary operation — the admin probe's page must still render even if
 * this write fails.
 *
 * Two guarantees this function now makes, both of which the old version
 * did not:
 *   - It refuses an empty/malformed record set, so a degraded refresh can
 *     never replace a good inventory with nothing.
 *   - It writes with NO expirationTtl, so what it stores stays stored.
 *
 * @param {object} [options] `source`/`sourceUpdatedAt` record provenance
 *   (e.g. 'NFB_OPEN_DATA' plus the file's own UpdateTime) so a future
 *   reader can tell an official-inventory seed from a TDX refresh.
 */
export async function writeFreewayCctvMetadataCache(kv, records, now = new Date(), options = {}) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  if (!isUsableRecordSet(records)) return { committed: false, reason: 'refused-empty-record-set' };
  try {
    const payload = {
      records,
      fetchedAt: now.toISOString(),
      ...(options.source ? { source: options.source } : {}),
      ...(options.sourceUpdatedAt ? { sourceUpdatedAt: options.sourceUpdatedAt } : {}),
    };
    // Deliberately no expirationTtl — see this module's header.
    await kv.put(FREEWAY_METADATA_KEY, JSON.stringify(payload));
    return { committed: true, recordCount: records.length };
  } catch {
    return { committed: false, reason: 'kv-error' };
  }
}
