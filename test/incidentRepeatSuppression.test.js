// V1.5.1 hotfix — production repro (2026-08-16): the same 國1 南向
// 97K+700 accident was notified twice, 10 minutes apart, with no real
// change a driver could see on LINE. Exercises the real Cron path
// (runScheduledTdxSync) end to end for the 9 required scenarios.

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
  return { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV };
}

afterEach(() => resetTdxTokenCache());

test('1. same accident, only updatedAt changed 10 min later -> 1 LINE total (the production repro)', async () => {
  const env = await envWithSubscriber();
  const tdxFetch1720 = mockFetch({ freewayEvents: [accidentRaw({ LastUpdateTime: '2026-08-16T17:15:00+08:00' })] });
  const r1720 = await withPushCapture(tdxFetch1720, () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00')));
  assert.equal(r1720.pushed.length, 1);

  const tdxFetch1730 = mockFetch({ freewayEvents: [accidentRaw({ LastUpdateTime: '2026-08-16T17:24:00+08:00' })] });
  const r1730 = await withPushCapture(tdxFetch1730, () => runScheduledTdxSync(env, new Date('2026-08-16T17:30:00+08:00')));
  assert.equal(r1730.pushed.length, 0);
  assert.equal(r1730.result.line.incidentSuppressedCount, 1);
});

test('2. same accident, description wording changed (police-handling note added) -> 1 LINE total', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Description: '南向97K處車輛事故，外側車道封閉' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Description: '南向97K處車輛事故，外側車道封閉，警方處理中' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:30:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('3. same accident, NEW rawId within 10 min, same road/direction/KM -> 1 LINE total', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-97700-1' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);

  // TDX reissues under a brand-new EventID for the same real accident.
  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-97700-2-REISSUED' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:28:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('4. PBS + TDX report the SAME accident across DIFFERENT Cron ticks -> 1 LINE total', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw()] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);

  // A later tick: TDX no longer reports it (already gone from the live
  // feed), but PBS reports the same real accident on its own.
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
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:30:00+08:00'))
  );
  assert.equal(second.pushed.length, 0);
});

test('5. same accident, still unchanged 30 minutes later -> still 1 LINE total', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw()] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ LastUpdateTime: '2026-08-16T17:48:00+08:00' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:50:00+08:00')) // +30 min
  );
  assert.equal(second.pushed.length, 0);
});

test('6. accident escalates to road closure -> second notification allowed', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw()] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);
  assert.match(first.pushed[0], /🚨 交通事故/);

  const second = await withPushCapture(
    mockFetch({
      freewayEvents: [
        accidentRaw({
          EventType: '封閉',
          // closure is not a LIVE type (only accident/congestion are —
          // see effectiveWindow.js), so it needs a parseable Chinese
          // date range to become broadcast-relevant at all — same
          // requirement as this project's other closure/construction
          // tests (see broadcastEligibility.test.js #4).
          Description: '8月16日17時至18時南向97K處車輛事故，道路全線封閉，請改道',
          LastUpdateTime: '2026-08-16T17:28:00+08:00',
        }),
      ],
    }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:30:00+08:00'))
  );
  assert.equal(second.pushed.length, 1);
  assert.match(second.pushed[0], /🚧 道路封閉/);
  // Note: this specific escalation (type changes AWAY from 'accident')
  // is handled by the ORDINARY per-event fingerprint mechanism, not
  // incidentSuppression.js's own tracking — accidentRelevant only ever
  // routes CURRENTLY type==='accident' events into that module (see
  // broadcastPipeline.js), so a record that has already become
  // type==='closure' by the time it's evaluated naturally falls through
  // to the normal path instead. It still gets through correctly because
  // computeNotificationFingerprint() includes `type`, so the fingerprint
  // differs from what was stored — no incidentSuppression involvement
  // needed for this particular escalation shape.
  assert.equal(second.result.line.materialRebroadcastCount, 0);
});

test('7. blocked lanes materially increase -> second notification allowed', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Impact: { BlockedLanes: 1 } })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);

  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ Impact: { BlockedLanes: 3 }, LastUpdateTime: '2026-08-16T17:28:00+08:00' })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:30:00+08:00'))
  );
  assert.equal(second.pushed.length, 1);
  assert.equal(second.result.line.materialRebroadcastCount, 1);
});

test('8. genuinely different accident, same road/direction, sufficiently different KM -> both broadcast', async () => {
  const env = await envWithSubscriber();
  const first = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-A', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } } })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00'))
  );
  assert.equal(first.pushed.length, 1);

  // A completely different accident, ~13km up the road (still within
  // the Hsinchu-relevant range for 國道一號, 80K-105K — see
  // hsinchuConfig.js — but well beyond INCIDENT_MAX_KM_DIFF), minutes later.
  const second = await withPushCapture(
    mockFetch({ freewayEvents: [accidentRaw({ EventID: 'FRW-B', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '85K+000', EndKM: '85K+000' } } })] }),
    () => runScheduledTdxSync(env, new Date('2026-08-16T17:25:00+08:00'))
  );
  assert.equal(second.pushed.length, 1);
});

test('9. two accidents, same road/direction, genuinely distinct location AND reported in the same run -> both broadcast, not accidentally merged', async () => {
  const env = await envWithSubscriber();
  const events = [
    accidentRaw({ EventID: 'FRW-X', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } } }),
    accidentRaw({ EventID: 'FRW-Y', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '85K+000', EndKM: '85K+000' } } }),
  ];
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: events }), () => runScheduledTdxSync(env, new Date('2026-08-16T17:20:00+08:00')));

  assert.equal(pushed.length, 2);
  assert.equal(result.line.incidentSuppressedCount, 0);
});
