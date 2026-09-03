// V2.4.8 — 路況工程部｜V2.4.8 LINE 路況文字編輯與統一排版施工令
// (V2_4_8_AI_LINE_MESSAGE_EDITOR_AND_UNIFIED_PRESENTATION).
//
// Core goal: PBS 警廣 and TDX 高公局／公路局, whatever their raw text
// looks like, all end up on the driver's LINE as one unified "路況播報員"
// voice — short/accurate/clean/scannable/source-labeled. AI is a TEXT
// EDITOR of the event's own already-known content (order section一：
// AI=文字編輯，AI≠事實產生器) — never a second call, never a fact
// generator, and a broken cleanSummary must never take down a real
// notify:true broadcast (order section 十五).
//
// Covers the order's own section 十九 CASE 1-14, exercising the real
// pieces at the level that actually matters for each: pure unit coverage
// for aiDecisionEngine.js's own validation/consistency-check, the real
// shared formatter (messageFormat.js#formatEventMessage) for presentation/
// source-labeling, runAiApprovedPbsBroadcast() for end-to-end LINE text
// with cleanSummary threaded through, and processQueuedPbsEvent()/
// Observatory index for the fallback-safety and trace-page-preview cases.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { runAiApprovedPbsBroadcast } from '../src/traffic/aiApprovedPbsBroadcast.js';
import { validateAiDecisionResponse, cleanSummaryContradictsFacts, CLEAN_SUMMARY_MAX_CHARS } from '../src/pbs/aiDecisionEngine.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { listAiObservatoryEntries } from '../src/pbs/aiObservatoryIndex.js';

const NOW = new Date('2026-09-04T09:00:00+08:00'); // within LINE broadcast hours
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

function createMockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

// The ALREADY-NORMALIZED unified-event shape — used to call
// runAiApprovedPbsBroadcast()/formatEventMessage() directly (both expect
// this shape, never the raw Windows PBS push payload shape).
function pbsAccidentEvent(overrides = {}) {
  return {
    source: 'pbs',
    rawId: 'AI-PBS-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '國道一號北向',
    startKM: '100K+400',
    description: '北上在.新竹系統前.內.2小客車追撞事故',
    blockedLanes: 2,
    updatedAt: '2026-09-04T09:00:00+08:00',
    latitude: 24.8,
    longitude: 121.0,
    ...overrides,
  };
}

// The RAW Windows PBS push payload shape (road/areaNm/direction/comment/
// longitude/latitude/sourceDetail) — used for processQueuedPbsEvent()
// end-to-end tests (source='pbs'), which runs this through
// buildRawPbsRecordFromPush()/normalizePbsEvent() itself, exactly like
// test/tdxUnifiedAiPipeline.test.js's own pbsRawEvent() helper.
function pbsRawPushEvent(overrides = {}) {
  return {
    road: '國道一號', areaNm: '國道一號北向', direction: '北向',
    comment: '國道一號北向100.4公里處2小客車追撞事故', longitude: 121.0, latitude: 24.8, sourceDetail: 'test',
    ...overrides,
  };
}

let priorFetch;
let pushCalls;
beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  pushCalls = [];
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      pushCalls.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = priorFetch;
  resetTdxTokenCache();
});

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = createMockKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, ENROLLED_AT);
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, ...overrides };
}

// =======================================================================
// CASE 1/2/3 — PBS raw text (messy punctuation / typo / long text) ->
// cleanSummary is used, canonical facts (road/direction/KM) unchanged.
// =======================================================================

test('CASE 1: PBS raw text with messy punctuation -> cleanSummary shown, facts (road/direction/KM) unchanged', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = pbsAccidentEvent({ description: '北上在.新竹系統前.內.2小客車追撞事故' });
  const cleanSummary = '新竹系統前發生 2 輛小客車追撞，影響通行。';
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW, cleanSummary });
  const text = result.completedProducts[0].text;
  assert.match(text, /新竹系統前發生 2 輛小客車追撞，影響通行。/);
  assert.match(text, /100K\+400/); // canonical KM unchanged
  assert.match(text, /北向/); // canonical direction unchanged
  assert.doesNotMatch(text, /北上在\.新竹系統前/); // the messy raw text itself is not shown verbatim anymore
});

test('CASE 2: PBS obvious typo corrected by AI -> road/KM/direction still exactly the canonical values, never AI-edited', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = pbsAccidentEvent({ road: '國道一號', direction: '北向', startKM: '100K+400', description: '北上在新竹系筒前2小客车追撞' });
  const cleanSummary = '新竹系統前發生 2 輛小客車追撞。';
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW, cleanSummary });
  const text = result.completedProducts[0].text;
  assert.match(text, /國1 北向/);
  assert.match(text, /100K\+400/);
  assert.match(text, /新竹系統前發生 2 輛小客車追撞。/);
});

test('CASE 3: PBS long rambling raw text -> condensed to a short 1-2 sentence cleanSummary', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const longRaw = '南下在.過湖口.路肩.多塊輪胎皮.散落.現場已有巡邏車到場處理.請用路人小心慢行.注意安全.避免緊急煞車.以免發生二次事故';
  const event = pbsAccidentEvent({ type: 'other', description: longRaw, blockedLanes: null });
  const cleanSummary = '湖口路段路肩有多塊輪胎皮散落，請留意。';
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW, cleanSummary });
  const text = result.completedProducts[0].text;
  assert.match(text, /湖口路段路肩有多塊輪胎皮散落，請留意。/);
  assert.doesNotMatch(text, /避免緊急煞車/); // the long raw text itself is not dumped
  assert.ok(cleanSummary.length <= 60);
});

// =======================================================================
// CASE 4 — TDX machine-style raw text -> natural Chinese cleanSummary.
// =======================================================================

test('CASE 4: TDX machine-style raw description -> cleanSummary reads as natural Chinese, canonical facts unaffected', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = { source: 'freeway', rawId: 'TDX-1', type: 'accident', road: '國道一號', direction: '北向', startKM: '100K+400', description: 'EventType=事故;EventSubType=一般事故;BlockedLanes=2', blockedLanes: 2, updatedAt: '2026-09-04T09:00:00+08:00', longitude: 120.9686, latitude: 24.8066 };
  const cleanSummary = '國道一號北向發生一般交通事故，請注意行車安全。';
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW, cleanSummary });
  const text = result.completedProducts[0].text;
  assert.match(text, /國道一號北向發生一般交通事故，請注意行車安全。/);
  assert.doesNotMatch(text, /EventType=/);
});

// =======================================================================
// CASE 5 — KM must still be exactly canonical, regardless of cleanSummary.
// =======================================================================

test('CASE 5: 國1 北向 100K+400 -> final LINE message still shows exactly 100K+400', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = pbsAccidentEvent({ startKM: '100K+400' });
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW, cleanSummary: '新竹系統前發生追撞事故。' });
  const text = result.completedProducts[0].text;
  assert.match(text, /100K\+400/);
});

// =======================================================================
// CASE 6 — blockedLanes must never be re-generated/altered by AI text.
// =======================================================================

test('CASE 6: blockedLanes=2 canonical -> AI text claiming a wrong lane count is rejected (cleanSummaryContradictsFacts), formatter still shows the real count deterministically', async () => {
  const candidate = { direction: '北向', blockedLanes: 2 };
  assert.equal(cleanSummaryContradictsFacts('新竹系統前封閉1車道，請小心。', candidate), true);
  assert.equal(cleanSummaryContradictsFacts('新竹系統前發生追撞事故，影響通行。', candidate), false); // no lane number stated at all -> not a contradiction

  // End to end: a contradicting cleanSummary must never reach the driver —
  // caller (aiDecisionEngine.js#resolveAiDecision) nulls it before this
  // point is ever reached; simulate that by passing null here, proving
  // the deterministic blockedLanesLine still shows the REAL count.
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = pbsAccidentEvent({ blockedLanes: 2 });
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW, cleanSummary: null });
  const text = result.completedProducts[0].text;
  assert.match(text, /封閉2車道/);
});

test('CASE 6b: a direction word in cleanSummary that contradicts the canonical direction is flagged as a contradiction', () => {
  assert.equal(cleanSummaryContradictsFacts('南向發生事故', { direction: '北向' }), true);
  assert.equal(cleanSummaryContradictsFacts('北向發生事故', { direction: '北向' }), false);
});

// =======================================================================
// CASE 7 — cleanSummary invalid (missing/too long/schema issue) ->
// fallback to the existing deterministic formatter; LINE still sends.
// =======================================================================

test('CASE 7: cleanSummary missing from the AI response -> decision.cleanSummary is null, fallback formatter used, notify=true still reaches LINE normally', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '重大事故', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = pbsRawPushEvent();
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'CASE7-1', lifecycle: 'NEW', fingerprint: 'fp-case7' });
  const message = { source: 'pbs', eventId: 'CASE7-1', lifecycle: 'NEW', fingerprint: 'fp-case7', generatedAt: NOW.toISOString(), event, requestId: 'req-case7', idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 };

  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(pushCalls.length, 1); // LINE was NOT swallowed just because cleanSummary was absent
  const text = pushCalls[0].messages[0].text;
  assert.match(text, /事故影響通行/); // the pre-V2.4.8 deterministic fallback line is present
});

test('CASE 7b: cleanSummary longer than CLEAN_SUMMARY_MAX_CHARS -> validateAiDecisionResponse nulls it, never invalidates the whole decision', () => {
  const tooLong = '事'.repeat(CLEAN_SUMMARY_MAX_CHARS + 1);
  const result = validateAiDecisionResponse(JSON.stringify({ notify: true, impact: 'HIGH', reason: '事故', confidence: 0.9, cleanSummary: tooLong }));
  assert.equal(result.ok, true);
  assert.equal(result.decision.cleanSummary, null);
});

// =======================================================================
// CASE 8/9 — TDX source labeling.
// =======================================================================

test('CASE 8: TDX freeway -> 通報：【TDX】高公局', () => {
  const text = formatEventMessage({ source: 'freeway', type: 'accident', road: '國道一號', direction: '北向', startKM: '10K+000', description: '事故', updatedAt: NOW.toISOString() });
  assert.match(text, /通報：【TDX】高公局/);
});

test('CASE 9: TDX highway -> 通報：【TDX】公路局', () => {
  const text = formatEventMessage({ source: 'highway', type: 'accident', road: '台1線', direction: '南向', startKM: '10K+000', description: '事故', updatedAt: NOW.toISOString() });
  assert.match(text, /通報：【TDX】公路局/);
});

// =======================================================================
// CASE 10/11/12 — PBS source-detail alias mapping.
// =======================================================================

test('CASE 10: PBS + sourceDetail=高速公路局北區交控中心 -> 通報：【警廣】高公局', () => {
  const text = formatEventMessage({ source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '10K+000', description: '事故', sourceDetail: '高速公路局北區交控中心', updatedAt: NOW.toISOString() });
  assert.match(text, /通報：【警廣】高公局/);
});

test('CASE 11: PBS + sourceDetail=熱心聽眾 -> 通報：【警廣】熱心聽眾', () => {
  const text = formatEventMessage({ source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '10K+000', description: '事故', sourceDetail: '熱心聽眾', updatedAt: NOW.toISOString() });
  assert.match(text, /通報：【警廣】熱心聽眾/);
});

test('CASE 12: PBS with no reliable sourceDetail -> 通報：【警廣】 only, AI never invents a unit', () => {
  const text = formatEventMessage({ source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '10K+000', description: '事故', updatedAt: NOW.toISOString() });
  assert.match(text, /通報：【警廣】$/m);
  assert.doesNotMatch(text, /通報：【警廣】\S/); // nothing after the fixed prefix
});

test('CASE 12b: PBS sourceDetail literally "警廣" (the pipeline name itself) also collapses to the bare 【警廣】 prefix, never "【警廣】警廣"', () => {
  const text = formatEventMessage({ source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '10K+000', description: '事故', sourceDetail: '警廣', updatedAt: NOW.toISOString() });
  assert.doesNotMatch(text, /【警廣】警廣/);
  assert.match(text, /通報：【警廣】$/m);
});

// =======================================================================
// CASE 13 — Observatory trace preview: rawDescription/cleanSummary/final
// LINE preview all present and correct.
// =======================================================================

test('CASE 13: Observatory record preserves rawComment (raw description), cleanSummary, and finalRenderedMessage together', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '重大事故', confidence: 0.9, cleanSummary: '新竹系統前發生追撞事故，影響通行。' }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = pbsRawPushEvent({ comment: '北上在.新竹系統前.內.2小客車追撞事故' });
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'CASE13-1', lifecycle: 'NEW', fingerprint: 'fp-case13' });
  const message = { source: 'pbs', eventId: 'CASE13-1', lifecycle: 'NEW', fingerprint: 'fp-case13', generatedAt: NOW.toISOString(), event, requestId: 'req-case13', idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 };

  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.ok, true);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'CASE13-1');
  assert.ok(record);
  assert.match(record.rawComment, /北上在\.新竹系統前\.內\.2小客車追撞事故/);
  assert.equal(record.cleanSummary, '新竹系統前發生追撞事故，影響通行。');
  assert.match(record.finalRenderedMessage, /新竹系統前發生追撞事故，影響通行。/);
  assert.match(record.finalRenderedMessage, /通報：【警廣】/);
});

// =======================================================================
// CASE 14 — notify decision itself is completely unaffected by this round.
// =======================================================================

test('CASE 14: PBS notify=false decision is unaffected by cleanSummary presence/absence — this round never touches the notify verdict itself', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '影響輕微', confidence: 0.8, cleanSummary: '路段車流略多。' }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = pbsRawPushEvent({ comment: '國道一號北向車多壅塞' });
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'pbs', eventId: 'CASE14-1', lifecycle: 'NEW', fingerprint: 'fp-case14' });
  const message = { source: 'pbs', eventId: 'CASE14-1', lifecycle: 'NEW', fingerprint: 'fp-case14', generatedAt: NOW.toISOString(), event, requestId: 'req-case14', idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 };

  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_FALSE');
  assert.equal(pushCalls.length, 0); // notify=false -> 0 LINE, exactly as before this round
});

test('CASE 14b: a TDX notify=true decision (Phase E, NOTIFY switch on) also reaches LINE unaffected by cleanSummary, with the correct TDX reporter label', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '重大事故', confidence: 0.9, cleanSummary: '國道一號北向發生事故，請小心慢行。' }) }; } };
  const env = await baseEnv({ AI: ai, TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED: 'true' });
  const event = { source: 'freeway', rawId: 'CASE14B-1', type: 'accident', road: '國道一號', direction: '北向', startKM: '10K+000', description: '事故', updatedAt: NOW.toISOString(), latitude: 24.8, longitude: 121.0 };
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'freeway', eventId: 'CASE14B-1', lifecycle: 'NEW', fingerprint: 'fp-case14b' });
  const message = { source: 'freeway', eventId: 'CASE14B-1', lifecycle: 'NEW', fingerprint: 'fp-case14b', generatedAt: NOW.toISOString(), event, requestId: 'req-case14b', idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 };

  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(pushCalls.length, 1);
  const text = pushCalls[0].messages[0].text;
  assert.match(text, /國道一號北向發生事故，請小心慢行。/);
  assert.match(text, /通報：【TDX】高公局/);
});
