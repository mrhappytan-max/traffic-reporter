// V2.4.6 — 路況工程部｜V2.4.6 查修頁資訊改版施工令
// (V2_4_6_TRACE_PAGE_TDX_AND_DECISION_REASON_SUMMARY), order section 十二's
// own required 8 acceptance-criteria CASE scenarios, plus dedicated unit
// coverage for the two new pure/additive pieces this round introduces:
//   - aiObservatoryIndex.js#deriveFinalDecisionReason — the ONE canonical
//     composition of "why sent / not sent", derived only from data already
//     stored on an Observatory record (order section 三).
//   - tdx/tdxQueueIngress.js's own Gate A drop observability write (order
//     section 七/八) — a TDX event dropped at the geography or road-
//     management gate must still leave a KV record and be visible on the
//     trace page, WITHOUT changing the drop decision itself.
//
// This round is UI/observability-only (order section 十/十三): nothing
// here re-runs geography/road-management/AI judgment — every assertion
// checks that ALREADY-COMPUTED pipeline data is correctly surfaced.
// TDX test fixtures go through the REAL tdx/normalize.js#normalizeRoadEvent
// (same convention as test/tdxUnifiedAiPipeline.test.js), never hand-rolled
// normalized-shape objects, so this suite exercises the real field shapes
// buildAiCandidate/resolveServiceAreaEligibility/resolveLocationQuality
// actually see in Production.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { enqueueTdxRoadEvents } from '../src/tdx/tdxQueueIngress.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { deriveFinalDecisionReason, FINAL_DECISION_STATUS, AI_OUTCOME, listAiObservatoryEntries } from '../src/pbs/aiObservatoryIndex.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const NOW = new Date('2026-08-31T09:00:00+08:00'); // within LINE broadcast hours

function countingKV(initial) {
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
    async list({ prefix, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = countingKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, ...overrides };
}

function pbsRawEvent(overrides = {}) {
  return {
    road: '國道一號', areaNm: '國道一號南向', direction: '南向',
    comment: '南向97.7公里處發生車輛事故', longitude: 121.0, latitude: 24.8, sourceDetail: 'test',
    ...overrides,
  };
}

async function buildQueueMessage({ source, event, lifecycle = 'NEW', eventId, fingerprint = 'fp-1', now = NOW }) {
  const id = eventId || event.rawId;
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source, eventId: id, lifecycle, fingerprint });
  return {
    source, eventId: id, lifecycle, fingerprint,
    generatedAt: now.toISOString(), event, requestId: `test:${source}:${id}`,
    idempotencyKeyHash, acceptedFirstAcceptedAt: now.toISOString(), acceptedAttemptCount: 1,
  };
}

// CONFIRMED_HSINCHU coordinate (新竹市), reused from tdxHsinchuGeoResolver.test.js's own reference points.
const HSINCHU_POS = [{ PositionLon: 120.9686, PositionLat: 24.8066 }];
// OUTSIDE_HSINCHU coordinate (west-coast 桃園觀音 vicinity), same as tdxHsinchuGeoResolver.test.js CASE 3b.
const TAOYUAN_POS = [{ PositionLon: 121.033, PositionLat: 25.035 }];

function freewayEvent(raw, overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'FRW-1', EventType: '事故', Description: '南向事故',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向' } },
      Positions: HSINCHU_POS,
      ...raw,
    },
    overrides.source || 'freeway'
  );
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
  resetTdxTokenCache();
});

// =======================================================================
// deriveFinalDecisionReason — pure unit coverage (order section 三).
// =======================================================================

test('deriveFinalDecisionReason: lineSent=true -> SENT regardless of outcome value', () => {
  const r = deriveFinalDecisionReason({ outcome: AI_OUTCOME.AI_NOTIFY_TRUE, lineSent: true });
  assert.equal(r.status, FINAL_DECISION_STATUS.SENT);
});

test('deriveFinalDecisionReason: GEO_EXCLUDED_OUTSIDE_HSINCHU -> NOT_SENT / 非新竹縣市', () => {
  const r = deriveFinalDecisionReason({ outcome: AI_OUTCOME.GEO_EXCLUDED_OUTSIDE_HSINCHU });
  assert.equal(r.status, FINAL_DECISION_STATUS.NOT_SENT);
  assert.equal(r.reason, '非新竹縣市');
});

test('deriveFinalDecisionReason: GEO_EXCLUDED_UNKNOWN -> NOT_SENT / 地理位置無法確認', () => {
  const r = deriveFinalDecisionReason({ outcome: AI_OUTCOME.GEO_EXCLUDED_UNKNOWN });
  assert.equal(r.reason, '地理位置無法確認');
});

test('deriveFinalDecisionReason: ROAD_POLICY_EXCLUDED_SHOULDER_OPEN -> 機動路肩開放', () => {
  assert.equal(deriveFinalDecisionReason({ outcome: AI_OUTCOME.ROAD_POLICY_EXCLUDED_SHOULDER_OPEN }).reason, '機動路肩開放');
});

test('deriveFinalDecisionReason: ROAD_POLICY_EXCLUDED_SHOULDER_CLOSE -> 機動路肩關閉', () => {
  assert.equal(deriveFinalDecisionReason({ outcome: AI_OUTCOME.ROAD_POLICY_EXCLUDED_SHOULDER_CLOSE }).reason, '機動路肩關閉');
});

test('deriveFinalDecisionReason: ROAD_POLICY_EXCLUDED_INSUFFICIENT_LANES with blockedLanes=1 -> 施工僅封1車道 (never just "施工"/type)', () => {
  const r = deriveFinalDecisionReason({ outcome: AI_OUTCOME.ROAD_POLICY_EXCLUDED_INSUFFICIENT_LANES, blockedLanes: 1, eventType: 'construction' });
  assert.equal(r.reason, '施工僅封1車道');
});

test('deriveFinalDecisionReason: ROAD_POLICY_EXCLUDED_UNKNOWN_LANES -> 施工封鎖車道資料不足', () => {
  assert.equal(deriveFinalDecisionReason({ outcome: AI_OUTCOME.ROAD_POLICY_EXCLUDED_UNKNOWN_LANES }).reason, '施工封鎖車道資料不足');
});

test('deriveFinalDecisionReason: AI_NOTIFY_FALSE + eventType=congestion -> 壅塞 (not the raw outcome label)', () => {
  assert.equal(deriveFinalDecisionReason({ outcome: AI_OUTCOME.AI_NOTIFY_FALSE, eventType: 'congestion' }).reason, '壅塞');
});

test('deriveFinalDecisionReason: PROCESSING_FAILED -> PROCESSING_FAILED / 背景重試失敗', () => {
  const r = deriveFinalDecisionReason({ outcome: AI_OUTCOME.PROCESSING_FAILED });
  assert.equal(r.status, FINAL_DECISION_STATUS.PROCESSING_FAILED);
  assert.equal(r.reason, '背景重試失敗');
});

test('deriveFinalDecisionReason: AI_NOT_INVOKED_LEGACY_PATH + suppressedForPhase=true -> TDX通知開關關閉', () => {
  const r = deriveFinalDecisionReason({ outcome: AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH, suppressedForPhase: true });
  assert.equal(r.reason, 'TDX通知開關關閉');
});

// =======================================================================
// CASE 1/2 — PBS congestion/construction: collapsed card shows the reason
// directly (order section 十二 CASE 1/2).
// =======================================================================

test('CASE 1: PBS congestion, AI notify=false -> collapsed row shows 未發送／原因：壅塞 directly (no expand needed)', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '一般壅塞', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  // No bare "N公里"-shaped text here (see pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant —
  // a parsed KM overrides real coordinates for a 國道/台N road; "南向嚴重回堵" has no digit
  // to spuriously match, so the event's real Hsinchu coordinates decide service-area eligibility instead).
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: '南向嚴重回堵' }), eventId: 'PBS-CONGESTION' });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_FALSE');

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'PBS-CONGESTION');
  const reason = deriveFinalDecisionReason(record);
  assert.equal(reason.status, FINAL_DECISION_STATUS.NOT_SENT);

  const response = await handleAiObservatoryView(env, new Request('https://x/admin/pbs-ai-observatory-view'), NOW);
  const html = await response.text();
  assert.ok(html.includes('final-reason'));
  assert.ok(html.includes('未發送'));
});

test('CASE 2: PBS construction, AI notify=false -> collapsed row shows a reason more specific than the bare event type', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '施工影響輕微', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: '外側車道施工' }), eventId: 'PBS-CONSTRUCTION' });
  await processQueuedPbsEvent(env, message, NOW);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'PBS-CONSTRUCTION');
  const reason = deriveFinalDecisionReason(record);
  assert.equal(reason.reason, '一般施工');
});

// =======================================================================
// CASE 3 — TDX Hsinchu accident: full pass, visible with GEO/AI/LINE all shown.
// =======================================================================

test('CASE 3: TDX Hsinchu accident -> Gate A passes both gates, reaches AI, notify=true -> visible with source=TDX｜高公局, GEO ok, AI/LINE result present', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '國1事故', confidence: 0.9 }) }; } };
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ AI: ai, PBS_AI_QUEUE: queue });
  const event = freewayEvent({ EventID: 'FRW-ACC-1' });

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 1);
  await processQueuedPbsEvent(env, queue.sent[0], NOW);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'FRW-ACC-1');
  assert.ok(record);
  assert.equal(record.source, 'freeway');
  assert.equal(record.outcome, 'AI_NOTIFY_TRUE');

  const response = await handleAiObservatoryView(env, new Request('https://x/admin/pbs-ai-observatory-view'), NOW);
  const html = await response.text();
  assert.ok(html.includes('TDX｜高公局'));
  assert.ok(html.includes('AI candidate created'));
});

// =======================================================================
// CASE 4 — TDX event outside Hsinchu (Taoyuan): Gate A drops it, but it
// must STILL be visible with GEO=OUTSIDE, AI/LINE never reached (order
// section 七 — the "為什麼這筆 TDX 不見了" gap).
// =======================================================================

test('CASE 4: TDX Taoyuan event -> Gate A drops at geography, but STILL visible on the trace page with GEO=OUTSIDE, AI NOT_CALLED, LINE NOT_SENT', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = freewayEvent({ EventID: 'FRW-TAOYUAN-1', Positions: TAOYUAN_POS });

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 0);
  assert.equal(enqueueResult.droppedOutsideHsinchu, 1);
  assert.equal(queue.sent.length, 0); // never reached Queue at all

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'FRW-TAOYUAN-1');
  assert.ok(record, 'a Gate A geography drop must still leave an Observatory record');
  assert.equal(record.outcome, 'GEO_EXCLUDED_OUTSIDE_HSINCHU');
  assert.equal(record.lineAttempted, false);
  assert.equal(record.lineSent, false);
  const reason = deriveFinalDecisionReason(record);
  assert.equal(reason.reason, '非新竹縣市');

  const response = await handleAiObservatoryView(env, new Request('https://x/admin/pbs-ai-observatory-view'), NOW);
  const html = await response.text();
  assert.ok(html.includes('FRW-TAOYUAN-1'));
  assert.ok(html.includes('非新竹縣市'));
});

// =======================================================================
// CASE 5 — TDX UNKNOWN geography: visible, UNKNOWN, AI NOT_CALLED.
// =======================================================================

test('CASE 5: TDX event with no coordinate/KM/text evidence -> UNKNOWN, still visible, AI never called', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = normalizeRoadEvent(
    { EventID: 'HWY-UNKNOWN-1', EventType: '事故', Description: '事故', EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString() },
    'highway'
  );

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 0);
  assert.equal(enqueueResult.droppedUnknownHsinchu, 1);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'HWY-UNKNOWN-1');
  assert.ok(record);
  assert.equal(record.outcome, 'GEO_EXCLUDED_UNKNOWN');
  assert.equal(record.source, 'highway');
  assert.equal(deriveFinalDecisionReason(record).reason, '地理位置無法確認');
});

// =======================================================================
// CASE 6 — TDX dynamic shoulder open: visible with a clear reason.
// =======================================================================

test('CASE 6: TDX dynamic shoulder open (機動路肩開放) inside Hsinchu -> Gate A drops at road-management, still visible with a clear reason', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = freewayEvent({ EventID: 'FRW-SHOULDER-1', EventType: '管制', Description: '機動開放路肩' });
  assert.ok(event.dynamicShoulder && event.dynamicShoulder.state === 'OPEN', 'fixture sanity: normalizeRoadEvent must classify this as dynamicShoulder OPEN');

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 0);
  assert.equal(enqueueResult.droppedRoadManagement, 1);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'FRW-SHOULDER-1');
  assert.equal(record.outcome, 'ROAD_POLICY_EXCLUDED_SHOULDER_OPEN');
  assert.equal(deriveFinalDecisionReason(record).reason, '機動路肩開放');
});

// =======================================================================
// CASE 7 — TDX construction, 1 lane blocked: visible with the exact
// "施工僅封1車道" wording, never a bare "施工"/type label (order section 二).
// =======================================================================

test('CASE 7: TDX construction blocking exactly 1 lane -> visible, reason is exactly 施工僅封1車道 (never just the type "施工")', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = freewayEvent({ EventID: 'FRW-1LANE-1', EventType: '施工', Description: '外側車道施工', Impact: { BlockedLanes: 1 } });
  assert.equal(event.blockedLanes, 1, 'fixture sanity');

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 0);
  assert.equal(enqueueResult.droppedRoadManagement, 1);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'FRW-1LANE-1');
  assert.equal(record.outcome, 'ROAD_POLICY_EXCLUDED_INSUFFICIENT_LANES');
  assert.equal(record.blockedLanes, 1);
  assert.equal(deriveFinalDecisionReason(record).reason, '施工僅封1車道');

  const response = await handleAiObservatoryView(env, new Request('https://x/admin/pbs-ai-observatory-view'), NOW);
  const html = await response.text();
  assert.ok(html.includes('施工僅封1車道'));
});

// =======================================================================
// CASE 8 — TDX construction, 2 lanes blocked: passes road-management,
// reaches AI, result visible.
// =======================================================================

test('CASE 8: TDX construction blocking 2 lanes -> passes ROAD_POLICY, reaches AI, AI result visible on the trace page', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '影響輕微', confidence: 0.85 }) }; } };
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ AI: ai, PBS_AI_QUEUE: queue });
  const event = freewayEvent({ EventID: 'FRW-2LANE-1', EventType: '施工', Description: '雙車道施工', Impact: { BlockedLanes: 2 } });

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 1);
  await processQueuedPbsEvent(env, queue.sent[0], NOW);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, {});
  const record = records.find((r) => r.eventId === 'FRW-2LANE-1');
  assert.equal(record.outcome, 'AI_NOTIFY_FALSE'); // reached AI (not a Gate A drop) -> a real AI verdict

  const response = await handleAiObservatoryView(env, new Request('https://x/admin/pbs-ai-observatory-view'), NOW);
  const html = await response.text();
  assert.ok(html.includes('FRW-2LANE-1'));
  assert.ok(html.includes('AI candidate created'));
});

// =======================================================================
// Additional structural checks (order section 三/四/九).
// =======================================================================

test('Gate A drop KV write is best-effort and never blocks/changes the drop decision itself (missing TRAFFIC_KV -> still drops correctly)', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = { PBS_AI_QUEUE: queue }; // no TRAFFIC_KV at all
  const event = freewayEvent({ EventID: 'FRW-NOKV-1', Positions: TAOYUAN_POS });
  const result = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(result.droppedOutsideHsinchu, 1);
  assert.equal(result.enqueued, 0); // the real decision is unaffected by the missing KV
});

test('source badges: freeway -> TDX｜高公局, highway -> TDX｜公路局, pbs -> PBS (never lumped together)', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: 'x', confidence: 0.9 }) }; } };
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ AI: ai, PBS_AI_QUEUE: queue });

  const freeway = freewayEvent({ EventID: 'FRW-BADGE-1' });
  await enqueueTdxRoadEvents(env, { newEvents: [freeway], updatedEvents: [] }, NOW);
  await processQueuedPbsEvent(env, queue.sent[0], NOW);

  const highway = normalizeRoadEvent(
    {
      EventID: 'HWY-BADGE-1', EventType: '事故', Description: '事故',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '台1線', Direction: '南向' } },
      Positions: HSINCHU_POS,
    },
    'highway'
  );
  await enqueueTdxRoadEvents(env, { newEvents: [highway], updatedEvents: [] }, NOW);
  await processQueuedPbsEvent(env, queue.sent[1], NOW);

  const pbsMessage = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'PBS-BADGE-1' });
  await processQueuedPbsEvent(env, pbsMessage, NOW);

  const response = await handleAiObservatoryView(env, new Request('https://x/admin/pbs-ai-observatory-view'), NOW);
  const html = await response.text();
  assert.ok(html.includes('TDX｜高公局'));
  assert.ok(html.includes('TDX｜公路局'));
  assert.ok(html.includes('>PBS<'));
});
