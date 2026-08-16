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

test('the upstream request carries no custom headers at all — equivalent to plain fetch(url), plus only the AbortSignal', async () => {
  // Regression test for the real 406 Not Acceptable bug: PBS only ever
  // serves text/plain;charset=UTF-8 and does real content negotiation
  // against Accept, so an `Accept: application/json` header (or any
  // other custom header) here reintroduces exactly that failure.
  let capturedInit;
  let capturedUrl;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response('[]', { status: 200 });
  };
  await fetchPbsUpstream({ fetchImpl });

  assert.equal(capturedUrl, 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata');
  assert.equal(capturedInit.headers, undefined, 'no headers object should be sent at all');
  assert.ok(capturedInit.signal instanceof AbortSignal);
  // Exactly one option beyond the URL: signal.
  assert.deepEqual(Object.keys(capturedInit), ['signal']);
});

test('mirrors the real PBS server behavior: an Accept header would get 406, so succeeds now that none is sent', async () => {
  // A mock upstream shaped exactly like PBS's real content-negotiation
  // behavior confirmed on Windows: 406 if an Accept header is present
  // (any value demanding a specific type PBS won't produce), 200
  // otherwise. This directly encodes the real bug so a regression
  // (re-adding an Accept header) fails this test immediately.
  const fetchImpl = async (url, init) => {
    if (init.headers && init.headers.Accept) {
      return new Response('Not Acceptable', { status: 406, statusText: 'Not Acceptable' });
    }
    return new Response('{"result":[{"UID":"1"}]}', {
      status: 200,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  };
  const result = await fetchPbsUpstream({ fetchImpl });
  assert.equal(result.rawText, '{"result":[{"UID":"1"}]}');
  assert.equal(result.attempts, 1);
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

// Regression test for the real bug fixed this round: fetch() resolving
// successfully (headers arrive, response.ok===true) does NOT guarantee
// the body finishes downloading cleanly — a connection reset mid-body
// (ECONNRESET) or an abort firing while streaming a large payload must
// be caught, classified, and logged exactly like a fetch()-level
// failure, and must still be retried. Previously this class of failure
// happened *after* the try/catch had already exited, so it escaped
// unclassified and unlogged.
function responseThatFailsDuringBodyRead(readError) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/plain;charset=UTF-8' },
    text: async () => {
      throw readError;
    },
  };
}

test('a body-read failure after a successful fetch() (e.g. connection reset) is classified as a network error, logged, and retried', async () => {
  const cap = captureConsoleLog();
  let calls = 0;
  let result;
  try {
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new TypeError('terminated');
        err.cause = Object.assign(new Error('read ECONNRESET'), { name: 'Error', code: 'ECONNRESET' });
        return responseThatFailsDuringBodyRead(err);
      }
      return new Response('[{"UID":"recovered"}]', { status: 200 });
    };
    result = await fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-bodyread' });
  } finally {
    cap.restore();
  }

  // It recovered on retry — this alone proves the failure was properly
  // classified as retryable (a plain uncaught exception would still
  // have worked by accident via the generic isRetryable(err)=>true
  // fallback, so the log assertions below are what actually prove the
  // fix, not just this outcome).
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);

  const errLine = cap.lines.find((l) => l.includes('[PBS] upstream network error') && l.includes('requestId=pbs-test-bodyread'));
  assert.ok(errLine, 'expected a "[PBS] upstream network error" line for the body-read failure — this used to never be logged');
  assert.match(errLine, /causeCode=ECONNRESET/);

  const retryLine = cap.lines.find((l) => l.includes('[PBS] retry scheduled') && l.includes('requestId=pbs-test-bodyread'));
  assert.ok(retryLine, 'expected a retry to be scheduled for the body-read failure');
  assert.match(retryLine, /reason=network/);
});

test('a body-read failure on both attempts -> UpstreamError(code=network), attempts=2, no crash', async () => {
  const fetchImpl = async () => {
    const err = new TypeError('terminated');
    err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return responseThatFailsDuringBodyRead(err);
  };
  await assert.rejects(
    () => fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-bodyread-2' }),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.code, 'network');
      assert.equal(err.causeCode, 'ECONNRESET');
      assert.equal(err.attempts, 2);
      return true;
    }
  );
});

test('an AbortError raised while reading the body (not just during connect) is classified as timeout', async () => {
  const fetchImpl = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return responseThatFailsDuringBodyRead(err);
  };
  await assert.rejects(
    () => fetchPbsUpstream({ fetchImpl, requestId: 'pbs-test-bodyread-timeout' }),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.code, 'timeout');
      return true;
    }
  );
});

test('success is based purely on HTTP 2xx + a readable body — a text/plain content-type and a {"result":[...]} envelope never cause a failure', async () => {
  // Mirrors the real PBS response exactly: Content-Type
  // text/plain;charset=UTF-8, body wrapped as {"result":[...]}. This
  // client must not inspect/validate either — it only proxies bytes.
  const raw = '{"result":[{"UID":"1","road":"","direction":"西行","areaNm":"測試路段"}]}';
  const fetchImpl = async () =>
    new Response(raw, { status: 200, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
  const result = await fetchPbsUpstream({ fetchImpl });
  assert.equal(result.rawText, raw); // byte-for-byte, envelope untouched
  assert.equal(result.contentType, 'text/plain;charset=UTF-8');
  assert.equal(result.attempts, 1);
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
