// V2.4.11 — V2_4_11_DEBRIS_SAFETY_RISK_CLASSIFICATION_AND_PUSH_PROTECTION
// (路況工程部｜V2.4.11 散落物安全風險分級／LINE Push 額度保護施工令).
//
// The order's own minimum 19 required test cases (CASE 1-19), covering:
// every classification branch (HIGH_RISK/AI_REVIEW/LOW_RISK), the priority
// order that keeps a shoulder/quantity mention from ever overriding a real
// lane-position or explicit-impact match, the structured blockedLanes bonus
// signal, PBS/TDX parity through the SAME shared function, GEO/Road-Policy/
// LINE-formatter non-interference, 0 KV ops, and non-debris events being
// completely unaffected.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEBRIS_RISK, resolveDebrisSafetyRisk } from '../src/traffic/debrisRiskPolicy.js';
import { buildAiCandidate } from '../src/pbs/aiCandidate.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { AI_OUTCOME, listAiObservatoryEntries } from '../src/pbs/aiObservatoryIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function pbsRaw(overrides = {}) {
  return {
    UID: 'PBS-UID-DEBRIS-1',
    road: '國道一號',
    areaNm: '國道一號北向',
    direction: '北向',
    roadtype: '',
    comment: '',
    happendate: '2026-09-04',
    happentime: '10:00:00',
    modDttm: '2026-09-04 10:00:00',
    x1: 121.0,
    y1: 24.8,
    srcdetail: '',
    ...overrides,
  };
}

// TDX-shaped normalizedEvent — debugPush.js's own comment confirms a
// freeway/highway-sourced `event` object IS the normalizedEvent directly
// (no second normalize pass); this is the minimal field set
// aiCandidate.js#buildAiCandidate() reads for that shape.
function tdxNormalizedEvent(overrides = {}) {
  return {
    source: 'freeway',
    road: '國道三號',
    direction: '南向',
    location: '關西附近',
    description: '',
    sourceDetail: '',
    longitude: 121.2,
    latitude: 24.75,
    displayKM: 77,
    type: 'other',
    blockedLanes: null,
    ...overrides,
  };
}

test('CASE 1 (order section 四, real case): 國3南向77K關西附近中間車道有輪胎皮 -> HIGH_RISK (lane position)', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國3南向77K關西附近中間車道有輪胎皮' });
  assert.equal(result.isDebrisEvent, true);
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.equal(result.evidence.lanePosition, '中間車道');
  assert.ok(result.reasons.some((r) => r.includes('行車道位置')));
});

test('CASE 2 (order section 五, real case): 95K+200路面發現散落物狀況 (no object/size/quantity/lane/impact) -> AI_REVIEW', () => {
  const result = resolveDebrisSafetyRisk({ comment: '95K+200路面發現散落物狀況' });
  assert.equal(result.isDebrisEvent, true);
  assert.equal(result.classification, DEBRIS_RISK.AI_REVIEW);
  assert.equal(result.evidence.lanePosition, null);
  assert.equal(result.evidence.objectType, null);
  assert.equal(result.evidence.trafficImpact, false);
});

test('CASE 3: 路肩小型碎屑，明確未影響車道 -> LOW_RISK', () => {
  const result = resolveDebrisSafetyRisk({ comment: '散落物位於路肩，為小型碎屑' });
  assert.equal(result.isDebrisEvent, true);
  assert.equal(result.classification, DEBRIS_RISK.LOW_RISK);
});

test('CASE 4 (order section 十七): 已清除的散落物 -> LOW_RISK, no continuing danger', () => {
  const result = resolveDebrisSafetyRisk({ comment: '散落物已清除，恢復正常通行' });
  assert.equal(result.isDebrisEvent, true);
  assert.equal(result.classification, DEBRIS_RISK.LOW_RISK);
  assert.equal(result.evidence.cleared, true);
});

test('CASE 5: large hard object (鐵件) in the travel lane -> HIGH_RISK (lane + object both match)', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國1北向50K內側車道有鐵件掉落物' });
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.equal(result.evidence.lanePosition, '內側車道');
  assert.equal(result.evidence.objectType, '鐵件');
});

test('CASE 6: multiple/large quantity overrides a co-occurring 路肩 mention -> HIGH_RISK, not LOW_RISK', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國3北向120K路肩外散落物，多塊輪胎皮散落多處' });
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.ok(result.reasons.some((r) => r.includes('數量／範圍')));
});

test('CASE 7: explicit traffic-impact text -> HIGH_RISK', () => {
  const result = resolveDebrisSafetyRisk({ comment: '台61北向30K發現掉落物，已影響通行，車輛閃避頻繁' });
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.equal(result.evidence.trafficImpact, true);
});

test('CASE 8 (order section 七): 路肩大型物體部分侵入外側車道 -> still HIGH_RISK; the shoulder exception never overrides an actual lane intrusion', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國1南向80K路肩有大型貨物掉落物，部分侵入外側車道' });
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.equal(result.evidence.lanePosition, '外側車道');
});

test('CASE 9 (order section 十六): 大型紙箱掉落在快車道中央 -> HIGH_RISK via lane position, not because "紙箱" alone is a fixed danger word', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國3南向60K快車道中央有大型紙箱掉落物' });
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.ok(result.evidence.lanePosition);
});

test('CASE 10 (order section 十六): bare "紙箱" with no lane/quantity/impact evidence -> AI_REVIEW, never auto-LOW nor auto-HIGH from the word alone', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國3南向60K路面有紙箱掉落物，狀況不明' });
  assert.equal(result.classification, DEBRIS_RISK.AI_REVIEW);
});

test('CASE 11 (order section 六): debris confirmed on the safety island (off-road) -> LOW_RISK', () => {
  const result = resolveDebrisSafetyRisk({ comment: '散落物於安全島上，未影響行車' });
  assert.equal(result.classification, DEBRIS_RISK.LOW_RISK);
});

test('CASE 12 (order section 十二, structured signal): blockedLanes>=1 alone is sufficient for HIGH_RISK, equivalent to an explicit traffic-impact statement', () => {
  const result = resolveDebrisSafetyRisk({ description: '國3北向40K路面有異物', blockedLanes: 1 });
  assert.equal(result.classification, DEBRIS_RISK.HIGH_RISK);
  assert.equal(result.evidence.trafficImpact, true);
});

test('CASE 13: blockedLanes=0 (or absent) with vague text -> AI_REVIEW, never guessed as HIGH_RISK from blockedLanes alone', () => {
  const result = resolveDebrisSafetyRisk({ description: '國3北向40K路面有異物狀況說明中', blockedLanes: 0 });
  assert.equal(result.classification, DEBRIS_RISK.AI_REVIEW);
});

test('CASE 14 (order section 十一, PBS parity): the SAME HIGH_RISK text, built through the real PBS normalize+candidate pipeline, resolves HIGH_RISK', () => {
  const normalized = normalizePbsEvent(pbsRaw({ comment: '國3南向77K關西附近中間車道有輪胎皮' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-09-04T10:00:00+08:00' });
  assert.equal(candidate.debrisRisk.classification, DEBRIS_RISK.HIGH_RISK);
});

test('CASE 15 (order section 十一, TDX parity): the SAME HIGH_RISK text, built through the TDX-shaped candidate path, resolves HIGH_RISK via the identical shared function', () => {
  const normalized = tdxNormalizedEvent({ description: '國3南向77K關西附近中間車道有輪胎皮' });
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-09-04T10:00:00+08:00' });
  assert.equal(candidate.debrisRisk.classification, DEBRIS_RISK.HIGH_RISK);
  assert.equal(candidate.source, 'freeway');
});

test('CASE 16 (order section 十一/十九, GEO/Road-Policy non-interference): debrisRiskPolicy.js never imports the GEO resolver or the Road Management Policy gate', () => {
  const source = readFileSync(path.join(repoRoot, 'src/traffic/debrisRiskPolicy.js'), 'utf8');
  assert.ok(!source.includes('hsinchuGeoResolver'));
  assert.ok(!source.includes('roadManagementPolicyGate'));
  assert.ok(!source.includes('hsinchuFreewayKmRanges'));
  assert.ok(!/from ['"].*tdx\//.test(source), 'must not import anything from src/tdx/');
});

test('CASE 17 (LINE formatter non-interference): the existing LINE message-formatting module is not modified to read debrisRisk -- V2.4.8 cleanSummary remains the sole text-editing product', () => {
  const source = readFileSync(path.join(repoRoot, 'src/traffic/messageFormat.js'), 'utf8');
  assert.ok(!source.includes('debrisRisk'));
  assert.ok(!source.includes('DEBRIS_RISK'));
});

test('CASE 18 (order section 十三, 0 KV ops): resolveDebrisSafetyRisk is synchronous, takes no kv/env parameter, and returns a plain object -- structurally incapable of an I/O call', () => {
  assert.equal(resolveDebrisSafetyRisk.constructor.name, 'Function'); // never AsyncFunction
  assert.equal(resolveDebrisSafetyRisk.length, 1); // exactly one parameter: event
  const result = resolveDebrisSafetyRisk({ comment: '路肩發現散落物' });
  assert.equal(typeof result.then, 'undefined'); // not a Promise
});

test('CASE 19 (order section 十九): a non-debris event is completely unaffected -- isDebrisEvent:false, classification:null, no reasons/evidence fabricated', () => {
  const result = resolveDebrisSafetyRisk({ comment: '國1北向100K施工，機動路肩開放' });
  assert.deepEqual(result, { isDebrisEvent: false, classification: null, reasons: [], evidence: {} });

  // Also verify the full candidate-build integration path: every other
  // candidate field (eventType/road/direction/etc) is byte-identical to
  // what it was before this round -- debrisRisk is a purely additive field,
  // never a behavior change to any existing candidate property.
  const normalized = normalizePbsEvent(pbsRaw({ comment: '國1北向100K施工，機動路肩開放' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-09-04T10:00:00+08:00' });
  assert.equal(candidate.debrisRisk.isDebrisEvent, false);
  assert.equal(candidate.debrisRisk.classification, null);
  assert.equal(candidate.eventType, normalized.type);
});

// ---------------------------------------------------------------------
// Additional coverage beyond the order's own minimum 19, exercising the
// downstream integration points this classification feeds.
// ---------------------------------------------------------------------

test('buildAiUserPrompt (aiDecisionEngine.js) forwards candidate.debrisRisk as an additional structured fact, never a second decision', async () => {
  const { buildAiRequest } = await import('../src/pbs/aiDecisionEngine.js');
  const normalized = normalizePbsEvent(pbsRaw({ comment: '95K+200路面發現散落物狀況' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-09-04T10:00:00+08:00' });
  const request = buildAiRequest(candidate);
  const userPayload = JSON.parse(request.input.messages[1].content);
  assert.equal(userPayload.debrisRisk.classification, DEBRIS_RISK.AI_REVIEW);
  const systemPrompt = request.input.messages[0].content;
  assert.ok(systemPrompt.includes('散落物'));
});

test('a non-debris candidate carries debrisRisk:{isDebrisEvent:false,...} in the AI user prompt, never null-shaped away entirely (order section 十九)', async () => {
  const { buildAiRequest } = await import('../src/pbs/aiDecisionEngine.js');
  const normalized = normalizePbsEvent(pbsRaw({ comment: '國道一號北向94公里處發生追撞事故' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-09-04T10:00:00+08:00' });
  const request = buildAiRequest(candidate);
  const userPayload = JSON.parse(request.input.messages[1].content);
  assert.equal(userPayload.debrisRisk.isDebrisEvent, false);
});

// ---------------------------------------------------------------------
// End-to-end integration through the real ingress path
// (src/pbs/debugPush.js#processQueuedPbsEvent — the single shared PBS+TDX
// choke point): proves the LOW_RISK short-circuit actually skips the AI
// call and the LINE push, that HIGH_RISK/AI_REVIEW debris events still
// reach the real AI call unmodified, that the Observatory record carries
// the debrisRisk field, and that the KV write cost is byte-identical to
// every other event (order section 十三: NEW_KV_READS/WRITES/LISTS/
// DELETES_PER_EVENT = 0 beyond what every event already costs).
// ---------------------------------------------------------------------

const NOW = new Date('2026-09-04T10:00:00+08:00'); // within LINE broadcast hours

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

function mockAi(verdict) {
  return {
    calls: [],
    async run(model, input) {
      this.calls.push({ model, input });
      return { response: JSON.stringify(verdict) };
    },
  };
}

async function buildQueueMessage({ source, event, lifecycle = 'NEW', eventId, fingerprint = 'fp-1', now = NOW }) {
  const id = eventId || event.rawId;
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source, eventId: id, lifecycle, fingerprint });
  return {
    source,
    eventId: id,
    lifecycle,
    fingerprint,
    generatedAt: now.toISOString(),
    event,
    requestId: `test:${source}:${id}`,
    idempotencyKeyHash,
    acceptedFirstAcceptedAt: now.toISOString(),
    acceptedAttemptCount: 1,
  };
}

// A real coordinate confirmed inside the Hsinchu service area by prior
// rounds' own fixtures (see tdxUnifiedAiPipeline.test.js's own comment) —
// required or the event never even reaches candidate-build (SERVICE_AREA_
// EXCLUDED instead of exercising the debris path).
function freewayDebrisEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'FRW-DEBRIS-1',
      EventType: '其他',
      Description: '南向97K處路肩發現散落物，已清除',
      EffectiveTime: NOW.toISOString(),
      LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Positions: [{ PositionLon: 121.0, PositionLat: 24.8 }],
      ...overrides,
    },
    'freeway'
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
});

test('integration (TDX/freeway): a LOW_RISK debris event is excluded BEFORE any AI call -- 0 AI calls, 0 LINE push, outcome=DEBRIS_EXCLUDED_LOW_RISK', async () => {
  const ai = mockAi({ notify: true, impact: 'HIGH', reason: 'never reached', confidence: 0.9 });
  const env = { TRAFFIC_KV: countingKV(), LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: ai };
  const event = freewayDebrisEvent();
  const message = await buildQueueMessage({ source: 'freeway', event });

  const result = await processQueuedPbsEvent(env, message, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK);
  assert.equal(ai.calls.length, 0); // proves the AI was never invoked
  assert.equal(result.lineAttempted !== true, true); // never even attempted

  // Observatory record still carries the debrisRisk field, purely
  // additive to the SAME single write every event already produces.
  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { limit: 10 });
  const record = records.find((r) => r.eventId === 'FRW-DEBRIS-1');
  assert.ok(record);
  assert.equal(record.outcome, AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK);
  assert.equal(record.debrisRisk.classification, DEBRIS_RISK.LOW_RISK);
  assert.equal(record.debrisRisk.isDebrisEvent, true);
});

test('integration (TDX/freeway): a HIGH_RISK debris event still reaches the real AI call unmodified (order section 二/十九: AI stays the sole authority, never bypassed)', async () => {
  const ai = mockAi({ notify: true, impact: 'HIGH', reason: '中間車道輪胎皮，安全風險', confidence: 0.9 });
  const env = { TRAFFIC_KV: countingKV(), LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: ai };
  const event = freewayDebrisEvent({ EventID: 'FRW-DEBRIS-2', Description: '南向77K處中間車道有輪胎皮' });
  const message = await buildQueueMessage({ source: 'freeway', event, eventId: 'FRW-DEBRIS-2', fingerprint: 'fp-2' });

  const result = await processQueuedPbsEvent(env, message, NOW);

  assert.equal(result.ok, true);
  assert.equal(ai.calls.length, 1); // the AI WAS called -- HIGH_RISK never bypasses it
  assert.equal(result.outcome, AI_OUTCOME.AI_NOTIFY_TRUE);
  const userPayload = JSON.parse(ai.calls[0].input.messages[1].content);
  assert.equal(userPayload.debrisRisk.classification, DEBRIS_RISK.HIGH_RISK); // the AI sees the structured fact
});

test('integration (PBS): the SAME LOW_RISK short-circuit applies identically to a Windows PBS-sourced event (order section 十一: one shared choke point, not two per-source gates)', async () => {
  const ai = mockAi({ notify: true, impact: 'HIGH', reason: 'never reached', confidence: 0.9 });
  const env = { TRAFFIC_KV: countingKV(), LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: ai };
  const rawPbsEvent = {
    road: '國道一號',
    areaNm: '國道一號北向',
    direction: '北向',
    comment: '散落物位於路肩，為小型碎屑',
    longitude: 121.0,
    latitude: 24.8,
    sourceDetail: '',
  };
  const message = await buildQueueMessage({ source: 'pbs', event: rawPbsEvent, eventId: 'PBS-DEBRIS-1', fingerprint: 'fp-pbs-1' });

  const result = await processQueuedPbsEvent(env, message, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK);
  assert.equal(ai.calls.length, 0);
});

test('integration: KV write cost for a LOW_RISK-excluded event is unchanged from every other terminal outcome (order section 十三: 0 additional KV ops)', async () => {
  const ai = mockAi({ notify: true, impact: 'HIGH', reason: 'never reached', confidence: 0.9 });
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, AI: ai };
  const event = freewayDebrisEvent({ EventID: 'FRW-DEBRIS-3' });
  const message = await buildQueueMessage({ source: 'freeway', event, eventId: 'FRW-DEBRIS-3', fingerprint: 'fp-3' });

  await processQueuedPbsEvent(env, message, NOW);

  // Same 2-put shape as every other simple terminal TDX outcome in this
  // pipeline (idempotency COMPLETED + Observatory record) -- no third put,
  // no counter, no risk cache, no lookup table.
  assert.equal(kv.putCalls, 2);
});
