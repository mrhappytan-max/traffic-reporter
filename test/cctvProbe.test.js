// V1.7 — one-time Production CCTV probe (GET /admin/cctv-probe).
// Exercises the real Worker entry point end to end (same style as
// adminAuth.test.js) so the auth gate + one-time-use KV guard + the
// hard 1-call TDX limit are all tested as actually wired together, not
// just in isolation.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-cctv-probe';
const TDX_CLIENT_ID = 'test-tdx-client-id-cctv';
const TDX_CLIENT_SECRET = 'test-tdx-client-secret-cctv';

function kv(initial) {
  const store = new Map();
  if (initial) for (const [k, v] of Object.entries(initial)) store.set(k, v);
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

function getRequest(path, { auth } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, { method: 'GET', headers });
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
function makeFetch({ cctvStatus = 200, cctvBody, imageStatus = 200, imageContentType = 'image/jpeg', requireImageAuth = false } = {}) {
  const tdxHits = [];
  const imageHits = [];

  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      tdxHits.push({ kind: 'token', href });
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

// --- 1. not logged in -> 401, 0 TDX calls ---

test('1. GET /admin/cctv-probe with no Authorization -> 401, 0 TDX calls', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe'), env);
  assert.equal(res.status, 401);
  assert.equal(tdxHits.length, 0);
});

// --- 2. ADMIN_PASSWORD missing -> 503, 0 TDX calls ---

test('2. GET /admin/cctv-probe with ADMIN_PASSWORD missing -> 503, 0 TDX calls', async () => {
  const env = baseEnv({ ADMIN_PASSWORD: undefined });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, 'anything') }), env);
  assert.equal(res.status, 503);
  assert.equal(tdxHits.length, 0);
});

// --- 3. KV already marked completed -> 200/409, 0 TDX calls ---

test('3. GET /admin/cctv-probe when KV already says completed -> 0 TDX calls, "Probe already completed"', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ 'admin:cctv-probe-used:v1': 'completed' }) });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.ok([200, 409].includes(res.status));
  const body = await res.json();
  assert.match(body.message, /Probe already completed/);
  assert.equal(tdxHits.length, 0);
});

// --- 4. first legitimate run -> at most 1 CCTV metadata call ---

test('4. first legitimate run makes exactly 1 CCTV metadata call (plus 1 token call, tracked separately)', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cctvMetadataCalls, 1);

  const cctvCalls = tdxHits.filter((h) => h.kind === 'cctv-metadata');
  assert.equal(cctvCalls.length, 1);
});

// --- 5. image fetch never includes an Authorization header ---

test('5. the image URL fetch never includes an Authorization header', async () => {
  const env = baseEnv();
  const { fetchFn, imageHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 200);
  assert.equal(imageHits.length, 1);
  assert.equal(imageHits[0].hasAuth, false);

  const body = await res.json();
  assert.equal(body.step2.attempted, true);
  assert.equal(body.step2.finalHostname, 'cctv-media.example.com');
});

// --- 6. metadata fetch failure does not retry ---

test('6. CCTV metadata fetch failure (500) -> exactly 1 attempt, no retry, error reported', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch({ cctvStatus: 500 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.equal(body.stage, 'cctv-metadata');

  const cctvCalls = tdxHits.filter((h) => h.kind === 'cctv-metadata');
  assert.equal(cctvCalls.length, 1); // exactly one attempt, no retry

  // A failed metadata attempt must NOT mark the one-time-use guard —
  // a legitimate future attempt should still be possible.
  assert.equal(env.TRAFFIC_KV.store.get('admin:cctv-probe-used:v1'), undefined);
});

// --- 7. after completion, a second call makes 0 TDX calls ---

test('7. after a successful run, a second call makes 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;

  const res1 = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res1.status, 200);
  assert.equal(env.TRAFFIC_KV.store.get('admin:cctv-probe-used:v1'), 'completed');

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(second.tdxHits.length, 0);
  const body2 = await res2.json();
  assert.match(body2.message, /Probe already completed/);
});

// --- 8. no secret/token ever appears in the response ---

test('8. response body never contains ADMIN_PASSWORD, TDX_CLIENT_ID, TDX_CLIENT_SECRET, or the access token', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  const raw = await res.text();
  assert.doesNotMatch(raw, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_ID));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_SECRET));
  assert.doesNotMatch(raw, /\btok\b/); // the mock access_token value itself
  assert.doesNotMatch(raw, /Bearer\s+\S+/);
});

test('8b. sensitive-looking query string is flagged, not echoed in full', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  const body = await res.json();
  assert.equal(body.step1.hasSensitiveQuery, true); // IMAGE_URL has sig=/expire=
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /sig=abc123/); // the actual query value must not be echoed verbatim
});

// --- 9. does not affect POST /webhook ---

test('9. POST /webhook is unaffected by /admin/cctv-probe existing', async () => {
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

// --- 10. does not affect the Cron scheduled handler ---

test('10. scheduled() is unaffected by /admin/cctv-probe existing', async () => {
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

// --- extra: verdict fields make sense for the "no TDX auth needed" happy path ---

test('11. happy-path verdict: candidateArchitecture set when image succeeds without auth and off the TDX host', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  const body = await res.json();
  assert.equal(body.step3.imageRequiresTdxAuthorization, false);
  assert.equal(body.step3.imageTrafficTouchesTdxHost, false);
  assert.equal(body.step3.likelyExtraTdxApiQuotaPerImage, 0);
  assert.match(body.step3.candidateArchitecture, /預期不需要額外 TDX API data call/);
});

test('12. verdict when the image itself requires TDX auth: candidateArchitecture stays null', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch({ requireImageAuth: true });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(getRequest('/admin/cctv-probe', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  const body = await res.json();
  assert.equal(body.step3.imageRequiresTdxAuthorization, true);
  assert.equal(body.step3.candidateArchitecture, null);
});
