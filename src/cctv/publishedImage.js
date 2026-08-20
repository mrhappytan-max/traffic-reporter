// V1.8.4 — LINE-safe CCTV image publishing layer. Turns an already-
// composed collage JPEG (see cctv/collage.js) into a short-lived,
// opaque, unauthenticated public HTTPS URL that a future LINE Messaging
// API image message (originalContentUrl/previewImageUrl) could reference
// directly. Required because LINE's servers cannot attach our Admin
// Basic Auth header — /admin/cctv-hsinchu-collage's URL can never be
// handed to LINE directly, and ADMIN_PASSWORD must never be embedded in
// a URL (query string or otherwise) as a workaround.
//
// This round does NOT wire up real LINE push — see
// tdx/hsinchuCctvProbe.js's handleHsinchuCctvPublishTest, an
// Admin-Auth-gated manual test endpoint only.
//
// CORRECTION (post-review, storage moved from Workers KV to R2):
// the first version of this module stored the published JPEG in
// TRAFFIC_KV. Two real Production problems with that:
//   1. `Cache-Control: max-age=900` on the public response does NOT
//      bound the URL's actual public lifetime to 15 minutes — a client
//      that first fetches at, say, T+14:59 can legally keep serving its
//      own cached copy until T+29:59, long after the underlying data
//      should be gone. Expiry must be enforced server-side, on every
//      request, never delegated to an HTTP cache header.
//   2. Workers KV is only EVENTUALLY consistent across Cloudflare's
//      global network — a write can take 60+ seconds to become visible
//      from a different location, and negative lookups get cached too.
//      The intended real-world flow (compose -> store -> immediately
//      push to LINE -> LINE's servers GET the URL, likely from a
//      different Cloudflare location than the one that wrote it) has no
//      read-after-write guarantee on KV, which is unacceptable for
//      incident-time delivery — and "just sleep 60s before pushing" is
//      not an acceptable fix (delays a real incident notification, and
//      still isn't guaranteed correct: the docs say 60s is not a hard
//      upper bound).
// R2 provides strongly consistent read-after-write for object
// PUT/GET/DELETE, which is what this actually needs. CCTV candidate
// storage (tdx/hsinchuCctvProbe.js's CANDIDATES_KEY) is UNCHANGED — it
// stays on TRAFFIC_KV; only the published-image storage moved.
//
// Two structurally separate concerns:
//   - publishCollageImage(bucket, jpegBytes) — the WRITE path. Called
//     only from an Admin-Auth-gated handler (never from the public read
//     path below). Fail-closed: an R2 put failure returns {ok:false}
//     and the caller MUST NOT synthesize/return a URL for it — "不發布
//     URL" / "不要建立假 image entry".
//   - handlePublicCctvImage(env, id) — the READ path, GET
//     /cctv/image/:id. Deliberately NOT in index.js's ADMIN_PATHS/Admin
//     Basic Auth gate — LINE's servers need to fetch this with no
//     credential at all. Security comes from (a) a cryptographically
//     random 128-bit opaque id nothing can feasibly guess/enumerate, and
//     (b) an explicit expiresAt check performed on every single request
//     (never an HTTP cache header, never R2 lifecycle rules alone — see
//     the correction above). This module imports NOTHING
//     TDX/CCTV-fetch/LINE-related — "0 TDX calls, 0 CCTV fetch, 0 LINE
//     calls" for this endpoint is enforced by the import graph itself,
//     the same structural guarantee tdx/hsinchuCctvProbe.js's frame
//     endpoint already uses for its own "0 TDX calls" claim.
//
// R2 object shape: key `cctv/published-image/<opaque-id>.jpg`, body =
// raw JPEG bytes, customMetadata { createdAt, expiresAt } (both ISO
// strings — R2 customMetadata values must be strings). NEVER a TDX
// token, LINE token, ADMIN_PASSWORD, or VideoStreamURL, which must never
// appear in this module in any form. R2 has no built-in per-object TTL,
// so expiry is enforced ENTIRELY in code on every read (see
// readPublishedImage below) — an object that outlives its expiresAt is
// still treated as gone (404) even before any cleanup/lifecycle job
// actually deletes it; a best-effort delete is attempted opportunistically
// at read time, but cleanup timing must never be what decides whether a
// URL is valid.
//
// Binding: env.CCTV_IMAGES (Cloudflare R2 bucket binding — see
// wrangler.jsonc; bucket name suggested: traffic-reporter-cctv-images).
// No Secret of any kind is required for an R2 Worker binding.

const KEY_PREFIX = 'cctv/published-image/';
const KEY_SUFFIX = '.jpg';
export const PUBLISHED_IMAGE_TTL_SECONDS = 900; // 15 minutes
const ID_BYTE_LENGTH = 16; // 128 bits of entropy
const ID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Cryptographically random opaque id: crypto.getRandomValues, 128 bits,
 * hex-encoded. Deliberately NEVER derived from a timestamp, incident KM,
 * CCTV id, or an incrementing counter — this unauthenticated endpoint's
 * only security boundary is entropy + a server-enforced expiry check, so
 * the id itself must carry zero guessable structure.
 */
function generateOpaqueId() {
  const bytes = new Uint8Array(ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isValidId(id) {
  return typeof id === 'string' && ID_HEX_PATTERN.test(id);
}

function objectKeyForId(id) {
  return `${KEY_PREFIX}${id}${KEY_SUFFIX}`;
}

/**
 * Publishes an already-composed collage JPEG to R2 under a fresh opaque
 * id. Never called from the public read path — only from an
 * Admin-Auth-gated caller (tdx/hsinchuCctvProbe.js's
 * handleHsinchuCctvPublishTest).
 *
 * @param {{put: Function}} bucket - env.CCTV_IMAGES
 * @param {ArrayBuffer|Uint8Array} jpegBytes
 * @param {Date} [now]
 * @returns {Promise<{ok:true, id:string, sizeBytes:number, expiresIn:number,
 *   expiresAt:string}|{ok:false}>} `expiresAt` is the EXACT ISO string
 *   written into the object's customMetadata (never a recomputed
 *   approximation), so a caller can hand it onward — e.g. the V57 Shared
 *   Traffic Feed's imageExpiresAt — without ever being optimistic about
 *   when this URL actually stops resolving.
 */
export async function publishCollageImage(bucket, jpegBytes, now = new Date()) {
  const id = generateOpaqueId();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PUBLISHED_IMAGE_TTL_SECONDS * 1000).toISOString();

  try {
    await bucket.put(objectKeyForId(id), jpegBytes, {
      httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { createdAt, expiresAt },
    });
  } catch {
    return { ok: false };
  }

  return { ok: true, id, sizeBytes: jpegBytes.byteLength, expiresIn: PUBLISHED_IMAGE_TTL_SECONDS, expiresAt };
}

/**
 * Read-only. Returns null on ANY miss — invalid id shape, never
 * published, expired, or an R2 error — never throws, and never lets the
 * caller distinguish those cases from each other (handlePublicCctvImage
 * below always responds with a flat 404 either way).
 *
 * Expiry is enforced HERE, on every call, from the object's own
 * customMetadata.expiresAt — never from R2 lifecycle rules alone and
 * never from an HTTP cache header (see this module's correction note).
 * An expired object triggers a best-effort delete (a future cleanup job
 * may also sweep these, but the 404 above never waits on that) — a
 * failed delete is swallowed; a client must never see a 500 just because
 * cleanup didn't succeed, and the very next request will simply try the
 * delete again (or find the object already gone).
 */
async function readPublishedImage(bucket, id) {
  if (!isValidId(id)) return null;

  const key = objectKeyForId(id);
  let object;
  try {
    object = await bucket.get(key);
  } catch {
    return null; // fail closed — never fall back to KV/CCTV/TDX/regenerate
  }
  if (!object) return null;

  const expiresAt = object.customMetadata && object.customMetadata.expiresAt;
  if (!expiresAt || Date.parse(expiresAt) <= Date.now()) {
    try {
      await bucket.delete(key);
    } catch {
      // best-effort only — the expiry check above already treats this
      // object as gone regardless of whether the delete itself succeeds.
    }
    return null;
  }

  try {
    return await object.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * GET /cctv/image/:id — see module comment. Deliberately NOT
 * Admin-Auth-gated. Does only: (1) validate the id's shape, (2) one R2
 * read (plus, on an expired hit, a best-effort delete), (3) 404 or 200
 * image/jpeg. No directory listing, no index, no metadata echo, no
 * id-guessing surface beyond what the id's own entropy already bounds.
 * `Cache-Control: no-store` is deliberate (see the correction note
 * above) — this URL's validity is enforced server-side on every request,
 * never by letting an intermediate cache decide.
 */
export async function handlePublicCctvImage(env, id) {
  if (env.CCTV_IMAGES === undefined) {
    return new Response('Not Found', { status: 404 });
  }

  const bytes = await readPublishedImage(env.CCTV_IMAGES, id);
  if (!bytes) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
