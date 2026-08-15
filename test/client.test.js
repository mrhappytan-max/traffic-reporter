import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTdxJson, TdxApiError } from '../src/tdx/client.js';

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('fetchTdxJson returns parsed JSON on success', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 });

  const data = await fetchTdxJson('https://example.invalid/x', 'token', { source: 'freeway' });
  assert.deepEqual(data, { hello: 'world' });
});

test('fetchTdxJson surfaces a 429 with a clear status and source', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });

  await assert.rejects(
    () => fetchTdxJson('https://example.invalid/x', 'token', { source: 'freeway' }),
    (err) => {
      assert.ok(err instanceof TdxApiError);
      assert.equal(err.status, 429);
      assert.equal(err.source, 'freeway');
      assert.match(err.message, /429/);
      assert.match(err.message, /freeway/);
      return true;
    }
  );
});

test('fetchTdxJson surfaces a 5xx with a clear status', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('Internal Server Error', { status: 503, statusText: 'Service Unavailable' });

  await assert.rejects(
    () => fetchTdxJson('https://example.invalid/x', 'token', { source: 'cms' }),
    (err) => {
      assert.ok(err instanceof TdxApiError);
      assert.equal(err.status, 503);
      return true;
    }
  );
});

test('fetchTdxJson never includes the bearer token in an error message', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });

  await assert.rejects(
    () => fetchTdxJson('https://example.invalid/x', 'super-secret-token', { source: 'highway' }),
    (err) => {
      assert.doesNotMatch(err.message, /super-secret-token/);
      return true;
    }
  );
});

test('fetchTdxJson wraps network failures without dropping the source name', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };

  await assert.rejects(
    () => fetchTdxJson('https://example.invalid/x', 'token', { source: 'bus-hsinchu' }),
    (err) => {
      assert.ok(err instanceof TdxApiError);
      assert.match(err.message, /bus-hsinchu/);
      return true;
    }
  );
});
