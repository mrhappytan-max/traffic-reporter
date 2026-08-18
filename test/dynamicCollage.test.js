// V1.8.5 — src/cctv/dynamicCollage.js: dynamic, per-accident CCTV image
// preparation. No real TDX/R2/network calls anywhere in this file — every
// fetch is mocked, R2/KV are in-memory mocks.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { resolveCctvEligibility, prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const TDX_CLIENT_ID = 'test-tdx-client-id-dynamic';
const TDX_CLIENT_SECRET = 'test-tdx-client-secret-dynamic';

function kv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, _options) {
      store.set(key, value);
    },
  };
}

function r2Bucket({ failPut } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
      if (failPut) throw new Error('R2 write outage');
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { value: bytes, customMetadata: options.customMetadata || {} });
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, async arrayBuffer() { return entry.value.buffer; } };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    TDX_CLIENT_ID,
    TDX_CLIENT_SECRET,
    TRAFFIC_KV: kv(),
    CCTV_IMAGES: r2Bucket(),
    ...overrides,
  };
}

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '82K+000',
    endKM: '82K+200',
    description: '事故',
    ...overrides,
  };
}

function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'S',
    LocationMile: '82K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}

// Two clusters of records, deliberately far apart, so a selector run at
// targetKm=82.1 picks a DIFFERENT camera than one run at targetKm=95.0 —
// this is what test 2 (different KM -> different cameras) checks.
const RECORDS_NEAR_82 = [
  cctvRecord({ CCTVID: 'CCTV-82-S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-s-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-S-AFTER', RoadDirection: 'S', LocationMile: '82K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-s-after.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-N-AFTER', RoadDirection: 'N', LocationMile: '82K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-n-after.jpg' }),
];
const RECORDS_NEAR_95 = [
  cctvRecord({ CCTVID: 'CCTV-95-S-BEFORE', RoadDirection: 'S', LocationMile: '94K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/95-s-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-95-S-AFTER', RoadDirection: 'S', LocationMile: '95K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/95-s-after.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-95-N-AFTER', RoadDirection: 'N', LocationMile: '95K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/95-n-after.jpg' }),
];
const ALL_RECORDS = [...RECORDS_NEAR_82, ...RECORDS_NEAR_95];

async function makeSolidJpeg(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(await encodeJpeg({ data, width, height }, { quality: 80 }));
}

function makeTdxFetch({ cctvRecords = ALL_RECORDS, tokenStatus = 200, cctvStatus = 200, frameJpeg } = {}) {
  const hits = { token: 0, metadata: 0, frame: 0 };
  const fetchFn = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      hits.token += 1;
      if (tokenStatus !== 200) return new Response('unauthorized', { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/CCTV/Freeway')) {
      hits.metadata += 1;
      if (cctvStatus !== 200) return new Response('error', { status: cctvStatus });
      return new Response(JSON.stringify({ CCTVs: cctvRecords }), { status: 200 });
    }
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      if (!frameJpeg) return new Response('not found', { status: 404 });
      return new Response(frameJpeg, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { fetchFn, hits };
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// =======================================================================
// resolveCctvEligibility — pure, zero I/O
// =======================================================================

test('1. an eligible freeway accident with startKM/endKM resolves a DYNAMIC targetKm — not the old hardcoded 82.1', async () => {
  const e1 = resolveCctvEligibility(accidentEvent({ startKM: '95K+000', endKM: '95K+400' }));
  assert.equal(e1.eligible, true);
  assert.equal(e1.targetKm, 95.2); // midpoint of 95.0 and 95.4

  const e2 = resolveCctvEligibility(accidentEvent({ startKM: '30K+000', endKM: '30K+000' }));
  assert.equal(e2.eligible, true);
  assert.equal(e2.targetKm, 30);
  // Never silently defaults to the old fixed 82.1 for an event that
  // plainly reports a different location.
  assert.notEqual(e2.targetKm, 82.1);
});

test('3. road alias mapping: 國道1號/中山高/中山高速公路 all resolve to the same supported road; a genuinely different freeway (國道三號) resolves to a DIFFERENT, unsupported road', async () => {
  for (const roadText of ['國道一號', '國道1號', '中山高', '中山高速公路']) {
    const e = resolveCctvEligibility(accidentEvent({ road: roadText }));
    assert.equal(e.eligible, true, `expected "${roadText}" to resolve as eligible`);
    assert.equal(e.roadKey, '國道一號');
    assert.equal(e.roadShortName, '國1');
  }

  const e3 = resolveCctvEligibility(accidentEvent({ road: '國道三號' }));
  assert.equal(e3.eligible, false);
  assert.equal(e3.reason, 'unsupported-road');
});

test('4. missing KM (no startKM, no endKM) -> ineligible, text only', async () => {
  const e = resolveCctvEligibility(accidentEvent({ startKM: undefined, endKM: undefined }));
  assert.equal(e.eligible, false);
  assert.equal(e.reason, 'no-reliable-km');
});

test('5. unsupported/unresolvable road -> ineligible, text only', async () => {
  const unsupported = resolveCctvEligibility(accidentEvent({ road: '國道三號' }));
  assert.equal(unsupported.eligible, false);
  assert.equal(unsupported.reason, 'unsupported-road');

  const unresolvable = resolveCctvEligibility(accidentEvent({ road: '台61線' }));
  assert.equal(unresolvable.eligible, false);
  assert.equal(unresolvable.reason, 'unresolvable-road');
});

test('non-accident and non-freeway events are never eligible', async () => {
  assert.equal(resolveCctvEligibility(accidentEvent({ type: 'congestion' })).eligible, false);
  assert.equal(resolveCctvEligibility(accidentEvent({ type: 'closure' })).eligible, false);
  assert.equal(resolveCctvEligibility(accidentEvent({ source: 'pbs' })).eligible, false);
  assert.equal(resolveCctvEligibility(accidentEvent({ source: 'highway' })).eligible, false);
});

// =======================================================================
// prepareCctvImageForEvent — full orchestration, mocked network
// =======================================================================

test('2. a different accident KM selects DIFFERENT cameras than a nearby one', async () => {
  const envAt82 = baseEnv();
  const { fetchFn: fetchFn82 } = makeTdxFetch({ frameJpeg: await makeSolidJpeg(80, 60, [10, 20, 30]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn82;
  const result82 = await prepareCctvImageForEvent(envAt82, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result82.ok, true);

  globalThis.fetch = fetchFn82; // same mock, fresh env/runCache
  const envAt95 = baseEnv();
  const result95 = await prepareCctvImageForEvent(envAt95, accidentEvent({ startKM: '95K+000', endKM: '95K+200' }), {}, TEST_CODEC);
  assert.equal(result95.ok, true);

  // Different R2 objects (different opaque ids) — can't directly inspect
  // which CCTVID won without OCR-ing the JPEG, but we CAN confirm the
  // selector actually ran against different candidate pools by checking
  // the underlying selection directly.
  const { selectFourQuadrantCandidates, TARGET_ROAD_ID, TARGET_ROAD_NAME_PATTERN } = await import('../src/tdx/hsinchuCctvProbe.js');
  const at82 = selectFourQuadrantCandidates(ALL_RECORDS, { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, targetKm: 82.1 });
  const at95 = selectFourQuadrantCandidates(ALL_RECORDS, { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, targetKm: 95.2 });
  const idsAt82 = at82.filter(Boolean).map((c) => c.cctvId);
  const idsAt95 = at95.filter(Boolean).map((c) => c.cctvId);
  assert.ok(idsAt82.some((id) => id.startsWith('CCTV-82-')));
  assert.ok(idsAt95.some((id) => id.startsWith('CCTV-95-')));
  assert.notDeepEqual(idsAt82.sort(), idsAt95.sort());
});

test('6. CCTV metadata fetch failure (TDX auth/fetch error) -> prepareCctvImageForEvent fails closed, never throws', async () => {
  const env = baseEnv();
  const { fetchFn } = makeTdxFetch({ tokenStatus: 500 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tdx-auth-failed');
});

test('6b. CCTV metadata HTTP failure -> fails closed with tdx-fetch-failed', async () => {
  const env = baseEnv();
  const { fetchFn } = makeTdxFetch({ cctvStatus: 502 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tdx-fetch-failed');
});

test('7. 0 matching cameras (metadata has none on this road/near this KM) -> no-camera', async () => {
  const env = baseEnv();
  const { fetchFn } = makeTdxFetch({ cctvRecords: [cctvRecord({ RoadID: '999999', RoadName: '省道台1線' })] });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-camera');
});

test('8. cameras found but ALL frame fetches fail -> no-frames, never throws', async () => {
  const env = baseEnv();
  const { fetchFn } = makeTdxFetch({ frameJpeg: undefined }); // every freeway.gov.tw fetch 404s
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-frames');
});

test('9. R2 publish failure -> r2-publish-failed, never throws', async () => {
  const env = baseEnv({ CCTV_IMAGES: r2Bucket({ failPut: true }) });
  const { fetchFn } = makeTdxFetch({ frameJpeg: await makeSolidJpeg(80, 60, [1, 2, 3]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'r2-publish-failed');
});

test('9b. missing CCTV_IMAGES (R2) binding -> fails closed, 0 TDX calls (checked before composing)', async () => {
  const env = baseEnv({ CCTV_IMAGES: undefined });
  const { fetchFn, hits } = makeTdxFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-r2-binding');
  assert.equal(hits.metadata, 0);
  assert.equal(hits.token, 0);
});

// =======================================================================
// shared metadata cache: cache hit = 0 TDX; N accidents this run = <=1 TDX
// =======================================================================

test('metadata cache hit -> 0 TDX CCTV metadata calls', async () => {
  const env = baseEnv({
    TRAFFIC_KV: kv({ 'cctv:freeway-metadata:v1': JSON.stringify({ records: ALL_RECORDS, fetchedAt: new Date().toISOString() }) }),
  });
  const { fetchFn, hits } = makeTdxFetch({ frameJpeg: await makeSolidJpeg(80, 60, [4, 5, 6]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result.ok, true);
  assert.equal(hits.metadata, 0);
  assert.equal(hits.token, 0);
});

test('metadata cache miss populates the cache -> at most 1 TDX CCTV metadata call for a whole run, shared via runCache across multiple accidents', async () => {
  const env = baseEnv();
  const { fetchFn, hits } = makeTdxFetch({ frameJpeg: await makeSolidJpeg(80, 60, [7, 8, 9]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const runCache = {}; // ONE shared cache across "this tick's" accidents
  const [r1, r2, r3] = await Promise.all([
    prepareCctvImageForEvent(env, accidentEvent({ rawId: 'A1', startKM: '82K+000', endKM: '82K+200' }), runCache, TEST_CODEC),
    prepareCctvImageForEvent(env, accidentEvent({ rawId: 'A2', startKM: '95K+000', endKM: '95K+200' }), runCache, TEST_CODEC),
    prepareCctvImageForEvent(env, accidentEvent({ rawId: 'A3', startKM: '82K+000', endKM: '82K+200' }), runCache, TEST_CODEC),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(hits.metadata, 1, `expected exactly 1 shared TDX CCTV metadata call for 3 accidents this run, got ${hits.metadata}`);

  // And it was cached to KV for the NEXT run/tick to hit.
  const cached = env.TRAFFIC_KV.store.get('cctv:freeway-metadata:v1');
  assert.ok(cached);
});
