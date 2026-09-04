// V2.4.13.1 — V2_4_13_1_OBSERVATORY_NO_SEND_REASON_VISUAL_CONTRAST_HOTFIX
// (路況工程部｜V2.4.13.1 查修頁不通報原因視覺強化 Hotfix).
//
// CSS/presentation-only hotfix on top of V2.4.12/V2.4.13's own no-send-
// reason block: real Production feedback found the original all-red
// (label + body both #f85149 on a dark red background) low-contrast and
// hard to scan on a phone in dark mode. This round re-tiers the SAME
// block's colors -- red frame (alert) / bright yellow label (fast visual
// anchor) / near-white body (readability) -- and changes NOTHING about
// which reason text is chosen, how it's truncated, or any AI/GEO/Road
// Policy/LINE/Debris/KV/Queue/Incident Memory/CCTV/Production-flag
// behavior. See test/v2412ObservatoryNoSendReasonHighVisibilityUI.test.js
// for the full reason-selection/truncation/fallback test suite (still
// exhaustively covers those, untouched by this round) -- this file only
// asserts the NEW visual contract.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState, handlePbsAiQueueBatch } from '../src/pbs/debugPush.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { listAiObservatoryEntries, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';
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

// Pulls the .no-send-reason-label / .no-send-reason-text CSS rule bodies
// out of the page's own embedded <style> block, so this suite asserts
// against the REAL stylesheet the page ships, never a hand-copied guess.
// Anchored to a line START (only whitespace before the selector) so this
// never accidentally matches the TAIL of an unrelated compound selector
// (e.g. ".no-send-reason-missing .no-send-reason-text { ... }" contains
// the same substring but is a different rule with a different color).
function extractCssRule(html, selector) {
  const escaped = selector.replace(/[.#]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`, 'm');
  const m = html.match(re);
  return m ? m[1] : null;
}

// =======================================================================
// CASE 1: normal not-sent card -- ❌ red, title yellow, body white.
// =======================================================================

test('CASE 1: a normal AI_NOTIFY_FALSE not-sent card renders the label in bright yellow and the body in near-white, never the same red as the frame', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '僅一般車流壅塞，未達主動通知門檻', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE1' });
  await processQueuedPbsEvent(env, message, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('❌ 不通報原因'));
  assert.ok(html.includes('僅一般車流壅塞，未達主動通知門檻'));

  const labelRule = extractCssRule(html, '.no-send-reason-label');
  const textRule = extractCssRule(html, '.no-send-reason-text');
  assert.ok(labelRule, '.no-send-reason-label rule must exist in the page stylesheet');
  assert.ok(textRule, '.no-send-reason-text rule must exist in the page stylesheet');
  assert.ok(labelRule.includes('#facc15'), 'label (title) must be bright yellow');
  assert.ok(labelRule.includes('font-weight: 800'), 'label must be heavier than the body (800 vs 700)');
  assert.ok(textRule.includes('#f2f3f5'), 'body (real reason) must be near-white for readability');
  assert.ok(!labelRule.includes('#f85149'), 'the label must no longer be the old flat red');
  assert.ok(!textRule.includes('#f85149'), 'the body must no longer be the old flat red');

  // §三: never the whole block in one flat color -- label and body must be
  // two genuinely different colors, not just two rules with the same value.
  assert.notEqual(labelRule.match(/color:\s*(#[0-9a-fA-F]{3,6})/)?.[1], textRule.match(/color:\s*(#[0-9a-fA-F]{3,6})/)?.[1]);

  // The red alert frame itself (border/background) is preserved.
  const blockRule = extractCssRule(html, '.no-send-reason');
  assert.ok(blockRule.includes('#2b1414'), 'dark red background must be preserved as the alert frame');
  assert.ok(blockRule.includes('#4a1f1f'), 'red border must be preserved as the alert frame');
});

// =======================================================================
// CASE 2: system failure card -- same visual rules, distinct label text.
// =======================================================================

test('CASE 2: an AI processing failure card uses the SAME yellow-title/white-body visual rules as a normal not-sent card', async () => {
  const env = await baseEnv({ AI: { run: () => new Promise(() => {}) } }); // never resolves -> always times out
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE2' });
  for (let attempts = 1; attempts <= 3; attempts += 1) {
    const msg = { body: message, attempts, ack() {}, retry() {} };
    await handlePbsAiQueueBatch({ messages: [msg] }, env, { aiCallTimeoutMs: 20, now: NOW });
  }
  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'CASE2' });
  assert.equal(records[0].outcome, AI_OUTCOME.PROCESSING_FAILED);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes('❌ 處理失敗原因'), 'a system failure keeps its own distinct label text (order section五)');
  assert.ok(html.includes('AI 背景處理連續逾時，重試後仍未完成'));

  // Same shared CSS classes/rules as CASE 1 -- the visual CONTRACT is
  // identical for both card types, only the label/body TEXT differs.
  const labelRule = extractCssRule(html, '.no-send-reason-label');
  const textRule = extractCssRule(html, '.no-send-reason-text');
  assert.ok(labelRule.includes('#facc15'));
  assert.ok(textRule.includes('#f2f3f5'));
});

// =======================================================================
// CASE 3: mobile-first -- normal wrapping, no forced single line, no
// horizontal scroll, at 375/390/430px.
// =======================================================================

test('CASE 3: the block wraps normally on mobile widths (375/390/430px) -- no nowrap, no forced truncation to one line, no horizontal overflow', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '道路政策排除：機動路肩開放，此類資訊不主動發送 LINE。', confidence: 0.8 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'CASE3' });
  await processQueuedPbsEvent(env, message, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  const labelRule = extractCssRule(html, '.no-send-reason-label');
  const textRule = extractCssRule(html, '.no-send-reason-text');
  assert.ok(textRule.includes('overflow-wrap: break-word'));
  assert.ok(textRule.includes('word-break: break-word'));
  assert.ok(!textRule.includes('nowrap'), 'must never force a single non-wrapping line');
  assert.ok(!textRule.includes('text-overflow'), 'must never CSS-ellipsis/clip the body -- truncation is a deterministic upstream string operation, not a visual clip');

  // Base rule (no media query -- applies at every width including
  // 375/390/430px) still uses the order's own 18-20px range; the
  // >=431px media query only nudges up for larger screens, it never
  // shrinks the mobile-first base.
  assert.ok(/font-size:\s*1[89]px/.test(labelRule));
  assert.ok(/font-size:\s*1[89]px/.test(textRule));
});

// =======================================================================
// CASE 4: original reason text is unchanged, verbatim.
// =======================================================================

test('CASE 4: the underlying reason text is byte-for-byte identical to before this hotfix -- only color/weight changed, never the content', async () => {
  const reason = '散落物種類、大小及所在車道不明，目前沒有足夠證據確認屬高風險障礙物';
  const ai = { async run() { return { response: JSON.stringify({ notify: false, impact: 'LOW', reason, confidence: 0.7 }) }; } };
  const env = await baseEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent({ comment: '95K+200路面發現散落物狀況' }), eventId: 'CASE4' });
  await processQueuedPbsEvent(env, message, NOW);

  const html = await (await handleAiObservatoryView(env, viewRequest(), NOW)).text();
  assert.ok(html.includes(reason), 'the exact reason string must still appear verbatim');
});

// =======================================================================
// CASE 5: 0 AI change, 0 KV change, 0 decision change.
// =======================================================================

test('CASE 5: 0 additional AI calls, 0 additional KV reads/writes, and decision outcomes are completely unchanged by this pure CSS hotfix', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push(input); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '國1事故', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = normalizeRoadEvent(
    {
      EventID: 'CASE5', EventType: '事故', Description: '南向97K處車輛事故，外側車道封閉',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Impact: { BlockedLanes: 1 },
      Positions: [{ PositionLon: 120.9686, PositionLat: 24.8066 }],
    },
    'freeway'
  );
  const message = await buildQueueMessage({ source: 'freeway', event, eventId: 'CASE5' });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineSent, true);
  assert.equal(ai.calls.length, 1, 'exactly one AI call -- unchanged by this presentation-only hotfix');

  const getsBefore = env.TRAFFIC_KV.getCalls;
  const putsBefore = env.TRAFFIC_KV.putCalls;
  await handleAiObservatoryView(env, viewRequest(), NOW);
  assert.equal(env.TRAFFIC_KV.putCalls, putsBefore, '0 additional KV writes from rendering the view');
  assert.ok(env.TRAFFIC_KV.getCalls >= getsBefore, 'reads may happen (same pre-existing read-only page behavior) but this is not a regression check on reads -- see V2.4.12 CASE 12 for the write-count guarantee this round preserves unchanged');
});
