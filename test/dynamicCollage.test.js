// V1.8.5 — src/cctv/dynamicCollage.js: dynamic, per-accident CCTV image
// preparation. No real TDX/R2/network calls anywhere in this file — every
// fetch is mocked, R2/KV are in-memory mocks.
//
// CORRECTION (post-review, two Production blockers fixed):
//   1. The broadcast-facing metadata path is now CACHE-ONLY — it must
//      NEVER call TDX itself (enforced structurally: this module no
//      longer imports anything TDX-related at all). A cache miss/expiry
//      is 'metadata-cache-unavailable', not a TDX call.
//   2. prepareCctvImageForEvent now has a hard time budget
//      (CCTV_PREPARE_BUDGET_MS, overridable per-call for tests) — an
//      overrun resolves 'prepare-timeout', not an indefinite wait.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { resolveCctvEligibility, prepareCctvImageForEvent, CCTV_PREPARE_BUDGET_MS } from '../src/cctv/dynamicCollage.js';
import { FREEWAY_METADATA_KEY, FREEWAY_METADATA_TTL_SECONDS } from '../src/cctv/freewayCctvMetadataCache.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

function kv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options = {}) {
      store.set(key, value);
      this.lastPutOptions = options;
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

function metadataEnvelope(records) {
  return JSON.stringify({ records, fetchedAt: new Date().toISOString() });
}

function baseEnv(overrides = {}) {
  return {
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

/** freeway.gov.tw frame fetches only — this module must NEVER call TDX at all, so any TDX-looking URL here is a bug and throws loudly. */
function makeFrameFetch({ frameJpeg } = {}) {
  const hits = { frame: 0, other: 0 };
  const fetchFn = async (url) => {
    const href = String(url);
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      if (!frameJpeg) return new Response('not found', { status: 404 });
      return new Response(frameJpeg, { status: 200 });
    }
    hits.other += 1;
    throw new Error(`unexpected non-freeway.gov.tw fetch in test (this module must never call TDX): ${href}`);
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
// prepareCctvImageForEvent — full orchestration, mocked network, cache-only metadata
// =======================================================================

test('2. a different accident KM selects DIFFERENT cameras than a nearby one', async () => {
  const envAt82 = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [10, 20, 30]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const result82 = await prepareCctvImageForEvent(envAt82, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result82.ok, true);

  const envAt95 = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const result95 = await prepareCctvImageForEvent(envAt95, accidentEvent({ startKM: '95K+000', endKM: '95K+200' }), {}, TEST_CODEC);
  assert.equal(result95.ok, true);

  const { selectFourQuadrantCandidates, TARGET_ROAD_ID, TARGET_ROAD_NAME_PATTERN } = await import('../src/tdx/hsinchuCctvProbe.js');
  const at82 = selectFourQuadrantCandidates(ALL_RECORDS, { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, targetKm: 82.1 });
  const at95 = selectFourQuadrantCandidates(ALL_RECORDS, { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, targetKm: 95.2 });
  const idsAt82 = at82.filter(Boolean).map((c) => c.cctvId);
  const idsAt95 = at95.filter(Boolean).map((c) => c.cctvId);
  assert.ok(idsAt82.some((id) => id.startsWith('CCTV-82-')));
  assert.ok(idsAt95.some((id) => id.startsWith('CCTV-95-')));
  assert.notDeepEqual(idsAt82.sort(), idsAt95.sort());
});

test('6/1-required: broadcast metadata cache MISS -> text-only (metadata-cache-unavailable), 0 TDX CCTV metadata calls, never falls back to calling TDX', async () => {
  const env = baseEnv(); // no cctv:freeway-metadata:v1 key seeded at all
  const { fetchFn, hits } = makeFrameFetch(); // any fetch at all in this test is unexpected
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'metadata-cache-unavailable');
  assert.equal(hits.frame, 0);
  assert.equal(hits.other, 0, '0 fetch calls of any kind — this module must never call TDX itself');
});

test('6b. an EXPIRED/corrupt cache entry is treated the same as a miss -> metadata-cache-unavailable', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: 'not valid json' }) });
  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'metadata-cache-unavailable');
});

test('2-required: broadcast metadata cache HIT -> CCTV proceeds normally', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const { fetchFn, hits } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [1, 2, 3]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result.ok, true);
  assert.match(result.imageUrl, /^https:\/\//);
  assert.ok(hits.frame > 0);
});

test('7. 0 matching cameras (metadata has none on this road/near this KM) -> no-camera', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope([cctvRecord({ RoadID: '999999', RoadName: '省道台1線' })]) }) });
  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-camera');
});

test('8. cameras found but ALL frame fetches fail -> no-frames, never throws', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const { fetchFn } = makeFrameFetch({ frameJpeg: undefined }); // every freeway.gov.tw fetch 404s
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-frames');
});

test('9. R2 publish failure -> r2-publish-failed, never throws', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: r2Bucket({ failPut: true }) });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [1, 2, 3]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'r2-publish-failed');
});

test('9b. missing CCTV_IMAGES (R2) binding -> fails closed, 0 fetch calls (checked before doing any work)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: undefined });
  const { fetchFn, hits } = makeFrameFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-r2-binding');
  assert.equal(hits.frame, 0);
  assert.equal(hits.other, 0);
});

// =======================================================================
// shared metadata cache: N accidents this run share at most 1 KV read
// =======================================================================

test('metadata reads are shared across multiple accidents this run via runCache (at most 1 KV get)', async () => {
  const trafficKv = kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) });
  let getCalls = 0;
  const originalGet = trafficKv.get.bind(trafficKv);
  trafficKv.get = async (...args) => {
    getCalls += 1;
    return originalGet(...args);
  };
  const env = baseEnv({ TRAFFIC_KV: trafficKv });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [7, 8, 9]) });
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
  assert.equal(getCalls, 1, `expected exactly 1 shared metadata KV read for 3 accidents this run, got ${getCalls}`);
});

// =======================================================================
// 4. metadata TTL = 7 days
// =======================================================================

test('4. FREEWAY_METADATA_TTL_SECONDS is 7 days', async () => {
  assert.equal(FREEWAY_METADATA_TTL_SECONDS, 7 * 24 * 60 * 60);
});

// =======================================================================
// 5/6/7: hard time budget
// =======================================================================

test('5. CCTV prepare exceeding its budget -> text-only (prepare-timeout), never hangs the caller past the budget', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  // A frame fetch that hangs like a real stuck connection — never
  // resolves on its own, only reacts to the AbortSignal
  // extractFirstJpegFrame passes in (real `fetch` behaves the same way
  // under AbortSignal.timeout). This lets the still-running background
  // work eventually settle on its own shortly after the outer race is
  // lost, instead of leaving a truly-dangling unresolved promise for the
  // whole test process.
  priorFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  const started = Date.now();
  const smallBudgetMs = 80; // tiny budget so the test stays fast/deterministic
  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC, smallBudgetMs);
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'prepare-timeout');
  // Generous upper bound — proves the caller was NOT held anywhere near
  // "forever"/the old unbounded behavior, without being a flaky exact-ms
  // assertion under CI scheduling jitter.
  assert.ok(elapsed < smallBudgetMs + 1000, `expected to resolve near the ${smallBudgetMs}ms budget, took ${elapsed}ms`);

  // The LOSING side of the internal race (the abandoned frame fetch,
  // still bounded by its own MIN_FRAME_TIMEOUT_MS floor) keeps running
  // in the background after prepareCctvImageForEvent already returned —
  // exactly as documented (harmless, its result is simply discarded).
  // Explicitly wait it out here so the test process doesn't exit with a
  // floating promise still in flight (Node's test runner flags that as
  // an error even though it's an intentional, harmless discard).
  await new Promise((resolve) => setTimeout(resolve, 400));
});

test('CCTV_PREPARE_BUDGET_MS (the real production default) is 4000ms', async () => {
  assert.equal(CCTV_PREPARE_BUDGET_MS, 4000);
});
