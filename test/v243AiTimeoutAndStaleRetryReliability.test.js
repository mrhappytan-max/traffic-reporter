// V2.4.3 — V2_4_3_AI_TIMEOUT_AND_STALE_RETRY_RELIABILITY_FIX. The order's
// own CASE 1-12 acceptance list (order section 十一). Exercises
// aiDecisionEngine.js's new fail-fast timeout and debugPush.js's new
// CLEARED-cancels-stale-retry check directly against processQueuedPbsEvent/
// handlePbsAiQueueBatch — same idiom as test/tdxPhaseCProductionNotify.test.js
// (hand-built Queue messages, no real HTTP round trip needed for most cases;
// CASE 5/7 use the real HTTP CLEARED-push path to exercise the marker write
// end to end).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePbsDebugPush,
  handlePbsAiQueueBatch,
  processQueuedPbsEvent,
  computeIdempotencyKeyHash,
  PBS_DEBUG_PUSH_PATH,
  resetPbsDebugPushIdempotencyState,
} from '../src/pbs/debugPush.js';
import { resolveAiDecision, AI_CALL_TIMEOUT_MS } from '../src/pbs/aiDecisionEngine.js';
import { buildAiCandidate } from '../src/pbs/aiCandidate.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { listAiObservatoryEntries, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const NOW = new Date('2026-09-01T16:15:00+08:00'); // within LINE broadcast hours
const SECRET = 'v243-test-secret';
const TINY_TIMEOUT_MS = 20; // small enough to keep the suite fast; real behavior lives in AI_CALL_TIMEOUT_MS

function countingKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    getCalls: 0,
    putCalls: 0,
    async get(key) {
      this.getCalls += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      this.putCalls += 1;
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = countingKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_DEBUG_PUSH_SECRET: SECRET, PBS_AI_DECISION_ENABLED: true, ...overrides };
}

// --- AI mocks ---------------------------------------------------------------

function verdictJson({ notify = true, impact = 'HIGH', reason = '測試', confidence = 0.9 } = {}) {
  return JSON.stringify({ notify, impact, reason, confidence });
}

/** Resolves immediately — CASE 1/10/11/12's "AI behaves normally" baseline. */
function fastAi(response = verdictJson()) {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); return { response }; } };
}

/** Never settles — the exact shape a genuinely stuck Workers AI call takes. */
function hangingAi() {
  const calls = [];
  return {
    calls,
    run(model, input) {
      calls.push({ model, input });
      return new Promise(() => {}); // never resolves, never rejects
    },
  };
}

/** Hangs on its first N calls, then resolves fast — CASE 3's own shape. */
function hangsThenSucceedsAi(hangCount, response = verdictJson()) {
  const calls = [];
  return {
    calls,
    run(model, input) {
      calls.push({ model, input });
      if (calls.length <= hangCount) return new Promise(() => {});
      return Promise.resolve({ response });
    },
  };
}

let priorFetch;
let pushCalls;
beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  pushCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      pushCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = priorFetch;
});

function pbsRawEvent(overrides = {}) {
  return {
    road: '國道三號', areaNm: '國道三號南向', direction: '南向',
    comment: '南向81.3公里處過關西多車追撞事故', longitude: 121.0, latitude: 24.7, sourceDetail: '測試來源',
    ...overrides,
  };
}

async function buildPbsQueueMessage({ eventId = 'EVT-1', lifecycle = 'NEW', fingerprint = 'fp-1', now = NOW, event = pbsRawEvent() } = {}) {
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId, lifecycle, fingerprint });
  return {
    source: 'pbs', eventId, lifecycle, fingerprint,
    generatedAt: now.toISOString(), event, requestId: `test:pbs:${eventId}`,
    idempotencyKeyHash, acceptedFirstAcceptedAt: now.toISOString(), acceptedAttemptCount: 1,
  };
}

/** One manually-driven Queue delivery attempt — mirrors the real message
 * shape handlePbsAiQueueBatch's own loop expects. `now` defaults to a
 * deterministic within-broadcast-hours instant (V2.4.3's own test-only
 * `now` override — see handlePbsAiQueueBatch's own comment for why this
 * exists: its business-hours check was already real-wall-clock-coupled
 * before this round, which would otherwise make this suite's own result
 * depend on what time of day it happens to run). */
async function runOneAttempt(env, message, attempts, aiCallTimeoutMs, now = NOW) {
  let acked = false;
  let retried = false;
  const msg = { body: message, attempts, ack: () => { acked = true; }, retry: () => { retried = true; } };
  await handlePbsAiQueueBatch({ messages: [msg] }, env, { aiCallTimeoutMs, now });
  return { acked, retried };
}

function pushRequest(body) {
  const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` });
  return new Request(`https://producer.example${PBS_DEBUG_PUSH_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// =============================================================================
// CASE 1 — AI call normal, fast success -> behavior completely unchanged.
// =============================================================================

test('CASE 1: a fast, successful AI call behaves exactly as before this round (no timedOut field)', async () => {
  const candidate = buildAiCandidate(normalizePbsEvent({ UID: 'UID-1', ...pbsRawEvent(), happendate: '2026-09-01', happentime: '16:14:50' }), {
    lifecycle: 'NEW',
    generatedAt: NOW.toISOString(),
  });
  const result = await resolveAiDecision({ AI: fastAi() }, candidate, { eventId: 'EVT-1', fingerprint: 'fp-1' }, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.decision.notify, true);
  assert.equal('timedOut' in result, false, 'timedOut must not appear at all on a normal success');
});

// =============================================================================
// CASE 2 — AI exceeds the new timeout -> fail-fast (does not wait for the
// real ~236s platform ceiling).
// =============================================================================

test('CASE 2: an AI call that never resolves fails fast at aiCallTimeoutMs, flagged timedOut:true', async () => {
  const candidate = buildAiCandidate(normalizePbsEvent({ UID: 'UID-2', ...pbsRawEvent(), happendate: '2026-09-01', happentime: '16:14:50' }), {
    lifecycle: 'NEW',
    generatedAt: NOW.toISOString(),
  });
  const startedAt = Date.now();
  const result = await resolveAiDecision({ AI: hangingAi() }, candidate, { eventId: 'EVT-2', fingerprint: 'fp-2' }, NOW, { aiCallTimeoutMs: TINY_TIMEOUT_MS });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AI_CALL_FAILED');
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 2000, `must fail fast, not wait anywhere near the real ${AI_CALL_TIMEOUT_MS}ms default (took ${elapsed}ms)`);
});

// =============================================================================
// CASE 3 — timeout, then a bounded retry succeeds normally.
// =============================================================================

test('CASE 3: attempt 1 times out, attempt 2 succeeds -> bounded retry works normally, 1 LINE push', async () => {
  const env = await baseEnv({ AI: hangsThenSucceedsAi(1) });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-3', fingerprint: 'fp-3' });

  const attempt1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(attempt1.retried, true, 'attempt 1 (timeout) must be retried, bounded');
  assert.equal(attempt1.acked, false);

  const attempt2 = await runOneAttempt(env, message, 2, TINY_TIMEOUT_MS);
  assert.equal(attempt2.acked, true, 'attempt 2 (fast success) must ack');
  assert.equal(attempt2.retried, false);
  assert.equal(env.AI.calls.length, 2);
  assert.equal(pushCalls.length, 1, 'exactly 1 real LINE push once AI genuinely succeeds');
});

// =============================================================================
// CASE 4 — continuous timeout -> final PROCESSING_FAILED, no LINE, and the
// terminal Observatory record still shows it was a timeout (order section 十).
// =============================================================================

test('CASE 4: 3 consecutive timeouts -> terminal PROCESSING_FAILED, 0 LINE, Observatory record shows timedOut:true', async () => {
  const env = await baseEnv({ AI: hangingAi() });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-4', fingerprint: 'fp-4' });

  const a1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a1.retried, true);
  const a2 = await runOneAttempt(env, message, 2, TINY_TIMEOUT_MS);
  assert.equal(a2.retried, true);
  const a3 = await runOneAttempt(env, message, 3, TINY_TIMEOUT_MS);
  // MAX_QUEUE_RETRIES=3 -> attempts=3 is the last allowed attempt; the
  // Consumer authors the terminal PROCESSING_FAILED state itself and ACKs.
  assert.equal(a3.acked, true);
  assert.equal(a3.retried, false);
  assert.equal(env.AI.calls.length, 3, 'exactly 3 AI attempts, never more (bounded, not increased to 10)');
  assert.equal(pushCalls.length, 0, 'no LINE was ever sent');

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'EVT-4' });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, AI_OUTCOME.PROCESSING_FAILED);
  assert.equal(records[0].timedOut, true, 'the terminal record must still show this was a timeout, not a generic failure');
});

// =============================================================================
// CASE 5 — attempt 1 times out; a CLEARED for the SAME eventId arrives before
// the retry -> the retry must NOT call AI again, 0 LINE, stale/cancel outcome.
// =============================================================================

test('CASE 5: CLEARED arrives mid-retry for the SAME eventId -> retry cancels, 0 further AI calls, 0 LINE', async () => {
  const env = await baseEnv({ AI: hangingAi() });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-5', fingerprint: 'fp-5', now: NOW });

  const a1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a1.retried, true);
  assert.equal(env.AI.calls.length, 1);

  // The real HTTP CLEARED-push path (exercises recordPbsEventCleared for
  // real) — generatedAt strictly AFTER the NEW message's own generatedAt.
  const clearedAt = new Date(NOW.getTime() + 6 * 60 * 1000); // +6 minutes, mid-retry
  const clearedRes = await handlePbsDebugPush(
    pushRequest({ generatedAt: clearedAt.toISOString(), source: 'pbs', eventId: 'EVT-5', lifecycle: 'CLEARED', fingerprint: 'fp-5-cleared', requestId: 'req-cleared-5', event: pbsRawEvent() }),
    env,
    clearedAt
  );
  assert.equal(clearedRes.status, 200);

  const a2 = await runOneAttempt(env, message, 2, TINY_TIMEOUT_MS);
  assert.equal(a2.acked, true, 'the stale retry must ACK, not retry again');
  assert.equal(a2.retried, false);
  assert.equal(env.AI.calls.length, 1, 'AI must NOT be called again once the event is confirmed cleared');
  assert.equal(pushCalls.length, 0);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'EVT-5' });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, AI_OUTCOME.STALE_AFTER_CLEARED);
});

// =============================================================================
// CASE 6 — attempt 1 times out; NO CLEARED arrives -> retry continues normally.
// =============================================================================

test('CASE 6: no CLEARED received -> retry continues calling AI normally', async () => {
  const env = await baseEnv({ AI: hangsThenSucceedsAi(1) });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-6', fingerprint: 'fp-6' });

  await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  const a2 = await runOneAttempt(env, message, 2, TINY_TIMEOUT_MS);
  assert.equal(a2.acked, true);
  assert.equal(env.AI.calls.length, 2, 'AI must be called again — nothing cancelled it');
  assert.equal(pushCalls.length, 1);
});

// =============================================================================
// CASE 7 — a CLEARED for a DIFFERENT eventId must never cancel this event's
// own retry.
// =============================================================================

test('CASE 7: CLEARED for a different eventId does not cancel this event\'s retry', async () => {
  const env = await baseEnv({ AI: hangsThenSucceedsAi(1) });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-7', fingerprint: 'fp-7' });

  await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);

  const clearedAt = new Date(NOW.getTime() + 6 * 60 * 1000);
  await handlePbsDebugPush(
    pushRequest({ generatedAt: clearedAt.toISOString(), source: 'pbs', eventId: 'EVT-OTHER', lifecycle: 'CLEARED', fingerprint: 'fp-other-cleared', requestId: 'req-cleared-other', event: pbsRawEvent() }),
    env,
    clearedAt
  );

  const a2 = await runOneAttempt(env, message, 2, TINY_TIMEOUT_MS);
  assert.equal(a2.acked, true);
  assert.equal(env.AI.calls.length, 2, 'EVT-7 must still be retried normally — the CLEARED was for a different event');
  assert.equal(pushCalls.length, 1);
});

// =============================================================================
// CASE 8 — Queue duplicate delivery -> effectively-once unchanged. The new
// stale-cleared check sits AFTER the existing ALREADY_COMPLETED short-circuit,
// so a genuine duplicate of an already-COMPLETED attempt is still caught
// first and never reaches AI (or the new check) at all.
// =============================================================================

test('CASE 8: a duplicate delivery of an already-COMPLETED message is still skipped before any AI/stale-check work — effectively-once unchanged', async () => {
  const env = await baseEnv({ AI: fastAi() });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-8', fingerprint: 'fp-8' });

  const a1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a1.acked, true);
  assert.equal(env.AI.calls.length, 1);
  assert.equal(pushCalls.length, 1);

  // Redelivery of the SAME message (Queue's own at-least-once semantics).
  const a2 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a2.acked, true);
  assert.equal(env.AI.calls.length, 1, '0 additional AI calls for a duplicate');
  assert.equal(pushCalls.length, 1, '0 additional LINE pushes for a duplicate');
});

// =============================================================================
// CASE 9 — AI invalid response -> existing fail-closed behavior unchanged.
// =============================================================================

test('CASE 9: an invalid AI response is still terminal fail-closed, unaffected by this round', async () => {
  const env = await baseEnv({ AI: fastAi('this is not json') });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-9', fingerprint: 'fp-9' });
  const a1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a1.acked, true, 'AI_DECISION_INVALID is terminal, not retried');
  assert.equal(a1.retried, false);
  assert.equal(pushCalls.length, 0);
  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'EVT-9' });
  assert.equal(records[0].outcome, AI_OUTCOME.AI_DECISION_INVALID);
});

// =============================================================================
// CASE 10 — a normal PBS notify=true event still pushes LINE normally.
// =============================================================================

test('CASE 10: PBS notify=true event -> 1 real LINE push, unaffected by this round', async () => {
  const env = await baseEnv({ AI: fastAi() });
  const message = await buildPbsQueueMessage({ eventId: 'EVT-10', fingerprint: 'fp-10' });
  const a1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a1.acked, true);
  assert.equal(pushCalls.length, 1);
});

// =============================================================================
// CASE 11 — a normal TDX notify=true event still pushes LINE normally, Phase
// C behavior completely unaffected by this round.
// =============================================================================

test('CASE 11: TDX freeway notify=true event -> 1 real LINE push, Phase C unchanged', async () => {
  const env = await baseEnv({ AI: fastAi(), TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED: 'true' });
  const event = normalizeRoadEvent(
    {
      EventID: 'FRW-EVT-11', EventType: '事故', Description: '南向97K處車輛事故，外側車道封閉',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Impact: { BlockedLanes: 1 },
      // V2.4.5 — service-area gate evidence; official-polygon-confirmed
      // inside 新竹市 (near 國道一號 97K).
      Positions: [{ PositionLon: 120.9686, PositionLat: 24.8066 }],
    },
    'freeway'
  );
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'freeway', eventId: event.rawId, lifecycle: 'NEW', fingerprint: 'fp-11' });
  const message = {
    source: 'freeway', eventId: event.rawId, lifecycle: 'NEW', fingerprint: 'fp-11',
    generatedAt: NOW.toISOString(), event, requestId: 'test:freeway:11',
    idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1,
  };
  const a1 = await runOneAttempt(env, message, 1, TINY_TIMEOUT_MS);
  assert.equal(a1.acked, true);
  assert.equal(pushCalls.length, 1);
});

// =============================================================================
// CASE 12 — Incident Memory / 10-minute collision / CCTV / R2 are all
// untouched by this round: a second sighting of the SAME incident is still
// correctly suppressed (near-simultaneous collision window unchanged), never
// affected by the new timeout/stale-cleared machinery.
// =============================================================================

test('CASE 12: Incident Memory + 10-minute collision suppression still work unchanged alongside the new machinery', async () => {
  const env = await baseEnv({ AI: fastAi() });
  const first = await buildPbsQueueMessage({ eventId: 'EVT-12A', fingerprint: 'fp-12a', now: NOW });
  const firstResult = await runOneAttempt(env, first, 1, TINY_TIMEOUT_MS);
  assert.equal(firstResult.acked, true);
  assert.equal(pushCalls.length, 1);

  // A near-simultaneous (within 10 minutes) second sighting of the SAME
  // real-world incident (different eventId, same road/direction/km via the
  // same comment) — the AI-approved path's own 10-minute collision window
  // (incidentSuppression.js) must still suppress it, unrelated to this round.
  const second = await buildPbsQueueMessage({ eventId: 'EVT-12B', fingerprint: 'fp-12b', now: new Date(NOW.getTime() + 3 * 60 * 1000) });
  const secondResult = await runOneAttempt(env, second, 1, TINY_TIMEOUT_MS);
  assert.equal(secondResult.acked, true);
  assert.equal(pushCalls.length, 1, 'the 10-minute collision window still suppresses the near-duplicate — unaffected by this round');
});
