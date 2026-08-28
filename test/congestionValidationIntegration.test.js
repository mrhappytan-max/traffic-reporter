// End-to-end: TDX RoadEvent (or PBS) reports congestion -> real Cron path
// (runScheduledTdxSync) -> actual LINE message text. Complements the
// unit-level tests in congestionSeverity.test.js, vdSpeed.test.js, and
// congestionValidation.test.js.
//
// V1.6.1 update: the Cron path no longer calls applyCongestionSeverityValidation
// at all (no VD API call happens here anymore — see scheduled.js's module
// comment; V1.5 already excludes every congestion event from broadcast
// regardless of severity, so VD confirmation had no production purpose
// left). Every test below still passes unmodified: they all assert
// `pushed.length === 0` for congestion, which now holds even more
// directly (VD is never even invoked). Kept as regression coverage that
// a congestion event — VD-confirmed or not — can never reach LINE.

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

// V1.5: pure congestion is no longer broadcast-eligible AT ALL (see
// broadcastRules.js's isBroadcastEligibleType) — professional drivers
// already have Google Maps/1968 for ordinary traffic flow. This applies
// EVEN to a VD-confirmed 'severe' congestion event: the severity
// computation below still runs in full (still visible via GET
// /debug/status — see requirement "congestion 仍可保留在 debug/status")
// and is still exhaustively unit-tested in congestionValidation.test.js,
// but the eligibility gate in broadcastPipeline.js runs strictly BEFORE
// clustering/relevance/push, so no severity outcome — moderate,
// congested, or a genuinely VD-confirmed severe — can ever reach LINE.
// The tests below are the regression guard for exactly that: a VD
// upgrade to 'severe' must never accidentally bypass the new gate.

test('壅塞 + VD confirms low speed (would be "severe") -> still 0 LINE messages', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH - 10 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 0);
});

test('壅塞 + VD reports normal speed -> still 0 LINE messages', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH + 30 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 0);
});

test('車多 (moderate) alone, no VD confirmation nearby -> still 0 LINE messages', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayModerateRaw()], vdSpeed: null }), // no VD reading at all
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 0);
});

test('車多 (moderate) + VD confirms genuinely low speed (would be upgraded to "severe") -> still 0 LINE messages — VD confirmation never bypasses the new eligibility gate', async () => {
  const env = await baseEnv();
  const { pushed } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayModerateRaw()], vdSpeed: SEVERE_CONGESTION_MAX_KPH - 15 }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 0);
});

test('VD endpoint failure -> still 0 LINE messages, does not crash the Cron run', async () => {
  const env = await baseEnv();
  const { pushed, result } = await withPushCapture(
    mockFetch({ freewayEvents: [freewayCongestionRaw()], vdFails: true }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 0);
  assert.equal(result.line.pushSucceeded, 0);
});

test('PBS + TDX both report the SAME congestion -> still 0 LINE messages (not 2, not 1 — zero)', async () => {
  const env = await baseEnv();
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_30_MIN_POLLING_ENABLED = true; // V1.9.8: this file exercises the (unchanged) PBS pipeline via the polling entry point on purpose
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

  assert.equal(pushed.length, 0);
  // Cross-source dedup itself still ran correctly (still visible in
  // debug/status) — it's only the broadcast step that's now gated off.
  assert.equal(result.pbs.canonicalEventCount, 1);
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
