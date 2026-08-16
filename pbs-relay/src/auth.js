// Bearer-token check for GET /pbs. GET /health is intentionally not
// gated by this at all (see server.js). Fails closed: no RELAY_TOKEN
// configured, no/garbled Authorization header, or a mismatched token all
// resolve to "not authorized" — never a silent bypass.

import { timingSafeEqual } from 'node:crypto';

export function isAuthorizedPathToken(encodedToken, relayToken) {
  if (!relayToken) return false; // RELAY_TOKEN not configured on this deploy
  if (typeof encodedToken !== 'string' || encodedToken.length === 0) return false;
  let token;
  try {
    token = decodeURIComponent(encodedToken);
  } catch {
    return false;
  }
  return safeCompare(token, relayToken);
}

// Constant-time comparison so a mismatched-length or mismatched-content
// guess can't be distinguished by timing.
function safeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
