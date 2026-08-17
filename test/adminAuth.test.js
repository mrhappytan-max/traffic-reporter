// V1.6.3 — Admin Protection. Exercises the real Worker entry point
// (src/index.js's default export) end to end, since that's where the
// admin auth gate actually lives — see security/adminAuth.js.
//
// Final V1.6.3 shape: username is a fixed constant ("admin"), the ONLY
// Cloudflare Secret is ADMIN_PASSWORD — no first-run setup page, no
// Cookie session, no password ever stored in KV.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-7c1e';

function kv(initial) {
  const store = new Map();
  if (initial) {
    for (const [k, v] of Object.entries(initial)) store.set(k, v);
  }
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

function throwingFetch(label) {
  return async (...args) => {
    throw new Error(`unexpected ${label} call: ${JSON.stringify(args[0])}`);
  };
}

function healthySnapshot() {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    status: 'normal',
    tdx: { tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [], lastFetchedAt: new Date().toISOString(), scheduledThisRun: true, sleeping: false },
    pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
    line: { ready: true, enabledUsersCount: 1, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
    kv: { available: true },
    broadcast: { broadcastRelevantCount: 0, pendingTargetCount: 0, typeIneligibleCount: 0, ineligibleByReason: {}, incidentSuppressedCount: 0 },
  };
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// --- 1. /health, no Authorization -> 401 ---

test('1. GET /health with no Authorization header -> 401', async () => {
  const env = baseEnv();
  const res = await worker.fetch(getRequest('/health'), env);
  assert.equal(res.status, 401);
});

// --- 2. /health, wrong password -> 401 ---

test('2. GET /health with wrong password -> 401', async () => {
  const env = baseEnv();
  const res = await worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, 'wrong-password') }), env);
  assert.equal(res.status, 401);
});

test('2b. GET /health with wrong username -> 401', async () => {
  const env = baseEnv();
  const res = await worker.fetch(getRequest('/health', { auth: basicAuthHeader('wrong-user', ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 401);
});

// --- 3. /health, correct credentials -> proceeds into the real handler ---

test('3. GET /health with correct credentials (admin + ADMIN_PASSWORD) -> proceeds into handleHealth (200 with a snapshot present)', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ 'health:snapshot:v1': JSON.stringify(healthySnapshot()) }) });
  const res = await worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /路況播報員/);
});

test('3b. GET /health with correct credentials but no snapshot yet -> 503 from handleHealth itself (auth passed, this is the handler behaving normally)', async () => {
  const env = baseEnv(); // empty KV -> no snapshot
  const res = await worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /尚未有健康快照/); // handleHealth's own "no snapshot" page, not the auth 503
});

// --- 4. /debug/status, no auth -> 401, 0 TDX requests ---

test('4. GET /debug/status with no auth -> 401 and 0 TDX requests', async () => {
  const env = baseEnv();
  priorFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('TDX');
  const res = await worker.fetch(getRequest('/debug/status'), env);
  assert.equal(res.status, 401);
});

// --- 5. /debug/tdx, no auth -> 401, 0 TDX requests ---

test('5. GET /debug/tdx with no auth -> 401 and 0 TDX requests', async () => {
  const env = baseEnv();
  priorFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('TDX');
  const res = await worker.fetch(getRequest('/debug/tdx'), env);
  assert.equal(res.status, 401);
});

// --- 6. /debug/pbs, no auth -> 401, 0 PBS / 0 TDX requests ---

test('6. GET /debug/pbs with no auth -> 401 and 0 PBS/TDX requests', async () => {
  const env = baseEnv({
    PBS_RELAY_TOKEN: 'relay-token',
    PBS_RELAY_WINDOWS: { fetch: throwingFetch('PBS relay') },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('TDX');
  const res = await worker.fetch(getRequest('/debug/pbs'), env);
  assert.equal(res.status, 401);
});

// --- 7. /debug/pbs-vpc-probe, no auth -> 401, never touches VPC relay ---

test('7. GET /debug/pbs-vpc-probe with no auth -> 401 and never touches the VPC relay binding', async () => {
  const env = baseEnv({
    PBS_RELAY_TOKEN: 'relay-token',
    PBS_RELAY_WINDOWS: { fetch: throwingFetch('VPC relay') },
  });
  const res = await worker.fetch(getRequest('/debug/pbs-vpc-probe'), env);
  assert.equal(res.status, 401);
});

// --- 8. POST /webhook does NOT require Basic Auth ---

test('8. POST /webhook is not gated by admin auth (works with no ADMIN_PASSWORD configured at all)', async () => {
  const env = { TRAFFIC_KV: kv(), LINE_CHANNEL_SECRET: undefined }; // no ADMIN_PASSWORD at all
  const req = new Request('https://traffic-reporter.example.workers.dev/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  const res = await worker.fetch(req, env);
  // No LINE_CHANNEL_SECRET configured -> signature check fails (401 from
  // verifyLineSignature), but critically: no WWW-Authenticate challenge,
  // proving this never went through requireAdminAuth (which would have
  // returned 503 here since ADMIN_PASSWORD is also unset).
  assert.equal(res.headers.get('WWW-Authenticate'), null);
  assert.notEqual(res.status, 503);
});

// --- 9. Cron scheduled handler is unaffected by admin auth ---

test('9. scheduled() runs without ADMIN_PASSWORD configured at all', async () => {
  const env = { TRAFFIC_KV: kv() }; // no ADMIN_PASSWORD, no TDX/PBS/LINE config either
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  let waited;
  const ctx = { waitUntil: (p) => { waited = p; } };
  worker.scheduled({}, env, ctx);
  await waited; // should resolve without throwing
});

// --- 10/11. Missing ADMIN_PASSWORD -> 503 fail closed ---

test('10. ADMIN_PASSWORD missing -> protected endpoints fail closed with 503', async () => {
  const env = baseEnv({ ADMIN_PASSWORD: undefined });
  const res = await worker.fetch(getRequest('/health', { auth: basicAuthHeader('whatever', 'whatever') }), env);
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /Admin authentication is not configured/);
});

test('11. ADMIN_PASSWORD missing -> every protected endpoint fails closed with 503, not just /health', async () => {
  const env = baseEnv({ ADMIN_PASSWORD: undefined });
  for (const path of ['/health', '/debug/status', '/debug/tdx', '/debug/pbs', '/debug/pbs-vpc-probe']) {
    const res = await worker.fetch(getRequest(path), env); // no Authorization header at all
    assert.equal(res.status, 503, `expected 503 for ${path}`);
  }
});

test('10b. ADMIN_PASSWORD missing -> 503 even WITH a correct-looking username/wrong-guess password supplied', async () => {
  const env = baseEnv({ ADMIN_PASSWORD: undefined });
  const res = await worker.fetch(getRequest('/debug/tdx', { auth: basicAuthHeader(FIXED_USERNAME, 'anything') }), env);
  assert.equal(res.status, 503);
});

// --- 12. 401 responses carry WWW-Authenticate ---

test('12. 401 responses include a WWW-Authenticate header', async () => {
  const env = baseEnv();
  const res = await worker.fetch(getRequest('/health'), env);
  assert.equal(res.status, 401);
  const header = res.headers.get('WWW-Authenticate');
  assert.match(header, /^Basic realm="Traffic Reporter Admin"/);
  assert.match(header, /charset="UTF-8"/);
});

// --- 13. protected responses carry no-store/noindex headers (success, 401, 503 alike) ---

test('13. protected responses (200/401/503) all carry Cache-Control/Pragma/X-Robots-Tag/Referrer-Policy/X-Content-Type-Options', async () => {
  function assertSecurityHeaders(res) {
    assert.equal(res.headers.get('Cache-Control'), 'no-store, private');
    assert.equal(res.headers.get('Pragma'), 'no-cache');
    assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  }

  const env = baseEnv({ TRAFFIC_KV: kv({ 'health:snapshot:v1': JSON.stringify(healthySnapshot()) }) });

  const unauthed = await worker.fetch(getRequest('/health'), env);
  assert.equal(unauthed.status, 401);
  assertSecurityHeaders(unauthed);

  const authed = await worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
  assert.equal(authed.status, 200);
  assertSecurityHeaders(authed);
  // /health is HTML -> also gets the CSP. V1.7 hotfix added img-src
  // 'self' (for the Hsinchu CCTV probe page's same-origin <img> tags) —
  // confirm /health's own CSP still carries every other original
  // directive unchanged.
  const csp = authed.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /img-src 'self'/);
  assert.doesNotMatch(csp, /img-src \*/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);

  const misconfigured = await worker.fetch(getRequest('/debug/tdx'), baseEnv({ ADMIN_PASSWORD: undefined }));
  assert.equal(misconfigured.status, 503);
  assertSecurityHeaders(misconfigured);
});

test('13b. JSON debug endpoints do NOT get the HTML-only CSP header', async () => {
  const env = baseEnv();
  priorFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('TDX'); // will 401 before any fetch anyway
  const res = await worker.fetch(getRequest('/debug/tdx'), env);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Content-Security-Policy'), null);
});

// --- 14. ADMIN_PASSWORD never leaks into responses or logs ---

test('14. ADMIN_PASSWORD never appears in any response body across success/401/503', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ 'health:snapshot:v1': JSON.stringify(healthySnapshot()) }) });

  const responses = await Promise.all([
    worker.fetch(getRequest('/health'), env), // 401
    worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, 'wrong') }), env), // 401
    worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env), // 200
    worker.fetch(getRequest('/debug/tdx'), baseEnv({ ADMIN_PASSWORD: undefined })), // 503
  ]);

  for (const res of responses) {
    const body = await res.text();
    assert.doesNotMatch(body, new RegExp(ADMIN_PASSWORD));
  }
});

test('14b. ADMIN_PASSWORD never appears in console.log/console.error output', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv({ 'health:snapshot:v1': JSON.stringify(healthySnapshot()) }) });
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await worker.fetch(getRequest('/health'), env);
    await worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, 'wrong-pass') }), env);
    await worker.fetch(getRequest('/health', { auth: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) }), env);
    await worker.fetch(getRequest('/debug/tdx'), baseEnv({ ADMIN_PASSWORD: undefined }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const allLogs = logged.join('\n');
  assert.doesNotMatch(allLogs, new RegExp(ADMIN_PASSWORD));
});

// --- 15. no query-string bypass (?token=/?password=/etc) ---

test('15. query-string credentials (?token=/?password=/?user=) never bypass Basic Auth', async () => {
  const env = baseEnv();
  const attempts = [
    `/health?token=${encodeURIComponent(ADMIN_PASSWORD)}`,
    `/health?password=${encodeURIComponent(ADMIN_PASSWORD)}`,
    `/health?user=${encodeURIComponent(FIXED_USERNAME)}&pass=${encodeURIComponent(ADMIN_PASSWORD)}`,
    `/debug/status?admin_token=${encodeURIComponent(ADMIN_PASSWORD)}`,
  ];
  for (const path of attempts) {
    const res = await worker.fetch(getRequest(path), env); // no Authorization header
    assert.equal(res.status, 401, `expected 401 for ${path}`);
  }
});
