import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runTdxPipelinePreview, runTdxPipelineAndCommit } from '../src/traffic/pipeline.js';
import { readDedupeState } from '../src/traffic/dedupe.js';
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

// V1.2C.1: getAccessToken() now legitimately writes a shared token cache to
// TRAFFIC_KV (key 'tdx:oauth-token-v1') so that OTHER isolates — including
// future /debug/status calls in a fresh isolate — don't have to re-hit TDX
// OAuth. That's a deliberate, desired side effect of this feature, distinct
// from "traffic state" (dedupe/notified/baseline/subscriptions). The
// read-only tests below assert /debug/status never writes traffic state,
// while still allowing (and asserting the shape of) that one auth-cache key.
const TDX_TOKEN_CACHE_KEY = 'tdx:oauth-token-v1';

function trafficStateKeyCount(kv) {
  return [...kv.store.keys()].filter((k) => k !== TDX_TOKEN_CACHE_KEY).length;
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

// Within the configured Hsinchu range for 台1線 (see hsinchuConfig.js).
function makeHighwayRaw(id, overrides = {}) {
  return {
    EventID: id,
    EventTitle: `台1線南向90K事件${id}`,
    EventType: '施工',
    Description: '南向90K處施工',
    EffectiveTime: '2026-08-15T08:00:00+08:00',
    LastUpdateTime: '2026-08-15T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '台1線', Direction: '南向', StartKM: '90K+000', EndKM: '90K+500' } },
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
      if (state.freewayStatus && state.freewayStatus !== 200) {
        return new Response('error', { status: state.freewayStatus });
      }
      return new Response(JSON.stringify({ RoadEvents: state.freewayEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      if (state.highwayStatus && state.highwayStatus !== 200) {
        return new Response('error', { status: state.highwayStatus });
      }
      return new Response(JSON.stringify({ RoadEvents: state.highwayEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS/City/Hsinchu')) {
      return new Response(JSON.stringify({ CMSs: state.cmsEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty')) {
      return new Response(JSON.stringify({ Alerts: state.busCountyEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: state.busCityEvents ?? [] }), { status: 200 });
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

test('GET /debug/status is fully read-only: repeated calls never touch KV traffic state', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const state = { freewayEvents: [makeFreewayRaw('FRW-1'), makeFreewayRaw('FRW-2')] };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  assert.equal(kv.store.size, 0);

  const r1 = await handleDebugStatus(env);
  const body1 = await r1.json();
  assert.equal(body1.baselineInitialized, false);
  // The very first call legitimately populates the shared TDX token cache
  // (see V1.2C.1 comment above) — that's the ONLY key it may write.
  assert.equal(trafficStateKeyCount(kv), 0);
  assert.deepEqual([...kv.store.keys()], [TDX_TOKEN_CACHE_KEY]);
  const tokenCacheAfterFirstCall = kv.store.get(TDX_TOKEN_CACHE_KEY);

  const r2 = await handleDebugStatus(env);
  const body2 = await r2.json();
  assert.equal(body2.baselineInitialized, false);
  assert.equal(trafficStateKeyCount(kv), 0); // still no traffic state written
  // Second call reuses the cached token (memory tier) — doesn't re-write KV.
  assert.equal(kv.store.get(TDX_TOKEN_CACHE_KEY), tokenCacheAfterFirstCall);

  // pushableEventsCount must be 0 pre-baseline in the preview too, mirroring
  // exactly what the real Cron run would do.
  assert.equal(body1.pushableEventsCount, 0);
  assert.equal(body2.pushableEventsCount, 0);

  // Now actually establish the baseline via the real Cron path...
  await runScheduledTdxSync(env);
  const sizeAfterBaseline = kv.store.size;
  assert.ok(sizeAfterBaseline > 0);

  // ...and confirm /debug/status still never mutates traffic state, even
  // though it can now see (read-only) that the baseline exists.
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

// ---------------------------------------------------------------------
// Source Health: a source's own fetch failure must never be misread as
// "its events resolved". missingSince must only ever start/advance/prune
// for a source that reported ok===true this run.
// ---------------------------------------------------------------------

test('Source Health: a Highway 5xx failure freezes H-1\'s missingSince entirely, even across 25 consecutive hourly failures, and it survives unpruned', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const t0 = new Date('2026-08-15T00:00:00Z');

  const state = { highwayEvents: [makeHighwayRaw('H-1')] };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  // 1) Highway event exists, baseline established.
  const baselineRun = await runTdxPipelineAndCommit(env, t0);
  assert.equal(baselineRun.baselineSeedCount, 1);
  assert.equal(baselineRun.sourceHealth.highway, true);

  let stored = await readDedupeState(kv);
  assert.equal(stored.dedupeMap['highway:H-1'].missingSince, null);

  // 2) Highway API starts failing (500) — H-1 must not start its absence
  // clock. Simulate this continuously for 25 hourly ticks (past the old
  // 24h mark) to prove it never gets pruned while the SOURCE is unhealthy.
  state.highwayStatus = 500;
  for (let hour = 1; hour <= 25; hour += 1) {
    const now = new Date(t0.getTime() + hour * 60 * 60 * 1000);
    const run = await runTdxPipelineAndCommit(env, now);
    const highwaySource = run.sources.find((s) => s.source === 'highway');
    assert.equal(highwaySource.ok, false, `hour ${hour}: highway must be reported as failed`);
    assert.equal(run.sourceHealth.highway, false, `hour ${hour}: sourceHealth.highway must be false`);

    stored = await readDedupeState(kv);
    assert.ok(stored.dedupeMap['highway:H-1'], `hour ${hour}: H-1 must still be tracked`);
    assert.equal(
      stored.dedupeMap['highway:H-1'].missingSince,
      null,
      `hour ${hour}: missingSince must remain null while the source is unhealthy`
    );
  }

  // 3) Highway recovers, H-1 reappears unchanged -> must be a duplicate,
  // never "new", and must not have been pruned in the meantime.
  state.highwayStatus = 200;
  const recoveredAt = new Date(t0.getTime() + 26 * 60 * 60 * 1000);
  const recoveredRun = await runTdxPipelineAndCommit(env, recoveredAt);
  assert.equal(recoveredRun.sourceHealth.highway, true);
  assert.equal(recoveredRun.newEventsCount, 0);
  assert.equal(recoveredRun.updatedEventsCount, 0);
  assert.equal(recoveredRun.duplicateCount, 1);
});

test('Source Health: a genuinely-successful source with the event truly gone is pruned only after 24h of consecutive (healthy-run) absence', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const t0 = new Date('2026-08-15T00:00:00Z');

  const state = { highwayEvents: [makeHighwayRaw('H-2')] };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  await runTdxPipelineAndCommit(env, t0); // baseline

  // The event genuinely disappears from a HEALTHY Highway response (not a
  // source failure) — this is the one case where the absence clock should
  // actually run.
  state.highwayEvents = [];

  for (let hour = 1; hour <= 23; hour += 1) {
    const now = new Date(t0.getTime() + hour * 60 * 60 * 1000);
    const run = await runTdxPipelineAndCommit(env, now);
    assert.equal(run.sourceHealth.highway, true);
  }
  let stored = await readDedupeState(kv);
  assert.ok(stored.dedupeMap['highway:H-2'], 'still tracked just under 24h of genuine absence');

  const at25h = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
  await runTdxPipelineAndCommit(env, at25h);

  stored = await readDedupeState(kv);
  assert.equal(stored.dedupeMap['highway:H-2'], undefined, 'pruned after 24h of genuine, healthy-source absence');
});

test('Source Health: Freeway failing does not affect Highway/CMS/Bus Alert dedup at all', async () => {
  const kv = createMockKV();
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };
  const t0 = new Date('2026-08-15T00:00:00Z');

  const state = {
    freewayEvents: [makeFreewayRaw('FRW-1')],
    highwayEvents: [makeHighwayRaw('H-3')],
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch(state);

  await runTdxPipelineAndCommit(env, t0); // baseline: FRW-1 + H-3

  // Freeway starts failing; Highway keeps succeeding with the same,
  // unchanged event.
  state.freewayStatus = 429;
  const now = new Date(t0.getTime() + 60 * 60 * 1000);
  const run = await runTdxPipelineAndCommit(env, now);

  assert.equal(run.sourceHealth.freeway, false);
  assert.equal(run.sourceHealth.highway, true);
  assert.equal(run.failedSources.length, 1);
  assert.equal(run.failedSources[0].source, 'freeway');

  // Highway's own event is still classified normally (duplicate, since
  // unchanged) — completely unaffected by Freeway's outage.
  assert.equal(run.duplicateCount, 1);
  assert.equal(run.newEventsCount, 0);

  const stored = await readDedupeState(kv);
  assert.ok(stored.dedupeMap['freeway:FRW-1'], 'FRW-1 untouched, still present');
  assert.equal(stored.dedupeMap['freeway:FRW-1'].missingSince, null);
  assert.ok(stored.dedupeMap['highway:H-3'], 'H-3 unaffected by the unrelated Freeway outage');
});
