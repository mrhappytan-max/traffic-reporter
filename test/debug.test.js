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

test('handleDebugTdx: one source failing (429) does not take down the other four', async () => {
  originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty')) {
      return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      // Must be Hsinchu-relevant (road + in-range KM) to survive the geo
      // filter that's now wired into the freeway source, see hsinchuFilter.js.
      return new Response(JSON.stringify({ RoadEvents: [realFreewayEvent] }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS/City/Hsinchu')) {
      return new Response(JSON.stringify({ CMSs: [{ CMSID: 'A', Message: '壅塞' }] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [{ AlertID: 'a1', Description: '繞道' }] }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const response = await handleDebugTdx(ENV);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.tokenOk, true);
  assert.equal(body.sources.length, 5);

  const freeway = body.sources.find((s) => s.source === 'freeway');
  const county = body.sources.find((s) => s.source === 'bus-hsinchu-county');

  assert.equal(freeway.ok, true);
  assert.equal(freeway.count, 1);

  assert.equal(county.ok, false);
  assert.equal(county.status, 429);
  assert.match(county.error, /429/);

  assert.equal(body.failedSources.length, 1);
  assert.equal(body.failedSources[0].source, 'bus-hsinchu-county');

  // 1 (freeway) + 0 (highway) + 1 (cms) + 1 (bus-hsinchu) + 0 (failed county) = 3
  assert.equal(body.totalNormalizedCount, 3);

  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /super-secret-value/);
});

test('handleDebugTdx: token failure still reports all 5 sources as failed, not a crash', async () => {
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
  assert.equal(body.sources.length, 5);
  assert.ok(body.sources.every((s) => s.ok === false));
  assert.equal(body.failedSources.length, 5);

  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /super-secret-value/);
});
