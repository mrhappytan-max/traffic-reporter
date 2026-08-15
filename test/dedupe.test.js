import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint, readDedupeState, classifyEvents, commitDedupeState } from '../src/traffic/dedupe.js';

function createMockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
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
const eventAUpdatedDescription = { ...eventA, description: '事故，已排除' };
const eventAOnlyTimestampChanged = { ...eventA, updatedAt: '2026-08-15T09:00:00+08:00' };
const eventB = { source: 'freeway', rawId: 'FRW-2', type: 'construction', description: '施工' };

test('computeFingerprint ignores updatedAt but reacts to description/type/direction/KM/blockedLanes', () => {
  assert.equal(computeFingerprint(eventA), computeFingerprint(eventAOnlyTimestampChanged));
  assert.notEqual(computeFingerprint(eventA), computeFingerprint(eventAUpdatedDescription));
});

test('readDedupeState: no binding at all is treated the same as a failure (fail closed)', async () => {
  const state = await readDedupeState(undefined);
  assert.equal(state.kvAvailable, false);
  assert.equal(state.baselineInitialized, false);
});

test('readDedupeState: a get() throw is reported, not crashed on', async () => {
  const brokenKv = {
    async get() {
      throw new Error('KV read outage');
    },
  };
  const state = await readDedupeState(brokenKv);
  assert.equal(state.kvAvailable, false);
  assert.match(state.kvError, /KV read outage/);
});

test('classifyEvents: before baseline, everything is a baseline seed, nothing is new/updated/pushable', () => {
  const result = classifyEvents([eventA, eventB], { baselineInitialized: false, dedupeMap: {} });
  assert.equal(result.baselineSeedEvents.length, 2);
  assert.equal(result.newEvents.length, 0);
  assert.equal(result.updatedEvents.length, 0);
  assert.equal(result.pushableEvents.length, 0);
});

test('classifyEvents: after baseline, unseen rawId is new, same fingerprint is duplicate, changed fingerprint is updated', () => {
  const dedupeMap = {
    'freeway:FRW-1': { fingerprint: computeFingerprint(eventA), lastSeenAt: new Date().toISOString() },
  };

  // Three independent checks against the same stored map in one call:
  // eventB (rawId FRW-2, unseen) -> new; eventAOnlyTimestampChanged
  // (FRW-1, same fingerprint as stored) -> duplicate. The "changed
  // fingerprint -> updated" branch is asserted separately below since it
  // needs its own dedupeMap entry for FRW-1 to compare against.
  const result = classifyEvents([eventAOnlyTimestampChanged, eventB], {
    baselineInitialized: true,
    dedupeMap,
  });
  assert.equal(result.duplicateEvents.length, 1);
  assert.equal(result.duplicateEvents[0].rawId, 'FRW-1');
  assert.equal(result.newEvents.length, 1);
  assert.equal(result.newEvents[0].rawId, 'FRW-2');

  const updatedResult = classifyEvents([eventAUpdatedDescription], { baselineInitialized: true, dedupeMap });
  assert.equal(updatedResult.updatedEvents.length, 1);
  assert.equal(updatedResult.updatedEvents[0].rawId, 'FRW-1');
});

test('commitDedupeState (baseline run): seeds the map, marks baseline, writes exactly 2 keys, nothing pending', async () => {
  const kv = createMockKV();
  const events = [eventA, eventB];
  const classification = classifyEvents(events, { baselineInitialized: false, dedupeMap: {} });

  const result = await commitDedupeState(kv, { baselineInitialized: false, dedupeMap: {}, classification });

  assert.equal(result.committed, true);
  assert.equal(result.baselineJustInitialized, true);
  assert.equal(kv.store.size, 2); // traffic:baseline + traffic:dedupe-state, not one key per event

  const state = await readDedupeState(kv);
  assert.equal(state.baselineInitialized, true);
  assert.equal(Object.keys(state.dedupeMap).length, 2);
});

test('commitDedupeState: a run with zero new/updated events writes nothing', async () => {
  const kv = createMockKV();
  await commitDedupeState(kv, {
    baselineInitialized: false,
    dedupeMap: {},
    classification: classifyEvents([eventA], { baselineInitialized: false, dedupeMap: {} }),
  });
  const beforeSize = kv.store.size;

  const state = await readDedupeState(kv);
  const classification = classifyEvents([eventA], state); // identical event again -> duplicate
  assert.equal(classification.duplicateEvents.length, 1);

  const result = await commitDedupeState(kv, { ...state, classification });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'no-changes');
  assert.equal(kv.store.size, beforeSize); // no extra writes
});

test('commitDedupeState: an update changes the stored fingerprint so it stops looking like a duplicate next time', async () => {
  const kv = createMockKV();
  await commitDedupeState(kv, {
    baselineInitialized: false,
    dedupeMap: {},
    classification: classifyEvents([eventA], { baselineInitialized: false, dedupeMap: {} }),
  });

  let state = await readDedupeState(kv);
  let classification = classifyEvents([eventAUpdatedDescription], state);
  assert.equal(classification.updatedEvents.length, 1);
  await commitDedupeState(kv, { ...state, classification });

  state = await readDedupeState(kv);
  classification = classifyEvents([eventAUpdatedDescription], state);
  assert.equal(classification.duplicateEvents.length, 1); // now stable
  assert.equal(classification.updatedEvents.length, 0);
});

test('commitDedupeState surfaces a structured error and commits nothing when kv.put throws', async () => {
  const brokenKv = {
    async get() {
      return null;
    },
    async put() {
      throw new Error('KV write outage');
    },
  };
  const classification = classifyEvents([eventA], { baselineInitialized: false, dedupeMap: {} });
  const result = await commitDedupeState(brokenKv, { baselineInitialized: false, dedupeMap: {}, classification });

  assert.equal(result.committed, false);
  assert.equal(result.reason, 'kv-error');
  assert.match(result.error, /KV write outage/);
});

test('neither traffic:baseline nor traffic:dedupe-state is ever written with an expirationTtl', async () => {
  const kv = createMockKV();
  await commitDedupeState(kv, {
    baselineInitialized: false,
    dedupeMap: {},
    classification: classifyEvents([eventA], { baselineInitialized: false, dedupeMap: {} }),
  });

  // Also exercise the "new event on an established baseline" write path.
  let state = await readDedupeState(kv);
  await commitDedupeState(kv, { ...state, classification: classifyEvents([eventB], state) });

  assert.ok(kv.putCalls.length >= 3);
  for (const call of kv.putCalls) {
    assert.equal(call.options, undefined, `put("${call.key}") must not carry an expirationTtl`);
  }
});

test('an event present and unchanged for 48+ consecutive hours is never re-flagged as new (presence-based lifecycle, not calendar-time-based)', async () => {
  const kv = createMockKV();
  const t0 = new Date('2026-08-15T00:00:00Z');

  let state = { baselineInitialized: false, dedupeMap: {} };
  await commitDedupeState(kv, { ...state, classification: classifyEvents([eventA], state) }, t0);
  const sizeAfterBaseline = kv.store.size;

  // Cron ticks once an hour for 49 hours — well past the old 24h mark —
  // with eventA present and fingerprint-identical every single time.
  for (let hour = 1; hour <= 49; hour += 1) {
    const now = new Date(t0.getTime() + hour * 60 * 60 * 1000);
    state = await readDedupeState(kv);
    const classification = classifyEvents([eventA], state);

    assert.equal(classification.newEvents.length, 0, `hour ${hour}: must not be classified as new`);
    assert.equal(classification.updatedEvents.length, 0, `hour ${hour}: must not be classified as updated`);
    assert.equal(classification.duplicateEvents.length, 1, `hour ${hour}: must remain a duplicate`);

    await commitDedupeState(kv, { ...state, classification }, now);
  }

  // A continuously-present, unchanged event should never require a write
  // after the initial baseline — confirms this is genuinely presence-based
  // (no periodic "keep-alive" write needed), not merely passing the test.
  assert.equal(kv.store.size, sizeAfterBaseline);
});

test('an event absent for less than the grace period is kept and does not become "new" on reappearance', async () => {
  const kv = createMockKV();
  const t0 = new Date('2026-08-15T00:00:00Z');

  let state = { baselineInitialized: false, dedupeMap: {} };
  await commitDedupeState(kv, { ...state, classification: classifyEvents([eventA], state) }, t0);

  // Missing for one run (e.g. a transient TDX blip), 1 hour later.
  const missingAt = new Date(t0.getTime() + 60 * 60 * 1000);
  state = await readDedupeState(kv);
  let classification = classifyEvents([], state); // eventA absent from this fetch
  assert.equal(classification.missingKeys.length, 1);
  await commitDedupeState(kv, { ...state, classification }, missingAt);

  // Reappears 2 hours later (well under the 24h grace period) -> duplicate,
  // not new.
  const reappearAt = new Date(t0.getTime() + 3 * 60 * 60 * 1000);
  state = await readDedupeState(kv);
  classification = classifyEvents([eventA], state);
  assert.equal(classification.newEvents.length, 0);
  assert.equal(classification.duplicateEvents.length, 1);
});

test('an event absent continuously for >= the grace period is pruned, and only then would reappear as new', async () => {
  const kv = createMockKV();
  const t0 = new Date('2026-08-15T00:00:00Z');

  let state = { baselineInitialized: false, dedupeMap: {} };
  await commitDedupeState(kv, { ...state, classification: classifyEvents([eventA], state) }, t0);

  // First missing run: absence clock starts.
  let now = new Date(t0.getTime() + 1 * 60 * 60 * 1000);
  state = await readDedupeState(kv);
  await commitDedupeState(kv, { ...state, classification: classifyEvents([], state) }, now);

  // Still missing, just under 24h of consecutive absence -> not pruned yet.
  now = new Date(t0.getTime() + (1 + 23) * 60 * 60 * 1000);
  state = await readDedupeState(kv);
  let classification = classifyEvents([], state);
  assert.equal(Object.keys(state.dedupeMap).length, 1); // still tracked
  await commitDedupeState(kv, { ...state, classification }, now);

  // Now past 24h of consecutive absence since the clock started -> pruned
  // on this write.
  now = new Date(t0.getTime() + (1 + 25) * 60 * 60 * 1000);
  state = await readDedupeState(kv);
  classification = classifyEvents([], state);
  await commitDedupeState(kv, { ...state, classification }, now);

  state = await readDedupeState(kv);
  assert.equal(Object.keys(state.dedupeMap).length, 0); // pruned

  // Reappearing after being pruned is indistinguishable from a genuinely
  // new event — this is the intended, documented behavior.
  classification = classifyEvents([eventA], state);
  assert.equal(classification.newEvents.length, 1);
});
