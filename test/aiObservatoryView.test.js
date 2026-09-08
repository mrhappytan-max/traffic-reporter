// V2.0.1 — AI Decision Observatory integration tests (order section 十三).
// Exercises the REAL src/pbs/debugPush.js handler (to populate the
// observatory index the same way Production would) and the REAL
// src/pbs/aiObservatoryView.js handler (to render the page) — proving
// end-to-end wiring, not just the pure index functions (see
// test/aiObservatoryIndex.test.js for those).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePbsDebugPush as realHandlePbsDebugPush,
  handlePbsAiQueueBatch,
  PBS_DEBUG_PUSH_PATH,
  resetPbsDebugPushIdempotencyState,
} from '../src/pbs/debugPush.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { APP_VERSION } from '../src/version.js';
import { buildAiObservatoryRecord, recordAiObservatoryEntry, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';
import { taipeiDateString } from '../src/tdx/usageLedger.js';

// V2.3.0 — see test/pbsAiDecisionScenarios.test.js's own comment for the
// full rationale: a self-draining fake Queue, attached transparently by a
// same-named wrapper around handlePbsDebugPush, so every existing call
// site here keeps observing fully-completed business processing.
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

async function handlePbsDebugPush(request, env, ...rest) {
  if (env && !env.PBS_AI_QUEUE) env.PBS_AI_QUEUE = fakeQueue(env);
  return realHandlePbsDebugPush(request, env, ...rest);
}

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

test('6: AI failure (429/invalid) is correctly displayed as a failure, never the legacy hard-rule label', async () => {
  // V2.3.0 — a PERSISTENT 429 (this fixture's AI mock always throws) is
  // now Queue-retried (order section 八) via the self-draining fake
  // Queue; retries genuinely exhaust and the terminal outcome is
  // PROCESSING_FAILED, not a lone AI_CALL_FAILED — see
  // test/pbsAiObservatoryFourLayer.test.js's own test 3b for a single
  // (non-exhausted) AI_CALL_FAILED attempt on its own terms.
  const env = await baseEnv({ AI: mockAi(null, { throwError: new Error('429 Too Many Requests') }) });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-OBS-D', fingerprint: 'fp-d', event: fullEventFields() }) }), env, NOW);

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  const html = await res.text();
  assert.ok(html.includes('AI／背景處理最終失敗'));
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
  // produces its OWN observatory row for the new lifecycle. V2.4.0 note:
  // the first push above also wrote a Recent Incident Memory sighting for
  // this event — without incidentMemory.js#selectMemoryCandidates's own
  // `excludeEventId` exclusion (see that function's doc comment), this
  // second push would "discover" its own just-recorded sighting as a
  // memory candidate, changing the AI decision cache key's memory-context
  // fingerprint and wrongly forcing a fresh AI call here. The exclusion
  // is what keeps this a genuine cache hit.
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
// bump (V2.2.0's own Four-Layer Event Lifecycle round moved it here;
// V2.3.0/V2.3.1/V2.3.2/V2.3.3/V2.4.0/V2.4.1/V2.4.2/V2.4.3/V2.4.4/V2.4.5
// only bump the literal), same discipline test/versionLineage.test.js's
// own series-prefix check already follows.
test('12: APP_VERSION reflects the current release', () => {
  assert.equal(APP_VERSION, 'V2.7.0');
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

// ============================================================================
// V2.5.1 (路況-053) — CCTV diagnostic detail rendering. Records are seeded
// DIRECTLY via buildAiObservatoryRecord()/recordAiObservatoryEntry()
// (both already exported, already the real production code path
// debugPush.js itself calls) rather than driven through a full real
// CCTV attempt — a genuine cctv.ok:true collage cannot be produced in
// `node --test` from aiApprovedPbsBroadcast.js's own call site without a
// codecOverride it does not expose (see test/aiApprovedPbsBroadcast.test.js's
// own V2.4.18 comment for the full, pre-existing explanation of this test-
// infrastructure limit — unrelated to and unchanged by this round). This
// still exercises the REAL handleAiObservatoryView() render path end to
// end for these 5 new fields, which is what this round's own new code
// (aiObservatoryIndex.js/aiObservatoryView.js) actually needs covered.
// ============================================================================

async function seedObservatoryRecord(env, overrides = {}) {
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號', direction: '北向', areaNm: '國道一號北向', displayKM: 94, eventType: 'accident', comment: '國道一號北向94公里處發生追撞事故' },
    eventId: overrides.eventId || 'PBS-CCTV-1',
    lifecycle: 'NEW',
    fingerprint: 'fp-cctv',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    lineAttempted: true,
    lineSent: true,
    now: NOW,
    ...overrides,
  });
  await recordAiObservatoryEntry(env.TRAFFIC_KV, record, { taipeiDate: taipeiDateString(NOW), idempotencyKeyHash: `hash-${overrides.eventId || 'PBS-CCTV-1'}`, now: NOW });
  return record;
}

test('V2.5.1: CCTV success scenario renders imageUrl/imageExpiresAt(過期提示)/imageStrategy, and does not render a cctvSkippedByReason value', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, {
    eventId: 'PBS-CCTV-OK',
    imageUrlPresent: true,
    imageUrl: 'https://traffic-reporter.example.workers.dev/cctv/image/abc123',
    imageExpiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), // 1h in the future relative to NOW
    imageStrategy: 'quad',
    r2ReadbackElapsedMs: 37,
  });

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('https://traffic-reporter.example.workers.dev/cctv/image/abc123'));
  assert.ok(html.includes('尚未過期'), 'an expiresAt in the future relative to render time must say 尚未過期');
  assert.ok(html.includes('quad'));
  assert.ok(html.includes('37'));
});

test('V2.5.1: CCTV failed scenario renders cctvSkippedByReason verbatim (no translation table — order explicitly forbids adding one), and imageUrl/imageStrategy stay absent', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, {
    eventId: 'PBS-CCTV-FAIL',
    imageUrlPresent: false,
    cctvSkippedByReason: 'no-camera',
  });

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('no-camera'), 'the raw reason string is shown verbatim, per order section 二');
});

test('V2.5.1: an expired imageExpiresAt (in the past relative to render time) is labeled 已過期', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, {
    eventId: 'PBS-CCTV-EXPIRED',
    imageUrlPresent: true,
    imageUrl: 'https://traffic-reporter.example.workers.dev/cctv/image/old',
    imageExpiresAt: new Date(NOW.getTime() - 3600_000).toISOString(), // 1h in the past relative to NOW
  });

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('已過期'));
  assert.ok(!html.includes('尚未過期'));
});

test('V2.5.1 backward-compat regression lock: a record built WITHOUT any of the 5 new fields (simulating a pre-V2.5.1, within-48h-TTL record) renders without throwing, showing the existing dash placeholder for all 5', async () => {
  const env = await baseEnv();
  // Deliberately the OLD call shape — no imageUrl/imageExpiresAt/
  // cctvSkippedByReason/imageStrategy/r2ReadbackElapsedMs passed at all,
  // exactly what a record written before this round would look like.
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'PBS-CCTV-OLD',
    lifecycle: 'NEW',
    fingerprint: 'fp-old',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    imageUrlPresent: true,
    lineAttempted: true,
    lineSent: true,
    now: NOW,
  });
  await recordAiObservatoryEntry(env.TRAFFIC_KV, record, { taipeiDate: taipeiDateString(NOW), idempotencyKeyHash: 'hash-old', now: NOW });

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  assert.equal(res.status, 200, 'must render successfully, never throw, for a record missing the new fields');
  const html = await res.text();
  assert.ok(html.includes('CCTV'), 'sanity: the page did render the CCTV section at all');
});

test('V2.5.1: the pre-existing imageUrlPresent YES/NO/UNKNOWN calculation is completely unaffected by the new fields being present', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, { eventId: 'PBS-CCTV-PRESENT-CHECK', imageUrlPresent: true, imageUrl: 'https://x/y', imageStrategy: 'quad' });
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  // renderField('CCTV', ...) still reads record.imageUrlPresent exactly as before — verified by presence of the YES label this file's other tests never had reason to check directly, alongside the new fields now sitting next to it.
  assert.match(html, /CCTV<\/div><div class="value">YES/);
});

// ============================================================================
// V2.6.0 (路況-055, following 路況-054's own plan) — the symmetric Telegram
// section/badge rendering, same seeding approach as the V2.5.1 CCTV tests
// above (buildAiObservatoryRecord()/recordAiObservatoryEntry() directly —
// this round's own new fields are plain booleans with no I/O-dependent
// path, so there is no equivalent test-infrastructure limit to disclose
// here the way V2.5.1's CCTV fields had).
// ============================================================================

test('V2.6.0: Telegram sent scenario renders "Telegram sent: YES" and the ✅ Telegram 已發送 badge, independently of LINE\'s own status', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, {
    eventId: 'PBS-TG-OK',
    lineAttempted: true,
    lineSent: false, // deliberately the OPPOSITE of Telegram, proving no cross-contamination in rendering either
    telegramAttempted: true,
    telegramSent: true,
  });
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.match(html, /Telegram sent<\/div><div class="value">YES/);
  assert.ok(html.includes('✅ Telegram 已發送'));
  assert.match(html, /LINE sent<\/div><div class="value">NO/, 'LINE\'s own field must independently still say NO');
  assert.ok(html.includes('❌ LINE 發送失敗'));
});

test('V2.6.0 symmetric: Telegram failed scenario renders "Telegram sent: NO" and the ❌ Telegram 發送失敗 badge, independently of LINE\'s own status', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, {
    eventId: 'PBS-TG-FAIL',
    lineAttempted: true,
    lineSent: true,
    telegramAttempted: true,
    telegramSent: false,
  });
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.match(html, /Telegram sent<\/div><div class="value">NO/);
  assert.ok(html.includes('❌ Telegram 發送失敗'));
  assert.match(html, /LINE sent<\/div><div class="value">YES/, 'LINE\'s own field must independently still say YES');
  assert.ok(html.includes('✅ LINE 已發送'));
});

test('V2.6.0: Telegram never attempted (e.g. unconfigured) renders "⏭️ Telegram 未發送" and a 未執行原因 field, same convention as LINE\'s own not-attempted state', async () => {
  const env = await baseEnv();
  await seedObservatoryRecord(env, {
    eventId: 'PBS-TG-NONE',
    lineAttempted: true,
    lineSent: true,
    telegramAttempted: false,
    telegramSent: false,
  });
  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.match(html, /Telegram attempted<\/div><div class="value">NO/);
  assert.ok(html.includes('⏭️ Telegram 未發送'));
});

test('V2.6.0 backward-compat regression lock: a record built WITHOUT telegramAttempted/telegramSent (simulating a pre-V2.6.0, within-48h-TTL record) renders without throwing, degrading to the same "未發送" state as a genuinely-never-attempted event', async () => {
  const env = await baseEnv();
  // Deliberately the OLD call shape — no telegramAttempted/telegramSent
  // passed at all, exactly what a record written before this round would
  // look like when read back within its still-live 48h TTL.
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'PBS-TG-OLD',
    lifecycle: 'NEW',
    fingerprint: 'fp-tg-old',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    lineAttempted: true,
    lineSent: true,
    now: NOW,
  });
  await recordAiObservatoryEntry(env.TRAFFIC_KV, record, { taipeiDate: taipeiDateString(NOW), idempotencyKeyHash: 'hash-tg-old', now: NOW });

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  assert.equal(res.status, 200, 'must render successfully, never throw, for a record missing the new Telegram fields');
  const html = await res.text();
  assert.ok(html.includes('⏭️ Telegram 未發送'), 'undefined telegramAttempted/telegramSent must degrade to the same not-attempted display as false/false');
});

// ============================================================================
// V2.7.0 (路況-061, following 路況-060's own plan) — memoryContextFingerprint
// join fix (路況-059's own discovery): loadAiDecisionDetail() used to omit
// memoryContextFingerprint entirely, so ANY event with memoryCandidateCount>0
// was a guaranteed AI-decision-cache miss, silently rendering UNKNOWN / NOT
// RECORDED even though the real decision was persisted under a (different)
// key. Real end-to-end proof below: two sequential PBS pushes for the SAME
// location build up a real memory candidate for the second call, and the
// second call's own real AI reason must now actually appear on the page.
// ============================================================================

test('V2.7.0: a second event with a real memory candidate (memoryCandidateCount>0) correctly joins its OWN AI decision cache entry — no longer UNKNOWN / NOT RECORDED', async () => {
  let callCount = 0;
  const ai = {
    calls: [],
    async run(model, input) {
      callCount += 1;
      this.calls.push({ model, input });
      const parsed = JSON.parse(input.messages[1].content);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      return {
        response: JSON.stringify(
          hasContext
            ? { notify: true, impact: 'HIGH', reason: '第二次真實理由（join修正後應正確顯示）', confidence: 0.87, sameIncident: true, materialChange: true }
            : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }
        ),
      };
    },
  };
  const env = await baseEnv({ AI: ai });
  await handlePbsDebugPush(pushRequest({ body: validPayload({ eventId: 'PBS-MCF-1', fingerprint: 'fp-mcf-1', event: fullEventFields() }) }), env, NOW);
  assert.equal(callCount, 1);

  const later = new Date(NOW.getTime() + 5 * 60_000);
  await handlePbsDebugPush(
    pushRequest({ body: validPayload({ eventId: 'PBS-MCF-2', fingerprint: 'fp-mcf-2', event: fullEventFields(), generatedAt: later.toISOString() }) }),
    env,
    later
  );
  assert.equal(callCount, 2, 'sanity: the second call genuinely reached the AI with a different request (real memory context)');
  const secondUserMsg = JSON.parse(ai.calls[1].input.messages[1].content);
  assert.equal(secondUserMsg.recentIncidents.length, 1, 'sanity: the second call really did carry a memory candidate — this is the exact condition that broke the join before this round');

  const html = await (await handleAiObservatoryView(env, viewRequest(), later)).text();
  assert.ok(html.includes('第二次真實理由（join修正後應正確顯示）'), 'THE FIX: the second event\'s own real AI reason must now be joinable and shown, not UNKNOWN');
  assert.ok(html.includes('0.87'));
});

test('V2.7.0 backward-compat regression lock: a record built WITHOUT memoryContextFingerprint (simulating a pre-V2.7.0, within-48h-TTL record, or one with memoryCandidateCount===0) renders without throwing, degrading to the existing UNKNOWN / NOT RECORDED join-miss display', async () => {
  const env = await baseEnv();
  // Deliberately the OLD call shape — no memoryContextFingerprint passed
  // at all, exactly what a record written before this round would look
  // like when read back within its still-live 48h TTL. Also seed the
  // matching AI decision cache record under the OLD (2-part) hash so a
  // reader can confirm this is a genuine "field absent" case, not merely
  // "nothing was ever cached".
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'PBS-MCF-OLD',
    lifecycle: 'NEW',
    fingerprint: 'fp-mcf-old',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    lineAttempted: true,
    lineSent: true,
    memoryCandidateCount: 0,
    now: NOW,
  });
  await recordAiObservatoryEntry(env.TRAFFIC_KV, record, { taipeiDate: taipeiDateString(NOW), idempotencyKeyHash: 'hash-mcf-old', now: NOW });

  const res = await handleAiObservatoryView(env, viewRequest(), NOW);
  assert.equal(res.status, 200, 'must render successfully, never throw, for a record missing memoryContextFingerprint');
  const html = await res.text();
  assert.ok(html.includes('UNKNOWN / NOT RECORDED'), 'no cache entry exists for this key — must degrade honestly, never fabricate a reason');
});
