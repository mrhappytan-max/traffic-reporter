// End-to-end: TDX RoadEvent (or PBS) reports congestion -> real Cron path
// (runScheduledTdxSync) -> VD speed confirmation -> actual LINE message
// text. Complements the unit-level tests in congestionSeverity.test.js,
// vdSpeed.test.js, and congestionValidation.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { SEVERE_CONGESTION_MAX_KPH } from '../src/traffic/congestionValidation.js';

const VD_STATIC_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/Freeway?$format=JSON';
const VD_LIVE_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON';

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

function freewayCongestionRaw(overrides = {}) {
  return {
    EventID: 'FRW-CONGESTION-1',
    EventTitle: '國道一號北向92K壅塞',
    EventType: '壅塞',
    Description: '北向92K處壅塞，車多回堵',
    EffectiveTime: '2026-08-15T08:00:00+08:00',
    LastUpdateTime: '2026-08-15T08:55:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
    ...overrides,
  };
}

function freewayModerateRaw(overrides = {}) {
  return {
    ...freewayCongestionRaw(overrides),
    EventID: 'FRW-MODERATE-1',
    EventType: '車多',
    Description: '北向92K處車多',
  };
}

function vdStaticRecord(overrides = {}) {
  return { VDID: 'VD-92', RoadName: '國道一號', RoadDirection: 'N', LocationMile: '92K+000', ...overrides };
}

function mockFetch({ freewayEvents = [], vdSpeed = null, vdFails = false }) {
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
    if (href === VD_STATIC_URL) {
      if (vdFails) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ VDs: [vdStaticRecord()] }), { status: 200 });
    }
    if (href === VD_LIVE_URL) {
      if (vdFails) return new Response('boom', { status: 500 });
      const speed = vdSpeed;
      return new Response(
        JSON.stringify({ VDLives: speed === null ? [] : [{ VDID: 'VD-92', LinkFlows: [{ Lanes: [{ Speed: speed }] }] }] }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

const NOW = new Date('2026-08-15T09:00:00+08:00');

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

async function baseEnv() {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    // No PBS_RELAY_WINDOWS -> PBS pipeline fails closed but must not
    // affect TDX broadcasting (see the dedicated PBS failure test in
    // pbsLineBroadcast.test.js; this file focuses on VD validation).
  };
}

afterEach(() => resetTdxTokenCache());

test('壅塞 + VD confirms low speed -> LINE message reads 嚴重壅塞', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH - 10 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /^🐢 嚴重壅塞/);
});

test('壅塞 + VD reports normal speed -> LINE message reads 壅塞, NOT 嚴重壅塞', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH + 30 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /^🐢 壅塞/);
  assert.doesNotMatch(pushed[0], /嚴重壅塞/);
});

test('車多 (moderate) alone, no VD confirmation nearby -> LINE message reads 車流偏多, never 嚴重壅塞', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayModerateRaw()], vdSpeed: null }), // no VD reading at all
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /^🚗 車流偏多/);
  assert.doesNotMatch(pushed[0], /嚴重壅塞/);
});

test('車多 (moderate) + VD confirms genuinely low speed -> upgraded all the way to 嚴重壅塞', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayModerateRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH - 15 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /^🐢 嚴重壅塞/);
});

test('VD endpoint failure never blocks the congestion broadcast — still exactly 1 message, at its keyword-classified severity', async () => {
  const env = await baseEnv();
  const { pushed, result } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdFails: true }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /^🐢 壅塞/); // 壅塞 keyword classified it 'congested'; VD failure never upgrades OR blocks
  assert.equal(result.line.pushSucceeded, 1);
});

test('PBS + TDX both report the SAME congestion -> still exactly 1 message (cross-source dedup unaffected by severity work)', async () => {
  const env = await baseEnv();
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = {
    fetch: async () =>
      new Response(
        JSON.stringify([
          {
            UID: 'PBS-CONGESTION-1', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '壅塞',
            comment: '北向92公里處壅塞回堵中', happendate: '2026-08-15', happentime: '08:50:00',
            modDttm: '2026-08-15 08:56:00', srcdetail: '測試來源',
          },
        ]),
        { status: 200 }
      ),
  };

  const { pushed, result } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH - 10 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1); // not 2 — the whole point of cross-source dedup
  assert.equal(result.pbs.canonicalEventCount, 1);
  assert.match(pushed[0], /^🐢 嚴重壅塞/); // VD confirmation still upgrades the MERGED canonical event
});

test('a non-congestion event (accident) never triggers any VD fetch at all', async () => {
  let vdCalled = false;
  const env = await baseEnv();
  const tdxFetch = mockFetch({
    freewayEvents: [
      {
        EventID: 'FRW-ACC-1', EventType: '事故', Description: '北向92K事故',
        EffectiveTime: '2026-08-15T08:12:00+08:00', LastUpdateTime: '2026-08-15T08:20:00+08:00',
        Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
      },
    ],
  });
  const wrappedFetch = async (url, init) => {
    if (String(url) === VD_STATIC_URL || String(url) === VD_LIVE_URL) vdCalled = true;
    return tdxFetch(url, init);
  };

  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    return wrappedFetch(url, init);
  };
  try {
    await runScheduledTdxSync(env, NOW);
  } finally {
    globalThis.fetch = priorFetch;
  }

  assert.equal(vdCalled, false);
});
