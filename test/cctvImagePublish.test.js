// V1.8.4 — LINE-safe CCTV image publishing layer.
//
// Covers two endpoints:
//   - GET /admin/cctv-hsinchu-publish-test (Admin-Auth-gated): composes
//     the same collage as /admin/cctv-hsinchu-collage and publishes it
//     to KV under a fresh opaque id, per tdx/hsinchuCctvProbe.js's
//     handleHsinchuCctvPublishTest.
//   - GET /cctv/image/:id (deliberately UNAUTHENTICATED — see
//     cctv/publishedImage.js's module comment): reads back an
//     already-published image by opaque id.
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
import { publishCollageImage, handlePublicCctvImage, PUBLISHED_IMAGE_TTL_SECONDS } from '../src/cctv/publishedImage.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-publish-VERY-SECRET';
const LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token-VERY-SECRET';
const TDX_CLIENT_SECRET = 'test-tdx-secret-VERY-SECRET';

function kv(initial, { failPutForKeyPrefix } = {}) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key, _type) {
      return store.get(key) ?? null;
    },
    async put(key, value, _options) {
      if (failPutForKeyPrefix && key.startsWith(failPutForKeyPrefix)) throw new Error('KV write outage');
      store.set(key, value);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    ADMIN_PASSWORD,
    LINE_CHANNEL_ACCESS_TOKEN,
    TDX_CLIENT_SECRET,
    TRAFFIC_KV: kv(),
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

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

function extractIdFromUrl(imageUrl) {
  return imageUrl.split('/cctv/image/')[1];
}

// --- 1. successful compose -> KV stores a binary entry -> a public image id comes back ---

test('1. a successful collage compose publishes a binary entry to KV and returns an opaque image id', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });

  const res = await handleHsinchuCctvPublishTest(
    env,
    new Request('https://traffic-reporter.example.workers.dev/admin/cctv-hsinchu-publish-test'),
    TEST_CODEC
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.published, true);
  assert.match(body.imageUrl, /^https:\/\/traffic-reporter\.example\.workers\.dev\/cctv\/image\/[0-9a-f]{32}$/);
  assert.equal(body.expiresIn, PUBLISHED_IMAGE_TTL_SECONDS);
  assert.ok(typeof body.sizeBytes === 'number' && body.sizeBytes > 0);

  // A KV entry with a matching key prefix now exists, holding binary data.
  const id = extractIdFromUrl(body.imageUrl);
  const stored = env.TRAFFIC_KV.store.get(`cctv:published-image:${id}`);
  assert.ok(stored, 'expected a KV entry for the published image');
  assert.ok(stored.byteLength > 0);
});

// --- 2. public GET -> 200, image/jpeg, bytes match what was stored ---

test('2. GET /cctv/image/:id -> 200, image/jpeg, bytes identical to what was published', async () => {
  const jpegBytes = await makeSolidJpeg(50, 50, [10, 200, 30]);
  const env = baseEnv();
  const published = await publishCollageImage(env.TRAFFIC_KV, jpegBytes);
  assert.equal(published.ok, true);

  const res = await worker.fetch(unauthedRequest(`/cctv/image/${published.id}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  const returnedBytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(returnedBytes, jpegBytes);
});

// --- 3. public image endpoint: 0 TDX calls, 0 CCTV fetch, 0 LINE calls ---

test('3. GET /cctv/image/:id never calls fetch at all (0 TDX, 0 CCTV, 0 LINE)', async () => {
  const jpegBytes = await makeSolidJpeg(20, 20, [1, 2, 3]);
  const env = baseEnv();
  const published = await publishCollageImage(env.TRAFFIC_KV, jpegBytes);

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

// --- 4. a guessed/wrong id -> 404 ---

test('4. a guessed/random id that was never published -> 404', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  const res = await worker.fetch(unauthedRequest(`/cctv/image/${'a'.repeat(32)}`), env);
  assert.equal(res.status, 404);
});

// --- 5. expired/missing key -> 404 ---

test('5. a valid-shaped id whose KV key is missing (expired or never existed) -> 404', async () => {
  const env = baseEnv();
  const res = await handlePublicCctvImage(env, 'f'.repeat(32));
  assert.equal(res.status, 404);
});

test('5b. malformed id shapes (wrong length, non-hex, path traversal attempt) -> 404, never a KV lookup', async () => {
  const env = baseEnv();
  let getCalls = 0;
  const trackedKv = env.TRAFFIC_KV;
  const originalGet = trackedKv.get.bind(trackedKv);
  trackedKv.get = async (...args) => {
    getCalls += 1;
    return originalGet(...args);
  };

  for (const badId of ['short', 'g'.repeat(32), '../../etc/passwd', '', `${'a'.repeat(32)}extra`]) {
    const res = await handlePublicCctvImage(env, badId);
    assert.equal(res.status, 404, `expected 404 for id "${badId}"`);
  }
  assert.equal(getCalls, 0, 'a malformed id must never even reach a KV read');
});

// --- 6. opaque ids: high entropy, not derivable from timestamp/km ---

test('6. published image ids are 128-bit random hex, distinct across calls even with the same input/timestamp', async () => {
  const jpegBytes = await makeSolidJpeg(10, 10, [5, 5, 5]);
  const env = baseEnv();
  const fixedNow = new Date('2026-08-18T12:00:00Z');

  const first = await publishCollageImage(env.TRAFFIC_KV, jpegBytes, fixedNow);
  const second = await publishCollageImage(env.TRAFFIC_KV, jpegBytes, fixedNow);

  assert.match(first.id, /^[0-9a-f]{32}$/);
  assert.match(second.id, /^[0-9a-f]{32}$/);
  assert.notEqual(first.id, second.id, 'two publishes must never collide/reuse the same id, even with identical bytes and timestamp');

  // Not derivable from the fixed timestamp: the id must not contain the
  // timestamp's own digits as a recognizable run (e.g. "20260818").
  assert.doesNotMatch(first.id, /20260818/);
  assert.doesNotMatch(second.id, /20260818/);
});

// --- 7. Admin publish-test unauthenticated -> 0 KV write, 0 CCTV fetch, 0 TDX ---

test('7. unauthenticated request to /admin/cctv-hsinchu-publish-test -> 401, 0 KV writes, 0 CCTV fetch', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch when unauthenticated: ${url}`);
  };
  const putSpy = env.TRAFFIC_KV.put.bind(env.TRAFFIC_KV);
  let putCalls = 0;
  env.TRAFFIC_KV.put = async (...args) => {
    putCalls += 1;
    return putSpy(...args);
  };

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-publish-test'), env);
  assert.equal(res.status, 401);
  assert.equal(fetchCalls, 0);
  assert.equal(putCalls, 0);
});

// --- 8. Admin publish-test: at most 4 CCTV fetches ---

test('8. an authenticated publish-test with 4 cached candidates fetches at most 4 CCTV frames', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  // Calls the handler directly (with the Node-compatible test codec)
  // rather than via worker.fetch: a real successful compose loads the
  // production WASM JPEG codec via a dynamic `.wasm` import that plain
  // Node cannot resolve — see hsinchuCctvProbe.js's module comment and
  // the same pattern used by the /admin/cctv-hsinchu-collage tests. Admin
  // Auth itself is separately covered by test 7 (401 case), which never
  // reaches a successful compose.
  const res = await handleHsinchuCctvPublishTest(
    env,
    new Request('https://traffic-reporter.example.workers.dev/admin/cctv-hsinchu-publish-test'),
    TEST_CODEC
  );
  assert.equal(res.status, 200);
  assert.ok(fetchCalls <= 4, `expected at most 4 CCTV fetches, got ${fetchCalls}`);
});

// --- 9. candidate cache missing -> 0 TDX, 0 published image ---

test('9. no cached candidates -> "CCTV candidate cache unavailable", 0 TDX calls, no image published', async () => {
  const env = baseEnv();
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
  assert.match(body.message, /CCTV candidate cache unavailable/);
  assert.equal(env.TRAFFIC_KV.store.size, 0, 'no published-image entry should have been written');
});

// --- 10. 0 usable frames -> no published image entry written ---

test('10. all 4 candidate frame fetches fail -> no published image is written, no imageUrl returned', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('gateway timeout', { status: 504 });

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-publish-test'), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.imageUrl, undefined);
  assert.match(body.message, /No CCTV footage/);

  const publishedKeys = [...env.TRAFFIC_KV.store.keys()].filter((k) => k.startsWith('cctv:published-image:'));
  assert.equal(publishedKeys.length, 0);
});

// --- 11. KV write fail -> no imageUrl returned ---

test('11. a KV write failure while publishing -> no imageUrl returned, clear error instead', async () => {
  const env = baseEnv({
    TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }, { failPutForKeyPrefix: 'cctv:published-image:' }),
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });

  // Direct handler call + test codec — see test 8's comment on why.
  const res = await handleHsinchuCctvPublishTest(
    env,
    new Request('https://traffic-reporter.example.workers.dev/admin/cctv-hsinchu-publish-test'),
    TEST_CODEC
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.imageUrl, undefined);
  assert.equal(body.published, undefined);
});

// --- 12. no secret ever appears in the response or the image URL ---

test('12. neither the publish-test response nor the public image URL ever contains ADMIN_PASSWORD, LINE token, TDX token, or a VideoStreamURL', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });

  // Direct handler call + test codec — see test 8's comment on why.
  const res = await handleHsinchuCctvPublishTest(
    env,
    new Request('https://traffic-reporter.example.workers.dev/admin/cctv-hsinchu-publish-test'),
    TEST_CODEC
  );
  const rawBody = await res.text();
  assert.doesNotMatch(rawBody, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(rawBody, new RegExp(LINE_CHANNEL_ACCESS_TOKEN));
  assert.doesNotMatch(rawBody, new RegExp(TDX_CLIENT_SECRET));
  for (const c of FOUR_CANDIDATES) assert.ok(!rawBody.includes(c.videoStreamUrl), `response must not leak VideoStreamURL: ${c.videoStreamUrl}`);

  const body = JSON.parse(rawBody);
  const imgRes = await worker.fetch(unauthedRequest(new URL(body.imageUrl).pathname), env);
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  assert.ok(!imgBytes.includes(Buffer.from(ADMIN_PASSWORD)));
  assert.ok(!imgBytes.includes(Buffer.from(LINE_CHANNEL_ACCESS_TOKEN)));
  assert.ok(!imgBytes.includes(Buffer.from(TDX_CLIENT_SECRET)));
});

// --- 13. the existing /admin/cctv-hsinchu-collage endpoint is unaffected by this round's refactor ---

test('13. GET /admin/cctv-hsinchu-collage still produces a normal collage JPEG after the V1.8.4 refactor', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
});
