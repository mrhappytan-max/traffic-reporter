// V1.9.5/V1.9.7 — POST /internal/pbs-debug-push (Windows PBS Local
// Monitor → Cloudflare, DEBUG-ONLY receiving end). Covers the V1.9.5
// order's CASE A-R plus the V1.9.7 order's persistent-idempotency test
// list (20 items): auth (missing/wrong/unconfigured secret, no fallback
// to PBS_RELAY_TOKEN), schema validation (each required field, invalid
// source/lifecycle/generatedAt, oversized body), method restriction,
// persistent cross-isolate/cross-restart idempotency (L1 memory + L2 KV,
// stable key composition, TTL, KV writes counted exactly), the
// debug-only structural boundary (0 fetch calls, 0 business KV writes —
// the NEW debug:pbs-push-idempotency:v1:* prefix is the one deliberate
// exception), and secret non-leakage in logs/responses.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  handlePbsDebugPush,
  PBS_DEBUG_PUSH_PATH,
  PBS_DEBUG_PUSH_IDEMPOTENCY_MODE,
  PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY,
  KV_ONLY_ATOMICITY,
  IDEMPOTENCY_KV_PREFIX,
  IDEMPOTENCY_TTL_SECONDS,
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

const REAL_CONSOLE_LOG = console.log; // for this file's OWN diagnostic prints — beforeEach patches console.log itself, so a test body's own console.log() would otherwise be swallowed into logLines too

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

test('CASE R (V1.9.7): no BUSINESS KV writes across NEW/UPDATED/CLEARED — the new debug idempotency prefix is the one deliberate exception', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NEW' }) }), env, NOW);
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'UPDATED', fingerprint: 'fp-x' }) }), env, NOW);
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'CLEARED', fingerprint: 'fp-y' }) }), env, NOW);
  const businessPrefixes = ['traffic:shared-feed', 'line:notified-state', 'line:incident-suppression-state', 'debug:pipeline-trace', 'pbs:lifecycle-state'];
  const keys = [...kv.store.keys()];
  assert.ok(keys.length > 0, 'expected the new debug idempotency prefix to have written something');
  for (const key of keys) {
    assert.ok(key.startsWith(IDEMPOTENCY_KV_PREFIX), `unexpected non-debug-prefix key written: ${key}`);
    assert.ok(!businessPrefixes.some((p) => key.startsWith(p)), `a business-prefixed key was written: ${key}`);
  }
});

// --- V1.9.7: persistent cross-isolate/cross-restart idempotency -----------------

test('1: first request for a fresh idempotency key -> accepted=true', async () => {
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-1' }) }), baseEnv(), NOW);
  const json = await res.json();
  assert.equal(json.accepted, true);
  assert.equal(json.duplicate, undefined);
});

test('2: same-isolate duplicate (same payload, second request) -> duplicate=true, resolved via L1 memory', async () => {
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

  const logLine = logLines.find((l) => l.includes('memoryHit=true'));
  assert.ok(logLine, 'expected the second (same-isolate) duplicate to be resolved via L1 memory, not a KV read');
});

test('3: simulated new isolate (memory cleared) but persistent KV store survives -> duplicate=true, resolved via L2 KV', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ fingerprint: 'fp-cross-isolate', requestId: 'req-a' });

  const first = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal((await first.json()).accepted, true);

  // Simulate a fresh isolate: L1 memory is gone, but the SAME underlying
  // KV store (the real durable layer) is reused, exactly like a real
  // Cloudflare isolate recycle would look from this module's point of view.
  resetPbsDebugPushIdempotencyState();

  const second = await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-b' } }), env, new Date(NOW.getTime() + 60_000));
  const secondJson = await second.json();
  assert.equal(secondJson.accepted, false);
  assert.equal(secondJson.duplicate, true);

  const logLine = logLines.find((l) => l.includes('persistentHit=true'));
  assert.ok(logLine, 'expected the cross-isolate duplicate to be resolved via the L2 KV layer');
});

test('4: simulated deployment restart (memory cleared, same KV namespace) -> duplicate=true', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ fingerprint: 'fp-restart', requestId: 'req-a' });

  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  resetPbsDebugPushIdempotencyState(); // a redeploy wipes every isolate's memory the same way

  const afterRestart = await handlePbsDebugPush(
    pushRequest({ body: { ...payload, requestId: 'req-after-restart' } }),
    baseEnv({ TRAFFIC_KV: kv }), // a fresh env object, same underlying KV namespace
    new Date(NOW.getTime() + 3 * 60 * 60 * 1000) // 3 hours later, well within the 48h TTL
  );
  const json = await afterRestart.json();
  assert.equal(json.accepted, false);
  assert.equal(json.duplicate, true);
});

test('5: a different fingerprint is never treated as a duplicate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-a' }) }), env, NOW);
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-b', requestId: 'req-2' }) }), env, NOW);
  const json = await res.json();
  assert.equal(json.accepted, true);
});

test('6: the SAME eventId with NEW vs UPDATED lifecycle are separate idempotency keys, both accepted', async () => {
  const env = baseEnv();
  const newRes = await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'SAME-UID', lifecycle: 'NEW', fingerprint: 'fp-n' }) }), env, NOW);
  const updatedRes = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'SAME-UID', lifecycle: 'UPDATED', fingerprint: 'fp-u', requestId: 'req-2' }) }),
    env,
    NOW
  );
  assert.equal((await newRes.json()).accepted, true);
  assert.equal((await updatedRes.json()).accepted, true, 'a different lifecycle for the same eventId must be its own key, not a duplicate');
});

test('7: the SAME eventId + UPDATED + SAME fingerprint sent twice -> duplicate', async () => {
  const env = baseEnv();
  const payload = validPayload({ eventId: 'SAME-UID-2', lifecycle: 'UPDATED', fingerprint: 'fp-same' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const res = await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-retry' } }), env, NOW);
  assert.equal((await res.json()).duplicate, true);
});

test('8: CLEARED with the same fingerprint sent twice -> duplicate', async () => {
  const env = baseEnv();
  const payload = validPayload({ eventId: 'SAME-UID-3', lifecycle: 'CLEARED', fingerprint: 'fp-cleared' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const res = await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-retry-2' } }), env, NOW);
  assert.equal((await res.json()).duplicate, true);
});

test('9: invalid auth -> 0 KV read/write', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest({ token: null }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  await handlePbsDebugPush(pushRequest({ token: 'wrong' }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.equal(kv.getCalls, 0);
  assert.equal(kv.putCalls, 0);
});

test('10: invalid payload -> 0 KV write (and 0 KV read — idempotency is computed AFTER validation)', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NOT_A_LIFECYCLE' }) }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  await handlePbsDebugPush(pushRequest({ rawBody: 'not json' }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.equal(kv.getCalls, 0);
  assert.equal(kv.putCalls, 0);
});

test('11: a duplicate request adds 0 additional KV writes', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ fingerprint: 'fp-dup-write-check' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal(kv.putCalls, 1);
  resetPbsDebugPushIdempotencyState(); // force the second request through the L2 KV path, not the L1 shortcut
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-dup' } }), env, new Date(NOW.getTime() + 1000));
  assert.equal(kv.putCalls, 1, 'a genuine duplicate must never add a second KV write');
});

test('12: a genuinely accepted event writes exactly 1 idempotency record, under the debug-only prefix', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-exactly-one' }) }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.equal(kv.putCalls, 1);
  const [key] = [...kv.store.keys()];
  assert.ok(key.startsWith(`${IDEMPOTENCY_KV_PREFIX}:`));
});

// 13/14/15/16 (LINE/CCTV/Shared-Feed/Business-KV zero side effects) are
// covered by CASE M/N above (0 fetch calls) and CASE O/P/Q/R above (0
// business-prefixed KV writes).

test('17: secret is never logged even on a persistent-idempotency-path request', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-log-check' }) }), env, NOW);
  const combined = logLines.join('\n');
  assert.ok(!combined.includes(SECRET));
});

test('18: TTL is set on every idempotency KV write, equal to the exported IDEMPOTENCY_TTL_SECONDS', async () => {
  let capturedOptions = null;
  const kv = {
    store: new Map(),
    async get(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    async put(key, value, options) {
      capturedOptions = options;
      this.store.set(key, value);
    },
  };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-ttl-check' }) }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.ok(capturedOptions, 'expected kv.put to have been called with options');
  assert.equal(capturedOptions.expirationTtl, IDEMPOTENCY_TTL_SECONDS);
  assert.equal(IDEMPOTENCY_TTL_SECONDS, 48 * 60 * 60);
});

test('19: KV prefix isolation — the idempotency key is always under IDEMPOTENCY_KV_PREFIX, never a bare eventId/fingerprint', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-UID-1', fingerprint: 'fp-prefix-check' }) }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  const [key] = [...kv.store.keys()];
  assert.ok(key.startsWith(IDEMPOTENCY_KV_PREFIX));
  assert.ok(!key.includes('PBS-UID-1'), 'the raw eventId must never appear directly in the KV key (hashed, not concatenated in the clear)');
  assert.ok(!key.includes('fp-prefix-check'), 'the raw fingerprint must never appear directly in the KV key');
});

test('20: existing Debug API response schema is unchanged (backward compatible) for both accepted and duplicate', async () => {
  const env = baseEnv();
  const payload = validPayload({ fingerprint: 'fp-schema-check' });
  const acceptedRes = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.deepEqual(await acceptedRes.json(), {
    ok: true,
    accepted: true,
    debugOnly: true,
    requestId: payload.requestId,
    eventId: payload.eventId,
    lifecycle: payload.lifecycle,
  });

  const dupRes = await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-dup-schema' } }), env, new Date(NOW.getTime() + 1000));
  assert.deepEqual(await dupRes.json(), {
    ok: true,
    accepted: false,
    duplicate: true,
    requestId: 'req-dup-schema',
    eventId: payload.eventId,
    lifecycle: payload.lifecycle,
  });
});

test('idempotency: PBS_DEBUG_PUSH_IDEMPOTENCY_MODE / PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY / KV_ONLY_ATOMICITY are honestly reported (V1.9.7)', () => {
  assert.equal(PBS_DEBUG_PUSH_IDEMPOTENCY_MODE, 'PERSISTENT_KV_PARTIAL');
  assert.equal(PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY, 'PARTIAL');
  assert.equal(KV_ONLY_ATOMICITY, 'NOT_SUFFICIENT');
});

test('KV outage on the idempotency read/write fails OPEN (event still accepted), never throws', async () => {
  const throwingKv = {
    async get() {
      throw new Error('simulated KV outage');
    },
    async put() {
      throw new Error('simulated KV outage');
    },
  };
  const res = await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-outage' }) }), baseEnv({ TRAFFIC_KV: throwingKv }), NOW);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.accepted, true);
  const logLine = logLines.find((l) => l.includes('kvOutage=true'));
  assert.ok(logLine, 'expected the outage to be visible in the log line');
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

// --- V1.9.7 KV cost quantification (order section 十) --------------------------
//
// Real measured counts against a real counting mock, never hand-estimates
// — same discipline as this project's other KV-quantification fixtures
// (see test/kvWriteQuantificationV193.test.js). The final report's own
// "10/30/100 events/day" cost table is built directly from this file's
// own console.log output.

function distinctPayloadForIndex(i) {
  return validPayload({ eventId: `PBS-COST-${i}`, fingerprint: `fp-cost-${i}`, requestId: `req-cost-${i}` });
}

for (const eventsPerDay of [10, 30, 100]) {
  test(`KV cost quantification: ${eventsPerDay} distinct accepted events/day -> measured reads/writes`, async () => {
    const kv = countingKV();
    const env = baseEnv({ TRAFFIC_KV: kv });
    for (let i = 0; i < eventsPerDay; i += 1) {
      const res = await handlePbsDebugPush(pushRequest({ body: distinctPayloadForIndex(i) }), env, NOW);
      assert.equal((await res.json()).accepted, true);
    }
    REAL_CONSOLE_LOG(`[V1.9.7 KV cost] eventsPerDay=${eventsPerDay} kvGetCalls=${kv.getCalls} kvPutCalls=${kv.putCalls}`);
    assert.equal(kv.putCalls, eventsPerDay, '1 accepted event = at most 1 write (order section 四)');
    assert.equal(kv.getCalls, eventsPerDay); // one get ("not yet seen") before each distinct accept
  });
}

test('KV cost quantification: duplicates (including repeated retries) never add extra writes', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ fingerprint: 'fp-cost-retry' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  for (let i = 0; i < 5; i += 1) {
    resetPbsDebugPushIdempotencyState(); // force each retry through the L2 KV path, not the L1 shortcut
    await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: `req-retry-${i}` } }), env, new Date(NOW.getTime() + (i + 1) * 1000));
  }
  REAL_CONSOLE_LOG(`[V1.9.7 KV cost] scenario=retries retries=5 kvGetCalls=${kv.getCalls} kvPutCalls=${kv.putCalls}`);
  assert.equal(kv.putCalls, 1, 'no number of retries for the same event may add a second write');
  assert.equal(kv.getCalls, 6); // 1 initial get (miss) + 1 get per retry (all hits)
});
