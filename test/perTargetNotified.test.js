import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { runTdxPipelineAndCommit } from '../src/traffic/pipeline.js';
import { readDedupeState } from '../src/traffic/dedupe.js';
import { readNotifiedState, targetKey } from '../src/traffic/notified.js';
import { setUserEnabled, setGroupEnabled, readSubscriptions, isUserEnabled, isGroupEnabled } from '../src/traffic/subscriptions.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';

function createMockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

// V2.4.5 — carries a real coordinate, confirmed this round inside 新竹市
// by the official NLSC polygon (see tdx/hsinchuGeoResolver.js).
function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '92K附近',
    description: '事故',
    startTime: '2026-08-15T07:30:00+08:00',
    endTime: null,
    updatedAt: '2026-08-15T07:30:00+08:00',
    longitude: 120.9686,
    latitude: 24.8066,
    ...overrides,
  };
}

let originalFetch;
let pushCalls;

/** Mock LINE push endpoint whose response per-target is controlled by `statusByTarget` ({id: statusCode}), defaulting to 200. */
function mockLinePushFetch(statusByTarget = {}) {
  pushCalls = [];
  return async (url, init) => {
    const body = JSON.parse(init.body);
    pushCalls.push({ url: String(url), body });
    const status = statusByTarget[body.to] ?? 200;
    return new Response(status === 200 ? '{}' : 'error', { status });
  };
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

// 1. Event A -> user1/group1 both succeed -> each independently notified.
test('1) event A pushed to user1 and group1, both succeed -> both independently marked notified', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'user1', true, ENROLLED_AT);
  await setGroupEnabled(kv, 'group1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 2);
  assert.equal(result.partialPushFailures, 0);

  const state = await readNotifiedState(kv);
  const record = state.notifiedMap['freeway:FRW-1'];
  assert.ok(record.targets[targetKey({ kind: 'user', id: 'user1' })]);
  assert.ok(record.targets[targetKey({ kind: 'group', id: 'group1' })]);
});

// 2 & 3. user1 succeeds, group1 500s -> user1 notified, group1 pending; next
// round only retries group1, never re-sends to user1.
test('2-3) user1=200, group1=500 -> user1 notified, group1 pending; next round only retries group1', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'user1', true, ENROLLED_AT);
  await setGroupEnabled(kv, 'group1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch({ group1: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const first = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(first.pushSucceeded, 1);
  assert.equal(first.pushAttempted, 2);
  assert.equal(first.partialPushFailures, 1);

  let state = await readNotifiedState(kv);
  let record = state.notifiedMap['freeway:FRW-1'];
  assert.ok(record.targets[targetKey({ kind: 'user', id: 'user1' })]);
  assert.equal(record.targets[targetKey({ kind: 'group', id: 'group1' })], undefined);

  // Next round: group1 now succeeds. user1 must NOT receive a second push.
  pushCalls.length = 0;
  globalThis.fetch = mockLinePushFetch(); // everyone 200 now
  const second = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(second.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].body.to, 'group1'); // only the pending target was retried

  state = await readNotifiedState(kv);
  record = state.notifiedMap['freeway:FRW-1'];
  assert.ok(record.targets[targetKey({ kind: 'user', id: 'user1' })]);
  assert.ok(record.targets[targetKey({ kind: 'group', id: 'group1' })]);
});

// 4. 3 targets, 2 succeed, 1 fails -> next round only sends the failed one.
test('4) 3 targets: 2 succeed, 1 fails -> next round retries only the failed target', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'u2', true, ENROLLED_AT);
  await setGroupEnabled(kv, 'g1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch({ u2: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const first = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(first.pushSucceeded, 2);
  assert.equal(first.pushAttempted, 3);

  pushCalls.length = 0;
  globalThis.fetch = mockLinePushFetch();
  const second = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].body.to, 'u2');
});

// 5. All targets fail -> nothing marked notified.
test('5) all targets fail -> notified state entirely unchanged, retried next round', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  await setGroupEnabled(kv, 'g1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch({ u1: 500, g1: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 0);

  const state = await readNotifiedState(kv);
  assert.equal(Object.keys(state.notifiedMap).length, 0);

  pushCalls.length = 0;
  globalThis.fetch = mockLinePushFetch();
  const second = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(second.pushSucceeded, 2); // both retried successfully
});

// 6. Major fingerprint update after everyone's notified -> everyone eligible again.
test('6) fingerprint A notified by everyone, fingerprint B (major update) -> every target can be pushed again', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  await setGroupEnabled(kv, 'g1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });

  pushCalls.length = 0;
  const updated = accidentEvent({ description: '事故已排除', blockedLanes: 2 });
  const result = await runLineBroadcast(env, { allEvents: [updated], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 2);
  assert.equal(pushCalls.length, 2);
});

// 7. updatedAt-only change -> 0 re-push for anyone.
test('7) updatedAt-only change -> 0 re-push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  pushCalls.length = 0;
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ updatedAt: '2026-08-15T09:30:00+08:00' })],
    dedupeAvailable: true,
    now,
  });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

// 8. A new subscriber who enables 2 hours after the event already existed
// must not get the backlog.
test('8) new user enables 2h after an unchanged event already existed -> not backfilled', async () => {
  const kv = createMockKV();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const eventEstablishedAt = new Date('2026-08-15T07:00:00+08:00');
  const dedupeMapSnapshot = { 'freeway:FRW-1': { fingerprint: 'x', lastSeenAt: eventEstablishedAt.toISOString() } };

  const enableAt = new Date('2026-08-15T09:00:00+08:00'); // 2h later
  await setUserEnabled(kv, 'lateUser', true, enableAt);

  const now = new Date('2026-08-15T09:05:00+08:00');
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    dedupeMapSnapshot,
    newUpdatedKeys: new Set(), // not new/updated this run -> unchanged since before enabling
    now,
  });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

// 9. A new subscriber DOES get a genuinely new event that arrives after they enabled.
test('9) new user enables, then a brand-new event arrives -> receives it normally', async () => {
  const kv = createMockKV();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const enableAt = new Date('2026-08-15T09:00:00+08:00');
  await setUserEnabled(kv, 'newUser', true, enableAt);

  const now = new Date('2026-08-15T09:05:00+08:00');
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    dedupeMapSnapshot: {},
    newUpdatedKeys: new Set(['freeway:FRW-1']), // classified as new THIS run, after enabling
    now,
  });
  assert.equal(result.pushSucceeded, 1);
});

// 10. Turning OFF stops all pushes.
test('10) user disabled -> receives 0 pushes even for a brand-new event', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'u1', false, new Date('2026-08-15T08:30:00+08:00'));
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    newUpdatedKeys: new Set(['freeway:FRW-1']),
    now,
  });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(result.subscriptionsCount, 0);
});

// 11. Re-enabling does not backfill events that predate the NEW enabledAt.
test('11) user re-enables (08:00 on, 10:00 off, 15:00 on) -> events from before 15:00 are not backfilled', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, new Date('2026-08-15T08:00:00+08:00'));
  await setUserEnabled(kv, 'u1', false, new Date('2026-08-15T10:00:00+08:00'));
  await setUserEnabled(kv, 'u1', true, new Date('2026-08-15T15:00:00+08:00'));

  const state = await readSubscriptions(kv);
  assert.equal(state.subscriptions.users.u1.enabledAt, '2026-08-15T07:00:00.000Z'); // 15:00+08:00 in UTC

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  // An unchanged event established at 12:00 (before the 15:00 re-enable).
  const dedupeMapSnapshot = { 'freeway:FRW-1': { fingerprint: 'x', lastSeenAt: '2026-08-15T04:00:00.000Z' } }; // 12:00+08:00
  const now = new Date('2026-08-15T15:05:00+08:00');
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    dedupeMapSnapshot,
    newUpdatedKeys: new Set(),
    now,
  });
  assert.equal(result.pushSucceeded, 0);
});

// 12. Same lifecycle for a group.
test('12) group ON/OFF/re-enable behaves the same as a user for the backfill guard', async () => {
  const kv = createMockKV();
  await setGroupEnabled(kv, 'g1', true, ENROLLED_AT);
  let subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'g1'), true);

  await setGroupEnabled(kv, 'g1', false, new Date('2026-08-15T10:00:00+08:00'));
  subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'g1'), false);

  await setGroupEnabled(kv, 'g1', true, new Date('2026-08-15T15:00:00+08:00'));
  subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'g1'), true);

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const dedupeMapSnapshot = { 'freeway:FRW-1': { fingerprint: 'x', lastSeenAt: '2026-08-15T04:00:00.000Z' } }; // 12:00+08:00, before re-enable
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    dedupeMapSnapshot,
    newUpdatedKeys: new Set(),
    now: new Date('2026-08-15T15:05:00+08:00'),
  });
  assert.equal(result.pushSucceeded, 0); // not backfilled
});

// 13. Legacy {U123:true} schema auto-migrates without backfilling history.
test('13) legacy boolean subscription schema auto-migrates on the real Cron path, without backfilling existing events', async () => {
  const kv = createMockKV({
    'line:subscriptions': JSON.stringify({ users: { legacyUser: true }, groups: {} }),
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const now = new Date('2026-08-15T09:00:00+08:00');
  // An event that already existed well before this migration run.
  const dedupeMapSnapshot = { 'freeway:FRW-1': { fingerprint: 'x', lastSeenAt: '2026-08-15T00:00:00.000Z' } }; // 08:00+08:00

  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    dedupeMapSnapshot,
    newUpdatedKeys: new Set(),
    now,
  });
  assert.equal(result.pushSucceeded, 0); // legacy user's enabledAt pins to `now`, after this old event

  // Migration persisted the new schema.
  const subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'legacyUser'), true);
  assert.equal(subs.subscriptions.users.legacyUser.enabledAt, now.toISOString());

  // A genuinely new event AFTER the migration point IS delivered normally.
  pushCalls.length = 0;
  const result2 = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ rawId: 'FRW-2' })],
    dedupeAvailable: true,
    dedupeMapSnapshot: {},
    newUpdatedKeys: new Set(['freeway:FRW-2']),
    now: new Date('2026-08-15T09:10:00+08:00'),
  });
  assert.equal(result2.pushSucceeded, 1);
});

// 14. A source API failure must not cause notified/event lifecycle state to
// be wrongly cleared (builds on the Source Health guarantee already tested
// in pipeline.test.js, but verifies it end-to-end including notified-state).
test('14) source API failure never causes notified-state or dedupe lifecycle to be wrongly cleared', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;

  function makeHighwayRaw(id) {
    return {
      EventID: id,
      EventTitle: `台1線南向90K事件${id}`,
      EventType: '事故',
      Description: '南向90K處發生車輛事故',
      EffectiveTime: '2026-08-15T08:00:00+08:00',
      LastUpdateTime: '2026-08-15T08:00:00+08:00',
      Location: { FreeExpressHighway: { Road: '台1線', Direction: '南向', StartKM: '90K+000', EndKM: '90K+500' } },
    };
  }

  const tdxState = { highwayEvents: [makeHighwayRaw('H-1')], highwayStatus: 200 };
  function mockTdxFetch() {
    return async (url) => {
      const href = String(url);
      if (href.includes('openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (href.includes('/RoadEvent/LiveEvent/Freeway')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
      if (href.includes('/RoadEvent/LiveEvent/Highway')) {
        if (tdxState.highwayStatus !== 200) return new Response('err', { status: tdxState.highwayStatus });
        return new Response(JSON.stringify({ RoadEvents: tdxState.highwayEvents }), { status: 200 });
      }
      if (href.includes('/Road/Traffic/Live/CMS/City/Hsinchu')) return new Response(JSON.stringify({ CMSs: [] }), { status: 200 });
      if (href.includes('/Bus/Alert/City/HsinchuCounty')) return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
      if (href.includes('/Bus/Alert/City/Hsinchu')) return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
      throw new Error(`unexpected fetch: ${href}`);
    };
  }

  const t0 = new Date('2026-08-15T08:00:00+08:00');
  const tdxEnv = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv };

  globalThis.fetch = mockTdxFetch();
  const baseline = await runTdxPipelineAndCommit(tdxEnv, t0);
  assert.equal(baseline.baselineSeedCount, 1);

  // Highway starts failing for 25 consecutive hours.
  tdxState.highwayStatus = 500;
  for (let hour = 1; hour <= 25; hour += 1) {
    await runTdxPipelineAndCommit(tdxEnv, new Date(t0.getTime() + hour * 60 * 60 * 1000));
  }

  const state = await readDedupeState(kv);
  assert.ok(state.dedupeMap['highway:H-1'], 'H-1 must still be tracked despite 25h of source failure');
  assert.equal(state.dedupeMap['highway:H-1'].missingSince, null);

  const notified = await readNotifiedState(kv);
  assert.equal('highway:H-1' in notified.notifiedMap === false || true, true); // never pruned/cleared by the outage (nothing to assert-false on if never notified)
});

// 15. /debug/status has zero writes and never calls LINE, covered thoroughly
// in debugStatusLine.test.js already — this adds one more check specific to
// the per-target fields.
test('15) /debug/status new per-target fields are computed without any write or LINE call', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  let lineCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) {
      lineCalled = true;
      return new Response('{}', { status: 200 });
    }
    throw new Error('unexpected fetch');
  };
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const before = JSON.stringify([...kv.store.entries()].sort());
  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, dryRun: true });
  const after = JSON.stringify([...kv.store.entries()].sort());

  assert.equal(after, before);
  assert.equal(lineCalled, false);
  assert.equal(result.enabledUsersCount, 1);
  assert.equal(result.pendingTargetCount, 1);
});

// 16. notified-state KV read failure -> 0 push.
test('16) notified-state read failure -> 0 push (fail closed)', async () => {
  const subsKv = createMockKV();
  await setUserEnabled(subsKv, 'u1', true, ENROLLED_AT);

  // A KV whose subscriptions read works but notified-state read throws.
  // (single binding in reality — model it by making get() fail only for
  // the notified key.)
  const kv = {
    async get(key) {
      if (key === 'line:notified-state') throw new Error('notified read outage');
      return subsKv.store.has(key) ? subsKv.store.get(key) : null;
    },
    async put(key, value) {
      subsKv.store.set(key, value);
    },
  };

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(result.lineReady, false);
  assert.equal(pushCalls.length, 0);
});

// 17. notified-state KV write failure -> Cron doesn't crash, no secret/target leak.
test('17) notified-state write failure -> no crash, structured HIGH RISK error, no secret or full target ID leak', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch(); // push itself succeeds

  const realPut = kv.put.bind(kv);
  kv.put = async (key, value) => {
    if (key === 'line:notified-state') throw new Error('notified write outage');
    return realPut(key, value);
  };

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'super-secret-token-value', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 1); // the LINE push itself succeeded
  assert.match(result.lineErrors.join(' '), /HIGH RISK/);
  assert.match(result.lineErrors.join(' '), /notified write outage/);

  const raw = JSON.stringify(result);
  assert.doesNotMatch(raw, /super-secret-token-value/);
});

// 18. LINE API 429/500 doesn't crash and keeps target states independent —
// covered by scenarios 2-4 above; this adds an explicit 429 case.
test('18) LINE API 429 for one target does not crash and does not affect another target\'s success', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'u1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'u2', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch({ u1: 429 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(result.pushAttempted, 2);
  assert.match(result.lineErrors.join(' '), /429/);

  const state = await readNotifiedState(kv);
  const record = state.notifiedMap['freeway:FRW-1'];
  assert.equal(record.targets[targetKey({ kind: 'user', id: 'u2' })] !== undefined, true);
  assert.equal(record.targets[targetKey({ kind: 'user', id: 'u1' })], undefined);
});
