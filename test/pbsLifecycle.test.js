import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isClearedComment,
  isStalePbsEvent,
  computePbsFingerprint,
  readPbsLifecycleState,
  classifyPbsLifecycle,
  commitPbsLifecycleState,
} from '../src/pbs/lifecycle.js';

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

function pbsEvent(overrides = {}) {
  return {
    source: 'pbs',
    rawId: 'U1',
    type: 'accident',
    road: '台68',
    direction: '西向',
    description: '西行8.1公里處交通事故',
    updatedAt: '2026-08-15T14:20:00.000Z',
    happenedAt: '2026-08-15T14:14:00.000Z',
    ...overrides,
  };
}

test('isClearedComment matches 排除/已排除/解除/已解除', () => {
  assert.equal(isClearedComment('北控:排除'), true);
  assert.equal(isClearedComment('已排除，恢復正常'), true);
  assert.equal(isClearedComment('事故已解除'), true);
  assert.equal(isClearedComment('解除交通管制'), true);
  assert.equal(isClearedComment('西行8.1公里處交通事故'), false);
  assert.equal(isClearedComment(''), false);
});

test('isStalePbsEvent: fresh event is not stale; an old one (>2h) is', () => {
  const now = new Date('2026-08-15T15:00:00.000Z');
  const fresh = pbsEvent({ updatedAt: '2026-08-15T14:50:00.000Z' }); // 10 min old
  const old = pbsEvent({ updatedAt: '2026-08-15T12:00:00.000Z' }); // 3h old
  assert.equal(isStalePbsEvent(fresh, now), false);
  assert.equal(isStalePbsEvent(old, now), true);
});

test('isStalePbsEvent: no time info at all is conservatively treated as stale', () => {
  const now = new Date('2026-08-15T15:00:00.000Z');
  assert.equal(isStalePbsEvent({ updatedAt: null, happenedAt: null }, now), true);
});

test('computePbsFingerprint ignores updatedAt but reacts to description/road/direction/type', () => {
  const a = pbsEvent();
  const timestampOnly = pbsEvent({ updatedAt: '2026-08-15T15:00:00.000Z' });
  const contentChanged = pbsEvent({ description: '西行8.1公里事故已排除' });
  assert.equal(computePbsFingerprint(a), computePbsFingerprint(timestampOnly));
  assert.notEqual(computePbsFingerprint(a), computePbsFingerprint(contentChanged));
});

test('classifyPbsLifecycle: cleared comment wins over staleness (a just-cleared old event is "cleared", not "stale")', () => {
  const now = new Date('2026-08-15T20:00:00.000Z'); // hours after the event -> would be stale
  const clearedButOld = pbsEvent({ description: '北控:排除' });
  const { clearedEvents, staleEvents, activeEvents } = classifyPbsLifecycle([clearedButOld], now);
  assert.equal(clearedEvents.length, 1);
  assert.equal(staleEvents.length, 0);
  assert.equal(activeEvents.length, 0);
});

test('classifyPbsLifecycle: fresh + not cleared -> active; old + not cleared -> stale', () => {
  const now = new Date('2026-08-15T15:00:00.000Z');
  const fresh = pbsEvent({ rawId: 'FRESH' });
  const old = pbsEvent({ rawId: 'OLD', updatedAt: '2026-08-15T10:00:00.000Z' });
  const { activeEvents, staleEvents } = classifyPbsLifecycle([fresh, old], now);
  assert.equal(activeEvents.length, 1);
  assert.equal(activeEvents[0].rawId, 'FRESH');
  assert.equal(staleEvents.length, 1);
  assert.equal(staleEvents[0].rawId, 'OLD');
});

test('commitPbsLifecycleState: a healthy fetch with a cleared UID does not touch state (no-changes, first sighting)', async () => {
  // First time seeing it AND already cleared -> still recorded once.
  const kv = createMockKV();
  const now = new Date('2026-08-15T15:00:00.000Z');
  const event = pbsEvent({ description: '北控:排除' });
  const result = await commitPbsLifecycleState(kv, {}, { clearedEvents: [event], activeEvents: [], seenIds: new Set(['U1']) }, true, now);
  assert.equal(result.committed, true);

  const state = await readPbsLifecycleState(kv);
  assert.equal(state.pbsMap['U1'].lifecycle, 'cleared');
});

test('commitPbsLifecycleState: source-unhealthy (pbsOk=false) never writes anything, regardless of input', async () => {
  const kv = createMockKV();
  const result = await commitPbsLifecycleState(
    kv,
    {},
    { clearedEvents: [], activeEvents: [pbsEvent()], seenIds: new Set(['U1']) },
    false, // pbsOk=false
    new Date()
  );
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'source-unhealthy');
  assert.equal(kv.store.size, 0);
});

test('commitPbsLifecycleState: no expirationTtl is ever set on the PBS lifecycle key', async () => {
  const kv = createMockKV();
  await commitPbsLifecycleState(kv, {}, { clearedEvents: [], activeEvents: [pbsEvent()], seenIds: new Set(['U1']) }, true, new Date());
  assert.ok(kv.putCalls.length >= 1);
  for (const call of kv.putCalls) assert.equal(call.options, undefined);
});

test('same UID: active last round, comment shows 排除 this round -> transitions to cleared', async () => {
  const kv = createMockKV();
  const now1 = new Date('2026-08-15T15:00:00.000Z');

  // Round 1: active.
  const active = pbsEvent();
  await commitPbsLifecycleState(kv, {}, { clearedEvents: [], activeEvents: [active], seenIds: new Set(['U1']) }, true, now1);
  let state = await readPbsLifecycleState(kv);
  assert.equal(state.pbsMap['U1'].lifecycle, 'active');

  // Round 2: same UID, comment now says 排除.
  const now2 = new Date('2026-08-15T15:05:00.000Z');
  const cleared = pbsEvent({ description: '北控:排除' });
  const classification = classifyPbsLifecycle([cleared], now2);
  await commitPbsLifecycleState(kv, state.pbsMap, classification, true, now2);

  state = await readPbsLifecycleState(kv);
  assert.equal(state.pbsMap['U1'].lifecycle, 'cleared');
});

test('an active PBS UID absent from a healthy fetch for >=24h is pruned; still-present-and-active is never pruned', async () => {
  const kv = createMockKV();
  const t0 = new Date('2026-08-15T00:00:00Z');

  await commitPbsLifecycleState(kv, {}, { clearedEvents: [], activeEvents: [pbsEvent()], seenIds: new Set(['U1']) }, true, t0);

  // Missing from the feed for 25 consecutive healthy hours.
  let state = await readPbsLifecycleState(kv);
  for (let hour = 1; hour <= 25; hour += 1) {
    const now = new Date(t0.getTime() + hour * 60 * 60 * 1000);
    const classification = classifyPbsLifecycle([], now); // U1 absent this round
    await commitPbsLifecycleState(kv, state.pbsMap, classification, true, now);
    state = await readPbsLifecycleState(kv);
  }

  assert.equal(state.pbsMap['U1'], undefined); // pruned after 24h of genuine absence
});

test('readPbsLifecycleState fails closed when TRAFFIC_KV is missing or throws', async () => {
  const noKv = await readPbsLifecycleState(undefined);
  assert.equal(noKv.kvAvailable, false);

  const brokenKv = {
    async get() {
      throw new Error('KV outage');
    },
  };
  const broken = await readPbsLifecycleState(brokenKv);
  assert.equal(broken.kvAvailable, false);
});
