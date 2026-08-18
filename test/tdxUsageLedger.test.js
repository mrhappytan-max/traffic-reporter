// V1.8.6 — TDX usage reconciliation ledger. Covers the module directly
// (src/tdx/usageLedger.js: recording, batching, compaction, theoretical
// baseline, monthly rollup) plus the wiring into fetchTdxJson/auth.js/
// fetchAllSources/scheduled.js/debugStatus.js/the two admin CCTV probes,
// and /health's own "0 TDX calls" guarantee.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { getAccessToken } from '../src/tdx/auth.js';
import { fetchTdxJson } from '../src/tdx/client.js';
import { fetchAllSources } from '../src/tdx/fetchAll.js';
import { handleDebugTdx } from '../src/tdx/debug.js';
import { handleHsinchuCctvProbe } from '../src/tdx/hsinchuCctvProbe.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { handleHealth } from '../src/traffic/health.js';
import {
  recordTdxDataCall,
  recordTdxOAuthCall,
  commitTdxUsageBatch,
  buildDayRowFromEntries,
  compactTdxUsageSummaryForToday,
  readTdxUsageSummary,
  aggregateUsageForMonth,
  taipeiDateString,
  productionWindowsElapsedToday,
  theoreticalProductionCallsToday,
  PRODUCTION_TDX_CALLS_PER_DAY,
  USAGE_ENTRY_KEY_PREFIX,
  USAGE_SUMMARY_KEY,
} from '../src/tdx/usageLedger.js';

let originalFetch;
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  resetTdxTokenCache();
});

function kv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      // Simulate real Workers KV pagination in 2-key pages so multi-page
      // compaction is actually exercised, not just a happy single page.
      const pageSize = 2;
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      const list_complete = nextStart >= keys.length;
      return { keys: page.map((name) => ({ name })), list_complete, cursor: list_complete ? undefined : String(nextStart) };
    },
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

function mockTdxFetch(state = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      if (state.oauthStatus && state.oauthStatus !== 200) return new Response('nope', { status: state.oauthStatus });
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      if (state.freewayStatus && state.freewayStatus !== 200) return new Response('error', { status: state.freewayStatus });
      return new Response(JSON.stringify({ RoadEvents: state.freewayEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: state.highwayEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS/City/Hsinchu')) {
      return new Response(JSON.stringify({ CMSs: state.cmsEvents ?? [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/CCTV/Freeway')) {
      return new Response(JSON.stringify({ CCTVs: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

// ===========================================================================
// 1/2/15. fetchAllSources: correct per-source recording, no lost update under
// Promise.all concurrency, correct production/manual breakdown.
// ===========================================================================

test('1. production freeway+highway -> usage data calls = 2, one batch', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [makeFreewayRaw('A')] });

  const usageSink = [];
  await fetchAllSources({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' }, { sourceIds: ['freeway', 'highway'], usageSink });

  const dataRecords = usageSink.filter((r) => r.kind === 'data');
  assert.equal(dataRecords.length, 2);
  assert.deepEqual(dataRecords.map((r) => r.source).sort(), ['freeway', 'highway']);
  assert.ok(dataRecords.every((r) => r.attempted === true && r.success === true));
});

test('2. all 5 sources fetched concurrently (Promise.all) -> exactly 5 data records, never lost/duplicated', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [makeFreewayRaw('A')] });

  const usageSink = [];
  // No sourceIds filter -> all 5 defined sources, fired concurrently
  // inside fetchAllSources' own Promise.all.
  await fetchAllSources({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' }, { usageSink });

  const dataRecords = usageSink.filter((r) => r.kind === 'data');
  assert.equal(dataRecords.length, 5);
  assert.deepEqual(
    dataRecords.map((r) => r.source).sort(),
    ['bus-hsinchu', 'bus-hsinchu-county', 'cms', 'freeway', 'highway'].sort()
  );
});

test('15. production + debug breakdown: byContext/bySource/totalDataCalls agree', async () => {
  const now = new Date('2026-08-18T09:00:00+08:00');
  const productionBatch = {
    context: 'production-cron',
    date: taipeiDateString(now),
    records: [
      { kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 1000 },
      { kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 500 },
    ],
  };
  const debugBatch = {
    context: 'debug-status',
    date: taipeiDateString(now),
    records: [
      { kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 900 },
      { kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 400 },
    ],
  };
  const row = buildDayRowFromEntries(taipeiDateString(now), [productionBatch, debugBatch]);
  assert.equal(row.totalDataCalls, 4);
  assert.equal(row.productionDataCalls, 2);
  assert.equal(row.manualDataCalls, 2);
  assert.equal(row.byContext['production-cron'], 2);
  assert.equal(row.byContext['debug-status'], 2);
  assert.equal(row.bySource.freeway, 2);
  assert.equal(row.bySource.highway, 2);
  assert.equal(row.payloadBytesEstimate, 1000 + 500 + 900 + 400);
});

// ===========================================================================
// 3/4. Cron gating: skipped-by-schedule / night-sleep ticks record 0 calls.
// ===========================================================================

test('3. a skipped-by-schedule tick (daytime, not a 20-min mark) records +0 TDX usage entries', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });
  // 09:07 Asia/Taipei — within broadcast hours, but not minute 00/20/40.
  const now = new Date('2026-08-18T09:07:00+08:00');
  await runScheduledTdxSync(
    { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore, PBS_RELAY_WINDOWS: undefined },
    now
  );
  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 0);
});

test('4. a night-sleep tick (outside 08:00-22:00) records +0 TDX usage entries', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });
  const now = new Date('2026-08-18T02:00:00+08:00'); // 02:00 Taipei — night-sleep
  await runScheduledTdxSync(
    { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore, PBS_RELAY_WINDOWS: undefined },
    now
  );
  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 0);
});

// ===========================================================================
// 5. debug-scope fetch (up to all 5 sources) -> context tagging works for a
// non-Production context, however many sources are actually fetched.
// ===========================================================================

test('5. a full 5-source fetch tagged context=debug-tdx -> the batch entry carries +5 data records under that context', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });

  const usageSink = [];
  await fetchAllSources({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' }, { usageSink }); // no sourceIds -> all 5
  const commit = await commitTdxUsageBatch(kvStore, { context: 'debug-tdx', records: usageSink });
  assert.equal(commit.committed, true);

  const raw = kvStore.store.get(commit.key);
  const body = JSON.parse(raw);
  assert.equal(body.context, 'debug-tdx');
  assert.equal(body.records.filter((r) => r.kind === 'data').length, 5);
});

test('/debug/tdx (the real handler) is tagged context=debug-tdx and costs exactly 2 TDX data calls (production-restricted, V1.6.2)', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });

  await handleDebugTdx({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore });

  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 1);
  const body = JSON.parse(kvStore.store.get(usageKeys[0]));
  assert.equal(body.context, 'debug-tdx');
  assert.equal(body.records.filter((r) => r.kind === 'data').length, 2);
});

// ===========================================================================
// 6. admin CCTV probe -> context=admin-cctv, +1
// ===========================================================================

test('6. the Hsinchu admin CCTV probe records exactly 1 data call under context=admin-cctv', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({});

  await handleHsinchuCctvProbe({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore });

  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 1);
  const body = JSON.parse(kvStore.store.get(usageKeys[0]));
  assert.equal(body.context, 'admin-cctv');
  const dataRecords = body.records.filter((r) => r.kind === 'data');
  assert.equal(dataRecords.length, 1);
  assert.equal(dataRecords[0].source, 'cctv-hsinchu-probe');
});

// ===========================================================================
// 7/8. OAuth: memory-cache reuse records 0 network calls; a real refresh
// records exactly 1 oauthRequest and never touches the data-call total.
// ===========================================================================

test('7. OAuth served from the isolate memory cache on a second call -> +0 OAuth network calls', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({});

  const usageSink = [];
  await getAccessToken({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' }, usageSink); // real refresh
  await getAccessToken({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' }, usageSink); // memory hit

  const oauthRecords = usageSink.filter((r) => r.kind === 'oauth');
  assert.equal(oauthRecords.length, 1); // only the first call actually hit the network
});

test('8. a real OAuth refresh records oauthRequests +1 and never inflates the data-call total', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });

  const usageSink = [];
  await fetchAllSources({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' }, { sourceIds: ['freeway'], usageSink });

  const row = buildDayRowFromEntries('2026-08-18', [{ context: 'production-cron', records: usageSink }]);
  assert.equal(row.oauthRequests, 1);
  assert.equal(row.totalDataCalls, 1); // only the freeway data call — the OAuth request is NOT counted here
});

// ===========================================================================
// 9/10. Failed HTTP requests and payload byte estimation.
// ===========================================================================

test('9. a failed HTTP TDX request records attempted=true, success=false, with the real HTTP status', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayStatus: 500 });

  const usageSink = [];
  await assert.rejects(() => fetchTdxJson('https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/Freeway', 'tok', { source: 'freeway', usageSink }));

  assert.equal(usageSink.length, 1);
  assert.equal(usageSink[0].attempted, true);
  assert.equal(usageSink[0].success, false);
  assert.equal(usageSink[0].httpStatus, 500);
});

test('10. payload bytes are estimated correctly from the real response body size (UTF-8 byte length, not char length)', async () => {
  const body = JSON.stringify({ RoadEvents: [makeFreewayRaw('中文事件')] }); // includes multi-byte UTF-8 chars
  const expectedBytes = new TextEncoder().encode(body).length;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });

  const usageSink = [];
  await fetchTdxJson('https://example.test/x', 'tok', { source: 'freeway', usageSink });

  assert.equal(usageSink[0].payloadBytesEstimate, expectedBytes);
  assert.ok(expectedBytes > body.length); // proves this measured BYTES, not JS string .length, for the multi-byte chars
});

// ===========================================================================
// 11. /health never calls TDX/PBS/LINE, even with the new usage card.
// ===========================================================================

test('11. GET /health makes 0 TDX/PBS/LINE calls even with a populated usage summary', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`/health must never call fetch() — tried: ${url}`);
  };

  // handleHealth(env) always uses the real wall clock internally (no
  // injectable `now` — see this file's own top comment), so the
  // persisted snapshot's generatedAt must be genuinely fresh (real
  // Date.now()) or the staleness check would force a 503 unrelated to
  // what this test is actually checking.
  const now = new Date();
  const summary = {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    days: { [taipeiDateString(now)]: buildDayRowFromEntries(taipeiDateString(now), []) },
  };
  const kvStore = kv({
    'health:snapshot:v1': JSON.stringify({
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      status: 'normal',
      tdx: { tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [], lastFetchedAt: now.toISOString(), scheduledThisRun: true, sleeping: false },
      pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
      line: { ready: true, enabledUsersCount: 0, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
      kv: { available: true },
      broadcast: { broadcastRelevantCount: 0, pendingTargetCount: 0, typeIneligibleCount: 0, ineligibleByReason: {}, incidentSuppressedCount: 0 },
    }),
    [USAGE_SUMMARY_KEY]: JSON.stringify(summary),
  });

  const response = await handleHealth({ TRAFFIC_KV: kvStore });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /TDX 用量對帳/);
});

// ===========================================================================
// 12. Daily rollover — Asia/Taipei date, not UTC date.
// ===========================================================================

test('12. taipeiDateString rolls over at Asia/Taipei midnight, not UTC midnight', () => {
  // 2026-08-17T16:30:00Z = 2026-08-18T00:30:00+08:00 — already the NEXT
  // Taipei calendar day, even though the UTC date is still the 17th.
  assert.equal(taipeiDateString(new Date('2026-08-17T16:30:00Z')), '2026-08-18');
  // One minute earlier in UTC is still 2026-08-17T23:59 Taipei time.
  assert.equal(taipeiDateString(new Date('2026-08-17T15:59:00Z')), '2026-08-17');
});

// ===========================================================================
// 13. Monthly total = correct sum of daily rows already in the summary.
// ===========================================================================

test('13. aggregateUsageForMonth sums only the days in the same Asia/Taipei month as `now`', () => {
  const summary = {
    days: {
      '2026-08-16': { totalDataCalls: 10, productionDataCalls: 8, manualDataCalls: 2, oauthRequests: 1, payloadBytesEstimate: 1000 },
      '2026-08-17': { totalDataCalls: 20, productionDataCalls: 18, manualDataCalls: 2, oauthRequests: 0, payloadBytesEstimate: 2000 },
      '2026-07-31': { totalDataCalls: 999, productionDataCalls: 999, manualDataCalls: 0, oauthRequests: 5, payloadBytesEstimate: 999999 }, // different month, must be excluded
    },
  };
  const totals = aggregateUsageForMonth(summary, new Date('2026-08-18T09:00:00+08:00'));
  assert.equal(totals.totalDataCalls, 30);
  assert.equal(totals.productionDataCalls, 26);
  assert.equal(totals.manualDataCalls, 4);
  assert.equal(totals.oauthRequests, 1);
  assert.equal(totals.payloadBytesEstimate, 3000);
});

// ===========================================================================
// 14. Theoretical current-day expected calls — 08:00-22:00, every 20 min.
// ===========================================================================

test('14. theoreticalProductionCallsToday matches the real 08:00-22:00/20-min schedule at several points in the day', () => {
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T07:59:00+08:00')), 0); // before 08:00
  assert.equal(productionWindowsElapsedToday(new Date('2026-08-18T08:00:00+08:00')), 1); // the 08:00 window just fired
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T08:00:00+08:00')), 2); // 1 window x 2 sources
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T08:19:00+08:00')), 2); // still just the 08:00 window
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T08:20:00+08:00')), 4); // 08:00 + 08:20
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T09:00:00+08:00')), 8); // 08:00/08:20/08:40/09:00 (4 windows)
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T21:40:00+08:00')), PRODUCTION_TDX_CALLS_PER_DAY); // last window of the day
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T21:59:00+08:00')), PRODUCTION_TDX_CALLS_PER_DAY); // no new window between :40 and day end
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T22:00:00+08:00')), PRODUCTION_TDX_CALLS_PER_DAY); // full day done
  assert.equal(theoreticalProductionCallsToday(new Date('2026-08-18T23:59:00+08:00')), PRODUCTION_TDX_CALLS_PER_DAY);
});

// ===========================================================================
// Compaction — Cron-driven, today-only, cheap, idempotent, multi-page-safe.
// ===========================================================================

test('compactTdxUsageSummaryForToday recomputes today\'s row from raw entries (multi-page list, via the 2-key-per-page mock) and preserves other days', async () => {
  const now = new Date('2026-08-18T09:00:00+08:00');
  const today = taipeiDateString(now);
  const kvStore = kv({
    [USAGE_SUMMARY_KEY]: JSON.stringify({ schemaVersion: 1, updatedAt: '2026-08-17T00:00:00Z', days: { '2026-08-17': { totalDataCalls: 84, productionDataCalls: 84, manualDataCalls: 0, oauthRequests: 1, payloadBytesEstimate: 500, bySource: {}, byContext: {} } } }),
  });
  // 3 separate batches for today, forcing the mock's 2-key pagination to
  // actually paginate (3 keys > page size 2).
  for (let i = 0; i < 3; i += 1) {
    await commitTdxUsageBatch(kvStore, {
      context: 'production-cron',
      now,
      records: [
        { kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 100 },
        { kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 50 },
      ],
    });
  }

  const result = await compactTdxUsageSummaryForToday(kvStore, now);
  assert.equal(result.committed, true);

  const { summary } = await readTdxUsageSummary(kvStore);
  assert.equal(summary.days[today].totalDataCalls, 6); // 3 batches x 2 sources
  assert.equal(summary.days[today].payloadBytesEstimate, 3 * 150);
  assert.equal(summary.days['2026-08-17'].totalDataCalls, 84); // untouched, still frozen
});

test('compactTdxUsageSummaryForToday is idempotent — calling it twice in a row never double-counts', async () => {
  const now = new Date('2026-08-18T09:00:00+08:00');
  const kvStore = kv();
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now,
    records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 100 }],
  });
  await compactTdxUsageSummaryForToday(kvStore, now);
  await compactTdxUsageSummaryForToday(kvStore, now);
  const { summary } = await readTdxUsageSummary(kvStore);
  assert.equal(summary.days[taipeiDateString(now)].totalDataCalls, 1); // not 2
});

// ===========================================================================
// 16. Telemetry KV failure must never affect the real TDX/PBS/LINE pipeline.
// ===========================================================================

test('16. a usage-ledger KV write failure never breaks the real Cron run (dedupe still commits, LINE broadcast still runs)', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [makeFreewayRaw('A')] });

  const goodStore = new Map();
  const brokenKv = {
    async get(key) {
      return goodStore.has(key) ? goodStore.get(key) : null;
    },
    async put(key, value) {
      if (key.startsWith(USAGE_ENTRY_KEY_PREFIX) || key === USAGE_SUMMARY_KEY) {
        throw new Error('usage-ledger KV outage (simulated)');
      }
      goodStore.set(key, value);
    },
    async list() {
      throw new Error('usage-ledger KV outage (simulated)');
    },
  };

  const now = new Date('2026-08-18T08:00:00+08:00'); // a real scheduled tick
  const result = await runScheduledTdxSync(
    { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: brokenKv, PBS_RELAY_WINDOWS: undefined },
    now
  );

  // The real pipeline completed normally despite the usage-ledger KV
  // outage: dedupe state committed, baseline established.
  assert.equal(result.kvAvailable, true);
  assert.equal(result.baselineInitialized, true);
  assert.ok(goodStore.has('traffic:dedupe-state') || goodStore.has('traffic:baseline'));
});

// ===========================================================================
// Recording helpers themselves — pure, defensive no-ops on a missing sink.
// ===========================================================================

test('recordTdxDataCall / recordTdxOAuthCall are silent no-ops when usageSink is not an array', () => {
  assert.doesNotThrow(() => recordTdxDataCall(undefined, { source: 'freeway', success: true }));
  assert.doesNotThrow(() => recordTdxOAuthCall(null, { success: true }));
  assert.doesNotThrow(() => recordTdxDataCall({}, { source: 'freeway', success: true })); // not an array either
});

test('commitTdxUsageBatch is a no-op (not committed) for an empty or missing records array', async () => {
  const kvStore = kv();
  assert.equal((await commitTdxUsageBatch(kvStore, { context: 'production-cron', records: [] })).committed, false);
  assert.equal((await commitTdxUsageBatch(kvStore, { context: 'production-cron', records: undefined })).committed, false);
  assert.equal(kvStore.store.size, 0);
});
