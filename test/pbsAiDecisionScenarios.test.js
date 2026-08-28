// V1.9.9 Phase 3B — order section 十七 (deterministic AI adapter / mocked
// end-to-end scenarios A-P) plus the kill-switch behavior (order section
// 十八). Exercises the REAL src/pbs/debugPush.js handler with
// env.PBS_AI_DECISION_ENABLED=true and a deterministic mocked env.AI.run
// — this proves the WIRING (candidate -> cache -> AI call -> validate ->
// execute) behaves correctly for each scenario shape; it does not and
// cannot prove what the real Workers AI model would judge for real PBS
// text (that is Cloudflare's model, not testable from this sandbox).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePbsDebugPush, PBS_DEBUG_PUSH_PATH, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const SECRET = 'real-debug-secret-value';
const NOW = new Date('2026-08-28T10:00:00+08:00'); // within LINE broadcast hours

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

/** A fixed, deterministic mock AI adapter — never a real Workers AI call. */
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

function verdictJson({ notify, impact = 'HIGH', reason = '測試理由', confidence = 0.9 }) {
  return JSON.stringify({ notify, impact, reason, confidence });
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

async function baseEnv(overrides = {}) {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  return {
    PBS_DEBUG_PUSH_SECRET: SECRET,
    TRAFFIC_KV: kv,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    PBS_AI_DECISION_ENABLED: true,
    ...overrides,
  };
}

function fullEventFields(overrides = {}) {
  return {
    road: '國道一號',
    areaNm: '國道一號北向',
    direction: '北向',
    comment: '國道一號北向94公里處發生追撞事故',
    longitude: 121.0,
    latitude: 24.8,
    sourceDetail: 'test',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-28T10:00:00+08:00',
    source: 'pbs',
    eventId: 'PBS-SCEN-1',
    lifecycle: 'NEW',
    fingerprint: 'fp-scen-1',
    requestId: 'req-scen-1',
    event: fullEventFields(),
    ...overrides,
  };
}

function pushRequest({ method = 'POST', token = SECRET, body } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return new Request(`https://producer.example${PBS_DEBUG_PUSH_PATH}`, { method, headers, body: JSON.stringify(body ?? validPayload()) });
}

let priorFetch;
let logLines;
let logSpy;

beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  logLines = [];
  logSpy = console.log;
  console.log = (...args) => logLines.push(args.join(' '));
});
afterEach(() => {
  globalThis.fetch = priorFetch;
  console.log = logSpy;
});

function aiLines(eventId) {
  return logLines.filter((l) => l.includes('[pbs-debug-push][ai-decision]') && l.includes(`eventId=${eventId}`));
}
function lineSentCount(eventId) {
  return aiLines(eventId).filter((l) => l.includes('event=AI_LINE_SENT')).length;
}

// --- A-C, F, G: real-world-shaped fixtures that SHOULD notify=true/HIGH ----

const NOTIFY_TRUE_FIXTURES = [
  ['A: 台61 雙向 60.4K-63K 軍事演習 09:00-11:00 雙向封閉', fullEventFields({ road: '台61', comment: '台61線60.4K-63K因軍事演習09:00-11:00雙向封閉' })],
  ['B: 落石造成雙向封閉需要改道', fullEventFields({ comment: '國道一號北向94公里處落石雙向封閉需改道' })],
  ['C: 交流道封閉', fullEventFields({ comment: '國道一號北向新竹系統交流道封閉' })],
  ['F: 非accident的交通管制但雙向完全封閉', fullEventFields({ comment: '國道一號北向94公里處交通管制雙向完全封閉' })],
  ['G: locationQuality imperfect但comment明確寫封路與位置', fullEventFields({ comment: '國道一號北向新竹路段全線封閉' })],
];

for (const [label, eventFields] of NOTIFY_TRUE_FIXTURES) {
  test(`V1.9.9 Phase 3B scenario ${label} -> AI mock notify=true/HIGH executes exactly 1 LINE push`, async () => {
    const kv = countingKV();
    await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
    const pushCalls = [];
    globalThis.fetch = async (url, init) => {
      pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    };
    const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: mockAi(verdictJson({ notify: true, impact: 'HIGH' })) };
    const eventId = `PBS-${label.slice(0, 1)}`;
    await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId, fingerprint: `fp-${label}`, event: eventFields }) }), env, NOW);
    assert.equal(pushCalls.length, 1, `expected exactly 1 LINE push for scenario ${label}`);
    assert.equal(lineSentCount(eventId), 1);
  });
}

// --- D, E: fixtures that SHOULD notify=false/LOW ----------------------------

const NOTIFY_FALSE_FIXTURES = [
  ['D: 小型事故仍可正常通行短時間排除', fullEventFields({ comment: '國道一號北向94公里處小型擦撞事故，未影響通行' })],
  ['E: 一般施工未封路影響輕微', fullEventFields({ comment: '國道一號北向94公里處一般養護施工，未封閉車道' })],
];

for (const [label, eventFields] of NOTIFY_FALSE_FIXTURES) {
  test(`V1.9.9 Phase 3B scenario ${label} -> AI mock notify=false/LOW -> 0 LINE`, async () => {
    const kv = countingKV();
    await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
    const pushCalls = [];
    globalThis.fetch = async (url, init) => {
      pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    };
    const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: mockAi(verdictJson({ notify: false, impact: 'LOW' })) };
    const eventId = `PBS-${label.slice(0, 1)}`;
    await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId, fingerprint: `fp-${label}`, event: eventFields }) }), env, NOW);
    assert.equal(pushCalls.length, 0, `expected 0 LINE push for scenario ${label}`);
    assert.ok(aiLines(eventId).some((l) => l.includes('event=AI_NOTIFY_FALSE')));
  });
}

// --- H: out-of-service-area -> never reaches AI ------------------------------

test('V1.9.9 Phase 3B scenario H: out-of-service-area -> 0 AI calls', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-H', fingerprint: 'fp-h', event: fullEventFields({ longitude: 121.71801, latitude: 25.10288, comment: '國道一號北向發生追撞事故' }) }) }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 0);
});

// --- I: exact transport duplicate -> 0 AI call --------------------------------

test('V1.9.9 Phase 3B scenario I: exact transport duplicate -> 0 additional AI call', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  const payload = validPayload({ eventId: 'PBS-I', fingerprint: 'fp-i' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  assert.equal(env.AI.calls.length, 1);
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-i-dup' } }), env, new Date(NOW.getTime() + 1000));
  assert.equal(env.AI.calls.length, 1, 'a genuine transport duplicate must never reach the AI decision path at all');
});

// --- J: AI cache hit -> 0 AI call, K: fingerprint changed -> new AI call -----

test('V1.9.9 Phase 3B scenario J/K: same eventId+fingerprint -> cache hit (0 AI call); changed fingerprint -> new AI call', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  // NEW then UPDATED for the SAME eventId with the SAME fingerprint would
  // itself be a transport duplicate at the idempotency layer (scenario I) —
  // to reach the AI *cache* specifically, use NEW then a genuinely
  // different lifecycle transition sharing the same content fingerprint
  // is not realistic either; the direct, honest way to prove cache reuse
  // is calling resolveAiDecision's own cache twice for the identical
  // (eventId, fingerprint) pair via two DIFFERENT lifecycle transport
  // events (NEW, then UPDATED) that happen to carry the same real-world
  // content (same fingerprint) -- transport idempotency treats NEW and
  // UPDATED as separate keys (V1.9.7), so both reach the AI decision layer,
  // and the SECOND one is where the cache hit is provable.
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-JK', lifecycle: 'NEW', fingerprint: 'fp-jk-same' }) }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 1);
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-JK', lifecycle: 'UPDATED', fingerprint: 'fp-jk-same', requestId: 'req-jk-2' }) }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 1, 'same eventId+fingerprint content -> cache hit, 0 additional AI call');
  assert.ok(aiLines('PBS-JK').some((l) => l.includes('event=AI_CACHE_HIT')));

  // K: a genuinely different fingerprint (real content change) -> new AI call
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-JK', lifecycle: 'UPDATED', fingerprint: 'fp-jk-changed', requestId: 'req-jk-3' }) }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 2, 'a changed fingerprint must call AI again');
});

// --- L: AI invalid JSON -> 0 LINE ---------------------------------------------

test('V1.9.9 Phase 3B scenario L: AI returns invalid JSON -> 0 LINE, no fallback to legacy decision', async () => {
  const pushCalls = [];
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url, body: init.body });
    return new Response('{}', { status: 200 });
  };
  const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: mockAi('這不是有效的JSON回應') };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-L', fingerprint: 'fp-l' }) }), env, NOW);
  assert.equal(pushCalls.length, 0);
  assert.ok(aiLines('PBS-L').some((l) => l.includes('event=AI_DECISION_INVALID')));
});

// --- M: AI 429/error -> 0 LINE -------------------------------------------------

test('V1.9.9 Phase 3B scenario M: AI call fails (429-shaped error) -> 0 LINE, no fallback', async () => {
  const pushCalls = [];
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url, body: init.body });
    return new Response('{}', { status: 200 });
  };
  const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: mockAi(null, { throwError: new Error('429 Too Many Requests') }) };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-M', fingerprint: 'fp-m' }) }), env, NOW);
  assert.equal(pushCalls.length, 0);
  assert.ok(aiLines('PBS-M').some((l) => l.includes('event=AI_CALL_FAILED')));
});

// --- N: AI notify=false -> 0 LINE (duplicate of the D/E group's own proof, item kept explicit per the order's own numbering) --

test('V1.9.9 Phase 3B scenario N: AI notify=false -> 0 LINE (explicit, order item 14/N)', async () => {
  const pushCalls = [];
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url, body: init.body });
    return new Response('{}', { status: 200 });
  };
  const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: mockAi(verdictJson({ notify: false, impact: 'LOW' })) };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-N', fingerprint: 'fp-n' }) }), env, NOW);
  assert.equal(pushCalls.length, 0);
});

// --- O: AI notify=true -> exactly 1 LINE (explicit) --------------------------

test('V1.9.9 Phase 3B scenario O: AI notify=true -> exactly 1 LINE (explicit, order item 15/O)', async () => {
  const pushCalls = [];
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url, body: init.body });
    return new Response('{}', { status: 200 });
  };
  const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: mockAi(verdictJson({ notify: true, impact: 'HIGH' })) };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-O', fingerprint: 'fp-o' }) }), env, NOW);
  assert.equal(pushCalls.length, 1);
});

// --- P: CLEARED -> 0 AI call / 0 LINE -----------------------------------------

test('V1.9.9 Phase 3B scenario P: CLEARED -> 0 AI calls, 0 LINE', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  const res = await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-P', lifecycle: 'CLEARED', fingerprint: 'fp-p', event: fullEventFields({ comment: '國道一號北向94公里處已排除' }) }) }),
    env,
    NOW
  );
  assert.equal(res.status, 200);
  assert.equal(env.AI.calls.length, 0);
});

// --- Kill switch (order section 十八): default false, byte-identical legacy behavior --

test('V1.9.9 Phase 3B: PBS_AI_DECISION_ENABLED not set -> AI never called, legacy Business Pipeline runs exactly as V1.9.8/Phase 2', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const pushCalls = [];
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url, body: init.body });
    return new Response('{}', { status: 200 });
  };
  const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', AI: mockAi(verdictJson({ notify: true })) }; // note: no PBS_AI_DECISION_ENABLED
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-KILL', fingerprint: 'fp-kill', event: fullEventFields({ comment: '國道一號北向94公里處全線封閉' }) }) }), env, NOW);
  assert.equal(env.AI.calls.length, 0, 'AI must never be called while the kill switch is off, even if env.AI is bound and would approve');
  // type='control' fails the legacy MAJOR_ACCIDENT_ONLY policy -> 0 push, proving the LEGACY path (not AI) decided this
  assert.equal(pushCalls.length, 0);
});

test('V1.9.9 Phase 3B: kill switch off -> a real accident still pushes via the UNCHANGED legacy path', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const pushCalls = [];
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url, body: init.body });
    return new Response('{}', { status: 200 });
  };
  const env = { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok' }; // no AI binding at all, no kill switch
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-KILL-2', fingerprint: 'fp-kill-2', event: fullEventFields({ comment: '國道一號北向94公里處發生追撞事故，車道回堵' }) }) }),
    env,
    NOW
  );
  assert.equal(pushCalls.length, 1, 'legacy path must still work correctly with the kill switch off, with no AI binding present at all');
});

// --- V1.9.9 Phase 3D hotfix: Cloudflare Dashboard/CLI Variables inject
// PBS_AI_DECISION_ENABLED as a STRING ("true"/"false"), never a real
// boolean -- this is the exact shape GPT Work set in Production and hit
// the bug with. These integration-level tests exercise the REAL
// handlePbsDebugPush() end-to-end with a string env value, proving the
// fix actually wires through the AI decision path (not just the pure
// resolvePbsAiDecisionEnabled() unit) -- see test/aiConfig.test.js for
// the exhaustive pure-function cases.

test('V1.9.9 Phase 3D hotfix: PBS_AI_DECISION_ENABLED="true" (Cloudflare string form) -> AI path is entered and mocked AI is called', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const pushCalls = [];
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
  const env = {
    PBS_DEBUG_PUSH_SECRET: SECRET,
    TRAFFIC_KV: kv,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    PBS_AI_DECISION_ENABLED: 'true', // Cloudflare Dashboard/CLI Variable shape -- a string, not a boolean
    AI: mockAi(verdictJson({ notify: true, impact: 'HIGH' })),
  };
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-3D-1', fingerprint: 'fp-3d-1', event: fullEventFields({ comment: '國道一號北向94公里處落石雙向封閉需改道' }) }) }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 1, 'the mocked AI adapter must actually be called when PBS_AI_DECISION_ENABLED is the string "true"');
  assert.equal(pushCalls.length, 1, 'a validated notify=true AI verdict must still reach LINE when the kill switch was set via a Cloudflare string variable');
});

test('V1.9.9 Phase 3D hotfix: PBS_AI_DECISION_ENABLED="false" (Cloudflare string form) -> AI path stays disabled, 0 AI calls', async () => {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const pushCalls = [];
  globalThis.fetch = async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
  const env = {
    PBS_DEBUG_PUSH_SECRET: SECRET,
    TRAFFIC_KV: kv,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    PBS_AI_DECISION_ENABLED: 'false',
    AI: mockAi(verdictJson({ notify: true, impact: 'HIGH' })),
  };
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-3D-2', fingerprint: 'fp-3d-2', event: fullEventFields({ comment: '國道一號北向94公里處發生追撞事故' }) }) }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 0, 'AI must never be called when PBS_AI_DECISION_ENABLED is the string "false"');
  assert.equal(pushCalls.length, 1, 'the legacy runLineBroadcast() path must still handle a real accident correctly');
});
