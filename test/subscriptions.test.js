import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSubscriptions,
  setUserEnabled,
  setGroupEnabled,
  isUserEnabled,
  isGroupEnabled,
} from '../src/traffic/subscriptions.js';

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

test('user is OFF by default', async () => {
  const kv = createMockKV();
  const state = await readSubscriptions(kv);
  assert.equal(isUserEnabled(state.subscriptions, 'U123'), false);
});

test('啟動播報 -> user ON, then 關閉播報/停止播報 -> user OFF', async () => {
  const kv = createMockKV();

  await setUserEnabled(kv, 'U123', true);
  let state = await readSubscriptions(kv);
  assert.equal(isUserEnabled(state.subscriptions, 'U123'), true);

  await setUserEnabled(kv, 'U123', false);
  state = await readSubscriptions(kv);
  assert.equal(isUserEnabled(state.subscriptions, 'U123'), false);
});

test('group is OFF by default, then can be turned ON and OFF independently of users', async () => {
  const kv = createMockKV();
  let state = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(state.subscriptions, 'C999'), false);

  await setGroupEnabled(kv, 'C999', true);
  state = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(state.subscriptions, 'C999'), true);
  assert.equal(isUserEnabled(state.subscriptions, 'C999'), false); // separate namespace

  await setGroupEnabled(kv, 'C999', false);
  state = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(state.subscriptions, 'C999'), false);
});

test('subscriptions key is never written with an expirationTtl', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true);
  await setGroupEnabled(kv, 'C1', true);
  assert.ok(kv.putCalls.length >= 2);
  for (const call of kv.putCalls) {
    assert.equal(call.options, undefined);
  }
});

test('readSubscriptions fails closed (kvAvailable=false) when TRAFFIC_KV is missing or throws', async () => {
  const noKv = await readSubscriptions(undefined);
  assert.equal(noKv.kvAvailable, false);

  const brokenKv = {
    async get() {
      throw new Error('KV outage');
    },
  };
  const broken = await readSubscriptions(brokenKv);
  assert.equal(broken.kvAvailable, false);
  assert.match(broken.kvError, /KV outage/);
});
