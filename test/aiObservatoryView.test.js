// V2.0.1 — AI Decision Observatory integration tests (order section 十三).
// Exercises the REAL src/pbs/debugPush.js handler (to populate the
// observatory index the same way Production would) and the REAL
// src/pbs/aiObservatoryView.js handler (to render the page) — proving
// end-to-end wiring, not just the pure index functions (see
// test/aiObservatoryIndex.test.js for those).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePbsDebugPush, PBS_DEBUG_PUSH_PATH, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { APP_VERSION } from '../src/version.js';

const SECRET = 'real-debug-secret-value';
const NOW = new Date('2026-08-29T10:00:00+08:00'); // within LINE broadcast hours

function countingKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: undefined };
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

function verdictJson({ notify, impact = 'HIGH', reason = '雙向封閉需改道', confidence = 0.93 }) {
  return JSON.stringify({ notify, impact, reason, confidence });
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

function fullEventFields(overrides = {}) {
  return {
    road: '台61',
    areaNm: '台61南向',
    direction: '南向',
    comment: '台61線60.4K-63K因軍事演習雙向封閉需改道',
    longitude: 121.0,
    latitude: 24.8,
    sourceDetail: 'test',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T10:00:00+08:00',
    source: 'pbs',
    eventId: 'PBS-OBS-1',
    lifecycle: 'NEW',
    fingerprint: 'fp-obs-1',
    requestId: 'req-obs-1',
    event: fullEventFields(),
    ...overrides,
  };
}

function pushRequest({ body } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` });
  return new Request(`https://producer.example${PBS_DEBUG_PUSH_PATH}`, { method: 'POST', headers, body: JSON.stringify(body ?? validPayload()) });
}

function viewRequest(query = '') {
  return new Request(`https://producer.example/admin/pbs-ai-observatory-view${query}`, { method: 'GET' });
}

let priorFetch;
beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = priorFetch;
});

async function baseEnv(overrides = {}) {
  const kv = countingKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  return { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, ...overrides };
}

test('1/2/3: opening, refreshing, and searching the Observatory page makes ZERO Workers AI calls', async () => {
  const ai = mockAi(verdictJson({ notify: true }));
  const env = await baseEnv({ AI: ai });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-A', fingerprint: 'fp-a', event: fullEventFields() }) }), env, NOW);
  assert.equal(ai.calls.length, 1, 'sanity: the AI was actually called once while building the fixture');

  await handleAiObservatoryView(env, viewRequest(), NOW); // "open"
  await handleAiObservatoryView(env, viewRequest(), NOW); // "refresh"
  await handleAiObservatoryView(env, viewRequest('?q=%E5%8F%B061&road=%E5%8F%B061'), NOW); // "search"
  assert.equal(ai.calls.length, 1, 'viewing/refreshing/searching the Observatory must never call Workers AI again');
});

test('4: notify=true is correctly displayed as "AI：建議通報" with impact/confidence/reason from the real decision', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true, impact: 'HIGH', reason: '雙向封閉需改道，明顯影響營業車通行', confidence: 0.96 })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-B', fingerprint: 'fp-b', event: fullEventFields() }) }), env, NOW);

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  const html = await res.text();
  assert.ok(html.includes('AI：建議通報'));
  assert.ok(html.includes('雙向封閉需改道，明顯影響營業車通行'));
  assert.ok(html.includes('0.96'));
  assert.ok(html.includes('HIGH'));
});

test('5: notify=false is correctly displayed as "AI：不需主動通報"', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: false, impact: 'LOW', reason: '短暫輕微影響，可正常通行' })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-C', fingerprint: 'fp-c', event: fullEventFields() }) }), env, NOW);

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  const html = await res.text();
  assert.ok(html.includes('AI：不需主動通報'));
  assert.ok(html.includes('短暫輕微影響，可正常通行'));
});

test('6: AI failure (429/invalid) is correctly displayed as "AI：判讀失敗，安全不通報"', async () => {
  const env = await baseEnv({ AI: mockAi(null, { throwError: new Error('429 Too Many Requests') }) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-D', fingerprint: 'fp-d', event: fullEventFields() }) }), env, NOW);

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  const html = await res.text();
  assert.ok(html.includes('AI：判讀失敗，安全不通報'));
  assert.ok(!html.includes('不符合播報資格'), 'must never use the legacy V1.x hard-rule label for an AI-path event');
});

test('7/8: cache MISS then cache HIT are correctly and distinctly displayed', async () => {
  const ai = mockAi(verdictJson({ notify: true }));
  const env = await baseEnv({ AI: ai });
  const payload = validPayload({ eventId: 'PBS-OBS-E', fingerprint: 'fp-e', event: fullEventFields() });

  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW); // first time -> MISS
  let html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('MISS'));
  assert.equal(ai.calls.length, 1);

  // Second push with the SAME eventId+fingerprint but a different
  // lifecycle (UPDATED) still hits the SAME AI decision cache key
  // (eventId+fingerprint only) -> cache hit, 0 additional AI calls, and
  // produces its OWN observatory row for the new lifecycle.
  resetPbsDebugPushIdempotencyState();
  await handlePbsDebugPush(pushRequest({ body: { ...payload, lifecycle: 'UPDATED' } }), env, NOW);
  assert.equal(ai.calls.length, 1, 'a cache hit must never call Workers AI again');

  html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('HIT'));
});

test('9: reason shown on the page is the REAL persisted decision, never regenerated even if the mock would return something different on a later call', async () => {
  let callCount = 0;
  const ai = {
    calls: [],
    async run() {
      callCount += 1;
      this.calls.push({});
      // If the page ever called this again with a different reason, the
      // test below would catch the drift.
      return { response: verdictJson({ notify: true, reason: callCount === 1 ? '第一次的真實理由' : '如果被重新呼叫就會是這個（不應該發生）' }) };
    },
  };
  const env = await baseEnv({ AI: ai });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-F', fingerprint: 'fp-f', event: fullEventFields() }) }), env, NOW);

  await handleAiObservatoryView(env, viewRequest(), NOW);
  await handleAiObservatoryView(env, viewRequest(), NOW);
  await handleAiObservatoryView(env, viewRequest(), NOW);

  assert.equal(callCount, 1, 'the AI adapter must have been called exactly once total, across the push AND three page views');
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('第一次的真實理由'));
  assert.ok(!html.includes('如果被重新呼叫就會是這個'));
});

test('10: an event processed via the legacy (AI-disabled) path is labeled "AI 未判讀", never mislabeled as an AI decision', async () => {
  const env = await baseEnv({ PBS_AI_DECISION_ENABLED: false, AI: mockAi(verdictJson({ notify: true })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-G', fingerprint: 'fp-g', event: fullEventFields({ comment: '國道一號北向94公里處發生追撞事故' }) }) }), env, NOW);

  assert.equal(env.AI.calls.length, 0, 'AI must never be called while the kill switch is off');
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('AI 未判讀'));
  assert.ok(!html.includes('AI：建議通報'));
  assert.ok(!html.includes('AI：不需主動通報'));
});

test('11: missing/expired AI decision cache data renders UNKNOWN / NOT RECORDED, never a guess', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true, reason: '真實理由不應消失' })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-H', fingerprint: 'fp-h', event: fullEventFields() }) }), env, NOW);

  // Simulate the AI decision cache record having expired/been evicted
  // (TTL passed) while the observatory index entry itself is still
  // present — the page must degrade honestly, not fabricate a reason.
  for (const key of [...env.TRAFFIC_KV.store.keys()]) {
    if (key.startsWith('debug:pbs-ai-decision-cache:v1:')) env.TRAFFIC_KV.store.delete(key);
  }

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('UNKNOWN / NOT RECORDED'));
  assert.ok(!html.includes('真實理由不應消失'));
});

// V2.0.1 order item 12's own literal version checklist assertion. Kept as
// a live "current version" smoke check rather than a frozen historical
// literal — updated in the SAME commit as every subsequent APP_VERSION
// bump (V2.1.0's own transport-ack/business-processing round moved it
// here), same discipline test/versionLineage.test.js's own series-prefix
// check already follows.
test('12: APP_VERSION reflects the current release', () => {
  assert.equal(APP_VERSION, 'V2.1.0');
});

test('SERVICE_AREA_EXCLUDED events show "服務區域外", never routed through AI at all', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  await handlePbsDebugPush(
    pushRequest({
      body: validPayload({
        eventId: 'PBS-OBS-I',
        fingerprint: 'fp-i',
        event: fullEventFields({ longitude: 121.71801, latitude: 25.10288, road: '國道一號', comment: '國道一號南向八堵交流道事故' }),
      }),
    }),
    env,
    NOW
  );
  assert.equal(env.AI.calls.length, 0);
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('服務區域外'));
});

test('duplicate transport arrivals never create a second observatory row, and the "重複事件" filter explains why rather than guessing', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  const payload = validPayload({ eventId: 'PBS-OBS-J', fingerprint: 'fp-j', event: fullEventFields() });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  const res2 = await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW); // exact duplicate — same idempotency key
  assert.equal((await res2.json()).duplicate, true);
  assert.equal(env.AI.calls.length, 1, 'the duplicate must never reach the AI at all');

  const html = await (await handleAiObservatoryView(env, viewRequest('?status=DUPLICATE'), NOW)).text();
  assert.ok(html.includes('重複到達的 Windows PBS 事件'), 'must explain the architecture limit, never silently show an empty/misleading result');
});
