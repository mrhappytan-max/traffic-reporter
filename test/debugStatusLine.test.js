import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { handleDebugStatus } from '../src/traffic/debugStatus.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

function makeFreewayRaw(id) {
  return {
    EventID: id,
    EventTitle: `國道一號北向92K事件${id}`,
    EventType: '事故',
    Description: '北向92K處發生車輛事故',
    EffectiveTime: '2026-08-15T08:00:00+08:00',
    LastUpdateTime: '2026-08-15T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+000', EndKM: '92K+500' } },
    Impact: { BlockedLanes: 1 },
  };
}

function mockTdxFetch(state) {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response(JSON.stringify({ RoadEvents: state.freewayEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS/City/Hsinchu')) {
      return new Response(JSON.stringify({ CMSs: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

let originalFetch;
let linePushCalled;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

test('/debug/status: no secrets anywhere in the response, across a fully "ready" system', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true);
  const env = {
    TDX_CLIENT_ID: 'real-tdx-client-id',
    TDX_CLIENT_SECRET: 'real-tdx-client-secret',
    LINE_CHANNEL_SECRET: 'real-line-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'real-line-access-token',
    TRAFFIC_KV: kv,
  };

  linePushCalled = false;
  originalFetch = globalThis.fetch;
  const state = { freewayEvents: [makeFreewayRaw('FRW-1')] };
  const tdxFetch = mockTdxFetch(state);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      linePushCalled = true;
      return new Response('{}', { status: 200 });
    }
    return tdxFetch(url, init);
  };

  const response = await handleDebugStatus(env);
  const bodyText = await response.text();

  for (const secret of [
    'real-tdx-client-id',
    'real-tdx-client-secret',
    'real-line-channel-secret',
    'real-line-access-token',
  ]) {
    assert.doesNotMatch(bodyText, new RegExp(secret), `${secret} must never appear in /debug/status`);
  }

  // And /debug/status must never actually call the LINE API, even when
  // it's "ready" and there's a broadcast-relevant event + a subscriber.
  assert.equal(linePushCalled, false);
});

test('/debug/status has zero side effects: KV is byte-for-byte unchanged across repeated calls with a real subscriber and a real event', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true);
  const env = {
    TDX_CLIENT_ID: 'id',
    TDX_CLIENT_SECRET: 'secret',
    LINE_CHANNEL_SECRET: 'line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    TRAFFIC_KV: kv,
  };

  originalFetch = globalThis.fetch;
  const state = { freewayEvents: [makeFreewayRaw('FRW-1')] };
  const tdxFetch = mockTdxFetch(state);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) throw new Error('LINE API must never be called from /debug/status');
    return tdxFetch(url, init);
  };

  const snapshotBefore = JSON.stringify([...kv.store.entries()].sort());

  await handleDebugStatus(env);
  await handleDebugStatus(env);
  await handleDebugStatus(env);

  const snapshotAfter = JSON.stringify([...kv.store.entries()].sort());
  assert.equal(snapshotAfter, snapshotBefore);
});
