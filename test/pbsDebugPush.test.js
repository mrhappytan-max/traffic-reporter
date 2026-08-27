// V1.9.5 — POST /internal/pbs-debug-push (Windows PBS Local Monitor →
// Cloudflare, DEBUG-ONLY receiving end). Covers the order's CASE A-R plus
// the additional edge cases needed to back up the final report's PASS/
// FAIL claims: auth (missing/wrong/unconfigured secret, no fallback to
// PBS_RELAY_TOKEN), schema validation (each required field, invalid
// source/lifecycle/generatedAt, oversized body), method restriction,
// idempotency (best-effort, honestly NOT_PERSISTENT), the debug-only
// structural boundary (0 fetch calls, 0 KV calls of any kind), and secret
// non-leakage in logs/responses.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  handlePbsDebugPush,
  PBS_DEBUG_PUSH_PATH,
  PBS_DEBUG_PUSH_IDEMPOTENCY_MODE,
  resetPbsDebugPushIdempotencyState,
} from '../src/pbs/debugPush.js';

const SECRET = 'real-debug-secret-value';
const NOW = new Date('2026-08-27T10:00:00+08:00');

function countingKV() {
  const store = new Map();
  return {
    store,
    getCalls: 0,
    putCalls: 0,
    async get(key) {
      this.getCalls += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      this.putCalls += 1;
      store.set(key, value);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    PBS_DEBUG_PUSH_SECRET: SECRET,
    TRAFFIC_KV: countingKV(),
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-27T10:00:00+08:00',
    source: 'pbs',
    eventId: 'PBS-UID-1',
    lifecycle: 'NEW',
    fingerprint: 'fp-abc123def456',
    requestId: 'req-1',
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

function pushRequest({ method = 'POST', token = SECRET, body, rawBody } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  const bodyText = rawBody !== undefined ? rawBody : JSON.stringify(body ?? validPayload());
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = bodyText;
  return new Request(`https://producer.example${PBS_DEBUG_PUSH_PATH}`, init);
}

let priorFetch;
let logSpy;
let logLines;

beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected fetch: ${url}`); // any network call at all is a boundary violation
  };
  logLines = [];
  logSpy = console.log;
  console.log = (...args) => logLines.push(args.join(' '));
});

afterEach(() => {
  globalThis.fetch = priorFetch;
  console.log = logSpy;
});

// --- CASE A/B/C: valid payload, each lifecycle -----------------------------

test('CASE A: correct secret + NEW -> 200 accepted', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NEW' }) }), baseEnv(), NOW);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { ok: true, accepted: true, debugOnly: true, requestId: 'req-1', eventId: 'PBS-UID-1', lifecycle: 'NEW' });
});

test('CASE B: correct secret + UPDATED -> 200 accepted', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'UPDATED', fingerprint: 'fp-2' }) }), baseEnv(), NOW);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.accepted, true);
  assert.equal(json.lifecycle, 'UPDATED');
});

test('CASE C: correct secret + CLEARED -> 200 accepted', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'CLEARED', fingerprint: 'fp-3' }) }), baseEnv(), NOW);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.accepted, true);
  assert.equal(json.lifecycle, 'CLEARED');
});

// --- CASE D/E: auth -------------------------------------------------------

test('CASE D: no secret header -> 401', async () => {
  const res = await handlePbsDebugPush(pushRequest({ token: null }), baseEnv(), NOW);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('CASE E: wrong secret -> 401', async () => {
  const res = await handlePbsDebugPush(pushRequest({ token: 'totally-wrong' }), baseEnv(), NOW);
  assert.equal(res.status, 401);
});

test('auth: PBS_DEBUG_PUSH_SECRET not configured -> 503, fails closed', async () => {
  const res = await handlePbsDebugPush(pushRequest(), baseEnv({ PBS_DEBUG_PUSH_SECRET: undefined }), NOW);
  assert.equal(res.status, 503);
});

test('auth: does NOT fall back to PBS_RELAY_TOKEN (independent secret, no cross-reuse)', async () => {
  const env = baseEnv({ PBS_RELAY_TOKEN: 'relay-token-value' });
  const res = await handlePbsDebugPush(pushRequest({ token: 'relay-token-value' }), env, NOW);
  assert.equal(res.status, 401, 'a valid PBS_RELAY_TOKEN must NOT authenticate this endpoint');
});

test('auth: does NOT fall back to ADMIN_PASSWORD (independent secret)', async () => {
  const env = baseEnv({ ADMIN_PASSWORD: 'admin-pw-value' });
  const res = await handlePbsDebugPush(pushRequest({ token: 'admin-pw-value' }), env, NOW);
  assert.equal(res.status, 401);
});

// --- CASE F: method ---------------------------------------------------------

test('CASE F: GET -> 405', async () => {
  const res = await handlePbsDebugPush(pushRequest({ method: 'GET', token: null }), baseEnv(), NOW);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST');
});

test('method: PUT -> 405 too', async () => {
  const res = await handlePbsDebugPush(pushRequest({ method: 'PUT' }), baseEnv(), NOW);
  assert.equal(res.status, 405);
});

// --- CASE G: invalid JSON ----------------------------------------------------

test('CASE G: invalid JSON body -> 400', async () => {
  const res = await handlePbsDebugPush(pushRequest({ rawBody: '{not valid json' }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_json');
});

// --- CASE H: source != pbs ---------------------------------------------------

test('CASE H: source != "pbs" -> 400', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ source: 'tdx' }) }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_source');
});

// --- CASE I: invalid lifecycle ------------------------------------------------

test('CASE I: invalid lifecycle -> 400', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'DELETED' }) }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_lifecycle');
});

// --- CASE J/K: missing required fields ---------------------------------------

test('CASE J: missing eventId -> 400', async () => {
  const payload = validPayload();
  delete payload.eventId;
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'missing_or_empty_eventId');
});

test('CASE K: missing fingerprint -> 400', async () => {
  const payload = validPayload();
  delete payload.fingerprint;
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'missing_or_empty_fingerprint');
});

test('every required field is independently enforced (generatedAt/source/eventId/lifecycle/fingerprint/requestId)', async () => {
  for (const field of ['generatedAt', 'source', 'eventId', 'lifecycle', 'fingerprint', 'requestId']) {
    const payload = validPayload();
    delete payload[field];
    const res = await handlePbsDebugPush(pushRequest({ body: payload }), baseEnv(), NOW);
    assert.equal(res.status, 400, `missing ${field} should be rejected`);
  }
});

test('invalid (unparseable) generatedAt -> 400', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ generatedAt: 'not-a-date' }) }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_generatedAt');
});

// --- CASE L: oversized body ---------------------------------------------------

test('CASE L: oversized body -> rejected (400)', async () => {
  const oversizedComment = 'x'.repeat(32 * 1024);
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ event: { comment: oversizedComment } }) }), baseEnv(), NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'payload_too_large');
});

// --- CASE M/N: no LINE / CCTV calls -------------------------------------------

test('CASE M/N: never calls fetch (no LINE push, no CCTV enrichment) — global fetch throws if invoked', async () => {
  const res = await handlePbsDebugPush(pushRequest(), baseEnv(), NOW);
  assert.equal(res.status, 200); // if fetch had been called, the patched mock above would have thrown
});

// --- CASE O/P/Q/R: no business KV writes of any kind --------------------------

test('CASE O: never writes traffic:shared-feed', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest(), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('traffic:shared-feed')));
});

test('CASE P: never writes line:notified-state', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest(), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('line:notified-state')));
});

test('CASE Q: never writes Pipeline Trace (v1 or v2 batch keys)', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest(), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('debug:pipeline-trace')));
});

test('CASE R: zero business KV operations at all (get AND put) across NEW/UPDATED/CLEARED', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NEW' }) }), env, NOW);
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'UPDATED', fingerprint: 'fp-x' }) }), env, NOW);
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'CLEARED', fingerprint: 'fp-y' }) }), env, NOW);
  assert.equal(kv.getCalls, 0);
  assert.equal(kv.putCalls, 0);
});

// --- idempotency (best-effort, honestly NOT_PERSISTENT) ------------------------

test('idempotency: the SAME fingerprint sent twice within the window -> second response is accepted:false, duplicate:true', async () => {
  const env = baseEnv();
  const payload = validPayload({ fingerprint: 'fp-repeat', requestId: 'req-first' });
  const first = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal((await first.json()).accepted, true);

  const second = await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-second' } }), env, new Date(NOW.getTime() + 1000));
  const secondJson = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondJson.ok, true);
  assert.equal(secondJson.accepted, false);
  assert.equal(secondJson.duplicate, true);
});

test('idempotency: a DIFFERENT fingerprint is never treated as a duplicate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-a' }) }), env, NOW);
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-b', requestId: 'req-2' }) }), env, NOW);
  const json = await res.json();
  assert.equal(json.accepted, true);
});

test('idempotency: PBS_DEBUG_PUSH_IDEMPOTENCY_MODE is honestly reported as NOT_PERSISTENT', () => {
  assert.equal(PBS_DEBUG_PUSH_IDEMPOTENCY_MODE, 'NOT_PERSISTENT');
});

// --- secret never leaks --------------------------------------------------------

test('secret never appears in the Workers Logs output (auth pass or fail)', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(pushRequest(), env, NOW); // auth pass
  await handlePbsDebugPush(pushRequest({ token: 'wrong-one' }), env, NOW); // auth fail
  const combined = logLines.join('\n');
  assert.ok(!combined.includes(SECRET));
  assert.ok(!combined.includes('wrong-one'));
  assert.ok(!combined.includes('Bearer'));
});

test('secret never appears in the response body (success or any error path)', async () => {
  const env = baseEnv();
  const responses = await Promise.all([
    handlePbsDebugPush(pushRequest(), env, NOW),
    handlePbsDebugPush(pushRequest({ token: 'wrong' }), env, NOW),
    handlePbsDebugPush(pushRequest({ rawBody: 'not json' }), env, NOW),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(SECRET));
  }
});

// --- schema whitelist: extra/unexpected event fields are ignored, not required -

test('extra unrecognized fields inside event are accepted and simply ignored (not required, not rejected)', async () => {
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ event: { road: '國道一號', someFutureField: 'whatever', nested: { a: 1 } } }) }),
    baseEnv(),
    NOW
  );
  assert.equal(res.status, 200);
});

test('event field is optional entirely — a payload with no event object still validates', async () => {
  const payload = validPayload();
  delete payload.event;
  const res = await handlePbsDebugPush(pushRequest({ body: payload }), baseEnv(), NOW);
  assert.equal(res.status, 200);
});

// --- index.js routing wiring (worker.fetch, real dispatch) --------------------

test('routing: worker.fetch dispatches POST /internal/pbs-debug-push through to the handler (NOT Admin Basic Auth)', async () => {
  const res = await worker.fetch(pushRequest(), baseEnv(), NOW);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.accepted, true);
});

test('routing: worker.fetch also enforces auth/method for the real route (no bypass at the index.js level)', async () => {
  const unauthed = await worker.fetch(pushRequest({ token: null }), baseEnv(), NOW);
  assert.equal(unauthed.status, 401);
  const wrongMethod = await worker.fetch(pushRequest({ method: 'GET', token: null }), baseEnv(), NOW);
  assert.equal(wrongMethod.status, 405);
});

test('routing: a similar-but-different path still 404s (no accidental prefix match)', async () => {
  const res = await worker.fetch(
    new Request('https://producer.example/internal/pbs-debug-push-extra', { method: 'POST', body: '{}' }),
    baseEnv()
  );
  assert.equal(res.status, 404);
});
