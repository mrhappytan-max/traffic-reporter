import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPbsUpstream, UpstreamError } from '../src/upstreamClient.js';

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function networkError({ code = 'ENOTFOUND', name = 'Error', message = 'getaddrinfo ENOTFOUND rtr.pbs.gov.tw' } = {}) {
  // Mirrors what undici's fetch actually throws for DNS/TLS/connection
  // failures: a TypeError('fetch failed') wrapping the real system error
  // in `.cause`.
  const cause = new Error(message);
  cause.name = name;
  cause.code = code;
  const err = new TypeError('fetch failed');
  err.cause = cause;
  return err;
}

function captureConsoleLog() {
  const lines = [];
  const original = console.log;
  console.log = (msg) => {
    lines.push(String(msg));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
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

// --- diagnostic logging (this round's addition) -----------------------

test('logs "[PBS] upstream success" with requestId/attempt/status/durationMs/contentType', async () => {
  const cap = captureConsoleLog();
  try {
    const fetchImpl = async () =>
      new Response('[{"UID":"1"}]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-success' });
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.includes('[PBS] upstream success'));
  assert.ok(line, 'expected an "[PBS] upstream success" log line');
  assert.match(line, /requestId=pbs-test-success/);
  assert.match(line, /attempt=1/);
  assert.match(line, /status=200/);
  assert.match(line, /durationMs=\d+/);
  assert.match(line, /contentType=application\/json/);
});

test('logs "[PBS] upstream timeout" with errorName on an AbortError', async () => {
  const cap = captureConsoleLog();
  let result;
  try {
    const fetchImpl = async () => {
      throw abortError();
    };
    result = await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-timeout' }).catch((e) => e);
  } finally {
    cap.restore();
  }
  assert.ok(result instanceof UpstreamError);
  const line = cap.lines.find((l) => l.includes('[PBS] upstream timeout'));
  assert.ok(line, 'expected an "[PBS] upstream timeout" log line');
  assert.match(line, /requestId=pbs-test-timeout/);
  assert.match(line, /attempt=1/);
  assert.match(line, /durationMs=\d+/);
  assert.match(line, /errorName=AbortError/);
});

test('logs "[PBS] upstream network error" with errorName/message on a plain network failure', async () => {
  const cap = captureConsoleLog();
  try {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-network' }).catch(() => {});
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.includes('[PBS] upstream network error'));
  assert.ok(line, 'expected an "[PBS] upstream network error" log line');
  assert.match(line, /requestId=pbs-test-network/);
  assert.match(line, /errorName=TypeError/);
});

test('DNS-style failure (err.cause.code=ENOTFOUND) logs causeCode', async () => {
  const cap = captureConsoleLog();
  let thrown;
  try {
    const fetchImpl = async () => {
      throw networkError({ code: 'ENOTFOUND' });
    };
    thrown = await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-dns' }).catch((e) => e);
  } finally {
    cap.restore();
  }
  assert.equal(thrown.causeCode, 'ENOTFOUND');
  const line = cap.lines.find((l) => l.includes('[PBS] upstream network error') && l.includes('requestId=pbs-test-dns'));
  assert.ok(line, 'expected a network-error log line for the DNS-style failure');
  assert.match(line, /causeCode=ENOTFOUND/);
});

test('5xx retry logs "[PBS] retry scheduled" with reason=5xx and a backoffMs', async () => {
  const cap = captureConsoleLog();
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return new Response('error', { status: 503 });
      return new Response('[]', { status: 200 });
    };
    await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-5xx-retry' });
  } finally {
    cap.restore();
  }
  const line = cap.lines.find((l) => l.includes('[PBS] retry scheduled'));
  assert.ok(line, 'expected a "[PBS] retry scheduled" log line');
  assert.match(line, /requestId=pbs-test-5xx-retry/);
  assert.match(line, /nextAttempt=2/);
  assert.match(line, /reason=5xx/);
  assert.match(line, /backoffMs=\d+/);
});

test('4xx logs "[PBS] no retry" with reason=4xx, never "[PBS] retry scheduled"', async () => {
  const cap = captureConsoleLog();
  try {
    const fetchImpl = async () => new Response('not found', { status: 404 });
    await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-4xx' }).catch(() => {});
  } finally {
    cap.restore();
  }
  const noRetryLine = cap.lines.find((l) => l.includes('[PBS] no retry'));
  assert.ok(noRetryLine, 'expected a "[PBS] no retry" log line');
  assert.match(noRetryLine, /requestId=pbs-test-4xx/);
  assert.match(noRetryLine, /reason=4xx/);
  assert.equal(
    cap.lines.some((l) => l.includes('[PBS] retry scheduled')),
    false
  );
});

test('RELAY_TOKEN / Authorization values never appear in any upstreamClient log line', async () => {
  const SECRET = 'super-secret-relay-token-should-never-log';
  const cap = captureConsoleLog();
  try {
    const fetchImpl = async () => new Response('error', { status: 500 });
    await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-secret' }).catch(() => {});
  } finally {
    cap.restore();
  }
  for (const line of cap.lines) {
    assert.doesNotMatch(line, new RegExp(SECRET));
    assert.doesNotMatch(line, /Bearer /);
    assert.doesNotMatch(line, /Authorization/i);
  }
});
