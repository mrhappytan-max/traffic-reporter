import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

function createMockKV() {
  const store = new Map();
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
    ...overrides,
  };
}

// Fixed early "already subscribed" timestamp, well before every test
// scenario's event/now values, so the new enabledAt backfill guard never
// interferes with tests that aren't specifically testing that guard.
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

let originalFetch;
let pushCalls;

function mockLinePushFetch() {
  pushCalls = [];
  return async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('fail-closed: missing LINE_CHANNEL_ACCESS_TOKEN -> 0 push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.lineReady, false);
  assert.equal(result.pushSucceeded, 0);
  assert.match(result.lineErrors.join(' '), /LINE_CHANNEL_ACCESS_TOKEN/);
});

test('fail-closed: dedupeAvailable=false (base pipeline KV unavailable) -> 0 push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: false, now });
  assert.equal(result.pushSucceeded, 0);
});

test('fail-closed: subscriptions read failure -> 0 push', async () => {
  const brokenKv = {
    async get() {
      throw new Error('subs read outage');
    },
  };
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: brokenKv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(result.lineReady, false);
});

test('quiet hours: 07:59 Taipei -> 0 push even with a ready system and a real event', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now: new Date('2026-08-15T07:59:00+08:00'),
  });
  assert.equal(result.withinBroadcastHours, false);
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('quiet hours: 22:00 Taipei -> 0 push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now: new Date('2026-08-15T22:00:00+08:00'),
  });
  assert.equal(result.withinBroadcastHours, false);
  assert.equal(result.pushSucceeded, 0);
});

test('0 subscribers -> LINE API is never called, even with a relevant event inside broadcast hours', async () => {
  const kv = createMockKV(); // no users/groups enabled
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now: new Date('2026-08-15T09:00:00+08:00'),
  });
  assert.equal(result.subscriptionsCount, 0);
  assert.equal(pushCalls.length, 0);
  assert.equal(result.pushSucceeded, 0);
});

// ---------------------------------------------------------------------
// seen != notified: an event seen well before 08:00 (outside hours) must
// still be notified the first time we're inside broadcast hours, even
// though the base pipeline's own seen-dedupe already considers it a
// "duplicate" by then.
// ---------------------------------------------------------------------
test('seen at 07:35 (pre-hours), still active at 08:00 -> must be notified exactly once at 08:00', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const event = accidentEvent({ startTime: '2026-08-15T07:30:00+08:00' });

  // 07:35: outside broadcast hours -> 0 push, regardless of relevance.
  const at0735 = await runLineBroadcast(env, {
    allEvents: [event],
    dedupeAvailable: true,
    now: new Date('2026-08-15T07:35:00+08:00'),
  });
  assert.equal(at0735.withinBroadcastHours, false);
  assert.equal(at0735.pushSucceeded, 0);

  // 08:00: event still active (never ended) -> must push exactly once.
  const at0800 = await runLineBroadcast(env, {
    allEvents: [event],
    dedupeAvailable: true,
    now: new Date('2026-08-15T08:00:00+08:00'),
  });
  assert.equal(at0800.withinBroadcastHours, true);
  assert.equal(at0800.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);

  // 08:05, unchanged content -> must NOT push again.
  pushCalls.length = 0;
  const at0805 = await runLineBroadcast(env, {
    allEvents: [event],
    dedupeAvailable: true,
    now: new Date('2026-08-15T08:05:00+08:00'),
  });
  assert.equal(at0805.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('notified dedup: first push succeeds, second identical run does not push again', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = accidentEvent();
  const now = new Date('2026-08-15T09:00:00+08:00');

  const first = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  assert.equal(first.pushSucceeded, 1);

  pushCalls.length = 0;
  const second = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  assert.equal(second.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('notified dedup: a real content change (blockedLanes) re-triggers a push; updatedAt-only does not', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });

  pushCalls.length = 0;
  const timestampOnly = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ updatedAt: '2026-08-15T09:05:00+08:00' })],
    dedupeAvailable: true,
    now,
  });
  assert.equal(timestampOnly.pushSucceeded, 0);

  pushCalls.length = 0;
  const contentChanged = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ description: '事故已排除', blockedLanes: 2 })],
    dedupeAvailable: true,
    now,
  });
  assert.equal(contentChanged.pushSucceeded, 1);
});

test('forecast event crossing into the 60-minute window is pushed once, then not repeated on later ticks with unchanged content', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  // Uses a construction/closure/control fixture as its vehicle; the
  // 重大事故限定 push policy (broadcastPolicy.js) would withhold those,
  // masking the mechanic under test. Opt into ALL_ELIGIBLE — production
  // policy behaviour is pinned in test/pbsCctvMajorAccidentOnly.test.js.
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_PUSH_POLICY: 'ALL_ELIGIBLE', TRAFFIC_KV: kv };

  const forecastEvent = {
    source: 'highway',
    rawId: 'HWY-9',
    type: 'construction',
    road: '台1線',
    direction: '南向',
    location: '90K附近',
    // starts at 09:00 today; "車道封閉" required since V1.5 (construction
    // only broadcasts with an impact keyword — see broadcastRules.js).
    description: '8月15日9時至10時施工，車道封閉',
    updatedAt: '2026-08-15T08:00:00+08:00',
  };

  // 08:05: 09:00 start is 55 minutes away -> inside the 60-min window -> push once.
  const at0805 = await runLineBroadcast(env, {
    allEvents: [forecastEvent],
    dedupeAvailable: true,
    now: new Date('2026-08-15T08:05:00+08:00'),
  });
  assert.equal(at0805.pushSucceeded, 1);
  assert.match(pushCalls[0].body.messages[0].text, /60分鐘路況預報/);

  // 08:10, 08:15, 08:20: unchanged -> must not push again.
  for (const minute of ['08:10', '08:15', '08:20']) {
    pushCalls.length = 0;
    const run = await runLineBroadcast(env, {
      allEvents: [forecastEvent],
      dedupeAvailable: true,
      now: new Date(`2026-08-15T${minute}:00+08:00`),
    });
    assert.equal(run.pushSucceeded, 0, `${minute} must not re-push unchanged forecast`);
  }
});

test('dry-run mode never calls the LINE API and never marks anything notified', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const sizeBefore = kv.store.size;
  const preview = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, dryRun: true });

  assert.equal(pushCalls.length, 0);
  assert.equal(preview.pendingTargetCount, 1);
  assert.equal(preview.pushSucceeded, 0);
  assert.equal(kv.store.size, sizeBefore); // nothing written

  // Calling it again changes nothing either.
  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, dryRun: true });
  assert.equal(kv.store.size, sizeBefore);
});

test('LINE push API 500 does not throw, is recorded as a structured error, and does not mark notified', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T09:00:00+08:00');

  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(result.pushAttempted, 1);
  assert.match(result.lineErrors.join(' '), /500/);

  const raw = JSON.stringify(result);
  assert.doesNotMatch(raw, /tok"/); // token itself never appears in the error/result payload
});

// =======================================================================
// V1.2C — congestion clustering + 30-minute cooldown, end-to-end through
// runLineBroadcast (not just the underlying congestionCluster.js /
// notified.js unit tests).
// =======================================================================

function congestionEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'CONG-1',
    type: 'congestion',
    road: '國道一號',
    direction: '北向',
    startKM: '91K+000',
    endKM: '82K+400',
    description: '車多回堵',
    updatedAt: '2026-08-15T10:50:00+08:00',
    ...overrides,
  };
}

// V1.5: 8/9/12-16/17 below used to prove the V1.2C clustering/cooldown
// machinery worked end-to-end THROUGH a real push. Pure congestion is no
// longer broadcast-eligible at all (see broadcastRules.js's
// isBroadcastEligibleType) — professional drivers already have Google
// Maps/1968 for ordinary traffic flow; this service now only interrupts
// for accidents/closures/control/other genuinely abnormal events. The
// underlying clustering/cooldown FUNCTIONS are untouched and still fully
// covered at the unit level (congestionCluster.test.js,
// notified.test.js's own "different targets have fully independent
// cooldowns" case) — kept, not deleted, per "不刪除 congestion 資料來源"
// — they just never fire inside the real broadcast pipeline anymore.
// These integration tests now assert the new, correct outcome: 0 pushes,
// regardless of overlap/direction/KM-churn/multi-target scenario.

test('8. same Cron tick, 4 overlapping 國1北向 congestion rows -> 0 LINE pushes (pure congestion is no longer broadcast-eligible)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T10:50:00+08:00');

  const events = [
    congestionEvent({ rawId: 'N1', startKM: '83K+800', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N2', startKM: '91K+000', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N3', startKM: '89K+020', endKM: '82K+400' }),
    congestionEvent({ rawId: 'N4', startKM: '90K+415', endKM: '86K+500' }),
    congestionEvent({ rawId: 'N5', startKM: '91K+000', endKM: '90K+415' }),
  ];

  const result = await runLineBroadcast(env, { allEvents: events, dedupeAvailable: true, now });
  assert.equal(result.typeIneligibleCount, 5); // all 5 excluded before clustering ever ran
  assert.equal(result.broadcastRelevantCount, 0);
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('9. same road, different direction congestion — still 0 pushes either way', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T10:50:00+08:00');

  const events = [
    congestionEvent({ rawId: 'N1', direction: '北向', startKM: '91K+000', endKM: '82K+400' }),
    congestionEvent({ rawId: 'S1', direction: '南向', startKM: '83K+000', endKM: '91K+000' }),
  ];

  const result = await runLineBroadcast(env, { allEvents: events, dedupeAvailable: true, now });
  assert.equal(result.typeIneligibleCount, 2);
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('12-16. congestion stays silent across every tick (KM churn, rawId churn, 30+ minutes later) — never pushed at all', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const t0 = new Date('2026-08-15T10:50:00+08:00');
  const ticks = [
    { at: t0, event: congestionEvent({ startKM: '91K+000', endKM: '82K+400' }) },
    { at: new Date(t0.getTime() + 5 * 60 * 1000), event: congestionEvent({ startKM: '89K+000', endKM: '82K+400' }) },
    { at: new Date(t0.getTime() + 10 * 60 * 1000), event: congestionEvent({ rawId: 'CONG-DIFFERENT-ID', startKM: '86K+000', endKM: '87K+000' }) },
    { at: new Date(t0.getTime() + 30 * 60 * 1000), event: congestionEvent({ startKM: '91K+000', endKM: '82K+400' }) },
  ];

  for (const { at, event } of ticks) {
    pushCalls.length = 0;
    const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: at });
    assert.equal(result.pushSucceeded, 0);
    assert.equal(pushCalls.length, 0);
  }
});

test('17. multiple targets, congestion — still 0 pushes for everyone', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'U2', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const result = await runLineBroadcast(env, { allEvents: [congestionEvent()], dedupeAvailable: true, now: new Date('2026-08-15T10:50:00+08:00') });
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('18. a target whose LINE push failed can still be retried next run; a successful target is not re-pushed', async () => {
  // V1.5: this test's real subject is the generic partial-push-failure
  // retry mechanism (fingerprint-based notified-state), not congestion —
  // it used a congestionEvent() fixture only incidentally. Switched to
  // accidentEvent() (broadcast-eligible) so this still exercises the
  // real code path instead of being filtered out before ever reaching it.
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'U2', true, ENROLLED_AT);
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T10:50:00+08:00');

  originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    call += 1;
    const body = JSON.parse(init.body);
    // Fail exactly the push aimed at U2, succeed U1.
    if (body.to === 'U2') return new Response('fail', { status: 500 });
    pushCalls.push({ url: String(url), body });
    return new Response('{}', { status: 200 });
  };
  pushCalls = [];

  const first = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });
  assert.equal(first.pushAttempted, 2);
  assert.equal(first.pushSucceeded, 1);

  // Immediately retry with the SAME unchanged content — U1 was already
  // successfully notified (fingerprint-based dedup, no cooldown), but U2
  // was never successfully notified, so U2 must still be pending.
  pushCalls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    pushCalls.push({ url: String(url), body });
    return new Response('{}', { status: 200 });
  };
  const retryNow = new Date(now.getTime() + 60 * 1000);
  const second = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now: retryNow });
  assert.equal(second.pushSucceeded, 1); // only U2
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].body.to, 'U2');
});

test('19. accident fingerprint changes are NOT subject to the 30-minute congestion cooldown', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T10:50:00+08:00');

  await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now });

  // 5 minutes later, a real content change (blockedLanes) -> must notify
  // again immediately, unaffected by the congestion cooldown window.
  pushCalls.length = 0;
  const t5 = new Date(now.getTime() + 5 * 60 * 1000);
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ blockedLanes: 2, description: '事故已排除一線道' })],
    dedupeAvailable: true,
    now: t5,
  });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);
});

test('20. construction/closure/control events are unaffected by clustering or cooldown — original per-event fingerprint behavior', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  // Uses a construction/closure/control fixture as its vehicle; the
  // 重大事故限定 push policy (broadcastPolicy.js) would withhold those,
  // masking the mechanic under test. Opt into ALL_ELIGIBLE — production
  // policy behaviour is pinned in test/pbsCctvMajorAccidentOnly.test.js.
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_PUSH_POLICY: 'ALL_ELIGIBLE', TRAFFIC_KV: kv };
  const now = new Date('2026-08-15T10:50:00+08:00');

  // construction is not a LIVE event type (only accident/congestion are —
  // see effectiveWindow.js), so its relevance window comes from parsing a
  // real Chinese date range out of the description, not from startTime.
  const constructionEvent = {
    source: 'highway',
    rawId: 'HWY-CONST-1',
    type: 'construction',
    road: '台68線',
    direction: '東向',
    location: '5K附近',
    // covers 10:50 (`now` below) -> active now, not forecast; "車道封閉"
    // is required since V1.5 (construction only broadcasts with an
    // impact keyword — see broadcastRules.js).
    description: '8月15日9時至12時施工，車道封閉',
    startTime: null,
    endTime: null,
    updatedAt: '2026-08-15T10:50:00+08:00',
  };

  const first = await runLineBroadcast(env, { allEvents: [constructionEvent], dedupeAvailable: true, now });
  assert.equal(first.pushSucceeded, 1);

  // Unchanged, 5 minutes later -> no re-push (ordinary dedup, not cooldown).
  pushCalls.length = 0;
  const unchanged = await runLineBroadcast(env, {
    allEvents: [constructionEvent],
    dedupeAvailable: true,
    now: new Date(now.getTime() + 5 * 60 * 1000),
  });
  assert.equal(unchanged.pushSucceeded, 0);

  // A real change (blockedLanes, part of the fingerprint) -> re-push
  // immediately, no 30-minute wait required. Keeps the same parseable
  // date-range description so effectiveWindow computation is unaffected —
  // only the fingerprint-relevant field changes.
  pushCalls.length = 0;
  const changed = await runLineBroadcast(env, {
    allEvents: [{ ...constructionEvent, blockedLanes: 1 }],
    dedupeAvailable: true,
    now: new Date(now.getTime() + 5 * 60 * 1000 + 1000),
  });
  assert.equal(changed.pushSucceeded, 1);
});

test('enabledAt backfill guard, cluster-aware: a corridor whose earliest member predates a new subscriber is not backfilled just because KM shifted', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  // Congestion first seen well in the past (baseline-seeded via
  // dedupeMapSnapshot, as pipeline.js would report it).
  const seenSince = new Date('2026-08-15T09:00:00+08:00').toISOString();
  const dedupeMapSnapshot = { 'freeway:CONG-1': { fingerprint: 'whatever', lastSeenAt: seenSince, missingSince: null } };

  // A brand-new subscriber joins AFTER the congestion started.
  const enabledAt = new Date('2026-08-15T10:00:00+08:00');
  await setUserEnabled(kv, 'U-NEW', true, enabledAt);

  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();

  const now = new Date('2026-08-15T10:50:00+08:00'); // KM has since shifted several times, but the jam itself predates U-NEW
  const result = await runLineBroadcast(env, {
    allEvents: [congestionEvent({ rawId: 'CONG-1' })],
    dedupeAvailable: true,
    newUpdatedKeys: new Set(), // not new/updated this run
    dedupeMapSnapshot,
    now,
  });

  assert.equal(result.pushSucceeded, 0); // must not backfill old content to the new subscriber
  assert.equal(pushCalls.length, 0);
});

test('notification-key stability (corridor boundary shrink) — still 0 pushes either way, now that pure congestion is broadcast-ineligible', async () => {
  // The corridor-id stability property itself (a shrinking jam keeps one
  // stable id across what used to be a bucket boundary) is still fully
  // unit-tested in roadSectionLabel.test.js — this integration test now
  // only needs to confirm neither KM range reaches LINE at all.
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const t0 = new Date('2026-08-15T10:50:00+08:00');
  const first = await runLineBroadcast(env, {
    allEvents: [congestionEvent({ startKM: '82K+400', endKM: '91K+000' })],
    dedupeAvailable: true,
    now: t0,
  });
  assert.equal(first.pushSucceeded, 0);

  pushCalls.length = 0;
  const t20 = new Date(t0.getTime() + 20 * 60 * 1000);
  const later = await runLineBroadcast(env, {
    allEvents: [congestionEvent({ startKM: '88K+000', endKM: '93K+000' })],
    dedupeAvailable: true,
    now: t20,
  });
  assert.equal(later.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});
