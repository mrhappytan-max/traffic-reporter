// V2.2.0 — AI Decision Observatory Four-Layer Event Lifecycle (order
// section 十二's own 20-item minimum test list). Exercises the REAL
// src/pbs/debugPush.js handler (to populate the two-write — PROCESSING_
// STARTED then final — Observatory record the same way Production would)
// and the REAL src/pbs/aiObservatoryView.js handler (to render the
// four-layer page), proving end-to-end wiring. Pure-function coverage for
// aiObservatoryIndex.js's own rawComment/rawSourceDetail/PROCESSING_
// STARTED lives in test/aiObservatoryIndex.test.js; this file is scoped
// to the four-layer PAGE itself and the zero-side-effect guarantees.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePbsDebugPush, PBS_DEBUG_PUSH_PATH, IDEMPOTENCY_STATUS, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const SECRET = 'real-debug-secret-value';
const NOW = new Date('2026-08-29T10:00:00+08:00'); // within LINE broadcast hours

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
    async put(key, value, options) {
      this.putCalls += 1;
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix } = {}) {
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
const RAW_COMMENT = '東向近竹科匝道有A3交通事故，內側車道封閉，請改道慢車道通行';

function fullEventFields(overrides = {}) {
  return {
    road: '台68',
    areaNm: '台68東向',
    direction: '東向',
    comment: RAW_COMMENT,
    longitude: 121.0,
    latitude: 24.8,
    sourceDetail: '警廣路況中心',
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    generatedAt: '2026-08-29T10:00:00+08:00',
    source: 'pbs',
    eventId: 'PBS-4L-1',
    lifecycle: 'NEW',
    fingerprint: 'fp-4l-1',
    requestId: 'req-4l-1',
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
let lineFetchCalls;
beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  lineFetchCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) {
      lineFetchCalls += 1;
      return new Response('{}', { status: 200 });
    }
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

// --- 1/2: notify=true / notify=false, full four layers ---------------------

test('1: AI notify=true — all four layers visible: PBS/Windows raw text, Cloudflare COMPLETED, AI decision, LINE sent', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true, impact: 'HIGH', reason: '內側車道封閉，建議改道' })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-1', fingerprint: 'fp-4l-1' }) }), env, NOW);
  assert.equal(lineFetchCalls, 1, 'sanity: a real LINE push happened for this fixture');

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('① PBS/Windows'));
  assert.ok(html.includes('② Cloudflare'));
  assert.ok(html.includes('③ AI'));
  assert.ok(html.includes('④ LINE'));
  assert.ok(html.includes(RAW_COMMENT), 'raw PBS comment must appear verbatim');
  assert.ok(html.includes('COMPLETED'));
  assert.ok(html.includes('AI：建議通報'));
  assert.ok(html.includes('內側車道封閉，建議改道'));
  assert.ok(html.includes('LINE 已發送'));
});

test('2: AI notify=false — all four layers visible, LINE explicitly shown as not-sent with a reason', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: false, impact: 'LOW', reason: '短暫延誤，很快恢復' })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-2', fingerprint: 'fp-4l-2' }) }), env, NOW);
  assert.equal(lineFetchCalls, 0);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('AI：不需主動通報'));
  assert.ok(html.includes('短暫延誤，很快恢復'));
  assert.ok(html.includes('LINE 未發送'));
  assert.ok(html.includes('AI notify=false'), '未執行原因 must name the real cause');
});

// --- 3/4: AI failure / AI invalid ------------------------------------------

test('3: AI call failure — visible as a card, LINE never attempted, reason honestly UNKNOWN', async () => {
  const env = await baseEnv({ AI: mockAi(null, { throwError: new Error('simulated network failure') }) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-3', fingerprint: 'fp-4l-3' }) }), env, NOW);
  assert.equal(lineFetchCalls, 0);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('AI：判讀失敗，安全不通報'));
  assert.ok(html.includes('AI 判讀失敗，安全不通報'), 'LINE 未執行原因 must name AI failure, not a generic UNKNOWN');
  assert.ok(!html.includes('LINE 已發送'));
});

test('4: AI invalid response — visible as a card, distinct failure state, LINE never attempted', async () => {
  const env = await baseEnv({ AI: mockAi('not valid json at all') });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-4', fingerprint: 'fp-4l-4' }) }), env, NOW);
  assert.equal(lineFetchCalls, 0);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('AI：判讀失敗，安全不通報'));
});

// --- 5: transport duplicate --------------------------------------------------

test('5: a transport duplicate never creates a second Observatory entry', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: false })) });
  const payload = validPayload({ eventId: 'PBS-4L-5', fingerprint: 'fp-4l-5' });
  await handlePbsDebugPush(pushRequest({ body: payload }), env, NOW);
  await handlePbsDebugPush(pushRequest({ body: { ...payload, requestId: 'req-4l-5-dup' } }), env, new Date(NOW.getTime() + 1000));

  const obsKeys = [...env.TRAFFIC_KV.store.keys()].filter((k) => k.startsWith('debug:pbs-ai-observatory-index:v1:'));
  assert.equal(obsKeys.length, 1, 'a duplicate retry must never add a second Observatory entry');
});

// --- 6/7: Cloudflare PROCESSING vs COMPLETED --------------------------------

test('6: Cloudflare layer shows PROCESSING while the AI call is still genuinely in flight', async () => {
  const deferred = (() => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  })();
  const env = await baseEnv({ AI: { run: async () => deferred.promise } });
  const ctx = { waitUntil(p) { this._p = p; } };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-6', fingerprint: 'fp-4l-6' }) }), env, NOW, ctx);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes(IDEMPOTENCY_STATUS.PROCESSING));
  assert.ok(html.includes('AI：未執行（處理中或未完成）'));

  deferred.resolve({ response: verdictJson({ notify: false }) });
  await ctx._p; // let the background work finish so it doesn't leak into the next test
});

test('7: Cloudflare layer shows COMPLETED once business processing genuinely finishes', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: false })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-7', fingerprint: 'fp-4l-7' }) }), env, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes(IDEMPOTENCY_STATUS.COMPLETED));
  assert.ok(html.includes('已交由背景流程處理完成'));
});

// --- 8/9: LINE success / failure --------------------------------------------

test('8: LINE success is visible as "LINE 已發送"', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-8', fingerprint: 'fp-4l-8' }) }), env, NOW);
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('LINE 已發送'));
});

test('9: LINE failure (push attempted but did not succeed) is visible as "LINE 發送失敗"', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 500 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-9', fingerprint: 'fp-4l-9' }) }), env, NOW);
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('LINE 發送失敗'));
});

// --- 10: missing optional fields -> UNKNOWN ---------------------------------

test('10: missing optional fields (no displayKM, no sourceDetail, expired AI decision cache) render UNKNOWN / NOT RECORDED, never a guess', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true, reason: '真實理由不應消失' })) });
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-4L-10', fingerprint: 'fp-4l-10', event: fullEventFields({ sourceDetail: undefined }) }) }),
    env,
    NOW
  );
  for (const key of [...env.TRAFFIC_KV.store.keys()]) {
    if (key.startsWith('debug:pbs-ai-decision-cache:v1:')) env.TRAFFIC_KV.store.delete(key);
  }
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('UNKNOWN / NOT RECORDED'));
  assert.ok(html.includes('NOT RECORDED')); // PBS 發生時間／LINE 發送時間
  assert.ok(!html.includes('真實理由不應消失'), 'an expired cache entry must never be guessed back');
});

// --- 11/12: raw comment fully displayed, separate from formatted output ----

test('11: PBS raw comment is displayed COMPLETE — never truncated, summarized, or rewritten', async () => {
  const longComment = `${RAW_COMMENT}。${'補充說明文字。'.repeat(20)}`; // well over the old 120-char truncation ceiling
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: false })) });
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-4L-11', fingerprint: 'fp-4l-11', event: fullEventFields({ comment: longComment }) }) }),
    env,
    NOW
  );
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes(longComment), 'the full raw comment, including everything past the old 120-char cutoff, must be present verbatim');
  assert.ok(!html.includes('…'), 'no truncation ellipsis must appear for the raw text block');
});

test('12: raw PBS comment and formatted/parsed output (road/direction/areaNm) are shown as clearly separate fields, never merged', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: false })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-12', fingerprint: 'fp-4l-12' }) }), env, NOW);
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('PBS 原始通報'), 'the raw text block must be independently labeled');
  assert.ok(html.includes('解析結果'), 'the parsed/formatted fields must be independently labeled, never presented as if they were the raw text');
  assert.ok(html.includes(RAW_COMMENT));
  assert.ok(html.includes('台68'));
});

// --- 13/14/15: zero Workers AI calls on open/refresh/search ----------------

test('13/14/15: opening, refreshing, and searching the four-layer page makes ZERO Workers AI calls', async () => {
  const ai = mockAi(verdictJson({ notify: true }));
  const env = await baseEnv({ AI: ai });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-13', fingerprint: 'fp-4l-13' }) }), env, NOW);
  assert.equal(ai.calls.length, 1, 'sanity: the AI was genuinely called once while building the fixture');

  await handleAiObservatoryView(env, viewRequest(), NOW); // open
  await handleAiObservatoryView(env, viewRequest(), NOW); // refresh
  await handleAiObservatoryView(env, viewRequest('?q=台68'), NOW); // search
  await handleAiObservatoryView(env, viewRequest('?road=台68&status=AI_NOTIFY_TRUE'), NOW); // filter

  assert.equal(ai.calls.length, 1, 'open/refresh/search/filter must never call Workers AI again');
});

// --- 16/17/18: zero KV writes on open/refresh/search ------------------------

test('16/17/18: opening, refreshing, and searching the four-layer page makes ZERO KV writes', async () => {
  const env = await baseEnv({ AI: mockAi(verdictJson({ notify: true })) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-4L-16', fingerprint: 'fp-4l-16' }) }), env, NOW);

  const putsAfterIngest = env.TRAFFIC_KV.putCalls;
  await handleAiObservatoryView(env, viewRequest(), NOW); // open
  await handleAiObservatoryView(env, viewRequest(), NOW); // refresh
  await handleAiObservatoryView(env, viewRequest('?q=台68'), NOW); // search

  assert.equal(env.TRAFFIC_KV.putCalls, putsAfterIngest, 'the Observatory page must be pure READ — open/refresh/search must never write to KV');
});

// --- 19: KV cost formula (order section 六) ---------------------------------
//
// Uses the SAME reference fixture as test/pbsDebugPush.test.js's own KV
// cost quantification suite (AI decisions disabled -> legacy
// runLineBroadcast path, no subscribers enrolled, no broadcast-relevant
// event) — the established apples-to-apples baseline this project's
// Engineering Memory has quoted a formula against since V2.0.1. The AI
// PATH's own additional per-event cost (aiDecisionCache's own persist
// write on a cache MISS — orthogonal to this round's own change, already
// covered by test/aiDecisionCache.test.js) is deliberately NOT part of
// this measurement, so the number reported here isolates exactly what
// THIS round added.
function legacyPathEnv() {
  const kv = countingKV();
  return { PBS_DEBUG_PUSH_SECRET: SECRET, TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok' }; // PBS_AI_DECISION_ENABLED absent -> legacy path
}

test('19: KV cost formula — N accepted events cost exactly 4N+2 puts (V2.2.0: idempotency PROCESSING+COMPLETED + observatory PROCESSING_STARTED+final)', async () => {
  for (const eventsPerDay of [50, 100, 200]) {
    resetPbsDebugPushIdempotencyState(); // the L1 in-memory map is module-global — reset between iterations so eventId reuse across passes can never L1-shortcut into a false duplicate
    const env = legacyPathEnv();
    for (let i = 0; i < eventsPerDay; i += 1) {
      const res = await handlePbsDebugPush(
        pushRequest({ body: validPayload({ eventId: `PBS-4L-KV-${eventsPerDay}-${i}`, fingerprint: `fp-4l-kv-${eventsPerDay}-${i}`, requestId: `req-4l-kv-${eventsPerDay}-${i}` }) }),
        env,
        NOW
      );
      assert.equal((await res.json()).accepted, true);
    }
    const expectedPuts = eventsPerDay * 4 + 2; // idempotency-PROCESSING + idempotency-COMPLETED + observatory-PROCESSING_STARTED + observatory-final, + 1 incident-suppression-state + 1 shared-feed (both WRITE_ON_CHANGE, once per run)
    assert.equal(env.TRAFFIC_KV.putCalls, expectedPuts, `eventsPerDay=${eventsPerDay}: expected ${expectedPuts} puts (well under the Workers KV Free Plan's 1,000 writes/day per namespace)`);
    assert.ok(expectedPuts < 1000, `eventsPerDay=${eventsPerDay}: ${expectedPuts} puts/day must stay under the Free Plan's 1,000/day budget`);
  }
});

// --- sanity: the new outcome value is a real, closed vocabulary member -----

test('PROCESSING_STARTED is part of the closed AI_OUTCOME vocabulary, never a magic string', () => {
  assert.equal(AI_OUTCOME.PROCESSING_STARTED, 'PROCESSING_STARTED');
});
