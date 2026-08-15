import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAccessToken, resetTdxTokenCache, TdxAuthError } from '../src/tdx/auth.js';

const FAKE_ENV = { TDX_CLIENT_ID: 'fake-id', TDX_CLIENT_SECRET: 'fake-secret' };

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
