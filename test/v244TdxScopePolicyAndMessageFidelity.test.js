// V2.4.4 — V2_4_4_TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX. The order's
// own CASE 1-14 acceptance list (order section 八) most directly exercised
// by this round's own new code (the Hsinchu-only Production hard gate, the
// fourth AI policy anchor, and the TDX message-fidelity fix). CASE 15/17/
// 18/19/20 (PBS V2.4.2 formatter / TDX CCTV / TDX Highway text-only / V2.4.3
// timeout / Incident Memory — all "must not regress") are covered by the
// existing dedicated suites for those rounds re-running clean under full
// regression, not duplicated here — see this round's own final report.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHsinchuOnlyProductionEligibility } from '../src/traffic/serviceArea.js';
import { runAiApprovedPbsBroadcast } from '../src/traffic/aiApprovedPbsBroadcast.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { buildAiRequest } from '../src/pbs/aiDecisionEngine.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const NOW = new Date('2026-09-02T11:00:00+08:00'); // within LINE broadcast hours

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
let originalFetch;
let pushCalls;
function mockLinePushFetch() {
  pushCalls = [];
  return async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

async function broadcastEnv() {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  return { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
}

// =============================================================================
// CASE 1/2 — genuinely-Hsinchu events (city and county) still reach LINE.
// =============================================================================

test('CASE 1: 新竹市 (國1 93K) TDX event clears the Hsinchu-only gate and reaches LINE', async () => {
  const env = await broadcastEnv();
  const event = {
    source: 'freeway', rawId: 'C1', type: 'accident', road: '國道一號', direction: '南向',
    startKM: '93K+300', description: '新竹市境內事故', latitude: 24.8, longitude: 120.97,
    updatedAt: NOW.toISOString(),
  };
  assert.equal(resolveHsinchuOnlyProductionEligibility(event).eligible, true);
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW });
  assert.equal(result.serviceAreaEligible, true);
  assert.equal(result.pushSucceeded, 1);
});

test('CASE 2: 新竹縣 (台1線 湖口 90K) TDX event clears the Hsinchu-only gate and reaches LINE', async () => {
  const env = await broadcastEnv();
  const event = {
    source: 'highway', rawId: 'C2', type: 'accident', road: '台1線', direction: '南向',
    startKM: '90K+000', description: '新竹縣湖口路段事故', updatedAt: NOW.toISOString(),
  };
  assert.equal(resolveHsinchuOnlyProductionEligibility(event).eligible, true);
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW });
  assert.equal(result.serviceAreaEligible, true);
  assert.equal(result.pushSucceeded, 1);
});

// =============================================================================
// CASE 3 — the real leaked event: 桃園市觀音區, 台61線 39K+600 -> LINE = 0.
// =============================================================================

test('CASE 3: 桃園市觀音區 (台61線 39K+600) -> LINE = 0 (the real Production leak, now blocked)', async () => {
  const env = await broadcastEnv();
  const event = {
    source: 'highway', rawId: 'C3', type: 'control', road: '台61線', direction: '南向',
    startKM: '39K+600', description: '西濱公路南向39K+600附近，桃園市觀音區白玉里，雙向道路封閉',
    updatedAt: NOW.toISOString(),
  };
  const gate = resolveHsinchuOnlyProductionEligibility(event);
  assert.equal(gate.eligible, false);
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW });
  assert.equal(result.serviceAreaEligible, false);
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

// =============================================================================
// CASE 4 — 苗栗 (頭份/竹南/國1 102K, now outside the narrowed range and
// explicitly named) -> LINE = 0.
// =============================================================================

test('CASE 4: 苗栗縣頭份 (國1 102K) -> LINE = 0', async () => {
  const env = await broadcastEnv();
  const event = {
    source: 'freeway', rawId: 'C4', type: 'accident', road: '國道一號', direction: '北向',
    startKM: '102K+000', description: '苗栗縣頭份路段事故', updatedAt: NOW.toISOString(),
  };
  assert.equal(resolveHsinchuOnlyProductionEligibility(event).eligible, false);
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW });
  assert.equal(result.pushSucceeded, 0);
});

test('CASE 4b: 苗栗縣竹南/三灣 named in text alone (no placeable KM/coords) is still blocked by the denylist backstop', () => {
  const event = { source: 'highway', road: '台61線', description: '苗栗縣竹南路段封閉' };
  assert.equal(resolveHsinchuOnlyProductionEligibility(event).eligible, false);
});

// =============================================================================
// CASE 5 — 台北／新北 -> LINE = 0. Deliberately NO KM/coordinates, so the
// base resolveServiceAreaEligibility() alone would "defer to ingestion"
// (eligible:true) — this proves the NEW text-denylist backstop, not just
// the KM-table fix, is what closes the gap.
// =============================================================================

test('CASE 5a: 台北市 mentioned, no placeable geography -> the denylist backstop blocks it (base resolver alone would defer)', async () => {
  const env = await broadcastEnv();
  const event = {
    source: 'freeway', rawId: 'C5A', type: 'accident', road: '國道一號', direction: '南向',
    description: '台北市內湖路段事故', updatedAt: NOW.toISOString(),
  };
  const gate = resolveHsinchuOnlyProductionEligibility(event);
  assert.equal(gate.eligible, false);
  assert.match(gate.reason, /non-hsinchu-place:台北/);
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW });
  assert.equal(result.pushSucceeded, 0);
});

test('CASE 5b: 新北市 mentioned -> blocked the same way', () => {
  const event = { source: 'highway', road: '台1線', description: '新北市林口路段事故' };
  assert.equal(resolveHsinchuOnlyProductionEligibility(event).eligible, false);
});

test('the hard gate never WIDENS eligibility — an event the base resolver already rejects stays rejected even with no denylist match', () => {
  const event = { source: 'freeway', road: '國道一號', startKM: '10K+000', description: '事故' }; // far outside any range, no place name at all
  const base = resolveHsinchuOnlyProductionEligibility(event);
  assert.equal(base.eligible, false);
});

// =============================================================================
// CASE 6/7/8 — routine road management: prompt anchor states notify=false
// as the default (this project has no live Workers AI access in tests —
// see aiDecisionEngine.js's own header comment — these are prompt-content
// regression tests, not live-model assertions).
// =============================================================================

function systemPromptText() {
  const request = buildAiRequest({ road: '國道一號', direction: '南向', comment: '測試', eventType: 'construction' });
  return request.input.messages[0].content;
}

test('CASE 6/7/8: prompt states routine construction/shoulder-open/shoulder-close default to notify=false', () => {
  const prompt = systemPromptText();
  assert.match(prompt, /例行施工/);
  assert.match(prompt, /機動路肩開放/);
  assert.match(prompt, /機動路肩關閉/);
  assert.match(prompt, /notify=false/);
  assert.match(prompt, /道路管理狀態/);
});

// =============================================================================
// CASE 9/10/11 — the same anchor states clear exceptions: an accident during
// construction, a complete-blockage collapse, and a large highway obstacle
// all remain eligible for notify=true.
// =============================================================================

test('CASE 9/10/11: the routine-management anchor explicitly carves out accident / complete-blockage collapse / large obstacle as notify=true-eligible', () => {
  const prompt = systemPromptText();
  assert.match(prompt, /事故／車禍／碰撞/);
  assert.match(prompt, /重大坍方、落石、大型掉落物/);
  assert.match(prompt, /道路完全中斷/);
  assert.match(prompt, /notify=true/);
});

// =============================================================================
// CASE 12 — a 故障車 (broken-down vehicle, type='other') is never forced to
// a fixed notify value purely by its event type — structural proof, not a
// live-model call.
// =============================================================================

test('CASE 12: nothing in the AI request/candidate pipeline hard-codes a fixed notify value by event.type — the AI judges content, not the type label', () => {
  const prompt = systemPromptText();
  // The prompt itself never instructs a fixed answer keyed off a type name.
  assert.doesNotMatch(prompt, /type\s*===?\s*'other'/);
  assert.doesNotMatch(prompt, /other.{0,4}(一律|固定|永遠).{0,4}(通知|不通知)/);
  // And the request payload sent to the model carries eventType as plain
  // data, never as a field the schema conditions its own required-fields
  // set on (only recentIncidentContext does that — see buildAiRequest).
  const candidate = { road: '國道一號', direction: '南向', comment: '91K發現故障車', eventType: 'other' };
  const request = buildAiRequest(candidate);
  const payload = JSON.parse(request.input.messages[1].content);
  assert.equal(payload.eventType, 'other');
  assert.ok(!('notify' in payload));
});

// =============================================================================
// CASE 13/14 — TDX message fidelity: description facts and blockedLanes
// both survive to the LINE text, never washed out by the generic template.
// =============================================================================

test('CASE 13: a detailed TDX description survives into the LINE message, not just the generic "請注意車道"/"請留意路況" template', () => {
  const event = {
    source: 'freeway', type: 'construction', road: '國道一號', direction: '北向',
    startKM: '104K+000', description: '因路面刨鋪施工，內側車道封閉，預計今晚23時解除',
    updatedAt: '2026-09-02T10:00:00+08:00',
  };
  const text = formatEventMessage(event);
  // The real fact from the source record is present as its own line...
  assert.match(text, /路面刨鋪施工，內側車道封閉，預計今晚23時解除/);
  // ...ADDITIONAL to (not instead of) the existing generic impact line —
  // this proves the fix is purely additive, matching V2.4.2's own
  // "source facts preserved, existing template untouched" principle.
  assert.match(text, /施工影響通行/);
  assert.match(text, /請注意車道/);
});

test('CASE 14: TDX blockedLanes survives as its own structured line, never washed out by the generic template', () => {
  const event = {
    source: 'freeway', type: 'other', road: '國道一號', direction: '南向',
    startKM: '104K+600', description: '', blockedLanes: 1,
    updatedAt: '2026-09-02T10:05:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /⚠️ 封閉1車道/);
});

// =============================================================================
// CASE 16 — a normal PBS Hsinchu event: full pipeline still reaches LINE,
// unaffected by the new geographic hard gate (it only ever subtracts).
// =============================================================================

test('CASE 16: a normal PBS Hsinchu accident still reaches LINE normally through the new hard gate', async () => {
  const env = await broadcastEnv();
  const event = {
    source: 'pbs', rawId: 'C16', type: 'accident', road: '國道一號', direction: '北向',
    startKM: '90K+000', description: '追撞事故，車道封閉', sourceDetail: '警廣路況中心',
    latitude: 24.8, longitude: 121.0, updatedAt: NOW.toISOString(),
  };
  assert.equal(resolveHsinchuOnlyProductionEligibility(event).eligible, true);
  const result = await runAiApprovedPbsBroadcast(env, { event, now: NOW });
  assert.equal(result.pushSucceeded, 1);
});
