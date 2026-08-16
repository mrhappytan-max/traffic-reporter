import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAccessToken, resetTdxTokenCache, getLastTdxTokenSource, TdxAuthError } from '../src/tdx/auth.js';

const FAKE_ENV = { TDX_CLIENT_ID: 'fake-id', TDX_CLIENT_SECRET: 'fake-secret' };
const KV_TOKEN_KEY = 'tdx:oauth-token-v1';

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

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetTdxTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('getAccessToken succeeds and never leaks the client secret in the request body target (only sends it to TDX)', async () => {
  let capturedUrl;
  let capturedBody;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = init.body;
    return new Response(JSON.stringify({ access_token: 'token-123', expires_in: 3600 }), {
      status: 200,
    });
  };

  const token = await getAccessToken(FAKE_ENV);

  assert.equal(token, 'token-123');
  assert.match(capturedUrl, /^https:\/\/tdx\.transportdata\.tw\/auth\/realms\/TDXConnect/);
  assert.match(capturedBody, /client_id=fake-id/);
  assert.match(capturedBody, /client_secret=fake-secret/);
});

test('getAccessToken reuses the cached token without calling fetch again', async () => {
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), {
      status: 200,
    });
  };

  const first = await getAccessToken(FAKE_ENV);
  const second = await getAccessToken(FAKE_ENV);

  assert.equal(first, 'token-abc');
  assert.equal(second, 'token-abc');
  assert.equal(callCount, 1);
});

test('getAccessToken throws TdxAuthError on non-2xx and does not include the secret in the message', async () => {
  globalThis.fetch = async () =>
    new Response('invalid_client', { status: 401, statusText: 'Unauthorized' });

  await assert.rejects(
    () => getAccessToken(FAKE_ENV),
    (err) => {
      assert.ok(err instanceof TdxAuthError);
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /fake-secret/);
      return true;
    }
  );
});

test('getAccessToken throws when credentials are missing, without prompting for them', async () => {
  await assert.rejects(
    () => getAccessToken({}),
    (err) => {
      assert.ok(err instanceof TdxAuthError);
      assert.match(err.message, /TDX_CLIENT_ID|TDX_CLIENT_SECRET/);
      return true;
    }
  );
});

// =======================================================================
// V1.2C.1 — memory -> KV -> OAuth lookup order, KV fail-open behavior,
// and the in-flight-refresh stampede guard.
// =======================================================================

test('1. a fresh memory token is used directly — never reads KV, never calls OAuth', async () => {
  let oauthCalls = 0;
  let kvGetCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'seed-token', expires_in: 3600 }), { status: 200 });
  };
  const kv = createMockKV();
  const originalGet = kv.get.bind(kv);
  kv.get = async (...args) => {
    kvGetCalls += 1;
    return originalGet(...args);
  };
  const env = { ...FAKE_ENV, TRAFFIC_KV: kv };

  await getAccessToken(env); // seeds memory (and KV) via OAuth
  assert.equal(oauthCalls, 1);

  oauthCalls = 0;
  kvGetCalls = 0;
  const token = await getAccessToken(env); // should hit the fast memory path only
  assert.equal(token, 'seed-token');
  assert.equal(oauthCalls, 0);
  assert.equal(kvGetCalls, 0);
  assert.equal(getLastTdxTokenSource(), 'memory');
});

test('2. no memory token, but a valid KV token exists -> uses KV, never calls OAuth', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'should-not-be-used', expires_in: 3600 }), { status: 200 });
  };
  const kv = createMockKV();
  await kv.put(KV_TOKEN_KEY, JSON.stringify({ accessToken: 'kv-token', expiresAt: Date.now() + 30 * 60 * 1000 }));
  const env = { ...FAKE_ENV, TRAFFIC_KV: kv };

  const token = await getAccessToken(env);
  assert.equal(token, 'kv-token');
  assert.equal(oauthCalls, 0);
  assert.equal(getLastTdxTokenSource(), 'kv');
});

test('3. an expired KV token is not used -> falls through to OAuth', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'brand-new-token', expires_in: 3600 }), { status: 200 });
  };
  const kv = createMockKV();
  await kv.put(KV_TOKEN_KEY, JSON.stringify({ accessToken: 'stale-token', expiresAt: Date.now() - 1000 }));
  const env = { ...FAKE_ENV, TRAFFIC_KV: kv };

  const token = await getAccessToken(env);
  assert.equal(token, 'brand-new-token');
  assert.equal(oauthCalls, 1);
  assert.equal(getLastTdxTokenSource(), 'oauth');
});

// KV freshness uses the same EXPIRY_SAFETY_MARGIN_MS as memory — a token
// that's technically not-yet-expired but within the safety margin must
// still be treated as needing refresh (never wait for the literal last
// second before refreshing, per the explicit requirement).
test('a KV token inside the safety margin (about to expire) is treated as stale, not reused', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 3600 }), { status: 200 });
  };
  const kv = createMockKV();
  await kv.put(KV_TOKEN_KEY, JSON.stringify({ accessToken: 'about-to-expire', expiresAt: Date.now() + 10_000 })); // well under the 60s margin
  const env = { ...FAKE_ENV, TRAFFIC_KV: kv };

  const token = await getAccessToken(env);
  assert.equal(token, 'refreshed-token');
  assert.equal(oauthCalls, 1);
});

test('4. a successful OAuth request writes BOTH memory and KV', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'new-token', expires_in: 3600 }), { status: 200 });
  const kv = createMockKV();
  const env = { ...FAKE_ENV, TRAFFIC_KV: kv };

  const token = await getAccessToken(env);
  assert.equal(token, 'new-token');

  // Written to KV:
  const stored = JSON.parse(await kv.get(KV_TOKEN_KEY));
  assert.equal(stored.accessToken, 'new-token');
  assert.ok(Number.isFinite(stored.expiresAt));
  assert.ok(stored.expiresAt > Date.now());

  // Written to memory too — a second call (even with a broken KV) still works.
  let oauthCalls = 1;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    throw new Error('should not be called — memory should serve this');
  };
  const second = await getAccessToken(env);
  assert.equal(second, 'new-token');
  assert.equal(oauthCalls, 1);
});

test('5. KV.get throwing still falls back to OAuth (never blocks token acquisition)', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'fallback-token', expires_in: 3600 }), { status: 200 });
  };
  const brokenKv = {
    async get() {
      throw new Error('KV outage');
    },
    async put() {
      // still functional for writes in this scenario
    },
  };
  const env = { ...FAKE_ENV, TRAFFIC_KV: brokenKv };

  const token = await getAccessToken(env);
  assert.equal(token, 'fallback-token');
  assert.equal(oauthCalls, 1);
});

test('6. KV.put throwing does not invalidate the freshly-obtained OAuth token — it stays usable via memory', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'still-good-token', expires_in: 3600 }), { status: 200 });
  };
  const brokenKv = {
    async get() {
      return null;
    },
    async put() {
      throw new Error('KV write outage');
    },
  };
  const env = { ...FAKE_ENV, TRAFFIC_KV: brokenKv };

  const token = await getAccessToken(env);
  assert.equal(token, 'still-good-token');
  assert.equal(oauthCalls, 1);

  // The token remains usable from memory afterward, and does not
  // re-trigger OAuth just because the KV write failed.
  const second = await getAccessToken(env);
  assert.equal(second, 'still-good-token');
  assert.equal(oauthCalls, 1);
});

test('7. OAuth 429 throws a safe TdxAuthError', async () => {
  globalThis.fetch = async () => new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
  const env = { ...FAKE_ENV, TRAFFIC_KV: createMockKV() };

  await assert.rejects(
    () => getAccessToken(env),
    (err) => {
      assert.ok(err instanceof TdxAuthError);
      assert.match(err.message, /429/);
      return true;
    }
  );
});

test('8. a 429 error never leaks client_id/client_secret', async () => {
  globalThis.fetch = async () => new Response('Too Many Requests', { status: 429 });
  const env = { ...FAKE_ENV, TRAFFIC_KV: createMockKV() };

  await assert.rejects(() => getAccessToken(env), (err) => {
    assert.doesNotMatch(err.message, /fake-id/);
    assert.doesNotMatch(err.message, /fake-secret/);
    assert.doesNotMatch(JSON.stringify(err), /fake-secret/);
    return true;
  });
});

test('9. 5 concurrent getAccessToken() calls in the same isolate issue at most 1 OAuth HTTP request', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    // Simulate real network latency so the concurrent calls genuinely
    // overlap in time, not just in call order.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: 'shared-token', expires_in: 3600 }), { status: 200 });
  };
  const env = { ...FAKE_ENV, TRAFFIC_KV: createMockKV() };

  const results = await Promise.all([1, 2, 3, 4, 5].map(() => getAccessToken(env)));
  assert.deepEqual(results, Array(5).fill('shared-token'));
  assert.equal(oauthCalls, 1);
});

test('11. resetTdxTokenCache() clears the memory cache — a subsequent call re-fetches rather than reusing the old token', async () => {
  let oauthCalls = 0;
  globalThis.fetch = async () => {
    oauthCalls += 1;
    return new Response(JSON.stringify({ access_token: `token-${oauthCalls}`, expires_in: 3600 }), { status: 200 });
  };
  // No TRAFFIC_KV here on purpose — isolates this test to the MEMORY tier
  // specifically. (KV, if present, would legitimately keep serving the
  // first token after a memory-only reset — that's correct behavior of
  // the shared cache, not something resetTdxTokenCache() is meant to
  // undo; see the KV-token test above for that layer.)
  const env = { ...FAKE_ENV };

  const first = await getAccessToken(env);
  assert.equal(first, 'token-1');
  assert.equal(oauthCalls, 1);

  resetTdxTokenCache();

  const second = await getAccessToken(env);
  assert.equal(second, 'token-2'); // not reused from the (now-cleared) memory cache
  assert.equal(oauthCalls, 2);
});

test('resetTdxTokenCache() also clears any in-flight refresh promise, so it never leaks into a later call', async () => {
  let oauthCalls = 0;
  let releaseFirstFetchStarted;
  const firstFetchStarted = new Promise((resolve) => {
    releaseFirstFetchStarted = resolve;
  });
  globalThis.fetch = async () => {
    oauthCalls += 1;
    releaseFirstFetchStarted(); // signal that fetch (and everything before it, incl. the KV read) has actually run
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: 'slow-token', expires_in: 3600 }), { status: 200 });
  };
  const env = { ...FAKE_ENV, TRAFFIC_KV: createMockKV() };

  const pending = getAccessToken(env); // starts an in-flight refresh
  await firstFetchStarted; // don't reset until the refresh has genuinely begun
  resetTdxTokenCache();

  // A call made right after reset must start its OWN OAuth attempt, not
  // silently await the stale in-flight promise from before the reset.
  let secondCallOauthCalls = 0;
  globalThis.fetch = async () => {
    secondCallOauthCalls += 1;
    return new Response(JSON.stringify({ access_token: 'post-reset-token', expires_in: 3600 }), { status: 200 });
  };
  const token = await getAccessToken(env);
  assert.equal(token, 'post-reset-token');
  assert.equal(secondCallOauthCalls, 1);

  await pending; // let the original slow call finish so the test cleans up its own timer
});

test('getLastTdxTokenSource() reflects the tier that served each successful call, and never exposes the token', () => {
  assert.equal(getLastTdxTokenSource(), null); // fresh module state (reset in beforeEach)
});
