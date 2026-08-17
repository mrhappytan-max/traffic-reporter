import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealth } from '../src/traffic/health.js';

// handleHealth(env) uses the real wall clock internally (no injectable
// `now`), so staleness tests below use snapshot.generatedAt computed as an
// offset from the real Date.now() at test-run time, not a fixed timestamp.

function kv(initial) {
  const store = new Map();
  if (initial) store.set('health:snapshot:v1', JSON.stringify(initial));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function baseSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'normal',
    tdx: {
      tokenOk: true,
      successfulSourceCount: 5,
      totalSourceCount: 5,
      sources: [
        { source: 'freeway', label: '國道即時道路事件', ok: true, httpStatus: 200 },
        { source: 'highway', label: '省道即時道路事件', ok: true, httpStatus: 200 },
        { source: 'cms', label: '新竹市 CMS 即時看板', ok: true, httpStatus: 200 },
        { source: 'bus-hsinchu', label: '新竹市公車營運通阻', ok: true, httpStatus: 200 },
        { source: 'bus-hsinchu-county', label: '新竹縣公車營運通阻', ok: true, httpStatus: 200 },
      ],
    },
    pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 1000, hsinchuCount: 27, activeCount: 5, clearedCount: 15, staleCount: 7 },
    line: { ready: true, enabledUsersCount: 1, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
    kv: { available: true },
    broadcast: {
      broadcastRelevantCount: 0,
      pendingTargetCount: 0,
      typeIneligibleCount: 3,
      ineligibleByReason: { 'congestion-excluded': 2, 'other-no-anomaly-keyword': 1 },
      incidentSuppressedCount: 0,
    },
    ...overrides,
  };
}

function withFetchGuard(fn) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      throw new Error(`unexpected network call during /health: ${JSON.stringify(args[0])}`);
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test('handleHealth never calls fetch (no TDX/PBS/LINE network activity)', withFetchGuard(async () => {
  const env = { TRAFFIC_KV: kv(baseSnapshot()) };
  const res = await handleHealth(env);
  assert.equal(res.status, 200);
}));

test('handleHealth never writes to KV (read-only): kv.put is never invoked', async () => {
  const TRAFFIC_KV = kv(baseSnapshot());
  let putCalled = false;
  const originalPut = TRAFFIC_KV.put.bind(TRAFFIC_KV);
  TRAFFIC_KV.put = async (...args) => {
    putCalled = true;
    return originalPut(...args);
  };
  await handleHealth({ TRAFFIC_KV });
  assert.equal(putCalled, false);
});

test('fresh snapshot (<10min old) -> underlying status shown as-is, no staleness notice', async () => {
  const snapshot = baseSnapshot({ status: 'normal', generatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() });
  const res = await handleHealth({ TRAFFIC_KV: kv(snapshot) });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /正常/);
  assert.doesNotMatch(html, /資料更新延遲/);
});

test('snapshot 10-15min old -> "資料更新延遲" notice, normal upgraded to degraded', async () => {
  const snapshot = baseSnapshot({ status: 'normal', generatedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString() });
  const res = await handleHealth({ TRAFFIC_KV: kv(snapshot) });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /資料更新延遲（10～15 分鐘）/);
  assert.match(html, /降級運作/);
  assert.doesNotMatch(html, /🟢/);
});

test('snapshot >15min old -> forced critical regardless of underlying status, with the 15-minute notice', async () => {
  const snapshot = baseSnapshot({ status: 'normal', generatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  const res = await handleHealth({ TRAFFIC_KV: kv(snapshot) });
  const html = await res.text();
  assert.equal(res.status, 503);
  assert.match(html, /健康快照超過 15 分鐘沒有更新/);
  assert.match(html, /嚴重異常/);
});

test('missing snapshot (KV empty) -> safe 503 HTML page, no throw', async () => {
  const res = await handleHealth({ TRAFFIC_KV: kv(null) });
  const html = await res.text();
  assert.equal(res.status, 503);
  assert.match(html, /尚未有健康快照/);
});

test('missing TRAFFIC_KV binding entirely -> safe 503 HTML page, no throw', async () => {
  const res = await handleHealth({});
  const html = await res.text();
  assert.equal(res.status, 503);
  assert.match(html, /尚未有健康快照/);
});

test('ineligibleByReason keys rendered as Chinese labels', async () => {
  const snapshot = baseSnapshot({
    broadcast: {
      broadcastRelevantCount: 0,
      pendingTargetCount: 0,
      typeIneligibleCount: 4,
      ineligibleByReason: {
        'congestion-excluded': 2,
        'alert-excluded': 1,
        'construction-no-impact-keyword': 3,
        'other-no-anomaly-keyword': 1,
      },
      incidentSuppressedCount: 0,
    },
  });
  const res = await handleHealth({ TRAFFIC_KV: kv(snapshot) });
  const html = await res.text();
  assert.match(html, /壅塞事件/);
  assert.match(html, /公車一般通阻資訊/);
  assert.match(html, /施工無重大影響/);
  assert.match(html, /一般其他事件/);
  // raw reason keys must never leak into the HTML
  assert.doesNotMatch(html, /congestion-excluded/);
  assert.doesNotMatch(html, /alert-excluded/);
  assert.doesNotMatch(html, /construction-no-impact-keyword/);
  assert.doesNotMatch(html, /other-no-anomaly-keyword/);
});

test('response Content-Type is text/html; charset=utf-8', async () => {
  const res = await handleHealth({ TRAFFIC_KV: kv(baseSnapshot()) });
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
});

test('missing-snapshot response also has the utf-8 html content type', async () => {
  const res = await handleHealth({ TRAFFIC_KV: kv(null) });
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
});

test('HTML output never leaks token/secret/userId/groupId/Authorization substrings', async () => {
  const snapshot = baseSnapshot({
    tdx: {
      tokenOk: false,
      successfulSourceCount: 3,
      totalSourceCount: 5,
      sources: [
        { source: 'freeway', label: '國道即時道路事件', ok: false, httpStatus: 429 },
        { source: 'highway', label: '省道即時道路事件', ok: false, httpStatus: 401 },
        { source: 'cms', label: '新竹市 CMS 即時看板', ok: true, httpStatus: 200 },
        { source: 'bus-hsinchu', label: '新竹市公車營運通阻', ok: true, httpStatus: 200 },
        { source: 'bus-hsinchu-county', label: '新竹縣公車營運通阻', ok: true, httpStatus: 200 },
      ],
    },
    pbs: { ok: false, relayOk: false, relayStatus: 502, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
    line: { ready: false, enabledUsersCount: 2, enabledGroupsCount: 1, pushAttempted: 3, pushSucceeded: 1, partialPushFailures: 2, lastLinePushAt: new Date().toISOString() },
  });
  const res = await handleHealth({ TRAFFIC_KV: kv(snapshot) });
  const html = await res.text();
  assert.doesNotMatch(html, /\btoken\b/i);
  assert.doesNotMatch(html, /secret/i);
  assert.doesNotMatch(html, /userId|groupId/i);
  assert.doesNotMatch(html, /Authorization/i);
  // Also guard against accidental literal secret-shaped values leaking in
  assert.doesNotMatch(html, /Bearer\s+\S+/i);
});

test('KV read throwing -> treated as missing snapshot, safe 503, no throw out of handleHealth', async () => {
  const brokenKv = {
    async get() {
      throw new Error('KV read outage');
    },
  };
  const res = await handleHealth({ TRAFFIC_KV: brokenKv });
  assert.equal(res.status, 503);
});
