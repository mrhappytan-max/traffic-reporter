// V1.8.5 correction — shared freeway CCTV metadata KV cache, factored
// into its own tiny module so it can be:
//   - WRITTEN by tdx/hsinchuCctvProbe.js's handleHsinchuCctvProbe, which
//     already makes the ONE allowed TDX CCTV metadata call for its own
//     admin-probe purpose — this module lets that same response ALSO
//     seed the broadcast-facing cache, with zero additional TDX calls.
//   - READ, CACHE-ONLY, by cctv/dynamicCollage.js's real broadcast path.
// Living in its own module (rather than either of those two importing
// from the other) avoids a circular import: dynamicCollage.js already
// imports several things FROM hsinchuCctvProbe.js (selectFourQuadrantCandidates,
// composeCollageFromCandidates, etc).
//
// Key: cctv:freeway-metadata:v1. TTL: 7 days. Camera INVENTORY (which
// CCTVs exist, their RoadID/RoadDirection/LocationMile/VideoStreamURL)
// is near-static metadata — the actual live FRAME is always fetched
// fresh, directly from freeway.gov.tw, on every use, never cached here
// or anywhere else. A stale/missing metadata entry can only cause a
// camera to be missing or a quadrant to come up empty — which already
// fails closed to a placeholder/text-only through the existing
// four-quadrant "null if nothing found" rule and (as of this
// correction) dynamicCollage.js's own cache-miss fail-closed path. It
// can never cause a WRONG image to be served with false confidence.

export const FREEWAY_METADATA_KEY = 'cctv:freeway-metadata:v1';
export const FREEWAY_METADATA_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** Read-only, cache-only — NEVER calls TDX. Returns null on missing/expired/corrupt (KV's own TTL already expires the key server-side). */
export async function readFreewayCctvMetadataCache(kv) {
  if (!kv) return null;
  try {
    const raw = await kv.get(FREEWAY_METADATA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.records)) return null;
    return parsed.records;
  } catch {
    return null;
  }
}

/**
 * Best-effort write. A failure here must NEVER fail the caller's own
 * primary operation — the Admin probe's page must still render
 * correctly even if this particular write fails; only the metadata
 * cache itself stays stale/absent, which the read side already handles
 * as a fail-closed cache miss.
 */
export async function writeFreewayCctvMetadataCache(kv, records, now = new Date()) {
  if (!kv) return { committed: false };
  try {
    await kv.put(FREEWAY_METADATA_KEY, JSON.stringify({ records, fetchedAt: now.toISOString() }), {
      expirationTtl: FREEWAY_METADATA_TTL_SECONDS,
    });
    return { committed: true };
  } catch {
    return { committed: false };
  }
}
