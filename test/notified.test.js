import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readNotifiedState,
  targetKey,
  targetNeedsNotification,
  targetNeedsCongestionNotification,
  applyNotifiedTargets,
  removePrunedEvents,
  persistNotifiedState,
  computeFingerprint,
  computeNotificationFingerprint,
  CONGESTION_COOLDOWN_MS,
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

// --- V1.2C: congestion cooldown ---------------------------------------

test('CONGESTION_COOLDOWN_MS is 30 minutes', () => {
  assert.equal(CONGESTION_COOLDOWN_MS, 30 * 60 * 1000);
});

test('12. first time for a corridor -> needs notification', () => {
  const key = 'congestion:國道一號:北向:83-91';
  assert.equal(targetNeedsCongestionNotification(key, userA, {}, new Date('2026-08-16T10:50:00+08:00')), true);
});

test('13-15. within 30 minutes of the last notification -> never needs notification again, regardless of fingerprint', () => {
  const key = 'congestion:國道一號:北向:83-91';
  const t0 = new Date('2026-08-16T10:50:00+08:00');
  const map = applyNotifiedTargets({}, key, 'fp-at-10:50', [userA], t0);

  for (const minutesLater of [5, 10, 25]) {
    const now = new Date(t0.getTime() + minutesLater * 60 * 1000);
    assert.equal(
      targetNeedsCongestionNotification(key, userA, map, now),
      false,
      `${minutesLater} minutes later should still be within cooldown`
    );
  }
});

test('a fingerprint change during the cooldown window still does not re-trigger notification (time-based, not content-based)', () => {
  const key = 'congestion:國道一號:北向:83-91';
  const t0 = new Date('2026-08-16T10:50:00+08:00');
  const map = applyNotifiedTargets({}, key, 'fp-original', [userA], t0);
  const tenMinLater = new Date(t0.getTime() + 10 * 60 * 1000);
  // targetNeedsCongestionNotification doesn't even take a fingerprint —
  // this documents that KM churn (a different fingerprint) is ignored.
  assert.equal(targetNeedsCongestionNotification(key, userA, map, tenMinLater), false);
});

test('16. exactly at and past 30 minutes -> eligible again', () => {
  const key = 'congestion:國道一號:北向:83-91';
  const t0 = new Date('2026-08-16T10:50:00+08:00');
  const map = applyNotifiedTargets({}, key, 'fp', [userA], t0);

  const exactly30 = new Date(t0.getTime() + CONGESTION_COOLDOWN_MS);
  assert.equal(targetNeedsCongestionNotification(key, userA, map, exactly30), true);

  const past30 = new Date(t0.getTime() + CONGESTION_COOLDOWN_MS + 60 * 1000);
  assert.equal(targetNeedsCongestionNotification(key, userA, map, past30), true);
});

test('17. different targets have fully independent cooldowns for the same corridor', () => {
  const key = 'congestion:國道一號:北向:83-91';
  const t0 = new Date('2026-08-16T10:50:00+08:00');
  // Only userA notified at t0; groupB never notified.
  const map = applyNotifiedTargets({}, key, 'fp', [userA], t0);

  const fiveMinLater = new Date(t0.getTime() + 5 * 60 * 1000);
  assert.equal(targetNeedsCongestionNotification(key, userA, map, fiveMinLater), false);
  assert.equal(targetNeedsCongestionNotification(key, groupB, map, fiveMinLater), true);
});

test('a custom cooldownMs override is respected (for tests that need a different window)', () => {
  const key = 'congestion:國道一號:北向:83-91';
  const t0 = new Date('2026-08-16T10:50:00+08:00');
  const map = applyNotifiedTargets({}, key, 'fp', [userA], t0);
  const oneMinLater = new Date(t0.getTime() + 60 * 1000);
  assert.equal(targetNeedsCongestionNotification(key, userA, map, oneMinLater, 30 * 1000), true); // 30s cooldown already elapsed
  assert.equal(targetNeedsCongestionNotification(key, userA, map, oneMinLater, 5 * 60 * 1000), false); // 5min cooldown not yet elapsed
});

test('a corrupt/unparseable notifiedAt fails open (needs notification) rather than getting stuck silent forever', () => {
  const key = 'congestion:國道一號:北向:83-91';
  const map = { [key]: { targets: { [targetKey(userA)]: { fingerprint: 'fp', notifiedAt: 'not-a-date' } } } };
  assert.equal(targetNeedsCongestionNotification(key, userA, map, new Date('2026-08-16T10:50:00+08:00')), true);
});

// V1.8.5.1 — required regression test 10: computeNotificationFingerprint
// must never change because of pbs/normalize.js's new displayKM field.
// The function only ever reads type/road/direction/startKM/endKM (or
// location as a fallback when neither KM is present)/blockedLanes/a
// closure-impact boolean derived from title+description — displayKM is
// simply not one of its inputs, so two events identical in every one of
// those fields must fingerprint identically regardless of displayKM.
test('10. computeNotificationFingerprint is unaffected by a PBS event\'s displayKM field (present, absent, or changed)', () => {
  const base = {
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    location: '中山高速公路-國道1號',
    title: '',
    description: '西行在93.3公里處內側車道發生交通事故',
    blockedLanes: undefined,
  };
  const withoutDisplayKm = { ...base };
  const withDisplayKm = { ...base, displayKM: 93.3 };
  const withDifferentDisplayKm = { ...base, displayKM: 12.7 };

  const fpWithout = computeNotificationFingerprint(withoutDisplayKm);
  const fpWith = computeNotificationFingerprint(withDisplayKm);
  const fpDifferent = computeNotificationFingerprint(withDifferentDisplayKm);

  assert.equal(fpWith, fpWithout);
  assert.equal(fpDifferent, fpWithout);
});
