// V1.8.6.9 — GET /admin/deployment-status-view: mobile-readable HTML,
// zero client-side JS, Admin Auth, 405, drift banner display.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-deploy-view';

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

test('GET /admin/deployment-status-view with no Authorization -> 401', async () => {
  const env = { ADMIN_PASSWORD };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/admin/deployment-status-view'), env);
    assert.equal(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('18: renders mobile-readable HTML — viewport meta, no client-side JS, Cache-Control no-store, correct CSP', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/admin/deployment-status-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store, private');
    assert.match(res.headers.get('Content-Security-Policy') || '', /default-src 'none'/);

    const html = await res.text();
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /部署狀態/);
    assert.match(html, /Bindings/);
    assert.match(html, /Cron/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('drift banner: 🔴 VERSION DRIFT shown when driftDetected (the checked-in placeholder metadata always drifts in this dev/test environment)', async () => {
  const env = { ADMIN_PASSWORD, TRAFFIC_KV: {}, CCTV_IMAGES: {}, PBS_RELAY_WINDOWS: {} };
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/admin/deployment-status-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /VERSION DRIFT/);
    assert.match(html, /Deployed:/);
    assert.match(html, /Expected:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing bindings show as ❌ 缺失, missing secrets show as ⚠️ 未設定 — never silently omitted', async () => {
  const env = { ADMIN_PASSWORD }; // no TRAFFIC_KV/CCTV_IMAGES/PBS_RELAY_WINDOWS at all
  originalFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch('upstream');
  try {
    const res = await worker.fetch(request('/admin/deployment-status-view', { auth: basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD) }), env);
    const html = await res.text();
    assert.match(html, /缺失/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /admin/deployment-status-view -> 405', async () => {
  const env = { ADMIN_PASSWORD };
  const auth = basicAuthHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
  const res = await worker.fetch(request('/admin/deployment-status-view', { method: 'POST', auth }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
});
