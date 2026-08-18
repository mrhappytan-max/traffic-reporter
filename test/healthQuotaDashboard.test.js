// V1.8.6.1 — TDX 健康頁 UI 瘦身＋額度儀表板. Targeted tests for the new
// derived-calculation functions (src/tdx/usageLedger.js: estimatePoints/
// remainingPoints/usagePercent/projectEndOfMonthPoints) and the UI-level
// behaviors built on top of them in src/traffic/health.js (retired-source
// hiding/warning, CCTV never mislabeled as Production, /health's 0-TDX-
// calls guarantee). Does NOT touch the pipeline/scheduler/probe — pure
// derived math + one HTML render per test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealth } from '../src/traffic/health.js';
import {
  estimatePoints,
  remainingPoints,
  usagePercent,
  projectEndOfMonthPoints,
  buildDayRowFromEntries,
  taipeiDateString,
  TDX_MONTHLY_POINT_BUDGET,
  TDX_CALLS_PER_POINT,
  TDX_TRAFFIC_MB_PER_POINT,
  USAGE_SUMMARY_KEY,
} from '../src/tdx/usageLedger.js';

// ===========================================================================
// 1/2/3. estimatePoints — the core TDX 基礎服務 point conversion.
// ===========================================================================

test('1. 1500 calls = 1 call point', () => {
  assert.equal(estimatePoints({ totalDataCalls: TDX_CALLS_PER_POINT, payloadBytesEstimate: 0 }), 1);
  assert.equal(estimatePoints({ totalDataCalls: TDX_CALLS_PER_POINT / 2, payloadBytesEstimate: 0 }), 0.5);
});

test('2. 150 MB = 1 traffic point', () => {
  const bytes = TDX_TRAFFIC_MB_PER_POINT * 1024 * 1024;
  assert.equal(estimatePoints({ totalDataCalls: 0, payloadBytesEstimate: bytes }), 1);
  assert.equal(estimatePoints({ totalDataCalls: 0, payloadBytesEstimate: bytes / 2 }), 0.5);
});

test('3. call points + traffic points add correctly (estimatedPoints = callPoints + trafficPoints)', () => {
  const points = estimatePoints({
    totalDataCalls: TDX_CALLS_PER_POINT, // 1 call point
    payloadBytesEstimate: TDX_TRAFFIC_MB_PER_POINT * 1024 * 1024, // 1 traffic point
  });
  assert.equal(points, 2);
});

// ===========================================================================
// 4/5. Budget / remaining / percent.
// ===========================================================================

test('4. remainingPoints against the 3-point budget is correct, and never negative', () => {
  assert.equal(remainingPoints(1.2, 3), 1.8);
  assert.equal(remainingPoints(0, 3), 3);
  assert.equal(remainingPoints(5, 3), 0); // clamped, never negative
  assert.equal(remainingPoints(1.2), 3 - 1.2); // default budget = TDX_MONTHLY_POINT_BUDGET
  assert.equal(TDX_MONTHLY_POINT_BUDGET, 3); // documented default
});

test('5. usagePercent is a correct plain fraction of the budget', () => {
  assert.equal(usagePercent(1.5, 3), 0.5);
  assert.equal(usagePercent(0, 3), 0);
  assert.equal(usagePercent(3, 3), 1);
  assert.equal(usagePercent(6, 3), 2); // over-budget reads as >100%, not clamped — the UI clamps the progress BAR width, not this raw fraction
});

// ===========================================================================
// 6/7. Month-end projection — partial-day exclusion, minimum 2 complete days.
// ===========================================================================

test('6. the partial tracking day is excluded from the complete-day average', () => {
  const now = new Date('2026-08-20T09:00:00+08:00');
  const summary = {
    trackingStartedAt: '2026-08-18T12:40:00.000Z', // 2026-08-18 20:40+08:00 -> the partial day
    days: {
      '2026-08-18': { totalDataCalls: TDX_CALLS_PER_POINT, payloadBytesEstimate: 0 }, // partial day: 1 point, but must NOT count
      '2026-08-19': { totalDataCalls: TDX_CALLS_PER_POINT, payloadBytesEstimate: 0 }, // complete day #1: 1 point
      '2026-08-20': { totalDataCalls: 0, payloadBytesEstimate: 0 }, // today — must NOT count either
    },
  };
  // Only ONE complete day (08-19) exists — 08-18 is partial, 08-20 is today.
  const result = projectEndOfMonthPoints(summary, now);
  assert.equal(result.ready, false);
  assert.equal(result.completeDayCount, 1); // proves 08-18 was excluded (would be 2 if it counted)
});

test('7. fewer than 2 complete tracked days -> 資料累積中 (ready:false), never a fabricated projection', () => {
  const now = new Date('2026-08-19T09:00:00+08:00');
  const summaryZeroComplete = { trackingStartedAt: null, days: { '2026-08-19': { totalDataCalls: 10, payloadBytesEstimate: 0 } } };
  assert.equal(projectEndOfMonthPoints(summaryZeroComplete, now).ready, false);

  const summaryOneComplete = {
    trackingStartedAt: null,
    days: {
      '2026-08-18': { totalDataCalls: TDX_CALLS_PER_POINT, payloadBytesEstimate: 0 },
      '2026-08-19': { totalDataCalls: 10, payloadBytesEstimate: 0 }, // today
    },
  };
  assert.equal(projectEndOfMonthPoints(summaryOneComplete, now).ready, false);

  const summaryTwoComplete = {
    trackingStartedAt: null,
    days: {
      '2026-08-17': { totalDataCalls: TDX_CALLS_PER_POINT, payloadBytesEstimate: 0 },
      '2026-08-18': { totalDataCalls: TDX_CALLS_PER_POINT, payloadBytesEstimate: 0 },
      '2026-08-19': { totalDataCalls: 10, payloadBytesEstimate: 0 }, // today
    },
  };
  const ready = projectEndOfMonthPoints(summaryTwoComplete, now);
  assert.equal(ready.ready, true);
  assert.equal(ready.completeDayCount, 2);
  assert.equal(ready.avgPointsPerDay, 1); // both complete days were exactly 1 point each
});

test('cross-month: last month\'s complete days (still in the ~35-day summary retention) must NEVER be averaged into THIS month\'s projection', () => {
  const now = new Date('2026-09-03T09:00:00+08:00');
  const summary = {
    trackingStartedAt: null,
    days: {
      '2026-08-30': { totalDataCalls: TDX_CALLS_PER_POINT * 10, payloadBytesEstimate: 0 }, // last month, very high usage — must be excluded
      '2026-08-31': { totalDataCalls: TDX_CALLS_PER_POINT * 10, payloadBytesEstimate: 0 }, // last month, very high usage — must be excluded
      '2026-09-01': { totalDataCalls: 75, payloadBytesEstimate: 0 }, // 75/1500 = 0.05 point — this month, complete
      '2026-09-02': { totalDataCalls: 75, payloadBytesEstimate: 0 }, // 0.05 point — this month, complete
      '2026-09-03': { totalDataCalls: 0, payloadBytesEstimate: 0 }, // today — still in progress
    },
  };

  const result = projectEndOfMonthPoints(summary, now);
  assert.equal(result.ready, true);
  assert.equal(result.completeDayCount, 2); // only 09-01 and 09-02 — NOT 08-30/08-31
  assert.equal(result.avgPointsPerDay, 0.05); // would be wildly higher (~13.35) if August's high-usage days leaked in
});

// ===========================================================================
// 8/9. Retired-source (CMS/Bus) hide-when-zero, warn-when-nonzero.
// ===========================================================================

function baseHealthSnapshot(now) {
  return {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    status: 'normal',
    tdx: { tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [], lastFetchedAt: now.toISOString(), scheduledThisRun: true, sleeping: false },
    pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
    line: { ready: true, enabledUsersCount: 0, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
    kv: { available: true },
    broadcast: { broadcastRelevantCount: 0, pendingTargetCount: 0, typeIneligibleCount: 0, ineligibleByReason: {}, incidentSuppressedCount: 0 },
  };
}

function kvWithSummary(now, summary) {
  const store = new Map();
  store.set('health:snapshot:v1', JSON.stringify(baseHealthSnapshot(now)));
  store.set(USAGE_SUMMARY_KEY, JSON.stringify(summary));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

test('8. CMS/Bus retired sources all 0 today -> the anomaly card is not rendered at all', async () => {
  const now = new Date();
  const today = taipeiDateString(now);
  const row = buildDayRowFromEntries(today, [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };

  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  assert.doesNotMatch(html, /發現已停用 TDX 來源/);
  assert.doesNotMatch(html, /公車市/);
  assert.doesNotMatch(html, /公車縣/);
});

test('9. CMS/Bus retired sources > 0 today -> the anomaly card renders with the exact counts', async () => {
  const now = new Date();
  const today = taipeiDateString(now);
  const row = buildDayRowFromEntries(today, [
    {
      context: 'debug-tdx',
      records: [
        { kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
        { kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
        { kind: 'data', source: 'cms', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
        { kind: 'data', source: 'bus-hsinchu', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
        { kind: 'data', source: 'bus-hsinchu-county', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 },
      ],
    },
  ]);
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };

  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  assert.match(html, /發現已停用 TDX 來源/);
  assert.match(html, /公車市/);
  assert.match(html, /公車縣/);
  assert.match(html, /CMS/);
});

// ===========================================================================
// 10/11. CCTV counts toward totals/points but is never labeled Production.
// ===========================================================================

test('10. a CCTV metadata call (context=admin-cctv, source=cctv-hsinchu-probe) counts toward today/month totals and estimated points', () => {
  const date = '2026-08-18';
  const row = buildDayRowFromEntries(date, [
    { context: 'admin-cctv', records: [{ kind: 'data', source: 'cctv-hsinchu-probe', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 1024 }] },
  ]);
  assert.equal(row.totalDataCalls, 1);
  assert.equal(row.bySource.cctv, 1);
  assert.ok(estimatePoints(row) > 0);
});

test('11. CCTV is never counted as Production — byContextSource[production-cron] has no cctv contribution', () => {
  const date = '2026-08-18';
  const row = buildDayRowFromEntries(date, [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
    { context: 'admin-cctv', records: [{ kind: 'data', source: 'cctv-hsinchu-probe', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  assert.equal(row.byContextSource['production-cron'].cctv, 0);
  assert.equal(row.byContextSource['production-cron'].freeway, 1);
  assert.equal(row.byContextSource['admin-cctv'].cctv, 1);
  assert.equal(row.productionDataCalls, 1); // only the freeway call
  assert.equal(row.manualDataCalls, 1); // the CCTV call is manual, not Production
});

// ===========================================================================
// 12. /health still makes 0 TDX/PBS/LINE calls with the new quota dashboard.
// ===========================================================================

test('12. GET /health with the new quota dashboard still makes 0 TDX/PBS/LINE calls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`/health must never call fetch() — tried: ${url}`);
  };
  try {
    const now = new Date();
    const today = taipeiDateString(now);
    const row = buildDayRowFromEntries(today, [
      { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
    ]);
    const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };
    const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /TDX 今日/);
    assert.match(html, /剩餘額度/);
    assert.match(html, /月底預估/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
