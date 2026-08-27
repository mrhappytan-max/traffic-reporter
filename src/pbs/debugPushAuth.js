// V1.9.5 — auth helper for POST /internal/pbs-debug-push (see
// debugPush.js's module comment for the full picture). Kept in its own
// tiny file so debugPush.js's own body stays about the endpoint's
// behavior, not crypto plumbing — same separation this project already
// uses (line/verifySignature.js is its own file for the same reason).
//
// `Authorization: Bearer <PBS_DEBUG_PUSH_SECRET>` — the SAME header shape
// traffic/sharedFeedHandler.js already uses for TRAFFIC_FEED_SECRET
// (an existing, established convention for a machine-to-machine bearer
// credential in this repo), reused here for consistency rather than
// inventing a third header convention alongside Admin Basic Auth and
// LINE's X-Line-Signature.
//
// Unlike sharedFeedHandler.js's plain `!==` comparison, this hashes both
// sides before comparing (SHA-256, then a constant-time byte compare) —
// the same technique security/adminAuth.js already uses for
// ADMIN_PASSWORD. Duplicated locally rather than imported from
// adminAuth.js: that module's exports are Basic-Auth-specific
// (parseBasicAuthHeader, the fixed ADMIN_USERNAME) and this is a
// different credential shape (a single bearer token, no username) — same
// "each auth module stays independently readable" precedent as
// line/verifySignature.js's own local timingSafeEqual.

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bufferToHex(digest);
}

/** Constant-time byte comparison over two SHA-256 hex digests (always the
 * same fixed length regardless of the original secret's length). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * @param {string|null} authorizationHeader - the raw `Authorization` header value
 * @param {string} expectedSecret - env.PBS_DEBUG_PUSH_SECRET (already
 *   confirmed present by the caller — this function does not itself
 *   decide "not configured")
 * @returns {Promise<boolean>} true only if the header is exactly
 *   `Bearer <expectedSecret>` per a constant-time hashed comparison.
 *   Never throws. Never logs the header or the secret.
 */
export async function verifyDebugPushToken(authorizationHeader, expectedSecret) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) return false;
  const candidate = authorizationHeader.slice('Bearer '.length);
  if (!candidate) return false;

  const [candidateHash, expectedHash] = await Promise.all([sha256Hex(candidate), sha256Hex(expectedSecret)]);
  return timingSafeEqual(candidateHash, expectedHash);
}
