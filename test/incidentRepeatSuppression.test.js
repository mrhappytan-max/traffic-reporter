// V1.5.1 hotfix — production repro (2026-08-16): the same 國1 南向
// 97K+700 accident was notified twice, 10 minutes apart, with no real
// change a driver could see on LINE. Originally exercised the real Cron
// path (runScheduledTdxSync) end to end for the 9 required scenarios,
// fed entirely by TDX RoadEvent fixtures.
//
// V2.4.0 (TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE) — order section
// 四: LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT. A TDX freeway/
// highway event no longer reaches `broadcastEvents` inside scheduled.js
// AT ALL (see that module's own V2.4.0 comment), so it can no longer
// reach incidentSuppression.js via this path either — every scenario
// below that used to assert "1 LINE, then 0 (suppressed)" or "1 LINE,
// then 1 (material escalation)" now correctly asserts 0 at every step,
// since the TDX event never becomes a legacy broadcast candidate in the
// first place, whether or not it would have been suppressed under the
// old rules.
//
// THIS DOES NOT MEAN THE UNDERLYING SUPPRESSION/ESCALATION LOGIC LOST
// COVERAGE — incidentSuppression.js itself (resolveIncidentNotifications/
// isMaterialEscalation) is completely UNCHANGED by V2.4.0 and remains
// fully covered at the pure-unit level in test/incidentSuppression.test.js
// (same-rawId, different-rawId reissue, KM distance, direction, type
// escalation, blockedLanes escalation, unchanged=no escalation, distinct
// same-run accidents, GC after the window, KV I/O — literally every
// scenario this file used to exercise end-to-end). It is ALSO still
// exercised live for BOTH Windows PBS (legacy AI-disabled fallback) and
// TDX (new AI path, once TDX_ROADEVENT_QUEUE_INGRESS_ENABLED is on) via
// runAiApprovedPbsBroadcast — see test/aiApprovedPbsBroadcast.test.js and
// test/pbsDebugPush.test.js's own incidentSuppression coverage.
//
// This file's remaining job, same repurposing this round already applied
// to test/broadcastEligibility.test.js, is exactly order section 18's
// test 17: proving TDX never reaches LINE via the legacy Cron path,
// across the specific real-world scenarios this file's own production
// repro history cares about (reissued rawId, wording-only changes,
// escalation, blocked-lane increases, distinct nearby accidents).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

function kv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

// Matches the production repro: 國1 南向 97K+700.
function accidentRaw(overrides = {}) {
  return {
    EventID: 'FRW-97700-1',
    EventType: '事故',
    Description: '南向97K處車輛事故，外側車道封閉',
    EffectiveTime: '2026-08-16T17:15:00+08:00',
    LastUpdateTime: '2026-08-16T17:15:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
    Impact: { BlockedLanes: 1 },
    ...overrides,
  };
}

function mockFetch({ freewayEvents = [] }) {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response(JSON.stringify({ RoadEvents: freewayEvents }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS')) {
      return new Response(JSON.stringify({ CMSs: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty') || href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

async function withPushCapture(tdxFetch, run) {
  const pushed = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      pushed.push(JSON.parse(init.body).messages[0].text);
      return new Response('{}', { status: 200 });
    }
    return tdxFetch(url, init);
  };
  try {
    return { pushed, result: await run() };
  } finally {
    globalThis.fetch = priorFetch;
  }
}

async function envWithSubscriber() {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return {
    TDX_CLIENT_ID: 'id',
    TDX_CLIENT_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_PUSH_POLICY: 'ALL_ELIGIBLE',
    TRAFFIC_KV,
  };
}

afterEach(() => resetTdxTokenCache());

test('1. (V2.4.0) same accident, only updatedAt changed 10 min later -> 0 LINE at every tick via the legacy path (the original production repro scenario; suppression logic itself still covered in incidentSuppression.test.js)', async () => {
  const env = await envWithSubscriber();
  const r1720 = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ LastUpdateTime: '2026-08-16T17:15:00+08:00' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(r1720.pushed.length, 0);

  const r1730 = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ LastUpdateTime: '2026-08-16T17:24:00+08:00' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(r1730.pushed.length, 0);
});

test('2. (V2.4.0) same accident, description wording changed -> 0 LINE at every tick via the legacy path', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Description: '南向97K處車輛事故，外側車道封閉' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Description: '南向97K處車輛事故，外側車道封閉，警方處理中' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('3. (V2.4.0) same accident, NEW rawId shortly after (same road/direction/KM) -> 0 LINE at every tick via the legacy path', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-97700-1' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-97700-2-REISSUED' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('4. (V2.4.0) PBS + TDX report the SAME accident across DIFFERENT Cron ticks -> 0 LINE at every tick (TDX never reaches the legacy path; PBS legacy polling stays dormant unless explicitly re-enabled, unaffected by this round)', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw()] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  // A later tick: TDX no longer reports it, and PBS reports the same real
  // accident — but PBS_30_MIN_POLLING_ENABLED is never set here, so
  // (matching real Production default, unchanged since V1.9.8) PBS's own
  // legacy polling never actually runs either.
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = {
    fetch: async () =>
      new Response(
        JSON.stringify([
          {
            UID: 'PBS-97700-1', road: '國道一號', direction: '南向', areaNm: '國道一號南向', roadtype: '事故',
            comment: '南向97公里處車輛事故，外側車道封閉', happendate: '2026-08-16', happentime: '17:25:00',
            modDttm: '2026-08-16 17:29:00', srcdetail: '測試來源',
          },
        ]),
        { status: 200 }
      ),
  };
  const second = await withPushCapture(
    mockFetch({ freewayEvents: [] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('5. (V2.4.0) same accident, still unchanged 40 minutes later -> 0 LINE at every tick via the legacy path', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw()] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ LastUpdateTime: '2026-08-16T17:48:00+08:00' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T18:00:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('6. (V2.4.0) accident escalates to road closure -> still 0 LINE at every tick via the legacy path (escalation-unlocks-renotify logic itself still covered in incidentSuppression.test.js)', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw()] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  const second = await withPushCapture(
    mockFetch({
      freewayEvents: [
        accidentRaw({
          EventType: '封閉',
          Description: '8月16日17時至18時南向97K處車輛事故，道路全線封閉，請改道',
          LastUpdateTime: '2026-08-16T17:40:00+08:00',
        }),
      ],
    }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('7. (V2.4.0) blocked lanes materially increase -> still 0 LINE at every tick via the legacy path', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Impact: { BlockedLanes: 1 } })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Impact: { BlockedLanes: 3 }, LastUpdateTime: '2026-08-16T17:40:00+08:00' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('8. (V2.4.0) genuinely different accident, same road/direction, sufficiently different KM -> still 0 LINE at every tick via the legacy path', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-A', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } } })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 0);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-B', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '85K+000', EndKM: '85K+000' } } })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:40:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('9. (V2.4.0) two accidents, same road/direction, genuinely distinct location, reported in the same run -> 0 LINE (both fetched/classified correctly, neither reaches the legacy path)', async () => {
  const env = await envWithSubscriber();
  const events = [
    accidentRaw({ EventID: 'FRW-X', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } } }),
    accidentRaw({ EventID: 'FRW-Y', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '85K+000', EndKM: '85K+000' } } }),
  ];
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: events }), () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00')));

  assert.equal(pushed.length, 0);
  assert.equal(result.baselineSeedCount, 2); // cold KV -> baseline seed, both genuinely fetched/classified
});
