// V1.6.2 — debug endpoints must never quietly burn TDX quota. Covers the
// task's required scenarios A-D:
//   A. GET /debug/tdx      -> at most 2 TDX data calls (freeway+highway)
//   B. GET /debug/status   -> at most 2 TDX data calls, VD calls = 0
//   C. GET /debug/pbs      -> TDX calls = 0
//   D. GET /health         -> TDX calls = 0

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { handleDebugTdx } from '../src/tdx/debug.js';
import { handleDebugStatus } from '../src/traffic/debugStatus.js';
import { handleDebugPbs } from '../src/pbs/debugPbs.js';
import { handleHealth } from '../src/traffic/health.js';
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

const VD_STATIC_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/Freeway?$format=JSON';
const VD_LIVE_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON';

function congestionFreewayRaw() {
  return {
    EventID: 'FRW-CONG',
    EventType: '壅塞',
    Description: '北向92K壅塞回堵',
    EffectiveTime: '2026-08-18T08:00:00+08:00',
    LastUpdateTime: '2026-08-18T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
  };
}

function trackingTdxFetch(hits, { freewayEvents = [] } = {}) {
  return async (url) => {
    const href = String(url);
    hits.push(href);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response(JSON.stringify({ RoadEvents: freewayEvents }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    // Deliberately no CMS/Bus Alert/VD handlers — if any of those are
    // ever requested again by a debug endpoint, this throws and fails
    // the test loudly.
    throw new Error(`unexpected TDX-side fetch: ${href}`);
  };
}

afterEach(() => resetTdxTokenCache());

// --- A. /debug/tdx -> at most 2 TDX data calls ---

test('A. GET /debug/tdx makes at most 2 TDX data calls (freeway+highway only)', async () => {
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' };
  const hits = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = trackingTdxFetch(hits);
  try {
    const res = await handleDebugTdx(env);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = priorFetch;
  }
  const dataCalls = hits.filter((h) => !h.includes('openid-connect/token'));
  assert.equal(dataCalls.length, 2);
});

// --- B. /debug/status -> at most 2 TDX data calls, VD calls = 0 ---

test('B. GET /debug/status makes at most 2 TDX data calls, and 0 VD calls even with a congestion event', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV };
  const hits = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = trackingTdxFetch(hits, { freewayEvents: [congestionFreewayRaw()] });
  try {
    const res = await handleDebugStatus(env);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = priorFetch;
  }
  const dataCalls = hits.filter((h) => !h.includes('openid-connect/token'));
  assert.equal(dataCalls.length, 2);
  assert.ok(!hits.includes(VD_STATIC_URL));
  assert.ok(!hits.includes(VD_LIVE_URL));
  assert.ok(!hits.some((h) => h.includes('/Road/Traffic/Live/CMS')));
  assert.ok(!hits.some((h) => h.includes('/Bus/Alert/City/Hsinchu')));
});

// --- C. /debug/pbs -> TDX calls = 0 ---

test('C. GET /debug/pbs makes ZERO TDX calls', async () => {
  const TRAFFIC_KV = kv();
  const env = {
    TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token',
    PBS_RELAY_WINDOWS: { fetch: async () => new Response(JSON.stringify([]), { status: 200 }) },
  };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    throw new Error(`unexpected network call during /debug/pbs: ${JSON.stringify(args[0])}`);
  };
  try {
    const res = await handleDebugPbs(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tdxCacheStale, true); // no cache written yet in this test
    assert.equal(body.tdxCacheLastFetchedAt, null);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

// --- D. /health -> TDX calls = 0 ---

test('D. GET /health makes ZERO TDX calls', async () => {
  const snapshot = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    status: 'normal',
    tdx: { tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [], lastFetchedAt: new Date().toISOString(), scheduledThisRun: true, sleeping: false },
    pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
    line: { ready: true, enabledUsersCount: 1, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
    kv: { available: true },
    broadcast: { broadcastRelevantCount: 0, pendingTargetCount: 0, typeIneligibleCount: 0, ineligibleByReason: {}, incidentSuppressedCount: 0 },
  };
  const TRAFFIC_KV = kv();
  TRAFFIC_KV.store.set('health:snapshot:v1', JSON.stringify(snapshot));
  const env = { TRAFFIC_KV };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    throw new Error(`unexpected network call during /health: ${JSON.stringify(args[0])}`);
  };
  try {
    const res = await handleHealth(env);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = priorFetch;
  }
});
