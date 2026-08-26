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

  // V1.2C.1: the FIRST call legitimately populates the shared TDX token
  // cache in TRAFFIC_KV ('tdx:oauth-token-v1') so other isolates (including
  // future /debug/status calls) don't have to re-hit TDX OAuth. That's a
  // deliberate, one-time side effect of this feature, distinct from
  // "traffic state" (dedupe/notified/baseline/subscriptions) — so the
  // byte-for-byte comparison below starts AFTER that first call, and this
  // test still proves what it's meant to: repeated /debug/status calls are
  // fully idempotent from then on, including for the token cache itself.
  await handleDebugStatus(env);

  // V1.8.6 used to also write ONE new TDX usage-ledger entry per call
  // here (key prefix 'tdx:usage:entry:v1:', context='debug-status'). V1.9.2
  // retired that write entirely (TDX Usage Summary retired — see
  // usageLedger.js/scheduled.js's own V1.9.2 comments) — a repeated
  // /debug/status call is therefore now fully idempotent KV-wise,
  // including that prefix, not just the traffic-state keys. The filter
  // below is kept (now a no-op) purely so this test still reads as "the
  // byte-for-byte comparison intentionally excludes this prefix" rather
  // than silently changing its own meaning.
  const nonUsageLedgerEntries = (kv) => [...kv.store.entries()].filter(([k]) => !k.startsWith('tdx:usage:entry:v1:')).sort();

  const snapshotBefore = JSON.stringify(nonUsageLedgerEntries(kv));

  await handleDebugStatus(env);
  await handleDebugStatus(env);
  await handleDebugStatus(env);

  const snapshotAfter = JSON.stringify(nonUsageLedgerEntries(kv));
  assert.equal(snapshotAfter, snapshotBefore);

  // V1.9.2 — the usage ledger this call used to append to is retired;
  // repeated calls now write literally 0 of these keys.
  const usageLedgerEntryCount = [...kv.store.keys()].filter((k) => k.startsWith('tdx:usage:entry:v1:')).length;
  assert.equal(usageLedgerEntryCount, 0);
});
