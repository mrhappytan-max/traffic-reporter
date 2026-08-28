// V1.9.5 — POST /internal/pbs-debug-push
//
// Windows PBS Local Monitor → Cloudflare, DEBUG-ONLY receiving end. This
// endpoint proves exactly one thing, end to end: Windows can send a
// minimal event payload, Cloudflare can authenticate it, validate its
// shape, make a durable idempotency judgment, log it, and ACK — nothing
// more.
//
// HARD BOUNDARY (the whole point of this module, UNCHANGED by V1.9.7):
// this file imports NOTHING from line/, cctv/, traffic/sharedFeed
// (Handler)?.js, traffic/incidentSuppression.js, traffic/notified.js,
// traffic/broadcastProvenance.js, traffic/pipelineTrace.js, or pbs/
// lifecycle.js|pipeline.js — there is no import path to LINE, CCTV,
// Shared Feed, Incident Suppression, notified-state, Broadcast
// Provenance, or Pipeline Trace, even by accident, and no R2/fetch call
// anywhere in this file. This is the module-level guarantee the order's
// "Debug-only 邊界" section asks for, enforced structurally rather than
// by a runtime flag that could be forgotten or flipped.
//
// V1.9.7 — this module NOW touches `env.TRAFFIC_KV`, but ONLY under its
// own dedicated debug-only prefix (IDEMPOTENCY_KV_PREFIX below,
// `debug:pbs-push-idempotency:v1:*`) — never a business key
// (`traffic:shared-feed`, `line:notified-state`,
// `line:incident-suppression-state`, `debug:pipeline-trace*`,
// `pbs:lifecycle-state`, etc). See the IDEMPOTENCY section below for why,
// and test/pbsDebugPush.test.js's "KV prefix isolation" tests for the
// direct proof.
//
// AUTH: same convention as traffic/sharedFeedHandler.js's own
// TRAFFIC_FEED_SECRET — `Authorization: Bearer <secret>`, its OWN
// dedicated Cloudflare Secret (PBS_DEBUG_PUSH_SECRET), never reused from
// PBS_RELAY_TOKEN (the existing, unrelated Cloudflare→Windows PULL
// credential), any LINE/TDX secret, or ADMIN_PASSWORD. Missing secret
// configuration fails closed with 503 (an operator/deploy problem, same
// distinction sharedFeedHandler.js already makes) — never silently
// public. A present-but-wrong-or-absent token is 401, evaluated through a
// hashed constant-time comparison (same technique as
// security/adminAuth.js's credentialMatches — hash both sides first so
// neither the raw secret's length nor content is observable via timing).
// Auth and payload validation both happen BEFORE any idempotency
// check/KV access — an unauthenticated or malformed request touches KV
// zero times.
//
// IDEMPOTENCY (V1.9.7 — PERSISTENT, replacing V1.9.5's per-isolate-only
// design): V1.9.5 kept a small in-memory (per-isolate) Map as the ONLY
// duplicate signal, honestly reported as NOT_PERSISTENT — a real risk
// once Cloudflare recycles/evicts an isolate, restarts, or redeploys: the
// same event could be re-accepted. V1.9.7 adds a durable L2 layer in
// TRAFFIC_KV under IDEMPOTENCY_KV_PREFIX, keyed by a STABLE, deterministic
// hash of `source:eventId:lifecycle:fingerprint` (never requestId, which
// can differ across retries) — see computeIdempotencyKeyHash. The
// in-memory Map is kept as an L1 fast-path (skips a KV read entirely for
// a genuine same-isolate repeat) but is NEVER the sole source of truth:
// an L1 miss always falls through to an L2 KV read before a request is
// ever accepted, so a fresh isolate with an empty L1 map still correctly
// sees an L2 hit written by a different isolate.
//
// KV_ONLY_ATOMICITY = NOT_SUFFICIENT for a true atomic exactly-once
// guarantee — Cloudflare KV's get-then-put has no compare-and-swap, so
// two isolates receiving the IDENTICAL payload at the truly same instant
// could both KV-get a miss and both KV-put "accepted". This is
// deliberately NOT solved with a Durable Object this round (the order's
// own "不要過度設計" instruction) because the actual identified risk this
// round exists to close — isolate eviction / restart / redeploy causing
// re-acceptance of the SAME transition sent again later, not
// simultaneously — is fully closed by the durable KV layer regardless of
// this narrow race. The residual race window requires two literally
// concurrent requests for the identical idempotency key, which this
// endpoint's real traffic pattern (one Windows client, one event per
// PBS transition, never bursty) makes vanishingly unlikely; even if hit,
// the blast radius is a duplicate debug log line and a harmless
// redundant KV put of identical content — this endpoint has ZERO
// business side effects (LINE=0, CCTV=0, Shared Feed=0), so a race here
// can never double-push anything real. A Durable Object (or other atomic
// coordination) would be the correct fix if this endpoint is ever wired
// to a genuine business side effect — not before.
//
// See PBS_DEBUG_PUSH_IDEMPOTENCY_MODE / PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY
// for the exported, honestly-reported status of this design.

import { verifyDebugPushToken } from './debugPushAuth.js';

export const PBS_DEBUG_PUSH_PATH = '/internal/pbs-debug-push';

// Generous for a single, real, minimal PBS event (a handful of short
// strings plus two numbers) — this is a safety ceiling against a
// malformed/malicious body, never a real expected size. The order is
// explicit that Windows must send "only the events that actually
// changed", never the whole ~1000-record raw PBS feed; 16 KiB is far
// larger than one event needs and far smaller than a raw-feed dump would
// require, so it cannot accidentally accept the thing this endpoint
// exists to NOT accept.
const MAX_BODY_BYTES = 16 * 1024;

const REQUIRED_STRING_FIELDS = ['generatedAt', 'source', 'eventId', 'lifecycle', 'fingerprint', 'requestId'];
const VALID_LIFECYCLES = new Set(['NEW', 'UPDATED', 'CLEARED']);

// Whitelist-only, same discipline as pipelineTrace.js's
// buildUpstreamSnapshot — only these fields are ever read out of the
// caller-supplied `event` object (for the Workers Logs line); nothing
// else in `event`, however large, is ever logged or stored.
const EVENT_LOG_FIELDS = ['road', 'areaNm', 'direction', 'comment', 'longitude', 'latitude', 'sourceDetail'];

// L1 fast-path only — see module comment. Bounded so a burst of distinct
// keys cannot grow this without limit within one isolate's lifetime.
// Deliberately much shorter than IDEMPOTENCY_TTL_SECONDS below: this
// layer only exists to skip a KV read for a genuine same-isolate repeat
// shortly after the first request, never to substitute for the durable
// L2 layer.
const IDEMPOTENCY_MEMORY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRACKED_KEYS = 500;

// V1.9.7 — durable L2 layer. Debug-only prefix, structurally distinct
// from every business KV prefix in this project (traffic:shared-feed,
// line:notified-state, line:incident-suppression-state,
// debug:pipeline-trace*, pbs:lifecycle-state) — see this module's own
// "KV prefix isolation" tests.
export const IDEMPOTENCY_KV_PREFIX = 'debug:pbs-push-idempotency:v1';

// 48 hours. A real PBS event's own active lifetime is typically hours,
// occasionally a bit over a day (see 07_KNOWN_ISSUES.md's PBS lifecycle
// records); any plausible isolate-recycle/restart/redeploy gap this round
// exists to survive is far shorter than that. 48h gives generous headroom
// for the record to still be found across such a gap for the event's
// entire realistic lifetime, while still bounding KV storage growth
// rather than keeping every debug idempotency record forever. See
// test/pbsDebugPush.test.js's KV-cost-quantification test and this
// round's own final report for the measured writes/day this produces —
// well under the 1,000 writes/day account budget even at generous event
// volume, since (per this constant's own design) a duplicate never adds
// a write.
export const IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;

// Exported so the log line and the final report both cite the SAME
// string — see module comment for the full nuance behind "PARTIAL":
// this closes the real identified risk (isolate/restart/redeploy
// re-acceptance) but is not an atomic exactly-once guarantee under truly
// concurrent identical requests (KV has no compare-and-swap).
export const PBS_DEBUG_PUSH_IDEMPOTENCY_MODE = 'PERSISTENT_KV_PARTIAL';
export const PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = 'PARTIAL';
export const KV_ONLY_ATOMICITY = 'NOT_SUFFICIENT';

let recentIdempotencyKeys = new Map(); // idempotencyKeyHash -> lastSeenAtEpochMs

/** Test-only reset — mirrors this repo's existing resetTdxTokenCache()
 * convention for module-level state that must not leak between tests.
 * Resets ONLY the L1 in-memory layer — a test wanting to simulate "a
 * fresh isolate, but the persistent KV record survives" calls this while
 * reusing the SAME kv mock object across calls (exactly what a real
 * isolate recycle looks like: memory gone, KV namespace unchanged). */
export function resetPbsDebugPushIdempotencyState() {
  recentIdempotencyKeys = new Map();
}

function pruneExpiredMemory(nowMs) {
  for (const [key, seenAt] of recentIdempotencyKeys) {
    if (nowMs - seenAt > IDEMPOTENCY_MEMORY_WINDOW_MS) recentIdempotencyKeys.delete(key);
  }
  // Defensive cap even if clock skew or a pathological burst defeats the
  // age-based prune above — evict oldest first (Map preserves insertion
  // order).
  while (recentIdempotencyKeys.size > MAX_TRACKED_KEYS) {
    const oldestKey = recentIdempotencyKeys.keys().next().value;
    recentIdempotencyKeys.delete(oldestKey);
  }
}

/** Returns true (and refreshes its timestamp) if `key` was already seen
 * within the L1 window; returns false and records it as newly-seen
 * otherwise. Never the sole source of truth — see module comment; a
 * `false` return here still requires an L2 KV check before accepting. */
function checkAndRecordMemory(key, nowMs) {
  pruneExpiredMemory(nowMs);
  const seenAt = recentIdempotencyKeys.get(key);
  const isDuplicate = seenAt !== undefined && nowMs - seenAt <= IDEMPOTENCY_MEMORY_WINDOW_MS;
  recentIdempotencyKeys.set(key, nowMs); // refresh position/timestamp either way
  return isDuplicate;
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same technique as debugPushAuth.js's own sha256Hex — duplicated
 * locally per this project's established "each module stays
 * independently readable" convention (see debugPushAuth.js's own module
 * comment for the precedent). */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bufferToHex(digest);
}

/**
 * The STABLE idempotency key input, per the order's section 二: built
 * from source/eventId/lifecycle/fingerprint — deliberately NEVER
 * requestId (which legitimately differs across a client's own retries of
 * the SAME logical event, per debugPushClient.js's own deterministic-
 * but-still-per-attempt requestId design) — so a retry, a Windows
 * restart, or a request landing on a different Cloudflare isolate/
 * deployment for the exact same real-world transition always produces
 * the IDENTICAL key. Hashed (not stored/logged raw) so the KV key itself
 * never carries the raw fingerprint text, and so the key length is fixed
 * regardless of how long an upstream fingerprint string gets.
 */
async function computeIdempotencyKeyHash({ source, eventId, lifecycle, fingerprint }) {
  return sha256Hex(`${source}:${eventId}:${lifecycle}:${fingerprint}`);
}

function buildIdempotencyKvKey(idempotencyKeyHash) {
  return `${IDEMPOTENCY_KV_PREFIX}:${idempotencyKeyHash}`;
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

/** Never throws — a malformed/empty string is just "not a valid time",
 * not a crash. */
function isParsableTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pure — validates the parsed body shape per the order's section 四.
 * Returns {ok:true} or {ok:false, reason}. Never touches KV/network.
 */
function validatePayloadShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body_not_object' };
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(body[field])) {
      return { ok: false, reason: `missing_or_empty_${field}` };
    }
  }
  if (body.source !== 'pbs') {
    return { ok: false, reason: 'invalid_source' };
  }
  if (!VALID_LIFECYCLES.has(body.lifecycle)) {
    return { ok: false, reason: 'invalid_lifecycle' };
  }
  if (!isParsableTimestamp(body.generatedAt)) {
    return { ok: false, reason: 'invalid_generatedAt' };
  }
  if (body.event !== undefined && (typeof body.event !== 'object' || body.event === null || Array.isArray(body.event))) {
    return { ok: false, reason: 'invalid_event_shape' };
  }
  return { ok: true };
}

/** Whitelist-only extraction for the log line — see EVENT_LOG_FIELDS. */
function extractLoggableEventFields(event) {
  if (!event || typeof event !== 'object') return {};
  const out = {};
  for (const field of EVENT_LOG_FIELDS) {
    if (event[field] !== undefined && event[field] !== null) out[field] = event[field];
  }
  return out;
}

function shortFingerprint(fingerprint) {
  return typeof fingerprint === 'string' ? fingerprint.slice(0, 16) : '';
}

/**
 * GET /internal/pbs-debug-push (any non-POST method): 405, checked BEFORE
 * auth — which HTTP methods a route accepts is not sensitive information
 * (unlike whether an admin page's CONTENT exists), so this can be a plain
 * routing-level answer, same as this project's public routes.
 */
export async function handlePbsDebugPush(request, env, now = new Date()) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  const secret = env.PBS_DEBUG_PUSH_SECRET;
  if (!secret) {
    // Not configured is an operator/deploy problem, not a caller
    // problem — same distinction traffic/sharedFeedHandler.js already
    // makes for TRAFFIC_FEED_SECRET. Fails CLOSED: a missing Secret must
    // never make this endpoint silently open.
    console.log('[pbs-debug-push] auth=fail reason=not_configured');
    return jsonResponse({ error: 'pbs_debug_push_not_configured' }, 503);
  }

  const authorized = await verifyDebugPushToken(request.headers.get('Authorization'), secret);
  if (!authorized) {
    console.log('[pbs-debug-push] auth=fail reason=unauthorized');
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    console.log('[pbs-debug-push] auth=pass validation=fail reason=payload_too_large');
    return jsonResponse({ error: 'payload_too_large' }, 400);
  }

  let rawText;
  try {
    rawText = await request.text();
  } catch {
    console.log('[pbs-debug-push] auth=pass validation=fail reason=body_read_error');
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  // Re-check on the ACTUAL bytes read — a caller can omit or lie about
  // Content-Length, so the header check above is a cheap early exit, not
  // the real guard.
  if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) {
    console.log('[pbs-debug-push] auth=pass validation=fail reason=payload_too_large');
    return jsonResponse({ error: 'payload_too_large' }, 400);
  }

  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    console.log('[pbs-debug-push] auth=pass validation=fail reason=invalid_json');
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const validation = validatePayloadShape(body);
  if (!validation.ok) {
    console.log(`[pbs-debug-push] auth=pass validation=fail reason=${validation.reason}`);
    return jsonResponse({ error: validation.reason }, 400);
  }

  const { source, generatedAt, eventId, lifecycle, fingerprint, requestId, event } = body;
  const receivedAt = now.toISOString();
  const loggableEvent = extractLoggableEventFields(event);
  const nowMs = now.getTime();

  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source, eventId, lifecycle, fingerprint });
  const idempotencyKeyHashShort = idempotencyKeyHash.slice(0, 12);

  // Step 3/4/5/6 of the order's own section 三 — L1 first (fast path,
  // never the sole source of truth), then L2 KV (the durable, authoritative
  // layer) only when L1 didn't already answer. See module comment for why
  // duplicates never cost a KV write, and why a KV outage fails OPEN
  // (accept) rather than closed — this is a debug-only observability
  // feature, never a gate on a business side effect, so losing a duplicate-
  // suppression edge case to a KV outage is the correct trade-off; losing
  // a legitimate debug event to one would not be.
  let duplicate = false;
  let memoryHit = false;
  let persistentHit = false;
  let kvOutage = false;

  if (checkAndRecordMemory(idempotencyKeyHash, nowMs)) {
    duplicate = true;
    memoryHit = true;
  } else {
    const kv = env.TRAFFIC_KV;
    if (kv) {
      const kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
      let existingRaw = null;
      try {
        existingRaw = await kv.get(kvKey);
      } catch {
        kvOutage = true; // fail OPEN — see module comment
      }
      if (existingRaw !== null) {
        duplicate = true;
        persistentHit = true;
      } else {
        try {
          await kv.put(
            kvKey,
            JSON.stringify({ firstAcceptedAt: now.toISOString(), requestId }),
            { expirationTtl: IDEMPOTENCY_TTL_SECONDS }
          );
        } catch {
          kvOutage = true; // event still accepted below — see module comment
        }
      }
    }
    // No `env.TRAFFIC_KV` binding at all (should never happen in
    // Production, but must never crash) degrades to memory-only L1,
    // identical to V1.9.5's own behavior before this round.
  }

  const logFields = [
    `requestId=${requestId}`,
    `eventId=${eventId}`,
    `lifecycle=${lifecycle}`,
    `fingerprint=${shortFingerprint(fingerprint)}`,
    `generatedAt=${generatedAt}`,
    `receivedAt=${receivedAt}`,
    'auth=pass',
    'validation=pass',
    'debugOnly=true',
    `idempotencyMode=${PBS_DEBUG_PUSH_IDEMPOTENCY_MODE}`,
    `idempotencyKeyHashShort=${idempotencyKeyHashShort}`,
    `memoryHit=${memoryHit}`,
    `persistentHit=${persistentHit}`,
    `accepted=${!duplicate}`,
    `duplicate=${duplicate}`,
  ];
  if (kvOutage) logFields.push('kvOutage=true');
  if (loggableEvent.road) logFields.push(`road=${loggableEvent.road}`);
  if (loggableEvent.areaNm) logFields.push(`areaNm=${loggableEvent.areaNm}`);
  console.log(`[pbs-debug-push] ${logFields.join(' ')}`);

  if (duplicate) {
    return jsonResponse({ ok: true, accepted: false, duplicate: true, requestId, eventId, lifecycle });
  }

  return jsonResponse({ ok: true, accepted: true, debugOnly: true, requestId, eventId, lifecycle });
}
