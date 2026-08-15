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
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const forecastEvent = {
    source: 'highway',
    rawId: 'HWY-9',
    type: 'construction',
    road: '台1線',
    direction: '南向',
    location: '90K附近',
    description: '8月15日9時至10時施工', // starts at 09:00 today
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
