// V1.8 — GET /admin/cctv-hsinchu-collage.
//
// Error/boundary paths (Admin Auth, missing KV, all-fetches-fail,
// all-quadrants-empty, missing binding) exercise the real Worker entry
// point end to end (worker.fetch) — none of those paths ever reach
// hasAnySuccess=true, so they never touch the Workers-only WASM codec
// (see tdx/hsinchuCctvProbe.js's module comment) and run fine under
// plain Node.
//
// Paths that produce a REAL collage image call handleHsinchuCctvCollage
// directly with test/testJpegCodec.js's Node-compatible codec override
// — plain Node cannot load src/cctv/jpegCodecWorker.js's `.wasm` import
// (the genuine Cloudflare Workers WASM-loading mechanism), so those
// specific tests deliberately bypass worker.fetch()'s routing layer for
// the codec only. Admin Auth itself is still fully covered by test 1
// (401) plus tests 2/6/7/12, which all authenticate successfully via
// worker.fetch() and reach the handler (proven by getting handler-level
// 404/502/503 responses, not a 401) — so the auth boundary is exercised
// even though the "produces an image" tests don't re-prove it.
//
// Every CCTV frame fetch is mocked; the JPEG codec itself is real
// (@jsquash/jpeg, via the Node-side test codec) — no mocking of
// decode/encode, no network. No real TDX or Production calls anywhere
// in this file.
//
// This endpoint is strictly read-only against the candidates KV — it
// must never trigger /admin/cctv-hsinchu-probe, never write
// PROBE_USED_KEY, and never call TDX (no getAccessToken/fetchTdxJson
// anywhere in its code path) — see tdx/hsinchuCctvProbe.js's module
// comment and PROJECT_HANDOFF.md's V1.8 section.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';
import { PROBE_USED_KEY, CANDIDATES_KEY, handleHsinchuCctvCollage } from '../src/tdx/hsinchuCctvProbe.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-collage';

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

function baseEnv(overrides = {}) {
  return { ADMIN_PASSWORD, TRAFFIC_KV: kv(), ...overrides };
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

// --- 1. Admin Auth: unauthenticated -> 401, 0 CCTV fetch, 0 TDX ---

test('1. unauthenticated request -> 401, 0 CCTV fetch, 0 TDX calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch when unauthenticated: ${url}`);
  };

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-collage'), env);
  assert.equal(res.status, 401);
  assert.equal(fetchCalls, 0);
});

// --- 2. missing candidates KV -> clear message, no TDX ---

test('2. no cached candidates -> clear "CCTV candidate cache unavailable" message, 0 TDX calls, never triggers the probe', async () => {
  const env = baseEnv();
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-collage'), env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.message, /CCTV candidate cache unavailable/);
  assert.equal(fetchCalls, 0);
  // Never armed/triggered the probe's own one-time-use guard.
  assert.equal(env.TRAFFIC_KV.store.get(PROBE_USED_KEY), undefined);
});

// --- 3. all 4 candidates succeed -> one collage image, 0 TDX calls ---

test('3. all 4 candidates succeed -> a single image/jpeg collage, 0 TDX calls, at most 4 image fetches', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  let fetchCount = 0;
  let tdxHit = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    const href = String(url);
    if (href.includes('tdx.transportdata.tw')) {
      tdxHit = true;
      throw new Error('must never call TDX');
    }
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(tdxHit, false);
  assert.ok(fetchCount <= 4, `expected at most 4 image fetches, got ${fetchCount}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  // Never armed/triggered the probe's own one-time-use guard.
  assert.equal(env.TRAFFIC_KV.store.get(PROBE_USED_KEY), undefined);
});

// --- 4. one candidate fails (timeout-shaped) -> the rest still succeed ---

test('4. one candidate frame fetch fails -> the other 3 still succeed and a collage is still produced', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('cctv3.freeway.gov.tw')) return new Response('gateway timeout', { status: 504 });
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
});

// --- 5. a null quadrant slot renders fine alongside successes ---

test('5. a null (empty) quadrant slot alongside successful ones still produces a collage', async () => {
  const candidates = [FOUR_CANDIDATES[0], null, FOUR_CANDIDATES[2], FOUR_CANDIDATES[3]];
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(candidates) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
});

// --- 6. all 4 candidates fail -> no fake collage image ---

test('6. all 4 candidate frame fetches fail -> no image produced, clear error instead', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('gateway timeout', { status: 504 });

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-collage'), env);
  assert.equal(res.status, 502);
  assert.notEqual(res.headers.get('Content-Type'), 'image/jpeg');
  const body = await res.json();
  assert.match(body.message, /No CCTV footage/);
});

// --- 7. all-null candidates array (every quadrant empty) -> no fake collage ---

test('7. every quadrant empty (all null) -> no image produced', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope([null, null, null, null]) }) });
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`must never fetch a null slot: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-collage'), env);
  assert.equal(res.status, 502);
  assert.equal(fetchCalls, 0);
});

// --- 8. no Authorization header is ever sent to freeway.gov.tw ---

test('8. CCTV frame fetches never include an Authorization header', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  let sawAuthHeader = false;
  let sawAnyFreewayCall = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sawAnyFreewayCall = true;
    if (init && init.headers && (init.headers.Authorization || init.headers.authorization)) sawAuthHeader = true;
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  assert.equal(sawAnyFreewayCall, true);
  assert.equal(sawAuthHeader, false);
});

// --- 9. a candidate whose videoStreamUrl is not on *.freeway.gov.tw is rejected, never fetched ---

test('9. a candidate URL outside *.freeway.gov.tw is rejected (treated as failed), never fetched', async () => {
  const candidates = [
    { ...FOUR_CANDIDATES[0], videoStreamUrl: 'https://evil.example.com/steal.jpg' },
    FOUR_CANDIDATES[1],
    FOUR_CANDIDATES[2],
    FOUR_CANDIDATES[3],
  ];
  const env = baseEnv({ TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(candidates) }) });
  let sawEvilCall = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('evil.example.com')) {
      sawEvilCall = true;
      throw new Error('must never fetch an untrusted host');
    }
    return new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });
  };

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200); // the other 3 quadrants still succeed
  assert.equal(sawEvilCall, false);
});

// --- 10. webhook / Cron entirely unaffected ---

test('10a. POST /webhook is unaffected by the new collage endpoint existing', async () => {
  const env = { TRAFFIC_KV: kv(), LINE_CHANNEL_SECRET: undefined };
  const req = new Request('https://traffic-reporter.example.workers.dev/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.headers.get('WWW-Authenticate'), null);
  assert.notEqual(res.status, 503);
});

test('10b. scheduled()/Cron is unaffected by the new collage endpoint existing', async () => {
  const env = { TRAFFIC_KV: kv() };
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  let waited;
  const ctx = { waitUntil: (p) => { waited = p; } };
  worker.scheduled({}, env, ctx);
  await waited;
});

// --- 11. response never leaks secrets, tokens, or raw VideoStreamURL ---

test('11. the collage response never contains ADMIN_PASSWORD, TDX secrets, or raw VideoStreamURL values', async () => {
  const TDX_CLIENT_ID = 'test-tdx-client-id-collage';
  const TDX_CLIENT_SECRET = 'test-tdx-client-secret-collage';
  const env = baseEnv({ TDX_CLIENT_ID, TDX_CLIENT_SECRET, TRAFFIC_KV: kv({ [CANDIDATES_KEY]: candidatesEnvelope(FOUR_CANDIDATES) }) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(await makeSolidJpeg(100, 100, [80, 140, 200]), { status: 200 });

  const res = await handleHsinchuCctvCollage(env, TEST_CODEC);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  const asLatin1 = bytes.toString('latin1'); // scan raw bytes for any leaked ASCII secret text
  assert.doesNotMatch(asLatin1, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(asLatin1, new RegExp(TDX_CLIENT_ID));
  assert.doesNotMatch(asLatin1, new RegExp(TDX_CLIENT_SECRET));
  assert.doesNotMatch(asLatin1, /Bearer\s+\S+/);
  assert.doesNotMatch(asLatin1, /freeway\.gov\.tw/); // the raw stream URL text itself never appears in the pixel/JPEG payload
});

// --- 12. missing TRAFFIC_KV binding fails closed ---

test('12. missing TRAFFIC_KV binding -> 503, 0 fetches', async () => {
  const env = { ADMIN_PASSWORD };
  let fetchCalls = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must never fetch');
  };
  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-collage'), env);
  assert.equal(res.status, 503);
  assert.equal(fetchCalls, 0);
});
