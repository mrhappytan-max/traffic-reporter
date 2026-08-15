import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPbsData, PbsFetchError } from '../src/pbs/client.js';

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('fetchPbsData returns the record array on success (bare array response)', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ UID: '1' }, { UID: '2' }]), { status: 200 });

  const data = await fetchPbsData();
  assert.equal(data.length, 2);
});

test('fetchPbsData handles a wrapped-object response defensively', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ UID: '1' }] }), { status: 200 });

  const data = await fetchPbsData();
  assert.equal(data.length, 1);
});

test('fetchPbsData throws PbsFetchError with status on a 429', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });

  await assert.rejects(
    () => fetchPbsData(),
    (err) => {
      assert.ok(err instanceof PbsFetchError);
      assert.equal(err.status, 429);
      return true;
    }
  );
});

test('fetchPbsData throws PbsFetchError on a 5xx', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('error', { status: 503 });

  await assert.rejects(() => fetchPbsData(), (err) => {
    assert.ok(err instanceof PbsFetchError);
    assert.equal(err.status, 503);
    return true;
  });
});

test('fetchPbsData throws PbsFetchError on a network error', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };

  await assert.rejects(() => fetchPbsData(), (err) => {
    assert.ok(err instanceof PbsFetchError);
    assert.match(err.message, /network down/);
    return true;
  });
});

test('fetchPbsData maps an AbortError (from the timeout controller) to a clear "timed out" PbsFetchError', async () => {
  // Simulates what happens once the real PBS_FETCH_TIMEOUT_MS elapses and
  // the AbortController fires, without actually waiting out that real
  // timeout in this test.
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  await assert.rejects(() => fetchPbsData(), (err) => {
    assert.ok(err instanceof PbsFetchError);
    assert.match(err.message, /timed out/);
    return true;
  });
});

test('fetchPbsData never requires an API key (no Authorization header sent)', async () => {
  originalFetch = globalThis.fetch;
  let capturedHeaders;
  globalThis.fetch = async (url, init) => {
    capturedHeaders = init.headers;
    return new Response('[]', { status: 200 });
  };

  await fetchPbsData();
  assert.equal(capturedHeaders.Authorization, undefined);
});
