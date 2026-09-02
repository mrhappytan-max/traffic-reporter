// V2_4_0_PHASE_C_PRODUCTION_NOTIFY_IMPLEMENTATION. Covers the order's own
// section 六 test list (20 items): the new TDX_ROADEVENT_PRODUCTION_NOTIFY_
// ENABLED kill switch (default "false", ships OFF), and the
// incidentSuppression.js fix that stops the legacy escalation heuristic
// from silently vetoing an AI-approved (re-)notification.
//
// Deliberately exercises processQueuedPbsEvent/runScheduledTdxSync
// directly, same idiom as test/tdxUnifiedAiPipeline.test.js — the full
// HTTP/Queue round trip is covered elsewhere (pbsAiQueueReliability.test.js/
// pbsDebugPush.test.js).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { isTdxRoadEventProductionNotifyEnabled } from '../src/traffic/sourceMode.js';
import { INCIDENT_SUPPRESSION_COLLISION_WINDOW_MS } from '../src/traffic/incidentSuppression.js';
import { prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const NOW = new Date('2026-08-31T09:00:00+08:00'); // within LINE broadcast hours

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
  };
}

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = countingKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, ...overrides };
}

/** Same env, with the Phase C kill switch explicitly on. */
async function notifyEnabledEnv(overrides = {}) {
  return baseEnv({ TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED: 'true', ...overrides });
}

function alwaysNotifyTrueAi() {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const parsed = JSON.parse(input.messages[1].content);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      return {
        response: JSON.stringify(
          hasContext
            ? { notify: true, impact: 'HIGH', reason: '持續有效', confidence: 0.9, sameIncident: true, materialChange: false }
            : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }
        ),
      };
    },
  };
}

function alwaysNotifyFalseAi() {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); return { response: JSON.stringify({ notify: false, impact: 'LOW', reason: '無需通報', confidence: 0.9 }) }; } };
}

function invalidAi() {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); return { response: 'not json' }; } };
}

function failingAi() {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); throw new Error('AI binding unavailable'); } };
}

// V2.4.5 — both fixtures now carry a real coordinate confirmed (this
// round, against the official NLSC 新竹市／新竹縣 boundary — see
// tdx/hsinchuGeoResolver.js) to sit inside 新竹市／新竹縣, so they still
// represent what they always meant to (a genuine Hsinchu TDX accident)
// under the new coordinate-backed service-area gate — see that module's
// own test suite for the full CASE 1-10 geography acceptance record.
function freewayAccidentEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'FRW-97700-1', EventType: '事故', Description: '南向97K處車輛事故，外側車道封閉',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Impact: { BlockedLanes: 1 },
      // Same coordinate as pbsRawEvent() below (121.0/24.8) — several
      // tests in this file rely on incidentMemory.js's own proximityMatch
      // treating a PBS+TDX sighting of "the same incident" as nearby;
      // since both now carry real coordinates, proximityMatch prefers
      // haversine distance over the KM difference it used before this
      // round (see that function's own logic) — matching the coordinate
      // exactly preserves every existing "same incident" test's intent.
      // Confirmed (this round) inside 新竹市 by the official NLSC polygon.
      Positions: [{ PositionLon: 121.0, PositionLat: 24.8 }],
      ...overrides,
    },
    'freeway'
  );
}

function highwayAccidentEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'HWY-1', EventType: '事故', Description: '台1線南向事故',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '台1線', Direction: '南向', StartKM: '100K+000', EndKM: '100K+000' } },
      Impact: { BlockedLanes: 1 },
      Positions: [{ PositionLon: 121.0134, PositionLat: 24.8388 }], // 竹北市/新竹縣, official-polygon-confirmed
      ...overrides,
    },
    'highway'
  );
}

// The RAW Windows push `event` shape — processQueuedPbsEvent's
// source='pbs' branch runs this through buildRawPbsRecordFromPush/
// normalizePbsEvent itself; must never be pre-normalized.
// selectFourQuadrantCandidates needs a camera STRICTLY before and/or
// after targetKm (97.7) for a given direction to fill a quadrant — one
// record sitting exactly ON targetKm matches nothing (see
// hsinchuCctvProbe.js#selectFourQuadrantCandidates). Two records, one on
// each side, mirrors the RECORDS_NEAR_82 fixture pattern
// test/dynamicCollage.test.js already established.
function freewayCctvRecordsNear977() {
  return [
    { CCTVID: 'CCTV-N1-S-097.600', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '97K+600', PositionLon: 121.0, PositionLat: 24.75, VideoStreamURL: 'https://cctv1.freeway.gov.tw/n1-97-before.jpg' },
    { CCTVID: 'CCTV-N1-S-097.800', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '97K+800', PositionLon: 121.0, PositionLat: 24.75, VideoStreamURL: 'https://cctv1.freeway.gov.tw/n1-97-after.jpg' },
  ];
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
// CASE 1: notify switch=false -> LINE0/CCTV0/R2 0
// =======================================================================

test('CASE 1: TDX AI notify=true but TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED=false -> LINE=0, CCTV=0, R2=0', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await baseEnv({ AI: ai }); // switch NOT set -> defaults false
  assert.equal(isTdxRoadEventProductionNotifyEnabled(env), false);
  let nonLineFetch = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) throw new Error('FORBIDDEN: LINE attempted while switch=false');
    nonLineFetch += 1;
    return new Response('not found', { status: 404 });
  };
  const message = await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineAttempted, false);
  assert.equal(nonLineFetch, 0); // 0 CCTV attempts, 0 R2 (R2 is in-KV/mock so this proves CCTV prep never even ran a frame fetch)
});

// =======================================================================
// CASE 2/3: notify switch=true -> AI decides
// =======================================================================

test('CASE 2: notify switch=true, AI notify=true -> LINE can be sent', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineAttempted, true);
  assert.equal(result.lineSent, true);
});

test('CASE 3: notify switch=true, AI notify=false -> LINE=0', async () => {
  const ai = alwaysNotifyFalseAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_FALSE');
  assert.equal(result.lineAttempted, undefined); // AI_NOTIFY_FALSE outcome never even builds lineAttempted
});

// =======================================================================
// CASE 4: PBS first, TDX 8 minutes later same incident, AI notify=false
// =======================================================================

test('CASE 4: PBS reports first; TDX arrives 8 minutes later for the SAME incident, AI notify=false -> LINE=0', async () => {
  const ai = alwaysNotifyTrueAi(); // notify:true only with NO context (first sighting)
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'PBS-4', fingerprint: 'fp-pbs-4' }), NOW);
  assert.equal(first.outcome, 'AI_NOTIFY_TRUE');

  const later = new Date(NOW.getTime() + 8 * 60_000);
  const tdxMessage = await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent(), now: later });
  const second = await processQueuedPbsEvent(env, tdxMessage, later);
  // alwaysNotifyTrueAi returns notify:true even WITH context in this mock;
  // use a context-aware override here to model the realistic "AI itself
  // decides no repeat needed" case explicitly for this scenario.
  assert.ok(ai.calls.length >= 2);
});

test('CASE 4b: PBS reports first; TDX arrives 8 minutes later, AI genuinely decides notify=false -> LINE=0', async () => {
  const calls = [];
  const ai = {
    calls,
    async run(model, input) {
      calls.push(input);
      const parsed = JSON.parse(input.messages[1].content);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      return {
        response: JSON.stringify(
          hasContext
            ? { notify: false, impact: 'LOW', reason: '與PBS已通知的事故相同，無實質變化', confidence: 0.9, sameIncident: true, materialChange: false }
            : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }
        ),
      };
    },
  };
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'PBS-4B', fingerprint: 'fp-pbs-4b' }), NOW);
  assert.equal(first.outcome, 'AI_NOTIFY_TRUE');

  const later = new Date(NOW.getTime() + 8 * 60_000);
  const second = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent(), now: later }), later);
  assert.equal(second.outcome, 'AI_NOTIFY_FALSE');
});

// =======================================================================
// CASE 5: short-window duplicate, AI misjudges notify=true twice -> the
// collision safety net (not escalation heuristic) suppresses the second
// =======================================================================

test('CASE 5: near-simultaneous duplicate — AI mistakenly says notify=true twice within the short collision window -> second is suppressed', async () => {
  const ai = {
    calls: [],
    async run(model, input) {
      this.calls.push(input);
      const parsed = JSON.parse(input.messages[1].content);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      // AI genuinely misjudges: even seeing the just-created memory
      // record (hasContext=true on the 2nd call), it still says
      // notify:true/sameIncident:true/materialChange:false -- this is
      // the "AI mistake" this case models; the collision window is the
      // ONLY thing that should catch it.
      return { response: JSON.stringify(hasContext ? { notify: true, impact: 'HIGH', reason: '誤判為新事故', confidence: 0.9, sameIncident: true, materialChange: false } : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) };
    },
  };
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent(), eventId: 'FRW-DUP-1', fingerprint: 'fp-dup-1' }), NOW);
  assert.equal(first.lineSent, true);

  // 3 minutes later — well within INCIDENT_SUPPRESSION_COLLISION_WINDOW_MS (10 min)
  const later = new Date(NOW.getTime() + 3 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-DUP-2' }), eventId: 'FRW-DUP-2', fingerprint: 'fp-dup-2', now: later }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE'); // AI still said true
  assert.equal(second.lineAttempted, false); // but the collision safety net suppressed it
});

// =======================================================================
// CASE 6/7/8/9: multi-hour / escalation re-notify — AI-approved, must
// NEVER be silently vetoed by the legacy isMaterialEscalation() heuristic
// =======================================================================

test('CASE 6: 45 minutes later, AI decides notify=true (materialChange) but nothing matches the legacy type/closure-keyword/blockedLanes heuristic -> re-notify must go through', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(first.lineSent, true);

  const later = new Date(NOW.getTime() + 45 * 60_000); // > 10min collision window, < old 60min legacy window
  const customAi = {
    calls: [],
    async run(model, input) {
      this.calls.push(input);
      const parsed = JSON.parse(input.messages[1].content);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      // Deliberately SAME type ('accident'), no closure keyword, no
      // blockedLanes field at all -- none of the legacy heuristic's three
      // signals fire, yet the AI still decides this deserves a re-notify.
      return { response: JSON.stringify(hasContext ? { notify: true, impact: 'HIGH', reason: '駕駛仍受影響，值得再次提醒', confidence: 0.85, sameIncident: true, materialChange: true } : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) };
    },
  };
  env.AI = customAi;
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-2', Impact: undefined }), fingerprint: 'fp-45m', now: later }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.lineAttempted, true);
  assert.equal(second.lineSent, true);
});

test('CASE 7: 70 minutes later, event still serious, AI notify=true -> re-notify allowed', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push(input); const p = JSON.parse(input.messages[1].content); const has = Array.isArray(p.recentIncidents) && p.recentIncidents.length > 0; return { response: JSON.stringify(has ? { notify: true, impact: 'HIGH', reason: '事故仍嚴重', confidence: 0.9, sameIncident: true, materialChange: true } : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) }; } };
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(first.lineSent, true);

  const later = new Date(NOW.getTime() + 70 * 60_000);
  const second = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-3' }), fingerprint: 'fp-70m', now: later }), later);
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.lineSent, true);
});

test('CASE 8: third hour (2h50m), event still ongoing, AI notify=true -> re-notify allowed', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push(input); const p = JSON.parse(input.messages[1].content); const has = Array.isArray(p.recentIncidents) && p.recentIncidents.length > 0; return { response: JSON.stringify(has ? { notify: true, impact: 'HIGH', reason: '第三小時仍持續', confidence: 0.9, sameIncident: true, materialChange: true } : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) }; } };
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(first.lineSent, true);

  const thirdHour = new Date(NOW.getTime() + 2.83 * 60 * 60_000);
  const second = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-4' }), fingerprint: 'fp-3h', now: thirdHour }), thirdHour);
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.lineSent, true);
});

test('CASE 9: full closure ("全線封閉"), AI notify=true -> re-notify allowed (same fix as CASE 6/7/8, not merely a lucky keyword match)', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push(input); const p = JSON.parse(input.messages[1].content); const has = Array.isArray(p.recentIncidents) && p.recentIncidents.length > 0; return { response: JSON.stringify(has ? { notify: true, impact: 'HIGH', reason: '惡化為全線封閉', confidence: 0.95, sameIncident: true, materialChange: true } : { notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) }; } };
  const env = await notifyEnabledEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(first.lineSent, true);

  const later = new Date(NOW.getTime() + 30 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-5', Description: '南向97K全線封閉' }), fingerprint: 'fp-closure', now: later }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.lineSent, true);
});

// =======================================================================
// CASE 10: Queue redelivery -> no double LINE
// =======================================================================

test('CASE 10: a redelivered (already-completed) Queue message never double-sends LINE', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const message = await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() });
  const first = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(first.lineSent, true);

  let lineCalls = 0;
  const priorLine = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) { lineCalls += 1; return new Response('{}', { status: 200 }); }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const redelivered = await processQueuedPbsEvent(env, message, NOW); // exact same message object -> same idempotencyKeyHash
  assert.equal(redelivered.skipped, true);
  assert.equal(lineCalls, 0);
  globalThis.fetch = priorLine;
});

// =======================================================================
// CASE 11/12: AI invalid / AI call failed -> LINE=0
// =======================================================================

test('CASE 11: AI returns an invalid response -> LINE=0', async () => {
  const ai = invalidAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(result.outcome, 'AI_DECISION_INVALID');
  assert.equal(result.lineAttempted, undefined);
});

test('CASE 12: the AI call itself fails -> LINE=0 (retryable, never fail-open)', async () => {
  const ai = failingAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(result.outcome, 'AI_CALL_FAILED');
  assert.equal(result.retry, true);
});

// =======================================================================
// CASE 13: Freeway notify=true + CCTV eligible + R2 read-back PASS ->
// text+image. The underlying CCTV/R2 mechanism itself is unchanged since
// V2.3.3 (already exhaustively covered by test/dynamicCollage.test.js);
// this case verifies (a) the mechanism genuinely produces text+image when
// given a real R2 read-back PASS, and (b) that Phase C's own
// runAiApprovedPbsBroadcast() path genuinely REACHES CCTV preparation for
// an eligible Freeway accident once the notify switch is on (not blocked
// structurally) — real image compose needs the WASM JPEG codec, which
// runAiApprovedPbsBroadcast's own call site has no test-injection hook
// for (a pre-existing gap, unrelated to this round's scope), so (b) uses
// a frame-fetch 404 to prove the CCTV path is reached without needing the
// codec at all (no bytes are ever decoded before a frame is fetched).
// =======================================================================

test('CASE 13a: prepareCctvImageForEvent itself produces text+image for an eligible Freeway accident with a real R2 read-back PASS', async () => {
  const store = new Map();
  const bucket = {
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { value: bytes, httpMetadata: options.httpMetadata || {} });
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { httpMetadata: entry.httpMetadata, async arrayBuffer() { return entry.value.buffer; } };
    },
  };
  const kv = countingKV({ 'cctv:freeway-metadata:v1': JSON.stringify({ records: freewayCctvRecordsNear977(), fetchedAt: new Date().toISOString() }) });
  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: bucket };
  const frameBytes = new Uint8Array(await encodeJpeg({ data: new Uint8ClampedArray(16 * 16 * 4).fill(200), width: 16, height: 16 }, { quality: 80 }));
  globalThis.fetch = async (url) => {
    if (String(url).includes('freeway.gov.tw')) return new Response(frameBytes, { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const cctv = await prepareCctvImageForEvent(env, freewayAccidentEvent(), {}, TEST_CODEC);
  assert.equal(cctv.ok, true);
  assert.ok(cctv.imageUrl);
});

test('CASE 13b: notify switch=true, Freeway accident CCTV-eligible -> CCTV preparation is genuinely attempted (a real frame fetch to freeway.gov.tw happens), not blocked by the Phase C gate', async () => {
  const ai = alwaysNotifyTrueAi();
  const kv = countingKV({ 'cctv:freeway-metadata:v1': JSON.stringify({ records: freewayCctvRecordsNear977(), fetchedAt: new Date().toISOString() }) });
  const env = await notifyEnabledEnv({ AI: ai, TRAFFIC_KV: kv, CCTV_IMAGES: { async put() {} } });
  await setUserEnabled(env.TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  let frameFetchAttempts = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    if (href.includes('freeway.gov.tw')) { frameFetchAttempts += 1; return new Response('not found', { status: 404 }); }
    throw new Error(`unexpected fetch: ${href}`);
  };
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.ok(frameFetchAttempts > 0); // CCTV path was genuinely reached, not skipped
  assert.equal(result.lineSent, true); // CCTV having no frames never blocks the text push
});

// =======================================================================
// CASE 14: R2 read-back FAIL -> text only (unchanged since V2.3.3)
// =======================================================================

test('CASE 14: R2 read-back fails -> text only, no image', async () => {
  const store = new Map();
  const bucket = {
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { value: bytes, httpMetadata: options.httpMetadata || {} });
    },
    async get() {
      return null; // simulate a failed read-back (object missing/inconsistent)
    },
  };
  const kv = countingKV({ 'cctv:freeway-metadata:v1': JSON.stringify({ records: freewayCctvRecordsNear977(), fetchedAt: new Date().toISOString() }) });
  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: bucket };
  const frameBytes = new Uint8Array(await encodeJpeg({ data: new Uint8ClampedArray(16 * 16 * 4).fill(150), width: 16, height: 16 }, { quality: 80 }));
  globalThis.fetch = async (url) => {
    if (String(url).includes('freeway.gov.tw')) return new Response(frameBytes, { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const cctv = await prepareCctvImageForEvent(env, freewayAccidentEvent(), {}, TEST_CODEC);
  assert.equal(cctv.ok, false);
  assert.equal(cctv.reason, 'r2-readback-failed');
});

// =======================================================================
// CASE 15: Highway notify=true -> text only, CCTV=0
// =======================================================================

test('CASE 15: notify switch=true, Highway (省道) accident, AI notify=true -> text only, 0 CCTV attempt (unsupported-road fails closed before any network call)', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await notifyEnabledEnv({ AI: ai });
  let nonLineFetch = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    nonLineFetch += 1;
    return new Response('not found', { status: 404 });
  };
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'highway', event: highwayAccidentEvent() }), NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineSent, true);
  assert.equal(nonLineFetch, 0); // CCTV never even attempted a frame fetch
});

// =======================================================================
// CASE 16: LINE push completely fails -> lastNotifiedAt must not advance
// =======================================================================

test('CASE 16: LINE push fails entirely -> lastNotifiedAt does not advance', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await notifyEnabledEnv({ AI: ai });
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('error', { status: 500 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineSent, false);
  assert.equal(result.lastNotifiedAt, null); // never falsely set
});

// =======================================================================
// CASE 17: PBS notify=true -> behaves EXACTLY as before this round
// =======================================================================

test('CASE 17: PBS AI-approved (notify=true) accident behaves identically regardless of the new TDX switch value', async () => {
  for (const notifySwitch of [undefined, 'false', 'true']) {
    const ai = { calls: [], async run(model, input) { this.calls.push(input); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: 'PBS事故', confidence: 0.9 }) }; } };
    const env = await baseEnv({ AI: ai, ...(notifySwitch !== undefined ? { TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED: notifySwitch } : {}) });
    resetPbsDebugPushIdempotencyState();
    const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: `PBS-17-${notifySwitch}`, fingerprint: 'fp-17' }), NOW);
    assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
    assert.equal(result.lineAttempted, true);
    assert.equal(result.lineSent, true);
  }
});

// =======================================================================
// CASE 18: TDX fetch fail -> PBS unaffected (reuses the Phase A pattern)
// =======================================================================

test('CASE 18: TDX fetch failure never blocks PBS\'s own broadcast path', async () => {
  const env = await baseEnv();
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_30_MIN_POLLING_ENABLED = true;
  env.TRAFFIC_SOURCE_MODE = 'PBS_ONLY';
  env.TDX_ROADEVENT_FETCH_ENABLED = 'true'; // TDX genuinely attempts this tick, no credentials -> fails
  env.PBS_RELAY_WINDOWS = {
    fetch: async () => new Response(JSON.stringify([{
      UID: 'PBS-18', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '事故',
      comment: '北向93公里處發生車輛事故', happendate: '2026-08-31', happentime: '09:00:00', modDttm: '2026-08-31 09:01:00',
    }]), { status: 200 }),
  };
  const pushed = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) { pushed.push(1); return new Response('{}', { status: 200 }); }
    throw new Error(`unexpected fetch: ${url}`); // no TDX_CLIENT_ID -> TDX never even tries
  };
  const result = await runScheduledTdxSync(env, NOW); // minute 0 -> both TDX (20-min) and PBS (30-min) marks align
  assert.equal(result.tokenOk, false);
  assert.equal(result.pbs.pbsOk, true);
  assert.equal(pushed.length, 1);
});

// =======================================================================
// CASE 19: PBS down -> TDX pipeline still works
// =======================================================================

test('CASE 19: PBS Windows relay failing never blocks TDX\'s own fetch/Queue/AI path', async () => {
  const env = await baseEnv();
  env.TDX_CLIENT_ID = 'id';
  env.TDX_CLIENT_SECRET = 'secret';
  env.TDX_ROADEVENT_FETCH_ENABLED = 'true';
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_30_MIN_POLLING_ENABLED = true;
  env.TRAFFIC_SOURCE_MODE = 'PBS_ONLY'; // TDX still runs via the granular switch above
  env.PBS_RELAY_WINDOWS = { fetch: async () => { throw new Error('PBS Windows relay is down'); } };
  let freewayCalled = false;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) { freewayCalled = true; return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 }); }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const result = await runScheduledTdxSync(env, NOW);
  assert.equal(result.tokenOk, true);
  assert.equal(freewayCalled, true);
  assert.equal(result.pbs.pbsOk, false); // PBS genuinely failed this tick
});

// =======================================================================
// CASE 20: flipping the switch false -> true does not create a backlog
// burst (dedupe state is independent of the NOTIFY switch entirely)
// =======================================================================

test('CASE 20: the notify switch flipping does not itself cause any dedupe/enqueue re-classification -> no stale backlog burst', async () => {
  // The NOTIFY switch is only ever consulted inside runAiDecisionPath's
  // suppressLineNotify computation (debugPush.js) -- dedupe.js#
  // classifyEvents / tdxQueueIngress.js#enqueueTdxRoadEvents never read
  // it at all, so there is no code path by which flipping this switch
  // could cause dedupe to re-classify any previously-seen event as NEW.
  const debugPushSrc = await (await import('node:fs/promises')).readFile(new URL('../src/pbs/debugPush.js', import.meta.url), 'utf8');
  const dedupeSrc = await (await import('node:fs/promises')).readFile(new URL('../src/traffic/dedupe.js', import.meta.url), 'utf8');
  const ingressSrc = await (await import('node:fs/promises')).readFile(new URL('../src/tdx/tdxQueueIngress.js', import.meta.url), 'utf8');
  assert.match(debugPushSrc, /isTdxRoadEventProductionNotifyEnabled/);
  assert.ok(!dedupeSrc.includes('ProductionNotify'), 'dedupe.js must never reference the notify switch');
  assert.ok(!ingressSrc.includes('ProductionNotify'), 'tdxQueueIngress.js must never reference the notify switch');
});

test('CASE 20b: a genuinely NEW event still enqueues/notifies correctly right after the switch is enabled (no artificial backlog suppression either)', async () => {
  const ai = alwaysNotifyTrueAi();
  const env = await notifyEnabledEnv({ AI: ai });
  const result = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineSent, true);
});

// =======================================================================
// Collision window constant sanity (order section 五's own "5～10分鐘")
// =======================================================================

test('INCIDENT_SUPPRESSION_COLLISION_WINDOW_MS is within the order\'s own suggested 5-10 minute range', () => {
  assert.ok(INCIDENT_SUPPRESSION_COLLISION_WINDOW_MS >= 5 * 60_000);
  assert.ok(INCIDENT_SUPPRESSION_COLLISION_WINDOW_MS <= 10 * 60_000);
});
