// V1.9.5/V1.9.7/V1.9.8 — POST /internal/pbs-debug-push (Windows PBS Local
// Monitor → Cloudflare). Covers the V1.9.5 order's CASE A-R, the V1.9.7
// order's persistent-idempotency test list (20 items), and the V1.9.8
// order's 15-item Business Pipeline integration list (section 十): auth
// (missing/wrong/unconfigured secret, no fallback to PBS_RELAY_TOKEN),
// schema validation (each required field, invalid source/lifecycle/
// generatedAt, oversized body), method restriction, persistent
// cross-isolate/cross-restart idempotency (L1 memory + L2 KV, stable key
// composition, TTL, KV writes counted exactly), secret non-leakage in
// logs/responses, and — new in V1.9.8 — a genuinely accepted (non-
// duplicate) NEW/UPDATED event now reaching the SAME canonical Business
// Pipeline (runLineBroadcast/Shared Feed) the polling path always used,
// while a duplicate or a CLEARED push still touches NONE of it. The old
// V1.9.5/V1.9.7 "0 business KV writes, 0 fetch calls, EVER" claim is
// updated accordingly below — see the "V1.9.8 Business Pipeline
// integration" section near the bottom of this file for the honest,
// current boundary.

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
  WINDOWS_PBS_PRODUCTION_INGRESS,
  PRODUCTION_BUSINESS_PIPELINE_INTEGRATION,
  resetPbsDebugPushIdempotencyState,
} from '../src/pbs/debugPush.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

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

// --- CASE M/N: no LINE / CCTV calls for an INELIGIBLE event -------------------
//
// V1.9.8: the DEFAULT payload's event.comment ('測試事件') carries no
// accident/impact keyword, so it's classified type:'other' and rejected by
// broadcastRules.js's V1.5 whitelist before ever reaching a push target or
// CCTV attempt — even though the Business Pipeline itself IS now invoked
// (see the CASE O/R2 tests above). "0 fetch calls" is therefore still the
// correct, meaningful assertion for THIS fixture. See the dedicated V1.9.8
// section below for a fixture that DOES become eligible and DOES push.

test('CASE M/N: an ineligible default-payload event never calls fetch (no LINE push, no CCTV enrichment) — global fetch throws if invoked', async () => {
  const res = await handlePbsDebugPush(pushRequest(), baseEnv(), NOW);
  assert.equal(res.status, 200); // if fetch had been called, the patched mock above would have thrown
});

// --- CASE O/P/Q/R (V1.9.5/V1.9.7 baseline, UPDATED for V1.9.8) ----------------
//
// V1.9.8 deliberately LIFTS the old "0 business KV writes, ever" claim for a
// genuinely accepted (non-duplicate) NEW/UPDATED event — see this file's own
// "V1.9.8 Business Pipeline integration" section further down for the tests
// that prove the NEW, correct boundary. CASE O/P/Q/R below are kept using
// the DEFAULT payload (event.comment='測試事件' — no accident/impact keyword,
// so it never becomes broadcast-ELIGIBLE at all: classifyPbsEvent gives it
// type:'other' with no matching anomaly keyword, so broadcastRules.js's V1.5
// whitelist rejects it before any push target/CCTV/notified-state work is
// even attempted) specifically so they can still assert "0 fetch calls" and
// "0 notified-state/Pipeline-Trace writes" meaningfully — those two
// invariants hold REGARDLESS of eligibility, because they only ever fire
// after/for a REAL push attempt, which a rejected-at-the-gate event never
// reaches.

test('CASE O (UPDATED V1.9.8): an INELIGIBLE default-payload NEW push still writes traffic:shared-feed once (Shared Feed reuse establishes/updates the key even for a 0-product run) — see the dedicated V1.9.8 Shared Feed test below for a REAL product', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest(), baseEnv({ TRAFFIC_KV: kv }), NOW);
  // V1.9.8: runSharedFeedPersist is now reached (order section 四's Shared
  // Feed reuse) even for a 0-eligible-event push — it establishes the key
  // with an empty event list, same first-write behavior scheduled.js's own
  // Cron path always had on its very first-ever tick.
  assert.ok([...kv.store.keys()].some((k) => k.startsWith('traffic:shared-feed')), 'expected the canonical Shared Feed reuse to have run');
});

test('CASE P: an INELIGIBLE default-payload push still writes 0 line:notified-state (only a REAL successful push ever writes this key)', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest(), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('line:notified-state')));
});

test('CASE Q: never writes Pipeline Trace (v1 or v2 batch keys) — deliberately out of scope for V1.9.8, this endpoint never calls persistPipelineTraceBatch', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest(), baseEnv({ TRAFFIC_KV: kv }), NOW);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('debug:pipeline-trace')));
});

test('CASE R (V1.9.7, UNCHANGED by V1.9.8): a DUPLICATE request never touches ANY business-prefixed KV key beyond what the original accepted request already wrote', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ lifecycle: 'NEW', fingerprint: 'fp-r-dup' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const keysAfterFirst = new Set(kv.store.keys());
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-r-dup-2' } }), env, new Date(NOW.getTime() + 1000));
  const keysAfterDuplicate = new Set(kv.store.keys());
  assert.deepEqual(keysAfterDuplicate, keysAfterFirst, 'a duplicate must add ZERO new KV keys of any kind — 0 second Business Pipeline pass');
});

test('CASE R2 (V1.9.8): a CLEARED push still writes ONLY the debug idempotency prefix — never reaches the Business Pipeline at all', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'CLEARED', fingerprint: 'fp-cleared-boundary' }) }), env, NOW);
  const businessPrefixes = ['traffic:shared-feed', 'line:notified-state', 'line:incident-suppression-state', 'debug:pipeline-trace', 'pbs:lifecycle-state'];
  const keys = [...kv.store.keys()];
  assert.ok(keys.length > 0, 'expected the debug idempotency prefix to have written something');
  for (const key of keys) {
    assert.ok(key.startsWith(IDEMPOTENCY_KV_PREFIX), `unexpected non-debug-prefix key written for a CLEARED push: ${key}`);
    assert.ok(!businessPrefixes.some((p) => key.startsWith(p)), `a business-prefixed key was written for a CLEARED push: ${key}`);
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

test('11: a duplicate request adds 0 additional KV writes (V1.9.8: compared against whatever the first accepted request — idempotency + Business Pipeline — already wrote, not a hardcoded 1)', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ fingerprint: 'fp-dup-write-check' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const putsAfterFirst = kv.putCalls;
  assert.ok(putsAfterFirst >= 1);
  resetPbsDebugPushIdempotencyState(); // force the second request through the L2 KV path, not the L1 shortcut
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-dup' } }), env, new Date(NOW.getTime() + 1000));
  assert.equal(kv.putCalls, putsAfterFirst, 'a genuine duplicate must never add a second KV write of any kind');
});

test('12: a genuinely accepted event writes exactly 1 idempotency record, under the debug-only prefix (V1.9.8: other business-prefixed writes may ALSO occur — this only counts the idempotency prefix)', async () => {
  const kv = countingKV();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-exactly-one' }) }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  const idempotencyKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${IDEMPOTENCY_KV_PREFIX}:`));
  assert.equal(idempotencyKeys.length, 1);
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

test('18: TTL is set on every idempotency KV write, equal to the exported IDEMPOTENCY_TTL_SECONDS (V1.9.8: captured by KEY prefix, since other business writes may also occur and must not carry this TTL)', async () => {
  const capturedOptionsByKey = new Map();
  const kv = {
    store: new Map(),
    async get(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    async put(key, value, options) {
      capturedOptionsByKey.set(key, options);
      this.store.set(key, value);
    },
  };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ fingerprint: 'fp-ttl-check' }) }), baseEnv({ TRAFFIC_KV: kv }), NOW);
  const idempotencyKey = [...capturedOptionsByKey.keys()].find((k) => k.startsWith(`${IDEMPOTENCY_KV_PREFIX}:`));
  assert.ok(idempotencyKey, 'expected the idempotency-prefixed key to have been put');
  const capturedOptions = capturedOptionsByKey.get(idempotencyKey);
  assert.ok(capturedOptions, 'expected kv.put to have been called with options for the idempotency key');
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

// --- V1.9.7/V1.9.8 KV cost quantification (order section 十/十一) --------------
//
// Real measured counts against a real counting mock, never hand-estimates
// — same discipline as this project's other KV-quantification fixtures
// (see test/kvWriteQuantificationV193.test.js). The final report's own
// "10/30/100 events/day" cost table is built directly from this file's
// own console.log output.
//
// V1.9.8 CHANGES THIS PROFILE, honestly: V1.9.7's "1 accepted event = at
// most 1 write" was true only while this endpoint was debug-only. Now a
// genuinely accepted event ALSO invokes the real canonical Business
// Pipeline (runLineBroadcast + runSharedFeedPersist) — reading
// subscriptions/notified-state/incident-suppression-state/shared-feed (4
// gets) every time, and — for a run of otherwise-identical/ineligible
// events, as this fixture deliberately uses (matching CASE M/N/O/P's own
// "0-broadcast-relevant" default payload) — writing
// line:incident-suppression-state and traffic:shared-feed EXACTLY ONCE
// each for the WHOLE run (both are WRITE_ON_CHANGE: content stabilizes to
// "empty" after the very first event establishes the key, so every
// following event's own write attempt is skipped). Measured exactly via
// this same mock, not guessed:
//   N accepted events -> gets = 5*N, puts = N + 2 (idempotency=N, plus
//   ONE incident-suppression-state write and ONE shared-feed write for
//   the whole run). A run with real, broadcast-ELIGIBLE events (not this
//   fixture) would additionally write line:notified-state and
//   debug:broadcast-provenance:v1:* per successful push — see the
//   dedicated V1.9.8 (9)/(12) tests below for that shape.

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
    REAL_CONSOLE_LOG(`[V1.9.8 KV cost] eventsPerDay=${eventsPerDay} kvGetCalls=${kv.getCalls} kvPutCalls=${kv.putCalls}`);
    // V1.9.8 measured shape (0-broadcast-relevant fixture, see comment above):
    assert.equal(kv.putCalls, eventsPerDay + 2, 'N idempotency writes + 1 incident-suppression-state + 1 shared-feed (both WRITE_ON_CHANGE, once per run)');
    assert.equal(kv.getCalls, eventsPerDay * 5, 'N idempotency reads + 4*N Business Pipeline reads (subscriptions/notified-state/incident-suppression/shared-feed)');
  });
}

// ============================================================================
// V1.9.8 — Business Pipeline integration (order section 十, the 15-item
// minimum targeted test list). Fixtures below reuse validPayload()'s own
// road/areaNm/direction/coordinates (國道一號, 24.8/121.0 — already inside
// HSINCHU_BOUNDING_BOX per traffic/hsinchuConfig.js, confirmed via
// isPbsEventHsinchuRelevant's coordinate fallback) and only vary `comment`
// (drives classifyPbsEvent's type) and event.longitude/latitude (drives
// service-area eligibility) between fixtures.
// ============================================================================

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00'); // well before NOW, clears the enabledAt backfill guard

/** [{type:'text','image'}, ...] LINE push body captor — same convention as
 * test/broadcastPipeline.test.js's own mockLinePushFetch(). */
function mockLinePushFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

function accidentComment() {
  return '國道一號北向94公里處發生追撞事故，車道回堵'; // matches ACCIDENT_PATTERNS (追撞) + an impact keyword (回堵) — type:'accident'
}

function controlOnlyComment() {
  return '國道一號北向94公里處實施交通管制'; // matches CONTROL_PATTERNS (交通管制) but not any ACCIDENT_PATTERNS — type:'control'
}

// V1.9.8 — validPayload()'s own top-level spread REPLACES `event` wholesale
// on override (it is not a deep merge), so every fixture below that needs a
// specific comment/coordinates while staying inside the service area must
// restate the FULL event object, not just the field it's varying. This
// helper is the one place that full default shape lives.
function fullEventFields(overrides = {}) {
  return {
    road: '國道一號',
    areaNm: '國道一號北向',
    direction: '北向',
    comment: accidentComment(),
    longitude: 121.0,
    latitude: 24.8,
    sourceDetail: 'test',
    ...overrides,
  };
}

const OUT_OF_AREA_COORDS = { longitude: 121.71801, latitude: 25.10288 }; // 八堵 (基隆) — outside HSINCHU_BOUNDING_BOX (lat > 24.85)

test('V1.9.8 (1): valid Windows NEW -> Business Pipeline is invoked (log line present)', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NEW', fingerprint: 'fp-v198-1' }) }), env, NOW);
  assert.ok(logLines.some((l) => l.includes('[pbs-debug-push][business-pipeline]') && l.includes('lifecycle=NEW')));
});

test('V1.9.8 (2): valid Windows UPDATED -> Business Pipeline is invoked (log line present)', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'UPDATED', fingerprint: 'fp-v198-2' }) }), env, NOW);
  assert.ok(logLines.some((l) => l.includes('[pbs-debug-push][business-pipeline]') && l.includes('lifecycle=UPDATED')));
});

test('V1.9.8 (3): valid confirmed CLEARED -> acknowledged, but NEVER routed to the Business Pipeline/broadcast', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ lifecycle: 'CLEARED', fingerprint: 'fp-v198-3', event: { comment: '北向93公里處已排除' } }) }),
    env,
    NOW
  );
  const line = logLines.find((l) => l.includes('[pbs-debug-push][business-pipeline]') && l.includes('lifecycle=CLEARED'));
  assert.ok(line, 'expected a CLEARED acknowledgement log line');
  assert.ok(line.includes('routedToBroadcast=false'));
});

test('V1.9.8 (4): a duplicate request never invokes the Business Pipeline a second time (0 second log line)', async () => {
  const env = baseEnv();
  const payload = validPayload({ lifecycle: 'NEW', fingerprint: 'fp-v198-4' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  logLines.length = 0; // reset capture — only care about the SECOND (duplicate) request now
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-v198-4-dup' } }), env, new Date(NOW.getTime() + 1000));
  assert.ok(!logLines.some((l) => l.includes('[pbs-debug-push][business-pipeline]')), 'a duplicate must not invoke the Business Pipeline at all');
});

// (5) invalid auth -> reject: see CASE D/E above. (6) invalid payload ->
// reject: see CASE G/H/I/J/K above. Both already prove 0 KV touches at all
// (tests 9/10 in the V1.9.7 section), which also means 0 Business Pipeline
// invocation — confirmed directly here too:
test('V1.9.8 (5/6): invalid auth / invalid payload never invoke the Business Pipeline', async () => {
  await handlePbsDebugPush(pushRequest({ token: null }), baseEnv(), NOW);
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NOT_A_LIFECYCLE' }) }), baseEnv(), NOW);
  assert.ok(!logLines.some((l) => l.includes('[pbs-debug-push][business-pipeline]')));
});

test('V1.9.8 (7): out-of-service-area event -> Business Pipeline runs, but 0 LINE push (service area gate, same canonical gate as polling)', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ lifecycle: 'NEW', fingerprint: 'fp-v198-7', event: fullEventFields(OUT_OF_AREA_COORDS) }) }),
    env,
    NOW
  );
  assert.equal(res.status, 200); // fetch mock still throws-on-call (beforeEach default) — 0 fetch calls proves 0 push
  const line = logLines.find((l) => l.includes('[pbs-debug-push][business-pipeline]'));
  assert.ok(line);
  assert.ok(line.includes('pushSucceeded=0'));
});

test('V1.9.8 (8): meets the V1.5 whitelist but not the formal MAJOR_ACCIDENT_ONLY LINE policy (type:control, not accident) -> 0 LINE', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ lifecycle: 'NEW', fingerprint: 'fp-v198-8', event: fullEventFields({ comment: controlOnlyComment() }) }) }),
    env,
    NOW
  );
  assert.equal(res.status, 200); // fetch mock still throws-on-call — 0 fetch calls proves 0 push
  const line = logLines.find((l) => l.includes('[pbs-debug-push][business-pipeline]'));
  assert.ok(line);
  assert.ok(line.includes('pushSucceeded=0'));
});

test('V1.9.8 (9): meets the formal LINE policy (real accident, subscribed target, within broadcast hours) -> LINE exactly once', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  const mockFetch = mockLinePushFetch();
  globalThis.fetch = mockFetch;
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-UID-1', lifecycle: 'NEW', fingerprint: 'fp-v198-9', event: fullEventFields() }) }),
    env,
    NOW
  );
  assert.equal(res.status, 200);
  assert.equal(mockFetch.calls.length, 1, 'expected exactly 1 LINE push API call');
  assert.equal(mockFetch.calls[0].url, 'https://api.line.me/v2/bot/message/push');
  const line = logLines.find((l) => l.includes('[pbs-debug-push][business-pipeline]'));
  assert.ok(line.includes('pushSucceeded=1'));
});

test('V1.9.8 (10): a duplicate of an already-pushed accident adds ZERO additional LINE pushes', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  const mockFetch = mockLinePushFetch();
  globalThis.fetch = mockFetch;
  const payload = validPayload({ eventId: 'PBS-UID-DUP', lifecycle: 'NEW', fingerprint: 'fp-v198-10', event: fullEventFields() });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal(mockFetch.calls.length, 1);
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-v198-10-dup' } }), env, new Date(NOW.getTime() + 1000));
  assert.equal(mockFetch.calls.length, 1, 'a duplicate Windows push must add 0 additional LINE pushes');
});

test('V1.9.8 (11): the Business Pipeline reuses the CANONICAL notified-state key scheme (source:rawId), never a Windows-specific parallel key', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  globalThis.fetch = mockLinePushFetch();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-UID-CANON', lifecycle: 'NEW', fingerprint: 'fp-v198-11', event: fullEventFields() }) }),
    env,
    NOW
  );
  const raw = kv.store.get('line:notified-state');
  assert.ok(raw, 'expected notified.js\'s own canonical KV key to have been written by the SAME function polling used');
  const parsed = JSON.parse(raw);
  const notifiedKeys = Object.keys(parsed.notified || parsed.events || parsed);
  assert.ok(notifiedKeys.some((k) => k === 'pbs:PBS-UID-CANON'), `expected the canonical "pbs:<rawId>" key scheme, got: ${notifiedKeys.join(',')}`);
});

test('V1.9.8 (12): Shared Feed behavior normal — a real accepted accident appears in traffic:shared-feed via the SAME runSharedFeedPersist reuse', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  globalThis.fetch = mockLinePushFetch();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-UID-FEED', lifecycle: 'NEW', fingerprint: 'fp-v198-12', event: fullEventFields() }) }),
    env,
    NOW
  );
  const raw = kv.store.get('traffic:shared-feed');
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  const events = parsed.events || parsed;
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'pbs:PBS-UID-FEED');
});

test('V1.9.8 (13): CCTV eligibility still uses the canonical (fail-safe) gate — no CCTV metadata cache seeded -> push still succeeds text-only, no crash', async () => {
  const kv = countingKV(); // no freeway CCTV metadata cache key seeded at all
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  const mockFetch = mockLinePushFetch();
  globalThis.fetch = mockFetch;
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-UID-CCTV', lifecycle: 'NEW', fingerprint: 'fp-v198-13', event: fullEventFields() }) }),
    env,
    NOW
  );
  assert.equal(res.status, 200);
  assert.equal(mockFetch.calls.length, 1);
  assert.equal(mockFetch.calls[0].body.messages.length, 1, 'no CCTV metadata cache available -> text-only, same canonical fail-safe behavior as the polling path');
  assert.equal(mockFetch.calls[0].body.messages[0].type, 'text');
});

// (14) retired PBS polling no longer fetches PBS, and (15) non-PBS Cron
// functionality stays normal: see the dedicated
// test/pbsPollingRetirementV198.test.js file — kept separate because it
// exercises traffic/scheduled.js's runScheduledTdxSync, not this endpoint.

test('V1.9.8: WINDOWS_PBS_PRODUCTION_INGRESS / PRODUCTION_BUSINESS_PIPELINE_INTEGRATION status constants are honestly reported', () => {
  assert.equal(WINDOWS_PBS_PRODUCTION_INGRESS, 'ACTIVE');
  assert.equal(PRODUCTION_BUSINESS_PIPELINE_INTEGRATION, 'ACTIVE');
});

test('KV cost quantification: duplicates (including repeated retries) never add extra writes', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  const payload = validPayload({ fingerprint: 'fp-cost-retry' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const putsAfterFirst = kv.putCalls; // V1.9.8: idempotency(1) + incident-suppression-state(1) + shared-feed(1) = 3, for this 0-relevant fixture
  for (let i = 0; i < 5; i += 1) {
    resetPbsDebugPushIdempotencyState(); // force each retry through the L2 KV path, not the L1 shortcut
    await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: `req-retry-${i}` } }), env, new Date(NOW.getTime() + (i + 1) * 1000));
  }
  REAL_CONSOLE_LOG(`[V1.9.8 KV cost] scenario=retries retries=5 kvGetCalls=${kv.getCalls} kvPutCalls=${kv.putCalls}`);
  assert.equal(kv.putCalls, putsAfterFirst, 'no number of retries for the same event may add ANY additional write — 0 second Business Pipeline pass');
  assert.equal(kv.getCalls, 5 + 5, '1 first-accept scan (idempotency get + 4 Business Pipeline reads) + 1 idempotency get per duplicate retry (a duplicate never re-reads business state)');
});

// ============================================================================
// V1.9.9 Phase 2 — AI-ready Business Pipeline Simplification (order section
// 十, the 15-item minimum targeted test list). Fixtures reuse the V1.9.8
// section's own fullEventFields()/accidentComment()/OUT_OF_AREA_COORDS/
// mockLinePushFetch()/ENROLLED_AT helpers above.
// ============================================================================

function constructionComment() {
  return '國道一號北向94公里處進行道路工程施工'; // matches CONSTRUCTION_PATTERNS (道路工程/施工) — type:'construction'
}

function closureComment() {
  return '國道一號北向94公里處全線封閉'; // matches CONTROL_PATTERNS (封閉) only — PBS classify.js has no distinct 'closure' type; this is PBS's own "road closure" shape, type:'control'
}

function congestionComment() {
  return '國道一號北向94公里處車多壅塞'; // matches CONGESTION_PATTERNS — type:'congestion'
}

function otherComment() {
  return '國道一號北向路況異常告警'; // matches no CLASSIFICATION_RULES pattern — falls to type:'other'
}

function aiCandidateLogLines(lines, eventId) {
  return lines.filter((l) => l.includes('[pbs-debug-push][ai-candidate]') && l.includes(`eventId=${eventId}`));
}

test('V1.9.9 (1): a NEW non-accident-type event still becomes an AI candidate — not eliminated before the candidate is built', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-1', lifecycle: 'NEW', fingerprint: 'fp-v199-1', event: fullEventFields({ comment: otherComment() }) }) }),
    env,
    NOW
  );
  const lines = aiCandidateLogLines(logLines, 'PBS-V199-1');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('eventType=other'));
  assert.ok(lines[0].includes(`mode=${'PREPARED_NOT_ACTIVE'}`));
});

test('V1.9.9 (2): a traffic control event becomes an AI candidate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-2', lifecycle: 'NEW', fingerprint: 'fp-v199-2', event: fullEventFields({ comment: closureComment() }) }) }),
    env,
    NOW
  );
  const lines = aiCandidateLogLines(logLines, 'PBS-V199-2');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('eventType=control'));
});

test('V1.9.9 (3): a construction event becomes an AI candidate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-3', lifecycle: 'NEW', fingerprint: 'fp-v199-3', event: fullEventFields({ comment: constructionComment() }) }) }),
    env,
    NOW
  );
  const lines = aiCandidateLogLines(logLines, 'PBS-V199-3');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('eventType=construction'));
});

test('V1.9.9 (4): an accident event becomes an AI candidate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-4', lifecycle: 'NEW', fingerprint: 'fp-v199-4', event: fullEventFields({ comment: accidentComment() }) }) }),
    env,
    NOW
  );
  const lines = aiCandidateLogLines(logLines, 'PBS-V199-4');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('eventType=accident'));
});

test('V1.9.9 (5): a "road closure" style event (PBS classifies it as control — no distinct closure type exists) becomes an AI candidate, and a congestion event does too', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-5A', lifecycle: 'NEW', fingerprint: 'fp-v199-5a', event: fullEventFields({ comment: closureComment() }) }) }),
    env,
    NOW
  );
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-5B', lifecycle: 'NEW', fingerprint: 'fp-v199-5b', event: fullEventFields({ comment: congestionComment() }) }) }),
    env,
    NOW
  );
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-5A').length, 1);
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-5B').length, 1);
});

test('V1.9.9 (6): an in-service-area event with imperfect location quality (no KM marker) is NOT hard-rejected before becoming a candidate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({
      body: validPayload({
        eventId: 'PBS-V199-6',
        lifecycle: 'NEW',
        fingerprint: 'fp-v199-6',
        event: fullEventFields({ comment: '國道一號北向發生追撞事故' }), // no KM marker in the comment
      }),
    }),
    env,
    NOW
  );
  const lines = aiCandidateLogLines(logLines, 'PBS-V199-6');
  assert.equal(lines.length, 1, 'expected a candidate to be built regardless of location-quality precision');
});

test('V1.9.9 (7): out-of-service-area event still does not become a candidate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({
      body: validPayload({
        eventId: 'PBS-V199-7',
        lifecycle: 'NEW',
        fingerprint: 'fp-v199-7',
        event: fullEventFields({ comment: '國道一號北向發生追撞事故', ...OUT_OF_AREA_COORDS }), // no KM marker, so coordinates decide
      }),
    }),
    env,
    NOW
  );
  const lines = logLines.filter((l) => l.includes('[pbs-debug-push][ai-candidate]') && l.includes('eventId=PBS-V199-7'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('candidate=false'));
  assert.ok(lines[0].includes('reason=outside-service-area'));
});

test('V1.9.9 (8): invalid auth -> reject, 0 AI candidate log lines', async () => {
  await handlePbsDebugPush(pushRequest({ token: null }), baseEnv(), NOW);
  assert.equal(logLines.filter((l) => l.includes('[pbs-debug-push][ai-candidate]')).length, 0);
});

test('V1.9.9 (9): invalid payload -> reject, 0 AI candidate log lines', async () => {
  await handlePbsDebugPush(pushRequest({ body: validPayload({ lifecycle: 'NOT_A_LIFECYCLE' }) }), baseEnv(), NOW);
  assert.equal(logLines.filter((l) => l.includes('[pbs-debug-push][ai-candidate]')).length, 0);
});

test('V1.9.9 (10): a duplicate payload does not produce a second AI candidate', async () => {
  const env = baseEnv();
  const payload = validPayload({ eventId: 'PBS-V199-10', lifecycle: 'NEW', fingerprint: 'fp-v199-10', event: fullEventFields() });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-10').length, 1);
  logLines.length = 0;
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-v199-10-dup' } }), env, new Date(NOW.getTime() + 1000));
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-10').length, 0, 'a duplicate must never produce a second AI candidate');
});

// (11) candidate schema correctness is covered exhaustively at the unit
// level in test/pbsAiCandidate.test.js (buildAiCandidate's own tests) —
// this integration test only confirms the real call site's log line
// carries the expected observable fields.
test('V1.9.9 (11): the real call site logs eventType and locationQualitySufficient for a built candidate', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-11', lifecycle: 'NEW', fingerprint: 'fp-v199-11', event: fullEventFields() }) }),
    env,
    NOW
  );
  const [line] = aiCandidateLogLines(logLines, 'PBS-V199-11');
  assert.ok(line);
  assert.match(line, /eventType=accident/);
  assert.match(line, /locationQualitySufficient=(true|false)/);
});

test('V1.9.9 (12): Phase 2 AI-inactive — building a candidate causes ZERO additional LINE push (0 fetch calls for an otherwise-ineligible event)', async () => {
  const kv = countingKV();
  const env = baseEnv({ TRAFFIC_KV: kv });
  // default beforeEach fetch mock throws if called at all
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-12', lifecycle: 'NEW', fingerprint: 'fp-v199-12', event: fullEventFields({ comment: otherComment() }) }) }),
    env,
    NOW
  );
  assert.equal(res.status, 200); // if the candidate build had triggered any fetch, the throwing mock would have failed this
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-12').length, 1, 'expected a candidate to still be built for observability');
});

test('V1.9.9 (13): existing LINE safety/dedupe is unbroken — a real eligible accident still pushes to LINE exactly once, unaffected by candidate building running alongside it', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = baseEnv({ TRAFFIC_KV: kv });
  const mockFetch = mockLinePushFetch();
  globalThis.fetch = mockFetch;
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-13', lifecycle: 'NEW', fingerprint: 'fp-v199-13', event: fullEventFields() }) }),
    env,
    NOW
  );
  assert.equal(mockFetch.calls.length, 1, 'expected exactly 1 real LINE push — the legacy Business Pipeline decision is completely unaffected by the new candidate-building code path');
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-13').length, 1, 'and the candidate preview is STILL built alongside it');
});

test('V1.9.9 (14): lifecycle unchanged — UPDATED still works exactly as V1.9.8, and also produces a candidate', async () => {
  const env = baseEnv();
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-14', lifecycle: 'UPDATED', fingerprint: 'fp-v199-14', event: fullEventFields() }) }),
    env,
    NOW
  );
  assert.equal((await res.json()).lifecycle, 'UPDATED');
  const lines = aiCandidateLogLines(logLines, 'PBS-V199-14');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('lifecycle=UPDATED'));
});

test('V1.9.9 (15): CLEARED never enters the AI candidate path', async () => {
  const env = baseEnv();
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-V199-15', lifecycle: 'CLEARED', fingerprint: 'fp-v199-15', event: fullEventFields({ comment: '國道一號北向94公里處已排除' }) }) }),
    env,
    NOW
  );
  assert.equal(aiCandidateLogLines(logLines, 'PBS-V199-15').length, 0, 'CLEARED must never reach buildAiCandidate — same gate as the Business Pipeline itself');
});
