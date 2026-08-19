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
  estimateMonthUsage,
  getOfficialUsageBaseline,
  aggregateUsageForMonth,
  hasPendingBaselineCalibrationGap,
  remainingPoints,
  usagePercent,
  projectEndOfMonthPoints,
  buildDayRowFromEntries,
  taipeiDateString,
  TDX_MONTHLY_POINT_BUDGET,
  TDX_CALLS_PER_POINT,
  TDX_TRAFFIC_MB_PER_POINT,
  TDX_OFFICIAL_USAGE_BASELINES,
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

// ===========================================================================
// CORRECTION (post-review) — 2026-08 pre-Ledger official baseline. The
// Local Usage Ledger only started 2026-08-18 (V1.8.6's Production
// deploy), so for August 2026 specifically, aggregateUsageForMonth alone
// silently omits real TDX usage that already happened (8/16-8/17) before
// the Ledger existed — making "剩餘額度" look artificially larger than it
// really is. estimateMonthUsage folds in a hand-confirmed
// TDX_OFFICIAL_USAGE_BASELINES entry for any month that has one.
// ===========================================================================

const AUGUST_BASELINE = TDX_OFFICIAL_USAGE_BASELINES['2026-08'];

test('1. 2026-08, localMonthPoints = 0 -> estimatedMonthPoints = baseline (1.723) -> remaining = 1.277', () => {
  const now = new Date('2026-08-19T09:00:00+08:00');
  const summary = { trackingStartedAt: null, days: {} }; // no Local Ledger data yet this month
  const usage = estimateMonthUsage(summary, now);
  assert.equal(usage.localPoints, 0);
  assert.equal(usage.estimatedPoints, AUGUST_BASELINE.officialPoints);
  assert.equal(usage.estimatedPoints, 1.723);
  assert.equal(remainingPoints(usage.estimatedPoints), 1.277);
});

test('2. 2026-08, localMonthPoints = 0.200 -> estimatedMonthPoints = 1.923 -> remaining = 1.077', () => {
  const now = new Date('2026-08-19T09:00:00+08:00');
  const summary = {
    trackingStartedAt: null,
    days: { '2026-08-19': { totalDataCalls: 300, payloadBytesEstimate: 0 } }, // 300/1500 = 0.2 point
  };
  const usage = estimateMonthUsage(summary, now);
  assert.ok(Math.abs(usage.localPoints - 0.2) < 1e-9);
  assert.ok(Math.abs(usage.estimatedPoints - 1.923) < 1e-9);
  assert.ok(Math.abs(remainingPoints(usage.estimatedPoints) - 1.077) < 1e-9);
});

test('3. 2026-09 -> the August baseline does NOT apply at all', () => {
  const now = new Date('2026-09-05T09:00:00+08:00');
  assert.equal(getOfficialUsageBaseline(now), null);

  const summary = {
    trackingStartedAt: null,
    days: { '2026-09-01': { totalDataCalls: 150, payloadBytesEstimate: 0 } }, // 0.1 point, fully Ledger-covered
  };
  const usage = estimateMonthUsage(summary, now);
  assert.equal(usage.baseline, null);
  assert.ok(Math.abs(usage.estimatedPoints - usage.localPoints) < 1e-9); // no baseline added — estimated === local
  assert.ok(Math.abs(usage.estimatedPoints - 0.1) < 1e-9);
});

test('4. month-end projection = baseline + local month-to-date + (complete-local-day average x remaining days)', () => {
  const now = new Date('2026-08-25T09:00:00+08:00');
  const summary = {
    trackingStartedAt: null,
    days: {
      '2026-08-20': { totalDataCalls: 150, payloadBytesEstimate: 0 }, // 0.1 point, complete
      '2026-08-21': { totalDataCalls: 150, payloadBytesEstimate: 0 }, // 0.1 point, complete
      '2026-08-25': { totalDataCalls: 0, payloadBytesEstimate: 0 }, // today — excluded from the average
    },
  };
  const result = projectEndOfMonthPoints(summary, now);
  assert.equal(result.ready, true);
  assert.equal(result.completeDayCount, 2);
  assert.ok(Math.abs(result.avgPointsPerDay - 0.1) < 1e-9); // LOCAL days only — the baseline is NOT a daily row and must never feed this average

  // monthToDatePoints must be baseline (AUGUST_BASELINE.officialPoints) + local MTD (300 calls / 1500 = 0.2)
  const expectedMonthToDate = AUGUST_BASELINE.officialPoints + 0.2;
  assert.ok(Math.abs(result.monthToDatePoints - expectedMonthToDate) < 1e-9);

  // August has 31 days; today is the 25th -> 6 days remain after today.
  const expectedProjected = expectedMonthToDate + 0.1 * 6;
  assert.ok(Math.abs(result.projected - expectedProjected) < 1e-9);
});

test('5. 8/16 and 8/17 still render 尚無資料 in the daily table — the baseline never fabricates Local Ledger daily rows', async () => {
  const now = new Date('2026-08-19T09:00:00+08:00'); // 7-day window (08/13-08/19) includes both 08/16 and 08/17
  const today = taipeiDateString(now);
  const row = buildDayRowFromEntries(today, [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  // Deliberately NO entries for 2026-08-16/17 in summary.days — exactly the real situation (Ledger didn't exist yet).
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };

  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  assert.match(html, /<tr><td>08\/16<\/td><td colspan="4" style="text-align:center;color:#999;">尚無資料<\/td><\/tr>/);
  assert.match(html, /<tr><td>08\/17<\/td><td colspan="4" style="text-align:center;color:#999;">尚無資料<\/td><\/tr>/);
});

test('6. GET /health still makes 0 TDX/PBS/LINE calls when a month-level official baseline is in effect', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`/health must never call fetch() — tried: ${url}`);
  };
  try {
    const now = new Date('2026-08-19T09:00:00+08:00');
    const today = taipeiDateString(now);
    const row = buildDayRowFromEntries(today, [
      { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
    ]);
    const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };
    const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /TDX 官方既有用量/); // the baseline note actually rendered, proving it went through the real render path
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ===========================================================================
// CORRECTION (post-review) — overlap-safe baseline: a Local Ledger day ON
// OR BEFORE baseline.throughDate must never be double-counted into the
// month quota total (it's already inside the baseline's own cumulative
// figure); a Local Ledger day STRICTLY AFTER throughDate still adds on
// top.
//
// V1.8.6.3 UPDATE — TDX's official 2026-08-18 day-close figures are now
// confirmed, so throughDate moved from 2026-08-17 to 2026-08-18. The gap
// that used to exist between throughDate and trackingStartedAt (mid-day
// 2026-08-18) is now closed — see the dedicated "no gap under current
// real baseline" test below, plus a separate mechanism-only test proving
// hasPendingBaselineCalibrationGap still correctly fires for a
// hypothetical LATER tracking-start date.
// ===========================================================================

test('1. baseline through 8/18, local rows on 8/19 + 8/20 -> BOTH add to the month total (neither is on/before throughDate)', () => {
  const now = new Date('2026-08-20T09:00:00+08:00');
  assert.equal(AUGUST_BASELINE.throughDate, '2026-08-18'); // the real, current baseline this test relies on
  const summary = {
    trackingStartedAt: null,
    days: {
      '2026-08-19': { totalDataCalls: 100, payloadBytesEstimate: 0 },
      '2026-08-20': { totalDataCalls: 50, payloadBytesEstimate: 0 },
    },
  };
  const usage = estimateMonthUsage(summary, now);
  assert.equal(usage.localTotals.totalDataCalls, 150); // 100 + 50 — both included
  assert.equal(usage.estimatedCalls, AUGUST_BASELINE.calls + 150);
});

test('2. a hypothetical baseline through 8/18: local rows on 8/18 + 8/19 -> ONLY 8/19 adds to the month total (8/18 not double-counted)', () => {
  const now = new Date('2026-08-19T09:00:00+08:00');
  const summary = {
    days: {
      '2026-08-18': { totalDataCalls: 100, payloadBytesEstimate: 0 }, // on the (hypothetical) throughDate -> excluded
      '2026-08-19': { totalDataCalls: 50, payloadBytesEstimate: 0 }, // strictly after -> included
    },
  };
  // Exercises the overlap-safe exclusion mechanism directly (aggregateUsageForMonth's `afterDate` option)
  // rather than editing the real TDX_OFFICIAL_USAGE_BASELINES constant.
  const totals = aggregateUsageForMonth(summary, now, { afterDate: '2026-08-18' });
  assert.equal(totals.totalDataCalls, 50); // only 8/19 — 8/18 correctly excluded, not double-counted
});

test('3. the 8/18 Local Ledger daily row still exists/renders normally even though it is excluded from the month quota total', async () => {
  const now = new Date('2026-08-19T09:00:00+08:00'); // 7-day window (08/13-08/19) includes 08/18
  const day18 = buildDayRowFromEntries('2026-08-18', [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  const today = taipeiDateString(now);
  const todayRow = buildDayRowFromEntries(today, [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { '2026-08-18': day18, [today]: todayRow } };

  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  // The 8/18 row must show its real call count (1), not "尚無資料" —
  // daily reconciliation is untouched by the month-quota overlap fix.
  assert.doesNotMatch(html, /<tr><td>08\/18<\/td><td colspan="4" style="text-align:center;color:#999;">尚無資料<\/td><\/tr>/);
  assert.match(html, /<td>08\/18<\/td>\s*<td>1<\/td>/); // the real row (multi-line, unlike the compact "missing" template) — its actual call count, not a placeholder
});

test('4. V1.8.6.3: current real baseline (through 8/18) + real trackingStartedAt mid-day 8/18 -> NO pending-calibration gap; 暫估 badge and warning both gone', async () => {
  const now = new Date('2026-08-19T09:00:00+08:00');
  const trackingStartedAt = '2026-08-18T12:40:00.000Z'; // 2026-08-18 20:40+08:00 — the real V1.8.6 deploy moment, now ON the baseline's throughDate
  const summary = { trackingStartedAt, days: {} };

  assert.equal(hasPendingBaselineCalibrationGap(summary, now), false);

  const today = taipeiDateString(now);
  const todayRow = buildDayRowFromEntries(today, [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  const fullSummary = { schemaVersion: 1, updatedAt: now.toISOString(), trackingStartedAt, days: { [today]: todayRow } };
  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, fullSummary) });
  const html = await response.text();
  assert.doesNotMatch(html, /尚待 TDX 官方日結校正/);
  assert.doesNotMatch(html, /（暫估）/);
  assert.match(html, /<h2>TDX 本月<\/h2>/); // badge-free heading restored
  assert.match(html, /<h2>剩餘額度<\/h2>/); // badge-free heading restored
});

test('4b. gap-detection mechanism still correctly fires for a hypothetical LATER tracking-start date beyond the current baseline coverage', () => {
  const now = new Date('2026-08-20T09:00:00+08:00');
  const trackingStartedAt = '2026-08-19T12:40:00.000Z'; // 2026-08-19 20:40+08:00 — mid-day, one day after the current throughDate (8/18)
  assert.equal(hasPendingBaselineCalibrationGap({ trackingStartedAt, days: {} }, now), true);
});

test('no pending-calibration gap when trackingStartedAt is on/before throughDate, or exactly midnight the day after', () => {
  const now = new Date('2026-08-20T09:00:00+08:00');
  // Tracking started ON throughDate itself -> no gap.
  assert.equal(hasPendingBaselineCalibrationGap({ trackingStartedAt: '2026-08-18T01:00:00.000Z', days: {} }, now), false);
  // Tracking started exactly at 00:00:00 Asia/Taipei the day after throughDate -> the Ledger covers that whole day, no gap.
  assert.equal(hasPendingBaselineCalibrationGap({ trackingStartedAt: '2026-08-18T16:00:00.000Z', days: {} }, now), false); // 2026-08-19T00:00:00+08:00 exactly
  // No trackingStartedAt at all yet -> nothing to flag.
  assert.equal(hasPendingBaselineCalibrationGap({ trackingStartedAt: null, days: {} }, now), false);
});
