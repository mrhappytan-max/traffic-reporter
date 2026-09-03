// V2_4_8_TDX_KM_FALLBACK_PRODUCTION_RUNTIME_DIAGNOSIS — 路況工程部｜P0 實機異常
// 查修令（TDX KM FALLBACK PRODUCTION PATH VERIFICATION）.
//
// Two real Production trace-page symptoms reported:
//   EVENT 1: TDX｜高公局, 國道一號 北向, description
//            "國道一號 北向 101K+300 施工事件-施工維護" — displayKM shown as "—".
//   EVENT 2: TDX｜高公局, 國道一號 南向, description
//            "國道一號 南向 100K+000 天候事件-天候不佳" — displayKM shown as "—".
// Both GEO=UNKNOWN / Gate A excluded.
//
// §一 root-cause chain (confirmed by direct runtime trace, not assumed):
//   A. extractKmTokenFromText()/parseKM() — CONFIRMED WORKING. Correctly
//      returns "101K+300"/101.3 and "100K+000"/100 for these exact strings.
//   B. tdx/normalize.js#normalizeRoadEvent() — CONFIRMED WORKING. Both
//      startKM/endKM/displayKM are correctly recovered via the V2.4.7 text
//      fallback and land on the returned normalized event object.
//   C. src/tdx/hsinchuGeoResolver.js#resolveTdxHsinchuGeography() — CONFIRMED
//      WORKING AND UNAFFECTED. It reads the real normalized `event` object
//      directly (never a pseudo-candidate), so it already received the KM
//      via kmHeuristic (observability-only tier, per V2.4.7's own safety
//      rule) and correctly still resolved UNKNOWN (no coordinate/text-place
//      evidence) — this is CORRECT safety behavior, not a bug (order §五
//      CASE 5's own acceptance criterion).
//   D. src/tdx/tdxQueueIngress.js#buildTdxPseudoCandidate() — THE BUG. This
//      Gate-A-drop-only local candidate builder predates V2.4.7's displayKM
//      field and was never updated to carry it forward, so
//      aiObservatoryIndex.js#buildAiObservatoryRecord() (which reads
//      candidate.displayKM) always wrote displayKM:null for any TDX event
//      dropped at Gate A — regardless of what normalize.js had actually
//      recovered. OBSERVABILITY_MAPPING_BUG, additive-only fix: propagate
//      event.displayKM into the pseudo-candidate, same convention as the
//      pre-existing longitude/latitude fields right next to it.
//   E. Events that PASS Gate A and reach AI already showed displayKM
//      correctly — they use the REAL candidate from
//      aiCandidate.js#buildAiCandidate(), which has carried displayKM since
//      V2.4.5, never buildTdxPseudoCandidate(). Confirmed unaffected by
//      this bug and this fix (CASE 4 below).
//
// GEO_RESOLVER_MODIFIED=NO, PBS_MODIFIED=NO, AI_MODIFIED=NO, LINE_MODIFIED=NO
// — this fix touches exactly one function's return object, adding one
// field, in one Gate-A-drop-only observability code path.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { extractKmTokenFromText, parseKM } from '../src/traffic/hsinchuFilter.js';
import { resolveTdxHsinchuGeography, HSINCHU_GEO_STATUS } from '../src/tdx/hsinchuGeoResolver.js';
import { enqueueTdxRoadEvents } from '../src/tdx/tdxQueueIngress.js';
import { listAiObservatoryEntries, AI_OUTCOME } from '../src/pbs/aiObservatoryIndex.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const NOW = new Date('2026-09-04T09:00:00+08:00');

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

// The two real Production raw shapes under investigation — no structured
// KM fields (Location.FreeExpressHighway.StartKM/EndKM), no Positions —
// exactly the shape a real TDX RoadEvent record for these two event types
// was reported to carry.
function event101K300() {
  return {
    EventID: 'PROD-101K300', EventType: '施工', EventSubType: '施工事件-施工維護',
    Description: '國道一號 北向 101K+300 施工事件-施工維護',
    EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
    RoadName: '國道一號', Direction: '北向',
  };
}
function event100K000() {
  return {
    EventID: 'PROD-100K000', EventType: '天候', EventSubType: '天候事件-天候不佳',
    Description: '國道一號 南向 100K+000 天候事件-天候不佳',
    EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
    RoadName: '國道一號', Direction: '南向',
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
// §五 CASE 1/2 — parser correctly recovers both real events' KM.
// =======================================================================

test('CASE 1: 101K+300 fallback parsing (real event 1)', () => {
  const token = extractKmTokenFromText('國道一號 北向 101K+300 施工事件-施工維護');
  assert.equal(token, '101K+300');
  assert.equal(parseKM(token), 101.3);

  const event = normalizeRoadEvent(event101K300(), 'freeway');
  assert.equal(event.startKM, '101K+300');
  assert.equal(event.endKM, '101K+300');
  assert.equal(event.displayKM, 101.3);
  assert.equal(event.provenance.kmSource.field, 'description-text-fallback');
});

test('CASE 2: 100K+000 fallback parsing (real event 2)', () => {
  const token = extractKmTokenFromText('國道一號 南向 100K+000 天候事件-天候不佳');
  assert.equal(token, '100K+000');
  assert.equal(parseKM(token), 100);

  const event = normalizeRoadEvent(event100K000(), 'freeway');
  assert.equal(event.startKM, '100K+000');
  assert.equal(event.endKM, '100K+000');
  assert.equal(event.displayKM, 100);
});

// =======================================================================
// §五 CASE 3 — full normalize() output carries displayKM into canonical
// facts (the object every downstream consumer, including the geo
// resolver, actually receives).
// =======================================================================

test('CASE 3: normalized canonical event object carries displayKM (not lost before the geo resolver)', () => {
  const event = normalizeRoadEvent(event101K300(), 'freeway');
  assert.equal(typeof event.displayKM, 'number');
  assert.equal(event.displayKM, 101.3);

  // resolveTdxHsinchuGeography() reads the REAL event object directly
  // (tdxQueueIngress.js's own call site) — confirm it genuinely receives
  // the KM via its observability-only kmHeuristic tier.
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.evidence.kmHeuristic.kmAvailable, true);
  assert.deepEqual(geo.evidence.kmHeuristic.kmPoints, [101.3, 101.3]);
});

// =======================================================================
// §五 CASE 4 — the Observatory record for a Gate-A-DROPPED TDX event must
// now show displayKM (the bug this round fixes). This is the exact
// end-to-end path both real Production events went through.
// =======================================================================

test('CASE 4a: real event 1 (101K+300, construction) dropped at Gate A -> Observatory record shows displayKM=101.3, not "—"', async () => {
  const env = await baseEnv();
  const event = normalizeRoadEvent(event101K300(), 'freeway');
  const result = await enqueueTdxRoadEvents(env, { newEvents: [event] }, NOW);

  // The drop decision itself is completely unaffected by this fix.
  assert.equal(result.enqueued, 0);
  assert.equal(result.droppedUnknownHsinchu, 1);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'PROD-101K300' });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, AI_OUTCOME.GEO_EXCLUDED_UNKNOWN);
  assert.equal(records[0].displayKM, 101.3); // THE FIX — was null before this round
  // Longitude/latitude correctly stay null: this event genuinely has no
  // raw Positions field, so "—" for those two IS correct, not a bug.
  assert.equal(records[0].longitude, null);
  assert.equal(records[0].latitude, null);
});

test('CASE 4b: real event 2 (100K+000, weather) dropped at Gate A -> Observatory record shows displayKM=100, not "—"', async () => {
  const env = await baseEnv();
  const event = normalizeRoadEvent(event100K000(), 'freeway');
  await enqueueTdxRoadEvents(env, { newEvents: [event] }, NOW);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'PROD-100K000' });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, AI_OUTCOME.GEO_EXCLUDED_UNKNOWN);
  assert.equal(records[0].displayKM, 100); // THE FIX
});

test('CASE 4c: TDX event that PASSES Gate A and reaches AI already showed displayKM correctly before this fix (buildAiCandidate path, unaffected)', async () => {
  const queued = [];
  const env = await baseEnv({ PBS_AI_QUEUE: { async send(msg) { queued.push(msg); } } });
  // A confirmed-Hsinchu coordinate (新竹市) so this event clears Gate A's
  // geography gate and reaches the real AI candidate path.
  const event = normalizeRoadEvent(
    {
      EventID: 'PROD-HSINCHU-KM', EventType: '施工', EventSubType: '施工事件-施工維護',
      Description: '國道三號 北向 96K+700 施工事件-施工維護',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道三號', Direction: '北向' }, },
      Positions: [{ PositionLon: 120.9686, PositionLat: 24.8066 }],
      Impact: { BlockedLanes: 2 },
    },
    'freeway'
  );
  assert.equal(event.displayKM, 96.7); // structured-vs-text irrelevant here; confirms recovery either way

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event] }, NOW);
  assert.equal(enqueueResult.enqueued, 1); // passes both Gate A steps

  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source: 'freeway', eventId: event.rawId, lifecycle: 'NEW', fingerprint: 'fp-km' });
  const message = {
    source: 'freeway', eventId: event.rawId, lifecycle: 'NEW', fingerprint: 'fp-km',
    generatedAt: NOW.toISOString(), event, requestId: 'test:freeway:PROD-HSINCHU-KM',
    idempotencyKeyHash, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1,
  };
  await processQueuedPbsEvent(env, message, NOW);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { eventId: 'PROD-HSINCHU-KM' });
  assert.equal(records.length, 1);
  assert.equal(records[0].displayKM, 96.7); // was already correct pre-fix (real buildAiCandidate path)
});

// =======================================================================
// §五 CASE 5 — safety: KM recovery/display alone must never upgrade the
// GEO decision. Both real events must stay UNKNOWN (0 Queue/0 AI/0 LINE).
// =======================================================================

test('CASE 5: KM successfully recovered and now visible on the trace page, but GEO decision stays UNKNOWN (safety unaffected by this fix)', async () => {
  const env = await baseEnv();
  const event1 = normalizeRoadEvent(event101K300(), 'freeway');
  const event2 = normalizeRoadEvent(event100K000(), 'freeway');

  const geo1 = resolveTdxHsinchuGeography(event1);
  const geo2 = resolveTdxHsinchuGeography(event2);
  assert.equal(geo1.status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.equal(geo2.status, HSINCHU_GEO_STATUS.UNKNOWN);

  const result = await enqueueTdxRoadEvents(env, { newEvents: [event1, event2] }, NOW);
  assert.equal(result.enqueued, 0); // 0 Queue
  assert.equal(result.droppedUnknownHsinchu, 2);

  const { records } = await listAiObservatoryEntries(env.TRAFFIC_KV, { limit: 10 });
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(r.outcome, AI_OUTCOME.GEO_EXCLUDED_UNKNOWN); // 0 AI / 0 LINE
    assert.notEqual(r.displayKM, null); // now visible...
  }
  // ...but visibility never became authority: neither record shows an AI
  // or LINE outcome, exactly as before this fix.
});

// =======================================================================
// Regression guard: Gate A drop KV write stays best-effort — a KV outage
// must still leave the drop decision (and the fix) unaffected.
// =======================================================================

test('missing TRAFFIC_KV: Gate A drop still happens correctly, buildTdxPseudoCandidate never throws even with the new displayKM field', async () => {
  const event = normalizeRoadEvent(event101K300(), 'freeway');
  const result = await enqueueTdxRoadEvents({}, { newEvents: [event] }, NOW);
  assert.equal(result.enqueued, 0);
  assert.equal(result.droppedUnknownHsinchu, 1);
});
