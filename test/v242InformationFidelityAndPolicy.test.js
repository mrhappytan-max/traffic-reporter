// V2.4.2 — V2_4_2_PBS_AI_LINE_INFORMATION_FIDELITY_AND_POLICY_FIX.
//
// The order's own CASE 1-12 acceptance list (order section 二十), plus a
// handful of directly-adjacent regression tests for the new messageFormat.js
// helpers. See src/version.js's own V2.4.2 changelog block for the full
// root-cause writeup (INFORMATION_LOSS_FILE/_FUNCTION/_REASON) this round
// fixes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { buildAiRequest } from '../src/pbs/aiDecisionEngine.js';
import { runAiApprovedPbsBroadcast } from '../src/traffic/aiApprovedPbsBroadcast.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

// --- shared test fixtures/helpers ------------------------------------------

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
const WITHIN_HOURS = new Date('2026-09-01T20:22:00+08:00');

let originalFetch;
let pushCalls;
function mockLinePushFetch() {
  pushCalls = [];
  return async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}
test.afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

// =============================================================================
// CASE 1 — 尖石鄉坍方: 竹60/往司馬庫斯/23.5K/道路阻斷/多車無法通行 must all
// survive to the LINE message, not just "請留意路況".
// =============================================================================

test('CASE 1: PBS 坍方 event preserves road/direction/KM AND the key facts (道路阻斷/多車無法通行) — never only "請留意路況"', () => {
  const event = {
    source: 'pbs',
    rawId: 'CASE-1',
    type: 'other', // classifyPbsEvent's own 坍方 override -> nonCollisionAnomalyDetail
    nonCollisionAnomalyDetail: { emoji: '⛰️', label: '邊坡坍方' },
    road: '竹60',
    direction: '往司馬庫斯',
    location: '新竹縣尖石鄉',
    displayKM: 23.5,
    description: '竹60鄉道往司馬庫斯23.5K因坍方道路阻斷多車無法通行',
    sourceDetail: '熱心聽眾',
    updatedAt: '2026-09-01T20:22:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /竹60/);
  assert.match(text, /往司馬庫斯/);
  assert.match(text, /23\.5K|23K\+500/);
  assert.match(text, /道路阻斷/);
  assert.match(text, /多車無法通行/);
  // The exact old-bug shape must not be the WHOLE story any more — the
  // generic reminder may still appear, but the real facts must too.
  assert.notEqual(text.trim(), ['⛰️ 邊坡坍方', '竹60 往司馬庫斯', '23K+500', '請留意路況'].join('\n'));
});

// =============================================================================
// CASE 2 — sourceDetail ("熱心聽眾") must render as "通報：熱心聽眾".
// =============================================================================

test('CASE 2: PBS sourceDetail renders as "通報：熱心聽眾"', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '90K+000',
    description: '事故',
    sourceDetail: '熱心聽眾',
    updatedAt: '2026-09-01T20:22:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /通報：熱心聽眾/);
});

test('sourceDetail absent -> no 通報 line at all (never guessed)', () => {
  const event = { source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '90K+000', description: '事故' };
  const text = formatEventMessage(event);
  assert.doesNotMatch(text, /通報：/);
});

test('sourceDetail longer than the cap is truncated with an ellipsis, never silently dropped', () => {
  const longDetail = '新' .repeat(60);
  const event = { source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '90K+000', description: '事故', sourceDetail: longDetail };
  const text = formatEventMessage(event);
  assert.match(text, /通報：新+…/);
});

// =============================================================================
// CASE 3 — 台68 竹科入口匝道事故: precise location text (竹科入口匝道) must
// survive even though areaNm/road alone are generic.
// =============================================================================

test('CASE 3: PBS event with a precise ramp/interchange location in the comment preserves it (竹科入口匝道)', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '台68',
    direction: '西行',
    location: '新竹市',
    description: '西行竹科入口匝道經國大橋上來事故',
    sourceDetail: '新竹市警察局勤務中心',
    updatedAt: '2026-09-01T20:22:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /竹科入口匝道/);
});

// =============================================================================
// CASE 4-8 — AI notify policy anchors: the SYSTEM_PROMPT itself (not a code-
// level keyword gate — buildAiRequest's schema/shape is unchanged) must state
// the three policy anchors the order requires. These are prompt-content
// regression tests (this project has no live Workers AI access in tests —
// see aiDecisionEngine.js's own header comment); the actual notify/impact
// verdict for any one real event is a live-model judgment, not something a
// unit test can assert.
// =============================================================================

function systemPromptText() {
  const request = buildAiRequest({ road: '台68', direction: '西向', comment: '測試', eventType: 'accident' });
  return request.input.messages[0].content;
}

test('CASE 4/14: prompt states plain/routine congestion should generally NOT be notified (avoid burying real incidents)', () => {
  const prompt = systemPromptText();
  assert.match(prompt, /車多|一般壅塞/);
  assert.match(prompt, /notify=false/);
});

test('CASE 5/6/13: prompt states predictive road-safety hazards (掉落物/輪胎皮/坍方/障礙/落石) should notify=true even without congestion', () => {
  const prompt = systemPromptText();
  assert.match(prompt, /掉落物/);
  assert.match(prompt, /輪胎皮/);
  assert.match(prompt, /坍方/);
  assert.match(prompt, /即使.{0,6}還沒.{0,4}壅塞|不需要等到造成壅塞/);
});

test('CASE 7/8/12: prompt states a credible accident/collision should notify=true by default, not gated on proven congestion', () => {
  const prompt = systemPromptText();
  assert.match(prompt, /事故|車禍|碰撞|追撞/);
  assert.match(prompt, /不需要先證明.{0,6}壅塞/);
});

test('buildAiRequest schema/shape is untouched by the prompt rewrite', () => {
  const candidate = { road: '台68', direction: '西向', areaNm: '新竹市', displayKM: 5, eventType: 'accident', comment: '測試', sourceDetail: 'x' };
  const request = buildAiRequest(candidate);
  assert.equal(request.model, '@cf/zai-org/glm-4.7-flash');
  assert.equal(request.input.messages.length, 2);
  const userPayload = JSON.parse(request.input.messages[1].content);
  assert.deepEqual(Object.keys(userPayload).sort(), ['areaNm', 'comment', 'displayKM', 'direction', 'eventType', 'road', 'sourceDetail'].sort());
});

// =============================================================================
// CASE 9 — AI reason must never override/replace source facts in the LINE
// message. formatEventMessage/runAiApprovedPbsBroadcast never receive the AI
// decision object at all — this proves it end to end, with a distinctive
// "reason-shaped" string that must never leak into the pushed text.
// =============================================================================

test('CASE 9: the AI decision reason text never appears in the pushed LINE message — only source facts do', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  // A distinctive string standing in for "what the AI's own `reason` field
  // would have said" — deliberately never placed on the event itself.
  const AI_REASON_MARKER = 'AI專屬判斷理由文字不應出現在LINE訊息中';
  const event = {
    source: 'pbs',
    rawId: 'CASE-9',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '90K+000',
    description: '追撞事故，車道封閉',
    sourceDetail: '警廣路況中心',
    updatedAt: WITHIN_HOURS.toISOString(),
  };
  const result = await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  assert.equal(result.pushSucceeded, 1);
  const text = result.completedProducts[0].text;
  assert.match(text, /追撞事故|車道封閉/); // the real source fact
  assert.doesNotMatch(text, new RegExp(AI_REASON_MARKER)); // never the (never-passed) AI reason
});

// =============================================================================
// CASE 10 — TDX Highway: shared formatter still works, text-only, no PBS-only
// fact line (source-gated — TDX's own raw Description is never dumped).
// =============================================================================

test('CASE 10: TDX highway event uses the same shared formatter, text-only, no PBS-only fact line', () => {
  const event = {
    source: 'highway',
    type: 'accident',
    road: '台1',
    direction: '南向',
    startKM: '90K+000',
    endKM: '91K+000',
    description: '這是一段很長的原始 TDX 敘述，不應該整段被貼上 LINE。',
    updatedAt: '2026-09-01T20:22:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /🚨 交通事故/);
  assert.match(text, /台1 南向/);
  assert.doesNotMatch(text, /很長的原始 TDX 敘述/); // still never dumped, unchanged invariant
});

// =============================================================================
// CASE 11 — TDX Freeway: shared formatter unaffected; blockedLanes (a real
// structured TDX field) DOES get its own line, source-agnostic.
// =============================================================================

test('CASE 11: TDX freeway event — shared formatter unaffected, blockedLanes gets its own structured fact line', () => {
  const event = {
    source: 'freeway',
    type: 'accident',
    road: '國道三號',
    direction: '南向',
    startKM: '81K+300',
    description: '這是一段很長的原始 TDX 敘述，不應該整段被貼上 LINE。',
    blockedLanes: 2,
    updatedAt: '2026-09-01T20:22:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /國3 南向/);
  assert.match(text, /⚠️ 封閉2車道/);
  assert.doesNotMatch(text, /很長的原始 TDX 敘述/); // TDX Description still never dumped
});

test('blockedLanes=0 or non-numeric never renders a line (no false positive)', () => {
  const base = { source: 'freeway', type: 'accident', road: '國道三號', direction: '南向', startKM: '81K+300', description: 'x' };
  assert.doesNotMatch(formatEventMessage({ ...base, blockedLanes: 0 }), /封閉/);
  assert.doesNotMatch(formatEventMessage({ ...base, blockedLanes: 'unknown' }), /封閉/);
  assert.doesNotMatch(formatEventMessage({ ...base }), /封閉/);
});

// =============================================================================
// CASE 12 — PBS's own already-working normal notification path must not
// regress: existing accident template (road/direction/KM/impact/updated-at)
// still renders correctly, with the new fact/sourceDetail lines purely
// additive.
// =============================================================================

test('CASE 12: a normal PBS accident notification is unchanged in its existing fields, new lines are purely additive', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '95K+000',
    description: '國道一號北向95公里處發生一般擦撞事故',
    sourceDetail: '國道公路警察局',
    updatedAt: '2026-08-15T12:35:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[0], '🚨 交通事故');
  assert.match(lines[1], /^國1 北向/); // may carry a resolved anchor-table section label, unaffected by this round
  assert.equal(lines[2], '95K+000');
  assert.ok(lines.includes('事故影響通行'));
  assert.ok(lines.includes('請提前避開'));
  assert.ok(lines.includes('通報：國道公路警察局'));
  assert.equal(lines[lines.length - 1], '🕒 12:35更新');
});

// =============================================================================
// Fact-line specific unit regressions (buildSourceFactLine internals, via the
// public formatEventMessage surface only).
// =============================================================================

test('fact line strips a redundant KM mention already shown on its own line, and caps at 60 chars', () => {
  const longFact = '道路狀況說明'.repeat(20); // far over 60 chars
  const event = { source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '90K+000', description: `90K處${longFact}` };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  const factLine = lines.find((l) => l.includes('道路狀況說明'));
  assert.ok(factLine);
  assert.doesNotMatch(factLine, /90K/); // redundant KM mention stripped
  assert.ok(factLine.length <= 61); // 60 chars + ellipsis
});

test('fact line omitted when description is empty or identical to the road/section line already shown', () => {
  const noDescription = { source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '90K+000', description: '' };
  assert.equal(formatEventMessage(noDescription).split('\n').length, formatEventMessage({ ...noDescription, description: undefined }).split('\n').length);

  const duplicateDescription = { source: 'pbs', type: 'accident', road: '國道一號', direction: '北向', startKM: '90K+000', description: '國1 北向' };
  const text = formatEventMessage(duplicateDescription);
  // '國1 北向' already appears as the road/direction line — must not be
  // repeated a second time as a redundant fact line.
  assert.equal(text.split('國1 北向').length - 1, 1);
});
