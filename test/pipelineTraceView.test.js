// V1.8.6.7 — GET /admin/pipeline-trace-view: the human-readable HTML
//查修頁. Covers: Admin Auth, 405 for non-GET, mobile-readable rendering
// (viewport meta, no client-side JS given the existing strict Admin CSP),
// status/CCTV/map badges, and the anomaly diff display.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { recordPipelineTrace, buildTraceEntry, buildUpstreamSnapshot } from '../src/traffic/pipelineTrace.js';

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '93K+500',
    endKM: '93K+000',
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: '事故',
      eventSubType: '一般事故',
      rawDirection: '北向',
      rawStartKM: '93K+500',
      rawEndKM: '93K+000',
      description: '北向93.5K車輛事故',
    }),
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T20:20:00+08:00');
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-trace-view';

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function adminRequest(path, { method = 'GET', auth } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, { method, headers });
}

function throwingFetch(label) {
  return async (...args) => {
    throw new Error(`unexpected ${label} call: ${JSON.stringify(args[0])}`);
  };
}

let originalFetch;

test('28: GET /admin/pipeline-trace-view with no Authorization -> 401', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view'), env);
    assert.equal(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('29: POST /admin/pipeline-trace-view -> 405 with valid credentials', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { method: 'POST', auth }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
});

test('27: renders mobile-readable HTML — viewport meta, no client-side JS, Cache-Control no-store, 0 upstream calls', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(
    kv,
    buildTraceEntry({
      event: accidentEvent(),
      now: NOW,
      eligibility: true,
      eligibilityReason: 'eligible-type',
      lineAttempted: 1,
      lineSucceeded: 1,
      cctvEligible: true,
      imagePrepared: true,
      imageUrlPresent: true,
      kmLocationResolution: { resolved: true, dataset: 'freeway', locationLabel: '竹北交流道' },
      formattedOutput: '🚨 交通事故\n📍 地圖 https://maps.google.com/?q=24.80605,121.00998',
    }),
    NOW
  );
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store, private');
    // The existing Admin CSP (default-src 'none', no script-src exception)
    // must still block any script — this page must never need one.
    assert.match(res.headers.get('Content-Security-Policy') || '', /default-src 'none'/);

    const html = await res.text();
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /國道一號/);
    assert.match(html, /📷/); // CCTV image badge
    assert.match(html, /🗺️/); // map badge
    assert.match(html, /<details/); // expand/collapse without JS
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('view page shows an anomaly banner for a record that actually has one (direction changed)', async () => {
  const kv = createMockKV();
  const event = accidentEvent({
    direction: '北向',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawDirection: '南向' }),
  });
  await recordPipelineTrace(kv, buildTraceEntry({ event, now: NOW, eligibility: true }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /上游方向.*南向.*系統方向.*北向/s);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('view page filters by ?rawId= (GET query, no JS needed)', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'A1' }), now: NOW, eligibility: true }), NOW);
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'A2' }), now: new Date(NOW.getTime() + 1000), eligibility: false, eligibilityReason: 'unrecognized-type' }), new Date(NOW.getTime() + 1000));
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view?rawId=A2', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /A2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('view page shows a friendly empty state when there is no data', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /沒有資料/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
