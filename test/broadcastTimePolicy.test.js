// V1.8.6.8 — Driver-Relevant Event Broadcast Time Policy. Covers the
// task's own required 15 scenarios end-to-end through the REAL pipeline
// (runLineBroadcast), never a re-implementation of the time logic under
// test — every assertion here reads Pipeline Trace's own decision fields
// (eventActive/eventTimeStatus/broadcastWindowActive/status) and/or the
// actual LINE push outcome, both produced by the SAME authoritative path
// (effectiveWindow.js's classifyEventTimeStatus, broadcastRules.js's
// isBroadcastRelevant, broadcastHours.js's isWithinBroadcastHours) this
// round wired together — never a parallel/independent computation.
//
// Deterministic throughout: every `now` is an explicit Date with a fixed
// +08:00 offset, so results never depend on the machine's own local
// timezone (see scenario 15).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { buildUpstreamSnapshot } from '../src/traffic/pipelineTrace.js';

function createMockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
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

async function envWithSubscriber() {
  const TRAFFIC_KV = createMockKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
    // This file pins the broadcast TIME/WINDOW policy, using a night
    // construction event as its vehicle. The 重大事故限定 push policy
    // (broadcastPolicy.js) withholds construction, which would mask the
    // window behaviour under test — so opt into ALL_ELIGIBLE. Production
    // policy behaviour is pinned in test/pbsCctvMajorAccidentOnly.test.js.
  return { LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_PUSH_POLICY: 'ALL_ELIGIBLE', TRAFFIC_KV };
}

function nightConstructionEvent(overrides = {}) {
  // 台61線 — deliberately not 國道一號, so this never accidentally
  // engages CCTV eligibility; a plain 車道封閉-style construction event,
  // same "carries a real impact keyword" shape broadcastRules.js already
  // requires for type:'construction' (see the pre-existing forecast
  // test in broadcastPipeline.test.js for the identical pattern).
  return {
    source: 'highway',
    rawId: 'HWY-NIGHT-1',
    type: 'construction',
    road: '台61線',
    direction: '北向',
    // 2026-08-24 — structured KM added when the Location Quality Gate
    // shipped. Every REAL TDX 省道/國道 record carries StartKM/EndKM (see
    // fixtures.js's realHighwayConstructionEvent, taken from confirmed
    // production output); this fixture simply never bothered, because the
    // behaviour it pins is the TIME window, not the location. 48K/49K is
    // inside the configured 台61線 Hsinchu range (35-70, hsinchuConfig.js).
    startKM: '48K+000',
    endKM: '49K+000',
    description: '台61線8月20日21時至翌日6時封閉車道施工',
    updatedAt: '2026-08-20T12:00:00+08:00',
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: '施工',
      rawDirection: '北向',
      upstreamUpdatedAt: '2026-08-20T12:00:00+08:00',
      description: '台61線8月20日21時至翌日6時封閉車道施工',
    }),
    ...overrides,
  };
}

function dayConstructionEvent(overrides = {}) {
  return {
    source: 'highway',
    rawId: 'HWY-DAY-1',
    type: 'construction',
    road: '台1線',
    direction: '南向',
    // Same reason as nightConstructionEvent above; 90K/91K is inside the
    // configured 台1線 Hsinchu range (75-100, hsinchuConfig.js) and is the
    // exact KM pair fixtures.js's highwayEventTai1InRange already uses.
    startKM: '90K+000',
    endKM: '91K+000',
    description: '台1線8月15日9時至17時封閉車道施工',
    updatedAt: '2026-08-15T08:00:00+08:00',
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: '施工',
      rawDirection: '南向',
      upstreamUpdatedAt: '2026-08-15T08:00:00+08:00',
      description: '台1線8月15日9時至17時封閉車道施工',
    }),
    ...overrides,
  };
}

async function traceFor(event, now) {
  const env = await envWithSubscriber();
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  const trace = result.pipelineTraceEntries.find((e) => e.identity.rawId === event.rawId);
  return { result, trace };
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

function mockLineFetch() {
  const pushed = [];
  return {
    pushed,
    fetchFn: async (url, init) => {
      if (String(url).includes('api.line.me')) {
        pushed.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  };
}

// --- 1/2: same-day window (no crossing midnight) — regression baseline --

test('1: 施工 09:00～17:00, checked at 10:00 -> eventActive true, broadcastWindowActive true, pushed', async () => {
  const { pushed, fetchFn } = mockLineFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const { trace } = await traceFor(dayConstructionEvent(), new Date('2026-08-15T10:00:00+08:00'));
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.eventTimeStatus, 'active');
  assert.equal(trace.decision.broadcastWindowActive, true);
  assert.equal(pushed.length, 1);
  assert.equal(trace.status, 'line-sent');
});

test('2: same event checked at 18:00 (after 17:00 end) -> event ended, not pushed', async () => {
  const { trace } = await traceFor(dayConstructionEvent(), new Date('2026-08-15T18:00:00+08:00'));
  assert.equal(trace.decision.eventActive, false);
  assert.equal(trace.decision.eventTimeStatus, 'ended');
  assert.equal(trace.status, 'event-ended');
});

// --- 3-6: overnight window crossing midnight -----------------------------

test('3: 施工 21:00～翌日06:00, checked at 21:30 -> eventActive true, broadcastWindowActive true, pushed', async () => {
  const { pushed, fetchFn } = mockLineFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const { trace } = await traceFor(nightConstructionEvent(), new Date('2026-08-20T21:30:00+08:00'));
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.broadcastWindowActive, true);
  assert.equal(pushed.length, 1);
  assert.equal(trace.status, 'line-sent');
});

test('4: same event at 23:15 -> event active, but outside the 08:00-22:00 broadcast window -> not pushed', async () => {
  const { trace } = await traceFor(nightConstructionEvent(), new Date('2026-08-20T23:15:00+08:00'));
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.eventTimeStatus, 'active');
  assert.equal(trace.decision.broadcastWindowActive, false);
  assert.equal(trace.status, 'outside-broadcast-window');
});

test('5: same event at 02:00 (past midnight, still within the announced window) -> event active, still outside broadcast window', async () => {
  const { trace } = await traceFor(nightConstructionEvent(), new Date('2026-08-21T02:00:00+08:00'));
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.broadcastWindowActive, false);
  assert.equal(trace.status, 'outside-broadcast-window');
});

test('6: same event at 06:30 (past the 06:00 end) -> event ended', async () => {
  const { trace } = await traceFor(nightConstructionEvent(), new Date('2026-08-21T06:30:00+08:00'));
  assert.equal(trace.decision.eventActive, false);
  assert.equal(trace.decision.eventTimeStatus, 'ended');
  assert.equal(trace.status, 'event-ended');
});

// --- 7/8: multi-day recurring, including the last day crossing midnight --

test('7: multi-day daily construction (8/20-8/25, 每日21時至翌日6時) — a MIDDLE day (8/22) resolves correctly', async () => {
  const event = nightConstructionEvent({
    rawId: 'HWY-MULTI-1',
    description: '台61線8月20日至8月25日每日21時至翌日6時封閉車道施工',
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: '施工',
      rawDirection: '北向',
      description: '台61線8月20日至8月25日每日21時至翌日6時封閉車道施工',
    }),
  });
  const { pushed, fetchFn } = mockLineFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const { trace } = await traceFor(event, new Date('2026-08-22T21:30:00+08:00'));
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.broadcastWindowActive, true);
  assert.equal(pushed.length, 1);
});

test('8: same multi-day event — the LAST day (8/25) still crosses midnight correctly, checked at 8/26 02:00', async () => {
  const event = nightConstructionEvent({
    rawId: 'HWY-MULTI-1',
    description: '台61線8月20日至8月25日每日21時至翌日6時封閉車道施工',
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: '施工',
      rawDirection: '北向',
      description: '台61線8月20日至8月25日每日21時至翌日6時封閉車道施工',
    }),
  });
  const { trace } = await traceFor(event, new Date('2026-08-26T02:00:00+08:00'));
  assert.equal(trace.decision.eventActive, true, 'the range\'s last night must still be active, not prematurely "ended" just because the range nominally ends 8/25');
  assert.equal(trace.decision.broadcastWindowActive, false);
  assert.equal(trace.status, 'outside-broadcast-window');

  // And past the actual end (8/26 06:00), it genuinely ends.
  const { trace: afterEndTrace } = await traceFor(event, new Date('2026-08-26T07:00:00+08:00'));
  assert.equal(afterEndTrace.decision.eventActive, false);
  assert.equal(afterEndTrace.status, 'event-ended');
});

// --- 9/10/11: direction semantic equivalence in Pipeline Trace anomalies -

async function directionTrace(rawDirection, normalizedDirection) {
  const event = nightConstructionEvent({
    rawId: 'HWY-DIR-1',
    direction: normalizedDirection,
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '施工', rawDirection, description: '台61線8月20日21時至翌日6時封閉車道施工' }),
  });
  const { trace } = await traceFor(event, new Date('2026-08-20T21:30:00+08:00'));
  const { buildTraceAnomalies } = await import('../src/traffic/pipelineTrace.js');
  return buildTraceAnomalies(trace);
}

test('9: upstream "北上" vs normalized "北向" -> NOT flagged as DIRECTION_CHANGED (same real-world direction)', async () => {
  const anomalies = await directionTrace('北上', '北向');
  assert.equal(anomalies.some((a) => a.code === 'DIRECTION_CHANGED'), false);
});

test('10: upstream "南下" vs normalized "南向" -> NOT flagged as DIRECTION_CHANGED', async () => {
  const anomalies = await directionTrace('南下', '南向');
  assert.equal(anomalies.some((a) => a.code === 'DIRECTION_CHANGED'), false);
});

test('11: upstream "北向" vs normalized "南向" -> STILL flagged as DIRECTION_CHANGED (a genuine semantic change)', async () => {
  const anomalies = await directionTrace('北向', '南向');
  assert.equal(anomalies.some((a) => a.code === 'DIRECTION_CHANGED'), true);
});

// --- 12: genuine accident regression --------------------------------------

test('12: a genuine, structured-time accident is completely unaffected by this round\'s announced-event time policy — pushes immediately regardless of the 08:00-22:00 window logic applied to scheduled events', async () => {
  const event = normalizeRoadEvent(
    {
      EventID: 'ACC-1', EventType: '事故', EventSubType: '一般事故', Description: '北向93.5K車輛事故',
      EffectiveTime: '2026-08-20T20:13:00+08:00', LastUpdateTime: '2026-08-20T20:13:48+08:00',
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '93K+500', EndKM: '93K+000' } },
      Impact: { BlockedLanes: 1 },
    },
    'freeway'
  );
  const { pushed, fetchFn } = mockLineFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const { trace } = await traceFor(event, new Date('2026-08-20T20:20:00+08:00'));
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.eventTimeStatus, 'active');
  assert.equal(pushed.length, 1);
  assert.equal(trace.status, 'line-sent');
});

// --- 13: V57.2 gating unaffected ------------------------------------------

test('13: V57.2 freeway-gating architecture (crossSourceDedup.js) is untouched by this round — isFreewayRoadName/gating logic still importable and behaves as before', async () => {
  const { isFreewayRoadName } = await import('../src/pbs/roadName.js');
  const { crossSourceDedup } = await import('../src/pbs/crossSourceDedup.js');
  assert.equal(isFreewayRoadName('國道一號'), true);
  assert.equal(isFreewayRoadName('台61線'), false);
  const pbsEvent = {
    source: 'pbs', rawId: 'PBS-GATE-1', type: 'accident', road: '國道一號', direction: '北向',
    description: '北向93公里處事故', updatedAt: '2026-08-20T20:00:00+08:00',
  };
  const { uniquePbsEvents, filteredFreewayEvents } = crossSourceDedup([pbsEvent], []); // no TDX match
  assert.equal(uniquePbsEvents.length, 0);
  assert.equal(filteredFreewayEvents.length, 1); // still gated, unaffected by this round
});

// --- 14: Pipeline Trace reason correctness --------------------------------

test('14: Pipeline Trace shows the FULL breakdown (eventWindow, eventActive, eventTimeStatus, broadcastWindowActive, eligibilityReason) for a rejected event, not a single generic reason', async () => {
  const { trace } = await traceFor(nightConstructionEvent(), new Date('2026-08-20T23:15:00+08:00'));
  assert.ok(trace.decision.eventWindow, 'the raw effectiveStart/effectiveEnd/timeSource window must be visible, not just a boolean');
  assert.equal(trace.decision.eventWindow.timeSource, 'description');
  assert.ok(trace.decision.eligibilityReason);
  assert.equal(trace.decision.eventActive, true);
  assert.equal(trace.decision.eventTimeStatus, 'active');
  assert.equal(trace.decision.broadcastWindowActive, false);
  assert.equal(trace.status, 'outside-broadcast-window');
});

// --- 15: timezone fixed to Asia/Taipei, independent of the execution
// environment's own local timezone ------------------------------------

test('15: results are identical regardless of the process TZ (all conversions are explicit +08:00 arithmetic, never Date\'s own local-timezone methods)', async () => {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const { trace: laTrace } = await traceFor(nightConstructionEvent(), new Date('2026-08-20T23:15:00+08:00'));
    process.env.TZ = 'UTC';
    const { trace: utcTrace } = await traceFor(nightConstructionEvent(), new Date('2026-08-20T23:15:00+08:00'));
    assert.equal(laTrace.decision.eventActive, utcTrace.decision.eventActive);
    assert.equal(laTrace.decision.broadcastWindowActive, utcTrace.decision.broadcastWindowActive);
    assert.equal(laTrace.status, utcTrace.status);
    assert.equal(laTrace.decision.eventWindow.effectiveStart, utcTrace.decision.eventWindow.effectiveStart);
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
});
