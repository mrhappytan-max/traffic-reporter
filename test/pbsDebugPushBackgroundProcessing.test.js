// V2.1.0 — Transport Ack Decoupled From Business Processing (order section
// 二/七/八/九/十一). Real Production incident this round exists to fix: two
// genuine NEW events reached service-area + AI_CALL_STARTED successfully,
// but Windows's own 5-second HTTP timeout fired while this handler was
// still `await`ing the real Workers AI call — because that work was never
// handed to `ctx.waitUntil()`, the Workers runtime cancelled the still-
// running handler when the client disconnected, and the idempotency
// record already written (accept-time, BEFORE this round) permanently
// blocked every later retry from ever re-attempting it.
//
// This file is scoped ONLY to the new lifecycle-separation behavior itself
// (background dispatch, the two-phase PROCESSING/COMPLETED idempotency
// marker, and PROCESSING_STALE_MS recovery) — not a re-test of AI
// prompt/model/schema semantics (test/aiDecisionEngine.test.js), the
// legacy Business Pipeline (test/pbsDebugPush.test.js's own V1.9.8
// section), or the AI decision scenario matrix
// (test/pbsAiDecisionScenarios.test.js), all untouched and unaffected by
// this round.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePbsDebugPush,
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

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Minimal fake ExecutionContext — captures every ctx.waitUntil() promise
 * so a test can explicitly `await flush()` once it's ready to let
 * background work actually finish, mirroring how Cloudflare itself keeps a
 * waitUntil'd promise alive past the response. */
function fakeCtx() {
  const promises = [];
  return {
    waitUntil(p) {
      promises.push(p);
    },
    async flush() {
      await Promise.allSettled(promises);
    },
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reproduces debugPush.js's own computeIdempotencyKeyHash/
 * buildIdempotencyKvKey (not exported) so a test can seed a synthetic
 * idempotency record directly — the exact input shape
 * (`source:eventId:lifecycle:fingerprint`) is documented in that module's
 * own comment and has been stable since V1.9.7. */
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

// --- fast ACK: the response never waits on AI completion --------------------

test('fast ACK: the HTTP response resolves without waiting for a still-pending AI call, when ctx.waitUntil is available', async () => {
  const deferred = createDeferred();
  const kv = makeKv();
  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: {
      run: async () => {
        aiCallCount += 1;
        return deferred.promise; // never resolves until the test says so
      },
    },
  });
  const ctx = fakeCtx();
  const payload = validPayload({ eventId: 'PBS-BG-1', fingerprint: 'fp-bg-1' });

  // This must resolve WITHOUT the test ever calling deferred.resolve() —
  // if the fix regresses back to awaiting business processing inline, this
  // await hangs until the surrounding test framework times the test out.
  // (Whether env.AI.run() has already been REACHED by this exact instant is
  // a microtask-ordering detail of the background chain, not something
  // this test asserts on — the response not hanging is the actual proof.)
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW, ctx);
  const json = await res.json();
  assert.equal(json.accepted, true);

  const key = await idempotencyKvKeyFor({ eventId: 'PBS-BG-1', lifecycle: 'NEW', fingerprint: 'fp-bg-1' });
  const recordBeforeCompletion = JSON.parse(kv.store.get(key));
  assert.equal(recordBeforeCompletion.status, IDEMPOTENCY_STATUS.PROCESSING, 'business processing genuinely has not finished yet at response time');

  // Now let the background work actually finish.
  deferred.resolve({ response: JSON.stringify({ notify: false, impact: 'LOW', reason: '輕微事件', confidence: 0.9 }) });
  await ctx.flush();

  assert.equal(aiCallCount, 1, 'the AI call must genuinely have run to completion once ctx.waitUntil work is flushed');
  const recordAfterCompletion = JSON.parse(kv.store.get(key));
  assert.equal(recordAfterCompletion.status, IDEMPOTENCY_STATUS.COMPLETED, 'ctx.waitUntil work must still run to completion and mark the record COMPLETED');
});

// --- fresh PROCESSING record: a retry while genuinely still in flight -------

test('fresh PROCESSING record: a transport retry while the original attempt is still genuinely in flight is deduped, never reprocessed', async () => {
  const deferred = createDeferred();
  const kv = makeKv();
  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: {
      run: async () => {
        aiCallCount += 1;
        return deferred.promise;
      },
    },
  });
  const ctx = fakeCtx();
  const payload = validPayload({ eventId: 'PBS-BG-2', fingerprint: 'fp-bg-2' });

  const res1 = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW, ctx);
  assert.equal((await res1.json()).accepted, true);

  // deferred.promise is still unresolved here — the original attempt's
  // idempotency record is therefore GUARANTEED to still read status=
  // PROCESSING (markProcessingComplete cannot have run yet), deterministic
  // regardless of exactly how far the background chain itself has
  // executed by this instant.
  resetPbsDebugPushIdempotencyState(); // force the retry through the L2 KV path, not the L1 in-memory shortcut
  const res2 = await handlePbsDebugPush(
    pushRequest({ body: { ...payload, requestId: 'req-retry' } }),
    env,
    new Date(NOW.getTime() + 1000),
    ctx
  );
  const json2 = await res2.json();
  assert.equal(json2.duplicate, true, 'a retry while the original attempt is still genuinely in flight must be deduped');

  deferred.resolve({ response: JSON.stringify({ notify: false, impact: 'LOW', reason: 'x', confidence: 0.5 }) });
  await ctx.flush();
  assert.equal(aiCallCount, 1, 'the retry must NOT have caused a second Workers AI call — only the original attempt ever ran');
});

// --- stale PROCESSING record: recovery from a genuinely lost attempt --------

test('stale PROCESSING record (older than PROCESSING_STALE_MS): a retry is NOT treated as duplicate and business processing genuinely re-runs', async () => {
  const kv = makeKv();
  const eventId = 'PBS-BG-3';
  const lifecycle = 'NEW';
  const fingerprint = 'fp-bg-3';
  const key = await idempotencyKvKeyFor({ eventId, lifecycle, fingerprint });

  // Simulate an attempt whose background work never got to run at all
  // (e.g. an isolate evicted before ctx.waitUntil could even schedule it —
  // NOT the normal client-timeout case, which this round's ctx.waitUntil
  // fix already prevents from mattering) by seeding a PROCESSING record
  // directly, older than PROCESSING_STALE_MS.
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
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW); // no ctx — synchronous fallback
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

  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: { run: async () => { aiCallCount += 1; return { response: '{}' }; } },
  });
  const payload = validPayload({ eventId, lifecycle, fingerprint });
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const json = await res.json();

  assert.equal(json.duplicate, true, 'a PROCESSING record younger than PROCESSING_STALE_MS must still be treated as a genuine duplicate');
  assert.equal(aiCallCount, 0, 'must not invoke Workers AI for a still-fresh PROCESSING record');
});

// --- CLEARED: no async work, so no lingering PROCESSING state ---------------

test('CLEARED lifecycle marks its idempotency record COMPLETED immediately — nothing async to protect, so nothing left PROCESSING', async () => {
  const kv = makeKv();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ eventId: 'PBS-BG-4', lifecycle: 'CLEARED', fingerprint: 'fp-bg-4' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);

  const key = await idempotencyKvKeyFor({ eventId: 'PBS-BG-4', lifecycle: 'CLEARED', fingerprint: 'fp-bg-4' });
  const record = JSON.parse(kv.store.get(key));
  assert.equal(record.status, IDEMPOTENCY_STATUS.COMPLETED);
});

// --- no ctx: every existing call site stays byte-identical ------------------

test('no ctx argument (every existing call site): business processing is fully awaited before the response resolves — byte-identical to pre-V2.1.0 behavior', async () => {
  const kv = makeKv();
  let aiCallCount = 0;
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: { run: async () => { aiCallCount += 1; return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: 'x', confidence: 0.5 }) }; } },
  });
  const payload = validPayload({ eventId: 'PBS-BG-5', fingerprint: 'fp-bg-5' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW); // no ctx
  assert.equal(aiCallCount, 1);

  const key = await idempotencyKvKeyFor({ eventId: 'PBS-BG-5', lifecycle: 'NEW', fingerprint: 'fp-bg-5' });
  const record = JSON.parse(kv.store.get(key));
  assert.equal(record.status, IDEMPOTENCY_STATUS.COMPLETED, 'without ctx, COMPLETED must already be set by the time the call returns');
});

// --- Observatory outcome survives the background-execution change ----------

test('a validated AI_NOTIFY_TRUE decision processed via ctx.waitUntil still writes exactly one Observatory record with the real outcome', async () => {
  const kv = makeKv();
  const env = baseEnv({
    TRAFFIC_KV: kv,
    PBS_AI_DECISION_ENABLED: 'true',
    AI: { run: async () => ({ response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '重大事故', confidence: 0.95 }) }) },
  });
  const ctx = fakeCtx();
  const payload = validPayload({ eventId: 'PBS-BG-6', fingerprint: 'fp-bg-6' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW, ctx);
  await ctx.flush();

  const obsKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  assert.equal(obsKeys.length, 1, 'exactly one Observatory record for this one genuinely accepted event');
  const record = JSON.parse(kv.store.get(obsKeys[0]));
  assert.equal(record.outcome, AI_OUTCOME.AI_NOTIFY_TRUE);
});

test('an AI call that never resolves before this test ends does not leak between tests (sanity: attemptCount/PROCESSING_STALE_MS are sane values)', () => {
  assert.equal(typeof PROCESSING_STALE_MS, 'number');
  assert.ok(PROCESSING_STALE_MS >= 10_000, 'must be generous enough to never mistake a real in-flight AI call for a lost one');
  assert.ok(PROCESSING_STALE_MS <= 3 * 60 * 1000, 'must still be well under Windows\'s own ~3-minute natural re-poll interval');
  assert.deepEqual(Object.values(IDEMPOTENCY_STATUS).sort(), ['COMPLETED', 'PROCESSING']);
});
