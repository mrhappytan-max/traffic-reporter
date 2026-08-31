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
import {
  FREEWAY_METADATA_KEY,
  readFreewayCctvMetadataCache,
  writeFreewayCctvMetadataCache,
} from '../src/cctv/freewayCctvMetadataCache.js';
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

// `getOverride`, when given, replaces get()'s entire behavior — used by
// the CCTV_R2_READBACK_VERIFY_BEFORE_LINE test cases below to simulate a
// post-publish read-back that misses/returns empty bytes/reports the
// wrong content type/throws, without touching put() at all (production
// only ever calls get() once per publish, from the new read-back check —
// see publishedImage.js#verifyPublishedImageReadable). `httpMetadata` is
// now stored/returned the same way `customMetadata` already was — real
// R2 does this too, and publishCollageImage always passes
// `httpMetadata: { contentType: 'image/jpeg' }`, so every existing test
// using the DEFAULT (no getOverride) behavior keeps passing unchanged.
function r2Bucket({ failPut, getOverride } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
      if (failPut) throw new Error('R2 write outage');
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { value: bytes, customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} });
    },
    async get(key) {
      if (getOverride) return getOverride(key, store);
      const entry = store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, httpMetadata: entry.httpMetadata, async arrayBuffer() { return entry.value.buffer; } };
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

test('3. road alias mapping: 國道1號/中山高/中山高速公路 all resolve to the same supported road; a genuinely different freeway (國道三號) resolves to a DIFFERENT road with its own identity', async () => {
  for (const roadText of ['國道一號', '國道1號', '中山高', '中山高速公路']) {
    const e = resolveCctvEligibility(accidentEvent({ road: roadText }));
    assert.equal(e.eligible, true, `expected "${roadText}" to resolve as eligible`);
    assert.equal(e.roadKey, '國道一號');
    assert.equal(e.roadShortName, '國1');
  }

  // V1.8.7.5 — 國道三號 is now ALSO CCTV-supported (real Production
  // RoadID/RoadName confirmed — see CCTV_SUPPORTED_ROADS's own comment),
  // so this no longer demonstrates "unsupported"; it still demonstrates
  // road resolution correctly keeping 國1/國3 as two distinct roads with
  // their own roadId/roadShortName, never conflated.
  const e3 = resolveCctvEligibility(accidentEvent({ road: '國道三號' }));
  assert.equal(e3.eligible, true);
  assert.equal(e3.roadKey, '國道三號');
  assert.equal(e3.roadShortName, '國3');
  assert.notEqual(e3.roadId, resolveCctvEligibility(accidentEvent({ road: '國道一號' })).roadId);
});

test('4. missing KM (no startKM, no endKM) -> ineligible, text only', async () => {
  const e = resolveCctvEligibility(accidentEvent({ startKM: undefined, endKM: undefined }));
  assert.equal(e.eligible, false);
  assert.equal(e.reason, 'no-reliable-km');
});

// V1.8.7.5 — roadSectionLabel.js's resolveRoadKey (which resolveCctvEligibility
// relies on) currently only recognizes 國道一號/國道三號 at all (see that
// module's own "Scope this round" comment) — and CCTV_SUPPORTED_ROADS now
// covers both. There is therefore currently no real road TEXT that
// resolves via resolveRoadKey yet still misses CCTV_SUPPORTED_ROADS
// (exactly the gap 國3 itself used to sit in, V1.8.7.4→V1.8.7.5) — the
// 'unsupported-road' branch in resolveCctvEligibility is unchanged and
// still there, ready for the day a THIRD road gains resolveRoadKey
// support before CCTV_SUPPORTED_ROADS catches up to it, same as 國3 did;
// it simply has no live example to assert against today. 'unresolvable-
// road' (a road resolveRoadKey has never heard of at all) remains fully
// exercisable and asserted below.
test('5. unresolvable road -> ineligible, text only (unsupported-road has no live example today — see comment above)', async () => {
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

// V1.8.5.1 — required regression test 9: a PBS accident whose comment
// text happened to parse a displayKM (pbs/normalize.js) must NOT gain
// CCTV eligibility because of it. resolveCctvEligibility checks
// `source === 'freeway'` before it ever looks at any KM field, so a
// PBS event fails closed at 'not-freeway-source' regardless of whether
// it carries a displayKM — this module never even reads that field.
test('9. a PBS event carrying a parsed displayKM is still CCTV-ineligible (not-freeway-source, displayKM never consulted)', async () => {
  const result = resolveCctvEligibility(accidentEvent({ source: 'pbs', startKM: undefined, endKM: undefined, displayKM: 93.3 }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not-freeway-source');
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

// UPDATED 2026-08-25 by CCTV_METADATA_RECOVERY_V1. This test used to require
// that a KV miss produced 'metadata-cache-unavailable' with 0 fetches. The
// no-TDX half of that was, and remains, the point of the test. The
// no-cameras half was the 19:01 defect: KV aged the inventory out on a
// 7-day TTL and nothing was allowed to refill it. A miss now falls back to
// the bundled official NFB inventory, so frame fetches SHOULD happen here.
//
// The invariant that must never move is the second one: whatever this
// module does about metadata, it does without calling TDX.
test('6/1-required: broadcast metadata cache MISS -> bundled inventory, still 0 TDX CCTV metadata calls', async () => {
  const env = baseEnv(); // no cctv:freeway-metadata:v1 key seeded at all
  const { fetchFn, hits } = makeFrameFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  assert.notEqual(
    result.reason,
    'metadata-cache-unavailable',
    'a KV miss must never again mean "no cameras exist"'
  );
  assert.ok(hits.frame > 0, 'the bundled inventory gave the selector real cameras to try');
  assert.equal(hits.other, 0, '0 non-frame fetches — this module must never call TDX itself');
});

test('6b. a corrupt cache entry degrades to the bundled inventory, never to "no cameras"', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: 'not valid json' }) });
  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);
  // Unparseable KV is still a degraded read, but the floor beneath it is the
  // bundled official inventory rather than nothing at all.
  assert.notEqual(result.reason, 'metadata-cache-unavailable');
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

test('4. the camera inventory is stored with NO expiry, and has a bundled official floor', async () => {
  // REWRITTEN 2026-08-25 (CCTV_METADATA_RECOVERY_V1). This used to assert
  // FREEWAY_METADATA_TTL_SECONDS === 7 days. That TTL is the bug: the only
  // writer is a TDX-dependent admin probe, so under PBS_ONLY the key expired
  // and nothing could refill it — a real 國1 93K accident lost its image to
  // metadata-cache-unavailable. The constant is gone; what is pinned now is
  // that a write carries no expiry at all.
  const puts = [];
  const kv = {
    async get() {
      return null;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
    },
  };
  const result = await writeFreewayCctvMetadataCache(kv, [{ CCTVID: 'X', VideoStreamURL: 'u', LocationMile: '1K+000', RoadDirection: 'S' }]);
  assert.equal(result.committed, true);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].options, undefined, 'no expirationTtl may ever be set on the camera inventory');

  // And with KV empty, the bundled official inventory still answers.
  const records = await readFreewayCctvMetadataCache({ async get() { return null; } });
  assert.ok(Array.isArray(records) && records.length > 0, 'an empty KV must not mean an empty camera list');
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

test('3. work completing before the budget clears the pending timer (no dangling timer left after a fast success)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [4, 4, 4]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  // A deliberately large budget — if withTimeout's clearTimeout() were
  // NOT actually clearing the timer on a fast win, this budget's own
  // setTimeout would still be sitting in the event loop after this test
  // function returns, and — unlike test 5/6/7 above — this test does
  // NOT add a trailing wait to let it settle. A dangling, un-cleared
  // timer here would surface exactly like the earlier `unref()` bug did
  // (a lingering/"cancelledByParent" failure once the file finishes) —
  // this test passing cleanly, with the whole file finishing in ~2s
  // rather than anywhere near this 5000ms budget, IS the proof.
  const largeBudgetMs = 5000;
  const started = Date.now();
  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC, largeBudgetMs);
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  assert.ok(elapsed < 1000, `expected the successful call to resolve quickly (well under the ${largeBudgetMs}ms budget), took ${elapsed}ms`);
});

test('4. the deadline having already passed by the time R2 publish is reached -> R2 put is never called', async () => {
  const bucket = r2Bucket();
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: bucket });
  // Frame fetch resolves immediately — the point of this test is that
  // even when metadata+select+frame-fetch all succeed, an exhausted
  // deadline by the time compose/publish is reached must still prevent
  // the R2 write. A 1ms budget guarantees the deadline is already in the
  // past well before JPEG encode/decode (which realistically takes tens
  // of ms) finishes.
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [6, 6, 6]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const tinyBudgetMs = 1;
  const result = await prepareCctvImageForEvent(env, accidentEvent({ startKM: '82K+000', endKM: '82K+200' }), {}, TEST_CODEC, tinyBudgetMs);

  assert.equal(result.ok, false);
  assert.ok(['prepare-timeout', 'no-frames'].includes(result.reason), `expected a fail-closed reason, got ${result.reason}`);
  assert.equal(bucket.store.size, 0, 'no R2 object should ever have been written once the deadline had passed');
});

// =======================================================================
// CCTV_R2_READBACK_VERIFY_BEFORE_LINE (2026-08-31) — CASE 1-8 per the
// order's own numbering. Covers the quad (accident) path; the single
// (dynamic-shoulder) path gets the same treatment inside
// prepareSingleCctvImageWork (test/dynamicShoulder.test.js has its own
// CASE 1/6-equivalent coverage — same publishCollageImage +
// verifyPublishedImageReadable call pair, not duplicated here).
// =======================================================================

test('CASE 1: R2 put success + R2 get success + bytes>0 + image/jpeg -> imageUrl returned, LINE image allowed', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [11, 22, 33]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(typeof result.imageUrl === 'string' && result.imageUrl.length > 0);
  assert.equal(typeof result.r2ReadbackElapsedMs, 'number', 'read-back stage timing must be reported on the success path');
});

test('CASE 2: R2 put success, R2 get returns null -> r2-readback-failed, text only', async () => {
  const bucket = r2Bucket({ getOverride: async () => null });
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: bucket });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [12, 22, 32]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'r2-readback-failed');
  assert.equal(result.imageUrl, undefined, 'a failed read-back must never hand back a URL');
  // The object really was written — this proves the failure is the
  // NEW read-back check, not a regression in publishCollageImage itself.
  assert.equal(bucket.store.size, 1);
});

test('CASE 3: R2 put success, R2 get returns 0 bytes -> r2-readback-failed, text only', async () => {
  const bucket = r2Bucket({
    getOverride: async (key, store) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, httpMetadata: entry.httpMetadata, async arrayBuffer() { return new ArrayBuffer(0); } };
    },
  });
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: bucket });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [13, 23, 33]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'r2-readback-failed');
});

test('CASE 4: R2 put success, read-back reports the wrong content type -> r2-readback-failed, text only', async () => {
  const bucket = r2Bucket({
    getOverride: async (key, store) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, httpMetadata: { contentType: 'application/octet-stream' }, async arrayBuffer() { return entry.value.buffer; } };
    },
  });
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: bucket });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [14, 24, 34]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'r2-readback-failed');
});

test('CASE 5: R2 read-back throws -> fail closed, text only (never treated as "probably fine")', async () => {
  const bucket = r2Bucket({
    getOverride: async () => {
      throw new Error('R2 get outage');
    },
  });
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }), CCTV_IMAGES: bucket });
  const { fetchFn } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [15, 25, 35]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'r2-readback-failed');
});

test('CASE 7/8: read-back adds 0 extra TDX calls and never touches AI/Queue/PBS/LINE text logic (the only new I/O is one internal R2 GET, no HTTP fetch to this Worker\'s own /cctv/image/:id endpoint)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(ALL_RECORDS) }) });
  const { fetchFn, hits } = makeFrameFetch({ frameJpeg: await makeSolidJpeg(80, 60, [16, 26, 36]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC);

  assert.equal(result.ok, true, JSON.stringify(result));
  // makeFrameFetch's own fetchFn throws loudly on any non-freeway.gov.tw
  // URL (see its own comment) — 4 quadrant frame fetches, exactly, and
  // `hits.other` staying 0 proves no TDX/LINE/self-HTTP call was made by
  // the new read-back step (verifyPublishedImageReadable is a plain
  // bucket.get(), never a fetch()).
  assert.equal(hits.other, 0, 'no TDX, LINE, or self-HTTP call from the read-back step');
});

test('CCTV_PREPARE_BUDGET_MS (the real production default) is 4000ms', async () => {
  assert.equal(CCTV_PREPARE_BUDGET_MS, 4000);
});
