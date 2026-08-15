import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runTdxPipeline } from '../src/traffic/pipeline.js';
import { handleDebugStatus } from '../src/traffic/debugStatus.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import {
  realFreewayEvent,
  freewayEventOutsideHsinchu,
  realHighwayConstructionEvent,
  busAlertRealDetour,
  cmsCongestionMessage,
} from './fixtures.js';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function mockTdxFetch() {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response(
        JSON.stringify({ RoadEvents: [realFreewayEvent, freewayEventOutsideHsinchu] }),
        { status: 200 }
      );
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [realHighwayConstructionEvent] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS/City/Hsinchu')) {
      return new Response(JSON.stringify({ CMSs: [cmsCongestionMessage] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [busAlertRealDetour] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

test('runTdxPipeline: geo-filters Freeway, then dedupes against KV, and the first run seeds the baseline', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch();
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };

  const first = await runTdxPipeline(env);
  assert.equal(first.tokenOk, true);
  // freeway: 1 of 2 survives the geo filter; highway: 1; cms: 1; bus-hsinchu: 1; bus-hsinchu-county: 0
  assert.equal(first.totalEvents, 4);
  assert.equal(first.pendingCount, 4); // first sighting of everything = baseline
  assert.equal(first.duplicateCount, 0);
  assert.ok(first.pending.every((e) => e.rawId));
  assert.ok(!first.pending.some((e) => e.rawId === freewayEventOutsideHsinchu.EventID));

  // Second run with identical data: everything should now be a duplicate.
  const second = await runTdxPipeline(env);
  assert.equal(second.pendingCount, 0);
  assert.equal(second.duplicateCount, 4);
});

test('GET /debug/status returns 200 and caps the pending list', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: createMockKV() };

  const response = await handleDebugStatus(env);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.tokenOk, true);
  assert.equal(body.totalEvents, 4);
  assert.equal(body.pendingCount, 4);
  assert.ok(Array.isArray(body.pending));
  assert.ok(Array.isArray(body.sources));
  assert.equal(body.sources.length, 5);
});

test('runScheduledTdxSync runs the same pipeline without throwing when TRAFFIC_KV is present', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: createMockKV() };

  const summary = await runScheduledTdxSync(env);
  assert.equal(summary.tokenOk, true);
  assert.equal(summary.pendingCount, 4);
});
