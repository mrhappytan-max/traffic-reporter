import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterNewEvents } from '../src/traffic/dedupe.js';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      this.lastPutOpts = opts;
    },
    store,
  };
}

const eventA = { source: 'freeway', rawId: 'FRW-1', title: 'A' };
const eventB = { source: 'freeway', rawId: 'FRW-2', title: 'B' };

test('filterNewEvents: without a KV binding, everything is pending (no crash)', async () => {
  const result = await filterNewEvents(undefined, [eventA, eventB]);
  assert.equal(result.kvAvailable, false);
  assert.equal(result.pending.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test('filterNewEvents: first sighting is pending, second sighting of the same source+rawId is a duplicate', async () => {
  const kv = createMockKV();

  const first = await filterNewEvents(kv, [eventA]);
  assert.equal(first.pending.length, 1);
  assert.equal(first.duplicates.length, 0);

  const second = await filterNewEvents(kv, [eventA]);
  assert.equal(second.pending.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(second.duplicates[0].rawId, 'FRW-1');
});

test('filterNewEvents: dedup key is source+rawId — same rawId on a different source is not a duplicate', async () => {
  const kv = createMockKV();
  await filterNewEvents(kv, [{ source: 'freeway', rawId: 'X1' }]);
  const result = await filterNewEvents(kv, [{ source: 'highway', rawId: 'X1' }]);
  assert.equal(result.pending.length, 1);
  assert.equal(result.duplicates.length, 0);
});

test('filterNewEvents: records a 24h TTL on kv.put', async () => {
  const kv = createMockKV();
  await filterNewEvents(kv, [eventA]);
  assert.equal(kv.lastPutOpts.expirationTtl, 60 * 60 * 24);
});

test('filterNewEvents: events without a rawId are never deduped (always pending, no key collisions)', async () => {
  const kv = createMockKV();
  const noId1 = { source: 'cms', rawId: '', title: 'one' };
  const noId2 = { source: 'cms', rawId: '', title: 'two' };

  const first = await filterNewEvents(kv, [noId1]);
  const second = await filterNewEvents(kv, [noId2]);

  assert.equal(first.pending.length, 1);
  assert.equal(second.pending.length, 1); // not treated as a duplicate of noId1
  assert.equal(second.duplicates.length, 0);
});

test('filterNewEvents: a KV error degrades to "treat as pending" instead of dropping the event', async () => {
  const brokenKv = {
    async get() {
      throw new Error('KV outage');
    },
    async put() {},
  };

  const result = await filterNewEvents(brokenKv, [eventA]);
  assert.equal(result.kvAvailable, true);
  assert.equal(result.pending.length, 1);
  assert.match(result.kvError, /KV outage/);
});
