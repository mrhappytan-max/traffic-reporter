import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDebugPbs } from '../src/pbs/debugPbs.js';

function kv() {
  const store = new Map();
  return { store, async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, value); } };
}

function envWithRelay(TRAFFIC_KV, fetch) {
  return { TRAFFIC_KV, PBS_RELAY_TOKEN: 'debug-token', PBS_RELAY_WINDOWS: { fetch } };
}

test('GET /debug/pbs is read-only and exposes VPC relay diagnostics', async () => {
  const TRAFFIC_KV = kv();
  const env = envWithRelay(TRAFFIC_KV, async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'x-pbs-relay-cache': 'MISS', 'x-pbs-relay-upstream-duration-ms': '18' },
  }));
  const response = await handleDebugPbs(env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(TRAFFIC_KV.store.size, 0);
  assert.equal(body.pbsOk, true);
  assert.equal(body.pbsTransport, 'vpc-relay');
  assert.equal(body.relayConfigured, true);
  assert.equal(body.relayOk, true);
  assert.equal(body.relayStatus, 200);
  assert.equal(body.relayCache, 'MISS');
  assert.equal(body.relayUpstreamDurationMs, 18);
  assert.equal(body.pbsBroadcastEnabled, false);
  assert.doesNotMatch(JSON.stringify(body), /debug-token/);
});

test('GET /debug/pbs returns safe 502 output for a relay failure', async () => {
  const response = await handleDebugPbs(envWithRelay(kv(), async () => new Response('bad gateway', { status: 502 })));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.pbsOk, false);
  assert.equal(body.relayOk, false);
  assert.equal(body.relayStatus, 502);
  assert.equal(body.attempts, 2);
  assert.doesNotMatch(JSON.stringify(body), /Authorization|debug-token/);
});
