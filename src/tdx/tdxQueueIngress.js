// V2.4.0 — TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE, order section
// 六/七. The ONE place a TDX freeway/highway RoadEvent, already fetched
// and classified by this tick's traffic/pipeline.js#runTdxPipelineAndCommit
// (dedupe.js#classifyEvents — new/updated/duplicate), gets handed to the
// SAME PBS_AI_QUEUE Windows PBS already uses (order section 六: "沿用
// PBS_AI_QUEUE，不新增第二條Queue"). Called only from
// traffic/scheduled.js's own Cron path — see that module's own V2.4.0
// comment for the TDX_ROADEVENT_QUEUE_INGRESS_ENABLED gate this sits
// behind.
//
// WHY A SEPARATE MODULE, NOT INLINE IN scheduled.js — this project's own
// "each module stays independently readable" convention (see
// pbs/aiCandidate.js's own precedent for duplicating a small helper
// rather than reaching across files) — scheduled.js is already a large,
// many-concern Cron orchestrator; this keeps the TDX-to-Queue mapping
// itself in one small, independently testable file.
//
// LIFECYCLE MAPPING (order section 七) — TDX has no Windows-style
// lifecycle (NEW/UPDATED/MISSING_PENDING_CLEAR/CLEARED); it only has
// dedupe.js's own new/updated/duplicate content classification. This
// module maps new->'NEW', updated->'UPDATED', and NEVER enqueues a
// duplicate event at all (the caller passes only newEvents/updatedEvents
// — a duplicate was already excluded by dedupe.js#classifyEvents before
// this module ever sees it). No CLEARED mapping exists — order's own
// "若沒有可靠CLEARED：不得猜" — TDX events that stop appearing in a future
// fetch simply stop being re-enqueued; nothing here invents a synthetic
// CLEARED transition.
//
// IDEMPOTENCY — reuses pbs/debugPush.js#computeIdempotencyKeyHash
// UNCHANGED (sha256(source:eventId:lifecycle:fingerprint), deterministic,
// no timestamp involved) — a genuinely re-seen identical TDX sighting
// would already have been classified 'duplicate' by dedupe.js and never
// reach this module at all, so natural re-delivery protection falls out
// of the SAME dedupe.js machinery this project already trusts for TDX,
// never a second/parallel idempotency scheme.

import { buildPbsAiQueueMessage, computeIdempotencyKeyHash } from '../pbs/debugPush.js';
import { computeFingerprint } from '../traffic/dedupe.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

/**
 * @param {object} env
 * @param {{newEvents?: object[], updatedEvents?: object[]}} classification -
 *   the SAME newEvents/updatedEvents arrays traffic/pipeline.js's
 *   buildSummary already exposes (dedupe.js#classifyEvents output) —
 *   never re-classified here.
 * @param {Date} now
 * @returns {Promise<{attempted:number, enqueued:number, failed:number, reason?:string}>}
 */
export async function enqueueTdxRoadEvents(env, { newEvents = [], updatedEvents = [] } = {}, now = new Date()) {
  const toEnqueue = [
    ...newEvents.map((event) => ({ event, lifecycle: 'NEW' })),
    ...updatedEvents.map((event) => ({ event, lifecycle: 'UPDATED' })),
  ];
  if (toEnqueue.length === 0) {
    return { attempted: 0, enqueued: 0, failed: 0 };
  }

  const queue = env && env.PBS_AI_QUEUE;
  if (!queue || typeof queue.send !== 'function') {
    // Same "operator/deploy problem, fail closed" distinction
    // debugPush.js's own HTTP ingress already uses for a missing Queue
    // binding — never silently claim these were enqueued.
    console.error(`[tdx-queue-ingress] PBS_AI_QUEUE binding missing — 0 of ${toEnqueue.length} TDX event(s) enqueued`);
    return { attempted: toEnqueue.length, enqueued: 0, failed: toEnqueue.length, reason: 'queue-not-configured' };
  }

  let enqueued = 0;
  let failed = 0;
  for (const { event, lifecycle } of toEnqueue) {
    const source = event.source; // 'freeway' | 'highway' — set by tdx/normalize.js#normalizeRoadEvent
    const eventId = event.rawId;
    const fingerprint = computeFingerprint(event);
    const generatedAt = now.toISOString();
    const idempotencyKeyHash = await computeIdempotencyKeyHash({ source, eventId, lifecycle, fingerprint });
    const message = buildPbsAiQueueMessage({
      source,
      eventId,
      lifecycle,
      fingerprint,
      generatedAt,
      event,
      // No real HTTP request behind a Cron-originated TDX sighting — a
      // deterministic, log-correlatable synthetic id, never read for
      // anything security-sensitive (same role requestId already plays
      // for the real Windows push path: observability only).
      requestId: `tdx-cron:${source}:${eventId}:${now.getTime()}`,
      idempotencyKeyHash,
      acceptedFirstAcceptedAt: generatedAt,
      acceptedAttemptCount: 1,
    });
    try {
      await queue.send(message);
      enqueued += 1;
    } catch (err) {
      failed += 1;
      console.error(`[tdx-queue-ingress] source=${source} eventId=${eventId} lifecycle=${lifecycle} send failed: ${safeErrorMessage(err)}`);
    }
  }

  return { attempted: toEnqueue.length, enqueued, failed };
}
