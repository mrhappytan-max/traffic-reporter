// V2.3.0 — HTTP Ingress Is Decoupled From AI Business Processing Via
// Cloudflare Queues (order sections 二/五/六/七/十一). This file was
// originally written for V2.1.0's ctx.waitUntil()-based decoupling, which
// fixed a real Production incident where Windows's own 5-second HTTP
// timeout raced ahead of a still-running AI call. V2.1.0's fix worked, but
// exposed a SECOND, DIFFERENT real Production incident this round retires
// ctx.waitUntil() over entirely: EVENT_ID=11508290166-0 reached
// AI_CALL_STARTED successfully, but the AI call itself did not return
// before Cloudflare's own ctx.waitUntil() background-execution time budget
// (independent of Windows's HTTP timeout) expired — the platform force-
// cancelled the whole task, permanently losing the decision and leaving the
// idempotency record stuck at PROCESSING.
//
// V2.3.0's fix: HTTP ingress (handlePbsDebugPush) now only validates,
// writes the two-phase idempotency PROCESSING marker, writes the early
// Observatory PROCESSING_STARTED record, and hands the event to a
// Cloudflare Queue — Queue.send() itself has no dependency on the AI call
// ever starting, let alone finishing. A genuinely separate Queue Consumer
// invocation (handlePbsAiQueueBatch, tested in full — including bounded
// retry and the real-incident regression fixture — by the dedicated
// test/pbsAiQueueReliability.test.js) owns all AI/LINE/Observatory-final
// work and marks the record COMPLETED once it genuinely finishes.
//
// This file stays scoped to what it always was: HTTP-ingress-level
// lifecycle-separation behavior (fast ACK genuinely decoupled from
// business-processing completion, the two-phase PROCESSING/COMPLETED
// idempotency marker, PROCESSING_STALE_MS recovery, and the "never claim
// accepted:true if the event could not actually be handed off reliably"
// guarantee) — not a re-test of AI prompt/model/schema semantics
// (test/aiDecisionEngine.test.js), the legacy Business Pipeline
// (test/pbsDebugPush.test.js's own V1.9.8 section), the AI decision
// scenario matrix (test/pbsAiDecisionScenarios.test.js), or Queue retry/
// duplicate-delivery/real-incident coverage (test/pbsAiQueueReliability.
// test.js) — all untouched and unaffected by this round.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePbsDebugPush as realHandlePbsDebugPush,
  handlePbsAiQueueBatch,
  PBS_DEBUG_PUSH_PATH,
  IDEMPOTENCY_KV_PREFIX,
  IDEMPOTENCY_STATUS,
  PROCESSING_STALE_MS,
  resetPbsDebugPushIdempotencyState,
} from '../src/pbs/debugPush.js';
import { AI_OBSERVATORY_INDEX_KV_PREFIX, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';

const SECRET = 'real-debug-secret-value';
const NOW = new Date('2026-08-29T10:00:00+08:00');

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

// V2.3.0 — a self-draining fake Queue: `.send()` immediately loops the REAL
// handlePbsAiQueueBatch (including its real bounded-retry logic) against
// the just-enqueued message until acked or a 10-iteration safety valve, so
// a test that wants business processing to genuinely finish before its own
// next line runs doesn't need to hand-drive the Consumer itself. Matches
// the identical pattern already established in test/pbsDebugPush.test.js,
// test/pbsAiDecisionScenarios.test.js, test/aiObservatoryView.test.js, and
// test/pbsAiObservatoryFourLayer.test.js.
function fakeQueue(env) {
  return {
    async send(message) {
      let attempts = 0;
      for (;;) {
        attempts += 1;
        let acked = false;
        let retried = false;
        const message_ = {
          body: message,
          attempts,
          ack() {
            acked = true;
          },
          retry() {
            retried = true;
          },
        };
        await handlePbsAiQueueBatch({ messages: [message_] }, env);
        if (acked || !retried || attempts >= 10) break;
      }
    },
  };
}

// Auto-attaches the self-draining fake queue to any env that doesn't
// already supply its own PBS_AI_QUEUE — a test that wants to observe the
// genuinely-still-PROCESSING, not-yet-consumed state instead supplies its
// own non-draining "capturing" queue (see capturingQueue() below), which
// this wrapper deliberately never overrides.
async function handlePbsDebugPush(request, env, ...rest) {
  if (env && !env.PBS_AI_QUEUE) env.PBS_AI_QUEUE = fakeQueue(env);
  return realHandlePbsDebugPush(request, env, ...rest);
}

// V2.3.0 — a non-draining fake Queue: `.send()` only records the message,
// never consumes it — lets a test assert on the genuinely-still-enqueued/
// still-PROCESSING state on its own schedule, then manually drive
// handlePbsAiQueueBatch itself once ready.
function capturingQueue() {
  const messages = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    PBS_DEBUG_PUSH_SECRET: SECRET,
    TRAFFIC_KV: makeKv(),
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T10:00:00+08:00',
    source: 'pbs',
    eventId: 'PBS-BG-DEFAULT',
    lifecycle: 'NEW',
    fingerprint: 'fp-bg-default',
    requestId: 'req-bg-1',
    event: {
      road: '國道一號',
      areaNm: '國道一號北向',
      direction: '北向',
      comment: '測試事件',
      longitude: 121.0,
      latitude: 24.8,
      sourceDetail: 'test',
    },
    ...overrides,
  };
}

function pushRequest({ method = 'POST', token = SECRET, body } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  const init = { method, headers, body: JSON.stringify(body ?? validPayload()) };
  return new Request(`https://producer.example${PBS_DEBUG_PUSH_PATH}`, init);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reproduces debugPush.js's own computeIdempotencyKeyHash/
 * buildIdempotencyKvKey so a test can seed a synthetic idempotency record
 * directly — the exact input shape (`source:eventId:lifecycle:fingerprint`)
 * is documented in that module's own comment and has been stable since
 * V1.9.7. (V2.2.0 exported these directly; this file still reproduces its
 * own copy so it keeps testing the real, stable, external key shape rather
 * than silently coupling itself to the exported helper's own internals.) */
async function idempotencyKvKeyFor({ source = 'pbs', eventId, lifecycle, fingerprint }) {
  const hash = await sha256Hex(`${source}:${eventId}:${lifecycle}:${fingerprint}`);
  return `${IDEMPOTENCY_KV_PREFIX}:${hash}`;
}

let priorFetch;

beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  // Lenient by design (unlike test/pbsDebugPush.test.js's strict
  // throw-on-any-fetch): this file's own assertions target the
  // idempotency/Observatory record shape, not fetch-call policing — that
  // is already exhaustively covered by test/pbsAiDecisionScenarios.test.js
  // and test/aiApprovedPbsBroadcast.test.js, both untouched this round.
  globalThis.fetch = async () => new Response('{}', { status: 200 });
});

afterEach(() => {
  globalThis.fetch = priorFetch;
});

// --- fast ACK: the response never waits on the Queue Consumer ---------------

test('fast ACK: the HTTP response resolves once the event is durably enqueued, without waiting for the Queue Consumer (still-pending AI call) to finish', async () => {
  const kv = makeKv();
  const queue = capturingQueue();
  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_QUEUE: queue,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: {
      run: async () => {
        aiCallCount += 1;
        return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '輕微事件', confidence: 0.9 }) };
      },
    },
  });
  const payload = validPayload({ eventId: 'PBS-BG-1', fingerprint: 'fp-bg-1' });

  // This must resolve as soon as Queue.send() itself succeeds — the fake
  // queue here never consumes on its own, so if this hangs or the AI has
  // already run by this point, the fix has regressed back to awaiting
  // business processing inline.
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const json = await res.json();
  assert.equal(json.accepted, true);
  assert.equal(aiCallCount, 0, 'the AI call must not have run yet — only enqueued, never awaited, at response time');
  assert.equal(queue.messages.length, 1, 'exactly one message was handed to the Queue');

  const key = await idempotencyKvKeyFor({ eventId: 'PBS-BG-1', lifecycle: 'NEW', fingerprint: 'fp-bg-1' });
  const recordBeforeConsumption = JSON.parse(kv.store.get(key));
  assert.equal(recordBeforeConsumption.status, IDEMPOTENCY_STATUS.PROCESSING, 'business processing genuinely has not finished yet at response time');

  // Now let the Queue Consumer actually run, independently of the original
  // HTTP request/response cycle.
  const message = { body: queue.messages[0], attempts: 1, ack() {}, retry() {} };
  await handlePbsAiQueueBatch({ messages: [message] }, env);

  assert.equal(aiCallCount, 1, 'the AI call must genuinely have run to completion once the Queue Consumer processes the message');
  const recordAfterCompletion = JSON.parse(kv.store.get(key));
  assert.equal(recordAfterCompletion.status, IDEMPOTENCY_STATUS.COMPLETED, 'the Queue Consumer must mark the record COMPLETED once it genuinely finishes');
});

// --- fresh PROCESSING record: a retry while genuinely still in flight -------

test('fresh PROCESSING record: a transport retry while the original attempt is still genuinely un-consumed is deduped, never enqueued a second time', async () => {
  const kv = makeKv();
  const queue = capturingQueue();
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_QUEUE: queue,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: { run: async () => ({ response: JSON.stringify({ notify: false, impact: 'LOW', reason: 'x', confidence: 0.5 }) }) },
  });
  const payload = validPayload({ eventId: 'PBS-BG-2', fingerprint: 'fp-bg-2' });

  const res1 = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal((await res1.json()).accepted, true);
  assert.equal(queue.messages.length, 1);

  // The original message is still sitting un-consumed in the fake queue —
  // its idempotency record is therefore GUARANTEED to still read status=
  // PROCESSING, deterministic regardless of any real Queue Consumer timing.
  resetPbsDebugPushIdempotencyState(); // force the retry through the L2 KV path, not the L1 in-memory shortcut
  const res2 = await handlePbsDebugPush(
    pushRequest({ body: { ...payload, requestId: 'req-retry' } }),
    env,
    new Date(NOW.getTime() + 1000)
  );
  const json2 = await res2.json();
  assert.equal(json2.duplicate, true, 'a retry while the original attempt is still genuinely un-consumed must be deduped');
  assert.equal(queue.messages.length, 1, 'the retry must NOT have caused a second Queue.send() — only the original attempt was ever enqueued');
});

// --- stale PROCESSING record: recovery from a genuinely lost attempt --------

test('stale PROCESSING record (older than PROCESSING_STALE_MS): a retry is NOT treated as duplicate and business processing genuinely re-runs', async () => {
  const kv = makeKv();
  const eventId = 'PBS-BG-3';
  const lifecycle = 'NEW';
  const fingerprint = 'fp-bg-3';
  const key = await idempotencyKvKeyFor({ eventId, lifecycle, fingerprint });

  // Simulate an attempt whose message was genuinely never durably enqueued
  // or consumed (e.g. a lost Queue.send() whose caller crashed before
  // observing the failure) by seeding a PROCESSING record directly, older
  // than PROCESSING_STALE_MS.
  const staleFirstAcceptedAt = new Date(NOW.getTime() - (PROCESSING_STALE_MS + 5000)).toISOString();
  kv.store.set(
    key,
    JSON.stringify({ firstAcceptedAt: staleFirstAcceptedAt, requestId: 'req-lost-attempt', status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: 1 })
  );

  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: {
      run: async () => {
        aiCallCount += 1;
        return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: 'x', confidence: 0.5 }) };
      },
    },
  });
  const payload = validPayload({ eventId, lifecycle, fingerprint });
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW); // self-draining fake queue — business processing genuinely completes
  const json = await res.json();

  assert.equal(json.accepted, true, 'a retry past PROCESSING_STALE_MS must recover the lost attempt, not stay duplicate-blocked forever');
  assert.ok(!json.duplicate);
  assert.equal(aiCallCount, 1, 'business processing must genuinely re-run for a recovered stale attempt');

  const finalRecord = JSON.parse(kv.store.get(key));
  assert.equal(finalRecord.status, IDEMPOTENCY_STATUS.COMPLETED, 'the recovered attempt itself must reach COMPLETED');
  assert.equal(finalRecord.attemptCount, 2, 'attemptCount increments on a stale-recovery re-attempt, for diagnosability');
});

test('a PROCESSING record younger than PROCESSING_STALE_MS is never treated as stale (boundary sanity check)', async () => {
  const kv = makeKv();
  const eventId = 'PBS-BG-3B';
  const lifecycle = 'NEW';
  const fingerprint = 'fp-bg-3b';
  const key = await idempotencyKvKeyFor({ eventId, lifecycle, fingerprint });
  const freshFirstAcceptedAt = new Date(NOW.getTime() - Math.floor(PROCESSING_STALE_MS / 2)).toISOString();
  kv.store.set(
    key,
    JSON.stringify({ firstAcceptedAt: freshFirstAcceptedAt, requestId: 'req-still-fresh', status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: 1 })
  );

  const queue = capturingQueue();
  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_QUEUE: queue,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: { run: async () => { aiCallCount += 1; return { response: '{}' }; } },
  });
  const payload = validPayload({ eventId, lifecycle, fingerprint });
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const json = await res.json();

  assert.equal(json.duplicate, true, 'a PROCESSING record younger than PROCESSING_STALE_MS must still be treated as a genuine duplicate');
  assert.equal(aiCallCount, 0, 'must not invoke Workers AI for a still-fresh PROCESSING record');
  assert.equal(queue.messages.length, 0, 'a deduped retry must never reach Queue.send() at all');
});

// --- CLEARED: no async work, so no lingering PROCESSING state ---------------

test('CLEARED lifecycle marks its idempotency record COMPLETED immediately — nothing async to protect, so nothing left PROCESSING, and nothing enqueued', async () => {
  const kv = makeKv();
  const queue = capturingQueue();
  const env = baseEnv({ TRAFFIC_KV: kv, PBS_AI_QUEUE: queue });
  const payload = validPayload({ eventId: 'PBS-BG-4', lifecycle: 'CLEARED', fingerprint: 'fp-bg-4' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);

  const key = await idempotencyKvKeyFor({ eventId: 'PBS-BG-4', lifecycle: 'CLEARED', fingerprint: 'fp-bg-4' });
  const record = JSON.parse(kv.store.get(key));
  assert.equal(record.status, IDEMPOTENCY_STATUS.COMPLETED);
  assert.equal(queue.messages.length, 0, 'CLEARED has no async business processing, so it must never be enqueued');
});

// --- queue.send() failure must never claim accepted:true --------------------

test('Queue.send() failure returns a genuine transport failure (503), never accepted:true — order section 六\'s own hard rule', async () => {
  const kv = makeKv();
  const failingQueue = {
    async send() {
      throw new Error('simulated Queue.send() outage');
    },
  };
  const env = baseEnv({ TRAFFIC_KV: kv, PBS_AI_QUEUE: failingQueue });
  const payload = validPayload({ eventId: 'PBS-BG-5F', fingerprint: 'fp-bg-5f' });

  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal(res.status, 503, 'a genuine enqueue failure must surface as a transport failure, not a 200');
  const json = await res.json();
  assert.notEqual(json.accepted, true, 'must never report accepted:true when the event could not actually be handed off reliably');

  // The already-written PROCESSING marker recovers naturally via the
  // EXISTING PROCESSING_STALE_MS window (order section 六's own stated
  // design — no new orphan-recovery mechanism needed) — verified here only
  // as "still PROCESSING, not silently lost/duplicated", not re-testing
  // the stale-recovery mechanism itself (already covered above).
  const key = await idempotencyKvKeyFor({ eventId: 'PBS-BG-5F', lifecycle: 'NEW', fingerprint: 'fp-bg-5f' });
  const record = JSON.parse(kv.store.get(key));
  assert.equal(record.status, IDEMPOTENCY_STATUS.PROCESSING);
});

// --- Observatory outcome survives the ctx.waitUntil→Queue architecture change

test('a validated AI_NOTIFY_TRUE decision processed via the Queue Consumer still writes exactly ONE Observatory record with the real outcome (observatoryNow key-identity regression guard)', async () => {
  const kv = makeKv();
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: { run: async () => ({ response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '重大事故', confidence: 0.95 }) }) },
  });
  const payload = validPayload({ eventId: 'PBS-BG-6', fingerprint: 'fp-bg-6' });
  // Self-draining fake queue: the early PROCESSING_STARTED write (HTTP
  // ingress) and the final write (Queue Consumer, a genuinely separate
  // invocation) MUST target the identical Observatory KV key — otherwise
  // this assertion catches exactly the key-duplication bug found and fixed
  // during this round's own development (see src/pbs/debugPush.js's
  // processQueuedPbsEvent — the `observatoryNow` reconstruction).
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);

  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  assert.equal(obsKeys.length, 1, 'exactly one Observatory record for this one genuinely accepted event — the early and final writes must overwrite the same key');
  const record = JSON.parse(kv.store.get(obsKeys[0]));
  assert.equal(record.outcome, AI_OUTCOME.AI_NOTIFY_TRUE);
});

test('background-execution constants are sane values (sanity: attemptCount/PROCESSING_STALE_MS)', () => {
  assert.equal(typeof PROCESSING_STALE_MS, 'number');
  assert.ok(PROCESSING_STALE_MS >= 10_000, 'must be generous enough to never mistake a real in-flight attempt for a lost one');
  assert.ok(PROCESSING_STALE_MS <= 3 * 60 * 1000, 'must still be well under Windows\'s own ~3-minute natural re-poll interval');
  assert.deepEqual(Object.values(IDEMPOTENCY_STATUS).sort(), ['COMPLETED', 'PROCESSING']);
});
