import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { handleDebugStatus } from '../src/traffic/debugStatus.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

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

// A real, Hsinchu-relevant, currently-active PBS accident — exactly the
// kind of event that, if this feature-flag boundary were broken, would
// leak into a LINE push.
const REAL_PBS_FIXTURE = {
  UID: 'PBS-2026-08150001',
  road: '',
  direction: '西行',
  areaNm: '(南寮竹東)-台68線',
  roadtype: '事故',
  comment: '西行在8.1公里處內側車道發生交通事故，請小心慢行',
  happendate: '2026-08-15',
  happentime: '10:14:00',
  modDttm: '2026-08-15 10:20:00',
  x1: '120.9987',
  y1: '24.7912',
  srcdetail: '民眾報案',
};

function mockFetch({ pbsItems = [], pbsStatus = 200, pbsAlwaysFail = false, linePushCalled }) {
  return async (url, init) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('RoadEvent/LiveEvent') || href.includes('/Road/Traffic/Live/CMS') || href.includes('/Bus/Alert')) {
      // No TDX events this run — isolates the test to PBS's own contribution.
      const isRoadEvents = href.includes('RoadEvent');
      const key = isRoadEvents ? 'RoadEvents' : href.includes('CMS') ? 'CMSs' : 'Alerts';
      return new Response(JSON.stringify({ [key]: [] }), { status: 200 });
    }
    if (href.includes('pbs.gov.tw')) {
      // pbsAlwaysFail simulates PBS being down across BOTH retry attempts
      // (see client.js's PBS_MAX_ATTEMPTS) — used to prove total PBS
      // failure never leaks into TDX/LINE.
      if (pbsAlwaysFail) return new Response('error', { status: 503 });
      return new Response(pbsStatus === 200 ? JSON.stringify(pbsItems) : 'error', { status: pbsStatus });
    }
    if (href.includes('api.line.me')) {
      linePushCalled.value = true;
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

function taipeiNowString() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

test('a real, active, Hsinchu-relevant PBS event never reaches runLineBroadcast, even with a subscriber and full broadcast hours', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const linePushCalled = { value: false };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ pbsItems: [REAL_PBS_FIXTURE], linePushCalled });

  // Establish the TDX baseline first (no LINE push happens on baseline
  // runs regardless), well within broadcast hours.
  const t0 = new Date('2026-08-15T10:00:00+08:00');
  await runScheduledTdxSync(env, t0);

  // Second run: TDX baseline already exists (steady state, nothing new
  // from TDX), PBS has a real active Hsinchu accident, hours are open,
  // a subscriber is enabled.
  const t1 = new Date('2026-08-15T10:05:00+08:00');
  const result = await runScheduledTdxSync(env, t1);

  assert.equal(result.pbs.pbsOk, true);
  assert.equal(result.pbs.activeCount, 1); // PBS DID recognize and track the event

  // But it never reached the LINE layer:
  assert.equal(result.line.broadcastRelevantCount, 0);
  assert.equal(result.line.pushSucceeded, 0);
  assert.equal(linePushCalled.value, false);
});

test('/debug/status reports the PBS event via pbsActiveCount, but broadcastRelevantCount/pendingTargetCount stay 0', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const linePushCalled = { value: false };
  originalFetch = globalThis.fetch;
  // handleDebugStatus uses the real wall clock internally (no injectable
  // `now`), so this fixture's modDttm must be "just now" in real time to
  // avoid being classified as stale by PBS_STALE_THRESHOLD_MS.
  const freshFixture = { ...REAL_PBS_FIXTURE, modDttm: taipeiNowString() };
  globalThis.fetch = mockFetch({ pbsItems: [freshFixture], linePushCalled });

  const response = await handleDebugStatus(env);
  const body = await response.json();

  assert.equal(body.pbsOk, true);
  assert.equal(body.pbsActiveCount, 1);
  assert.equal(body.pbsBroadcastEnabled, false);
  assert.equal(body.broadcastRelevantCount, 0); // TDX-only field, PBS not included
  assert.equal(body.pendingTargetCount, 0);
  assert.equal(linePushCalled.value, false);
});

test('PBS total failure (both retry attempts fail) never affects the TDX pipeline', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const linePushCalled = { value: false };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ pbsAlwaysFail: true, linePushCalled });

  const now = new Date('2026-08-15T10:00:00+08:00');
  const result = await runScheduledTdxSync(env, now);

  // PBS failed after exhausting both retry attempts...
  assert.equal(result.pbs.pbsOk, false);
  assert.equal(result.pbs.attempts, 2);

  // ...but TDX's own pipeline completed normally regardless (baseline
  // seeding on a first run — no crash, no missing fields).
  assert.equal(result.tokenOk, true);
  assert.equal(result.kvAvailable, true);
  assert.equal(Array.isArray(result.allEvents), true);
});

test('PBS total failure (both retry attempts fail) never affects the LINE broadcast pipeline', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const linePushCalled = { value: false };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ pbsAlwaysFail: true, linePushCalled });

  // Establish the TDX baseline first (steady state by t1).
  const t0 = new Date('2026-08-15T10:00:00+08:00');
  await runScheduledTdxSync(env, t0);

  const t1 = new Date('2026-08-15T10:05:00+08:00');
  const result = await runScheduledTdxSync(env, t1);

  assert.equal(result.pbs.pbsOk, false);
  assert.equal(result.pbs.attempts, 2);

  // LINE's own pipeline ran and reported normally — PBS's failure didn't
  // throw, didn't get counted as a LINE error, and didn't block pushes.
  assert.equal(result.line.lineReady, true);
  assert.equal(result.line.withinBroadcastHours, true);
  assert.deepEqual(result.line.lineErrors, []);
  assert.equal(linePushCalled.value, false); // nothing to push (no relevant TDX events)
});
