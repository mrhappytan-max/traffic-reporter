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
  compactTdxUsageSummaryRecentDays,
  readTdxUsageSummary,
  aggregateUsageForMonth,
  taipeiDateString,
  productionWindowsElapsedToday,
  productionWindowsStrictlyBefore,
  theoreticalProductionCallsToday,
  theoreticalProductionCallsForDay,
  isPartialTrackingDay,
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

test('V1.9.2 — /debug/tdx (the real handler) still costs exactly 2 TDX data calls (production-restricted, V1.6.2), but no longer writes a usage-ledger entry (TDX Usage Summary retired)', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });

  const response = await handleDebugTdx({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore });
  const body = await response.json();

  // The real TDX fetch behavior (2 sources, freeway+highway) is completely
  // unaffected by the usage-ledger retirement — only the KV write is gone.
  assert.equal(body.sources.length, 2);

  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 0);
});

// ===========================================================================
// 6. admin CCTV probe — V1.9.2: usage-ledger write retired
// ===========================================================================

test('V1.9.2 — the Hsinchu admin CCTV probe still makes exactly 1 real TDX data call under context=admin-cctv, but no longer writes a usage-ledger entry (TDX Usage Summary retired)', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({});

  await handleHsinchuCctvProbe({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore });

  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 0);
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
  // V1.9.2 — the quota-first dashboard ("TDX 今日"/"TDX 本月"/"剩餘額度"/
  // "月底預估") is RETIRED (a real person now checks TDX's own official
  // back-office dashboard directly — see health.js's own
  // renderTdxUsageRetiredCard comment). USAGE_SUMMARY_KEY is still seeded
  // above purely to prove /health tolerates a leftover pre-V1.9.2 summary
  // key without reading or erroring on it; the page now shows the small
  // static retirement note instead.
  assert.match(html, /TDX 用量/);
  assert.match(html, /TDX 官方後台/);
  assert.doesNotMatch(html, /TDX 今日/);
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

// ===========================================================================
// CORRECTION ROUND (post-review) — 3 reconciliation-correctness blockers:
//   1. trackingStartedAt: no false negative diff on a mid-day first tracking
//      day; never reset by later compactions; a subsequent full day is a
//      normal 84.
//   2. byContextSource: Production and Debug/Admin source counts must never
//      mix into a shared "Production" number.
//   3. Cross-midnight invocations attribute each record by its OWN
//      timestamp's Asia/Taipei date, not the invocation's `now`.
// ===========================================================================

test('1. first tracking day started mid-day (20:32) does not produce a false negative diff at 20:40', async () => {
  const kvStore = kv();
  const trackingStart = new Date('2026-08-18T20:32:00+08:00');
  // First-ever compaction, 0 TDX calls this particular tick (e.g. a
  // skipped-by-schedule tick right after deploy) — trackingStartedAt
  // still gets set here; it marks when the LEDGER started existing, not
  // necessarily when the first real data call happened.
  await compactTdxUsageSummaryForToday(kvStore, trackingStart);
  let read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.trackingStartedAt, trackingStart.toISOString());

  // The next real scheduled tick, 20:40 — freeway+highway fetched.
  const tickTime = new Date('2026-08-18T20:40:00+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now: tickTime,
    records: [
      { kind: 'data', source: 'freeway', timestamp: tickTime.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 100 },
      { kind: 'data', source: 'highway', timestamp: tickTime.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 50 },
    ],
  });
  await compactTdxUsageSummaryForToday(kvStore, tickTime);
  read = await readTdxUsageSummary(kvStore);

  const today = read.summary.days[taipeiDateString(tickTime)];
  assert.equal(today.totalDataCalls, 2);

  const theoretical = theoreticalProductionCallsToday(tickTime, read.summary.trackingStartedAt);
  assert.equal(theoretical, 2); // NOT 78 — the false-negative the old 08:00-onward baseline would have shown
  assert.equal(today.totalDataCalls - theoretical, 0);
});

test('2. trackingStartedAt is set exactly once and never reset by any later compaction, even across days', async () => {
  const kvStore = kv();
  const first = new Date('2026-08-18T20:32:00+08:00');
  await compactTdxUsageSummaryForToday(kvStore, first);
  let read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.trackingStartedAt, first.toISOString());

  await compactTdxUsageSummaryForToday(kvStore, new Date('2026-08-18T21:00:00+08:00'));
  await compactTdxUsageSummaryForToday(kvStore, new Date('2026-08-19T09:00:00+08:00'));
  await compactTdxUsageSummaryForToday(kvStore, new Date('2026-08-20T09:00:00+08:00'));

  read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.trackingStartedAt, first.toISOString());
});

test('3. the second (full) tracking day has the normal complete theoretical baseline of 84, not a partial one', async () => {
  const kvStore = kv();
  await compactTdxUsageSummaryForToday(kvStore, new Date('2026-08-18T20:32:00+08:00')); // first, partial day
  const { summary } = await readTdxUsageSummary(kvStore);

  const secondDayNow = new Date('2026-08-19T22:00:00+08:00'); // full day elapsed
  assert.equal(theoreticalProductionCallsToday(secondDayNow, summary.trackingStartedAt), PRODUCTION_TDX_CALLS_PER_DAY);
  assert.equal(theoreticalProductionCallsForDay('2026-08-19', summary.trackingStartedAt), PRODUCTION_TDX_CALLS_PER_DAY);
  assert.equal(isPartialTrackingDay('2026-08-19', summary.trackingStartedAt), false);
  assert.equal(isPartialTrackingDay('2026-08-18', summary.trackingStartedAt), true); // the actual tracking-start day IS partial
});

test('4/5. byContextSource keeps Production and Debug/Admin source counts fully separate — Production reads ONLY byContextSource, never the marginal bySource total', () => {
  const date = '2026-08-18';
  const productionBatch = {
    context: 'production-cron',
    date,
    records: [
      ...Array.from({ length: 37 }, () => ({ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 })),
      ...Array.from({ length: 37 }, () => ({ kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 })),
    ],
  };
  const debugBatch = {
    context: 'debug-status',
    date,
    records: [
      { kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
      { kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
    ],
  };
  const row = buildDayRowFromEntries(date, [productionBatch, debugBatch]);

  assert.equal(row.totalDataCalls, 76);
  assert.equal(row.productionDataCalls, 74);
  assert.equal(row.manualDataCalls, 2);

  // The health page's "Production" block must read ONLY this:
  assert.equal(row.byContextSource['production-cron'].freeway, 37);
  assert.equal(row.byContextSource['production-cron'].highway, 37);
  // The marginal bySource total is 38/38 (Production + Debug mixed) —
  // proving exactly the bug this correction fixes, and that it must
  // never be what the "Production" UI block reads from.
  assert.equal(row.bySource.freeway, 38);
  assert.equal(row.bySource.highway, 38);
  // Debug's own slice stays fully isolated too.
  assert.equal(row.byContextSource['debug-status'].freeway, 1);
  assert.equal(row.byContextSource['debug-status'].highway, 1);
});

test('6. records straddling Asia/Taipei midnight are attributed to their OWN date, split into up to 2 append-only entries', async () => {
  const kvStore = kv();
  const invocationNow = new Date('2026-08-18T23:59:59+08:00'); // the invocation itself started just before midnight
  const beforeMidnight = new Date('2026-08-18T23:59:59+08:00');
  const afterMidnight = new Date('2026-08-19T00:00:05+08:00'); // resolved just after midnight

  const commit = await commitTdxUsageBatch(kvStore, {
    context: 'admin-cctv',
    now: invocationNow,
    records: [
      { kind: 'data', source: 'cctv-hsinchu-probe', timestamp: beforeMidnight.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
      { kind: 'oauth', timestamp: afterMidnight.toISOString(), success: true, httpStatus: 200 },
    ],
  });

  assert.equal(commit.committed, true);
  assert.equal(commit.keys.length, 2);

  const bodies = commit.keys.map((k) => JSON.parse(kvStore.store.get(k)));
  const day18 = bodies.find((b) => b.date === '2026-08-18');
  const day19 = bodies.find((b) => b.date === '2026-08-19');
  assert.ok(day18 && day19);
  assert.equal(day18.records.length, 1);
  assert.equal(day18.records[0].kind, 'data');
  assert.equal(day19.records.length, 1);
  assert.equal(day19.records[0].kind, 'oauth');

  // And compaction correctly attributes each to its own day.
  const row18 = buildDayRowFromEntries('2026-08-18', [day18]);
  const row19 = buildDayRowFromEntries('2026-08-19', [day19]);
  assert.equal(row18.totalDataCalls, 1);
  assert.equal(row18.oauthRequests, 0);
  assert.equal(row19.totalDataCalls, 0);
  assert.equal(row19.oauthRequests, 1);
});

test('7. a normal (non-midnight-straddling) invocation still writes exactly ONE batch entry', async () => {
  const kvStore = kv();
  const now = new Date('2026-08-18T09:00:00+08:00');
  const commit = await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now,
    records: [
      { kind: 'data', source: 'freeway', timestamp: now.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
      { kind: 'data', source: 'highway', timestamp: now.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
    ],
  });
  assert.equal(commit.keys.length, 1);
  assert.equal(kvStore.store.size, 1);
});

test('V1.9.2 — a real Cron tick (freeway+highway, same-day timestamps) no longer produces ANY usage-ledger KV key (TDX Usage Summary retired) or summary key', async () => {
  const kvStore = kv();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockTdxFetch({ freewayEvents: [] });
  const now = new Date('2026-08-18T08:00:00+08:00');
  await runScheduledTdxSync({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kvStore, PBS_RELAY_WINDOWS: undefined }, now);
  const usageKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageKeys.length, 0);
  assert.equal(kvStore.store.has(USAGE_SUMMARY_KEY), false);
});

// ===========================================================================
// CORRECTION ROUND 2 (post-review) — 2 daily-reconciliation boundary bugs:
//   1. the first Production window itself must never be swallowed by
//      trackingStartedAt when the ledger's very first compaction happens on
//      that same tick.
//   2. a cross-midnight invocation's "yesterday" entry must be picked up by
//      the NEXT Cron compaction even if it's written after midnight.
// ===========================================================================

test('1. first tracking tick IS the first real Production tick (20:40) -> that window is tracked, not swallowed', async () => {
  const kvStore = kv();
  const tickTime = new Date('2026-08-18T20:40:03+08:00'); // dispatch+fetch+normalize+compact takes a few real seconds
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now: tickTime,
    records: [
      { kind: 'data', source: 'freeway', timestamp: tickTime.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 100 },
      { kind: 'data', source: 'highway', timestamp: tickTime.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 50 },
    ],
  });
  // The FIRST-EVER compaction happens on this SAME tick, after the batch above.
  await compactTdxUsageSummaryRecentDays(kvStore, tickTime);

  const { summary } = await readTdxUsageSummary(kvStore);
  assert.equal(summary.trackingStartedAt, '2026-08-18T12:40:00.000Z'); // 20:40:00+08:00 — snapped DOWN from 20:40:03

  const today = summary.days[taipeiDateString(tickTime)];
  assert.equal(today.totalDataCalls, 2);

  const theoretical = theoreticalProductionCallsToday(tickTime, summary.trackingStartedAt);
  assert.equal(theoretical, 2); // NOT 0 — the 20:40 window itself must count as tracked
  assert.equal(today.totalDataCalls - theoretical, 0);
});

test('2. tracking begins on a skipped/PBS-only tick (20:30, 0 TDX calls) -> falls back to raw now; the NEXT real tick (20:40) still shows the correct theoretical', async () => {
  const kvStore = kv();
  const skippedTick = new Date('2026-08-18T20:30:00+08:00');
  await compactTdxUsageSummaryRecentDays(kvStore, skippedTick); // 0 records today -> trackingStartedAt falls back to raw `now`
  let read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.trackingStartedAt, skippedTick.toISOString());

  const tickTime = new Date('2026-08-18T20:40:00+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now: tickTime,
    records: [
      { kind: 'data', source: 'freeway', timestamp: tickTime.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 100 },
      { kind: 'data', source: 'highway', timestamp: tickTime.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 50 },
    ],
  });
  await compactTdxUsageSummaryRecentDays(kvStore, tickTime);
  read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.trackingStartedAt, skippedTick.toISOString()); // unchanged, still 20:30

  const today = read.summary.days[taipeiDateString(tickTime)];
  const theoretical = theoreticalProductionCallsToday(tickTime, read.summary.trackingStartedAt);
  assert.equal(today.totalDataCalls, 2);
  assert.equal(theoretical, 2);
});

test('3. productionWindowsStrictlyBefore boundary values (08:00:00/08:00:01/20:40:00/20:40:01)', () => {
  assert.equal(productionWindowsStrictlyBefore(new Date('2026-08-18T08:00:00+08:00')), 0);
  assert.equal(productionWindowsStrictlyBefore(new Date('2026-08-18T08:00:01+08:00')), 1);
  assert.equal(productionWindowsStrictlyBefore(new Date('2026-08-18T20:40:00+08:00')), 38);
  assert.equal(productionWindowsStrictlyBefore(new Date('2026-08-18T20:40:01+08:00')), 39);
});

test('4/5. cross-midnight raw records split into yesterday+today entries, and the NEXT Cron compaction folds BOTH into their correct summary rows', async () => {
  const kvStore = kv();
  const invocationNow = new Date('2026-08-18T23:59:59+08:00');
  const beforeMidnight = new Date('2026-08-18T23:59:59+08:00');
  const afterMidnight = new Date('2026-08-19T00:00:01+08:00');

  await commitTdxUsageBatch(kvStore, {
    context: 'debug-status',
    now: invocationNow,
    records: [
      { kind: 'data', source: 'freeway', timestamp: beforeMidnight.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
      { kind: 'data', source: 'highway', timestamp: afterMidnight.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 20 },
    ],
  });

  const rawKeys = [...kvStore.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(rawKeys.filter((k) => k.includes(':2026-08-18:')).length, 1);
  assert.equal(rawKeys.filter((k) => k.includes(':2026-08-19:')).length, 1);

  // The Cron tick right after midnight (e.g. 00:10) compacts BOTH days.
  const nextCronTick = new Date('2026-08-19T00:10:00+08:00');
  await compactTdxUsageSummaryRecentDays(kvStore, nextCronTick);

  const { summary } = await readTdxUsageSummary(kvStore);
  assert.equal(summary.days['2026-08-18'].totalDataCalls, 1); // the 23:59 freeway call
  assert.equal(summary.days['2026-08-18'].bySource.freeway, 1);
  assert.equal(summary.days['2026-08-19'].totalDataCalls, 1); // the 00:00 highway call
  assert.equal(summary.days['2026-08-19'].bySource.highway, 1);
});

test('a cross-midnight entry written AFTER yesterday was already compacted still gets picked up by the next compaction (the exact bug this fix targets)', async () => {
  const kvStore = kv();
  // Yesterday's summary row was already frozen by the last tick before midnight.
  const beforeMidnightCronTick = new Date('2026-08-18T23:50:00+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now: beforeMidnightCronTick,
    records: [{ kind: 'data', source: 'freeway', timestamp: beforeMidnightCronTick.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }],
  });
  await compactTdxUsageSummaryRecentDays(kvStore, beforeMidnightCronTick);
  let read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.days['2026-08-18'].totalDataCalls, 1);

  // A slow Debug/Admin invocation starts 23:59, its "yesterday" entry only
  // finishes writing after midnight has already passed.
  const lateWrite = new Date('2026-08-19T00:00:30+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'debug-status',
    now: lateWrite,
    records: [{ kind: 'data', source: 'highway', timestamp: '2026-08-18T23:59:50+08:00', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }],
  });

  // Without re-compacting yesterday, this late entry would be lost forever.
  const nextCronTick = new Date('2026-08-19T00:10:00+08:00');
  await compactTdxUsageSummaryRecentDays(kvStore, nextCronTick);
  read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.days['2026-08-18'].totalDataCalls, 2); // 1 (before) + 1 (late-arriving)
});

test('6. trackingStartedAt remains immutable across repeated compactTdxUsageSummaryRecentDays calls, including across midnight', async () => {
  const kvStore = kv();
  const first = new Date('2026-08-18T20:40:00+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now: first,
    records: [{ kind: 'data', source: 'freeway', timestamp: first.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }],
  });
  await compactTdxUsageSummaryRecentDays(kvStore, first);
  const { summary: s1 } = await readTdxUsageSummary(kvStore);
  const original = s1.trackingStartedAt;
  assert.ok(original);

  await compactTdxUsageSummaryRecentDays(kvStore, new Date('2026-08-19T09:00:00+08:00'));
  await compactTdxUsageSummaryRecentDays(kvStore, new Date('2026-08-20T09:00:00+08:00'));

  const { summary: sLater } = await readTdxUsageSummary(kvStore);
  assert.equal(sLater.trackingStartedAt, original);
});

// ===========================================================================
// CORRECTION ROUND 3 (post-review) — compactTdxUsageSummaryRecentDays must
// NEVER manufacture a fake "0 calls" row for a day that never had any raw
// ledger entry at all (e.g. the day before this Worker's very first day
// live) — that contradicts /health's "尚無資料 before tracking started"
// rule with a fabricated -84 diff.
// ===========================================================================

test('1. first-ever compaction (V1.8.6 goes live today, 2026-08-18) with yesterday having 0 raw entries -> no fake yesterday row is created', async () => {
  const kvStore = kv();
  const now = new Date('2026-08-18T09:00:00+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now,
    records: [
      { kind: 'data', source: 'freeway', timestamp: now.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
      { kind: 'data', source: 'highway', timestamp: now.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
    ],
  });

  await compactTdxUsageSummaryRecentDays(kvStore, now); // yesterday (2026-08-17) has ZERO raw entries — the ledger didn't exist yet

  const { summary } = await readTdxUsageSummary(kvStore);
  assert.equal(summary.days['2026-08-17'], undefined); // no fabricated row — /health must render 尚無資料 for it
  assert.ok(summary.days['2026-08-18']);
  assert.equal(summary.days['2026-08-18'].totalDataCalls, 2);
});

test('2. cross-midnight: yesterday still gets rebuilt/updated when it genuinely has a late-arriving raw entry', async () => {
  const kvStore = kv();
  const beforeMidnightCronTick = new Date('2026-08-18T23:50:00+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'production-cron',
    now: beforeMidnightCronTick,
    records: [{ kind: 'data', source: 'freeway', timestamp: beforeMidnightCronTick.toISOString(), attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }],
  });
  await compactTdxUsageSummaryRecentDays(kvStore, beforeMidnightCronTick);
  let read = await readTdxUsageSummary(kvStore);
  assert.equal(read.summary.days['2026-08-18'].totalDataCalls, 1);

  // A slow Debug/Admin call straddling midnight, its "yesterday" record
  // only finishes writing after midnight.
  const lateWrite = new Date('2026-08-19T00:00:30+08:00');
  await commitTdxUsageBatch(kvStore, {
    context: 'debug-status',
    now: lateWrite,
    records: [{ kind: 'data', source: 'highway', timestamp: '2026-08-18T23:59:50+08:00', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }],
  });

  const nextCronTick = new Date('2026-08-19T00:10:00+08:00');
  await compactTdxUsageSummaryRecentDays(kvStore, nextCronTick);
  read = await readTdxUsageSummary(kvStore);

  // Yesterday (2026-08-18) genuinely has raw entries -> rebuilt, and the
  // late-arriving call IS folded in.
  assert.equal(read.summary.days['2026-08-18'].totalDataCalls, 2);
  assert.ok(read.summary.days['2026-08-19']); // today still written unconditionally, even with 0 calls of its own
});
