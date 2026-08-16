import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePbsRequest as handlePbsRequestImpl } from '../src/pbsHandler.js';
import { createPbsCache, CACHE_TTL_MS } from '../src/cache.js';

const TOKEN = 'test-relay-token';

// Keep the existing core behavior assertions focused on PBS handling while
// adapting their old fixture field to the relay's new custom-header field.
function handlePbsRequest(args) {
  return handlePbsRequestImpl({
    ...args,
    tokenHeader: args.tokenHeader ?? (typeof args.authorizationHeader === 'string' && args.authorizationHeader.startsWith('Bearer ')
      ? args.authorizationHeader.slice(7)
      : args.authorizationHeader),
  });
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

test('no Authorization header -> 401, upstream never called', async () => {
  const cache = createPbsCache();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response('[]', { status: 200 });
  };
  const res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: undefined, fetchImpl });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('wrong token -> 401, upstream never called', async () => {
  const cache = createPbsCache();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response('[]', { status: 200 });
  };
  const res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: 'Bearer nope', fetchImpl });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('correct token + upstream success -> 200, X-PBS-Cache: MISS, body is the raw upstream JSON, unmodified', async () => {
  const cache = createPbsCache();
  const raw = '[{"UID":"PBS-1","modDttm":"2026-08-16 10:00:00","comment":"事故，內側車道，請小心慢行"}]';
  const fetchImpl = async () => new Response(raw, { status: 200 });
  const res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-PBS-Cache'], 'MISS');
  assert.equal(res.body, raw);
  assert.ok('X-PBS-Upstream-Duration-Ms' in res.headers);
});

test('a second call within the TTL is served from cache (HIT), upstream not called again', async () => {
  const cache = createPbsCache();
  const raw = '[{"UID":"PBS-2"}]';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(raw, { status: 200 });
  };
  const t0 = 1_000_000;
  const first = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, now: t0 });
  assert.equal(first.headers['X-PBS-Cache'], 'MISS');

  const second = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, now: t0 + 1000 });
  assert.equal(second.status, 200);
  assert.equal(second.headers['X-PBS-Cache'], 'HIT');
  assert.equal(second.body, raw);
  assert.equal(calls, 1); // upstream only ever hit once
});

test('cache expires after the 3-minute TTL -> refetches upstream (MISS again)', async () => {
  const cache = createPbsCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(`[{"UID":"call-${calls}"}]`, { status: 200 });
  };
  const t0 = 1_000_000;
  await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, now: t0 });

  const res2 = await handlePbsRequest({
    cache,
    relayToken: TOKEN,
    authorizationHeader: `Bearer ${TOKEN}`,
    fetchImpl,
    now: t0 + CACHE_TTL_MS + 1,
  });
  assert.equal(res2.headers['X-PBS-Cache'], 'MISS');
  assert.equal(calls, 2);
});

test('upstream fails but a stale cache exists -> 200 with X-PBS-Cache: STALE, old (unmodified) body returned', async () => {
  const cache = createPbsCache();
  const staleRaw = '[{"UID":"stale-event","comment":"舊資料"}]';
  const t0 = 1_000_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(staleRaw, { status: 200 }); // seeds the cache
    return new Response('error', { status: 500 }); // every call after that fails
  };
  await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, now: t0 });

  const res2 = await handlePbsRequest({
    cache,
    relayToken: TOKEN,
    authorizationHeader: `Bearer ${TOKEN}`,
    fetchImpl,
    now: t0 + CACHE_TTL_MS + 1, // force expiry so it actually tries upstream again
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.headers['X-PBS-Cache'], 'STALE');
  assert.equal(res2.body, staleRaw); // unmodified, not fabricated
});

test('upstream fails and there is no cache at all -> 502/504 structured error, no fabricated data', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => new Response('error', { status: 500 });
  const res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl });
  assert.ok(res.status === 502 || res.status === 504, `expected 502 or 504, got ${res.status}`);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'upstream_failed');
});

test('upstream timeout and no cache -> 504', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl });
  assert.equal(res.status, 504);
});

test('a 4xx from upstream (and no cache) surfaces as a structured error, not a 200', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => new Response('not found', { status: 404 });
  const res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl });
  assert.equal(res.status, 502);
});

test('RELAY_TOKEN never appears in the response body or headers, on success or failure', async () => {
  const cache = createPbsCache();

  const failFetch = async () => new Response('error', { status: 500 });
  const failRes = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: 'Bearer wrong-guess', fetchImpl: failFetch });
  assert.doesNotMatch(JSON.stringify(failRes), new RegExp(TOKEN));

  const okFetch = async () => new Response('[{"UID":"1"}]', { status: 200 });
  const okRes = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl: okFetch });
  assert.doesNotMatch(JSON.stringify(okRes), new RegExp(TOKEN));
});

// --- diagnostic logging (this round's addition) -----------------------

test('cache HIT is logged with the requestId, and request start/complete bracket it', async () => {
  const cache = createPbsCache();
  const raw = '[{"UID":"HIT-1"}]';
  const fetchImpl = async () => new Response(raw, { status: 200 });
  const t0 = 1_000_000;

  await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, now: t0, requestId: 'pbs-h-1' });

  const cap = captureConsoleLog();
  try {
    await handlePbsRequest({
      cache,
      relayToken: TOKEN,
      authorizationHeader: `Bearer ${TOKEN}`,
      fetchImpl,
      now: t0 + 1000,
      requestId: 'pbs-h-2',
    });
  } finally {
    cap.restore();
  }

  assert.ok(cap.lines.some((l) => l.includes('[PBS] request start') && l.includes('requestId=pbs-h-2') && l.includes('cacheStatus=HIT')));
  assert.ok(cap.lines.some((l) => l.includes('[PBS] cache HIT') && l.includes('requestId=pbs-h-2')));
  assert.ok(
    cap.lines.some((l) => l.includes('[PBS] request complete') && l.includes('requestId=pbs-h-2') && l.includes('cache=HIT') && l.includes('status=200'))
  );
});

test('cache MISS is logged on a fresh fetch', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => new Response('[{"UID":"MISS-1"}]', { status: 200 });

  const cap = captureConsoleLog();
  try {
    await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, requestId: 'pbs-h-miss' });
  } finally {
    cap.restore();
  }

  assert.ok(cap.lines.some((l) => l.includes('[PBS] request start') && l.includes('cacheStatus=MISS')));
  assert.ok(cap.lines.some((l) => l.includes('[PBS] cache MISS') && l.includes('requestId=pbs-h-miss')));
  assert.ok(cap.lines.some((l) => l.includes('[PBS] request complete') && l.includes('cache=MISS') && l.includes('status=200')));
});

test('STALE fallback is logged with cacheAgeMs when upstream fails but a cache exists', async () => {
  const cache = createPbsCache();
  const staleRaw = '[{"UID":"stale-1"}]';
  const t0 = 1_000_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(staleRaw, { status: 200 });
    return new Response('error', { status: 500 });
  };
  await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, now: t0, requestId: 'pbs-h-seed' });

  const cap = captureConsoleLog();
  try {
    await handlePbsRequest({
      cache,
      relayToken: TOKEN,
      authorizationHeader: `Bearer ${TOKEN}`,
      fetchImpl,
      now: t0 + CACHE_TTL_MS + 1,
      requestId: 'pbs-h-stale',
    });
  } finally {
    cap.restore();
  }

  assert.ok(cap.lines.some((l) => l.includes('[PBS] cache STALE') && l.includes('requestId=pbs-h-stale')));
  const staleLine = cap.lines.find((l) => l.includes('[PBS] stale fallback'));
  assert.ok(staleLine, 'expected a "[PBS] stale fallback" log line');
  assert.match(staleLine, /requestId=pbs-h-stale/);
  assert.match(staleLine, /cacheAgeMs=\d+/);
  assert.ok(cap.lines.some((l) => l.includes('[PBS] request complete') && l.includes('cache=STALE') && l.includes('status=200')));
});

test('"[PBS] no fallback cache" is logged when upstream fails and nothing was ever cached', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => new Response('error', { status: 500 });

  const cap = captureConsoleLog();
  try {
    await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, requestId: 'pbs-h-nofallback' });
  } finally {
    cap.restore();
  }

  assert.ok(cap.lines.some((l) => l.includes('[PBS] no fallback cache') && l.includes('requestId=pbs-h-nofallback')));
  assert.ok(cap.lines.some((l) => l.includes('[PBS] request complete') && l.includes('cache=NONE') && l.includes('status=502')));
});

test('a 401 (bad token) never emits any [PBS] diagnostic log line', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => new Response('[]', { status: 200 });

  const cap = captureConsoleLog();
  try {
    await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: 'Bearer wrong', fetchImpl });
  } finally {
    cap.restore();
  }

  assert.equal(
    cap.lines.some((l) => l.includes('[PBS]')),
    false
  );
});

test('the real Authorization header value and RELAY_TOKEN never appear in any [PBS] log line', async () => {
  const cache = createPbsCache();
  const fetchImpl = async () => new Response('error', { status: 500 });

  const cap = captureConsoleLog();
  try {
    await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, requestId: 'pbs-h-secret' });
  } finally {
    cap.restore();
  }

  assert.ok(cap.lines.length > 0, 'expected at least some log lines for this legitimate request');
  for (const line of cap.lines) {
    assert.doesNotMatch(line, new RegExp(TOKEN));
    assert.doesNotMatch(line, /Bearer /);
    assert.doesNotMatch(line, /Authorization/i);
  }
});

test('logging never touches the 1000-record-scale payload itself — success body stays exactly the raw upstream text', async () => {
  const cache = createPbsCache();
  const bigArray = Array.from({ length: 1000 }, (_, i) => ({ UID: `PBS-${i}`, comment: `事件 ${i}` }));
  const raw = JSON.stringify(bigArray);
  const fetchImpl = async () => new Response(raw, { status: 200 });

  const cap = captureConsoleLog();
  let res;
  try {
    res = await handlePbsRequest({ cache, relayToken: TOKEN, authorizationHeader: `Bearer ${TOKEN}`, fetchImpl, requestId: 'pbs-h-bulk' });
  } finally {
    cap.restore();
  }

  assert.equal(res.body, raw); // byte-for-byte, unmodified
  for (const line of cap.lines) {
    assert.ok(line.length < 2000, `log line unexpectedly long (${line.length} chars) — looks like the payload got dumped`);
  }
});
