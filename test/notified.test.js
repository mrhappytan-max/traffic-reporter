import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readNotifiedState,
  targetKey,
  targetNeedsNotification,
  applyNotifiedTargets,
  removePrunedEvents,
  persistNotifiedState,
  computeFingerprint,
} from '../src/traffic/notified.js';

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
const eventKeyStr = 'freeway:FRW-1';
const userA = { kind: 'user', id: 'U1' };
const groupB = { kind: 'group', id: 'C1' };

test('targetKey namespaces by kind so a user ID and group ID can never collide', () => {
  assert.equal(targetKey({ kind: 'user', id: 'X1' }), 'user:X1');
  assert.equal(targetKey({ kind: 'group', id: 'X1' }), 'group:X1');
  assert.notEqual(targetKey({ kind: 'user', id: 'X1' }), targetKey({ kind: 'group', id: 'X1' }));
});

test('a target never notified for this event needs notification', () => {
  assert.equal(targetNeedsNotification(eventKeyStr, userA, computeFingerprint(eventA), {}), true);
});

test('applyNotifiedTargets + targetNeedsNotification: per-target notified state', () => {
  const now = new Date('2026-08-15T09:00:00+08:00');
  const fp = computeFingerprint(eventA);

  let map = applyNotifiedTargets({}, eventKeyStr, fp, [userA], now);

  assert.equal(targetNeedsNotification(eventKeyStr, userA, fp, map), false); // userA now notified
  assert.equal(targetNeedsNotification(eventKeyStr, groupB, fp, map), true); // groupB untouched

  // Only userA's entry exists; groupB is independent.
  map = applyNotifiedTargets(map, eventKeyStr, fp, [groupB], now);
  assert.equal(targetNeedsNotification(eventKeyStr, groupB, fp, map), false);
  assert.equal(targetNeedsNotification(eventKeyStr, userA, fp, map), false); // still notified, untouched by groupB's update
});

test('a real content change makes an already-notified target need notification again; updatedAt-only does not', () => {
  const now = new Date('2026-08-15T09:00:00+08:00');
  const fp = computeFingerprint(eventA);
  const map = applyNotifiedTargets({}, eventKeyStr, fp, [userA], now);

  assert.equal(targetNeedsNotification(eventKeyStr, userA, computeFingerprint(eventAChanged), map), true);
  assert.equal(
    targetNeedsNotification(eventKeyStr, userA, computeFingerprint({ ...eventA, updatedAt: '2026-08-15T09:30:00+08:00' }), map),
    false
  );
});

test('removePrunedEvents drops only the listed keys, leaving everything else intact', () => {
  const now = new Date('2026-08-15T09:00:00+08:00');
  let map = applyNotifiedTargets({}, 'freeway:A1', 'fp1', [userA], now);
  map = applyNotifiedTargets(map, 'highway:B2', 'fp2', [userA], now);

  const pruned = removePrunedEvents(map, ['freeway:A1']);
  assert.equal('freeway:A1' in pruned, false);
  assert.equal('highway:B2' in pruned, true);
});

test('persistNotifiedState is never written with an expirationTtl, and stores lastLinePushAt + lastPartialPushFailureCount', async () => {
  const kv = createMockKV();
  const now = new Date('2026-08-15T09:05:00+08:00');
  await persistNotifiedState(kv, { [eventKeyStr]: { targets: {} } }, now.toISOString(), now, 2);

  const state = await readNotifiedState(kv);
  assert.equal(state.lastLinePushAt, now.toISOString());
  assert.equal(state.lastPartialPushFailureCount, 2);

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
