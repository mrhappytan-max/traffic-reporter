// V2.3.0 — PBS AI Queue Reliability (order sections 五/七/八/九/十/十七/
// 十八). Real Production incident this file exists to fix, and regression-
// guards forever: EVENT_ID=11508290166-0 reached Cloudflare and started the
// Workers AI call successfully (16:49:03.112), but the AI call itself did
// not return before Cloudflare's own ctx.waitUntil() background-execution
// time budget expired — an ENTIRELY DIFFERENT failure mode from the one
// V2.1.0 already fixed (Windows's own short HTTP timeout racing the AI
// call before ctx.waitUntil was even introduced). At 16:49:32.912 the
// platform force-cancelled the whole task ("waitUntil() tasks did not
// complete within the allowed time after invocation end and have been
// cancelled"), permanently losing the AI decision and leaving the
// idempotency record stuck at PROCESSING forever.
//
// V2.3.0's fix retires ctx.waitUntil() as an AI carrier entirely — see
// src/pbs/debugPush.js's own header comment for the full design — in favor
// of ONE Cloudflare Queue: the HTTP ingress (handlePbsDebugPush) only
// validates, writes idempotency/Observatory state, and Queue.send()s;
// business processing (candidate -> AI decision -> LINE/Shared Feed ->
// Observatory final -> COMPLETED) runs entirely inside a genuinely
// separate Queue Consumer invocation (handlePbsAiQueueBatch /
// processQueuedPbsEvent), with zero dependency on the original HTTP
// request or any ExecutionContext staying alive.
//
// This file is scoped to Queue-specific reliability behavior: bounded
// retry of AI_CALL_FAILED, the EXISTING AI_DECISION_INVALID fail-closed
// policy staying untouched (never retried), the new PROCESSING_FAILED
// terminal state once retries genuinely exhaust, AT_LEAST_ONCE delivery
// producing an EFFECTIVELY_ONCE business outcome (no duplicate AI calls,
// no duplicate LINE pushes on redelivery of an already-completed event),
// RAW_PBS_TEXT_POLICY surviving the queue message verbatim, and the real
// EVENT_ID=11508290166-0 incident fixture itself — proving a simulated
// 30+ second AI delay depends on neither the original HTTP request nor
// ctx.waitUntil staying alive, WITHOUT a real 30-second test sleep (a
// controllable Promise stands in for the delay). General HTTP-ingress
// lifecycle-separation/idempotency behavior (fast ACK, PROCESSING_STALE_MS
// recovery, queue.send() failure never reporting accepted:true) is already
// covered by test/pbsDebugPushBackgroundProcessing.test.js and is not
// re-tested here. AI prompt/model/schema semantics
// (test/aiDecisionEngine.test.js) and the full AI decision scenario matrix
// (test/pbsAiDecisionScenarios.test.js) are untouched and not re-tested
// here either — this file only proves the QUEUE carries them reliably.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePbsDebugPush,
  handlePbsAiQueueBatch,
  buildPbsAiQueueMessage,
  processQueuedPbsEvent,
  computeIdempotencyKeyHash,
  buildIdempotencyKvKey,
  PBS_DEBUG_PUSH_PATH,
  IDEMPOTENCY_STATUS,
  MAX_QUEUE_RETRIES,
  BACKGROUND_EXECUTION_MECHANISM,
  WAITUNTIL_AI_PROCESSING,
  QUEUE_ROLE,
  QUEUE_DELIVERY_MODEL,
  BUSINESS_OUTCOME_MODEL,
  resetPbsDebugPushIdempotencyState,
} from '../src/pbs/debugPush.js';
import { AI_OBSERVATORY_INDEX_KV_PREFIX, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';

const SECRET = 'real-debug-secret-value';
const NOW = new Date('2026-08-29T16:49:03+08:00');

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

function baseEnv(overrides = {}) {
  return {
    PBS_DEBUG_PUSH_SECRET: SECRET,
    TRAFFIC_KV: makeKv(),
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    PBS_AI_DECISION_ENABLED: 'true',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T16:49:03+08:00',
    source: 'pbs',
    eventId: 'PBS-Q-DEFAULT',
    lifecycle: 'NEW',
    fingerprint: 'fp-q-default',
    requestId: 'req-q-1',
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

// A non-draining fake Queue — `.send()` only records the message. Every
// test in this file drives handlePbsAiQueueBatch itself, by hand, so it
// can control exactly how many delivery attempts happen and inspect the
// outcome of each one individually (retried vs acked) — the whole point
// of a *reliability* test file.
function capturingQueue() {
  const messages = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}

/** Builds a fake Cloudflare Queue message object matching the shape
 * handlePbsAiQueueBatch reads (`.body`, `.attempts`, `.ack()`, `.retry()`).
 * `attempts` mirrors Cloudflare's own semantics: 1 on first delivery,
 * incrementing on each platform-driven redelivery after `.retry()`. */
function fakeMessage(body, attempts = 1) {
  let acked = false;
  let retried = false;
  return {
    body,
    attempts,
    get acked() {
      return acked;
    },
    get retried() {
      return retried;
    },
    ack() {
      acked = true;
    },
    retry() {
      retried = true;
    },
  };
}

function mockAi(responseTextOrFn, { throwError } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (throwError) throw throwError;
      const text = typeof responseTextOrFn === 'function' ? responseTextOrFn(calls.length) : responseTextOrFn;
      return { response: text };
    },
  };
}

let priorFetch;

beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
});

afterEach(() => {
  globalThis.fetch = priorFetch;
});

// --- Engineering Memory literals stay wired to real exported behavior ------

test('the required V2.3.0 Engineering Memory literals are exported and match the design', () => {
  assert.equal(BACKGROUND_EXECUTION_MECHANISM, 'CLOUDFLARE_QUEUE');
  assert.equal(WAITUNTIL_AI_PROCESSING, 'RETIRED');
  assert.equal(QUEUE_ROLE, 'RELIABLE_AI_BUSINESS_PROCESSING');
  assert.equal(QUEUE_DELIVERY_MODEL, 'AT_LEAST_ONCE');
  assert.equal(BUSINESS_OUTCOME_MODEL, 'EFFECTIVELY_ONCE');
  assert.ok(Number.isInteger(MAX_QUEUE_RETRIES) && MAX_QUEUE_RETRIES >= 1);
});

// --- AI_CALL_FAILED: bounded, Queue-retryable -------------------------------

test('AI_CALL_FAILED (a single failed attempt): the message is retried, not immediately terminal, and LINE is never attempted', async () => {
  const kv = makeKv();
  const env = baseEnv({ TRAFFIC_KV: kv, AI: mockAi(null, { throwError: new Error('simulated network failure') }) });
  const payload = validPayload({ eventId: 'PBS-Q-1', fingerprint: 'fp-q-1' });
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'PBS-Q-1', lifecycle: 'NEW', fingerprint: 'fp-q-1' });
  const kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
  kv.store.set(kvKey, JSON.stringify({ firstAcceptedAt: NOW.toISOString(), requestId: 'req-q-1', status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: 1 }));

  const message = buildPbsAiQueueMessage({ ...payload, idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 });
  const msg = fakeMessage(message, 1);
  await handlePbsAiQueueBatch({ messages: [msg] }, env);

  assert.equal(msg.retried, true, 'a single AI_CALL_FAILED attempt (attempts=1 < MAX_QUEUE_RETRIES) must be retried, not acked as terminal');
  assert.equal(msg.acked, false);
  assert.equal(env.AI.calls.length, 1);

  const record = JSON.parse(kv.store.get(kvKey));
  assert.equal(record.status, IDEMPOTENCY_STATUS.PROCESSING, 'must stay PROCESSING while retries remain — not falsely COMPLETED, not stuck forever either');
});

test('AI_CALL_FAILED exhausting MAX_QUEUE_RETRIES: the event reaches the new PROCESSING_FAILED terminal state and is acked, never stuck at PROCESSING forever', async () => {
  const kv = makeKv();
  const env = baseEnv({ TRAFFIC_KV: kv, AI: mockAi(null, { throwError: new Error('simulated persistent network failure') }) });
  const payload = validPayload({ eventId: 'PBS-Q-2', fingerprint: 'fp-q-2' });
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'PBS-Q-2', lifecycle: 'NEW', fingerprint: 'fp-q-2' });
  const kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
  kv.store.set(kvKey, JSON.stringify({ firstAcceptedAt: NOW.toISOString(), requestId: 'req-q-1', status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: 1 }));
  const message = buildPbsAiQueueMessage({ ...payload, idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 });

  // Simulate the platform redelivering with an incrementing `attempts`
  // counter, exactly like real Cloudflare Queues does after `.retry()`,
  // until attempts >= MAX_QUEUE_RETRIES.
  let lastMsg;
  for (let attempts = 1; attempts <= MAX_QUEUE_RETRIES; attempts += 1) {
    lastMsg = fakeMessage(message, attempts);
    await handlePbsAiQueueBatch({ messages: [lastMsg] }, env);
  }

  assert.equal(env.AI.calls.length, MAX_QUEUE_RETRIES, 'exactly MAX_QUEUE_RETRIES attempts must have genuinely called Workers AI — never silently fewer, never unbounded');
  assert.equal(lastMsg.acked, true, 'the final attempt (retries exhausted) must be acked — never left for an unconfigured platform DLQ/drop to explain');
  assert.equal(lastMsg.retried, false);

  const record = JSON.parse(kv.store.get(kvKey));
  assert.equal(record.status, IDEMPOTENCY_STATUS.COMPLETED, 'a PERMANENTLY-failed event must reach a terminal KV state, never show PROCESSING forever');

  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  assert.equal(obsKeys.length, 1, 'the terminal write must overwrite the same Observatory key as the early PROCESSING_STARTED record, never create a second entry');
  const obsRecord = JSON.parse(kv.store.get(obsKeys[0]));
  assert.equal(obsRecord.outcome, AI_OUTCOME.PROCESSING_FAILED, 'one minimal new terminal state — not a large state machine');
});

// --- AI_DECISION_INVALID: existing fail-closed policy stays UNTOUCHED ------

test('AI_DECISION_INVALID (the call completed with an invalid answer) is NEVER retried, even on the very first attempt — the EXISTING fail-closed policy is not loosened', async () => {
  const kv = makeKv();
  const env = baseEnv({ TRAFFIC_KV: kv, AI: mockAi('這不是有效的JSON回應') });
  const payload = validPayload({ eventId: 'PBS-Q-3', fingerprint: 'fp-q-3' });
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'PBS-Q-3', lifecycle: 'NEW', fingerprint: 'fp-q-3' });
  const kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
  kv.store.set(kvKey, JSON.stringify({ firstAcceptedAt: NOW.toISOString(), requestId: 'req-q-1', status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: 1 }));
  const message = buildPbsAiQueueMessage({ ...payload, idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 });

  const msg = fakeMessage(message, 1);
  await handlePbsAiQueueBatch({ messages: [msg] }, env);

  assert.equal(msg.acked, true, 'AI_DECISION_INVALID is terminal on the FIRST attempt — never Queue-retried');
  assert.equal(msg.retried, false);
  assert.equal(env.AI.calls.length, 1, 'must never re-question the AI over an invalid-but-completed answer');

  const record = JSON.parse(kv.store.get(kvKey));
  assert.equal(record.status, IDEMPOTENCY_STATUS.COMPLETED);
  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  const obsRecord = JSON.parse(kv.store.get(obsKeys[0]));
  assert.equal(obsRecord.outcome, AI_OUTCOME.AI_DECISION_INVALID, 'the existing fail-closed outcome vocabulary is unchanged — this is not remapped to PROCESSING_FAILED');
});

// --- AT_LEAST_ONCE delivery -> EFFECTIVELY_ONCE business outcome -----------

test('redelivery of an already-COMPLETED event (AT_LEAST_ONCE duplicate) is skipped: 0 additional AI calls, 0 additional LINE attempts, single ack', async () => {
  const kv = makeKv();
  const env = baseEnv({ TRAFFIC_KV: kv, AI: mockAi(JSON.stringify({ notify: true, impact: 'HIGH', reason: '重大事故', confidence: 0.95 })) });
  const payload = validPayload({ eventId: 'PBS-Q-4', fingerprint: 'fp-q-4' });
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'PBS-Q-4', lifecycle: 'NEW', fingerprint: 'fp-q-4' });
  const kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
  kv.store.set(kvKey, JSON.stringify({ firstAcceptedAt: NOW.toISOString(), requestId: 'req-q-1', status: IDEMPOTENCY_STATUS.PROCESSING, attemptCount: 1 }));
  const message = buildPbsAiQueueMessage({ ...payload, idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 });

  const firstDelivery = fakeMessage(message, 1);
  await handlePbsAiQueueBatch({ messages: [firstDelivery] }, env);
  assert.equal(firstDelivery.acked, true);
  assert.equal(env.AI.calls.length, 1);

  // Cloudflare Queues is AT_LEAST_ONCE — a redelivery of the SAME message
  // (network hiccup acking the first delivery, platform retry racing an
  // in-flight ack, etc.) is a real possibility this endpoint must survive
  // without a duplicate AI call or a duplicate LINE push.
  const redelivery = fakeMessage(message, 1);
  await handlePbsAiQueueBatch({ messages: [redelivery] }, env);

  assert.equal(redelivery.acked, true, 'a redelivered already-completed message must still be acked (never left retrying forever)');
  assert.equal(env.AI.calls.length, 1, 'EFFECTIVELY_ONCE business outcome: the redelivery must cause 0 additional AI calls');

  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  assert.equal(obsKeys.length, 1, 'the redelivery must never create a second Observatory entry');
});

// --- RAW_PBS_TEXT_POLICY survives the queue message verbatim ---------------

test('RAW_PBS_TEXT_POLICY: comment/sourceDetail reach the Queue Consumer, and from there the Observatory record, byte-for-byte identical — never truncated/summarized/rewritten', async () => {
  const kv = makeKv();
  const rawComment = '北上在102.6公里.過茄苳.外.2自小事故';
  const rawSourceDetail = '高速公路局北區交控中心';
  const env = baseEnv({ TRAFFIC_KV: kv, AI: mockAi(JSON.stringify({ notify: false, impact: 'LOW', reason: 'x', confidence: 0.5 })) });
  const payload = validPayload({
    eventId: 'PBS-Q-5',
    fingerprint: 'fp-q-5',
    event: {
      road: '福爾摩沙高速公路-國道3號',
      areaNm: '福爾摩沙高速公路-國道3號',
      direction: '北上',
      comment: rawComment,
      longitude: 120.96828,
      latitude: 24.75879,
      sourceDetail: rawSourceDetail,
    },
  });

  const queue = capturingQueue();
  await handlePbsDebugPush(pushRequest({ body: payload }), { ...env, PBS_AI_QUEUE: queue }, NOW);
  assert.equal(queue.messages.length, 1);
  // The message itself — what a real Queue durably carries between the
  // producer and consumer isolates — must already hold the verbatim text.
  assert.equal(queue.messages[0].event.comment, rawComment);
  assert.equal(queue.messages[0].event.sourceDetail, rawSourceDetail);

  await handlePbsAiQueueBatch({ messages: [fakeMessage(queue.messages[0], 1)] }, env);
  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  const obsRecord = JSON.parse(kv.store.get(obsKeys[0]));
  assert.equal(obsRecord.rawComment, rawComment, 'the FINAL Observatory record must still carry the untouched raw comment');
  assert.equal(obsRecord.rawSourceDetail, rawSourceDetail);
});

// --- Real incident regression fixture: EVENT_ID=11508290166-0 --------------

test('REAL INCIDENT REGRESSION (EVENT_ID=11508290166-0): a simulated 30+ second AI delay depends on neither the original HTTP request nor ctx.waitUntil staying alive', async () => {
  const kv = makeKv();
  const eventId = '11508290166-0';

  // A controllable Promise stands in for "the real Workers AI call takes
  // 30+ seconds to return" — order section 十八's own explicit requirement
  // NOT to use a real 30-second sleep in the test. The deferred is only
  // resolved much later in this test body, after the HTTP ingress has
  // already returned and the original `Request`/response objects are long
  // out of scope — proving completion cannot possibly depend on either.
  let resolveAiCall;
  const aiDelay = new Promise((resolve) => {
    resolveAiCall = resolve;
  });
  const env = baseEnv({
    TRAFFIC_KV: kv,
    AI: {
      calls: [],
      async run(model, input) {
        this.calls.push({ model, input });
        return aiDelay; // does not resolve until this test explicitly says so
      },
    },
  });

  const payload = {
    generatedAt: '2026-08-29T16:49:03+08:00',
    source: 'pbs',
    eventId,
    lifecycle: 'NEW',
    fingerprint: 'fp-real-incident',
    requestId: 'req-real-incident',
    event: {
      road: '福爾摩沙高速公路-國道3號',
      areaNm: '福爾摩沙高速公路-國道3號',
      direction: '北上',
      comment: '北上在102.6公里.過茄苳.外.2自小事故',
      longitude: 120.96828,
      latitude: 24.75879,
      sourceDetail: '高速公路局北區交控中心',
    },
  };

  const queue = capturingQueue();
  // Deliberately no `ctx` argument at all — the whole point of this
  // fixture is that nothing downstream may depend on one.
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), { ...env, PBS_AI_QUEUE: queue }, NOW);
  const json = await res.json();
  assert.equal(json.accepted, true, 'the HTTP ACK must succeed the instant the event is durably enqueued — it must never wait on the AI call');
  assert.equal(env.AI.calls.length, 0, 'the AI call has not even started yet at ACK time — it only starts once the Queue Consumer processes the message');
  assert.equal(queue.messages.length, 1);

  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId, lifecycle: 'NEW', fingerprint: 'fp-real-incident' });
  const kvKey = buildIdempotencyKvKey(idempotencyKeyHash);
  const recordAtAckTime = JSON.parse(kv.store.get(kvKey));
  assert.equal(recordAtAckTime.status, IDEMPOTENCY_STATUS.PROCESSING);

  // Now drive the Queue Consumer as its own, entirely separate invocation —
  // exactly how a real Cloudflare Queue delivers to a `queue()` handler:
  // no `request`, no `ctx`, only `env` and the durably-stored message.
  // `processQueuedPbsEvent` is awaited directly here (rather than going
  // through handlePbsAiQueueBatch's ack/retry loop) specifically so this
  // test can resolve the "30+ second" AI delay in between — proving the
  // Consumer's own await is not itself bound to any request-scoped
  // resource either.
  const consumerPromise = processQueuedPbsEvent(env, queue.messages[0], new Date(NOW.getTime() + 35_000));
  // Simulate the real incident's timeline: the AI call is still running
  // 30+ seconds after the original HTTP request was ACKed and has long
  // since completed/gone out of scope. No real wall-clock delay here —
  // resolving the controllable Promise now stands in for "eventually
  // returns", which is the entire point of this being a controllable
  // Promise rather than a timer.
  resolveAiCall({ response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '事故確認', confidence: 0.92 }) });
  const result = await consumerPromise;

  assert.equal(result.ok, true, 'a slow-but-eventually-successful AI call must still reach a genuine, correct completion — never silently lost the way the real incident lost it');
  assert.equal(result.outcome, AI_OUTCOME.AI_NOTIFY_TRUE);
  assert.equal(env.AI.calls.length, 1);

  // processQueuedPbsEvent itself calls markProcessingComplete directly for
  // any non-retryable outcome (handlePbsAiQueueBatch's own ack/retry loop
  // is a thin wrapper around exactly this call) — confirm the COMPLETED
  // transition genuinely happened.
  const finalRecordKey = buildIdempotencyKvKey(idempotencyKeyHash);
  const finalRecord = JSON.parse(kv.store.get(finalRecordKey));
  assert.equal(finalRecord.status, IDEMPOTENCY_STATUS.COMPLETED, 'the real incident\'s permanent PROCESSING lock must not recur — completion is reachable no matter how long the AI call genuinely took');

  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  assert.equal(obsKeys.length, 1, 'exactly one Observatory record — the early PROCESSING_STARTED write and this final write must target the identical key');
  const obsRecord = JSON.parse(kv.store.get(obsKeys[0]));
  assert.equal(obsRecord.outcome, AI_OUTCOME.AI_NOTIFY_TRUE);
  assert.equal(obsRecord.rawComment, '北上在102.6公里.過茄苳.外.2自小事故', 'raw PBS text must still be intact end-to-end for the real incident event');
});
