import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePbsRequest } from '../src/pbsHandler.js';
import { createPbsCache, CACHE_TTL_MS } from '../src/cache.js';

const TOKEN = 'test-relay-token';

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
