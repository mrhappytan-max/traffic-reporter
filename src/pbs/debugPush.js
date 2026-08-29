// V1.9.5/V1.9.7/V1.9.8/V1.9.9 Phase 2 — POST /internal/pbs-debug-push
//
// Windows PBS Local Monitor → Cloudflare. V1.9.5 proved the channel itself
// (auth, shape validation, a durable idempotency judgment, log, ACK).
// V1.9.7 made that idempotency judgment durable across isolates/restarts.
//
// V1.9.9 Phase 2 — AI-ready pipeline preparation. Alongside the (unchanged)
// legacy Business Pipeline call below, a genuinely accepted NEW/UPDATED
// event now ALSO builds and logs an "AI candidate" preview via
// pbs/aiCandidate.js — see that module's own header comment for the full
// design. This is observability-only (PBS_AI_DECISION_MODE =
// PREPARED_NOT_ACTIVE): it never gates, delays, or changes the real
// runLineBroadcast call or its outcome.
//
// V1.9.8 (order section 三/四) — this is now the FORMAL Windows PBS
// PRODUCTION INGRESS, upgraded in place rather than duplicated into a
// second endpoint (the order's own "選擇改動最小、重複程式碼最少的方案").
// The old "HARD BOUNDARY: 0 imports from line/, cctv/, ... 0 business KV
// writes" claim from V1.9.5/V1.9.7 is DELIBERATELY LIFTED for a genuinely
// accepted (non-duplicate) NEW/UPDATED event: auth -> validation ->
// persistent idempotency (UNCHANGED from V1.9.7, see below) -> a
// first-time-valid event is normalized into the SAME unified-event shape
// pbs/normalize.js's normalizePbsEvent() has always produced, then handed
// to the SAME canonical Business Pipeline entry point traffic/
// scheduled.js's Cron path has always used — traffic/broadcastPipeline.js's
// runLineBroadcast() — followed by the SAME traffic/sharedFeed.js
// runSharedFeedPersist() call scheduled.js makes right after it. This file
// never re-implements accident/service-area/location-quality policy,
// eligibility, dedupe, CCTV, or Shared Feed logic — see buildRawPbsRecordFromPush()
// below and its call site for the ONE place a Windows payload becomes a
// canonical event; every judgment past that point is made by the exact
// same function the retiring PBS-polling path always called (order
// section 四: "同一事件不論來源...正式判斷結果應由同一套函式產生").
//
// A CLEARED lifecycle is the one deliberate exception: it is ACKNOWLEDGED
// and logged, exactly like NEW/UPDATED, but NEVER routed into
// runLineBroadcast — this mirrors pbs/pipeline.js's own long-standing
// behavior, where classifyPbsLifecycle()'s `clearedEvents` never reach
// crossSourceDedup/broadcastEvents either (see pbs/pipeline.js — only
// `activeEvents` ever gets there). See "CLEARED lifecycle" below.
//
// LINE Push Policy is completely untouched by this round: MAJOR_ACCIDENT_ONLY
// and every existing eligibility/service-area/location-quality gate inside
// runLineBroadcast apply to a Windows-sourced event exactly as they already
// do to a TDX/polling-PBS-sourced one — this file makes zero policy
// decisions of its own.
//
// V1.9.7's own idempotency/KV-prefix-isolation guarantee is UNCHANGED by
// this round: this module still touches `env.TRAFFIC_KV` directly for
// ONLY its own dedicated debug-only prefix (IDEMPOTENCY_KV_PREFIX below,
// `debug:pbs-push-idempotency:v1:*`) — every OTHER KV key this file's
// business-pipeline call now reaches (`line:notified-state`,
// `line:incident-suppression-state`, `debug:broadcast-provenance:v1:*`,
// `traffic:shared-feed`) is written exclusively BY runLineBroadcast/
// runSharedFeedPersist themselves, the SAME functions/keys the polling
// path already used — never a second, parallel key this file invents.
// See test/pbsDebugPush.test.js's V1.9.8 section for the updated,
// honest boundary tests (a genuinely accepted NEW/UPDATED event DOES now
// reach those keys through the canonical pipeline; a duplicate or a
// CLEARED push still touches NONE of them).
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

// V2.1.0 (order section 二/七/八/九) — TRANSPORT ACK DECOUPLED FROM BUSINESS
// PROCESSING. Real Production incident: two genuine NEW events reached
// service-area + AI_CALL_STARTED successfully, but Windows's own 5-second
// HTTP timeout fired while this handler was still `await`ing
// resolveAiDecision() (a real Workers AI call). Because this handler never
// handed that work to `ctx.waitUntil()`, the Workers runtime treated the
// client's disconnect as licence to cancel the still-running fetch handler
// — the AI call, the LINE decision, and the Observatory record never
// completed (AI decision complete = 0). Windows's own client-side retry
// then found this endpoint's OWN idempotency record already written
// (see IDEMPOTENCY_KV_PREFIX — written the instant a request was accepted,
// BEFORE business processing began) and was silently treated as a
// duplicate forever: nothing ever re-attempted the AI decision.
//
// This round makes two changes, together closing the whole failure mode —
// neither one alone is sufficient:
//
// (1) BACKGROUND EXECUTION — a genuinely accepted (non-duplicate) NEW/
// UPDATED event's business processing (AI candidate -> AI decision ->
// LINE/Shared Feed -> Observatory record, OR the legacy runLineBroadcast
// path) is now handed to `ctx.waitUntil()` (see runProcessingInBackground
// below) instead of being awaited before the response is built. The HTTP
// response to Windows now reflects ONLY "did Cloudflare durably accept
// this transition" — never "did the AI finish deciding" — so Windows's
// own short timeout can no longer race against Workers AI at all. Per
// Cloudflare's own documented `ctx.waitUntil` contract, work handed to it
// keeps running even after the response has been sent AND even if the
// client that made the request disconnects — the exact guarantee this
// endpoint needs. `ctx` is optional (4th positional parameter, added
// after the pre-existing `now` parameter so every existing call site/test
// that passes only `(request, env, now)` is unaffected — see
// test/pbsDebugPush.test.js's untouched call sites): when absent (every
// existing unit test), this function falls back to `await`ing the work
// directly, preserving the exact synchronous-completion behavior those
// tests already assert. Only Production (src/index.js's fetch handler,
// which now accepts and forwards `ctx`) actually exercises the background
// path.
//
// (2) TWO-PHASE IDEMPOTENCY MARKER — a genuinely new event's KV
// idempotency record now carries a `status` field: 'PROCESSING' the
// instant it's durably accepted (so a truly concurrent duplicate transport
// retry still can't trigger a second business-processing run), then
// 'COMPLETED' once that background work actually finishes (success OR an
// internally-handled failure — see markProcessingComplete below). A
// request whose idempotency key already has status='PROCESSING' is
// STILL treated as a transport duplicate (no reprocessing) as long as
// that record is younger than PROCESSING_STALE_MS — the original
// background attempt, now genuinely unstoppable via ctx.waitUntil, is
// trusted to finish on its own. Only once a 'PROCESSING' record is OLDER
// than PROCESSING_STALE_MS (meaning the original attempt almost certainly
// never got to run at all — e.g. an isolate evicted before ctx.waitUntil
// could even schedule it, not a normal client-observed timeout, which
// this round's fix (1) already prevents from mattering) is a retry
// treated as NOT a duplicate, and business processing is genuinely
// re-attempted. This is what closes section 十一 item 5 ("第一次背景處理
// 失敗時，不得因過早 duplicate marker 永久卡死") — a legacy record with no
// `status` field at all (written before this round shipped) is treated as
// COMPLETED for backward compatibility, matching this endpoint's own
// pre-V2.1.0 behavior (an existing record always meant "already handled").
//
// TRANSPORT RECEIVED != BUSINESS PROCESSING COMPLETED (order section 七) —
// these are now two genuinely separate, separately-observable facts: the
// HTTP response/idempotency-accept answers the FIRST; the KV record's own
// `status` field (PROCESSING -> COMPLETED) and the existing
// `[pbs-debug-push][ai-decision]`/`[pbs-debug-push][business-pipeline]`
// log lines answer the SECOND. Deliberately NOT solved with a Cloudflare
// Queue (order section 二's own "不要先引入 Queue，除非現有 Worker
// lifecycle 無法可靠完成" — ctx.waitUntil is the existing Worker lifecycle
// primitive, and it IS sufficient here) and NOT solved with a Durable
// Object (order's own "不要過度設計" precedent, same reasoning as this
// file's pre-existing KV_ONLY_ATOMICITY note) — a bounded staleness window
// on a KV record is the minimum viable fix for the ACTUAL identified
// failure (execution genuinely cancelled before ctx.waitUntil could
// protect it), not a theoretical general-purpose exactly-once system.
//
// EXPLICITLY UNCHANGED THIS ROUND: AI prompt/model/schema/cache, the
// Windows PBS service-area/eligibility gate, LINE message formatting,
// driverSummary, hourly reminder, CCTV, Shared Feed product policy, TDX,
// and every raw-PBS-text field (comment/srcdetail) copy path
// (buildRawPbsRecordFromPush/normalizePbsEvent/buildAiCandidate/
// buildAiUserPrompt below) — none of those functions were touched. See
// this round's own final report for the RAW_TEXT_MUTATION_FOUND /
// RAW_TEXT_LOSS_FOUND re-verification.
//
// See test/pbsDebugPushBackgroundProcessing.test.js for the full
// regression suite: fast-ACK-before-AI-completes, ctx.waitUntil work
// actually completing the AI/LINE/Observatory path afterward, a fresh
// PROCESSING record still deduping a genuine transport retry, a STALE
// PROCESSING record allowing exactly one recovery re-attempt, and CLEARED/
// no-ctx call sites behaving byte-identically to before.

// V2.2.0 — Four-Layer Event Lifecycle Observatory (order section 一/九).
// This round adds exactly ONE thing to this module's own runtime
// behavior: processAcceptedEvent (below) now writes an early
// AI_OUTCOME.PROCESSING_STARTED Observatory record the instant business
// processing begins, before anything that could throw — so a crashed or
// never-completed background attempt still leaves a card on the
// Observatory page instead of vanishing. The FINAL Observatory write
// (unchanged from V2.0.1/V2.1.0) overwrites that SAME key once the real
// outcome is known — see aiObservatoryIndex.js's own header comment for
// exactly how the key stays identical across both writes. Everything else
// this round changed lives in aiObservatoryIndex.js (rawComment/
// rawSourceDetail, untruncated) and aiObservatoryView.js (the four-layer
// page itself) — this file's AI-or-legacy decision logic, idempotency
// design, and background-execution model (V2.1.0) are UNCHANGED.

import { verifyDebugPushToken } from './debugPushAuth.js';
import { normalizePbsEvent } from './normalize.js';
import { runLineBroadcast } from '../traffic/broadcastPipeline.js';
import { runSharedFeedPersist } from '../traffic/sharedFeed.js';
import { toTaipeiParts } from '../traffic/broadcastHours.js';
import { isWindowsPbsAiCandidateEligible, buildAiCandidate, PBS_AI_DECISION_MODE } from './aiCandidate.js';
import { resolvePbsAiDecisionEnabled } from './aiConfig.js';
import { resolveAiDecision, PBS_AI_MODEL_ID } from './aiDecisionEngine.js';
import { runAiApprovedPbsBroadcast } from '../traffic/aiApprovedPbsBroadcast.js';
import { taipeiDateString } from '../tdx/usageLedger.js';
import { buildAiObservatoryRecord, recordAiObservatoryEntry, AI_OUTCOME } from './aiObservatoryIndex.js';

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

// V1.9.8 — self-describing status constants, same convention as the three
// above: exported so the final report and any future reader/test cite the
// SAME literal this module itself asserts, never a second hand-typed copy.
export const WINDOWS_PBS_PRODUCTION_INGRESS = 'ACTIVE';
export const PRODUCTION_BUSINESS_PIPELINE_INTEGRATION = 'ACTIVE';

// V2.1.0 — see this module's own header comment for the full design.
// The two-phase idempotency record status, and how a background attempt
// stops being trusted to "still be running" and starts being eligible for
// recovery. Exported for the same "final report cites the literal this
// module itself asserts" discipline as the constants above.
export const IDEMPOTENCY_STATUS = { PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED' };

// 60 seconds — generous against a real Workers AI call's actual duration
// (single-digit seconds per this project's own measured aiDecisionEngine.js
// durationMs logging) so a legitimately still-running ctx.waitUntil
// attempt is never mistaken for a lost one, while staying far shorter than
// Windows's own natural ~3-minute PBS re-poll interval (see this file's
// V1.9.8-era comment on Business Pipeline failure isolation) so a
// genuinely lost attempt recovers well before Windows would have moved on
// anyway.
export const PROCESSING_STALE_MS = 60 * 1000;

export const PBS_DEBUG_PUSH_LIFECYCLE_MODE = 'TRANSPORT_ACK_DECOUPLED_FROM_BUSINESS_PROCESSING';
export const BACKGROUND_EXECUTION_MECHANISM = 'CTX_WAIT_UNTIL';

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
 *
 * V2.2.0 — exported (was module-private) so aiObservatoryView.js can
 * recompute the SAME key for a live, read-only "is this event's transport
 * still PROCESSING or already COMPLETED" lookup at page-render time —
 * never a second, parallel hash implementation (same reuse discipline as
 * this file's own AI decision cache key reuse elsewhere in this project).
 */
export async function computeIdempotencyKeyHash({ source, eventId, lifecycle, fingerprint }) {
  return sha256Hex(`${source}:${eventId}:${lifecycle}:${fingerprint}`);
}

export function buildIdempotencyKvKey(idempotencyKeyHash) {
  return `${IDEMPOTENCY_KV_PREFIX}:${idempotencyKeyHash}`;
}

/** V2.1.0 — the two-phase idempotency record shape. See IDEMPOTENCY_STATUS
 * and this module's own header comment. */
function serializeIdempotencyRecord({ firstAcceptedAt, requestId, status, attemptCount = 1, completedAt }) {
  const record = { firstAcceptedAt, requestId, status, attemptCount };
  if (completedAt) record.completedAt = completedAt;
  return JSON.stringify(record);
}

/**
 * V2.1.0 — called once business processing (AI-or-legacy path +
 * Observatory record) fully finishes, success or an internally-handled
 * failure alike, so a future duplicate never re-attempts already-completed
 * work. Best-effort and NEVER throws — marking COMPLETED is an
 * optimization (it lets a genuinely lost/crashed attempt recover sooner
 * via PROCESSING_STALE_MS), never a correctness requirement: the real
 * outcome (AI decision, LINE push, Observatory record) has already fully
 * happened by the time this is called, and a failed write here only means
 * a future duplicate retry might redundantly re-run processing (bounded,
 * self-correcting, same fail-open philosophy as every other KV write in
 * this module) rather than anything being lost.
 */
async function markProcessingComplete(kv, kvKey, { firstAcceptedAt, requestId, attemptCount, now = new Date() }) {
  if (!kv || !kvKey) return;
  try {
    await kv.put(
      kvKey,
      serializeIdempotencyRecord({
        firstAcceptedAt,
        requestId,
        status: IDEMPOTENCY_STATUS.COMPLETED,
        attemptCount,
        completedAt: now.toISOString(),
      }),
      { expirationTtl: IDEMPOTENCY_TTL_SECONDS }
    );
  } catch (err) {
    console.error(`[pbs-debug-push][idempotency] failed to mark COMPLETED keySuffix=${kvKey.slice(-16)}: ${err && err.message}`);
  }
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
 * V1.9.8 — Asia/Taipei is a fixed UTC+8 offset (no DST), so converting an
 * ISO instant to Taipei "YYYY-MM-DD"/"HH:MM:SS" parts and handing them to
 * pbs/normalize.js's own parseHappenedAt/parsePbsDateTime (which interpret
 * those same two shapes as Taipei local time) round-trips to the EXACT
 * same instant — this is a precise reconstruction, not an approximation.
 */
function taipeiDateTimeStringsFromIso(iso) {
  const { year, month, day, hour, minute, second } = toTaipeiParts(new Date(iso));
  const pad = (n) => String(n).padStart(2, '0');
  const happendate = `${year}-${pad(month)}-${pad(day)}`;
  const happentime = `${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return { happendate, happentime, modDttm: `${happendate} ${happentime}` };
}

/**
 * The ONE place a Windows push payload becomes a raw-PBS-shaped record —
 * see pbs/normalize.js's normalizePbsEvent() for the exact fields it reads
 * (UID/road/areaNm/direction/roadtype/comment/happendate/happentime/
 * modDttm/x1/y1/srcdetail). Never touches classification/eligibility/
 * formatting itself — normalizePbsEvent (unchanged) does that, identically
 * to how it always has for a polled PBS record.
 *
 * Field-by-field provenance, honestly:
 *   - UID/road/areaNm/direction/comment/x1(longitude)/y1(latitude)/
 *     srcdetail: taken directly from the Windows payload's `event` object
 *     (EVENT_LOG_FIELDS) / top-level `eventId` — exactly what Windows sent.
 *   - happendate/happentime/modDttm: derived from the payload's own
 *     `generatedAt` (see taipeiDateTimeStringsFromIso above) — a PRECISE
 *     reconstruction of that instant, not a guess. Using the SAME instant
 *     for both "happened at" and "last updated" is correct here (not an
 *     approximation with a hidden cost) because Windows only ever forwards
 *     a genuine NEW/UPDATED transition it just detected (V1.9.6 local
 *     edge filter) — `generatedAt` IS the moment this transition became
 *     known, for both purposes, exactly the same relationship a polled
 *     PBS record's own happendate/modDttm would have on the tick that
 *     first observed it.
 *   - roadtype: deliberately left '' — the Windows payload never carried
 *     PBS's own roadtype bucket (EVENT_LOG_FIELDS has no such field, and
 *     never has). classifyPbsEvent() reads `roadtype+comment` as one
 *     combined text, and Windows's own local filter (V1.9.6) only ever
 *     forwards a NEW/UPDATED event whose comment already matches the SAME
 *     accident-keyword patterns classify.js itself uses — so comment
 *     alone is sufficient for a faithful classification here. This field
 *     is only ever read for NEW/UPDATED (a CLEARED payload never reaches
 *     normalizePbsEvent at all — see handlePbsDebugPush below), so the gap
 *     never affects the one lifecycle where a bare "已排除"-style comment
 *     would otherwise risk a wrong classification.
 */
function buildRawPbsRecordFromPush({ eventId, generatedAt, event }) {
  const e = event && typeof event === 'object' ? event : {};
  const { happendate, happentime, modDttm } = taipeiDateTimeStringsFromIso(generatedAt);
  return {
    UID: eventId,
    road: e.road || '',
    areaNm: e.areaNm || '',
    direction: e.direction || '',
    roadtype: '',
    comment: e.comment || '',
    happendate,
    happentime,
    modDttm,
    x1: e.longitude,
    y1: e.latitude,
    srcdetail: e.sourceDetail || '',
  };
}

/**
 * V1.9.9 Phase 3B — the AI decision path, only ever invoked when
 * resolvePbsAiDecisionEnabled(env) is true (see aiConfig.js). Fully
 * isolated in its own try/catch by the caller — an exception anywhere in
 * here can never crash the endpoint or the ACK back to Windows, same
 * failure-isolation principle as the legacy Business Pipeline call (order
 * section 九's own reasoning, extended to this path).
 *
 * Ordering matches the order's own section 八 exactly: candidate already
 * built by the caller (steps 1-4: auth/validation/idempotency/candidate)
 * -> here: (5) cache lookup -> (6) cache miss only calls Workers AI ->
 * (7) validate -> (8) persist (inside resolveAiDecision) -> (9) execute
 * notify/no-notify.
 */
// V2.0.1 (order section 一/三) — returns a small outcome descriptor so
// the caller can build ONE AI Decision Observatory index record after
// this function fully completes (see aiObservatoryIndex.js). This is the
// ONLY change this function makes for V2.0.1: every existing trace log
// line, every existing branch, and the exact AI-call/cache/notify
// semantics are UNCHANGED — the descriptor is built purely from values
// this function already computed for its own console.log lines, never a
// new decision or a second AI call.
async function runAiDecisionPath(env, { candidate, normalizedEvent, eventId, lifecycle, fingerprint, now }) {
  if (!candidate) {
    // Outside the service area — already logged by the caller
    // (candidate=false reason=outside-service-area). No AI call, no LINE.
    return { outcome: AI_OUTCOME.SERVICE_AREA_EXCLUDED };
  }

  // event=AI_CALL_STARTED is logged UNCONDITIONALLY here, before the cache
  // lookup that resolveAiDecision performs internally — "started" marks
  // this decision RESOLUTION starting (order section十五's own trace
  // vocabulary), which a cache hit still resolves without ever reaching
  // Workers AI itself (see the AI_CACHE_HIT/AI_CACHE_MISS line right
  // after, which is what actually distinguishes the two).
  console.log(`[pbs-debug-push][ai-decision] event=AI_CALL_STARTED eventId=${eventId} lifecycle=${lifecycle}`);

  let aiResult;
  try {
    aiResult = await resolveAiDecision(env, candidate, { eventId, fingerprint }, now);
  } catch (err) {
    console.error(`[pbs-debug-push][ai-decision] event=AI_CALL_FAILED eventId=${eventId} lifecycle=${lifecycle} detail=${err && err.message}`);
    return { outcome: AI_OUTCOME.AI_CALL_FAILED, cacheStatus: 'MISS' }; // fail closed — no LINE, no fallback to the legacy hard-rule decision (order section 十二)
  }

  const cacheStatus = aiResult.source === 'cache-hit' ? 'HIT' : 'MISS';
  console.log(
    `[pbs-debug-push][ai-decision] event=${aiResult.source === 'cache-hit' ? 'AI_CACHE_HIT' : 'AI_CACHE_MISS'} ` +
      `eventId=${eventId} lifecycle=${lifecycle} durationMs=${aiResult.durationMs}`
  );

  if (!aiResult.ok) {
    console.log(
      `[pbs-debug-push][ai-decision] event=${aiResult.reason} eventId=${eventId} lifecycle=${lifecycle} ` +
        `detail=${aiResult.detail || ''} durationMs=${aiResult.durationMs}`
    );
    // aiResult.reason is already 'AI_CALL_FAILED' or 'AI_DECISION_INVALID'
    // — the SAME closed vocabulary AI_OUTCOME uses, never re-mapped.
    return { outcome: aiResult.reason, cacheStatus }; // -> 0 LINE, no fallback
  }

  console.log(`[pbs-debug-push][ai-decision] event=AI_DECISION_VALID eventId=${eventId} lifecycle=${lifecycle}`);

  const { decision } = aiResult;
  console.log(
    `[pbs-debug-push][ai-decision] event=${decision.notify ? 'AI_NOTIFY_TRUE' : 'AI_NOTIFY_FALSE'} eventId=${eventId} ` +
      `lifecycle=${lifecycle} model=${PBS_AI_MODEL_ID} impact=${decision.impact} ` +
      `confidence=${decision.confidence} reason=${decision.reason}`
  );

  if (!decision.notify) {
    return { outcome: AI_OUTCOME.AI_NOTIFY_FALSE, cacheStatus }; // trace only — no LINE, no CCTV, no proactive broadcast (order section 九)
  }

  try {
    const broadcastResult = await runAiApprovedPbsBroadcast(env, { event: normalizedEvent, now });
    console.log(
      `[pbs-debug-push][ai-decision] event=AI_LINE_ATTEMPTED eventId=${eventId} lifecycle=${lifecycle} ` +
        `lineReady=${broadcastResult.lineReady} suppressed=${broadcastResult.suppressed} ` +
        `pendingTargets=${broadcastResult.pendingTargetCount} pushAttempted=${broadcastResult.pushAttempted} ` +
        `pushSucceeded=${broadcastResult.pushSucceeded}`
    );
    const lineSent = broadcastResult.pushAttempted > 0 && broadcastResult.pushSucceeded === broadcastResult.pushAttempted;
    console.log(
      `[pbs-debug-push][ai-decision] event=${lineSent ? 'AI_LINE_SENT' : broadcastResult.pushAttempted > 0 ? 'AI_LINE_FAILED' : 'AI_LINE_NOT_ATTEMPTED'} ` +
        `eventId=${eventId} lifecycle=${lifecycle}`
    );

    let sharedFeedCommitted = false;
    try {
      const sharedFeedSummary = await runSharedFeedPersist(env, { completedProducts: broadcastResult.completedProducts, now });
      sharedFeedCommitted = Boolean(sharedFeedSummary.committed);
    } catch (err) {
      console.error(`[pbs-debug-push][shared-feed] eventId=${eventId} failed: ${err && err.message}`);
    }
    if (broadcastResult.lineErrors.length > 0) {
      console.error(`[pbs-debug-push][ai-decision] eventId=${eventId} lineErrors=${broadcastResult.lineErrors.join('; ')} sharedFeedCommitted=${sharedFeedCommitted}`);
    }
    const firstProduct = broadcastResult.completedProducts && broadcastResult.completedProducts[0];
    return {
      outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
      cacheStatus,
      lineAttempted: broadcastResult.pushAttempted > 0,
      lineSent,
      sharedFeedPersisted: sharedFeedCommitted,
      imageUrlPresent: Boolean(firstProduct && firstProduct.imageUrl),
    };
  } catch (err) {
    console.error(`[pbs-debug-push][ai-decision] event=AI_LINE_FAILED eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
    return { outcome: AI_OUTCOME.AI_NOTIFY_TRUE, cacheStatus, lineAttempted: true, lineSent: false };
  }
}

/**
 * GET /internal/pbs-debug-push (any non-POST method): 405, checked BEFORE
 * auth — which HTTP methods a route accepts is not sensitive information
 * (unlike whether an admin page's CONTENT exists), so this can be a plain
 * routing-level answer, same as this project's public routes.
 */
export async function handlePbsDebugPush(request, env, now = new Date(), ctx) {
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
  let staleRecovery = false;
  const kv = env.TRAFFIC_KV;
  let kvKey = null;
  let acceptedFirstAcceptedAt = now.toISOString();
  let acceptedAttemptCount = 1;

  if (checkAndRecordMemory(idempotencyKeyHash, nowMs)) {
    duplicate = true;
    memoryHit = true;
  } else if (kv) {
    kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
    let existingRaw = null;
    try {
      existingRaw = await kv.get(kvKey);
    } catch {
      kvOutage = true; // fail OPEN — see module comment
    }

    let existingRecord = null;
    if (existingRaw !== null) {
      try {
        existingRecord = JSON.parse(existingRaw);
      } catch {
        existingRecord = null; // corrupt record — treated the same as a legacy no-status record below
      }
    }

    if (existingRaw === null) {
      // Genuinely new key (V2.1.0) — write the PROCESSING marker. See
      // markProcessingComplete for the follow-up write once business
      // processing actually finishes.
      try {
        await kv.put(
          kvKey,
          serializeIdempotencyRecord({ firstAcceptedAt: acceptedFirstAcceptedAt, requestId, status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: acceptedAttemptCount }),
          { expirationTtl: IDEMPOTENCY_TTL_SECONDS }
        );
      } catch {
        kvOutage = true; // event still accepted below — see module comment
      }
    } else if (existingRecord && existingRecord.status === IDEMPOTENCY_STATUS.PROCESSING) {
      const firstAcceptedAtMs = existingRecord.firstAcceptedAt ? Date.parse(existingRecord.firstAcceptedAt) : NaN;
      const ageMs = Number.isFinite(firstAcceptedAtMs) ? nowMs - firstAcceptedAtMs : Infinity;
      if (ageMs >= PROCESSING_STALE_MS) {
        // V2.1.0 recovery path (order section 十一 item 5) — the original
        // attempt never reached COMPLETED and this record is now older
        // than any real ctx.waitUntil-protected attempt should take;
        // treat this retry as genuinely new and re-attempt business
        // processing rather than staying duplicate-blocked forever.
        staleRecovery = true;
        acceptedFirstAcceptedAt = now.toISOString();
        acceptedAttemptCount = (Number.isFinite(existingRecord.attemptCount) ? existingRecord.attemptCount : 1) + 1;
        try {
          await kv.put(
            kvKey,
            serializeIdempotencyRecord({ firstAcceptedAt: acceptedFirstAcceptedAt, requestId, status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: acceptedAttemptCount }),
            { expirationTtl: IDEMPOTENCY_TTL_SECONDS }
          );
        } catch {
          kvOutage = true;
        }
      } else {
        // A fresh PROCESSING record — the original attempt is trusted to
        // still be genuinely running under ctx.waitUntil (see module
        // comment); this retry is a true transport duplicate.
        duplicate = true;
        persistentHit = true;
      }
    } else {
      // status === COMPLETED, or a legacy pre-V2.1.0 record with no
      // `status` field at all — both mean "already handled", exactly this
      // endpoint's pre-V2.1.0 behavior for any existing record.
      duplicate = true;
      persistentHit = true;
    }
  }
  // No `env.TRAFFIC_KV` binding at all (should never happen in
  // Production, but must never crash) degrades to memory-only L1,
  // identical to V1.9.5's own behavior before this round.

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
  if (staleRecovery) logFields.push('staleRecovery=true');
  if (loggableEvent.road) logFields.push(`road=${loggableEvent.road}`);
  if (loggableEvent.areaNm) logFields.push(`areaNm=${loggableEvent.areaNm}`);
  console.log(`[pbs-debug-push] ${logFields.join(' ')}`);

  // V1.9.8 (order section 三/四/七) — Business Pipeline integration. Only a
  // GENUINELY ACCEPTED (non-duplicate) NEW/UPDATED event ever reaches this;
  // a duplicate stops here (0 second Business Pipeline pass, 0 second LINE
  // push, 0 second Shared Feed side effect — order section 六), and CLEARED
  // is acknowledged/logged above but deliberately never routed into
  // runLineBroadcast (mirrors pbs/pipeline.js's own clearedEvents-never-
  // broadcast behavior — see this module's own header comment).
  //
  // Failure isolation (order section 九): this whole block is wrapped so a
  // Business Pipeline exception can NEVER crash this endpoint or the ACK
  // back to Windows — logged only. Windows will naturally re-detect and
  // re-push the same transition on its own next ~3-minute poll if the
  // underlying PBS event is still present; no separate fallback-polling
  // mechanism is introduced for this.
  //
  // V2.1.0 — this is now the exact unit of work handed to ctx.waitUntil()
  // (see the dispatch right below this closure) instead of being awaited
  // inline before the response. Nothing INSIDE this closure changed for
  // V2.1.0 — same AI-or-legacy branch, same Observatory write, same
  // failure isolation — only WHEN and HOW it runs changed.
  const processAcceptedEvent = async () => {
    // V2.2.0 (order section 一/九) — the EARLIEST possible Observatory
    // write, before anything that could throw (buildRawPbsRecordFromPush/
    // normalizePbsEvent/candidate build). Built straight from the raw
    // Windows payload fields (never normalized/parsed) so this write does
    // not depend on any of the parsing this closure is about to attempt —
    // an event that crashes moments later, or whose ctx.waitUntil work is
    // genuinely lost, still leaves ONE card behind (frozen at
    // PROCESSING_STARTED) instead of being invisible on the Observatory
    // page, which is exactly the gap this round's order exists to close.
    // The FINAL write later in this closure reuses the identical (now,
    // taipeiDate, idempotencyKeyHash) triple, so it overwrites this same
    // KV key rather than creating a second entry — ONE extra KV put per
    // accepted event total, not two separate records.
    try {
      const pseudoCandidate = {
        road: (event && event.road) || null,
        direction: (event && event.direction) || null,
        areaNm: (event && event.areaNm) || null,
        comment: (event && event.comment) || '',
        sourceDetail: (event && event.sourceDetail) || '',
        longitude: event && typeof event.longitude === 'number' ? event.longitude : null,
        latitude: event && typeof event.latitude === 'number' ? event.latitude : null,
        generatedAt,
      };
      const startedRecord = buildAiObservatoryRecord({
        candidate: pseudoCandidate,
        eventId,
        lifecycle,
        fingerprint,
        now,
        outcome: AI_OUTCOME.PROCESSING_STARTED,
      });
      await recordAiObservatoryEntry(env.TRAFFIC_KV, startedRecord, {
        taipeiDate: taipeiDateString(now),
        idempotencyKeyHash,
        now,
      });
    } catch (err) {
      console.error(`[pbs-debug-push][ai-observatory] eventId=${eventId} lifecycle=${lifecycle} early-write failed: ${err && err.message}`);
    }

    try {
      const rawRecord = buildRawPbsRecordFromPush({ eventId, generatedAt, event });
      const normalizedEvent = normalizePbsEvent(rawRecord);

      // V1.9.9 Phase 2 (order section 一/二/三/四/六/七) — build the AI
      // candidate preview once, regardless of whether AI decisions are
      // active (see below). See src/pbs/aiCandidate.js's own header
      // comment for the full design and exactly which existing hard rules
      // this deliberately does NOT apply (event-type whitelist, LINE
      // policy, location-quality hard-reject) versus which it still
      // respects (service area — reusing the SAME canonical resolver,
      // never a second implementation).
      let candidate = null;
      try {
        if (isWindowsPbsAiCandidateEligible(normalizedEvent)) {
          candidate = buildAiCandidate(normalizedEvent, { lifecycle, generatedAt });
          console.log(
            `[pbs-debug-push][ai-candidate] event=AI_CANDIDATE_CREATED eventId=${eventId} lifecycle=${lifecycle} ` +
              `mode=${PBS_AI_DECISION_MODE} eventType=${candidate.eventType} ` +
              `locationQualitySufficient=${Boolean(candidate.locationQuality && candidate.locationQuality.sufficient)}`
          );
        } else {
          console.log(`[pbs-debug-push][ai-candidate] eventId=${eventId} lifecycle=${lifecycle} mode=${PBS_AI_DECISION_MODE} candidate=false reason=outside-service-area`);
        }
      } catch (err) {
        console.error(`[pbs-debug-push][ai-candidate] eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
      }

      // V1.9.9 Phase 3B (order section 十八) — the ONE branch point. When
      // AI decisions are disabled (the safe default — see aiConfig.js's
      // own comment), behavior is BYTE-IDENTICAL to V1.9.8/Phase 2: the
      // legacy canonical Business Pipeline (runLineBroadcast) is the sole
      // judge. When enabled, the NEW AI decision path (order section
      // 八/九/十) runs INSTEAD of the legacy call for this event — never
      // BOTH, which would risk a genuine double LINE push if both the old
      // hard rules and the AI happened to approve the same event (order
      // section 十二's own "避免同一事件有兩套裁判" reasoning applies here
      // too, not just to AI-call failures).
      let observatoryOutcome;
      if (resolvePbsAiDecisionEnabled(env)) {
        observatoryOutcome = await runAiDecisionPath(env, { candidate, normalizedEvent, eventId, lifecycle, fingerprint, now });
      } else {
        // Reuses the EXACT SAME canonical Business Pipeline entry point
        // traffic/scheduled.js's Cron path calls for every polled TDX/PBS
        // event — see this module's own header comment. Every eligibility/
        // service-area/location-quality/dedupe/incident-suppression/CCTV/
        // LINE-push-policy/notified-state decision below is made by that
        // SAME function, never a second copy.
        const lineSummary = await runLineBroadcast(env, {
          allEvents: [normalizedEvent],
          dedupeAvailable: true,
          now,
          dryRun: false,
        });
        // Same reuse principle for the Shared Traffic Feed — the exact call
        // traffic/scheduled.js makes immediately after its own
        // runLineBroadcast, using the SAME lineSummary.completedProducts
        // shape, so a Windows-originated PBS event keeps appearing in the
        // Shared Feed after Cloudflare's own PBS polling retires (order
        // section 八) exactly as it did before.
        let sharedFeedCommitted = false;
        try {
          const sharedFeedSummary = await runSharedFeedPersist(env, { completedProducts: lineSummary.completedProducts, now });
          sharedFeedCommitted = Boolean(sharedFeedSummary.committed);
        } catch (err) {
          console.error(`[pbs-debug-push][shared-feed] eventId=${eventId} failed: ${err && err.message}`);
        }
        console.log(
          `[pbs-debug-push][business-pipeline] eventId=${eventId} lifecycle=${lifecycle} ` +
            `lineReady=${lineSummary.lineReady} broadcastRelevant=${lineSummary.broadcastRelevantCount} ` +
            `pendingTargets=${lineSummary.pendingTargetCount} pushAttempted=${lineSummary.pushAttempted} ` +
            `pushSucceeded=${lineSummary.pushSucceeded} sharedFeedCommitted=${sharedFeedCommitted}`
        );
        observatoryOutcome = {
          outcome: AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH,
          lineAttempted: lineSummary.pushAttempted > 0,
          lineSent: lineSummary.pushAttempted > 0 && lineSummary.pushSucceeded === lineSummary.pushAttempted,
          sharedFeedPersisted: sharedFeedCommitted,
        };
      }

      // V2.0.1 (order section 一/三/四) — ONE thin AI Decision Observatory
      // index record, written AFTER the outcome above is fully known —
      // never a second AI call, never a guess. See aiObservatoryIndex.js's
      // own header comment for why this is the minimum viable addition
      // (existing KV records cannot answer "what happened to this event"
      // for every outcome). Best-effort, isolated — a write failure here
      // must never affect the real AI/LINE/Shared-Feed outcome above,
      // which has already fully completed.
      if (observatoryOutcome) {
        try {
          const record = buildAiObservatoryRecord({
            candidate,
            eventId,
            lifecycle,
            fingerprint,
            now,
            ...observatoryOutcome,
          });
          await recordAiObservatoryEntry(env.TRAFFIC_KV, record, {
            taipeiDate: taipeiDateString(now),
            idempotencyKeyHash,
            now,
          });
        } catch (err) {
          console.error(`[pbs-debug-push][ai-observatory] eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
        }
      }
    } catch (err) {
      console.error(`[pbs-debug-push][business-pipeline] eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
    }
    // V2.1.0 — business processing has now genuinely finished (success or
    // an internally-handled failure above) — mark this idempotency record
    // COMPLETED so a future transport duplicate never re-attempts it. See
    // markProcessingComplete's own comment for why this is best-effort.
    await markProcessingComplete(kv, kvKey, { firstAcceptedAt: acceptedFirstAcceptedAt, requestId, attemptCount: acceptedAttemptCount, now: new Date() });
  };

  if (!duplicate && lifecycle !== 'CLEARED') {
    // V2.1.0 (order section 二/七) — hand off to ctx.waitUntil() so the
    // Windows HTTP response never waits on AI/LINE completion; every
    // existing unit test call site (no `ctx` argument) falls back to a
    // direct `await`, preserving their exact synchronous-completion
    // assertions. See this module's own header comment for the full
    // reasoning and test/pbsDebugPushBackgroundProcessing.test.js for the
    // dedicated regression coverage of both paths.
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(processAcceptedEvent());
    } else {
      await processAcceptedEvent();
    }
  } else if (!duplicate && lifecycle === 'CLEARED') {
    console.log(`[pbs-debug-push][business-pipeline] eventId=${eventId} lifecycle=CLEARED acknowledged=true routedToBroadcast=false`);
    // CLEARED never performs async business processing — nothing for
    // ctx.waitUntil to protect — so its own idempotency record can be
    // marked COMPLETED immediately rather than sitting at PROCESSING
    // until PROCESSING_STALE_MS passes for no reason.
    await markProcessingComplete(kv, kvKey, { firstAcceptedAt: acceptedFirstAcceptedAt, requestId, attemptCount: acceptedAttemptCount, now });
  }

  // Response schema deliberately UNCHANGED from V1.9.5/V1.9.7 (Windows
  // client contract stability — see test/pbsDebugPush.test.js's own
  // "response schema unchanged" test) — Business Pipeline outcome is
  // observable only via the `[pbs-debug-push][business-pipeline]` log
  // line above, never via this response body.
  if (duplicate) {
    return jsonResponse({ ok: true, accepted: false, duplicate: true, requestId, eventId, lifecycle });
  }

  return jsonResponse({ ok: true, accepted: true, debugOnly: true, requestId, eventId, lifecycle });
}
