// V1.8.6.2 — "來源拆解（今日）" -> "TDX 來源（今日）" correction. TDX's own
// backend confirms 3 real TDX API sources this project ever fetches: 國道
// (freeway), 省道 (highway), and CCTV metadata (cctv). This card now shows
// all 3, always, read from `today.bySource` (the marginal total across
// EVERY call context), NEVER limited to `byContextSource['production-cron']`
// — that old scoping is what caused a source to silently read 0 whenever a
// non-Production context (Debug/Admin) was the one actually calling it.
// Call CONTEXT (Production Cron/Debug Status/Debug TDX/Admin CCTV) is a
// separate axis, kept out of this card entirely (moved into 進階資訊).
// Pure health-UI classification fix — scheduler/pipeline/ledger recording/
// baseline/quota math/CCTV metadata cache/LINE CCTV image logic untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealth } from '../src/traffic/health.js';
import { handleHsinchuCctvFrame } from '../src/tdx/hsinchuCctvProbe.js';
import { buildDayRowFromEntries, taipeiDateString, USAGE_SUMMARY_KEY, USAGE_ENTRY_KEY_PREFIX } from '../src/tdx/usageLedger.js';

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

function extractSourceCard(html) {
  // The TDX 來源（今日） card has no nested <div> inside it (just <ul>/<li>/<p>),
  // so its own closing </div> is the first </div> encountered after the <h2>.
  const match = html.match(/<h2>TDX 來源（今日）<\/h2>[\s\S]*?<\/div>/);
  return match ? match[0] : '';
}

// ===========================================================================
// 1. 國道=0、省道=0、CCTV=0 -> 三列仍全部固定顯示，不隱藏。
// ===========================================================================

test('1. all-zero TDX source day -> 國道/省道/CCTV all 3 rows still render', async () => {
  const now = new Date();
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: {} }; // no entries at all today
  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  const card = extractSourceCard(html);
  assert.match(card, /<span>國道<\/span><span>0<\/span>/);
  assert.match(card, /<span>省道<\/span><span>0<\/span>/);
  assert.match(card, /<span>CCTV<\/span><span>0<\/span>/);
});

// ===========================================================================
// 2. CCTV=5 -> 顯示 CCTV 5。
// ===========================================================================

test('2. 5 CCTV metadata calls today -> TDX 來源 card shows CCTV 5', async () => {
  const now = new Date();
  const today = taipeiDateString(now);
  const cctvRecords = Array.from({ length: 5 }, () => ({
    kind: 'data',
    source: 'cctv-hsinchu-probe',
    attempted: true,
    success: true,
    httpStatus: 200,
    payloadBytesEstimate: 100,
  }));
  const row = buildDayRowFromEntries(today, [{ context: 'admin-cctv', records: cctvRecords }]);
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };
  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  const card = extractSourceCard(html);
  assert.match(card, /<span>CCTV<\/span><span>5<\/span>/);
});

// ===========================================================================
// 3. Debug/Admin context 不會被誤標成 TDX source — the source card must
//    aggregate ACROSS context (bySource), never be scoped to just
//    production-cron (the old, now-fixed byContextSource['production-cron']
//    read would have shown 省道 as 0 here even though it was really called).
// ===========================================================================

test('3. a source called only via Debug/Admin context still shows its real count in TDX 來源 (never scoped to production-cron only)', async () => {
  const now = new Date();
  const today = taipeiDateString(now);
  const row = buildDayRowFromEntries(today, [
    { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
    { context: 'debug-tdx', records: [{ kind: 'data', source: 'highway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
    { context: 'admin-cctv', records: [{ kind: 'data', source: 'cctv-hsinchu-probe', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
  ]);
  const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };
  const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
  const html = await response.text();
  const card = extractSourceCard(html);
  // 省道 was called ONLY by debug-tdx, not production-cron -- must still show 1, not 0.
  assert.match(card, /<span>國道<\/span><span>1<\/span>/);
  assert.match(card, /<span>省道<\/span><span>1<\/span>/);
  assert.match(card, /<span>CCTV<\/span><span>1<\/span>/);
  // Context labels (call-path names) must never appear as rows inside the TDX 來源 card itself.
  assert.doesNotMatch(card, /Debug TDX/);
  assert.doesNotMatch(card, /Admin CCTV/);
  assert.doesNotMatch(card, /Production Cron/);
  // The context breakdown still exists, just relocated under 進階資訊, not merged into the source card.
  assert.match(html, /呼叫情境（今日）/);
  assert.match(html, /Debug TDX/);
});

// ===========================================================================
// 4. freeway.gov.tw MJPEG frame fetch (the real LINE CCTV image path) is
//    untouched -- it never calls TDX, never records into the Usage Ledger,
//    so it can never leak into the TDX 來源 CCTV count.
// ===========================================================================

test('4. handleHsinchuCctvFrame (freeway.gov.tw MJPEG frame grab) never writes a TDX usage-ledger entry', async () => {
  const store = new Map(); // no cached candidates -> deterministic 404, no network needed
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
  const response = await handleHsinchuCctvFrame({ TRAFFIC_KV: kv }, 0);
  assert.equal(response.status, 404); // no candidates cached
  const usageEntryKeys = [...store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageEntryKeys.length, 0); // proves this path never touches the TDX usage ledger
});

// ===========================================================================
// 5. /health still makes 0 TDX/PBS/LINE calls with the new TDX 來源 card.
// ===========================================================================

test('5. GET /health with the new TDX 來源（今日） card still makes 0 TDX/PBS/LINE calls', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`/health must never call fetch() — tried: ${url}`);
  };
  try {
    const now = new Date();
    const today = taipeiDateString(now);
    const row = buildDayRowFromEntries(today, [
      { context: 'production-cron', records: [{ kind: 'data', source: 'freeway', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
      { context: 'admin-cctv', records: [{ kind: 'data', source: 'cctv-hsinchu-probe', attempted: true, success: true, httpStatus: 200, payloadBytesEstimate: 10 }] },
    ]);
    const summary = { schemaVersion: 1, updatedAt: now.toISOString(), days: { [today]: row } };
    const response = await handleHealth({ TRAFFIC_KV: kvWithSummary(now, summary) });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /TDX 來源（今日）/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
