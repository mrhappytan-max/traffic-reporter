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

// V2.3.0 — PBS AI Queue Reliability (order: 路況工程部｜V2.3.0 正式施工令
// ｜PBS AI Queue Reliability｜Cloudflare Queues 可靠背景處理).
//
// REAL PRODUCTION INCIDENT this round fixes: EVENT_ID=11508290166-0.
// Cloudflare received the event, built the AI candidate, and started the
// Workers AI call (16:49:03.112) — but the AI call itself did not return
// within the Cloudflare runtime's own background-execution window, and at
// 16:49:32.912 the platform force-cancelled the whole ctx.waitUntil task:
// "waitUntil() tasks did not complete within the allowed time after
// invocation end and have been cancelled." AI_CALL_COMPLETED=NO,
// AI_DECISION=NONE, LINE=NOT_EXECUTED, OBSERVATORY_FINAL=NONE,
// IDEMPOTENCY stayed PROCESSING permanently (its own 60s
// PROCESSING_STALE_MS window helps a RETRY recover, but does nothing for
// the original request's own AI decision, which is simply gone).
// ROOT_CAUSE = a Workers AI call was placed inside ctx.waitUntil(), a
// background-execution primitive with its OWN platform-enforced time
// budget completely independent of Windows's HTTP timeout (the V2.1.0
// fix already solved the "Windows's own short timeout races Workers AI"
// failure mode — this is a DIFFERENT failure mode: the AI call itself
// can simply run long enough to exceed Cloudflare's own background
// window, something no client-side timeout tuning can prevent).
//
// FIX — WAITUNTIL_AI_PROCESSING = RETIRED. AI business processing no
// longer runs inside this Worker's own HTTP-triggered invocation AT ALL
// (not synchronously, not via ctx.waitUntil) — it runs in a genuinely
// separate Worker invocation triggered by Cloudflare Queues, which has NO
// coupling whatsoever to the HTTP request that originally accepted the
// event:
//
//   Windows -> POST /internal/pbs-debug-push
//     -> auth/validate/idempotency (unchanged)
//     -> write status=PROCESSING (unchanged)
//     -> write Observatory PROCESSING_STARTED (unchanged content, moved
//        earlier — now written before enqueue, not before the old
//        ctx.waitUntil closure)
//     -> env.PBS_AI_QUEUE.send(message)   <- NEW: replaces ctx.waitUntil
//     -> HTTP ACK (fast — reflects "durably enqueued", same principle
//        V2.1.0 already established for "durably accepted")
//
//   Cloudflare Queues (independent delivery, AT_LEAST_ONCE)
//     -> queue() handler (src/index.js) -> handlePbsAiQueueBatch (below)
//     -> processQueuedPbsEvent: the EXACT SAME candidate/AI-decision/
//        legacy/Observatory-final logic V2.1.0/V2.2.0 ran via
//        ctx.waitUntil — REUSED, not reimplemented, just relocated and
//        parameterized by the queue message instead of closed over the
//        HTTP request
//     -> success -> Observatory final + idempotency COMPLETED -> ack
//     -> AI_CALL_FAILED (a call that didn't reliably complete — network/
//        5xx/timeout/capacity) -> bounded Queue retry (MAX_QUEUE_RETRIES)
//     -> retries exhausted -> ONE new terminal state,
//        AI_OUTCOME.PROCESSING_FAILED (aiObservatoryIndex.js), written
//        deterministically by THIS code (never left to an unconfigured
//        platform DLQ/drop) + idempotency COMPLETED + ack — never stuck
//        at PROCESSING forever
//
// AI_DECISION_INVALID (the call DID complete, with an invalid answer) is
// UNCHANGED and NOT retried — the order is explicit that this round only
// adds retry for "工作未可靠完成", never loosens the EXISTING fail-closed
// policy for a completed-but-invalid AI response.
//
// QUEUE DELIVERY MODEL — AT_LEAST_ONCE (Cloudflare's own documented
// guarantee, never assumed exactly-once). BUSINESS OUTCOME MODEL —
// EFFECTIVELY_ONCE: a re-delivered message re-checks the SAME transport
// idempotency record FIRST (processQueuedPbsEvent's own first step) and
// skips all business processing the instant it finds status=COMPLETED —
// on top of which the EXISTING notified-state/incident-suppression LINE
// dedup (untouched this round) is the ultimate backstop against a real
// double LINE push even in the narrow window where a retry re-runs
// processing whose earlier attempt already pushed LINE successfully but
// crashed before marking COMPLETED.
//
// KV COST — unchanged in the clean (no-retry) case: the SAME four writes
// V2.2.0 already made (idempotency PROCESSING+COMPLETED, Observatory
// PROCESSING_STARTED+final) still happen exactly once each — the Queue
// Consumer's final write reuses the identical KV keys the old
// ctx.waitUntil closure used, just from a different call site.
// EXTRA_KV_WRITES_PER_EVENT (clean case) = 0. A retried event costs one
// additional informational Observatory PUT per retry attempt (same KV
// key, overwritten) — see this round's own final report for the measured
// numbers.
//
// EXPLICITLY UNCHANGED THIS ROUND: Windows PBS filter/relay transport,
// Windows's own HTTP timeout, every raw-PBS-text copy path (comment/
// sourceDetail — see RAW_PBS_TEXT_POLICY, still IMMUTABLE_END_TO_END_
// UNTIL_AI, now also preserved unmodified through the queue message
// itself), AI Prompt/model/semantic policy, service area, LINE formatter/
// policy, driverSummary, hourly reminder, TDX, CCTV, Shared Feed product
// logic, and the Observatory page's own overall UI (only the outcome
// vocabulary gained one new terminal state).
//
// See test/pbsAiQueueReliability.test.js for the full regression suite,
// including the real EVENT_ID=11508290166-0 fixture, and this round's own
// final report for the measured KV/Queue operation cost formulas.

import { verifyDebugPushToken } from './debugPushAuth.js';
import { normalizePbsEvent } from './normalize.js';
import { runLineBroadcast } from '../traffic/broadcastPipeline.js';
import { runSharedFeedPersist } from '../traffic/sharedFeed.js';
import { toTaipeiParts } from '../traffic/broadcastHours.js';
import { isWindowsPbsAiCandidateEligible, buildAiCandidate, PBS_AI_DECISION_MODE } from './aiCandidate.js';
import { resolvePbsAiDecisionEnabled } from './aiConfig.js';
import { resolveAiDecision, PBS_AI_MODEL_ID } from './aiDecisionEngine.js';
import { runAiApprovedPbsBroadcast } from '../traffic/aiApprovedPbsBroadcast.js';
import { isTdxRoadEventProductionNotifyEnabled } from '../traffic/sourceMode.js';
import { taipeiDateString } from '../tdx/usageLedger.js';
import { buildAiObservatoryRecord, recordAiObservatoryEntry, AI_OUTCOME } from './aiObservatoryIndex.js';
import {
  readIncidentMemory,
  selectMemoryCandidates,
  buildIncidentMemoryUpdate,
  persistIncidentMemory,
  deriveEventLocationForMemory,
  incidentMemoryGroupKey,
} from '../traffic/incidentMemory.js';

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
// V2.3.0 — see this module's own header comment for the full incident and
// design. ctx.waitUntil is no longer used to carry AI business processing
// at all (retired, not merely "still allowed as a fallback") — a
// Cloudflare Queue is now the reliable execution carrier.
export const BACKGROUND_EXECUTION_MECHANISM = 'CLOUDFLARE_QUEUE';
export const WAITUNTIL_AI_PROCESSING = 'RETIRED';
export const QUEUE_ROLE = 'RELIABLE_AI_BUSINESS_PROCESSING';
export const QUEUE_DELIVERY_MODEL = 'AT_LEAST_ONCE';
export const BUSINESS_OUTCOME_MODEL = 'EFFECTIVELY_ONCE';

// The Worker binding name this module expects for its Queue producer —
// declared in wrangler.jsonc's own `queues.producers` block (the single
// canonical config source, order section 十四 — never Dashboard-only).
export const PBS_AI_QUEUE_BINDING_NAME = 'PBS_AI_QUEUE';

// Bounded retry count for a transient AI_CALL_FAILED (order section 八:
// "允許 Queue retry...但不要自行建立無限重試"). Matches wrangler.jsonc's
// own queue consumer `max_retries` so this code's own bail-out (author a
// deterministic PROCESSING_FAILED terminal state) fires at exactly the
// boundary the platform would otherwise stop delivering at anyway —
// never relies on an unconfigured platform DLQ to explain what happened.
export const MAX_QUEUE_RETRIES = 3;

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

// V2.4.3 — V2_4_3_AI_TIMEOUT_AND_STALE_RETRY_RELIABILITY_FIX (order
// section 七/八). Production evidence: while EVENT_ID 11509010029-5's
// original NEW attempt was still on its 2nd of 3 Queue retries, PBS
// separately pushed a CLEARED for the SAME eventId (16:21:01, mid-retry)
// — but the original NEW/UPDATED retry chain kept re-attempting AI on
// its own stale snapshot regardless, with no way to know the event was
// already over.
//
// A CLEARED push never itself reaches PBS_AI_QUEUE (see the HTTP ingress
// handler's own CLEARED branch below — it is acknowledged and completed
// immediately, no Queue message, no AI call) — so there is no Queue-level
// mechanism that would let a still-retrying NEW/UPDATED message discover
// a LATER CLEARED on its own. This is the minimal fix: a tiny, dedicated,
// per-(source,eventId) KV marker — NOT the idempotency record (whose key
// is scoped to one specific lifecycle+fingerprint, so it structurally
// cannot answer "has ANY later CLEARED happened for this eventId") and
// NOT a new state machine — written only when a CLEARED push is
// genuinely, non-duplicate accepted, read once at the top of
// processQueuedPbsEvent before any candidate/AI work for a NEW/UPDATED
// message. Same 48h TTL as transport idempotency (IDEMPOTENCY_TTL_
// SECONDS) — this marker never needs to outlive that window either.
export const PBS_EVENT_CLEARED_KV_PREFIX = 'debug:pbs-event-cleared:v1';

function buildPbsEventClearedKvKey(source, eventId) {
  return `${PBS_EVENT_CLEARED_KV_PREFIX}:${source}:${eventId}`;
}

/**
 * Best-effort, never throws — a failed write here only means a future
 * stale retry might not get cancelled (degrades to today's pre-V2.4.3
 * behavior for that one event), never a correctness hazard for anything
 * that has already happened.
 */
async function recordPbsEventCleared(kv, { source, eventId, clearedAt }) {
  if (!kv || !eventId || !clearedAt) return;
  try {
    await kv.put(buildPbsEventClearedKvKey(source, eventId), JSON.stringify({ clearedAt }), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
  } catch (err) {
    console.error(`[pbs-debug-push][cleared-marker] eventId=${eventId} failed to record CLEARED: ${err && err.message}`);
  }
}

/**
 * Fail-open on any KV outage/parse error (returns null) — a transient
 * read failure must never block a genuine NEW/UPDATED retry from
 * proceeding; it only means this round's stale-cancel optimization
 * doesn't fire for that one attempt, never that a real event gets
 * silently dropped.
 */
async function readPbsEventClearedAt(kv, source, eventId) {
  if (!kv || !eventId) return null;
  try {
    const raw = await kv.get(buildPbsEventClearedKvKey(source, eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.clearedAt === 'string' ? parsed.clearedAt : null;
  } catch {
    return null;
  }
}

/**
 * V2.2.0/V2.3.0 — a minimal "AI candidate"-shaped object built DIRECTLY
 * from the raw Windows payload's `event` fields (never from
 * normalizedEvent/candidate, which may not exist yet, or ever, for a
 * given call site). Used for both the early Observatory PROCESSING_
 * STARTED write (before anything that could throw) and a Queue Consumer's
 * own terminal-failure write (where a real candidate may never have been
 * built at all, e.g. if normalizePbsEvent itself threw). Never truncates/
 * rewrites comment/sourceDetail — RAW_PBS_TEXT_POLICY.
 */
function buildPseudoCandidateFromRawEvent(event, generatedAt) {
  return {
    road: (event && event.road) || null,
    direction: (event && event.direction) || null,
    areaNm: (event && event.areaNm) || null,
    comment: (event && event.comment) || '',
    sourceDetail: (event && event.sourceDetail) || '',
    longitude: event && typeof event.longitude === 'number' ? event.longitude : null,
    latitude: event && typeof event.latitude === 'number' ? event.latitude : null,
    generatedAt,
  };
}

/**
 * V2.2.0/V2.3.0 — the ONE place an Observatory record is built+written,
 * shared by the early PROCESSING_STARTED write (HTTP ingress), the
 * Queue Consumer's own final write, and its terminal-failure write.
 * Best-effort, isolated — never affects the real AI/LINE outcome, which
 * has already fully happened (or, for the early write, hasn't happened
 * yet) by the time this is called.
 */
async function writeObservatoryRecord(env, { candidate, eventId, lifecycle, fingerprint, now, idempotencyKeyHash, ...outcomeFields }) {
  try {
    const record = buildAiObservatoryRecord({ candidate, eventId, lifecycle, fingerprint, now, ...outcomeFields });
    await recordAiObservatoryEntry(env.TRAFFIC_KV, record, { taipeiDate: taipeiDateString(now), idempotencyKeyHash, now });
  } catch (err) {
    console.error(`[pbs-debug-push][ai-observatory] eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
  }
}

/**
 * V2.3.0 (order section 五) — the exact payload a Queue Consumer needs to
 * independently complete business processing, with zero dependency on the
 * original HTTP request. RAW_PBS_TEXT_POLICY: `event` is copied verbatim
 * (shallow clone, never re-derived/truncated/summarized) — comment/
 * sourceDetail reach the Queue Consumer, and from there the AI prompt,
 * byte-for-byte identical to what Windows sent, exactly as they already
 * did via the old ctx.waitUntil closure (this is a relocation of an
 * existing guarantee, not a new one).
 */
export function buildPbsAiQueueMessage({ source, eventId, lifecycle, fingerprint, generatedAt, event, requestId, idempotencyKeyHash, acceptedFirstAcceptedAt, acceptedAttemptCount }) {
  return {
    source,
    eventId,
    lifecycle,
    fingerprint,
    generatedAt,
    requestId,
    idempotencyKeyHash,
    acceptedFirstAcceptedAt,
    acceptedAttemptCount,
    event: event && typeof event === 'object' ? { ...event } : {},
  };
}

/**
 * V2.3.0 — the SAME candidate/AI-decision/legacy/Observatory-final logic
 * V2.1.0/V2.2.0 ran inside processAcceptedEvent's ctx.waitUntil closure,
 * relocated here and parameterized by a Queue message instead of closed
 * over the original HTTP request — REUSED, not reimplemented (order
 * section 七's own explicit instruction). Called by handlePbsAiQueueBatch
 * for every queue delivery (including redeliveries — see the idempotency
 * re-check at the top, order section 七 items 2/8 and section 九).
 *
 * @returns {Promise<{ok: boolean, retry: boolean, outcome?: string, candidate?: object, error?: string, skipped?: boolean}>}
 *   ok=true -> ack (terminal success, or already-completed skip).
 *   ok=false, retry=true -> the caller should Queue-retry (bounded).
 */
export async function processQueuedPbsEvent(env, message, now = new Date(), { aiCallTimeoutMs } = {}) {
  const { source = 'pbs', eventId, lifecycle, fingerprint, generatedAt, event, idempotencyKeyHash, requestId, acceptedFirstAcceptedAt, acceptedAttemptCount } = message || {};
  const kv = env.TRAFFIC_KV;
  const kvKey = idempotencyKeyHash ? buildIdempotencyKvKey(idempotencyKeyHash) : null;
  // KEY IDENTITY, not a business timestamp: the Observatory KV key is
  // built from (taipeiDate(now), now.getTime(), idempotencyKeyHash) — the
  // early PROCESSING_STARTED write (HTTP ingress) used the ORIGINAL
  // accept-time `now`, so the final write here MUST reuse the exact same
  // instant (reconstructed from `acceptedFirstAcceptedAt`, captured
  // verbatim in the queue message) or it would create a SECOND KV entry
  // instead of overwriting the first — see aiObservatoryIndex.js's own
  // header comment for why this must stay identical. `now` itself (the
  // real, current processing time, possibly seconds/minutes later) is
  // still used for every actual business decision below (AI call,
  // broadcast-hour gating, etc.) — only the Observatory record's own
  // `timestamp` field and storage key intentionally stay anchored to
  // accept-time, consistent with what that field has always meant
  // end-to-end in this system.
  const observatoryNow = acceptedFirstAcceptedAt ? new Date(acceptedFirstAcceptedAt) : now;

  // order section 七 items 2/8, section 九 — a redelivered (AT_LEAST_ONCE)
  // or genuinely-retried message whose earlier attempt already completed
  // must skip business processing entirely: 0 additional AI calls, 0
  // additional LINE attempts.
  if (kv && kvKey) {
    try {
      const existingRaw = await kv.get(kvKey);
      if (existingRaw) {
        let existingRecord = null;
        try {
          existingRecord = JSON.parse(existingRaw);
        } catch {
          existingRecord = null;
        }
        if (existingRecord && existingRecord.status === IDEMPOTENCY_STATUS.COMPLETED) {
          console.log(`[pbs-ai-queue] event=ALREADY_COMPLETED eventId=${eventId} lifecycle=${lifecycle}`);
          return { ok: true, retry: false, skipped: true };
        }
      }
    } catch (err) {
      // fail OPEN — proceed with processing rather than silently dropping
      // a real event because of a transient KV read hiccup.
      console.error(`[pbs-ai-queue] eventId=${eventId} idempotency re-check failed (fail open, proceeding): ${err && err.message}`);
    }
  }

  // V2.4.3 (order section 七/八) — if PBS has SINCE confirmed this same
  // eventId is CLEARED (a separate, later push — see debugPush.js's own
  // CLEARED-branch write of this marker), this NEW/UPDATED message is
  // stale: never call AI again, never push LINE, terminal ACK. Only a
  // CLEARED strictly AFTER this message's own `generatedAt` counts —
  // order section 七's own scenario (CLEARED arrives mid-retry, after the
  // NEW was originally generated) — a CLEARED from BEFORE this message
  // was generated would mean a genuinely new re-occurrence, which must
  // still be judged normally. CLEARED itself never reaches this Queue at
  // all (see the HTTP ingress handler's own CLEARED branch), so this
  // check can never accidentally cancel a CLEARED message processing
  // itself. TDX has no CLEARED lifecycle (tdxQueueIngress.js's own
  // comment) — this marker is never written for a TDX-origin eventId, so
  // this is a guaranteed no-op there.
  if (lifecycle !== 'CLEARED') {
    const clearedAt = await readPbsEventClearedAt(kv, source, eventId);
    if (clearedAt && generatedAt && new Date(clearedAt).getTime() > new Date(generatedAt).getTime()) {
      console.log(
        `[pbs-ai-queue] event=STALE_AFTER_CLEARED eventId=${eventId} lifecycle=${lifecycle} ` +
          `clearedAt=${clearedAt} messageGeneratedAt=${generatedAt} — cancelling further AI retry, 0 LINE`
      );
      await writeObservatoryRecord(env, {
        candidate: buildPseudoCandidateFromRawEvent(event, generatedAt),
        eventId,
        lifecycle,
        fingerprint,
        now: observatoryNow,
        idempotencyKeyHash,
        source,
        outcome: AI_OUTCOME.STALE_AFTER_CLEARED,
      });
      await markProcessingComplete(kv, kvKey, { firstAcceptedAt: acceptedFirstAcceptedAt, requestId, attemptCount: acceptedAttemptCount, now });
      return { ok: true, retry: false, outcome: AI_OUTCOME.STALE_AFTER_CLEARED, staleAfterCleared: true };
    }
  }

  let candidate = null;
  let observatoryOutcome;
  try {
    // V2.4.0 — order section 六's own required dispatch: TDX freeway/
    // highway messages carry an ALREADY-normalized event (tdx/sources.js's
    // own `source.normalize: (raw) => normalizeRoadEvent(raw, 'freeway'/
    // 'highway')` runs at fetch time inside scheduled.js, before the
    // message is ever built — see scheduled.js's own V2.4.0 comment) —
    // never re-normalized here, and NEVER routed through
    // buildRawPbsRecordFromPush/normalizePbsEvent, which assume Windows's
    // raw push shape (road/areaNm/comment/x1/y1) that a TDX record simply
    // isn't. PBS (source==='pbs', every existing call) is completely
    // unchanged — same two-step build+normalize as before.
    const normalizedEvent =
      source === 'freeway' || source === 'highway' ? event && typeof event === 'object' ? event : {} : normalizePbsEvent(buildRawPbsRecordFromPush({ eventId, generatedAt, event }));

    try {
      if (isWindowsPbsAiCandidateEligible(normalizedEvent)) {
        candidate = buildAiCandidate(normalizedEvent, { lifecycle, generatedAt });
        console.log(
          `[pbs-ai-queue][ai-candidate] event=AI_CANDIDATE_CREATED eventId=${eventId} lifecycle=${lifecycle} ` +
            `mode=${PBS_AI_DECISION_MODE} eventType=${candidate.eventType} ` +
            `locationQualitySufficient=${Boolean(candidate.locationQuality && candidate.locationQuality.sufficient)}`
        );
      } else {
        console.log(`[pbs-ai-queue][ai-candidate] eventId=${eventId} lifecycle=${lifecycle} mode=${PBS_AI_DECISION_MODE} candidate=false reason=outside-service-area`);
      }
    } catch (err) {
      console.error(`[pbs-ai-queue][ai-candidate] eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
    }

    if (resolvePbsAiDecisionEnabled(env)) {
      observatoryOutcome = await runAiDecisionPath(env, { candidate, normalizedEvent, eventId, lifecycle, fingerprint, now, source, aiCallTimeoutMs });
    } else if (source !== 'pbs') {
      // V2.4.0 — order section 四: LEGACY_TDX_LINE_PIPELINE =
      // RETIRED_FOR_ROADEVENT. A TDX-origin message must NEVER fall back
      // to the legacy hard-rule runLineBroadcast() below, AI-globally-
      // disabled or not — that would silently resurrect V1.5 hard-rule
      // judgment on exactly the events this whole round exists to bring
      // under the one shared AI engine (order section 六/八's own "不得
      // 建立第二套決策系統" also covers "don't let TDX fall back to a
      // THIRD, even older one"). With AI disabled, a TDX-origin event
      // simply gets no decision this delivery — logged, never queued
      // anywhere else, never silently broadcast by a different rulebook.
      console.log(
        `[pbs-ai-queue][business-pipeline] eventId=${eventId} lifecycle=${lifecycle} source=${source} ` +
          `skipped: PBS_AI_DECISION_ENABLED=false and legacy runLineBroadcast is not a valid TDX path`
      );
      observatoryOutcome = { outcome: AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH, lineAttempted: false, lineSent: false, sharedFeedPersisted: false };
    } else {
      // Reuses the EXACT SAME canonical Business Pipeline entry point
      // traffic/scheduled.js's Cron path calls for every polled TDX/PBS
      // event — never a second copy. PBS only (source==='pbs') — see the
      // branch above for why TDX never reaches this.
      const lineSummary = await runLineBroadcast(env, {
        allEvents: [normalizedEvent],
        dedupeAvailable: true,
        now,
        dryRun: false,
      });
      let sharedFeedCommitted = false;
      try {
        const sharedFeedSummary = await runSharedFeedPersist(env, { completedProducts: lineSummary.completedProducts, now });
        sharedFeedCommitted = Boolean(sharedFeedSummary.committed);
      } catch (err) {
        console.error(`[pbs-ai-queue][shared-feed] eventId=${eventId} failed: ${err && err.message}`);
      }
      console.log(
        `[pbs-ai-queue][business-pipeline] eventId=${eventId} lifecycle=${lifecycle} ` +
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
  } catch (err) {
    // A genuine failure to even reach a decision (e.g. a malformed queue
    // message, or a total KV outage during normalize/candidate build) —
    // order section 八/九: this IS "工作未可靠完成", so it's retryable,
    // bounded by the caller's own MAX_QUEUE_RETRIES check.
    console.error(`[pbs-ai-queue][business-pipeline] eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
    return { ok: false, retry: true, error: err && err.message };
  }

  // order section 八 — AI_CALL_FAILED (the call itself did not reliably
  // complete: network/5xx/capacity/timeout/binding-missing) is retryable
  // via Queue, bounded. Every OTHER outcome — including the EXISTING
  // fail-closed AI_DECISION_INVALID (the call DID complete, with an
  // invalid answer) — is terminal, exactly as V2.1.0/V2.2.0 already
  // treated it; this round does not loosen that policy.
  if (observatoryOutcome.outcome === AI_OUTCOME.AI_CALL_FAILED) {
    await writeObservatoryRecord(env, { candidate, eventId, lifecycle, fingerprint, now: observatoryNow, idempotencyKeyHash, source, ...observatoryOutcome });
    // V2.4.3 — `timedOut` forwarded so a terminal PROCESSING_FAILED write
    // (if retries later exhaust — see handlePbsAiQueueBatch) can still
    // show it was a timeout, not just "background processing failed".
    return { ok: false, retry: true, outcome: observatoryOutcome.outcome, candidate, timedOut: observatoryOutcome.timedOut === true };
  }

  await writeObservatoryRecord(env, { candidate, eventId, lifecycle, fingerprint, now: observatoryNow, idempotencyKeyHash, source, ...observatoryOutcome });
  await markProcessingComplete(kv, kvKey, { firstAcceptedAt: acceptedFirstAcceptedAt, requestId, attemptCount: acceptedAttemptCount, now: new Date() });
  // V2.4.0 — the caller (Queue consumer, and this file's own test suite)
  // gets the FULL decision outcome back, not just `outcome` — sameIncident/
  // materialChange/memoryCandidateCount/primarySource/lastNotifiedAt/
  // memoryWrite are exactly the order section 十六 observability fields,
  // and surfacing them here (instead of only inside the Observatory KV
  // record) is what lets a caller reason about a single event's result
  // without a second KV read.
  return { ok: true, retry: false, candidate, ...observatoryOutcome };
}

/**
 * V2.3.0 — the Queue Consumer entry point (src/index.js's own `queue()`
 * handler delegates here). One Worker invocation per batch; each message
 * is individually ack'd or retried — never a whole-batch retry for one
 * message's failure. `max_batch_size` is deliberately 1 in wrangler.jsonc
 * (see that file's own comment) so in practice this loop runs once per
 * invocation, but the loop itself makes no assumption about batch size.
 *
 * `aiCallTimeoutMs`/`now` (V2.4.3) — BOTH TEST-ONLY: src/index.js's real
 * `queue()` handler always calls this with 2 arguments, so Production
 * always uses aiDecisionEngine.js's own AI_CALL_TIMEOUT_MS default AND
 * the real current wall-clock instant, exactly as before this round.
 * `aiCallTimeoutMs` exists so test/*.js can exercise the real fail-fast/
 * bounded-retry/exhaustion path end to end without a real multi-second
 * wait per attempt. `now` exists so a queue-level test isn't at the mercy
 * of the real wall-clock instant the suite happens to run at (this
 * function's own business-hours/broadcast-window decision was already
 * wall-clock-real-time-coupled before this round; several existing tests
 * already accept that as pre-existing, environment-dependent flakiness —
 * this override doesn't change PRODUCTION behavior at all, it only lets a
 * NEW deterministic test choose its own instant, same idiom as every
 * other `now` parameter already threaded through this file).
 */
export async function handlePbsAiQueueBatch(batch, env, { aiCallTimeoutMs, now } = {}) {
  const resolvedNow = now || new Date();
  for (const message of batch.messages) {
    const body = message.body || {};
    const attempts = typeof message.attempts === 'number' ? message.attempts : 1;

    let result;
    try {
      result = await processQueuedPbsEvent(env, body, resolvedNow, { aiCallTimeoutMs });
    } catch (err) {
      console.error(`[pbs-ai-queue] eventId=${body.eventId} unexpected consumer error: ${err && err.message}`);
      result = { ok: false, retry: true, error: err && err.message };
    }

    if (result.ok) {
      message.ack();
      continue;
    }

    if (result.retry && attempts < MAX_QUEUE_RETRIES) {
      console.log(`[pbs-ai-queue] event=RETRY eventId=${body.eventId} lifecycle=${body.lifecycle} attempts=${attempts} outcome=${result.outcome || result.error}`);
      message.retry();
      continue;
    }

    // order section 十 — retries exhausted (or a non-retryable failure on
    // the last allowed attempt) and business processing STILL hasn't
    // reliably completed. Author the terminal state ourselves — never
    // leave this stuck at PROCESSING_STARTED/PROCESSING forever, and
    // never depend on Cloudflare's own DLQ/drop behavior (which this
    // repo does not configure) to explain what happened.
    console.error(
      `[pbs-ai-queue] event=PROCESSING_FAILED eventId=${body.eventId} lifecycle=${body.lifecycle} ` +
        `attempts=${attempts} outcome=${result.outcome || result.error} — retries exhausted, marking terminal failure`
    );
    const kv = env.TRAFFIC_KV;
    const kvKey = body.idempotencyKeyHash ? buildIdempotencyKvKey(body.idempotencyKeyHash) : null;
    const finalCandidate = result.candidate || buildPseudoCandidateFromRawEvent(body.event, body.generatedAt);
    // Same key-identity requirement as processQueuedPbsEvent's own
    // observatoryNow — reuse the ORIGINAL accept-time so this terminal
    // write overwrites the early PROCESSING_STARTED record instead of
    // creating a second entry.
    const observatoryNow = body.acceptedFirstAcceptedAt ? new Date(body.acceptedFirstAcceptedAt) : resolvedNow;
    await writeObservatoryRecord(env, {
      candidate: finalCandidate,
      eventId: body.eventId,
      lifecycle: body.lifecycle,
      fingerprint: body.fingerprint,
      now: observatoryNow,
      idempotencyKeyHash: body.idempotencyKeyHash,
      outcome: AI_OUTCOME.PROCESSING_FAILED,
      // V2.4.3 (order section 十) — carried from the LAST attempt's own
      // outcome so a fully-exhausted "all 3 attempts timed out" run is
      // still distinguishable from a generic background failure, even
      // though this terminal write is the one record that survives.
      timedOut: result.timedOut === true,
    });
    await markProcessingComplete(kv, kvKey, { firstAcceptedAt: body.acceptedFirstAcceptedAt, requestId: body.requestId, attemptCount: attempts, now: resolvedNow });
    message.ack();
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
// V2.4.0 — `source` (default 'pbs', backward-compatible with every
// existing call site) and the new Recent Incident Memory integration
// (order section 九/十/十一/十二). Reused for BOTH Windows PBS AND TDX
// freeway/highway candidates — order section 六's own explicit
// requirement ("不得建立 TDX_AI_ENGINE / PBS_AI_ENGINE 兩套 AI 決策系統")
// — this is still the ONE orchestration entry point, just now aware of
// which source called it for two purposes only: (1) which record to
// attribute a sighting to in incidentMemory.js, (2) `suppressLineNotify`
// — see below.
//
// suppressLineNotify — PHASE B/C gate. V2_4_0_PHASE_C_PRODUCTION_NOTIFY_
// IMPLEMENTATION (2026-09-01) replaced the old hardcoded `true` with the
// canonical wrangler.jsonc switch TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED
// (isTdxRoadEventProductionNotifyEnabled(env)), default "false" — see
// this round's own final report for why a config switch is now
// considered safe: the switch ships DISABLED in this same commit/deploy,
// so nothing about landing this code turns real TDX LINE delivery on.
// Reaching Phase C in Production still requires a SEPARATE, explicit
// future human authorization to flip that one var — this file no longer
// needs to be touched again to do it. Everything ELSE (AI call, cache,
// sameIncident/materialChange reasoning, Recent Incident Memory read AND
// write, Observatory logging) runs for real either way — order section
// 二十's own "觀察：AI decision / sameIncident / materialChange / Memory"
// requires the full pipeline to genuinely execute, not a stub.
async function runAiDecisionPath(env, { candidate, normalizedEvent, eventId, lifecycle, fingerprint, now, source = 'pbs', aiCallTimeoutMs }) {
  if (!candidate) {
    // Outside the service area — already logged by the caller
    // (candidate=false reason=outside-service-area). No AI call, no LINE.
    return { outcome: AI_OUTCOME.SERVICE_AREA_EXCLUDED };
  }

  // V2.4.0 — order section 九's gets<=1/event budget: exactly one read
  // here, reused for both candidate selection (below) and the eventual
  // write's own diff-against-previous (persistIncidentMemory). A KV
  // outage degrades to "no candidates this event" (fail-open toward
  // giving the AI less context, never toward blocking the event) — same
  // philosophy incidentSuppression.js already uses.
  const memoryState = await readIncidentMemory(env.TRAFFIC_KV);
  const eventLocation = deriveEventLocationForMemory(normalizedEvent);
  // Stable identity, excluded from its own candidate list — see
  // incidentMemory.js#selectMemoryCandidates's own `excludeEventId` doc
  // (never let an event discover its own just-recorded sighting as if it
  // were a separate nearby incident).
  const memoryEventId = `${source}:${eventId}`;
  const memoryCandidates = selectMemoryCandidates(memoryState.groups, eventLocation, now, { excludeEventId: memoryEventId });

  // event=AI_CALL_STARTED is logged UNCONDITIONALLY here, before the cache
  // lookup that resolveAiDecision performs internally — "started" marks
  // this decision RESOLUTION starting (order section十五's own trace
  // vocabulary), which a cache hit still resolves without ever reaching
  // Workers AI itself (see the AI_CACHE_HIT/AI_CACHE_MISS line right
  // after, which is what actually distinguishes the two).
  console.log(
    `[pbs-debug-push][ai-decision] event=AI_CALL_STARTED eventId=${eventId} lifecycle=${lifecycle} ` +
      `source=${source} memoryCandidates=${memoryCandidates.length}`
  );

  let aiResult;
  try {
    // V2.4.3 — `aiCallTimeoutMs` is TEST-ONLY plumbing (see
    // processQueuedPbsEvent/handlePbsAiQueueBatch's own comment): omitted
    // in every real call site, so resolveAiDecision falls back to its own
    // AI_CALL_TIMEOUT_MS default — zero behavior change to Production.
    aiResult = await resolveAiDecision(env, candidate, { eventId, fingerprint }, now, {
      recentIncidentContext: memoryCandidates,
      ...(aiCallTimeoutMs !== undefined ? { aiCallTimeoutMs } : {}),
    });
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
      `[pbs-debug-push][ai-decision] event=${aiResult.timedOut ? 'AI_CALL_FAILED_TIMEOUT' : aiResult.reason} eventId=${eventId} lifecycle=${lifecycle} ` +
        `detail=${aiResult.detail || ''} durationMs=${aiResult.durationMs}`
    );
    // aiResult.reason is already 'AI_CALL_FAILED' or 'AI_DECISION_INVALID'
    // — the SAME closed vocabulary AI_OUTCOME uses, never re-mapped (the
    // log line above additionally distinguishes AI_CALL_FAILED_TIMEOUT
    // for a human reading Workers Logs, but the STORED/returned `outcome`
    // stays exactly `AI_CALL_FAILED` — order section 十: observability
    // only, never a second outcome the Queue Consumer's retry check would
    // need to also recognize). `timedOut` is forwarded purely for the
    // Observatory record (order section 十's own minimal-field ask) — see
    // aiObservatoryIndex.js's own `timedOut` field.
    // V2.4.0 — memory is NOT touched here: an unvalidated/failed decision
    // has nothing trustworthy to record.
    return { outcome: aiResult.reason, cacheStatus, ...(aiResult.timedOut ? { timedOut: true } : {}) };
  }

  console.log(`[pbs-debug-push][ai-decision] event=AI_DECISION_VALID eventId=${eventId} lifecycle=${lifecycle}`);

  const { decision } = aiResult;
  console.log(
    `[pbs-debug-push][ai-decision] event=${decision.notify ? 'AI_NOTIFY_TRUE' : 'AI_NOTIFY_FALSE'} eventId=${eventId} ` +
      `lifecycle=${lifecycle} model=${PBS_AI_MODEL_ID} impact=${decision.impact} ` +
      `confidence=${decision.confidence} reason=${decision.reason} ` +
      `sameIncident=${decision.sameIncident ?? 'n/a'} materialChange=${decision.materialChange ?? 'n/a'}`
  );

  // V2.4.0 — the AI's own sameIncident verdict (against
  // memoryCandidates[0], the single MOST RECENT candidate this function
  // handed it — "保持最小化", order section 十一: the schema asks for one
  // sameIncident/materialChange pair, not a per-candidate match id, so
  // the reference candidate is deterministically "the newest one in the
  // same road+direction+proximity+8h window") decides which stored
  // record this sighting updates in place, vs. starting a new incident
  // family.
  const matchedIncidentKey = decision.sameIncident && memoryCandidates[0] ? memoryCandidates[0].incidentKey : null;

  async function persistSighting(notified) {
    const nextGroups = buildIncidentMemoryUpdate(
      memoryState.groups,
      {
        road: eventLocation.road,
        direction: eventLocation.direction,
        km: eventLocation.km,
        latitude: eventLocation.latitude,
        longitude: eventLocation.longitude,
        eventType: normalizedEvent.type,
        source,
        eventId: memoryEventId,
        rawSummary: normalizedEvent.description || normalizedEvent.title || '',
      },
      { matchedIncidentKey, notified, now }
    );
    const persistResult = await persistIncidentMemory(
      env.TRAFFIC_KV,
      nextGroups,
      { previousGroups: memoryState.groups, previousStateExisted: memoryState.existed },
      now
    );
    if (!persistResult.committed) {
      console.error(`[pbs-debug-push][incident-memory] eventId=${eventId} persist failed: ${persistResult.error}`);
    }
    // order section 十六 — SOURCE/MEMORY_CANDIDATES/SAME_INCIDENT/
    // MATERIAL_CHANGE/PRIMARY_SOURCE/LAST_NOTIFIED_AT/MEMORY_WRITE, the
    // minimal observability fields. The touched record is re-derived from
    // nextGroups (never a second KV read) — it's either the matched
    // record (if matchedIncidentKey) or the just-appended new one, always
    // the LAST entry in its own group array (buildIncidentMemoryUpdate
    // always upserts in place or pushes to the end — never reorders).
    const groupKey = incidentMemoryGroupKey(eventLocation.road, eventLocation.direction);
    const groupRecords = nextGroups[groupKey] || [];
    const touchedRecord = matchedIncidentKey
      ? groupRecords.find((r) => r.incidentKey === matchedIncidentKey)
      : groupRecords[groupRecords.length - 1];
    return {
      written: persistResult.written === true,
      primarySource: touchedRecord ? touchedRecord.primarySource : source,
      lastNotifiedAt: touchedRecord ? touchedRecord.lastNotifiedAt : null,
    };
  }

  if (!decision.notify) {
    const memoryResult = await persistSighting(false);
    return {
      outcome: AI_OUTCOME.AI_NOTIFY_FALSE,
      cacheStatus,
      source,
      memoryCandidateCount: memoryCandidates.length,
      sameIncident: decision.sameIncident,
      materialChange: decision.materialChange,
      primarySource: memoryResult.primarySource,
      lastNotifiedAt: memoryResult.lastNotifiedAt,
      memoryWrite: memoryResult.written,
      // V2.4.8 (order section 十七) — the trace page must be able to show
      // 原文→AI整理 even for a notify:false event (no LINE ever happened,
      // so there is no finalRenderedMessage to show — only ever produced
      // by the real formatEventMessage() call inside
      // runAiApprovedPbsBroadcast(), which this branch never reaches).
      cleanSummary: decision.cleanSummary,
    }; // trace only — no LINE, no CCTV, no proactive broadcast (order section 九)
  }

  // Phase B/C gate, see this function's own header comment. A TDX-origin
  // (freeway/highway) event is suppressed UNLESS the Phase C canonical
  // switch is explicitly on; PBS (source==='pbs') is never suppressed,
  // regardless of the switch — this round's own scope never touches
  // PBS's own notify path.
  const suppressLineNotify = (source === 'freeway' || source === 'highway') && !isTdxRoadEventProductionNotifyEnabled(env);

  try {
    const broadcastResult = await runAiApprovedPbsBroadcast(env, { event: normalizedEvent, now, suppressLineNotify, cleanSummary: decision.cleanSummary });
    console.log(
      `[pbs-debug-push][ai-decision] event=AI_LINE_ATTEMPTED eventId=${eventId} lifecycle=${lifecycle} ` +
        `source=${source} suppressLineNotify=${suppressLineNotify} serviceAreaEligible=${broadcastResult.serviceAreaEligible} ` +
        `lineReady=${broadcastResult.lineReady} suppressed=${broadcastResult.suppressed} ` +
        `pendingTargets=${broadcastResult.pendingTargetCount} pushAttempted=${broadcastResult.pushAttempted} ` +
        `pushSucceeded=${broadcastResult.pushSucceeded}`
    );
    const lineSent = broadcastResult.pushAttempted > 0 && broadcastResult.pushSucceeded === broadcastResult.pushAttempted;
    console.log(
      `[pbs-debug-push][ai-decision] event=${lineSent ? 'AI_LINE_SENT' : broadcastResult.pushAttempted > 0 ? 'AI_LINE_FAILED' : 'AI_LINE_NOT_ATTEMPTED'} ` +
        `eventId=${eventId} lifecycle=${lifecycle}`
    );

    // V2.4.0 — "notified" for memory bookkeeping means a REAL push
    // succeeded, not merely "AI said notify:true" — matches order section
    // 九's own primarySource/lastNotifiedAt semantics ("誰先送AI、誰先通
    // 知" is about an ACTUAL LINE delivery, not an internal verdict a
    // Phase B suppressLineNotify or a 0-pending-target/fail-closed
    // outcome never actually delivered).
    const memoryResult = await persistSighting(broadcastResult.pushSucceeded > 0);

    let sharedFeedCommitted = false;
    // V2.4.0 — Shared Feed persistence stays scoped to what actually
    // reached LINE: a suppressLineNotify=true (Phase B, TDX-origin)
    // outcome never pushed anything real, so it must never appear in the
    // Shared Feed either (order's own architecture never asked for a
    // TDX-origin Phase B "ghost" product visible downstream).
    if (!suppressLineNotify) {
      try {
        const sharedFeedSummary = await runSharedFeedPersist(env, { completedProducts: broadcastResult.completedProducts, now });
        sharedFeedCommitted = Boolean(sharedFeedSummary.committed);
      } catch (err) {
        console.error(`[pbs-debug-push][shared-feed] eventId=${eventId} failed: ${err && err.message}`);
      }
    }
    if (broadcastResult.lineErrors.length > 0) {
      console.error(`[pbs-debug-push][ai-decision] eventId=${eventId} lineErrors=${broadcastResult.lineErrors.join('; ')} sharedFeedCommitted=${sharedFeedCommitted}`);
    }
    const firstProduct = broadcastResult.completedProducts && broadcastResult.completedProducts[0];
    return {
      outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
      cacheStatus,
      source,
      memoryCandidateCount: memoryCandidates.length,
      lineAttempted: broadcastResult.pushAttempted > 0,
      lineSent,
      sharedFeedPersisted: sharedFeedCommitted,
      imageUrlPresent: Boolean(firstProduct && firstProduct.imageUrl),
      sameIncident: decision.sameIncident,
      materialChange: decision.materialChange,
      primarySource: memoryResult.primarySource,
      lastNotifiedAt: memoryResult.lastNotifiedAt,
      memoryWrite: memoryResult.written,
      suppressedForPhase: suppressLineNotify,
      // V2.4.8 (order section 十七) — 【原始本文】/【AI 整理後】/【LINE 最終
      // 內容】 for the trace page. `finalRenderedMessage` is the EXACT text
      // formatEventMessage() produced (`firstProduct.text` — see
      // aiApprovedPbsBroadcast.js's own completedProduct) — never
      // recomputed a second time, so what the trace page shows is
      // guaranteed byte-identical to what LINE actually received (when a
      // push was attempted at all; still populated even when
      // suppressLineNotify=true or 0 pending targets, since the text is
      // built regardless of whether pushLineMessages() itself ran).
      cleanSummary: decision.cleanSummary,
      finalRenderedMessage: firstProduct ? firstProduct.text : null,
    };
  } catch (err) {
    console.error(`[pbs-debug-push][ai-decision] event=AI_LINE_FAILED eventId=${eventId} lifecycle=${lifecycle} failed: ${err && err.message}`);
    const memoryResult = await persistSighting(false);
    return {
      outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
      cacheStatus,
      source,
      memoryCandidateCount: memoryCandidates.length,
      lineAttempted: true,
      lineSent: false,
      sameIncident: decision.sameIncident,
      materialChange: decision.materialChange,
      primarySource: memoryResult.primarySource,
      lastNotifiedAt: memoryResult.lastNotifiedAt,
      memoryWrite: memoryResult.written,
    };
  }
}

/**
 * GET /internal/pbs-debug-push (any non-POST method): 405, checked BEFORE
 * auth — which HTTP methods a route accepts is not sensitive information
 * (unlike whether an admin page's CONTENT exists), so this can be a plain
 * routing-level answer, same as this project's public routes.
 *
 * V2.3.0 — `ctx` is kept in the signature for backward compatibility
 * (src/index.js's fetch handler still forwards it) but is no longer used:
 * AI business processing now runs via env.PBS_AI_QUEUE, not
 * ctx.waitUntil() — order section 三's own "ctx.waitUntil() 不得再承載
 * Workers AI inference/完整AI decision flow/LINE business flow" rule.
 * queue.send() itself is awaited directly (a lightweight enqueue call,
 * never the slow AI call this round exists to get OUT of the HTTP path).
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
  // V2.3.0 — this block no longer runs AI business processing itself at
  // all (not synchronously, not via ctx.waitUntil — see this module's own
  // header comment for the real incident this retires waitUntil over).
  // It only: writes the early Observatory PROCESSING_STARTED record
  // (order section 六 step 6), then hands the event to the Cloudflare
  // Queue (step 7) and reflects a fast, honest ACK (step 8/9) — "did
  // Cloudflare durably enqueue this", never "did the AI finish deciding".
  if (!duplicate && lifecycle !== 'CLEARED') {
    await writeObservatoryRecord(env, {
      candidate: buildPseudoCandidateFromRawEvent(event, generatedAt),
      eventId,
      lifecycle,
      fingerprint,
      now,
      idempotencyKeyHash,
      outcome: AI_OUTCOME.PROCESSING_STARTED,
    });

    const queue = env[PBS_AI_QUEUE_BINDING_NAME];
    if (!queue || typeof queue.send !== 'function') {
      // Same "operator/deploy problem, fail closed" distinction as a
      // missing PBS_DEBUG_PUSH_SECRET (order section 十四 — the queue
      // resource/binding is a canonical repo-config concern, never a
      // Dashboard-only assumption) — never silently claim the event was
      // queued when it structurally could not have been.
      console.error(`[pbs-debug-push][queue] eventId=${eventId} lifecycle=${lifecycle} failed: ${PBS_AI_QUEUE_BINDING_NAME} binding missing`);
      return jsonResponse({ error: 'pbs_ai_queue_not_configured' }, 503);
    }

    const queueMessage = buildPbsAiQueueMessage({
      source,
      eventId,
      lifecycle,
      fingerprint,
      generatedAt,
      event,
      requestId,
      idempotencyKeyHash,
      acceptedFirstAcceptedAt,
      acceptedAttemptCount,
    });
    try {
      await queue.send(queueMessage);
    } catch (err) {
      // order section 六's own hard rule: must NEVER report "已成功接收並
      // 排入處理" when the enqueue itself failed. The idempotency record
      // already written above as PROCESSING recovers naturally via the
      // EXISTING V2.1.0 PROCESSING_STALE_MS window (60s) once a retry
      // lands after that — no new orphan-recovery mechanism was needed.
      console.error(`[pbs-debug-push][queue] eventId=${eventId} lifecycle=${lifecycle} send failed: ${err && err.message}`);
      return jsonResponse({ error: 'queue_send_failed' }, 503);
    }
    console.log(`[pbs-debug-push][queue] event=QUEUED eventId=${eventId} lifecycle=${lifecycle}`);
  } else if (!duplicate && lifecycle === 'CLEARED') {
    console.log(`[pbs-debug-push][business-pipeline] eventId=${eventId} lifecycle=CLEARED acknowledged=true routedToBroadcast=false`);
    // CLEARED never performs async business processing — nothing to
    // enqueue — so its own idempotency record can be marked COMPLETED
    // immediately rather than sitting at PROCESSING for no reason.
    await markProcessingComplete(kv, kvKey, { firstAcceptedAt: acceptedFirstAcceptedAt, requestId, attemptCount: acceptedAttemptCount, now });
    // V2.4.3 (order section 七/八) — record this eventId as cleared, keyed
    // by `generatedAt` (the push's OWN reported instant, not Cloudflare's
    // receipt time — consistent with how this project already trusts
    // Windows/PBS's own reported timing elsewhere). A still-retrying NEW/
    // UPDATED Queue message for the SAME eventId checks this marker
    // before its next AI attempt — see processQueuedPbsEvent's own
    // comment. Only ever written for source==='pbs' in practice (TDX has
    // no CLEARED lifecycle at all — see tdxQueueIngress.js's own
    // comment), but this is source-scoped generically, not gated, so it
    // is simply inert for any future source that never sends CLEARED.
    await recordPbsEventCleared(kv, { source, eventId, clearedAt: generatedAt });
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
