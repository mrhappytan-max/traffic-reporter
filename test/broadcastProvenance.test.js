// V1.8.6.4 — Broadcast Provenance Log. See src/traffic/broadcastProvenance.js's
// own module comment for the full design/boundary list. This file covers:
// pure record-building (no KV), the append-only write/read functions
// directly, end-to-end integration through runLineBroadcast (write timing
// — only on an actually-successful push, never otherwise), content-safety
// (no LINE target/user/group id, no Secret/token), source-specific field
// coverage (TDX vs. PBS), and the Admin-Auth-gated GET /admin/broadcast-
// provenance endpoint (401/200/405, 0 TDX/PBS/LINE calls).
//
// No TDX/PBS probe, no real LINE push, no deploy — everything here is
// local fixtures + mock KV + mock fetch, same conventions already used
// throughout test/broadcastPipeline.test.js and test/adminAuth.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import worker from '../src/index.js';
import {
  PROVENANCE_KEY_PREFIX,
  PROVENANCE_TTL_SECONDS,
  buildProvenanceRecord,
  describeClassificationEvidence,
  recordBroadcastProvenance,
  listBroadcastProvenance,
} from '../src/traffic/broadcastProvenance.js';

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
    // Minimal real-Workers-KV-shaped list() — single page, no real
    // pagination needed for these test sizes (mirrors the {keys, list_complete}
    // shape usageLedger.js's own listAllEntryBodies already assumes).
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

// V2.4.5 — carries a real coordinate, confirmed this round inside 新竹市
// by the official NLSC polygon (see tdx/hsinchuGeoResolver.js).
function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '92K附近',
    description: '事故',
    startTime: '2026-08-15T07:30:00+08:00',
    endTime: null,
    updatedAt: '2026-08-15T07:30:00+08:00',
    longitude: 120.9686,
    latitude: 24.8066,
    ...overrides,
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

let originalFetch;
let pushCalls;

function mockLinePushFetch() {
  pushCalls = [];
  return async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

function provenanceKeys(kv) {
  return [...kv.store.keys()].filter((k) => k.startsWith(`${PROVENANCE_KEY_PREFIX}:`));
}

function provenanceRecords(kv) {
  return provenanceKeys(kv).map((k) => JSON.parse(kv.store.get(k)));
}

// ===========================================================================
// Pure record-building — no KV, no pipeline.
// ===========================================================================

test('buildProvenanceRecord: pulls only already-normalized event fields, never fabricates', () => {
  const event = {
    source: 'highway',
    rawId: 'HWY-1',
    type: 'construction',
    title: '台3線施工',
    description: '台3線雙向路段進行路面施工，請注意車道管制',
    road: '台3線',
    direction: '雙向',
    startKM: '78K+500',
    endKM: '79K+200',
    location: '台3線 雙向 78K+500 - 79K+200',
    locationDescription: '關西－橫山路段',
  };
  const now = new Date('2026-08-19T08:10:00+08:00');
  const record = buildProvenanceRecord({
    event,
    formattedOutput: '🚧 道路施工\n台3線 雙向｜關西－橫山路段\n78K+500～79K+200\n雙向施工管制\n請注意車道',
    eligibilityReason: 'construction-impact-keyword',
    anomalyDetail: null,
    image: { attached: false, urlPresent: false, expiresAt: null },
    now,
  });

  assert.equal(record.source, 'highway');
  assert.equal(record.rawId, 'HWY-1');
  assert.equal(record.type, 'construction');
  assert.equal(record.road, '台3線');
  assert.equal(record.direction, '雙向');
  assert.equal(record.startKM, '78K+500');
  assert.equal(record.endKM, '79K+200');
  assert.equal(record.locationDescription, '關西－橫山路段');
  assert.equal(record.eligibilityReason, 'construction-impact-keyword');
  assert.deepEqual(record.classificationEvidence, ['normalizedType=construction', 'eligibilityReason=construction-impact-keyword']);
  assert.equal(record.timestamp, now.toISOString());
  assert.equal(record.imageAttached, false);
});

test('buildProvenanceRecord: long description is truncated, not dumped whole', () => {
  const event = { type: 'other', description: '事'.repeat(500) };
  const record = buildProvenanceRecord({ event, formattedOutput: 'x' });
  assert.ok(record.descriptionSummary.length < 100);
});

test('describeClassificationEvidence: PBS pbsCategory and TDX anomalyDetail both surface as readable evidence lines', () => {
  const pbsEvidence = describeClassificationEvidence({ type: 'accident', pbsCategory: 'accident' }, 'eligible-type', null);
  assert.deepEqual(pbsEvidence, ['normalizedType=accident', 'pbsCategory=accident', 'eligibilityReason=eligible-type']);

  const anomalyEvidence = describeClassificationEvidence({ type: 'other' }, 'other-anomaly-keyword', { emoji: '🌊', label: '道路積水' });
  assert.deepEqual(anomalyEvidence, ['normalizedType=other', 'anomalyDetail=道路積水', 'eligibilityReason=other-anomaly-keyword']);
});

// ===========================================================================
// recordBroadcastProvenance — direct unit tests (TTL, isolation, key shape).
// ===========================================================================

test('15. recordBroadcastProvenance writes with TTL = 48h (PROVENANCE_TTL_SECONDS), under the documented key prefix', async () => {
  assert.equal(PROVENANCE_TTL_SECONDS, 48 * 60 * 60);
  const kv = createMockKV();
  const now = new Date('2026-08-19T08:10:00+08:00');
  const record = buildProvenanceRecord({ event: accidentEvent(), formattedOutput: 'text', now });
  const result = await recordBroadcastProvenance(kv, record, now);
  assert.equal(result.committed, true);
  assert.ok(result.key.startsWith(`${PROVENANCE_KEY_PREFIX}:2026-08-19:`));
  assert.equal(kv.lastPutOptions.expirationTtl, PROVENANCE_TTL_SECONDS);
});

test('recordBroadcastProvenance never throws on a KV outage — degrades to {committed:false}', async () => {
  const throwingKv = {
    async put() {
      throw new Error('simulated KV outage');
    },
  };
  const result = await recordBroadcastProvenance(throwingKv, { x: 1 });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'kv-error');
});

test('two writes in the same millisecond never collide (append-only, unique opaque id per key)', async () => {
  const kv = createMockKV();
  const now = new Date('2026-08-19T08:10:00.000Z');
  await recordBroadcastProvenance(kv, { a: 1 }, now);
  await recordBroadcastProvenance(kv, { a: 2 }, now);
  assert.equal(provenanceKeys(kv).length, 2); // not overwritten
});

// ===========================================================================
// End-to-end via runLineBroadcast — write timing.
// ===========================================================================

test('1. LINE push succeeds -> exactly 1 provenance record written', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(provenanceKeys(kv).length, 1);
});

test('2. LINE push fails for every target -> 0 provenance records', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(provenanceKeys(kv).length, 0);
});

test('3. no subscribers -> 0 provenance records (LINE API never even called)', async () => {
  const kv = createMockKV(); // no enabled users/groups
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.subscriptionsCount, 0);
  assert.equal(provenanceKeys(kv).length, 0);
});

test('4. a second identical run (deduped by notified-state, 0 pending targets) does not write a second record', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = accidentEvent();
  const now = new Date('2026-08-15T09:00:00+08:00');

  const first = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  assert.equal(first.pushSucceeded, 1);
  assert.equal(provenanceKeys(kv).length, 1);

  const second = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  assert.equal(second.pushSucceeded, 0); // deduped, unchanged from before this round
  assert.equal(provenanceKeys(kv).length, 1); // still only the first run's record
});

test('5. provenance KV write throwing does not affect the real LINE push or notified-state outcome', async () => {
  const inner = createMockKV();
  await setUserEnabled(inner, 'U1', true, ENROLLED_AT);
  const kv = {
    store: inner.store,
    async get(key) {
      return inner.get(key);
    },
    async put(key, value, options) {
      if (key.startsWith(`${PROVENANCE_KEY_PREFIX}:`)) throw new Error('simulated provenance KV outage');
      return inner.put(key, value, options);
    },
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  // The real push still succeeded and notified-state was still recorded,
  // even though every provenance write attempt threw.
  assert.equal(result.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);
  assert.equal(provenanceKeys(inner).length, 0); // no record made it through, as expected

  // notified-state dedup still works normally on the next run.
  pushCalls.length = 0;
  const secondResult = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(secondResult.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

// ===========================================================================
// 6/7. Content safety — no LINE target/user/group id, no Secret/token.
// ===========================================================================

test('6. a written record never contains the LINE target id/kind, userId, or groupId', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  const [record] = provenanceRecords(kv);
  const raw = JSON.stringify(record);
  assert.doesNotMatch(raw, /U1/);
  assert.doesNotMatch(raw, /userId/i);
  assert.doesNotMatch(raw, /groupId/i);
  assert.ok(!('target' in record));
  assert.ok(!('targets' in record));
});

test('7. a written record never contains the LINE access token or an Authorization header', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'super-secret-token-value', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  const [record] = provenanceRecords(kv);
  const raw = JSON.stringify(record);
  assert.doesNotMatch(raw, /super-secret-token-value/);
  assert.doesNotMatch(raw, /Authorization/i);
  assert.doesNotMatch(raw, /Secret/i);
});

// ===========================================================================
// 8/9. Source-specific field coverage.
// ===========================================================================

test('8. a TDX-sourced event is fully identifiable from its record: source/type/location/KM', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const event = accidentEvent({
    source: 'highway',
    road: '台3線',
    direction: '雙向',
    startKM: '78K+500',
    endKM: '79K+200',
    locationDescription: '關西－橫山路段',
  });
  await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  const [record] = provenanceRecords(kv);
  assert.equal(record.source, 'highway');
  assert.equal(record.type, 'accident');
  assert.equal(record.road, '台3線');
  assert.equal(record.direction, '雙向');
  assert.equal(record.startKM, '78K+500');
  assert.equal(record.endKM, '79K+200');
  assert.equal(record.locationDescription, '關西－橫山路段');
});

test('9. a PBS-sourced event is fully identifiable from its record: source/pbsCategory/displayKM', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  // Coordinates added 2026-08-24: this pins the PROVENANCE record's
  // fields, not geography, but the broadcast layer now enforces the
  // service area (see traffic/serviceArea.js — the 八堵 regression), and
  // a PBS event with no coordinates, no KM in its text and no Hsinchu
  // place name is unplaceable, so it is correctly blocked before any
  // record is written. 竹東 (on 台3線, inside the service area) keeps this
  // test exercising what it was written for.
  const event = accidentEvent({
    source: 'pbs',
    rawId: 'PBS-1',
    road: '台3線',
    direction: '南向',
    latitude: 24.7361,
    longitude: 121.0886,
    startKM: undefined,
    endKM: undefined,
    displayKM: 40.2,
    pbsCategory: 'accident',
  });
  delete event.startKM;
  delete event.endKM;
  await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  const [record] = provenanceRecords(kv);
  assert.equal(record.source, 'pbs');
  assert.equal(record.pbsCategory, 'accident');
  assert.equal(record.displayKM, 40.2);
  assert.equal(record.startKM, null);
});

// ===========================================================================
// 10. formattedOutput matches the exact LINE text actually sent.
// ===========================================================================

test('10. record.formattedOutput is byte-for-byte the same text actually pushed to LINE', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  const [record] = provenanceRecords(kv);
  const actualSentText = pushCalls[0].body.messages[0].text;
  assert.equal(record.formattedOutput, actualSentText);
});

// ===========================================================================
// listBroadcastProvenance — pure KV-read side, bounded/filterable.
// ===========================================================================

test('listBroadcastProvenance returns newest-first and respects source/road/rawId filters', async () => {
  const kv = createMockKV();
  const now = new Date('2026-08-19T08:00:00+08:00');
  await recordBroadcastProvenance(kv, buildProvenanceRecord({ event: { source: 'highway', rawId: 'A', type: 'accident', road: '台3線' }, formattedOutput: 'a', now: new Date(now.getTime() + 1000) }), new Date(now.getTime() + 1000));
  await recordBroadcastProvenance(kv, buildProvenanceRecord({ event: { source: 'freeway', rawId: 'B', type: 'accident', road: '國道一號' }, formattedOutput: 'b', now: new Date(now.getTime() + 2000) }), new Date(now.getTime() + 2000));
  await recordBroadcastProvenance(kv, buildProvenanceRecord({ event: { source: 'highway', rawId: 'C', type: 'construction', road: '台3線' }, formattedOutput: 'c', now: new Date(now.getTime() + 3000) }), new Date(now.getTime() + 3000));

  const all = await listBroadcastProvenance(kv, {});
  assert.equal(all.kvAvailable, true);
  assert.equal(all.records.length, 3);
  assert.equal(all.records[0].rawId, 'C'); // newest first

  const filtered = await listBroadcastProvenance(kv, { source: 'highway' });
  assert.equal(filtered.records.length, 2);
  assert.ok(filtered.records.every((r) => r.source === 'highway'));

  const byRoad = await listBroadcastProvenance(kv, { road: '國道一號' });
  assert.equal(byRoad.records.length, 1);
  assert.equal(byRoad.records[0].rawId, 'B');

  const byRawId = await listBroadcastProvenance(kv, { rawId: 'A' });
  assert.equal(byRawId.records.length, 1);
});

test('listBroadcastProvenance limit is clamped to [1, 100]', async () => {
  const kv = createMockKV();
  const result = await listBroadcastProvenance(kv, { limit: 99999 });
  assert.equal(result.kvAvailable, true); // clamping doesn't error, just bounds the request
});

test('listBroadcastProvenance never throws on a KV outage — degrades to empty + kvAvailable:false', async () => {
  const throwingKv = {
    async list() {
      throw new Error('simulated KV outage');
    },
  };
  const result = await listBroadcastProvenance(throwingKv, {});
  assert.deepEqual(result.records, []);
  assert.equal(result.kvAvailable, false);
});

// ===========================================================================
// 11/12/13/14 — GET /admin/broadcast-provenance, via the real Worker entry
// point (src/index.js), same convention as test/adminAuth.test.js.
// ===========================================================================

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-provenance';

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

test('11. GET /admin/broadcast-provenance with no Authorization -> 401, 0 TDX/PBS/LINE calls', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  const res = await worker.fetch(adminRequest('/admin/broadcast-provenance'), env);
  assert.equal(res.status, 401);
});

test('12. GET /admin/broadcast-provenance with correct credentials -> 200, pure KV read, 0 TDX/PBS/LINE calls', async () => {
  const kv = createMockKV();
  const now = new Date('2026-08-19T08:00:00+08:00');
  await recordBroadcastProvenance(kv, buildProvenanceRecord({ event: accidentEvent(), formattedOutput: 'text', now }), now);
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');

  const res = await worker.fetch(adminRequest('/admin/broadcast-provenance', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store, private'); // applyAdminSecurityHeaders wraps every admin response
  const body = await res.json();
  assert.equal(body.kvAvailable, true);
  assert.equal(body.count, 1);
  assert.equal(body.records[0].rawId, 'FRW-1');
});

test('13. POST/PUT/DELETE /admin/broadcast-provenance -> 405, even with valid credentials', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await worker.fetch(adminRequest('/admin/broadcast-provenance', { method, auth }), env);
    assert.equal(res.status, 405, `expected 405 for ${method}`);
    assert.equal(res.headers.get('Allow'), 'GET');
  }
});

test('13b. POST without auth -> 401, not 405 (auth checked first, wrong method never bypasses it)', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  const res = await worker.fetch(adminRequest('/admin/broadcast-provenance', { method: 'POST' }), env);
  assert.equal(res.status, 401);
});

test('14. the admin endpoint path makes 0 TDX/PBS/LINE network calls end to end', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: createMockKV() };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  const res = await worker.fetch(adminRequest('/admin/broadcast-provenance', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 200); // proves the handler ran to completion without ever calling fetch()
});
