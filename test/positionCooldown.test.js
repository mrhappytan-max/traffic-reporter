// V2.9.0 (路況-070, executing 路況-069's own read-only規劃) — "一小時內
// 同位置不重複推播" 硬性規則. Two layers of coverage, same split this
// project already uses elsewhere (e.g. aiObservatoryIndex.test.js vs
// aiObservatoryView.test.js): (1) pure unit tests directly against
// src/pbs/positionCooldown.js's own exported functions — fast, precise,
// independent of the AI/Queue/LINE machinery; (2) end-to-end pipeline
// tests via processQueuedPbsEvent (same idiom test/tdxUnifiedAiPipeline.js
// already uses) covering the order's own required scenario list
// (路況-069 七節／路況-070 四節，10 items).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  POSITION_COOLDOWN_WINDOW_MS,
  POSITION_COOLDOWN_MAX_KM_DIFF,
  POSITION_COOLDOWN_RECORD_TTL_MS,
  findPositionCooldownMatch,
  evaluatePositionCooldown,
  buildPositionCooldownUpdate,
  readPositionCooldownState,
  persistPositionCooldownState,
} from '../src/pbs/positionCooldown.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { SHARED_FEED_KEY } from '../src/traffic/sharedFeed.js';
import { APP_VERSION } from '../src/version.js';

// ============================================================================
// PART 1 — pure unit tests, zero I/O, zero AI/Queue machinery.
// ============================================================================

test('findPositionCooldownMatch: matches within POSITION_COOLDOWN_MAX_KM_DIFF (1km), never beyond it', () => {
  const records = [{ km: 50, lastNotifiedAt: '2026-09-10T00:00:00Z', maxImpactNotified: 'LOW' }];
  assert.ok(findPositionCooldownMatch(records, 50), 'exact same KM must match');
  assert.ok(findPositionCooldownMatch(records, 50 + POSITION_COOLDOWN_MAX_KM_DIFF), 'exactly at the 1km boundary must match (inclusive)');
  assert.equal(findPositionCooldownMatch(records, 50 + POSITION_COOLDOWN_MAX_KM_DIFF + 0.01), null, 'just past 1km must not match');
  assert.equal(POSITION_COOLDOWN_MAX_KM_DIFF, 1, 'sanity: 真人定案的1公里門檻，獨立於incidentSuppression.js(1.5km)/incidentMemory.js(1.5km)之外');
});

test('findPositionCooldownMatch: null km (either side) never matches — no reliable position, never guess', () => {
  assert.equal(findPositionCooldownMatch([{ km: 50, lastNotifiedAt: '2026-09-10T00:00:00Z' }], null), null);
  assert.equal(findPositionCooldownMatch([{ km: null, lastNotifiedAt: '2026-09-10T00:00:00Z' }], 50), null);
  assert.equal(findPositionCooldownMatch([], 50), null);
});

test('evaluatePositionCooldown: no match -> never blocked', () => {
  const now = new Date('2026-09-10T09:00:00Z');
  assert.deepEqual(evaluatePositionCooldown(null, now, 'HIGH'), { blocked: false, exception: false, withinWindow: false });
});

test('evaluatePositionCooldown: within window, no escalation (HIGH->HIGH) -> blocked', () => {
  const lastNotifiedAt = '2026-09-10T09:00:00Z';
  const now = new Date(new Date(lastNotifiedAt).getTime() + 30 * 60_000);
  const match = { lastNotifiedAt, maxImpactNotified: 'HIGH' };
  const result = evaluatePositionCooldown(match, now, 'HIGH');
  assert.equal(result.blocked, true);
  assert.equal(result.exception, false);
});

test('evaluatePositionCooldown: within window, no escalation (LOW->LOW) -> blocked', () => {
  const lastNotifiedAt = '2026-09-10T09:00:00Z';
  const now = new Date(new Date(lastNotifiedAt).getTime() + 30 * 60_000);
  const result = evaluatePositionCooldown({ lastNotifiedAt, maxImpactNotified: 'LOW' }, now, 'LOW');
  assert.equal(result.blocked, true);
  assert.equal(result.exception, false);
});

test('evaluatePositionCooldown: within window, LOW->HIGH escalation -> exception, not blocked', () => {
  const lastNotifiedAt = '2026-09-10T09:00:00Z';
  const now = new Date(new Date(lastNotifiedAt).getTime() + 30 * 60_000);
  const result = evaluatePositionCooldown({ lastNotifiedAt, maxImpactNotified: 'LOW' }, now, 'HIGH');
  assert.equal(result.blocked, false);
  assert.equal(result.exception, true);
});

test('evaluatePositionCooldown: HIGH->LOW is never an escalation (impact is a two-value enum; downgrading is not the exception) -> blocked', () => {
  const lastNotifiedAt = '2026-09-10T09:00:00Z';
  const now = new Date(new Date(lastNotifiedAt).getTime() + 30 * 60_000);
  const result = evaluatePositionCooldown({ lastNotifiedAt, maxImpactNotified: 'HIGH' }, now, 'LOW');
  assert.equal(result.blocked, true);
  assert.equal(result.exception, false);
});

test('evaluatePositionCooldown: 60-minute boundary — exactly 60:00 still within (inclusive, same closed-interval convention as broadcastHours.js V2.8.0), 60:00:01 has expired', () => {
  const lastNotifiedAt = '2026-09-10T09:00:00.000Z';
  const at60 = new Date(new Date(lastNotifiedAt).getTime() + POSITION_COOLDOWN_WINDOW_MS);
  const justAfter60 = new Date(new Date(lastNotifiedAt).getTime() + POSITION_COOLDOWN_WINDOW_MS + 1000);
  const match = { lastNotifiedAt, maxImpactNotified: 'HIGH' };
  assert.equal(evaluatePositionCooldown(match, at60, 'HIGH').blocked, true, '60分00秒仍在窗口內，應攔截');
  assert.equal(evaluatePositionCooldown(match, justAfter60, 'HIGH').blocked, false, '60分01秒視窗已過期，不應攔截');
});

test('buildPositionCooldownUpdate: first-ever record at a position is created with this event\'s own impact', () => {
  const now = new Date('2026-09-10T09:00:00Z');
  const next = buildPositionCooldownUpdate({}, { road: '國道一號', direction: '南向', km: 50 }, 'LOW', now);
  assert.equal(next['國道一號|南向'].length, 1);
  assert.equal(next['國道一號|南向'][0].maxImpactNotified, 'LOW');
  assert.equal(next['國道一號|南向'][0].lastNotifiedAt, now.toISOString());
});

test('buildPositionCooldownUpdate: maxImpactNotified never downgrades once HIGH — 真人定案原文「若本次為HIGH則覆蓋，否則維持既有值不降級」', () => {
  const t0 = new Date('2026-09-10T09:00:00Z');
  let groups = buildPositionCooldownUpdate({}, { road: '國道一號', direction: '南向', km: 50 }, 'HIGH', t0);
  assert.equal(groups['國道一號|南向'][0].maxImpactNotified, 'HIGH');

  const t1 = new Date(t0.getTime() + 90 * 60_000); // well past the 60-min window, but still within the 8h retention
  groups = buildPositionCooldownUpdate(groups, { road: '國道一號', direction: '南向', km: 50.2 }, 'LOW', t1);
  assert.equal(groups['國道一號|南向'][0].maxImpactNotified, 'HIGH', '一旦曾經HIGH過，即使這次是LOW，也不得降級為LOW');
  assert.equal(groups['國道一號|南向'][0].lastNotifiedAt, t1.toISOString());
  assert.equal(groups['國道一號|南向'][0].km, 50.2, '位置本身仍隨最新一次推播漂移更新');
});

test('buildPositionCooldownUpdate: prunes records past POSITION_COOLDOWN_RECORD_TTL_MS (8h), never a separate sweep job', () => {
  const t0 = new Date('2026-09-10T09:00:00Z');
  const staleGroups = { '國道一號|南向': [{ road: '國道一號', direction: '南向', km: 50, lastNotifiedAt: t0.toISOString(), maxImpactNotified: 'HIGH' }] };
  const t1 = new Date(t0.getTime() + POSITION_COOLDOWN_RECORD_TTL_MS + 60_000); // just past the 8h retention
  const next = buildPositionCooldownUpdate(staleGroups, { road: '台61線', direction: '北向', km: 10 }, 'LOW', t1);
  assert.equal(next['國道一號|南向'], undefined, '8小時前的舊記錄必須被剪除，不留在下一份state裡');
  assert.equal(next['台61線|北向'][0].maxImpactNotified, 'LOW');
});

test('persistPositionCooldownState: WRITE_ON_CHANGE — a content-identical next state skips the KV put', async () => {
  const store = new Map();
  const kv = {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
  const now = new Date('2026-09-10T09:00:00Z');
  const groups = { '國道一號|南向': [{ road: '國道一號', direction: '南向', km: 50, lastNotifiedAt: now.toISOString(), maxImpactNotified: 'HIGH' }] };
  const first = await persistPositionCooldownState(kv, groups, now, { previousStateExisted: false });
  assert.equal(first.written, true);
  const second = await persistPositionCooldownState(kv, groups, now, { previousGroups: groups, previousStateExisted: true });
  assert.equal(second.written, false, '內容完全相同的下一份state必須跳過KV put');
});

test('readPositionCooldownState: missing KV binding fails open (never blocks anything)', async () => {
  const state = await readPositionCooldownState(null);
  assert.equal(state.kvAvailable, false);
  assert.deepEqual(state.groups, {});
});

// ============================================================================
// PART 2 — end-to-end pipeline tests via processQueuedPbsEvent, mirroring
// test/tdxUnifiedAiPipeline.test.js's own conventions.
// ============================================================================

const NOW = new Date('2026-08-31T09:00:00+08:00'); // within LINE broadcast hours

function countingKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) { store.set(key, value); this.lastPutOptions = options; },
  };
}

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = countingKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, ...overrides };
}

/** Same real coordinate/road/direction pbsRawEvent() and freewayAccidentEvent() both use in test/tdxUnifiedAiPipeline.test.js — confirmed inside 新竹市 by the official NLSC polygon, so this file's cross-source test (scenario 8) exercises the SAME "PBS+TDX describe the same real incident" proximity this codebase already relies on elsewhere. */
function pbsAccidentEvent(overrides = {}) {
  return {
    road: '國道一號', areaNm: '國道一號南向', direction: '南向',
    comment: '南向97.7公里處發生車輛事故', longitude: 121.0, latitude: 24.8, sourceDetail: 'test',
    ...overrides,
  };
}

function freewayAccidentEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'FRW-CD-1', EventType: '事故', Description: '南向97K處車輛事故，外側車道封閉',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Impact: { BlockedLanes: 1 },
      Positions: [{ PositionLon: 121.0, PositionLat: 24.8 }],
      ...overrides,
    },
    'freeway'
  );
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

/** Returns fixed decisions in call order — precise per-call control, same idiom aiObservatoryView.test.js's own mockAi(fn) already uses. */
function sequentialAi(decisions) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const decision = decisions[calls.length - 1] || decisions[decisions.length - 1];
      return { response: JSON.stringify(decision) };
    },
  };
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

test('APP_VERSION reflects the current release', () => {
  assert.equal(APP_VERSION, 'V2.9.0');
});

// 路況-070 四節 (1): 60分鐘內同位置、無嚴重度上升（HIGH->HIGH）-> 擋下
test('scenario 1: 60 minutes內同位置、HIGH->HIGH無嚴重度上升 -> 攔截，0 LINE', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '仍持續', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'A1' }), NOW);
  assert.equal(first.lineAttempted, true);
  assert.equal(first.lineSent, true);

  const later = new Date(NOW.getTime() + 30 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'A2', fingerprint: 'fp-2', now: later }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.lineAttempted, false, '同位置60分鐘內、無嚴重度上升，必須攔截，不論AI notify為何');
  assert.equal(second.lineSent, false);
  assert.equal(second.positionCooldownBlocked, true);
});

// 路況-070 四節 (2): 60分鐘內同位置、LOW->HIGH升級 -> 放行，且視窗以本次時間重新起算
test('scenario 2: LOW->HIGH升級 -> 放行且重新起算，其後60分鐘內再次無升級則被擋', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'LOW', reason: '第一次，輕微', confidence: 0.8 },
    { notify: true, impact: 'HIGH', reason: '升級為嚴重', confidence: 0.9, sameIncident: false, materialChange: false },
    { notify: true, impact: 'HIGH', reason: '仍為HIGH，無再升級', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'B1' }), NOW);

  const t30 = new Date(NOW.getTime() + 30 * 60_000);
  const escalated = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'B2', fingerprint: 'fp-b2', now: t30 }),
    t30
  );
  assert.equal(escalated.lineAttempted, true, 'LOW->HIGH例外放行，必須正常推播');
  assert.equal(escalated.lineSent, true);

  // 距離B2（例外放行）僅30分鐘，距離B1已60分鐘——證明視窗是以B2（最近一次
  // 成功推播）重新起算，而非以B1原始時間為準。
  const t60FromB2 = new Date(t30.getTime() + 30 * 60_000);
  const thirdCall = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'B3', fingerprint: 'fp-b3', now: t60FromB2 }),
    t60FromB2
  );
  assert.equal(thirdCall.lineAttempted, false, '視窗應以B2重新起算，此時距B2僅30分鐘，且已是HIGH無法再升級，應攔截');
  assert.equal(thirdCall.positionCooldownBlocked, true);
});

// 路況-070 四節 (3): 超過60分鐘同位置 -> 不受影響，回歸V2.7.0既有邏輯
test('scenario 3: 超過60分鐘（61分鐘）同位置 -> 不攔截，正常推播', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '61分鐘後，視窗已過期', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'C1' }), NOW);

  const later = new Date(NOW.getTime() + 61 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'C2', fingerprint: 'fp-c2', now: later }),
    later
  );
  assert.equal(second.lineAttempted, true, '超過60分鐘視窗已過期，本規則不應攔截');
  assert.equal(second.lineSent, true);
});

// 路況-070 四節 (4): 不同位置（KM差>1公里）-> 完全不受影響
test('scenario 4: 不同位置（KM差2公里）-> 完全不受影響，各自獨立推播', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '位置一', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '位置二，相距2公里', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent({ comment: '南向97.7公里處發生車輛事故' }), eventId: 'D1' }), NOW);

  const t10 = new Date(NOW.getTime() + 10 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent({ comment: '南向99.7公里處發生車輛事故' }), eventId: 'D2', fingerprint: 'fp-d2', now: t10 }),
    t10
  );
  assert.equal(second.lineAttempted, true, 'KM差2公里超過1公里門檻，不應被視為同位置');
  assert.equal(second.lineSent, true);
});

// 路況-070 四節 (5): 與V2.7.0交互 — AI判斷materialChange:true但60分鐘內
// 且無嚴重度升級 -> 新規則仍應擋下（優先權高於V2.7.0）
test('scenario 5: AI判斷materialChange:true（V2.7.0本會放行）但60分鐘內無嚴重度升級 -> 新規則仍攔截，證明優先權更高', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '有實質變化但嚴重度未升級', confidence: 0.9, sameIncident: true, materialChange: true },
  ]);
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'E1' }), NOW);

  const t10 = new Date(NOW.getTime() + 10 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'E2', fingerprint: 'fp-e2', now: t10 }),
    t10
  );
  // V2.7.0's own suppressForNoChange requires sameIncident===true &&
  // materialChange===false — materialChange:true here means V2.7.0 itself
  // would NOT suppress. This proves the NEW rule (not V2.7.0) is what
  // blocks it.
  assert.equal(second.materialChange, true, 'sanity: V2.7.0本身不會攔這個情境（materialChange:true）');
  assert.equal(second.lineAttempted, false, '本規則優先權更高，即使V2.7.0判斷放行，仍應攔截');
  assert.equal(second.positionCooldownBlocked, true);
});

// 路況-070 四節 (6): 60分鐘邊界 — 第60分00秒 vs 第60分01秒
test('scenario 6: 60分鐘邊界 — 60分00秒仍攔截，60分01秒不攔截', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '第一次', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '60分00秒', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'F1' }), NOW);

  const at60 = new Date(NOW.getTime() + POSITION_COOLDOWN_WINDOW_MS);
  const atBoundary = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'F2', fingerprint: 'fp-f2', now: at60 }),
    at60
  );
  assert.equal(atBoundary.lineAttempted, false, '60分00秒仍在窗口內（inclusive），應攔截');

  const ai2 = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '第一次', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '60分01秒', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env2 = await baseEnv({ AI: ai2 });
  await processQueuedPbsEvent(env2, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'G1' }), NOW);
  const justAfter60 = new Date(NOW.getTime() + POSITION_COOLDOWN_WINDOW_MS + 1000);
  const afterBoundary = await processQueuedPbsEvent(
    env2,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'G2', fingerprint: 'fp-g2', now: justAfter60 }),
    justAfter60
  );
  assert.equal(afterBoundary.lineAttempted, true, '60分01秒視窗已過期，不應攔截');
});

// 路況-070 四節 (7): 首次事件（該位置尚無記錄）-> 不受影響
test('scenario 7: 首次事件（尚無任何記錄）-> 不攔截，正常建立新記錄', async () => {
  const ai = sequentialAi([{ notify: true, impact: 'HIGH', reason: '首次', confidence: 0.9 }]);
  const env = await baseEnv({ AI: ai });
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'H1' }), NOW);
  assert.equal(result.lineAttempted, true);
  assert.equal(result.lineSent, true);
  assert.notEqual(result.positionCooldownBlocked, true);
});

// 路況-070 四節 (8): 跨來源情境（PBS與TDX事件同位置、60分鐘內）
test('scenario 8: PBS事件先推播，60分鐘內同位置的TDX事件（Phase C開啟）無嚴重度升級 -> 跨來源仍正確攔截', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: 'PBS第一次發現', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: 'TDX同位置追蹤', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai, TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED: 'true' });
  const pbsResult = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'I-PBS' }), NOW);
  assert.equal(pbsResult.lineAttempted, true, 'sanity: PBS第一次必須真的推播出去，位置冷卻記錄才會被建立');

  const t10 = new Date(NOW.getTime() + 10 * 60_000);
  const tdxResult = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent(), eventId: 'I-TDX', fingerprint: 'fp-i-tdx', now: t10 }),
    t10
  );
  assert.equal(tdxResult.lineAttempted, false, 'PBS(displayKM)與TDX(startKM/endKM)透過同一份deriveEventLocationForMemory()描述比對，跨來源仍需正確辨識為同一位置');
  assert.equal(tdxResult.positionCooldownBlocked, true);
});

// 路況-070 四節 (9): 被攔截事件不寫入Shared Feed（regression lock）
test('scenario 9: 被本規則攔截的事件不寫入Shared Feed，Shared Feed內容維持第一次成功推播後的樣子', async () => {
  const ai = sequentialAi([
    { notify: true, impact: 'HIGH', reason: '第一次', confidence: 0.9 },
    { notify: true, impact: 'HIGH', reason: '應被攔截', confidence: 0.9, sameIncident: false, materialChange: false },
  ]);
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'J1' }), NOW);
  const sharedFeedAfterFirst = env.TRAFFIC_KV.store.get(SHARED_FEED_KEY);
  assert.ok(sharedFeedAfterFirst, 'sanity: 第一次成功推播必須寫入Shared Feed');

  const later = new Date(NOW.getTime() + 30 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'pbs', event: pbsAccidentEvent(), eventId: 'J2', fingerprint: 'fp-j2', now: later }),
    later
  );
  assert.equal(second.lineAttempted, false, 'sanity: 第二筆確實被本規則攔截');
  const sharedFeedAfterSecond = env.TRAFFIC_KV.store.get(SHARED_FEED_KEY);
  assert.equal(sharedFeedAfterSecond, sharedFeedAfterFirst, '被攔截的事件必須完全不寫入Shared Feed，內容應與第一次推播後逐字相同');
});

// 路況-070 四節 (10): 既有V2.7.0/V2.8.x回歸確認 — 交由本輪 git stash -u
// 全量迴歸比對負責（本檔案不重複既有測試檔案已覆蓋的情境）。
