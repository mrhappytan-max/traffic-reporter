import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPbsData, PbsFetchError } from '../src/pbs/client.js';

let originalFetch;

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

test('fetchPbsData returns { items, attempts: 1, durationMs } on a first-try success (bare array response)', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ UID: '1' }, { UID: '2' }]), { status: 200 });

  const result = await fetchPbsData();
  assert.equal(result.items.length, 2);
  assert.equal(result.attempts, 1);
  assert.equal(typeof result.durationMs, 'number');
});

test('fetchPbsData handles a wrapped-object response defensively', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ UID: '1' }] }), { status: 200 });

  const result = await fetchPbsData();
  assert.equal(result.items.length, 1);
  assert.equal(result.attempts, 1);
});

test('fetchPbsData does not retry on a 4xx (429) — fails immediately with attempts=1', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
  };

  await assert.rejects(
    () => fetchPbsData(),
    (err) => {
      assert.ok(err instanceof PbsFetchError);
      assert.equal(err.status, 429);
      assert.equal(err.attempts, 1);
      assert.equal(typeof err.durationMs, 'number');
      return true;
    }
  );
  assert.equal(callCount, 1);
});

test('fetchPbsData does not retry on a 404 — fails immediately with attempts=1', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  };

  await assert.rejects(
    () => fetchPbsData(),
    (err) => {
      assert.ok(err instanceof PbsFetchError);
      assert.equal(err.status, 404);
      assert.equal(err.attempts, 1);
      return true;
    }
  );
  assert.equal(callCount, 1);
});

test('fetchPbsData retries once on a 5xx and succeeds on the second attempt (attempts=2)', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) return new Response('error', { status: 503 });
    return new Response(JSON.stringify([{ UID: '1' }]), { status: 200 });
  };

  const result = await fetchPbsData();
  assert.equal(result.items.length, 1);
  assert.equal(result.attempts, 2);
  assert.equal(callCount, 2);
});

test('fetchPbsData retries once on a timeout and succeeds on the second attempt (attempts=2)', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) throw abortError();
    return new Response(JSON.stringify([{ UID: '1' }]), { status: 200 });
  };

  const result = await fetchPbsData();
  assert.equal(result.items.length, 1);
  assert.equal(result.attempts, 2);
  assert.equal(callCount, 2);
});

test('fetchPbsData retries once on a network error and succeeds on the second attempt (attempts=2)', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) throw new TypeError('network down');
    return new Response(JSON.stringify([{ UID: '1' }]), { status: 200 });
  };

  const result = await fetchPbsData();
  assert.equal(result.items.length, 1);
  assert.equal(result.attempts, 2);
});

test('fetchPbsData: both attempts time out -> throws PbsFetchError with attempts=2, no third request', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    throw abortError();
  };

  await assert.rejects(
    () => fetchPbsData(),
    (err) => {
      assert.ok(err instanceof PbsFetchError);
      assert.match(err.message, /timed out/);
      assert.equal(err.attempts, 2);
      assert.equal(typeof err.durationMs, 'number');
      return true;
    }
  );
  assert.equal(callCount, 2);
});

test('fetchPbsData: both attempts return 5xx -> throws PbsFetchError with attempts=2, no third request', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response('error', { status: 503 });
  };

  await assert.rejects(
    () => fetchPbsData(),
    (err) => {
      assert.ok(err instanceof PbsFetchError);
      assert.equal(err.status, 503);
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(callCount, 2);
});

test('fetchPbsData: both attempts hit network errors -> throws PbsFetchError with attempts=2', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    throw new TypeError('network down');
  };

  await assert.rejects(() => fetchPbsData(), (err) => {
    assert.ok(err instanceof PbsFetchError);
    assert.match(err.message, /network down/);
    assert.equal(err.attempts, 2);
    return true;
  });
  assert.equal(callCount, 2);
});

test('fetchPbsData waits a 300-1000ms backoff between a retryable failure and the retry', async () => {
  originalFetch = globalThis.fetch;
  let callCount = 0;
  const callTimes = [];
  globalThis.fetch = async () => {
    callTimes.push(Date.now());
    callCount += 1;
    if (callCount === 1) return new Response('error', { status: 503 });
    return new Response('[]', { status: 200 });
  };

  await fetchPbsData();
  assert.equal(callTimes.length, 2);
  const gap = callTimes[1] - callTimes[0];
  // Generous lower bound to avoid timer-jitter flakiness while still
  // proving a real backoff happened (not a tight retry loop).
  assert.ok(gap >= 250, `expected a backoff of at least ~300ms between attempts, got ${gap}ms`);
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
