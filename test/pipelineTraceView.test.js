// V1.8.6.7 — GET /admin/pipeline-trace-view: the human-readable HTML
//查修頁. Covers: Admin Auth, 405 for non-GET, mobile-readable rendering
// (viewport meta, no client-side JS given the existing strict Admin CSP),
// status/CCTV/map badges, and the anomaly diff display.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { recordPipelineTrace, buildTraceEntry, buildUpstreamSnapshot } from '../src/traffic/pipelineTrace.js';
import { handlePipelineTraceView, formatTaipeiListTime } from '../src/traffic/pipelineTraceView.js';

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

// --- V1.8.6.8: the time-policy breakdown (section 4 of that round) -------

test('view page distinguishes "非播報時段" from "事件已結束" from "事件尚未開始" — never a single generic status for all three', async () => {
  const kv = createMockKV();
  const window = { effectiveStart: '2026-08-20T13:00:00.000Z', effectiveEnd: '2026-08-20T22:00:00.000Z', timeSource: 'description' };
  await recordPipelineTrace(kv, buildTraceEntry({
    event: accidentEvent({ rawId: 'OUT1', type: 'construction' }), now: NOW, eligibility: true, eligibilityReason: 'construction-impact-keyword',
    relevant: true, eventTimeStatus: 'active', eventWindow: window, broadcastWindowActive: false, lineAttempted: 0, lineSucceeded: 0,
  }), NOW);
  await recordPipelineTrace(kv, buildTraceEntry({
    event: accidentEvent({ rawId: 'ENDED1', type: 'construction' }), now: NOW, eligibility: true, eligibilityReason: 'construction-impact-keyword',
    relevant: false, eventTimeStatus: 'ended', eventWindow: window, broadcastWindowActive: true,
  }), NOW);
  await recordPipelineTrace(kv, buildTraceEntry({
    event: accidentEvent({ rawId: 'NOTSTART1', type: 'construction' }), now: NOW, eligibility: true, eligibilityReason: 'construction-impact-keyword',
    relevant: false, eventTimeStatus: 'not-started', eventWindow: window, broadcastWindowActive: true,
  }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /非播報時段（08:00～22:00）/);
    assert.match(html, /事件已結束/);
    assert.match(html, /事件尚未開始/);
    // The detail section's own labeled fields must also be present, not
    // just the summary badge.
    assert.match(html, /eventActive/);
    assert.match(html, /broadcastWindowActive/);
    assert.match(html, /事件有效時間/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- V1.8.6.9a: mobile UX pass — Taiwan time / closed-vocab filters / dark mode ---

test('V1.8.6.9a: per-row summary time is Asia/Taipei, not raw UTC (04:00 UTC must render as 12:xx Taipei, not 04:xx)', async () => {
  const kv = createMockKV();
  // 2026-08-20T04:00:00Z is noon in Taipei (UTC+8). The pre-fix bug used
  // toISOString().slice(11,16) on this exact timestamp, which renders
  // "04:00" — the precise real-device complaint this round fixes. `now`
  // (the render-time reference for the relative-date correction below)
  // is pinned to the SAME Taipei calendar day so this test only exercises
  // the UTC-offset fix, not the today/yesterday logic.
  const utcNoonTaipei = new Date('2026-08-20T04:00:00.000Z');
  const renderNow = new Date('2026-08-20T10:00:00.000Z'); // 18:00 Taipei, same day
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'TZ1' }), now: utcNoonTaipei, eligibility: true }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), renderNow);
  const html = await res.text();
  assert.match(html, /col-time">今天 12:00</);
  assert.doesNotMatch(html, /col-time">今天 04:00</);
});

test('V1.8.6.9a: page states explicitly that times are Asia/Taipei, not UTC', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /Asia\/Taipei/);
    assert.match(html, /UTC\+8/);
    assert.match(html, /不是 UTC/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('V1.8.6.9a: source/status filters are closed-vocabulary <select> dropdowns, not free-text inputs', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /<select name="source"/);
    assert.match(html, /<select name="status"/);
    assert.doesNotMatch(html, /<input[^>]*name="source"/);
    assert.doesNotMatch(html, /<input[^>]*name="status"/);
    // road/rawId remain genuinely open-ended free text.
    assert.match(html, /<input type="text" name="road"/);
    assert.match(html, /<input type="text" name="rawId"/);
    // option lists reuse the exact same source-of-truth labels rendered on rows.
    assert.match(html, /<option value="freeway"[^>]*>TDX 國道（freeway）<\/option>/);
    assert.match(html, /<option value="line-sent"[^>]*>✅ 已播報<\/option>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('V1.8.6.9a: selecting a source/status via query string pre-selects the matching <option>', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view?source=pbs&status=line-failed', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /<option value="pbs" selected>/);
    assert.match(html, /<option value="line-failed" selected>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('V1.8.6.9a: page renders in dark mode — dark background, color-scheme dark, no large pure-white background', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /<meta name="color-scheme" content="dark">/);
    assert.match(html, /color-scheme:\s*dark/);
    assert.match(html, /background:\s*#0f1115/);
    assert.doesNotMatch(html, /background:\s*#fff(?:fff)?\b/i);
    assert.doesNotMatch(html, /background-color:\s*#fff(?:fff)?\b/i);
    // Inputs/selects/buttons must also be dark-themed, and placeholders visible.
    assert.match(html, /\.filters input, \.filters select \{[^}]*background: #20242c/);
    assert.match(html, /::placeholder \{ color: #6b7280/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('V1.8.6.9a: CCTV badge uses a distinct teal class, map badge uses a distinct blue class', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(
    kv,
    buildTraceEntry({
      event: accidentEvent(),
      now: NOW,
      eligibility: true,
      cctvEligible: true,
      imagePrepared: true,
      imageUrlPresent: true,
      kmLocationResolution: { resolved: true, dataset: 'freeway', locationLabel: '竹北交流道' },
    }),
    NOW
  );
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /badge badge-cctv/);
    assert.match(html, /badge badge-map/);
    assert.match(html, /\.badge-cctv \{ background: #102b2a; color: #2dd4bf/);
    assert.match(html, /\.badge-map \{ background: #0f2038; color: #58a6ff/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- V1.8.6.9a correction round: relative list time / D. 事件時間軸 / LINE honesty ---

test('V1.8.6.9a correction: formatTaipeiListTime — same Taipei calendar day -> 今天 HH:mm', () => {
  const now = new Date('2026-08-21T10:00:00.000Z'); // 18:00 Taipei, Aug 21
  const iso = '2026-08-21T04:10:00.000Z'; // 12:10 Taipei, same Taipei day as `now`
  assert.equal(formatTaipeiListTime(iso, now), '今天 12:10');
});

test('V1.8.6.9a correction: formatTaipeiListTime — previous Taipei calendar day -> 昨天 HH:mm', () => {
  const now = new Date('2026-08-21T01:00:00.000Z'); // 09:00 Taipei, Aug 21
  const iso = '2026-08-20T15:50:00.000Z'; // 23:50 Taipei, Aug 20
  assert.equal(formatTaipeiListTime(iso, now), '昨天 23:50');
});

test('V1.8.6.9a correction: formatTaipeiListTime — older than yesterday -> M/D HH:mm', () => {
  const now = new Date('2026-08-25T00:00:00.000Z'); // Aug 25 Taipei
  const iso = '2026-08-20T12:13:00.000Z'; // 20:13 Taipei, Aug 20
  assert.equal(formatTaipeiListTime(iso, now), '8/20 20:13');
});

test('V1.8.6.9a correction: formatTaipeiListTime crosses the Taipei midnight boundary correctly — 20 real minutes apart but different Taipei calendar days must say 昨天, not 今天', () => {
  const now = new Date('2026-08-20T16:10:00.000Z'); // 00:10 Taipei, Aug 21 (just past midnight)
  const iso = '2026-08-20T15:50:00.000Z'; // 23:50 Taipei, Aug 20 (20 minutes earlier)
  assert.equal(formatTaipeiListTime(iso, now), '昨天 23:50');
});

test('V1.8.6.9a correction: formatTaipeiListTime — same Taipei calendar day despite being nearly 24h apart must say 今天, not 昨天', () => {
  const now = new Date('2026-08-20T15:55:00.000Z'); // 23:55 Taipei, Aug 20
  const iso = '2026-08-20T00:05:00.000Z'; // 08:05 Taipei, Aug 20 — same day, ~15.8h earlier
  assert.equal(formatTaipeiListTime(iso, now), '今天 08:05');
});

test('V1.8.6.9a correction: list column actually renders 今天/昨天/M-D through the real page, not just the pure helper', async () => {
  const kv = createMockKV();
  const renderNow = new Date('2026-08-21T01:00:00.000Z'); // 09:00 Taipei, Aug 21
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'TODAY1' }), now: new Date('2026-08-21T00:10:00.000Z'), eligibility: true }), NOW); // 08:10 Taipei Aug 21 -> 今天
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'YEST1' }), now: new Date('2026-08-20T15:50:00.000Z'), eligibility: true }), NOW); // 23:50 Taipei Aug 20 -> 昨天
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'OLD1' }), now: new Date('2026-08-18T12:13:00.000Z'), eligibility: true }), NOW); // 20:13 Taipei Aug 18 -> 8/18
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), renderNow);
  const html = await res.text();
  assert.match(html, /col-time">今天 08:10</);
  assert.match(html, /col-time">昨天 23:50</);
  assert.match(html, /col-time">8\/18 20:13</);
});

test('V1.8.6.9a correction: detail page has a D. 事件時間軸 section with 上游更新/系統抓取 in Asia/Taipei', async () => {
  const kv = createMockKV();
  const event = accidentEvent({
    rawId: 'TIMELINE1',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawDirection: '北向', upstreamUpdatedAt: '2026-08-20T03:30:00.000Z' }), // 11:30 Taipei
  });
  await recordPipelineTrace(kv, buildTraceEntry({ event, now: new Date('2026-08-20T04:00:00.000Z'), eligibility: true }), NOW); // 12:00 Taipei
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), new Date('2026-08-20T10:00:00.000Z'));
  const html = await res.text();
  assert.match(html, /D\. 事件時間軸（Asia\/Taipei）/);
  assert.match(html, /上游更新[\s\S]*?2026-08-20 11:30/);
  assert.match(html, /系統抓取[\s\S]*?2026-08-20 12:00/);
});

test('V1.8.6.9a correction: LINE timeline — successfully sent but schema has no independent push timestamp -> honest "已播報（未保存獨立時間）", never identity.timestamp masquerading as push time', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(kv, buildTraceEntry({
    event: accidentEvent({ rawId: 'SENT1' }), now: NOW, eligibility: true, lineAttempted: 1, lineSucceeded: 1,
  }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), NOW);
  const html = await res.text();
  assert.match(html, /LINE 播報[\s\S]*?已播報（未保存獨立時間）/);
});

test('V1.8.6.9a correction: LINE timeline — never played shows 未播報 + the existing status/reason (suppressed example)', async () => {
  const kv = createMockKV();
  const event = accidentEvent({ rawId: 'SUPPRESSED1' });
  await recordPipelineTrace(kv, buildTraceEntry({
    event, now: NOW, eligibility: true, suppressionResult: 'same-incident-no-escalation', lineAttempted: 0, lineSucceeded: 0,
  }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), NOW);
  const html = await res.text();
  assert.match(html, /LINE 播報[\s\S]*?未播報（⚠️ 已抑制（同一事故））/);
});

test('V1.8.6.9a correction: LINE timeline — attempted but failed shows 未播報 + line-failed status, never a fabricated time', async () => {
  const kv = createMockKV();
  const event = accidentEvent({ rawId: 'FAILED1' });
  await recordPipelineTrace(kv, buildTraceEntry({
    event, now: NOW, eligibility: true, lineAttempted: 1, lineSucceeded: 0,
  }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), NOW);
  const html = await res.text();
  assert.match(html, /LINE 播報[\s\S]*?未播報（❌ LINE 推播失敗）/);
});

test('V1.8.6.9a correction: if the trace schema ever gains a real push timestamp field, the timeline uses it instead of the honest fallback', async () => {
  const kv = createMockKV();
  const entry = buildTraceEntry({ event: accidentEvent({ rawId: 'FUTURE1' }), now: NOW, eligibility: true, lineAttempted: 1, lineSucceeded: 1 });
  entry.delivery.linePushedAt = '2026-08-20T04:05:00.000Z'; // 12:05 Taipei — simulates a future schema addition
  await recordPipelineTrace(kv, entry, NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), NOW);
  const html = await res.text();
  assert.match(html, /LINE 播報[\s\S]*?2026-08-20 12:05/);
  assert.doesNotMatch(html, /未保存獨立時間/);
});

test('V1.8.6.9a correction: imageExpiresAt and UpdatedAt in the detail sections are Asia/Taipei, never raw ISO', async () => {
  const kv = createMockKV();
  const event = accidentEvent({
    rawId: 'ISOFMT1',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawDirection: '北向', upstreamUpdatedAt: '2026-08-20T03:30:00.000Z' }), // 11:30 Taipei
  });
  await recordPipelineTrace(kv, buildTraceEntry({
    event, now: new Date('2026-08-20T04:00:00.000Z'), eligibility: true, cctvEligible: true, imagePrepared: true, imageUrlPresent: true,
    imageExpiresAt: '2026-08-20T05:00:00.000Z', // 13:00 Taipei
  }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const res = await handlePipelineTraceView(env, adminRequest('/admin/pipeline-trace-view'), new Date('2026-08-20T10:00:00.000Z'));
  const html = await res.text();
  assert.doesNotMatch(html, /2026-08-20T03:30:00\.000Z/);
  assert.doesNotMatch(html, /2026-08-20T05:00:00\.000Z/);
  assert.match(html, /2026-08-20 11:30/); // UpdatedAt, Taipei
  assert.match(html, /2026-08-20 13:00/); // imageExpiresAt, Taipei
});

test('V1.8.6.9a correction: /admin/pipeline-trace (JSON API) contract is unchanged — raw UTC ISO, no Taipei formatting applied', async () => {
  const kv = createMockKV();
  const event = accidentEvent({
    rawId: 'JSON1',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawDirection: '北向', upstreamUpdatedAt: '2026-08-20T03:30:00.000Z' }),
  });
  await recordPipelineTrace(kv, buildTraceEntry({ event, now: new Date('2026-08-20T04:00:00.000Z'), eligibility: true }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace', { auth }), env);
  const body = await res.json();
  const record = body.records.find((r) => r.identity.rawId === 'JSON1');
  assert.equal(record.identity.timestamp, '2026-08-20T04:00:00.000Z');
  assert.equal(record.upstream.upstreamUpdatedAt, '2026-08-20T03:30:00.000Z');
});

// =======================================================================
// V1.9.1 — real ROOT CAUSE fix, confirmed with a real headless-Chromium
// reproduction (not part of this repo's automated suite — no browser
// binary dependency was added — but its finding is locked in here as a
// deterministic, no-browser regression test): pipelineTraceView.js's
// filter <form> was correct at every layer already (V1.8.7.6 verified
// this exhaustively), but applyAdminSecurityHeaders' own CSP shipped
// `form-action 'none'`, which every CSP-enforcing browser (which is
// every current major browser, including the iOS Safari a real
// Production report came from) uses to REFUSE to ever submit ANY <form>
// on this or any other admin HTML page — the browser's own console error
// was: "Refused to send form data to '...' because it violates the
// following Content Security Policy directive: form-action 'none'."
// Confirmed directly: stripping only this one directive (all else
// identical) let a real Chromium instance's click on the rendered
// submit button navigate correctly to the filtered URL.
// =======================================================================

test('V1.9.1 — the CSP no longer ships form-action \'none\' (root cause of "篩選按了沒有用" — every admin <form> was silently blocked by every CSP-enforcing browser)', async () => {
  const kv = createMockKV();
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth }), env);
  const csp = res.headers.get('Content-Security-Policy');
  assert.ok(csp, 'the page must still carry a CSP at all');
  assert.doesNotMatch(csp, /form-action 'none'/, 'this exact value silently blocked every <form> submission on every CSP-enforcing browser');
  assert.match(csp, /form-action 'self'/, 'same-origin forms (the only kind this project ever ships) must still be allowed to submit');
});

test('V1.9.1 — the rendered filter <form> has no method/action that would conflict with form-action \'self\' (same-origin GET, no explicit action attribute)', async () => {
  const kv = createMockKV();
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth }), env);
  const html = await res.text();
  assert.match(html, /<form class="filters" method="get">/);
  // No `action="https://..."` / `action="//..."` anywhere — a same-origin,
  // no-action form is exactly what `form-action 'self'` allows.
  assert.doesNotMatch(html, /<form[^>]*action=/);
});

// =======================================================================
// V1.9.1 — DEFAULT_LIST_LIMIT 30 -> 60. The placeholder text and the
// unfiltered record count must both reflect the new default — a stale
// placeholder would itself be a "the UI lies about what it's doing" bug
// of exactly the kind this round exists to eliminate.
// =======================================================================

test('V1.9.1 — the 筆數 placeholder reads 60, not the old 30', async () => {
  const kv = createMockKV();
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth }), env);
  const html = await res.text();
  assert.match(html, /筆數（預設 60）/);
  assert.doesNotMatch(html, /筆數（預設 30）/);
});

test('V1.9.1 — with more than 60 real records and no limit specified, exactly 60 are returned (not 30, not unbounded)', async () => {
  const kv = createMockKV();
  for (let i = 0; i < 75; i += 1) {
    await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: `V191-${i}` }), now: NOW }), NOW);
  }
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view', { auth }), env);
  const html = await res.text();
  const rowCount = (html.match(/class="trace-row/g) || []).length;
  assert.equal(rowCount, 60);
});

// =======================================================================
// V1.9.1 — 清除 (clear/reset) link genuinely resets to a query-string-free
// URL — the server-side "no filters" behavior itself was already proven
// correct (pipelineTraceFilterProduction.test.js test 6); this confirms
// the actual rendered link a real tap follows has no leftover params of
// its own that could re-apply a filter the human just tried to clear.
// =======================================================================

test('V1.9.1 — the 清除 link points at the bare path with no query string at all', async () => {
  const kv = createMockKV();
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(adminRequest('/admin/pipeline-trace-view?source=pbs&road=%E5%9C%8B%E9%81%93%E4%B8%89%E8%99%9F', { auth }), env);
  const html = await res.text();
  assert.match(html, /<a class="clear" href="\/admin\/pipeline-trace-view">清除<\/a>/);
});
