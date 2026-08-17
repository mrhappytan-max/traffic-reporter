// V1.7 next stage — GET /admin/cctv-hsinchu-probe + /admin/cctv-hsinchu-frame/0..4.
// Exercises the real Worker entry point end to end. No real TDX or
// Production calls anywhere in this file — every fetch is mocked.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';
import { extractFirstJpegFrame, MAX_FRAME_BYTES, PROBE_USED_KEY, CANDIDATES_KEY } from '../src/tdx/hsinchuCctvProbe.js';

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-hsinchu';
const TDX_CLIENT_ID = 'test-tdx-client-id-hsinchu';
const TDX_CLIENT_SECRET = 'test-tdx-client-secret-hsinchu';

function kv(initial, { failPutForValue } = {}) {
  const store = new Map();
  if (initial) for (const [k, v] of Object.entries(initial)) store.set(k, v);
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, _options) {
      if (failPutForValue && value === failPutForValue) throw new Error('KV write outage');
      store.set(key, value);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    ADMIN_PASSWORD,
    TDX_CLIENT_ID,
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

// --- Mock CCTV metadata: 9 records, only 5 should survive filter+rank ---

function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'N',
    LocationMile: '82K+020',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/stream/default.jpg',
    ...overrides,
  };
}

const MOCK_RECORDS = [
  cctvRecord({ CCTVID: 'CCTV-A', LocationMile: '82K+020', VideoStreamURL: 'https://cctv1.freeway.gov.tw/a.jpg' }), // dist 0.08
  cctvRecord({ CCTVID: 'CCTV-B', LocationMile: '82K+200', RoadDirection: 'S', VideoStreamURL: 'https://cctv2.freeway.gov.tw/b.jpg' }), // dist 0.10
  cctvRecord({ CCTVID: 'CCTV-C', LocationMile: '81K+800', VideoStreamURL: 'https://cctv3.freeway.gov.tw/c.jpg' }), // dist 0.30
  cctvRecord({ CCTVID: 'CCTV-D', LocationMile: '83K+000', VideoStreamURL: 'https://cctv4.freeway.gov.tw/d.jpg' }), // dist 0.90
  cctvRecord({ CCTVID: 'CCTV-E', LocationMile: '80K+500', VideoStreamURL: 'https://cctv5.freeway.gov.tw/e.jpg' }), // dist 1.60
  cctvRecord({ CCTVID: 'CCTV-F', LocationMile: '90K+000', VideoStreamURL: 'https://cctv6.freeway.gov.tw/f.jpg' }), // dist 7.90 -> excluded (6th nearest)
  cctvRecord({ CCTVID: 'CCTV-G', RoadID: '000030', RoadName: '國道3號', LocationMile: '82K+000' }), // wrong road -> excluded
  cctvRecord({ CCTVID: 'CCTV-H', LocationMile: '82K+050', VideoStreamURL: '' }), // no image URL -> excluded
  cctvRecord({ CCTVID: 'CCTV-I', LocationMile: 'N/A', VideoStreamURL: 'https://cctv9.freeway.gov.tw/i.jpg' }), // unparseable KM -> excluded
];

function makeFetch({ cctvStatus = 200, cctvRecords = MOCK_RECORDS, tokenStatus = 200 } = {}) {
  const tdxHits = [];

  const fetchFn = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      tdxHits.push({ kind: 'token', href });
      if (tokenStatus !== 200) return new Response('unauthorized', { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/CCTV/Freeway')) {
      tdxHits.push({ kind: 'cctv-metadata', href });
      if (cctvStatus !== 200) return new Response('error', { status: cctvStatus });
      return new Response(JSON.stringify({ CCTVs: cctvRecords }), { status: 200 });
    }
    throw new Error(`unexpected TDX-side fetch in test: ${href}`);
  };

  return { fetchFn, tdxHits };
}

function textBytes(str) {
  return new TextEncoder().encode(str);
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);

/** A well-behaved MJPEG stream: preamble, one complete JPEG frame, then trailing bytes for the "next" frame — must never be read if extraction stops correctly. */
function mjpegStreamThatHangsAfterFrame() {
  let pullCount = 0;
  return new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(textBytes('--myboundary\r\nContent-Type: image/jpeg\r\n\r\n'));
        return;
      }
      if (pullCount === 2) {
        controller.enqueue(JPEG_BYTES);
        return;
      }
      // A 3rd pull means extraction kept reading past the complete frame
      // — hang forever so the test itself fails/times out instead of
      // silently passing.
      return new Promise(() => {});
    },
  });
}

function oversizedStream() {
  const CHUNK = new Uint8Array(65536); // no FF D8/FF D9 anywhere in this data
  const chunkCount = Math.ceil((MAX_FRAME_BYTES + 65536) / CHUNK.length);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(CHUNK);
    },
  });
}

// Simulates a stalled upstream (connected, but the stream never produces
// a complete JPEG) that eventually errors out the way a real aborted
// fetch would. Uses its own setTimeout rather than actually observing
// the AbortSignal passed to fetch() — production code (extractFirstJpegFrame)
// legitimately relies on the standard, independently-verified Fetch API
// contract that `AbortSignal.timeout()` aborts an in-flight fetch/read;
// this test only needs to prove OUR code correctly classifies and
// reports that failure once it happens, which this simulates directly.
function hangingThenErrorsStream(delayMs) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(textBytes('--myboundary\r\n')); // no complete JPEG yet
      setTimeout(() => {
        controller.error(Object.assign(new Error('simulated timeout'), { name: 'AbortError' }));
      }, delayMs);
    },
  });
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// --- 1. not logged in -> 0 TDX calls ---

test('1. GET /admin/cctv-hsinchu-probe with no Authorization -> 401, 0 TDX calls', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 401);
  assert.equal(tdxHits.length, 0);
});

test('1b. GET /admin/cctv-hsinchu-frame/0 with no Authorization -> 401, 0 TDX calls', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 401);
  assert.equal(tdxHits.length, 0);
});

// --- 2. metadata called at most once, and selects the 5 nearest 國道1號 candidates ---

test('2. first legitimate run makes exactly 1 CCTV metadata call and selects the 5 nearest 國道1號 candidates in order', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  assert.equal(tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);

  const html = await res.text();
  const order = ['CCTV-A', 'CCTV-B', 'CCTV-C', 'CCTV-D', 'CCTV-E'];
  // All 5 candidates rendered as image tags pointing at frame endpoints 0-4.
  for (let i = 0; i < 5; i += 1) {
    assert.match(html, new RegExp(`/admin/cctv-hsinchu-frame/${i}`));
  }
  // Excluded records never leak into the page.
  assert.doesNotMatch(html, /CCTV-F|CCTV-G|CCTV-H|CCTV-I/);
  assert.match(html, /TDX CCTV metadata calls: 1/);
  assert.match(html, /CCTV candidates: 5/);

  const storedRaw = env.TRAFFIC_KV.store.get(CANDIDATES_KEY);
  const stored = JSON.parse(storedRaw);
  assert.deepEqual(stored.candidates.map((c) => c.cctvId), order);
  // Only the 6 allowed fields are persisted.
  for (const c of stored.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['cctvId', 'locationMile', 'positionLat', 'positionLon', 'roadDirection', 'videoStreamUrl'].sort());
  }
});

// --- 3. refresh after completion uses KV, 0 TDX calls ---

test('3. after completion, refreshing the probe page reads candidates from KV -> 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;
  const res1 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res1.status, 200);
  assert.equal(env.TRAFFIC_KV.store.get(PROBE_USED_KEY), 'completed');

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res2.status, 200);
  assert.equal(second.tdxHits.length, 0);
  const html2 = await res2.text();
  assert.match(html2, /CCTV candidates: 5/);
});

// --- 4. all 5 frame endpoints make 0 TDX calls ---

test('4. all 5 /admin/cctv-hsinchu-frame/N endpoints make 0 TDX calls', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env); // populates candidates KV

  const frameHits = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('tdx.transportdata.tw')) {
      frameHits.push(href);
      throw new Error('frame endpoints must never call TDX');
    }
    return new Response(mjpegStreamThatHangsAfterFrame(), { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' } });
  };

  for (let i = 0; i < 5; i += 1) {
    const res = await worker.fetch(authedRequest(`/admin/cctv-hsinchu-frame/${i}`), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  }
  assert.equal(frameHits.length, 0);
});

// --- 5. frame request carries no Authorization header ---

test('5. the frame fetch to freeway.gov.tw never includes an Authorization header', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);

  let sawAuthHeader = false;
  let sawFreewayCall = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('freeway.gov.tw')) {
      sawFreewayCall = true;
      if (init && init.headers && (init.headers.Authorization || init.headers.authorization)) sawAuthHeader = true;
      return new Response(mjpegStreamThatHangsAfterFrame(), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 200);
  assert.equal(sawFreewayCall, true);
  assert.equal(sawAuthHeader, false);
});

// --- 6. non-freeway.gov.tw URL is rejected ---

test('6. a candidate whose VideoStreamURL is not on *.freeway.gov.tw is rejected (400), never fetched', async () => {
  const env = baseEnv();
  await env.TRAFFIC_KV.put(
    PROBE_USED_KEY,
    'completed'
  );
  await env.TRAFFIC_KV.put(
    CANDIDATES_KEY,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidates: [{ cctvId: 'CCTV-EVIL', roadDirection: 'N', locationMile: '82K+000', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'https://evil.example.com/steal.jpg' }],
    })
  );

  let called = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    called = true;
    throw new Error(`must never fetch untrusted host: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('6b. a plain-http (non-https) VideoStreamURL is rejected, never fetched', async () => {
  const env = baseEnv();
  await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'completed');
  await env.TRAFFIC_KV.put(
    CANDIDATES_KEY,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidates: [{ cctvId: 'CCTV-HTTP', roadDirection: 'N', locationMile: '82K+000', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'http://cctv1.freeway.gov.tw/a.jpg' }],
    })
  );
  let called = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must never fetch a non-https URL');
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

// --- 7. MJPEG capture: extracts the first complete JPEG and stops reading ---

test('7. extractFirstJpegFrame captures exactly the first complete JPEG frame and stops reading the stream', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(mjpegStreamThatHangsAfterFrame(), { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [...JPEG_BYTES]);
});

// --- 8. over 2MB with no complete frame -> abort ---

test('8. a stream exceeding 2MB with no complete JPEG marker pair -> aborted, reason too-large', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(oversizedStream(), { status: 200 });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
});

// --- 9. timeout -> abort ---

test('9. a stalled stream is aborted once the timeout elapses', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(hangingThenErrorsStream(30), { status: 200 });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg', { timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

// --- 10. webhook / Cron entirely unaffected ---

test('10a. POST /webhook is unaffected by the new hsinchu endpoints existing', async () => {
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

test('10b. scheduled()/Cron is unaffected by the new hsinchu endpoints existing', async () => {
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

// --- extra: PRE-ARM guard mirrors tdx/cctvProbe.js's fix ---

test('PRE-ARM: metadata failure leaves KV "armed"; a refresh makes 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch({ cctvStatus: 500 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;
  const res1 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res1.status, 502);
  assert.equal(env.TRAFFIC_KV.store.get(PROBE_USED_KEY), 'armed');
  assert.equal(first.tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res2.status, 200);
  assert.equal(second.tdxHits.length, 0);
});

test('PRE-ARM: pre-arm KV.put failure -> 503, 0 TDX calls at all', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv(undefined, { failPutForValue: 'armed' }) });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 503);
  assert.equal(tdxHits.length, 0);
});

test('no secrets ever appear in the probe page or frame error responses', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  const raw = await res.text();
  assert.doesNotMatch(raw, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_ID));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_SECRET));
  assert.doesNotMatch(raw, /Bearer\s+\S+/);
});

// --- CSP hotfix: the probe page's same-origin <img> tags must not be blocked ---

test('CSP: /admin/cctv-hsinchu-probe HTML response includes img-src \'self\'', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /img-src 'self'/);
});

test('CSP: /admin/cctv-hsinchu-probe response never allows img-src *', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  const csp = res.headers.get('Content-Security-Policy');
  assert.doesNotMatch(csp, /img-src \*/);
  assert.doesNotMatch(csp, /img-src[^;]*freeway\.gov\.tw/); // never allow the CCTV host directly either
});

test('CSP: the /admin/cctv-hsinchu-frame/N image/jpeg response never gets the HTML-only CSP header', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env); // populates candidates KV

  globalThis.fetch = async () =>
    new Response(mjpegStreamThatHangsAfterFrame(), { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' } });

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(res.headers.get('Content-Security-Policy'), null);
});
