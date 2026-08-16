import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllSources } from '../src/tdx/fetchAll.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';

const TDX_AUTH_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

const FAKE_ENV = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' };

test.beforeEach(() => {
  resetTdxTokenCache();
});

// 10. fetchAllSources fans out to all 5 TDX sources in one Promise.all, but
// must only request an OAuth token ONCE for the whole run — never once per
// source (freeway/highway/cms/bus-hsinchu/bus-hsinchu-county each getting
// their own token request is exactly the pre-V1.2C.1 bug pattern this
// guards against).
test('10. fetchAllSources fetching all 5 TDX sources in one run issues at most 1 OAuth token request', async () => {
  let oauthCalls = 0;
  const sourceCallsByUrl = new Map();

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr === TDX_AUTH_URL) {
      oauthCalls += 1;
      return new Response(JSON.stringify({ access_token: 'shared-token', expires_in: 3600 }), { status: 200 });
    }
    sourceCallsByUrl.set(urlStr, (sourceCallsByUrl.get(urlStr) || 0) + 1);
    // Empty-but-valid TDX payload shape — the content doesn't matter for
    // this test, only that each of the 5 sources gets fetched exactly once
    // and none of them trigger their own OAuth call.
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const { tokenOk, results } = await fetchAllSources(FAKE_ENV);

  assert.equal(tokenOk, true);
  assert.equal(oauthCalls, 1); // the whole point of this test
  assert.equal(results.length, 5);
  // Every source got its own HTTP call (nobody silently skipped), but each
  // exactly once — i.e. the fan-out is real, it just shares one token.
  assert.equal(sourceCallsByUrl.size, 5);
  for (const count of sourceCallsByUrl.values()) {
    assert.equal(count, 1);
  }
  for (const result of results) {
    assert.equal(result.ok, true);
  }
});

test('10b. if OAuth itself 429s, all 5 sources share the SAME token failure — not 5 independent OAuth attempts', async () => {
  let oauthCalls = 0;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr === TDX_AUTH_URL) {
      oauthCalls += 1;
      return new Response('rate limited', { status: 429 });
    }
    throw new Error('a TDX source endpoint should never be reached without a token');
  };

  const { tokenOk, results } = await fetchAllSources(FAKE_ENV);

  assert.equal(tokenOk, false);
  assert.equal(oauthCalls, 1); // not 5 — one failure is shared across all sources
  assert.equal(results.length, 5);
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.match(result.error, /TDX token unavailable/);
    // Never leaks the 429 body / credentials into the per-source error.
    assert.doesNotMatch(result.error, /secret/i);
  }
});
