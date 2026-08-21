// V1.8.6.9 — Mobile-first Deployment Guard. Covers deploymentStatus.js's
// pure drift-detection logic, GET /version (public, minimal, no secrets
// leaked), GET /admin/deployment-status (Admin-Auth, full detail, 405),
// route/binding presence, and 0-upstream-calls.
//
// Since getDeploymentStatus() reads the REAL, checked-in
// src/generated/buildMetadata.js (a deliberate placeholder for local
// dev/test — see that file's own comment), these tests exercise the
// drift-detection RULES using synthetic BUILD_METADATA-shaped objects
// passed through the same pure logic, rather than depending on
// whatever this checkout's placeholder happens to contain at test time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  EXPECTED_BRANCH,
  EXPECTED_CRON,
  REQUIRED_BINDINGS,
  IMPORTANT_ROUTES,
  DASHBOARD_ONLY_CHECKS,
  getDeploymentStatus,
  getPublicVersionInfo,
  computeDriftReasons,
} from '../src/traffic/deploymentStatus.js';
import { APP_VERSION } from '../src/version.js';

// --- 1/2/3: the actual drift RULE, exercised against synthetic
// BUILD_METADATA-shaped fixtures (see computeDriftReasons's own comment
// for why this is factored out separately from getDeploymentStatus) ----

function metadata(overrides = {}) {
  return {
    deployedCommit: 'abc1234abc1234abc1234abc1234abc1234abcd',
    commitSource: 'git',
    deployedBranch: 'main',
    branchSource: 'git',
    expectedMainCommit: 'abc1234abc1234abc1234abc1234abc1234abcd',
    expectedMainCommitSource: 'git:origin/main',
    buildTime: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

test('1: deployedCommit == expectedMainCommit, branch == main -> no drift', () => {
  const reasons = computeDriftReasons(metadata());
  assert.deepEqual(reasons, []);
});

test('2: deployedCommit != expectedMainCommit (real, git-resolved comparison) -> drift', () => {
  const reasons = computeDriftReasons(metadata({ expectedMainCommit: 'ffffffffffffffffffffffffffffffffffffffff' }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /deployedCommit=.*!= expectedMainCommit=/);
});

test('2b: a merely-ASSUMED expectedMainCommit (expectedMainCommitSource not "git:") never flags a commit mismatch, even if the values happen to differ', () => {
  const reasons = computeDriftReasons(
    metadata({ expectedMainCommit: 'different-value-but-only-assumed', expectedMainCommitSource: 'assumed-same-as-deployed' })
  );
  assert.equal(reasons.length, 0, 'must never fabricate a mismatch from a value that was never actually compared');
});

test('3: deployedBranch != "main" -> drift', () => {
  const reasons = computeDriftReasons(metadata({ deployedBranch: 'feature/something' }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /deployedBranch="feature\/something"/);
});

test('multiple simultaneous drift reasons are all reported, not just the first', () => {
  const reasons = computeDriftReasons(
    metadata({ deployedBranch: 'feature/x', expectedMainCommit: 'zzzz', commitSource: 'git' })
  );
  assert.ok(reasons.length >= 2);
});

// --- driftDetected rules (pure, no I/O) — tested against the REAL
// getDeploymentStatus(), which reads the checked-in placeholder metadata
// (always "not-yet-generated" locally) — this is itself scenario 4
// ("missing build metadata -> explicit unknown/degraded"), verified
// directly rather than synthesized. ---------------------------------

test('4: missing/placeholder build metadata -> explicit drift, not silently "fine"', () => {
  const status = getDeploymentStatus({});
  assert.equal(status.driftDetected, true);
  assert.ok(status.driftReasons.some((r) => r.includes('commitSource')));
  assert.ok(status.driftReasons.some((r) => r.includes('branchSource')));
});

test('appVersion/schemaVersion come from src/version.js, not the generated file', () => {
  const status = getDeploymentStatus({});
  assert.equal(status.appVersion, APP_VERSION);
  assert.equal(typeof status.schemaVersion, 'number');
});

test('expectedBranch is always "main" (the sole canonical Production source)', () => {
  assert.equal(EXPECTED_BRANCH, 'main');
});

test('routes/bindings/dashboardOnlyChecks are non-empty and match the task\'s own required list', () => {
  const status = getDeploymentStatus({});
  const paths = status.routes.map((r) => r.path);
  for (const required of ['/health', '/admin/pipeline-trace', '/admin/pipeline-trace-view', '/admin/broadcast-provenance', '/admin/deployment-status']) {
    assert.ok(paths.includes(required), `missing route ${required}`);
  }
  assert.ok(paths.includes('/admin/deployment-status-view'));
  assert.ok(paths.includes('/version'));
  assert.equal(REQUIRED_BINDINGS.length, 3);
  assert.ok(DASHBOARD_ONLY_CHECKS.length > 0);
});

// --- 10: required binding presence check --------------------------------

test('10: bindings report present:true only when actually defined on env, never guessed', () => {
  const statusMissing = getDeploymentStatus({});
  assert.ok(statusMissing.bindings.every((b) => b.present === false));

  const statusPresent = getDeploymentStatus({ TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} });
  assert.ok(statusPresent.bindings.every((b) => b.present === true));
});

test('secrets are reported as booleans only, never their value', () => {
  const status = getDeploymentStatus({ ADMIN_PASSWORD: 'super-secret-value' });
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('super-secret-value'), false);
  const adminSecret = status.secrets.find((s) => s.name === 'ADMIN_PASSWORD');
  assert.equal(adminSecret.present, true);
});

// --- 11: expected cron static check --------------------------------------

test('11: cron reports the code-expected schedule and an explicit "cannot read Dashboard" note, never claims to have read the real trigger', () => {
  const status = getDeploymentStatus({});
  assert.equal(status.cron.expected, '*/10 * * * *');
  assert.equal(EXPECTED_CRON, '*/10 * * * *');
  assert.match(status.cron.note, /無法讀取 Cloudflare Dashboard/);
});

// --- 5: public /version does not leak sensitive info ---------------------

test('5: getPublicVersionInfo() exposes exactly the 5 documented fields, nothing else', () => {
  const info = getPublicVersionInfo();
  assert.deepEqual(Object.keys(info).sort(), ['appVersion', 'buildTime', 'deployedBranch', 'deployedCommit', 'service'].sort());
});

test('5: /version never contains a binding name, secret name, driftReasons, or dashboardOnlyChecks', () => {
  const info = getPublicVersionInfo();
  const serialized = JSON.stringify(info);
  for (const forbidden of ['TRAFFIC_KV', 'CCTV_IMAGES', 'PBS_RELAY_WINDOWS', 'ADMIN_PASSWORD', 'driftReasons', 'dashboardOnlyChecks', 'bindings', 'secrets', 'routes']) {
    assert.equal(serialized.includes(forbidden), false, `/version must never mention ${forbidden}`);
  }
});

// --- HTTP layer: GET /version, GET /admin/deployment-status via the real
// Worker entry point (src/index.js) --------------------------------------

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-deploy-status';

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function request(path, { method = 'GET', auth } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, { method, headers });
}

function throwingFetch(label) {
  return async (...args) => {
    throw new Error(`unexpected ${label} call: ${JSON.stringify(args[0])}`);
  };
}

let originalFetch;

// --- 6: public /version -----------------------------------------------

test('6: GET /version requires NO Authorization header -> 200', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/version'), {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.service, 'traffic-reporter');
    assert.ok('deployedCommit' in body);
    assert.ok('deployedBranch' in body);
    assert.ok('buildTime' in body);
    assert.ok('appVersion' in body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /version falls through to the generic 404 (same convention as the public "/" route)', async () => {
  const res = await worker.fetch(request('/version', { method: 'POST' }), {});
  assert.equal(res.status, 404);
});

// --- 8: Admin Auth on /admin/deployment-status ---------------------------

test('8: GET /admin/deployment-status with no Authorization -> 401', async () => {
  const env = { ADMIN_PASSWORD };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/admin/deployment-status'), env);
    assert.equal(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- 6: admin deployment-status full detail -------------------------------

test('6: GET /admin/deployment-status with correct credentials -> 200, full detail, Cache-Control no-store, 0 upstream calls', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/admin/deployment-status', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store, private');
    const body = await res.json();
    assert.ok(Array.isArray(body.routes));
    assert.ok(Array.isArray(body.bindings));
    assert.ok(Array.isArray(body.secrets));
    assert.ok(Array.isArray(body.driftReasons));
    assert.ok(Array.isArray(body.dashboardOnlyChecks));
    assert.equal(body.cron.expected, '*/10 * * * *');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- 7: non-GET -> 405 --------------------------------------------------

test('7: POST/PUT/DELETE /admin/deployment-status -> 405 even with valid credentials; POST without auth -> 401 (not 405)', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await worker.fetch(request('/admin/deployment-status', { method, auth }), env);
    assert.equal(res.status, 405, `expected 405 for ${method}`);
    assert.equal(res.headers.get('Allow'), 'GET');
  }
  const unauth = await worker.fetch(request('/admin/deployment-status', { method: 'POST' }), env);
  assert.equal(unauth.status, 401);
});

test('7: same 405 treatment for /admin/deployment-status-view', async () => {
  const env = { ADMIN_PASSWORD };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(request('/admin/deployment-status-view', { method: 'POST', auth }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
});

// --- 9: important route registry — every route this round names is
// actually reachable via the real Worker (not just listed in
// deploymentStatus.js's own constant) --------------------------------

test('9: every IMPORTANT_ROUTES entry actually resolves through the real Worker (200 or 401, never 404)', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    for (const path of IMPORTANT_ROUTES) {
      const res = await worker.fetch(request(path), env);
      assert.ok([200, 401].includes(res.status), `${path} returned ${res.status}, expected 200 or 401`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- 16: 0 upstream calls -------------------------------------------------

test('16: GET /version and GET /admin/deployment-status make 0 TDX/PBS/CCTV/LINE/GitHub/Cloudflare calls', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res1 = await worker.fetch(request('/version'), env);
    assert.equal(res1.status, 200);
    const res2 = await worker.fetch(request('/admin/deployment-status', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    assert.equal(res2.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
