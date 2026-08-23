// TDX OAuth2 (client_credentials) token acquisition.
//
// V1.2C.1: a real production 429 ("TDX token request failed with HTTP
// 429") was traced to Cloudflare isolate churn — the old module-memory-
// only cache meant every cold start / isolate swap / debug request could
// re-authenticate against TDX from scratch. Lookup order is now:
//
//   A. this isolate's own module memory (fastest, no I/O)
//   B. TRAFFIC_KV — a token acquired by ANY isolate, shared across all of
//      them, survives cold starts
//   C. only then, a real TDX OAuth request
//
// KV here is purely an optimization to cut OAuth request volume — NOT a
// fail-closed dependency the way traffic:dedupe-state/line:notified-state
// are for the broadcast pipeline. A KV read/write failure degrades this
// straight back to "isolate-local memory cache + OAuth on miss" (the
// pre-V1.2C.1 behavior), never blocks token acquisition, and never
// invalidates a token this call just legitimately obtained.
//
// Reads TDX_CLIENT_ID / TDX_CLIENT_SECRET from the Worker's runtime
// environment (Cloudflare Secrets, configured outside this repo). Neither
// those values nor the resulting accessToken are ever logged, thrown,
// returned in any response, or partially displayed (no "first/last N
// chars") — anywhere in this module.
//
// V1.8.6: getAccessToken() optionally accepts a `usageSink` (see
// ../tdx/usageLedger.js) purely to record a REAL OAuth network request —
// recorded ONLY in the tier-C branch below (acquireToken's
// requestNewToken() call), never for a tier-A memory hit or tier-B KV
// hit. This is a separate counter from TDX DATA calls on purpose (see
// usageLedger.js's module comment) — a token refresh is not itself a
// RoadEvent/CCTV data request. Omitting usageSink (every pre-V1.8.6
// caller/test) is a no-op, unchanged behavior.

import { recordTdxOAuthCall } from './usageLedger.js';
import { isTdxRuntimeEnabled } from '../traffic/sourceMode.js';

const TDX_AUTH_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

// Refresh this many ms before actual expiry to avoid edge-of-expiry races.
// Bumped from 30s to 60s this round (still just one named constant, used
// for both the memory and the KV cache freshness check below).
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

// Deliberately versioned ("-v1") so a future schema change can roll out
// without needing to parse/migrate old entries — an unrecognized/stale-
// shaped blob is simply treated as a cache miss (see readKvTokenCache).
const KV_TOKEN_KEY = 'tdx:oauth-token-v1';

export class TdxAuthError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'TdxAuthError';
    this.status = status;
  }
}

let tokenCache = null; // { accessToken, expiresAt } — this isolate's own memory
// Stampede guard: while a refresh is in flight, every other concurrent
// getAccessToken() caller in this isolate awaits this SAME promise
// instead of issuing its own OAuth request. Always cleared via .finally()
// so a rejected refresh doesn't wedge future calls.
let tokenRefreshPromise = null;

// Diagnostic only (see GET /debug/status's `tdxTokenCache` field) — which
// tier most recently served a successful getAccessToken() call. Never the
// token itself, never partially displayed.
let lastTokenSource = null; // 'memory' | 'kv' | 'oauth' | null

/** Test-only: clear the in-memory token cache, in-flight refresh, and diagnostic state between test cases. */
export function resetTdxTokenCache() {
  tokenCache = null;
  tokenRefreshPromise = null;
  lastTokenSource = null;
}

/** Diagnostic only — see module comment. Never exposes the token. */
export function getLastTdxTokenSource() {
  return lastTokenSource;
}

function isFresh(entry, now) {
  return Boolean(entry) && Number.isFinite(entry.expiresAt) && entry.expiresAt > now + EXPIRY_SAFETY_MARGIN_MS;
}

async function readKvTokenCache(kv) {
  if (!kv) return null;
  try {
    const raw = await kv.get(KV_TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken || typeof parsed.expiresAt !== 'number') {
      return null; // unrecognized shape -> treat as a miss, never throw
    }
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
  } catch {
    // A KV read failure (or corrupt JSON) degrades to "no cached token" —
    // never lets a KV problem stop OAuth from being attempted. See module
    // comment: this cache is an optimization, not a fail-closed gate.
    return null;
  }
}

async function writeKvTokenCache(kv, entry) {
  if (!kv) return;
  try {
    await kv.put(KV_TOKEN_KEY, JSON.stringify(entry));
  } catch {
    // A write failure must never invalidate the token this call just
    // legitimately obtained — the caller's memory cache is already set
    // before this runs, and keeps working regardless of this outcome.
  }
}

async function requestNewToken(env) {
  const clientId = env.TDX_CLIENT_ID;
  const clientSecret = env.TDX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new TdxAuthError('Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET in the Worker environment');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  let response;
  try {
    response = await fetch(TDX_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new TdxAuthError(`Network error while requesting TDX token: ${err.message}`);
  }

  if (!response.ok) {
    // Deliberately status-code only: the response body from the auth
    // server is not included in case it ever echoes request parameters
    // (and definitely never client_id/client_secret, which this function
    // never puts anywhere near an Error message to begin with).
    throw new TdxAuthError(`TDX token request failed with HTTP ${response.status}`, { status: response.status });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new TdxAuthError(`Failed to parse TDX token response: ${err.message}`);
  }

  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new TdxAuthError('TDX token response did not include access_token');
  }

  // expiresAt is always derived from TDX's own expires_in — never a
  // hardcoded assumed lifetime — falling back to a conservative 1 hour
  // only if TDX's response is missing/invalid on that one field.
  const expiresIn = Number(data.expires_in);
  const expiresAt = Date.now() + (expiresIn > 0 ? expiresIn * 1000 : 3_600_000);
  return { accessToken: data.access_token, expiresAt };
}

async function acquireToken(env, usageSink) {
  const now = Date.now();

  // A. this isolate's own memory.
  if (isFresh(tokenCache, now)) {
    lastTokenSource = 'memory';
    return tokenCache.accessToken;
  }

  // B. shared TRAFFIC_KV cache (another isolate may have already
  // refreshed it) — never reached if TRAFFIC_KV is unavailable/throws,
  // see readKvTokenCache.
  const kvEntry = await readKvTokenCache(env.TRAFFIC_KV);
  if (isFresh(kvEntry, now)) {
    tokenCache = kvEntry; // backfill this isolate's memory too
    lastTokenSource = 'kv';
    return kvEntry.accessToken;
  }

  // C. neither tier has a valid token -> the real OAuth request. At most
  // one of these per getAccessToken() call, and getAccessToken's own
  // stampede guard (tokenRefreshPromise) keeps concurrent callers in this
  // isolate from each starting their own. V1.8.6: this is the ONLY branch
  // that ever records an OAuth usage entry — a real network request was
  // just about to be attempted, success or failure.
  let fresh;
  try {
    fresh = await requestNewToken(env);
  } catch (err) {
    recordTdxOAuthCall(usageSink, { success: false, httpStatus: err && typeof err.status === 'number' ? err.status : null });
    throw err;
  }
  recordTdxOAuthCall(usageSink, { success: true, httpStatus: 200 });
  tokenCache = fresh;
  lastTokenSource = 'oauth';
  await writeKvTokenCache(env.TRAFFIC_KV, fresh); // best-effort; see writeKvTokenCache
  return fresh.accessToken;
}

export async function getAccessToken(env, usageSink) {
  // TDX QUOTA PROTECTION (2026-08-23) — the mechanical backstop.
  //
  // Every TDX API call in this Worker needs a token, so refusing here
  // makes "zero TDX calls in PBS-only mode" a property of the code rather
  // than a property of every caller remembering to check a flag. A future
  // code path that forgets the gate fails closed instead of quietly
  // spending quota that no longer exists.
  //
  // Deliberately a TdxAuthError: callers already treat that as
  // "no token this run" (pipeline.js sets tokenOk=false and carries on),
  // so this degrades along an existing, tested path rather than throwing
  // something nobody handles. It must never reach PBS — PBS never asks
  // for a TDX token.
  if (!isTdxRuntimeEnabled(env)) {
    throw new TdxAuthError(
      'TDX runtime disabled (TRAFFIC_SOURCE_MODE=PBS_ONLY, quota protection) — no token requested. See src/traffic/sourceMode.js to restore.'
    );
  }

  // Fast path: fresh memory, no promise machinery, no await at all.
  const now = Date.now();
  if (isFresh(tokenCache, now)) {
    lastTokenSource = 'memory';
    return tokenCache.accessToken;
  }

  // Stampede guard — see module comment.
  if (tokenRefreshPromise) return tokenRefreshPromise;

  tokenRefreshPromise = acquireToken(env, usageSink).finally(() => {
    tokenRefreshPromise = null;
  });

  return tokenRefreshPromise;
}
