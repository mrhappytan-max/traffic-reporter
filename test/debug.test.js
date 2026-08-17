import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { handleDebugTdx } from '../src/tdx/debug.js';
import { realFreewayEvent } from './fixtures.js';

const ENV = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'super-secret-value' };

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

// V1.6.2: GET /debug/tdx is restricted to PRODUCTION_TDX_SOURCE_IDS
// (freeway+highway only) — CMS/Bus Alert are retired from production
// entirely (V1.6.1) and must not be quietly re-fetched by this debug
// endpoint. At most 2 TDX data calls per request.

test('handleDebugTdx: only freeway+highway are fetched, never CMS/Bus Alert -> at most 2 TDX data calls', async () => {
  originalFetch = globalThis.fetch;
  const requestedUrls = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    requestedUrls.push(href);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      // Must be Hsinchu-relevant (road + in-range KM) to survive the geo
      // filter that's now wired into the freeway source, see hsinchuFilter.js.
      return new Response(JSON.stringify({ RoadEvents: [realFreewayEvent] }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const response = await handleDebugTdx(ENV);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.tokenOk, true);
  assert.equal(body.sources.length, 2);

  const freeway = body.sources.find((s) => s.source === 'freeway');
  const highway = body.sources.find((s) => s.source === 'highway');

  assert.equal(freeway.ok, true);
  assert.equal(freeway.count, 1);

  assert.equal(highway.ok, false);
  assert.equal(highway.status, 429);
  assert.match(highway.error, /429/);

  assert.equal(body.failedSources.length, 1);
  assert.equal(body.failedSources[0].source, 'highway');

  assert.equal(body.totalNormalizedCount, 1); // freeway only (highway failed)

  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /super-secret-value/);

  // The actual TDX-usage-reduction guarantee: never a CMS/Bus Alert call.
  assert.ok(!requestedUrls.some((u) => u.includes('/Road/Traffic/Live/CMS')));
  assert.ok(!requestedUrls.some((u) => u.includes('/Bus/Alert/City/Hsinchu')));
  assert.ok(!requestedUrls.some((u) => u.includes('/Bus/Alert/City/HsinchuCounty')));
  // Exactly 1 token call + 2 data calls (freeway + highway).
  const dataCalls = requestedUrls.filter((u) => !u.includes('openid-connect/token'));
  assert.equal(dataCalls.length, 2);
});

test('handleDebugTdx: token failure still reports both sources as failed, not a crash', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) {
      return new Response('unauthorized', { status: 401 });
    }
    throw new Error('should not call any TDX data endpoint without a token');
  };

  const response = await handleDebugTdx(ENV);
  assert.equal(response.status, 502);

  const body = await response.json();
  assert.equal(body.tokenOk, false);
  assert.equal(body.sources.length, 2);
  assert.ok(body.sources.every((s) => s.ok === false));
  assert.equal(body.failedSources.length, 2);

  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /super-secret-value/);
});
