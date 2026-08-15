import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { handleDebugPbs } from '../src/pbs/debugPbs.js';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

const REAL_PBS_FIXTURE = {
  UID: 'PBS-2026-08150001',
  road: '',
  direction: '西行',
  areaNm: '(南寮竹東)-台68線',
  roadtype: '事故',
  comment: '西行在8.1公里處內側車道發生交通事故，請小心慢行',
  happendate: '2026-08-15',
  happentime: '22:14:00',
  modDttm: '2026-08-15 22:20:00',
  x1: '120.9987',
  y1: '24.7912',
  srcdetail: '民眾報案',
};

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

test('GET /debug/pbs is fully read-only: repeated calls never touch KV', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('pbs.gov.tw')) return new Response(JSON.stringify([REAL_PBS_FIXTURE]), { status: 200 });
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const before = kv.store.size;
  const res1 = await handleDebugPbs(env);
  const body1 = await res1.json();
  assert.equal(kv.store.size, before);

  await handleDebugPbs(env);
  assert.equal(kv.store.size, before);

  assert.equal(body1.pbsOk, true);
  assert.equal(body1.rawCount, 1);
  assert.equal(body1.hsinchuCount, 1);
  assert.equal(body1.pbsBroadcastEnabled, false);
});

test('GET /debug/pbs never calls the LINE API', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok' };
  originalFetch = globalThis.fetch;
  let lineCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) {
      lineCalled = true;
      return new Response('{}', { status: 200 });
    }
    if (String(url).includes('pbs.gov.tw')) return new Response(JSON.stringify([REAL_PBS_FIXTURE]), { status: 200 });
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  await handleDebugPbs(env);
  assert.equal(lineCalled, false);
});

test('GET /debug/pbs returns 502 when the PBS fetch itself fails, without crashing', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('pbs.gov.tw')) return new Response('error', { status: 500 });
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const res = await handleDebugPbs(env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.pbsOk, false);
  assert.match(body.pbsError, /500/);
});
