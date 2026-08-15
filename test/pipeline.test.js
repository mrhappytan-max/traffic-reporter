import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runTdxPipelinePreview, runTdxPipelineAndCommit } from '../src/traffic/pipeline.js';
import { handleDebugStatus } from '../src/traffic/debugStatus.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';

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

// All within the configured Hsinchu range for 國道一號 (see hsinchuConfig.js)
// so they survive the geo filter without any fixture juggling.
function makeFreewayRaw(id, overrides = {}) {
  return {
    EventID: id,
    EventTitle: `國道一號北向92K事件${id}`,
    EventType: '事故',
    Description: '北向92K處發生車輛事故',
    EffectiveTime: '2026-08-15T08:00:00+08:00',
    LastUpdateTime: '2026-08-15T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+000', EndKM: '92K+500' } },
    Impact: { BlockedLanes: 1 },
    ...overrides,
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

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

test('Cron lifecycle: baseline -> stable -> new event -> content update -> timestamp-only is not an update', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const state = { freewayEvents: Array.from({ length: 10 }, (_, i) => makeFreewayRaw(`FRW-${i + 1}`)) };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  // 1) First-ever Cron run: 10 pre-existing events must NOT flood as new.
  const run1 = await runScheduledTdxSync(env);
  assert.equal(run1.baselineInitialized, true);
  assert.equal(run1.baselineSeedCount, 10);
  assert.equal(run1.newEventsCount, 0);
  assert.equal(run1.updatedEventsCount, 0);
  assert.equal(run1.pushableEventsCount, 0);

  // 2) Second run, identical data: nothing new, nothing updated.
  const run2 = await runScheduledTdxSync(env);
  assert.equal(run2.newEventsCount, 0);
  assert.equal(run2.updatedEventsCount, 0);
  assert.equal(run2.duplicateCount, 10);
  assert.equal(run2.pushableEventsCount, 0);

  // 3) Third run: one genuinely new rawId added.
  state.freewayEvents = [...state.freewayEvents, makeFreewayRaw('FRW-11')];
  const run3 = await runScheduledTdxSync(env);
  assert.equal(run3.newEventsCount, 1);
  assert.equal(run3.updatedEventsCount, 0);
  assert.equal(run3.pushableEventsCount, 1);

  // 4) Fourth run: FRW-1's description changes (a real, driver-relevant
  // change) -> counts as an update.
  state.freewayEvents = state.freewayEvents.map((e) =>
    e.EventID === 'FRW-1' ? makeFreewayRaw('FRW-1', { Description: '北向92K事故已排除，車道恢復通行' }) : e
  );
  const run4 = await runScheduledTdxSync(env);
  assert.equal(run4.newEventsCount, 0);
  assert.equal(run4.updatedEventsCount, 1);
  assert.equal(run4.pushableEventsCount, 1);

  // 5) Fifth run: only LastUpdateTime changes on FRW-1 (content identical)
  // -> must NOT be treated as a major update.
  state.freewayEvents = state.freewayEvents.map((e) =>
    e.EventID === 'FRW-1'
      ? makeFreewayRaw('FRW-1', {
          Description: '北向92K事故已排除，車道恢復通行',
          LastUpdateTime: '2026-08-15T09:30:00+08:00',
        })
      : e
  );
  const run5 = await runScheduledTdxSync(env);
  assert.equal(run5.newEventsCount, 0);
  assert.equal(run5.updatedEventsCount, 0);
  assert.equal(run5.pushableEventsCount, 0);
});

test('GET /debug/status is fully read-only: repeated calls never touch KV state', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const state = { freewayEvents: [makeFreewayRaw('FRW-1'), makeFreewayRaw('FRW-2')] };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  assert.equal(kv.store.size, 0);

  const r1 = await handleDebugStatus(env);
  const body1 = await r1.json();
  assert.equal(body1.baselineInitialized, false);
  assert.equal(kv.store.size, 0); // still nothing written

  const r2 = await handleDebugStatus(env);
  const body2 = await r2.json();
  assert.equal(body2.baselineInitialized, false);
  assert.equal(kv.store.size, 0); // still nothing written after a second call

  // pushableEventsCount must be 0 pre-baseline in the preview too, mirroring
  // exactly what the real Cron run would do.
  assert.equal(body1.pushableEventsCount, 0);
  assert.equal(body2.pushableEventsCount, 0);

  // Now actually establish the baseline via the real Cron path...
  await runScheduledTdxSync(env);
  const sizeAfterBaseline = kv.store.size;
  assert.ok(sizeAfterBaseline > 0);

  // ...and confirm /debug/status still never mutates state, even though it
  // can now see (read-only) that the baseline exists.
  const r3 = await handleDebugStatus(env);
  const body3 = await r3.json();
  assert.equal(body3.baselineInitialized, true);
  assert.equal(kv.store.size, sizeAfterBaseline);

  await handleDebugStatus(env);
  await handleDebugStatus(env);
  assert.equal(kv.store.size, sizeAfterBaseline); // unchanged after repeated calls
});

test('KV read failure: kvAvailable=false and pushableEventsCount=0, TDX data itself is unaffected', async () => {
  const brokenKv = {
    async get() {
      throw new Error('KV read outage');
    },
    async put() {
      throw new Error('should not be called after a read failure');
    },
  };
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: brokenKv };
  const state = { freewayEvents: [makeFreewayRaw('FRW-1')] };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  const summary = await runTdxPipelineAndCommit(env);
  assert.equal(summary.kvAvailable, false);
  assert.match(summary.kvError, /KV read outage/);
  assert.equal(summary.pushableEventsCount, 0);
  assert.equal(summary.newEventsCount, 0);
  assert.equal(summary.updatedEventsCount, 0);
  assert.equal(summary.hsinchuFilteredCount, 1); // TDX fetch + geo filter still worked
});

test('KV write failure: kvAvailable=false and pushableEventsCount=0 even though the read succeeded', async () => {
  const kv = {
    async get() {
      return null; // baseline not initialized, empty map
    },
    async put() {
      throw new Error('KV write outage');
    },
  };
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const state = { freewayEvents: [makeFreewayRaw('FRW-1')] };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  const summary = await runTdxPipelineAndCommit(env);
  assert.equal(summary.kvAvailable, false);
  assert.match(summary.kvError, /KV write outage/);
  assert.equal(summary.pushableEventsCount, 0);
  assert.equal(summary.baselineInitialized, false);
});

test('TDX single-source failure (429) does not affect the other sources or the pipeline overall', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
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

  const summary = await runTdxPipelineAndCommit(env);
  assert.equal(summary.tokenOk, true);
  assert.equal(summary.failedSources.length, 1);
  assert.equal(summary.failedSources[0].source, 'freeway');
  assert.equal(summary.failedSources[0].status, 429);
  // The other 4 sources still ran fine (0 events each here, but ok).
  const freewaySource = summary.sources.find((s) => s.source === 'freeway');
  const highwaySource = summary.sources.find((s) => s.source === 'highway');
  assert.equal(freewaySource.ok, false);
  assert.equal(highwaySource.ok, true);
});

test('after baseline is established, a fresh pipeline call ("restart") does not re-flood old events as new', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const state = { freewayEvents: [makeFreewayRaw('FRW-1'), makeFreewayRaw('FRW-2')] };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  await runScheduledTdxSync(env); // establishes baseline

  // Simulate a Worker cold start / redeploy: dedupe.js has no in-memory
  // cache, so calling the pipeline fresh (same KV, new function calls,
  // no shared JS state) already models this — assert it behaves correctly.
  const afterRestart = await runTdxPipelinePreview(env);
  assert.equal(afterRestart.baselineInitialized, true);
  assert.equal(afterRestart.newEventsCount, 0);
  assert.equal(afterRestart.pushableEventsCount, 0);
  assert.equal(afterRestart.duplicateCount, 2);
});
