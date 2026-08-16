import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPbsUpstream, UpstreamError } from '../src/upstreamClient.js';

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

test('first attempt success -> attempts=1, rawText is byte-for-byte the upstream body', async () => {
  const raw = '[{"UID":"1","comment":"測試 中文 保留","x1":"120.9987"}]';
  const fetchImpl = async () => new Response(raw, { status: 200 });
  const result = await fetchPbsUpstream({ fetchImpl });
  assert.equal(result.attempts, 1);
  assert.equal(result.rawText, raw);
  assert.equal(typeof result.durationMs, 'number');
});

test('4xx does not retry — fails immediately with attempts=1', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  };
  await assert.rejects(
    () => fetchPbsUpstream({ fetchImpl }),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'http_status');
      assert.equal(err.attempts, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('5xx retries once and succeeds on the second attempt (attempts=2)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response('error', { status: 503 });
    return new Response('[]', { status: 200 });
  };
  const result = await fetchPbsUpstream({ fetchImpl });
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('timeout retries once and succeeds on the second attempt (attempts=2)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw abortError();
    return new Response('[]', { status: 200 });
  };
  const result = await fetchPbsUpstream({ fetchImpl });
  assert.equal(result.attempts, 2);
});

test('both attempts time out -> UpstreamError(code=timeout), attempts=2, no third request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw abortError();
  };
  await assert.rejects(
    () => fetchPbsUpstream({ fetchImpl }),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.code, 'timeout');
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test('both attempts return 5xx -> UpstreamError, attempts=2, no third request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('error', { status: 500 });
  };
  await assert.rejects(
    () => fetchPbsUpstream({ fetchImpl }),
    (err) => {
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test('network error retries once, and both-network-error also stops at attempts=2', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => fetchPbsUpstream({ fetchImpl }),
    (err) => {
      assert.equal(err.code, 'network');
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test('waits a real backoff (>=~250ms) between the first failure and the retry', async () => {
  const callTimes = [];
  let calls = 0;
  const fetchImpl = async () => {
    callTimes.push(Date.now());
    calls += 1;
    if (calls === 1) return new Response('error', { status: 503 });
    return new Response('[]', { status: 200 });
  };
  await fetchPbsUpstream({ fetchImpl });
  assert.equal(callTimes.length, 2);
  assert.ok(callTimes[1] - callTimes[0] >= 250, `expected a backoff, got ${callTimes[1] - callTimes[0]}ms`);
});

test('sends Accept + a plain, honest User-Agent; never Authorization or Cookie to upstream', async () => {
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedInit = init;
    return new Response('[]', { status: 200 });
  };
  await fetchPbsUpstream({ fetchImpl });
  assert.equal(capturedInit.headers.Accept, 'application/json');
  assert.match(capturedInit.headers['User-Agent'], /pbs-relay/);
  assert.equal(capturedInit.headers.Authorization, undefined);
  assert.equal(capturedInit.headers.Cookie, undefined);
});
