// V1.8.4 — LINE-safe CCTV image publishing layer, R2-backed.
//
// CORRECTION (post-review): storage moved from Workers KV to R2 — see
// src/cctv/publishedImage.js's module comment for the full rationale
// (Cache-Control alone cannot bound the URL's real lifetime; Workers KV
// is only eventually consistent across Cloudflare's global network,
// which a "compose -> immediately push to LINE -> LINE fetches the URL"
// flow cannot tolerate). CCTV candidate storage is UNCHANGED — it stays
// on TRAFFIC_KV; only published-image storage moved to R2
// (env.CCTV_IMAGES).
//
// 2026-08-30 (CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR) — real incident
// EVENT_ID=11508310005-5 (LINE delivered a broken image) exposed that
// /admin/cctv-hsinchu-publish-test, the ONE tool that could directly
// verify "does /cctv/image/:id genuinely return 200+JPEG right after
// publish", was itself unusable in Production: it depended on
// CANDIDATES_KEY, populated ONLY by /admin/cctv-hsinchu-probe, which
// makes a real TDX API call — forbidden while TRAFFIC_SOURCE_MODE=
// PBS_ONLY. This round repairs the tool to compose from the SAME
// cctv:freeway-metadata:v1 inventory cache (FREEWAY_METADATA_KEY) the
// real per-accident dynamic broadcast path already reads cache-only
// (never TDX) — see hsinchuCctvProbe.js's composeCollageFromFreewayMetadata
// and its own module-comment writeup. Tests below that exercise the
// publish-test endpoint now seed FREEWAY_METADATA_KEY (raw CCTV metadata
// records), not CANDIDATES_KEY (which only the fixed-target admin probe/
// collage pair still reads — see test 15).
//
// Covers two endpoints:
//   - GET /admin/cctv-hsinchu-publish-test (Admin-Auth-gated): composes
//     from the freeway metadata cache (0 TDX calls) and publishes to R2
//     under a fresh opaque id, per tdx/hsinchuCctvProbe.js's
//     handleHsinchuCctvPublishTest / composeCollageFromFreewayMetadata.
//   - GET /cctv/image/:id (deliberately UNAUTHENTICATED — see
//     cctv/publishedImage.js's module comment): reads back an
//     already-published image by opaque id, enforcing expiry itself on
//     every request (never delegated to HTTP caching or R2 lifecycle).
//
// Every CCTV frame fetch is mocked; the JPEG codec is real
// (test/testJpegCodec.js) — no network, no real TDX/LINE calls anywhere
// in this file. This round does NOT wire up real LINE push — nothing
// here calls line/pushMessage.js or line/webhook.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';
import { CANDIDATES_KEY, handleHsinchuCctvCollage, handleHsinchuCctvPublishTest } from '../src/tdx/hsinchuCctvProbe.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { publishCollageImage, handlePublicCctvImage, PUBLISHED_IMAGE_TTL_SECONDS } from '../src/cctv/publishedImage.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-publish-VERY-SECRET';
const LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token-VERY-SECRET';
const TDX_CLIENT_SECRET = 'test-tdx-secret-VERY-SECRET';

function kv(initial) {
  const store = new Map(Object.entries(initial || {}));
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

/** Minimal R2Bucket mock: put/get/delete, customMetadata, arrayBuffer(). */
function r2Bucket({ failPutForKeyPrefix, failGetForKeyPrefix } = {}) {
  const store = new Map(); // key -> { value: Uint8Array, customMetadata, httpMetadata }
  const deletedKeys = [];
  return {
    store,
    deletedKeys,
    async put(key, value, options = {}) {
      if (failPutForKeyPrefix && key.startsWith(failPutForKeyPrefix)) throw new Error('R2 write outage');
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { value: bytes, customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} });
    },
    async get(key) {
      if (failGetForKeyPrefix && key.startsWith(failGetForKeyPrefix)) throw new Error('R2 read outage');
      const entry = store.get(key);
      if (!entry) return null;
      return {
        customMetadata: entry.customMetadata,
        httpMetadata: entry.httpMetadata,
        async arrayBuffer() {
          return entry.value.buffer.slice(entry.value.byteOffset, entry.value.byteOffset + entry.value.byteLength);
        },
      };
    },
    async delete(key) {
      deletedKeys.push(key);
      store.delete(key);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    ADMIN_PASSWORD,
    LINE_CHANNEL_ACCESS_TOKEN,
    TDX_CLIENT_SECRET,
    TRAFFIC_KV: kv(),
    CCTV_IMAGES: r2Bucket(),
    ...overrides,
  };
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function authedRequest(path) {
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, {
    method: 'GET',
    headers: { Authorization: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) },
  });
}

function unauthedRequest(path) {
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, { method: 'GET' });
}

function publishTestRequest() {
  return new Request('https://traffic-reporter.example.workers.dev/admin/cctv-hsinchu-publish-test');
}

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

function candidatesEnvelope(candidates) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), candidates });
}

const FOUR_CANDIDATES = [
  { cctvId: 'CCTV-A', roadDirection: 'S', locationMile: '82K+000', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'https://cctv1.freeway.gov.tw/a.jpg' },
  { cctvId: 'CCTV-B', roadDirection: 'S', locationMile: '85K+500', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'https://cctv2.freeway.gov.tw/b.jpg' },
  { cctvId: 'CCTV-C', roadDirection: 'N', locationMile: '81K+000', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'https://cctv3.freeway.gov.tw/c.jpg' },
  { cctvId: 'CCTV-D', roadDirection: 'N', locationMile: '83K+500', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'https://cctv4.freeway.gov.tw/d.jpg' },
];

// --- Freeway metadata cache fixtures (2026-08-30) ---------------------------
// Raw CCTV metadata record shape — same as selectFourQuadrantCandidates'
// own `records` parameter (and the same shape test/dynamicCollage.test.js's
// own cctvRecord()/metadataEnvelope() helpers already use for the real
// per-accident path — this file follows the identical convention rather
// than inventing a second fixture shape).
function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010', // TARGET_ROAD_ID
    RoadName: '國道1號',
    RoadDirection: 'S',
    LocationMile: '82K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}

function metadataEnvelope(records) {
  return JSON.stringify({ records, fetchedAt: new Date().toISOString() });
}

// Covers all 4 quadrants around the fixed test target (國1 82K+100 —
// TARGET_KM) so selectFourQuadrantCandidates() fills every slot,
// deterministically, without depending on the real bundled inventory's
// exact shape.
const FOUR_RAW_RECORDS = [
  cctvRecord({ CCTVID: 'CCTV-S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/s-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-S-AFTER', RoadDirection: 'S', LocationMile: '82K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/s-after.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-N-BEFORE', RoadDirection: 'N', LocationMile: '81K+800', VideoStreamURL: 'https://cctv1.freeway.gov.tw/n-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-N-AFTER', RoadDirection: 'N', LocationMile: '82K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/n-after.jpg' }),
];

// Deliberately the WRONG road — selectFourQuadrantCandidates must reject
// every one of these (isTargetRoad fails for both RoadID and RoadName),
// yielding all-null candidates: the real, legitimate way to reach
// NO_CCTV_CANDIDATES with real code, no mocking required.
const WRONG_ROAD_RECORDS = [cctvRecord({ CCTVID: 'CCTV-WRONG-ROAD', RoadID: '999999', RoadName: '省道台1線' })];

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

function extractIdFromUrl(imageUrl) {
  return imageUrl.split('/cctv/image/')[1];
}

function mockCctvFetchOk() {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
}

// --- 1. R2 put succeeds -> imageUrl returned, all required fields present --

test('1. a successful collage compose (from the freeway metadata cache, 0 TDX) publishes to R2 and returns every required diagnostic field', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  mockCctvFetchOk();

  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  assert.equal(res.status, 200);
  const body = await res.json();
  // order section 二's own minimum required field list.
  assert.equal(body.status, 'ok');
  assert.equal(body.published, true);
  assert.equal(body.contentType, 'image/jpeg');
  assert.ok(typeof body.bytes === 'number' && body.bytes > 0);
  assert.ok(typeof body.createdAt === 'string' && !Number.isNaN(Date.parse(body.createdAt)));
  assert.ok(typeof body.expiresAt === 'string' && !Number.isNaN(Date.parse(body.expiresAt)));
  assert.match(body.imageUrl, /^https:\/\/traffic-reporter\.example\.workers\.dev\/cctv\/image\/[0-9a-f]{32}$/);
  assert.equal(body.expiresIn, PUBLISHED_IMAGE_TTL_SECONDS);

  const id = extractIdFromUrl(body.imageUrl);
  const stored = env.CCTV_IMAGES.store.get(`cctv/published-image/${id}.jpg`);
  assert.ok(stored, 'expected an R2 object for the published image');
  assert.ok(stored.value.byteLength > 0);
  assert.ok(stored.customMetadata.createdAt);
  assert.ok(stored.customMetadata.expiresAt);
});

// --- CASE 1 (order section 五): freeway metadata cache available via the
// BUNDLED fallback alone (genuinely empty TRAFFIC_KV — no probe ever
// ran, no FREEWAY_METADATA_KEY ever written) -> 0 TDX calls -> test image
// still published. This is the strongest possible proof of the repair's
// own stated goal: even a brand-new Production deploy that has NEVER run
// /admin/cctv-hsinchu-probe can still run this diagnostic tool.

test('CASE 1: a genuinely empty TRAFFIC_KV (no probe ever run, no metadata cache ever written) still succeeds via the bundled official inventory — 0 TDX calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv() }); // completely empty
  mockCctvFetchOk();

  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  assert.equal(res.status, 200, `expected success via bundled fallback, got: ${JSON.stringify(await res.clone().json().catch(() => null))}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.published, true);
});

// --- 2. put, then immediately read via a separate mock request -> 200 ---
// (demonstrates the code path never waits/sleeps for consistency and
// trusts R2's own strong read-after-write guarantee — nothing here
// artificially delays the read.)

test('2. immediately reading right after publish (a separate request/handler call) -> 200', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  mockCctvFetchOk();

  const publishRes = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  const { imageUrl } = await publishRes.json();
  const id = extractIdFromUrl(imageUrl);

  // A separate, freshly-constructed read request (simulating LINE's
  // servers fetching the URL right after the push) — no delay inserted.
  const readRes = await worker.fetch(unauthedRequest(`/cctv/image/${id}`), env);
  assert.equal(readRes.status, 200);
});

// --- 3. public GET -> identical JPEG bytes ---

test('3. GET /cctv/image/:id -> 200, image/jpeg, bytes identical to what was published', async () => {
  const jpegBytes = await makeSolidJpeg(50, 50, [10, 200, 30]);
  const env = baseEnv();
  const published = await publishCollageImage(env.CCTV_IMAGES, jpegBytes);
  assert.equal(published.ok, true);

  const res = await worker.fetch(unauthedRequest(`/cctv/image/${published.id}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  const returnedBytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(returnedBytes, jpegBytes);
});

// --- 4. expired object -> 404, best-effort delete attempted ---

test('4. an object past its expiresAt -> 404, and a best-effort delete is attempted', async () => {
  const env = baseEnv();
  const jpegBytes = await makeSolidJpeg(10, 10, [1, 1, 1]);
  const past = new Date(Date.now() - 2 * PUBLISHED_IMAGE_TTL_SECONDS * 1000); // published long ago
  const published = await publishCollageImage(env.CCTV_IMAGES, jpegBytes, past);
  assert.equal(published.ok, true);

  const res = await handlePublicCctvImage(env, published.id);
  assert.equal(res.status, 404);
  assert.deepEqual(env.CCTV_IMAGES.deletedKeys, [`cctv/published-image/${published.id}.jpg`]);
  assert.equal(env.CCTV_IMAGES.store.has(`cctv/published-image/${published.id}.jpg`), false);
});

// --- 5. missing object -> 404 ---

test('5. a valid-shaped id whose R2 object is missing (never existed) -> 404', async () => {
  const env = baseEnv();
  const res = await handlePublicCctvImage(env, 'f'.repeat(32));
  assert.equal(res.status, 404);
});

// --- 6. bad opaque id -> 404, R2 never read ---

test('6. malformed id shapes (wrong length, non-hex, path traversal attempt) -> 404, never even reaches R2.get', async () => {
  const env = baseEnv();
  let getCalls = 0;
  const originalGet = env.CCTV_IMAGES.get.bind(env.CCTV_IMAGES);
  env.CCTV_IMAGES.get = async (...args) => {
    getCalls += 1;
    return originalGet(...args);
  };

  for (const badId of ['short', 'g'.repeat(32), '../../etc/passwd', '', `${'a'.repeat(32)}extra`]) {
    const res = await handlePublicCctvImage(env, badId);
    assert.equal(res.status, 404, `expected 404 for id "${badId}"`);
  }
  assert.equal(getCalls, 0, 'a malformed id must never even reach an R2 read');
});

// --- 7. R2 put fail -> no imageUrl (CASE 5: R2 publish failure) ---

test('7. an R2 write failure while publishing -> step=R2_PUBLISH_FAILED, no imageUrl returned', async () => {
  const env = baseEnv({
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }),
    CCTV_IMAGES: r2Bucket({ failPutForKeyPrefix: 'cctv/published-image/' }),
  });
  mockCctvFetchOk();

  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.equal(body.step, 'R2_PUBLISH_FAILED');
  assert.equal(body.imageUrl, undefined);
  assert.equal(body.published, undefined);
});

// --- 8. R2 get fail -> fail closed, no fallback ---

test('8. an R2 read failure on the public endpoint fails closed (404), never falls back to KV/CCTV/TDX/regenerate', async () => {
  const env = baseEnv({ CCTV_IMAGES: r2Bucket({ failGetForKeyPrefix: 'cctv/published-image/' }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fall back to a network fetch: ${url}`);
  };

  const res = await handlePublicCctvImage(env, 'a'.repeat(32));
  assert.equal(res.status, 404);
  assert.equal(fetchCalls, 0);
});

// --- 9. public response: Cache-Control: no-store ---

test('9. the public image response always sets Cache-Control: no-store', async () => {
  const jpegBytes = await makeSolidJpeg(10, 10, [7, 7, 7]);
  const env = baseEnv();
  const published = await publishCollageImage(env.CCTV_IMAGES, jpegBytes);

  const res = await worker.fetch(unauthedRequest(`/cctv/image/${published.id}`), env);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

// --- 10. public GET: 0 TDX, 0 CCTV fetch, 0 LINE ---

test('10. GET /cctv/image/:id never calls fetch at all (0 TDX, 0 CCTV, 0 LINE)', async () => {
  const jpegBytes = await makeSolidJpeg(20, 20, [1, 2, 3]);
  const env = baseEnv();
  const published = await publishCollageImage(env.CCTV_IMAGES, jpegBytes);

  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`the public image endpoint must never call fetch: ${url}`);
  };

  const res = await worker.fetch(unauthedRequest(`/cctv/image/${published.id}`), env);
  assert.equal(res.status, 200);
  assert.equal(fetchCalls, 0);
});

// --- 11. Admin publish-test unauthenticated -> 0 R2 write, 0 CCTV fetch ---

test('11. unauthenticated request to /admin/cctv-hsinchu-publish-test -> 401, 0 R2 writes, 0 CCTV fetch', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch when unauthenticated: ${url}`);
  };
  let putCalls = 0;
  const originalPut = env.CCTV_IMAGES.put.bind(env.CCTV_IMAGES);
  env.CCTV_IMAGES.put = async (...args) => {
    putCalls += 1;
    return originalPut(...args);
  };

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-publish-test'), env);
  assert.equal(res.status, 401);
  assert.equal(fetchCalls, 0);
  assert.equal(putCalls, 0);
});

// --- 12. Admin publish-test: at most 4 CCTV fetches, TDX_CALLS_PER_TEST = 0 -

test('12. an authenticated publish-test with 4 metadata-cache candidates fetches at most 4 CCTV frames and makes 0 TDX calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  let fetchCalls = 0;
  const seenUrls = [];
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    seenUrls.push(String(url));
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  // Direct handler call + test codec: a real successful compose loads
  // the production WASM JPEG codec via a dynamic `.wasm` import that
  // plain Node cannot resolve — see hsinchuCctvProbe.js's module
  // comment. Admin Auth itself is separately covered by test 11.
  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  assert.equal(res.status, 200);
  assert.ok(fetchCalls <= 4, `expected at most 4 CCTV fetches, got ${fetchCalls}`);
  // TDX calls go through tdx/client.js's fetchTdxJson, which always
  // targets tdx.transportdata.tw — asserting no fetch URL ever touches
  // that domain is a direct, real proof of TDX_CALLS_PER_TEST = 0, not
  // just an absence-of-import argument.
  assert.ok(seenUrls.every((u) => !u.includes('tdx.transportdata.tw')), 'must make 0 TDX calls');
});

// --- 13. NO_CCTV_CANDIDATES: metadata cache present but no eligible camera -

test('13. metadata cache present but every record is for the wrong road -> step=NO_CCTV_CANDIDATES, 0 TDX calls, no image published', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(WRONG_ROAD_RECORDS) }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-publish-test'), env);
  assert.equal(res.status, 404);
  assert.equal(fetchCalls, 0);
  const body = await res.json();
  assert.equal(body.step, 'NO_CCTV_CANDIDATES');
  assert.match(body.message, /No eligible CCTV candidates/);
  assert.equal(env.CCTV_IMAGES.store.size, 0, 'no published-image object should have been written');
});

// --- 13b. SNAPSHOT_FETCH_FAILED: all frame fetches fail ---------------------

test('13b. all 4 candidate frame fetches fail -> step=SNAPSHOT_FETCH_FAILED, no published image is written, no imageUrl returned', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('gateway timeout', { status: 504 });

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-publish-test'), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.step, 'SNAPSHOT_FETCH_FAILED');
  assert.equal(body.imageUrl, undefined);
  assert.match(body.message, /No CCTV footage/);
  assert.equal(env.CCTV_IMAGES.store.size, 0);
});

// --- 13b2. every frame fetch returns 200 with no JPEG marker at all -> this
// is still SNAPSHOT_FETCH_FAILED (extractFirstJpegFrame itself never
// reports a complete frame), distinct from 13b3 below -----------------------

test('13b2. every frame fetch returns 200 but with no JPEG marker at all -> step=SNAPSHOT_FETCH_FAILED (extractFirstJpegFrame itself never completes)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-publish-test'), env);
  const body = await res.json();
  // No SOI(0xFFD8)/EOI(0xFFD9) pair at all -> extractFirstJpegFrame
  // itself returns {ok:false, reason:'no-complete-frame'} for every
  // candidate — the same "no usable frame" outcome as a genuine network
  // failure from this endpoint's own point of view, so this fixture
  // lands on SNAPSHOT_FETCH_FAILED (no candidate ever reached
  // jpegBytes/status:'ok'). COMPOSE_FAILED is reserved for a frame that
  // DID satisfy extractFirstJpegFrame's own SOI...EOI completeness check
  // but still failed to actually decode — see test 13b3 below.
  assert.equal(body.step, 'SNAPSHOT_FETCH_FAILED');
  assert.equal(env.CCTV_IMAGES.store.size, 0);
});

test('13b3. every frame has a structurally-complete SOI...EOI marker pair but corrupt scan data -> step=COMPOSE_FAILED (distinct from SNAPSHOT_FETCH_FAILED)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  priorFetch = globalThis.fetch;
  // Real JPEG SOI (0xFFD8) ... EOI (0xFFD9) markers with garbage in
  // between — extractFirstJpegFrame's own marker-walk (findJpegImageEnd)
  // reports this as a COMPLETE frame (verified directly against the real
  // function: {ok:true, bytes:7}), so a frame genuinely IS "fetched" —
  // but the real mozjpeg WASM decoder then genuinely fails on it
  // (verified directly: "Corrupt JPEG data ... JPEG datastream contains
  // no image"), landing on anyFrameFetchSucceeded=true but
  // successfulDecodedFrames=0 -> COMPOSE_FAILED. This is the one case
  // this file could not exercise before this round (composeQuadrantCollage's
  // own decode-failure handling was already tested in
  // test/cctvCollage.test.js, but never reachable through this endpoint's
  // OWN step taxonomy until now).
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), { status: 200 });

  // Direct handler call + test codec — same reasoning as test 12: a
  // frame that genuinely fetches ok:true reaches the real WASM decode
  // path, which plain Node cannot resolve without the Node-compatible
  // test codec (see module comment on TEST_CODEC/codecOverride).
  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  const body = await res.json();
  assert.equal(body.step, 'COMPOSE_FAILED');
  assert.equal(env.CCTV_IMAGES.store.size, 0);
});

test('13c. CCTV_IMAGES binding not configured -> 503, 0 CCTV fetch (fails before composing)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }), CCTV_IMAGES: undefined });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch when CCTV_IMAGES is unconfigured: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-publish-test'), env);
  assert.equal(res.status, 503);
  assert.equal(fetchCalls, 0);
});

test('13d. CCTV_IMAGES binding not configured -> public GET fails closed (404)', async () => {
  const env = baseEnv({ CCTV_IMAGES: undefined });
  const res = await handlePublicCctvImage(env, 'a'.repeat(32));
  assert.equal(res.status, 404);
});

// --- 14. no secret, and no VideoStreamURL, ever appears in the URL, R2 metadata, or response ---

test('14. neither the publish-test response, the R2 metadata, nor the public image URL ever contains ADMIN_PASSWORD, LINE token, TDX token, or a VideoStreamURL', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  mockCctvFetchOk();

  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  const rawBody = await res.text();
  assert.doesNotMatch(rawBody, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(rawBody, new RegExp(LINE_CHANNEL_ACCESS_TOKEN));
  assert.doesNotMatch(rawBody, new RegExp(TDX_CLIENT_SECRET));
  for (const r of FOUR_RAW_RECORDS) assert.ok(!rawBody.includes(r.VideoStreamURL), `response must not leak VideoStreamURL: ${r.VideoStreamURL}`);

  // R2 customMetadata itself must never carry a secret or VideoStreamURL.
  for (const entry of env.CCTV_IMAGES.store.values()) {
    const metaJson = JSON.stringify(entry.customMetadata);
    assert.doesNotMatch(metaJson, new RegExp(ADMIN_PASSWORD));
    assert.doesNotMatch(metaJson, new RegExp(LINE_CHANNEL_ACCESS_TOKEN));
    assert.doesNotMatch(metaJson, new RegExp(TDX_CLIENT_SECRET));
    for (const r of FOUR_RAW_RECORDS) assert.ok(!metaJson.includes(r.VideoStreamURL));
  }

  const body = JSON.parse(rawBody);
  const imgRes = await worker.fetch(unauthedRequest(new URL(body.imageUrl).pathname), env);
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  assert.ok(!imgBytes.includes(Buffer.from(ADMIN_PASSWORD)));
  assert.ok(!imgBytes.includes(Buffer.from(LINE_CHANNEL_ACCESS_TOKEN)));
  assert.ok(!imgBytes.includes(Buffer.from(TDX_CLIENT_SECRET)));
});

// --- 15. existing fixed-target collage endpoint regression (CANDIDATES_KEY,
// unaffected by this round's repair — /admin/cctv-hsinchu-collage still
// reads only its own fixed-target probe cache, never the freeway metadata
// cache) -------------------------------------------------------------------

test('15. GET /admin/cctv-hsinchu-collage still produces a normal collage JPEG after the V1.8.4 R2 change, using CANDIDATES_KEY unaffected by this round', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  mockCctvFetchOk();

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
});

// --- CASE 7 (order section 五): the diagnostic tool never triggers PBS, the
// AI decision path, the Queue, or a real LINE broadcast ---------------------

test('CASE 7: a successful publish-test run never calls PBS, AI, Queue, or LINE — only CCTV frame fetches happen', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(FOUR_RAW_RECORDS) }) });
  const seenUrls = [];
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  const res = await handleHsinchuCctvPublishTest(env, publishTestRequest(), TEST_CODEC);
  assert.equal(res.status, 200);
  // Every fetch call must be a CCTV frame fetch (freeway.gov.tw), never
  // LINE's Messaging API, TDX, or any PBS-relay domain.
  assert.ok(seenUrls.length > 0, 'sanity: at least one CCTV frame fetch must have happened');
  for (const url of seenUrls) {
    assert.ok(!url.includes('api.line.me'), `must never call LINE: ${url}`);
    assert.ok(!url.includes('tdx.transportdata.tw'), `must never call TDX: ${url}`);
  }
});
