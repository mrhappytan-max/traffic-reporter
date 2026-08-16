import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPbsData, PbsFetchError } from '../src/pbs/client.js';

function relayEnv(fetch) {
  return { PBS_RELAY_TOKEN: 'test-token', PBS_RELAY_WINDOWS: { fetch } };
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

test('fetchPbsData requests the PBS Windows VPC relay with the custom token header', async () => {
  let request;
  const result = await fetchPbsData(relayEnv(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify([{ UID: '1' }]), {
      status: 200,
      headers: { 'x-pbs-relay-cache': 'HIT', 'x-pbs-relay-upstream-duration-ms': '42' },
    });
  }));

  assert.equal(request.url, 'http://pbs-relay.internal/pbs');
  assert.equal(request.options.headers['X-PBS-Relay-Token'], 'test-token');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(result.items.length, 1);
  assert.equal(result.relayOk, true);
  assert.equal(result.relayCache, 'HIT');
  assert.equal(result.relayUpstreamDurationMs, 42);
});

test('fetchPbsData fails safely when binding or token is absent', async () => {
  await assert.rejects(fetchPbsData({ PBS_RELAY_TOKEN: 'test-token' }), (err) =>
    err instanceof PbsFetchError && err.attempts === 1 && err.relayConfigured === false
  );
  await assert.rejects(fetchPbsData({ PBS_RELAY_WINDOWS: { fetch: async () => new Response('[]') } }), (err) =>
    err instanceof PbsFetchError && err.attempts === 1 && err.relayConfigured === false
  );
});

test('fetchPbsData does not retry relay 401 and safely retries relay 502 once', async () => {
  for (const [status, expectedAttempts] of [[401, 1], [502, 2]]) {
    let calls = 0;
    await assert.rejects(fetchPbsData(relayEnv(async () => {
      calls += 1;
      return new Response('error', { status });
    })), (err) => err instanceof PbsFetchError && err.relayStatus === status && err.attempts === expectedAttempts);
    assert.equal(calls, expectedAttempts);
  }
});

test('fetchPbsData retries a relay fetch throw once and stays a PbsFetchError', async () => {
  let calls = 0;
  await assert.rejects(fetchPbsData(relayEnv(async () => {
    calls += 1;
    throw abortError();
  })), (err) => err instanceof PbsFetchError && err.attempts === 2 && err.relayOk === false);
  assert.equal(calls, 2);
});
