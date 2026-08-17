// V1.7 — one-time Production CCTV probe (GET /admin/cctv-probe), PRE-ARM
// design. Exercises the real Worker entry point end to end (same style
// as adminAuth.test.js) so the auth gate + KV pre-arm guard + the hard
// 1-call TDX limit are all tested as actually wired together.
//
// Guiding principle under test: "寧可一次測試失敗，也不能因 refresh/retry
// 意外再次消耗 TDX" — once admin:cctv-probe-used:v1 is anything other
// than absent ('armed' or 'completed'), every subsequent request must
// make 0 TDX calls, no exceptions, no auto-reset.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-cctv-probe';
const TDX_CLIENT_ID = 'test-tdx-client-id-cctv';
const TDX_CLIENT_SECRET = 'test-tdx-client-secret-cctv';
const CCTV_PROBE_KEY = 'admin:cctv-probe-used:v1';

/** @param {object} [opts] - failPutForValue: throw on kv.put when the value being written matches this string. */
function kv(initial, { failPutForValue } = {}) {
  const store = new Map();
  if (initial) for (const [k, v] of Object.entries(initial)) store.set(k, v);
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
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

const IMAGE_HOST = 'https://cctv-media.example.com';
const IMAGE_URL = `${IMAGE_HOST}/stream/001.jpg?sig=abc123&expire=999999`;

function mockCctvRecord(overrides = {}) {
  return {
    CCTVID: 'CCTV-92K-N',
    RoadName: '國道一號',
    RoadDirection: 'N',
    LocationDescription: '92K+000',
    PositionLon: 120.9876,
    PositionLat: 24.8123,
    VideoStreamURL: IMAGE_URL,
    ...overrides,
  };
}

/** Tracks every TDX-side call (token + CCTV metadata) and every image-host call separately. */
function makeFetch({ cctvStatus = 200, cctvBody, tokenStatus = 200, imageStatus = 200, imageContentType = 'image/jpeg', requireImageAuth = false } = {}) {
  const tdxHits = [];
  const imageHits = [];

  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      tdxHits.push({ kind: 'token', href });
      if (tokenStatus !== 200) return new Response('unauthorized', { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/CCTV/Freeway')) {
      tdxHits.push({ kind: 'cctv-metadata', href, hadAuth: Boolean(init && init.headers && init.headers.Authorization) });
      if (cctvStatus !== 200) return new Response('error', { status: cctvStatus });
      return new Response(JSON.stringify(cctvBody ?? { CCTVs: [mockCctvRecord()] }), { status: 200 });
    }
    if (href.startsWith(IMAGE_HOST)) {
      const hasAuth = Boolean(init && init.headers && (init.headers.Authorization || init.headers.authorization));
      imageHits.push({ href, hasAuth });
      if (requireImageAuth && !hasAuth) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
      }
      return new Response('binary-jpeg-data', { status: imageStatus, headers: { 'Content-Type': imageContentType } });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };

  return { fetchFn, tdxHits, imageHits };
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// --- Admin Auth gate still applies first (unchanged from V1.6.3) ---

test('GET /admin/cctv-probe with no Authorization -> 401, 0 TDX calls', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(unauthedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 401);
  assert.equal(tdxHits.length, 0);
});

test('GET /admin/cctv-probe with ADMIN_PASSWORD missing -> 503, 0 TDX calls', async () => {
  const env = baseEnv({ ADMIN_PASSWORD: undefined });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 503);
  assert.equal(tdxHits.length, 0);
});

// --- A. pre-arm KV.put failure -> 503, 0 OAuth, 0 metadata ---

test('A. pre-arm KV.put failure -> 503, 0 OAuth calls, 0 CCTV metadata calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv(undefined, { failPutForValue: 'armed' }) });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.stage, 'pre-arm');
  assert.equal(tdxHits.filter((h) => h.kind === 'token').length, 0);
  assert.equal(tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 0);
  // The failed pre-arm write must not have left ANY state behind.
  assert.equal(env.TRAFFIC_KV.store.get(CCTV_PROBE_KEY), undefined);
});

// --- B. armed already present -> refresh -> 0 OAuth, 0 metadata ---

test('B. KV already "armed" -> 0 OAuth calls, 0 CCTV metadata calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CCTV_PROBE_KEY]: 'armed' }) });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'locked');
  assert.match(body.message, /Manual reset required/);
  assert.equal(tdxHits.length, 0);
});

// --- C. completed already present -> refresh -> 0 OAuth, 0 metadata ---

test('C. KV already "completed" -> 0 OAuth calls, 0 CCTV metadata calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ [CCTV_PROBE_KEY]: 'completed' }) });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'already-completed');
  assert.match(body.message, /Probe already completed/);
  assert.equal(tdxHits.length, 0);
});

// --- D. armed succeeds, then OAuth fails -> KV stays armed, next refresh 0 TDX calls ---

test('D. OAuth failure after successful pre-arm -> KV stays "armed"; a later refresh makes 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch({ tokenStatus: 401 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;

  const res1 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res1.status, 502);
  const body1 = await res1.json();
  assert.equal(body1.status, 'locked');
  assert.equal(body1.stage, 'oauth');
  assert.match(body1.message, /manual reset required/);
  assert.equal(env.TRAFFIC_KV.store.get(CCTV_PROBE_KEY), 'armed');
  assert.equal(first.tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 0);

  // Refresh — same env/KV, fresh fetch tracker.
  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.status, 'locked');
  assert.equal(second.tdxHits.length, 0);
});

// --- E. armed succeeds, OAuth succeeds, metadata fails -> KV stays armed, next refresh 0 TDX calls ---

test('E. CCTV metadata failure after successful OAuth -> exactly 1 metadata attempt, KV stays "armed", later refresh 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch({ cctvStatus: 500 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;

  const res1 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res1.status, 502);
  const body1 = await res1.json();
  assert.equal(body1.status, 'locked');
  assert.equal(body1.stage, 'cctv-metadata');
  assert.match(body1.message, /manual reset required/);
  assert.equal(first.tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1); // exactly once
  assert.equal(env.TRAFFIC_KV.store.get(CCTV_PROBE_KEY), 'armed');

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res2.status, 200);
  assert.equal(second.tdxHits.length, 0);
});

// --- F. metadata succeeds, completed written OK -> second refresh 0 TDX calls ---

test('F. successful metadata call writes "completed"; a second refresh makes 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;

  const res1 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res1.status, 200);
  assert.equal(env.TRAFFIC_KV.store.get(CCTV_PROBE_KEY), 'completed');
  assert.equal(first.tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(second.tdxHits.length, 0);
  const body2 = await res2.json();
  assert.equal(body2.status, 'already-completed');
});

// --- G. metadata succeeds but the completed write itself fails -> armed protection still holds ---

test('G. metadata succeeds but the final "completed" write fails -> KV stays "armed" (still locked), next refresh 0 TDX calls', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv(undefined, { failPutForValue: 'completed' }) });
  const first = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;

  const res1 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res1.status, 200); // the probe itself still succeeded — only the bookkeeping write failed
  const body1 = await res1.json();
  assert.equal(body1.completionWriteFailed, true);
  assert.equal(env.TRAFFIC_KV.store.get(CCTV_PROBE_KEY), 'armed'); // completed write failed -> stays armed, never reverts to absent

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.status, 'locked'); // still reads as "armed", not "absent"
  assert.equal(second.tdxHits.length, 0);
});

// --- H. happy path ---

test('H. happy path: exactly 1 CCTV metadata call, image fetch has no Authorization header', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits, imageHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cctvMetadataCalls, 1);
  assert.equal(tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);
  assert.equal(imageHits.length, 1);
  assert.equal(imageHits[0].hasAuth, false);
  assert.equal(body.step1.imageUrlHostname, 'cctv-media.example.com');
  assert.equal(body.step1.hasSensitiveQuery, true);
});

// --- I. does not affect POST /webhook ---

test('I. POST /webhook is unaffected by /admin/cctv-probe existing', async () => {
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

// --- J. does not affect the Cron scheduled handler ---

test('J. scheduled()/Cron is unaffected by /admin/cctv-probe existing', async () => {
  const env = { TRAFFIC_KV: kv() };
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  let waited;
  const ctx = { waitUntil: (p) => { waited = p; } };
  worker.scheduled({}, env, ctx);
  await waited; // resolves without throwing
});

// --- extra: no secrets leak; verdict logic ---

test('response body never contains ADMIN_PASSWORD, TDX_CLIENT_ID, TDX_CLIENT_SECRET, or the access token', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  const raw = await res.text();
  assert.doesNotMatch(raw, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_ID));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_SECRET));
  assert.doesNotMatch(raw, /\btok\b/); // the mock access_token value itself
  assert.doesNotMatch(raw, /Bearer\s+\S+/);
});

test('sensitive-looking query string value is never echoed in full', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  const body = await res.json();
  assert.equal(body.step1.hasSensitiveQuery, true);
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /sig=abc123/);
});

test('verdict: candidateArchitecture set when image succeeds without auth and off the TDX host', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  const body = await res.json();
  assert.equal(body.step3.imageRequiresTdxAuthorization, false);
  assert.equal(body.step3.imageTrafficTouchesTdxHost, false);
  assert.equal(body.step3.likelyExtraTdxApiQuotaPerImage, 0);
  assert.match(body.step3.candidateArchitecture, /預期不需要額外 TDX API data call/);
});

test('verdict: candidateArchitecture stays null when the image itself requires TDX auth', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch({ requireImageAuth: true });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  const body = await res.json();
  assert.equal(body.step3.imageRequiresTdxAuthorization, true);
  assert.equal(body.step3.candidateArchitecture, null);
});

test('KV read failure at the guard stage fails closed -> 503, 0 TDX calls', async () => {
  const brokenKv = {
    async get() {
      throw new Error('KV read outage');
    },
  };
  const env = baseEnv({ TRAFFIC_KV: brokenKv });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 503);
  assert.equal(tdxHits.length, 0);
});
