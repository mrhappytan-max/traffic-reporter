import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNotifiedState, needsNotification, markNotified } from '../src/traffic/notified.js';

function createMockKV() {
  const store = new Map();
  const putCalls = [];
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      store.set(key, value);
      putCalls.push({ key, options });
    },
    store,
    putCalls,
  };
}

const eventA = { source: 'freeway', rawId: 'FRW-1', type: 'accident', description: '事故', direction: '北向' };
const eventAChanged = { ...eventA, description: '事故已排除' };
const eventATimestampOnly = { ...eventA, updatedAt: '2026-08-15T09:00:00+08:00' };

test('a never-notified event needs notification', async () => {
  const state = await readNotifiedState(createMockKV());
  assert.equal(needsNotification(eventA, state.notifiedMap), true);
});

test('after markNotified, the identical event no longer needs notification (39/40: first push, second identical -> no push)', async () => {
  const kv = createMockKV();
  let state = await readNotifiedState(kv);
  assert.equal(needsNotification(eventA, state.notifiedMap), true);

  await markNotified(kv, state.notifiedMap, [eventA]);

  state = await readNotifiedState(kv);
  assert.equal(needsNotification(eventA, state.notifiedMap), false);
  assert.equal(needsNotification(eventATimestampOnly, state.notifiedMap), false); // 42: updatedAt-only -> no push
});

test('a real content change re-triggers notification (41: major update -> can push again)', async () => {
  const kv = createMockKV();
  let state = await readNotifiedState(kv);
  await markNotified(kv, state.notifiedMap, [eventA]);

  state = await readNotifiedState(kv);
  assert.equal(needsNotification(eventAChanged, state.notifiedMap), true);
});

test('markNotified records lastLinePushAt, and the notified key is never written with an expirationTtl', async () => {
  const kv = createMockKV();
  const state = await readNotifiedState(kv);
  const now = new Date('2026-08-15T09:05:00+08:00');
  await markNotified(kv, state.notifiedMap, [eventA], now, now.toISOString());

  const after = await readNotifiedState(kv);
  assert.equal(after.lastLinePushAt, now.toISOString());

  for (const call of kv.putCalls) {
    assert.equal(call.options, undefined);
  }
});

test('readNotifiedState fails closed when TRAFFIC_KV is missing or throws', async () => {
  const noKv = await readNotifiedState(undefined);
  assert.equal(noKv.kvAvailable, false);

  const brokenKv = {
    async get() {
      throw new Error('KV outage');
    },
  };
  const broken = await readNotifiedState(brokenKv);
  assert.equal(broken.kvAvailable, false);
});
