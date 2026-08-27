// V1.9.5 — POST /internal/pbs-debug-push
//
// Windows PBS Local Monitor → Cloudflare, DEBUG-ONLY receiving end. This
// round proves exactly one thing, end to end: Windows can send a minimal
// event payload, Cloudflare can authenticate it, validate its shape, make
// a best-effort idempotency judgment, log it, and ACK — nothing more.
//
// HARD BOUNDARY (the whole point of this module): this file imports
// NOTHING from line/, cctv/, traffic/sharedFeed(Handler)?.js,
// traffic/incidentSuppression.js, traffic/notified.js,
// traffic/broadcastProvenance.js, traffic/pipelineTrace.js, or pbs/
// lifecycle.js|pipeline.js, and never touches `env.TRAFFIC_KV` (or any
// other binding) at all. A request here cannot reach LINE, CCTV, Shared
// Feed, Incident Suppression, notified-state, Broadcast Provenance, or
// Pipeline Trace even by accident — there is no import path to any of
// them, and no KV/R2/fetch call anywhere in this file. This is the
// module-level guarantee the order's "Debug-only 邊界" section asks for,
// enforced structurally rather than by a runtime flag that could be
// forgotten or flipped.
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
//
// IDEMPOTENCY: Cloudflare Workers isolates are not a reliable place to
// dedupe across requests — a given request can land on any warm isolate,
// or a fresh one, with no guarantee the same isolate saw the prior
// request for the same event. Per this round's own explicit fallback
// instruction, this module does NOT add a KV write to solve that: it
// keeps a small in-memory (per-isolate) Map of recently-seen fingerprints
// as a best-effort duplicate hint, and reports the honest limitation
// (CROSS_REQUEST_IDEMPOTENCY = NOT_PERSISTENT) rather than implying a
// guarantee this design cannot make. See PBS_DEBUG_PUSH_IDEMPOTENCY_MODE.

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

// Best-effort, per-isolate, NEVER persisted to KV — see module comment.
// Bounded so a burst of distinct fingerprints cannot grow this without
// limit within one isolate's lifetime.
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRACKED_FINGERPRINTS = 500;
export const PBS_DEBUG_PUSH_IDEMPOTENCY_MODE = 'NOT_PERSISTENT';

let recentFingerprints = new Map(); // fingerprint -> lastSeenAtEpochMs

/** Test-only reset — mirrors this repo's existing resetTdxTokenCache()
 * convention for module-level state that must not leak between tests. */
export function resetPbsDebugPushIdempotencyState() {
  recentFingerprints = new Map();
}

function pruneExpired(nowMs) {
  for (const [fp, seenAt] of recentFingerprints) {
    if (nowMs - seenAt > IDEMPOTENCY_WINDOW_MS) recentFingerprints.delete(fp);
  }
  // Defensive cap even if clock skew or a pathological burst defeats the
  // age-based prune above — evict oldest first (Map preserves insertion
  // order).
  while (recentFingerprints.size > MAX_TRACKED_FINGERPRINTS) {
    const oldestKey = recentFingerprints.keys().next().value;
    recentFingerprints.delete(oldestKey);
  }
}

/** Returns true (and records it) the FIRST time a fingerprint is seen
 * within the window; returns false (duplicate) on a repeat. */
function checkAndRecordFingerprint(fingerprint, nowMs) {
  pruneExpired(nowMs);
  const seenAt = recentFingerprints.get(fingerprint);
  const isDuplicate = seenAt !== undefined && nowMs - seenAt <= IDEMPOTENCY_WINDOW_MS;
  recentFingerprints.set(fingerprint, nowMs); // refresh position/timestamp either way
  return !isDuplicate;
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

  const { generatedAt, eventId, lifecycle, fingerprint, requestId, event } = body;
  const receivedAt = now.toISOString();
  const loggableEvent = extractLoggableEventFields(event);

  const isFirstSeen = checkAndRecordFingerprint(fingerprint, now.getTime());

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
    `duplicate=${!isFirstSeen}`,
  ];
  if (loggableEvent.road) logFields.push(`road=${loggableEvent.road}`);
  if (loggableEvent.areaNm) logFields.push(`areaNm=${loggableEvent.areaNm}`);
  console.log(`[pbs-debug-push] ${logFields.join(' ')}`);

  if (!isFirstSeen) {
    return jsonResponse({ ok: true, accepted: false, duplicate: true, requestId, eventId, lifecycle });
  }

  return jsonResponse({ ok: true, accepted: true, debugOnly: true, requestId, eventId, lifecycle });
}
