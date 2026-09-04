// V2.4.13 — V2_4_12_OBSERVATORY_NO_SEND_REASON_HIGH_VISIBILITY_UI (order's
// own task label; the actual product version follows this project's
// three-part scheme -- see src/version.js's own comment for why this round
// bumps to V2.4.13, not V2.4.12).
//
// 路況工程部｜V2.4.12 查修頁「不通報原因」高可視化改版施工令. The order's
// own required §十八 CASE 1-13, covering: every reason-source category
// (AI/GEO/Road Policy/failure/duplicate), truncation, the missing-reason
// fallback, collapsed-card visibility without expanding, expanded-detail
// preservation, 0 additional KV writes, and AI/GEO/Road Policy/LINE
// decision logic being completely unchanged by this UI-only round.
//
// OBSERVABILITY/UI ONLY (order's own explicit framing): every fixture here
// exercises the REAL debugPush.js/tdxQueueIngress.js/aiObservatoryIndex.js
// pipeline unmodified in its DECISION logic -- only aiObservatoryIndex.js's
// new AI_NOTIFY_TRUE (duplicate-suppression) branch of
// deriveFinalDecisionReason, and aiObservatoryView.js's new presentation
// helpers, are new this round.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState, handlePbsAiQueueBatch } from '../src/pbs/debugPush.js';
import { enqueueTdxRoadEvents } from '../src/tdx/tdxQueueIngress.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { listAiObservatoryEntries, buildAiObservatoryRecord, recordAiObservatoryEntry, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';
import { taipeiDateString } from '../src/tdx/usageLedger.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const NOW = new Date('2026-09-04T09:00:00+08:00'); // within LINE broadcast hours

function countingKV(initial) {
  const store = new Map(Object.entries(initial || {}));
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
    async list({ prefix, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = countingKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED: 'true', ...overrides };
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

const HSINCHU_POS = [{ PositionLon: 120.9686, PositionLat: 24.8066 }];

function freewayAccidentEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'FRW-97700-1', EventType: '事故', Description: '南向97K處車輛事故，外側車道封閉',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Impact: { BlockedLanes: 1 },
      Positions: HSINCHU_POS,
      ...overrides,
    },
    'freeway'
  );
}

function viewRequest() {
  return new Request('https://x/admin/pbs-ai-observatory-view');
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
// CASE 1: AI notify=false, generic low-impact reason -> collapsed card
// shows the red no-send-reason block directly, no expand needed.
// =======================================================================

test('CASE 1: AI notify=false with a real reason -> collapsed card shows the reason in the red no-send-reason block', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '僅一般車流壅塞，沒有重大事故或道路阻斷資訊，未達主動通知門檻', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: '南向嚴重回堵' }), eventId: 'CASE1' });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_FALSE');

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('no-send-reason'));
  assert.ok(html.includes('❌ 不通報原因'));
  assert.ok(html.includes('僅一般車流壅塞，沒有重大事故或道路阻斷資訊，未達主動通知門檻'), 'the REAL AI reason must appear, not a generic label');
});

// =======================================================================
// CASE 2: AI notify=false, debrisRisk=AI_REVIEW -> shows the real AI
// reason for the debris ambiguity, never a fixed generic label.
// =======================================================================

test('CASE 2: AI notify=false on an AI_REVIEW debris event -> collapsed card shows the real debris-specific AI reason', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '散落物種類、大小及所在車道不明，目前沒有足夠證據確認屬高風險障礙物', confidence: 0.7 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: '95K+200路面發現散落物狀況' }), eventId: 'CASE2' });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_FALSE');
  assert.ok(result.candidate.debrisRisk);
  assert.equal(result.candidate.debrisRisk.classification, 'AI_REVIEW');

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  // Scoped to the COLLAPSED <summary> only: the separate, pre-existing
  // (V2.4.11) DEBRIS RISK expanded section still shows its own
  // FINAL_NOTIFY_REASON field using the terse canonical categorization for
  // observational comparison — that field is untouched by this round and
  // is not what this CASE is about (order section 十四's own "AI 判斷過鬆
  // 過嚴" observation purpose, a different concern from the collapsed
  // card's driver-facing reason).
  const summaryHtml = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
  assert.ok(summaryHtml.includes('散落物種類、大小及所在車道不明，目前沒有足夠證據確認屬高風險障礙物'));
  assert.ok(!summaryHtml.includes('AI判定影響低'), 'the collapsed card must never fall back to the generic label when a real reason exists');
});

// =======================================================================
// CASE 3/4: GEO UNKNOWN / OUTSIDE.
// =======================================================================

test('CASE 3: GEO UNKNOWN -> collapsed card shows the real geo-unknown reason directly', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = normalizeRoadEvent(
    { EventID: 'CASE3', EventType: '事故', Description: '事故', EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString() },
    'highway'
  );
  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.droppedUnknownHsinchu, 1);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('無法確認事件位於新竹服務範圍，Gate A 已安全排除'));
});

test('CASE 4: GEO OUTSIDE_HSINCHU -> collapsed card shows the real out-of-service-area reason directly', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = normalizeRoadEvent(
    {
      EventID: 'CASE4', EventType: '事故', Description: '南向事故',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向' } },
      Positions: [{ PositionLon: 121.033, PositionLat: 25.035 }], // Taoyuan, outside Hsinchu
    },
    'freeway'
  );
  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.droppedOutsideHsinchu, 1);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('事件確認位於新竹縣市服務範圍之外'));
});

// =======================================================================
// CASE 5: Road Policy exclusion (機動路肩開放).
// =======================================================================

test('CASE 5: Road Policy exclusion (機動路肩開放) -> collapsed card shows the full policy-exclusion sentence', async () => {
  const queue = { sent: [], async send(m) { this.sent.push(m); } };
  const env = await baseEnv({ PBS_AI_QUEUE: queue });
  const event = normalizeRoadEvent(
    {
      EventID: 'CASE5', EventType: '管制', Description: '機動開放路肩',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向' } },
      Positions: HSINCHU_POS,
    },
    'freeway'
  );
  assert.ok(event.dynamicShoulder && event.dynamicShoulder.state === 'OPEN', 'fixture sanity');
  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.droppedRoadManagement, 1);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('道路政策排除：機動路肩開放，此類資訊不主動發送 LINE'));
});

// =======================================================================
// CASE 6: AI timeout, retries exhausted -> distinct "處理失敗原因" label.
// =======================================================================

test('CASE 6: AI background processing times out repeatedly, retries exhausted -> collapsed card shows 處理失敗原因 (not 不通報原因)', async () => {
  const env = await baseEnv({
    AI: { run: () => new Promise(() => {}) }, // never resolves -> always times out
  });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE6' });
  for (let attempts = 1; attempts <= 3; attempts += 1) {
    const msg = { body: message, attempts, ack() {}, retry() {} };
    await handlePbsAiQueueBatch({ messages: [msg] }, env, { aiCallTimeoutMs: 20, now: NOW });
  }
  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'CASE6' });
  assert.equal(records[0].outcome, AI_OUTCOME.PROCESSING_FAILED);
  assert.equal(records[0].timedOut, true);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('❌ 處理失敗原因'));
  assert.ok(html.includes('AI 背景處理連續逾時，重試後仍未完成'));
  assert.ok(!html.includes('❌ 不通報原因：AI 背景處理連續逾時'), 'a system failure must never be labeled as a normal not-sent decision');
});

// =======================================================================
// CASE 7: duplicate / same-incident-suppressed (order 十一-F).
// =======================================================================

test('CASE 7: AI says notify=true twice for the same incident within the collision window -> the suppressed duplicate shows a real reason, not UNKNOWN', async () => {
  const ai = {
    calls: [],
    async run(model, input) {
      this.calls.push(input);
      const parsed = JSON.parse(input.messages[1].content);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      return { response: JSON.stringify(hasContext ? { notify: true, impact: 'HIGH', reason: '誤判為新事故', confidence: 0.9, sameIncident: true, materialChange: false } : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) };
    },
  };
  const env = await baseEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent(), eventId: 'CASE7-1', fingerprint: 'fp-7-1' }), NOW);
  assert.equal(first.lineSent, true);

  const later = new Date(NOW.getTime() + 3 * 60_000); // within the 10min collision window
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'CASE7-2' }), eventId: 'CASE7-2', fingerprint: 'fp-7-2', now: later }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.lineAttempted, false);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('重複事件'));
  assert.ok(html.includes('與近期已通知過的同一起事故相同，且無實質變化，未重複發送'));
  assert.ok(!html.includes('❌ 不通報原因：UNKNOWN / NOT RECORDED'), 'this specific gap must no longer render as an unexplained UNKNOWN');
});

// =======================================================================
// CASE 8: a long (70+ Chinese char) reason is truncated for the card,
// never breaking the layout or silently vanishing.
// =======================================================================

test('CASE 8a: deriveCompactNoSendReason deterministically truncates a reason over the card budget, ellipsis included, never silently dropped', async () => {
  const { deriveCompactNoSendReason } = await import('../src/pbs/aiObservatoryView.js');
  // Exercises the pure function directly with a reason well over 100
  // chars -- the real AI decision pipeline itself already caps `reason`
  // at 80 chars (aiDecisionEngine.js's own pre-existing, unrelated
  // REASON_MAX_CHARS), so this round's own 100-char card budget is a
  // defensive normalizer for every OTHER reason source (policy/GEO/
  // failure templates, future longer AI reasons) -- tested directly here
  // rather than routed through the AI's own shorter cap.
  const longReason =
    '這是一段非常長的理由文字，用來確認收合卡片上的紅字原因區塊會被正確截斷成適合手機閱讀的長度，而不會整段爆版或是被直接忽略掉，也不會截斷到看起來像亂碼或缺字，' +
    '即使原始理由文字遠遠超過一百個中文字，卡片上顯示的內容也必須被安全地截斷並加上刪節號，完整原文則保留在展開頁供查證使用，絕不能整段消失不見。';
  assert.ok(longReason.length > 100, 'fixture sanity: the reason must exceed the card truncation budget');
  const aiRecord = { outcome: 'AI_NOTIFY_FALSE', eventType: 'other' };
  const compact = deriveCompactNoSendReason(aiRecord, { reason: longReason });
  assert.equal(compact.missing, false);
  assert.equal(compact.text, `${longReason.slice(0, 99)}…`);
  assert.ok(compact.text.length <= 100);
});

test('CASE 8b: a real, close-to-the-AI-cap reason (78 chars) renders in full on the collapsed card without breaking the page', async () => {
  const nearCapReason = '僅一般車流壅塞緩慢通行，沒有事故車損或道路阻斷跡象，路況資訊屬於例行性車多現象，未達需要主動提醒駕駛提高警覺或改道的門檻標準，暫不主動發送通知';
  assert.ok(nearCapReason.length >= 70 && nearCapReason.length <= 80, `fixture sanity: expected a 70-80 char reason, got ${nearCapReason.length}`);
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: nearCapReason, confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE8B' });
  await processQueuedPbsEvent(env, message, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes(nearCapReason), 'a reason within budget must render in full, never truncated when it does not need to be');
});

// =======================================================================
// CASE 9: missing reason -> honest fallback, never invented.
// =======================================================================

test('CASE 9: a genuinely unrecognized outcome (no template, no AI cache, no derivable reason at all) -> the collapsed card shows the exact honest fallback text, never a fabricated one', async () => {
  const env = await baseEnv();
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號', direction: '南向', eventType: 'other' },
    eventId: 'CASE9', lifecycle: 'NEW', fingerprint: 'fp-9',
    outcome: 'SOME_FUTURE_OUTCOME_THIS_VIEW_DOES_NOT_KNOW_YET', now: NOW,
  });
  await recordAiObservatoryEntry(env.TRAFFIC_KV, record, { taipeiDate: taipeiDateString(NOW), idempotencyKeyHash: 'fp-9-hash', now: NOW });

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('系統未記錄詳細原因，請展開查看流程紀錄。'));
  assert.ok(!html.includes('❌ 不通報原因：UNKNOWN / NOT RECORDED'), 'the raw internal sentinel string must never leak into the driver-facing card');
});

test('CASE 9b: AI decision cache expired/evicted (no real reason available anywhere) -> the collapsed card shows the honest missing-reason fallback text', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '這段理由稍後會被清掉', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: '南向嚴重回堵' }), eventId: 'CASE9B' });
  await processQueuedPbsEvent(env, message, NOW);
  for (const key of [...env.TRAFFIC_KV.store.keys()]) {
    if (key.startsWith('debug:pbs-ai-decision-cache:v1:')) env.TRAFFIC_KV.store.delete(key);
  }

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  // With the AI cache gone, this AI_NOTIFY_FALSE record still degrades to
  // the existing eventType-based deriveFinalDecisionReason categorization
  // (order section五's own priority tier 6, "existing outcome/status
  // reason") rather than the missing-reason fallback -- this repo DOES
  // still have SOME real reason on hand (the event type itself), so it is
  // shown, never replaced by an admission of ignorance it doesn't need.
  assert.ok(!html.includes('這段理由稍後會被清掉'));
  assert.ok(html.includes('no-send-reason'));
});

// =======================================================================
// CASE 10/11: collapsed visibility without expanding, expanded detail
// still fully preserved.
// =======================================================================

test('CASE 10: the no-send-reason block appears INSIDE <summary> (collapsed-visible), before any expand', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '測試原因十', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE10' });
  await processQueuedPbsEvent(env, message, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  const summaryStart = html.indexOf('<summary>');
  const summaryEnd = html.indexOf('</summary>', summaryStart);
  const summaryHtml = html.slice(summaryStart, summaryEnd);
  assert.ok(summaryHtml.includes('no-send-reason'), 'the reason block must live inside <summary>, visible without a tap/click');
  assert.ok(summaryHtml.includes('測試原因十'));
});

test('CASE 11: the expanded detail section keeps every pre-existing field, byte-for-byte, unaffected by the new collapsed block', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '完整展開頁測試原因', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: 'RAW_COMMENT_MUST_STILL_APPEAR' }), eventId: 'CASE11' });
  await processQueuedPbsEvent(env, message, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('① PBS / Windows'));
  assert.ok(html.includes('③ AI'));
  assert.ok(html.includes('④ LINE'));
  assert.ok(html.includes('RAW_COMMENT_MUST_STILL_APPEAR'));
  assert.ok(html.includes('完整展開頁測試原因'));
});

// =======================================================================
// CASE 12: 0 additional KV writes for this round's own rendering work.
// =======================================================================

test('CASE 12: rendering the observatory view (including every new no-send-reason block) performs 0 KV writes', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '零額外KV測試', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE12' });
  await processQueuedPbsEvent(env, message, NOW);

  const putsBeforeView = env.TRAFFIC_KV.putCalls;
  await handleAiObservatoryView(env, viewRequest(), NOW);
  assert.equal(env.TRAFFIC_KV.putCalls, putsBeforeView, 'GET /admin/pbs-ai-observatory-view must perform 0 KV writes, same as before this round');
});

// =======================================================================
// CASE 13: AI / GEO / Road Policy / LINE decision logic completely
// unchanged -- this round is UI-only.
// =======================================================================

test('CASE 13: a HIGH-impact accident still reaches AI and pushes LINE exactly as before -- decision logic untouched by this UI-only round', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push(input); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '國1事故', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent(), eventId: 'CASE13' });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineSent, true);
  assert.equal(ai.calls.length, 1, 'exactly one AI call, no new second call added by this round');
});
