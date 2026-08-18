// V1.8.4 — LINE-safe CCTV image publishing layer. Turns an already-
// composed collage JPEG (see cctv/collage.js) into a short-lived,
// opaque, unauthenticated public HTTPS URL that a future LINE Messaging
// API image message (originalContentUrl/previewImageUrl) could reference
// directly. This is required because LINE's servers cannot attach our
// Admin Basic Auth header — /admin/cctv-hsinchu-collage's URL can never
// be handed to LINE directly, and the ADMIN_PASSWORD must never be
// embedded in a URL (query string or otherwise) as a workaround.
//
// This round does NOT wire up real LINE push — see
// tdx/hsinchuCctvProbe.js's handleHsinchuCctvPublishTest, an
// Admin-Auth-gated manual test endpoint only.
//
// Two structurally separate concerns:
//   - publishCollageImage(kv, jpegBytes) — the WRITE path. Called only
//     from an Admin-Auth-gated handler (never from this public GET
//     route below). Fail-closed: a KV write failure returns
//     {ok:false} and the caller MUST NOT synthesize/return a URL for it
//     — "不發布 URL" / "不要建立假 image entry".
//   - handlePublicCctvImage(env, id) — the READ path, GET
//     /cctv/image/:id. Deliberately NOT in index.js's ADMIN_PATHS/Admin
//     Basic Auth gate — LINE's servers need to fetch this with no
//     credential at all. Security comes from (a) a cryptographically
//     random 128-bit opaque id nothing can feasibly guess/enumerate, and
//     (b) a short KV TTL — never from URL obscurity, never from auth.
//     This module imports NOTHING TDX/CCTV-fetch/LINE-related — "0 TDX
//     calls, 0 CCTV fetch, 0 LINE calls" for this endpoint is enforced
//     by the import graph itself, the same structural guarantee
//     tdx/hsinchuCctvProbe.js's frame endpoint already uses for its own
//     "0 TDX calls" claim.
//
// KV shape: key `cctv:published-image:<opaque-id>`, value = raw JPEG
// bytes, TTL PUBLISHED_IMAGE_TTL_SECONDS (15 minutes — LINE's servers
// are expected to fetch the URL well within this window; if a future
// round finds that's too tight, widen the constant, but this must never
// become a permanent/non-expiring store). KV's own `metadata` slot holds
// only display/debug-adjacent fields (contentType, createdAt, expiresAt)
// — NEVER a TDX token, LINE token, ADMIN_PASSWORD, or VideoStreamURL,
// which must never appear in this module in any form.

const KEY_PREFIX = 'cctv:published-image:';
export const PUBLISHED_IMAGE_TTL_SECONDS = 900; // 15 minutes
const ID_BYTE_LENGTH = 16; // 128 bits of entropy
const ID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Cryptographically random opaque id: crypto.getRandomValues, 128 bits,
 * hex-encoded. Deliberately NEVER derived from a timestamp, incident KM,
 * CCTV id, or an incrementing counter — per instruction, this
 * unauthenticated endpoint's only security boundary is entropy + short
 * TTL, so the id itself must carry zero guessable structure.
 */
function generateOpaqueId() {
  const bytes = new Uint8Array(ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isValidId(id) {
  return typeof id === 'string' && ID_HEX_PATTERN.test(id);
}

/**
 * Publishes an already-composed collage JPEG to KV under a fresh opaque
 * id. Never called from the public read path — only from an
 * Admin-Auth-gated caller (tdx/hsinchuCctvProbe.js's
 * handleHsinchuCctvPublishTest).
 *
 * @param {{put: Function}} kv - env.TRAFFIC_KV
 * @param {ArrayBuffer|Uint8Array} jpegBytes
 * @param {Date} [now]
 * @returns {Promise<{ok:true, id:string, sizeBytes:number, expiresIn:number}|{ok:false}>}
 */
export async function publishCollageImage(kv, jpegBytes, now = new Date()) {
  const id = generateOpaqueId();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PUBLISHED_IMAGE_TTL_SECONDS * 1000).toISOString();

  try {
    await kv.put(KEY_PREFIX + id, jpegBytes, {
      expirationTtl: PUBLISHED_IMAGE_TTL_SECONDS,
      metadata: { contentType: 'image/jpeg', createdAt, expiresAt },
    });
  } catch {
    return { ok: false };
  }

  return { ok: true, id, sizeBytes: jpegBytes.byteLength, expiresIn: PUBLISHED_IMAGE_TTL_SECONDS };
}

/**
 * Read-only. Returns null on ANY miss — invalid id shape, never
 * published, expired (KV's own TTL already expires the key
 * server-side), or a KV error — never throws, and never lets the caller
 * distinguish those cases from each other (handlePublicCctvImage below
 * always responds with a flat 404 either way, so this function's return
 * shape can't leak that distinction even if a caller tried to inspect
 * it).
 */
async function readPublishedImage(kv, id) {
  if (!isValidId(id)) return null;
  try {
    const value = await kv.get(KEY_PREFIX + id, 'arrayBuffer');
    if (!value) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * GET /cctv/image/:id — see module comment. Deliberately NOT
 * Admin-Auth-gated. Does only: (1) validate the id's shape, (2) one KV
 * binary read, (3) 404 or 200 image/jpeg. No directory listing, no
 * index, no metadata echo, no id-guessing surface beyond what the id's
 * own entropy + TTL already bound.
 */
export async function handlePublicCctvImage(env, id) {
  if (env.TRAFFIC_KV === undefined) {
    return new Response('Not Found', { status: 404 });
  }

  const bytes = await readPublishedImage(env.TRAFFIC_KV, id);
  if (!bytes) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      // Short, safe to cache: the id is immutable content once
      // published (a given id is always the exact same bytes, or gone),
      // and the cache lifetime is capped well under the KV TTL so a
      // client can never serve a stale hit past the underlying key's
      // own expiry.
      'Cache-Control': `public, max-age=${PUBLISHED_IMAGE_TTL_SECONDS}, immutable`,
    },
  });
}
