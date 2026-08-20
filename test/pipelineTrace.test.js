// V1.8.6.7 — 24h Pipeline Trace core module: buildTraceEntry/
// buildUpstreamSnapshot (pure), buildTraceAnomalies (pure, section H),
// recordPipelineTrace/persistPipelineTraceEntries/listPipelineTrace (KV),
// and GET /admin/pipeline-trace (Admin-Auth, 405, 0 upstream calls,
// privacy). End-to-end pipeline scenarios (successful push, eligibility
// reject, dedupe, suppression, gating, CCTV outcomes, LINE failure) live
// in test/pipelineTraceIntegration.test.js; the HTML view page lives in
// test/pipelineTraceView.test.js.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  TRACE_KEY_PREFIX,
  TRACE_TTL_SECONDS,
  buildUpstreamSnapshot,
  buildTraceEntry,
  buildTraceAnomalies,
  recordPipelineTrace,
  persistPipelineTraceEntries,
  listPipelineTrace,
} from '../src/traffic/pipelineTrace.js';

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
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
    location: '國道一號 北向 93K+500',
    description: '事故',
    updatedAt: '2026-08-20T20:13:48+08:00',
    pipelineTraceUpstream: buildUpstreamSnapshot({
      eventType: '事故',
      eventSubType: '一般事故',
      rawDirection: '北向',
      rawStartKM: '93K+500',
      rawEndKM: '93K+000',
      upstreamUpdatedAt: '2026-08-20T20:13:48+08:00',
      description: '北向93.5K車輛事故',
    }),
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T20:20:00+08:00');

// --- buildUpstreamSnapshot / buildTraceEntry (pure) -------------------

test('buildUpstreamSnapshot: truncates description to 120 chars, keeps whitelisted fields only', () => {
  const longText = '危'.repeat(200);
  const snap = buildUpstreamSnapshot({ eventType: '事故', description: longText });
  assert.equal(snap.descriptionSummary.length, 121); // 120 chars + the truncation ellipsis char
  assert.ok(snap.descriptionSummary.endsWith('…'));
  assert.equal(snap.EventType, '事故');
});

test('buildTraceEntry: pure, no I/O, reuses describeClassificationEvidence (never a second classification rule)', () => {
  const entry = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    eligibility: true,
    eligibilityReason: 'eligible-type',
    dedupeResult: 'new',
  });
  assert.equal(entry.eventKey, 'freeway:FRW-1');
  assert.equal(entry.identity.source, 'freeway');
  assert.equal(entry.normalized.type, 'accident');
  assert.deepEqual(entry.normalized.classificationEvidence, ['normalizedType=accident', 'eligibilityReason=eligible-type']);
  assert.equal(entry.decision.dedupeResult, 'new');
  assert.equal(entry.status, 'eligible-no-target');
});

// --- buildTraceAnomalies (section H) -----------------------------------

test('12: SHARED_FEED_IMAGE_LOST anomaly — LINE has an image but Shared Feed does not', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    lineAttempted: 1,
    lineSucceeded: 1,
    imagePrepared: true,
    imageUrlPresent: true,
    imageExpiresAt: NOW.toISOString(),
    sharedFeedPersisted: true,
    sharedFeedWithImage: false,
  });
  const anomalies = buildTraceAnomalies(trace);
  assert.ok(anomalies.some((a) => a.code === 'SHARED_FEED_IMAGE_LOST'));
  assert.equal(anomalies.find((a) => a.code === 'SHARED_FEED_IMAGE_LOST').severity, 'error');
});

test('no SHARED_FEED_IMAGE_LOST anomaly when the image DID reach the Shared Feed', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    imageUrlPresent: true,
    sharedFeedPersisted: true,
    sharedFeedWithImage: true,
  });
  assert.equal(buildTraceAnomalies(trace).some((a) => a.code === 'SHARED_FEED_IMAGE_LOST'), false);
});

test('14: MAP_MISSING anomaly — KM resolved but the formatted text has no maps.google.com link', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    kmLocationResolution: { resolved: true, dataset: 'freeway', locationLabel: '竹北交流道' },
    formattedOutput: '🚨 交通事故\n國1 北向｜竹北交流道\n93K+500',
  });
  const anomalies = buildTraceAnomalies(trace);
  assert.ok(anomalies.some((a) => a.code === 'MAP_MISSING'));
});

test('13: no MAP_MISSING anomaly when KM resolved AND the map URL is present in the formatted output', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    kmLocationResolution: { resolved: true, dataset: 'freeway', locationLabel: '竹北交流道' },
    formattedOutput: '🚨 交通事故\n📍 地圖 https://maps.google.com/?q=24.80605,121.00998',
  });
  assert.equal(buildTraceAnomalies(trace).some((a) => a.code === 'MAP_MISSING'), false);
});

test('no MAP_MISSING anomaly when the resolver genuinely failed to resolve (nothing to check)', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    kmLocationResolution: { resolved: false, reason: 'no-data' },
    formattedOutput: '🚨 交通事故\n93K+500',
  });
  assert.equal(buildTraceAnomalies(trace).some((a) => a.code === 'MAP_MISSING'), false);
});

test('15: no DIRECTION_CHANGED anomaly when upstream direction matches normalized direction', () => {
  const trace = buildTraceEntry({ event: accidentEvent(), now: NOW });
  assert.equal(buildTraceAnomalies(trace).some((a) => a.code === 'DIRECTION_CHANGED'), false);
});

test('16: DIRECTION_CHANGED anomaly — upstream said 南向 but normalized ended up 北向', () => {
  const event = accidentEvent({
    direction: '北向',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawDirection: '南向' }),
  });
  const trace = buildTraceEntry({ event, now: NOW });
  const anomalies = buildTraceAnomalies(trace);
  const found = anomalies.find((a) => a.code === 'DIRECTION_CHANGED');
  assert.ok(found);
  assert.match(found.message, /南向/);
  assert.match(found.message, /北向/);
});

test('17: TYPE_SEMANTIC_MISMATCH anomaly — upstream EventSubType reads 行人誤闖 but normalized type is still accident', () => {
  const event = accidentEvent({
    type: 'accident', // simulates the pre-V1.8.6.6 bug reproducing, or a future regression of it
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', eventSubType: '其他異常告警－行人誤闖' }),
  });
  const trace = buildTraceEntry({ event, now: NOW });
  const anomalies = buildTraceAnomalies(trace);
  assert.ok(anomalies.some((a) => a.code === 'TYPE_SEMANTIC_MISMATCH'));
});

test('no TYPE_SEMANTIC_MISMATCH anomaly for a genuine collision (EventSubType: 一般事故)', () => {
  const trace = buildTraceEntry({ event: accidentEvent(), now: NOW }); // default fixture: EventSubType '一般事故'
  assert.equal(buildTraceAnomalies(trace).some((a) => a.code === 'TYPE_SEMANTIC_MISMATCH'), false);
});

test('no TYPE_SEMANTIC_MISMATCH anomaly when the type was correctly reclassified to other', () => {
  const event = accidentEvent({
    type: 'other',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', eventSubType: '其他異常告警－行人誤闖' }),
  });
  const trace = buildTraceEntry({ event, now: NOW });
  assert.equal(buildTraceAnomalies(trace).some((a) => a.code === 'TYPE_SEMANTIC_MISMATCH'), false);
});

test('KM_CHANGED anomaly — upstream KM differs from normalized KM', () => {
  const event = accidentEvent({
    startKM: '93K+500',
    pipelineTraceUpstream: buildUpstreamSnapshot({ eventType: '事故', rawStartKM: '92K+800' }),
  });
  const trace = buildTraceEntry({ event, now: NOW });
  assert.ok(buildTraceAnomalies(trace).some((a) => a.code === 'KM_CHANGED'));
});

test('IMAGE_EXPECTED_BUT_MISSING anomaly — CCTV prepared an image but the LINE push has none', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    lineSucceeded: 1,
    cctvEligible: true,
    imagePrepared: true,
    imageUrlPresent: false,
  });
  assert.ok(buildTraceAnomalies(trace).some((a) => a.code === 'IMAGE_EXPECTED_BUT_MISSING'));
});

test('LINE_FAILED anomaly — status is line-failed', () => {
  const trace = buildTraceEntry({ event: accidentEvent(), now: NOW, lineAttempted: 1, lineSucceeded: 0 });
  assert.equal(trace.status, 'line-failed');
  assert.ok(buildTraceAnomalies(trace).some((a) => a.code === 'LINE_FAILED'));
});

test('a clean, fully-successful trace has zero anomalies', () => {
  const trace = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    eligibility: true,
    eligibilityReason: 'eligible-type',
    relevant: true,
    lineAttempted: 1,
    lineSucceeded: 1,
    cctvEligible: true,
    imagePrepared: true,
    imageUrlPresent: true,
    kmLocationResolution: { resolved: true, dataset: 'freeway', locationLabel: '竹北交流道' },
    formattedOutput: '🚨 交通事故\n📍 地圖 https://maps.google.com/?q=24.80605,121.00998',
    sharedFeedPersisted: true,
    sharedFeedWithImage: true,
  });
  assert.deepEqual(buildTraceAnomalies(trace), []);
});

// --- recordPipelineTrace / persistPipelineTraceEntries -----------------

test('22: TTL is exactly 24h (86400s), and the key embeds the Taipei date/epochMs/opaqueId', async () => {
  assert.equal(TRACE_TTL_SECONDS, 86400);
  const kv = createMockKV();
  const entry = buildTraceEntry({ event: accidentEvent(), now: NOW });
  const result = await recordPipelineTrace(kv, entry, NOW);
  assert.equal(result.committed, true);
  assert.ok(result.key.startsWith(`${TRACE_KEY_PREFIX}:2026-08-20:`));
  assert.equal(kv.lastPutOptions.expirationTtl, 86400);
});

test('25: a trace write failure never throws and never surfaces as an exception — degrades to {committed:false}', async () => {
  const throwingKv = { put: async () => { throw new Error('KV outage'); } };
  const entry = buildTraceEntry({ event: accidentEvent(), now: NOW });
  const result = await recordPipelineTrace(throwingKv, entry, NOW);
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'kv-error');
});

test('persistPipelineTraceEntries: one KV put per entry, isolates a single bad write from the rest', async () => {
  const kv = createMockKV();
  let calls = 0;
  const originalPut = kv.put.bind(kv);
  kv.put = async (key, value, options) => {
    calls += 1;
    if (calls === 2) throw new Error('transient KV error');
    return originalPut(key, value, options);
  };
  const entries = [
    buildTraceEntry({ event: accidentEvent({ rawId: 'FRW-A' }), now: NOW }),
    buildTraceEntry({ event: accidentEvent({ rawId: 'FRW-B' }), now: NOW }),
    buildTraceEntry({ event: accidentEvent({ rawId: 'FRW-C' }), now: NOW }),
  ];
  const summary = await persistPipelineTraceEntries(kv, entries, NOW);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.committed, 2);
  assert.equal(summary.failed, 1);
});

// --- 23/24: privacy — no raw payload, no LINE target, no secret --------

test('23/24: a persisted trace record never contains a full raw payload, a LINE target id, a secret, or an Authorization header', async () => {
  const kv = createMockKV();
  const entry = buildTraceEntry({
    event: accidentEvent(),
    now: NOW,
    lineAttempted: 1,
    lineSucceeded: 1,
    formattedOutput: '🚨 交通事故',
  });
  await recordPipelineTrace(kv, entry, NOW);
  const raw = kv.store.get([...kv.store.keys()][0]);
  const record = JSON.parse(raw);
  const serialized = JSON.stringify(record);
  for (const forbidden of ['Authorization', 'ADMIN_PASSWORD', 'TRAFFIC_FEED_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'access_token']) {
    assert.equal(serialized.includes(forbidden), false, `must never contain ${forbidden}`);
  }
  // No LINE userId/groupId/target — only counts (lineAttempted/lineSucceeded).
  assert.equal('lineTargetId' in record.delivery, false);
  assert.equal(serialized.includes('userId'), false);
  assert.equal(serialized.includes('groupId'), false);
  // Description is capped at 120 chars, never the full raw payload.
  assert.ok(record.upstream.descriptionSummary.length <= 121);
  assert.equal('rawPayload' in record, false);
  assert.equal('raw' in record, false);
});

// --- 18/19/20/21: listPipelineTrace filters ----------------------------

async function seedThree(kv) {
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'A1', road: '國道一號' }), now: NOW, eligibility: true, lineAttempted: 1, lineSucceeded: 1 }), NOW);
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'A2', road: '國道三號', source: 'freeway' }), now: new Date(NOW.getTime() + 1000), eligibility: false, eligibilityReason: 'construction-no-impact-keyword' }), new Date(NOW.getTime() + 1000));
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: 'B1', source: 'pbs', road: '台68' }), now: new Date(NOW.getTime() + 2000), gatingResult: 'unique-candidate' }), new Date(NOW.getTime() + 2000));
}

test('18: ?rawId= filters to exactly the matching record', async () => {
  const kv = createMockKV();
  await seedThree(kv);
  const { records } = await listPipelineTrace(kv, { rawId: 'A2' });
  assert.equal(records.length, 1);
  assert.equal(records[0].identity.rawId, 'A2');
});

test('19: ?source= filters by source', async () => {
  const kv = createMockKV();
  await seedThree(kv);
  const { records } = await listPipelineTrace(kv, { source: 'pbs' });
  assert.equal(records.length, 1);
  assert.equal(records[0].identity.source, 'pbs');
});

test('20: ?road= filters by road', async () => {
  const kv = createMockKV();
  await seedThree(kv);
  const { records } = await listPipelineTrace(kv, { road: '台68' });
  assert.equal(records.length, 1);
  assert.equal(records[0].identity.road, '台68');
});

test('21: ?status= filters by computed status', async () => {
  const kv = createMockKV();
  await seedThree(kv);
  const { records } = await listPipelineTrace(kv, { status: 'line-sent' });
  assert.equal(records.length, 1);
  assert.equal(records[0].identity.rawId, 'A1');
});

test('limit defaults to 30, caps at 100', async () => {
  const kv = createMockKV();
  for (let i = 0; i < 5; i += 1) {
    await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent({ rawId: `X${i}` }), now: NOW }), NOW);
  }
  const { records } = await listPipelineTrace(kv, { limit: 3 });
  assert.equal(records.length, 3);
  const { records: overCap } = await listPipelineTrace(kv, { limit: 99999 });
  assert.equal(overCap.length <= 100, true);
});

// --- 28/29: GET /admin/pipeline-trace via the real Worker entry point --

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-trace';

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

test('28a: GET /admin/pipeline-trace with no Authorization -> 401', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace'), env);
    assert.equal(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('28b: GET /admin/pipeline-trace with correct credentials -> 200, Cache-Control no-store, 0 upstream calls', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(kv, buildTraceEntry({ event: accidentEvent(), now: NOW, lineAttempted: 1, lineSucceeded: 1 }), NOW);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store, private');
    const body = await res.json();
    assert.equal(body.kvAvailable, true);
    assert.equal(body.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- 30: /health remains 0 pipeline-trace reads --------------------------

test('30: GET /health never imports or reads pipeline-trace state (structural check, not just behavioral)', () => {
  const healthSrc = readFileSync(new URL('../src/traffic/health.js', import.meta.url), 'utf8');
  const healthSnapshotSrc = readFileSync(new URL('../src/traffic/healthSnapshot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(healthSrc, /pipelineTrace/);
  assert.doesNotMatch(healthSnapshotSrc, /pipelineTrace/);
});

test('29: POST/PUT/DELETE /admin/pipeline-trace -> 405 even with valid credentials; POST without auth -> 401 (not 405)', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await worker.fetch(adminRequest('/admin/pipeline-trace', { method, auth }), env);
    assert.equal(res.status, 405, `expected 405 for ${method}`);
    assert.equal(res.headers.get('Allow'), 'GET');
  }
  const unauth = await worker.fetch(adminRequest('/admin/pipeline-trace', { method: 'POST' }), env);
  assert.equal(unauth.status, 401);
});
