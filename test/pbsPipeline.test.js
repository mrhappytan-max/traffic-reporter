import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPbsPipelinePreview, runPbsPipelineAndCommit } from '../src/pbs/pipeline.js';

function kv() {
  const store = new Map();
  return { store, async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, value); } };
}

test('PBS relay failure is isolated and does not commit lifecycle state', async () => {
  const TRAFFIC_KV = kv();
  const result = await runPbsPipelineAndCommit({
    TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'test-token',
    PBS_RELAY_WINDOWS: { fetch: async () => { throw new Error('tunnel offline'); } },
  });

  assert.equal(result.pbsOk, false);
  assert.equal(result.relayOk, false);
  assert.equal(result.committed, false);
  assert.equal(TRAFFIC_KV.store.size, 0);
});

test('PBS preview reads relay data without writing KV', async () => {
  const TRAFFIC_KV = kv();
  const result = await runPbsPipelinePreview({
    TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'test-token',
    PBS_RELAY_WINDOWS: { fetch: async () => new Response(JSON.stringify([]), { status: 200 }) },
  });

  assert.equal(result.pbsOk, true);
  assert.equal(result.pbsTransport, 'vpc-relay');
  assert.equal(TRAFFIC_KV.store.size, 0);
});
