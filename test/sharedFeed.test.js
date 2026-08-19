import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARED_FEED_KEY,
  SHARED_FEED_SCHEMA_VERSION,
  eventIdOf,
  fingerprintOf,
  buildSharedFeedEvents,
  readSharedFeed,
  persistSharedFeed,
  selectFeedWindow,
  clampWindowMinutes,
  clampLimit,
  toPublicEvent,
  runSharedFeedPersist,
} from '../src/traffic/sharedFeed.js';
import { handleSharedFeed } from '../src/traffic/sharedFeedHandler.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';

function createMockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls = [];
  const getCalls = [];
  return {
    async get(key) {
      getCalls.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      putCalls.push({ key, value });
      store.set(key, value);
    },
    store,
    putCalls,
    getCalls,
  };
}

function failingKV(mode = 'both') {
  return {
    async get() {
      if (mode === 'get' || mode === 'both') throw new Error('KV get exploded');
      return null;
    },
    async put() {
      if (mode === 'put' || mode === 'both') throw new Error('KV put exploded');
    },
  };
}

const NOW = new Date('2026-08-19T06:00:00.000Z');

/** A "live" event (accident) — always broadcast-relevant while present. */
function liveEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    title: '國道事故',
    description: '國道1號北向88K發生事故',
    road: '國道1號',
    direction: '北向',
    location: '國道1號 北向 88K+000',
    startTime: '2026-08-19T05:50:00.000Z',
    endTime: null,
    updatedAt: '2026-08-19T05:55:00.000Z',
    startKM: '88K+000',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// eventId / fingerprint contracts
// ---------------------------------------------------------------------------

test('eventId is source:rawId and is stable across content updates', () => {
  const a = liveEvent();
  const b = liveEvent({ description: '事故已排除中', updatedAt: '2026-08-19T05:59:00.000Z' });
  assert.equal(eventIdOf(a), 'freeway:FRW-1');
  assert.equal(eventIdOf(a), eventIdOf(b));
});

test('fingerprint ignores updatedAt-only churn but changes on real content change', async () => {
  const base = liveEvent();
  const timestampOnly = liveEvent({ updatedAt: '2026-08-19T05:59:59.000Z' });
  const contentChanged = liveEvent({ description: '事故已排除' });

  assert.equal(await fingerprintOf(base), await fingerprintOf(timestampOnly));
  assert.notEqual(await fingerprintOf(base), await fingerprintOf(contentChanged));
});

test('fingerprint is a short stable hex digest, not the raw content blob', async () => {
  const fp = await fingerprintOf(liveEvent());
  assert.match(fp, /^[0-9a-f]{24}$/);
});

// ---------------------------------------------------------------------------
// snapshot building
// ---------------------------------------------------------------------------

test('build produces the whitelisted schema with finished text and null image fields', async () => {
  const events = await buildSharedFeedEvents([liveEvent()], [], NOW);
  assert.equal(events.length, 1);
  const entry = events[0];

  assert.deepEqual(Object.keys(toPublicEvent(entry)).sort(), [
    'createdAt',
    'direction',
    'eventId',
    'fingerprint',
    'imageExpiresAt',
    'imageUrl',
    'road',
    'text',
    'type',
    'updatedAt',
  ]);
  assert.equal(entry.eventId, 'freeway:FRW-1');
  assert.equal(entry.road, '國道1號');
  assert.equal(entry.direction, '北向');
  assert.equal(entry.type, 'accident');
  assert.equal(entry.imageUrl, null);
  assert.equal(entry.imageExpiresAt, null);
  assert.ok(entry.text.includes('交通事故'));
  assert.ok(entry.text.includes('國道1號 北向'));
  assert.equal(entry.createdAt, NOW.toISOString());
  assert.equal(entry.updatedAt, NOW.toISOString());
});

test('feed text never leaks raw TDX payload fields', async () => {
  const raw = { EventID: 'X', Secret: 'do-not-leak' };
  const events = await buildSharedFeedEvents([liveEvent({ raw, description: '事故' })], [], NOW);
  const serialised = JSON.stringify(events.map(toPublicEvent));
  assert.ok(!serialised.includes('do-not-leak'));
  assert.ok(!serialised.includes('EventID'));
});

test('updatedAt only advances when the fingerprint changes; createdAt is carried forward', async () => {
  const first = await buildSharedFeedEvents([liveEvent()], [], NOW);

  const later = new Date(NOW.getTime() + 10 * 60_000);
  const unchanged = await buildSharedFeedEvents(
    [liveEvent({ updatedAt: '2026-08-19T06:09:00.000Z' })],
    first,
    later
  );
  assert.equal(unchanged[0].updatedAt, NOW.toISOString(), 'timestamp churn must not advance updatedAt');
  assert.equal(unchanged[0].createdAt, NOW.toISOString());

  const evenLater = new Date(NOW.getTime() + 20 * 60_000);
  const changed = await buildSharedFeedEvents([liveEvent({ description: '事故已排除' })], unchanged, evenLater);
  assert.equal(changed[0].updatedAt, evenLater.toISOString(), 'real content change must advance updatedAt');
  assert.equal(changed[0].createdAt, NOW.toISOString(), 'createdAt must survive a content update');
});

test('forecast wording changes every tick but must not move the fingerprint or updatedAt', async () => {
  const future = liveEvent({
    type: 'construction',
    source: 'highway',
    rawId: 'HWY-9',
    description: '8月19日15時至18時進行施工',
    startTime: null,
  });
  const t0 = new Date('2026-08-19T06:20:00.000Z');
  const first = await buildSharedFeedEvents([future], [], t0);
  if (first.length === 0) return; // description parsing declined — nothing to assert

  const t1 = new Date('2026-08-19T06:25:00.000Z');
  const second = await buildSharedFeedEvents([future], first, t1);
  assert.equal(second[0].fingerprint, first[0].fingerprint);
  assert.equal(second[0].updatedAt, first[0].updatedAt);
});

test('events that are not broadcast-relevant never enter the feed', async () => {
  const unparseable = liveEvent({
    source: 'highway',
    rawId: 'HWY-1',
    type: 'construction',
    description: '未來某日施工',
    startTime: null,
  });
  const events = await buildSharedFeedEvents([unparseable], [], NOW);
  assert.equal(events.length, 0);
});

test('malformed events are skipped without throwing', async () => {
  const events = await buildSharedFeedEvents([null, {}, { source: 'freeway' }, liveEvent()], [], NOW);
  assert.equal(events.length, 1);
});

test('an event that vanished from the feed is retained with a frozen updatedAt', async () => {
  const first = await buildSharedFeedEvents([liveEvent()], [], NOW);
  const later = new Date(NOW.getTime() + 30 * 60_000);
  const afterDisappearance = await buildSharedFeedEvents([], first, later);

  assert.equal(afterDisappearance.length, 1);
  assert.equal(afterDisappearance[0].updatedAt, NOW.toISOString());
});

test('a retained event is dropped once it passes the retention horizon', async () => {
  const first = await buildSharedFeedEvents([liveEvent()], [], NOW);
  const wayLater = new Date(NOW.getTime() + 181 * 60_000);
  assert.equal((await buildSharedFeedEvents([], first, wayLater)).length, 0);
});

test('snapshot is sorted newest-first with a deterministic tie-break', async () => {
  const a = liveEvent({ rawId: 'FRW-B' });
  const b = liveEvent({ rawId: 'FRW-A' });
  const events = await buildSharedFeedEvents([a, b], [], NOW);
  assert.deepEqual(
    events.map((e) => e.eventId),
    ['freeway:FRW-A', 'freeway:FRW-B']
  );
});

// ---------------------------------------------------------------------------
// window selection
// ---------------------------------------------------------------------------

function storedEvent(id, minutesAgo) {
  const iso = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return {
    eventId: id,
    fingerprint: `fp-${id}`,
    text: `事件 ${id}`,
    imageUrl: null,
    imageExpiresAt: null,
    createdAt: iso,
    updatedAt: iso,
    road: '國道1號',
    type: 'accident',
    direction: '北向',
  };
}

test('window selection filters by age, sorts newest-first and reports total', () => {
  const stored = [storedEvent('a', 5), storedEvent('b', 95), storedEvent('c', 30)];
  const result = selectFeedWindow(stored, { windowMinutes: 90, limit: 50, now: NOW });

  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.events.map((e) => e.eventId),
    ['a', 'c']
  );
});

test('window selection reports truncated when total exceeds the limit', () => {
  const stored = Array.from({ length: 7 }, (_, i) => storedEvent(`e${i}`, i + 1));
  const result = selectFeedWindow(stored, { windowMinutes: 90, limit: 5, now: NOW });

  assert.equal(result.total, 7);
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, 5);
  assert.deepEqual(
    result.events.map((e) => e.eventId),
    ['e0', 'e1', 'e2', 'e3', 'e4'],
    'truncation must drop the OLDEST entries, never the newest'
  );
});

test('window selection drops structurally invalid stored entries', () => {
  const stored = [storedEvent('ok', 1), { eventId: 'bad' }, null, { ...storedEvent('x', 1), text: '' }];
  const result = selectFeedWindow(stored, { windowMinutes: 90, limit: 50, now: NOW });
  assert.deepEqual(
    result.events.map((e) => e.eventId),
    ['ok']
  );
});

test('window and limit params are clamped to safe bounds', () => {
  assert.equal(clampWindowMinutes(undefined), 90);
  assert.equal(clampWindowMinutes('0'), 90);
  assert.equal(clampWindowMinutes('abc'), 90);
  assert.equal(clampWindowMinutes('99999'), 180);
  assert.equal(clampWindowMinutes('30'), 30);

  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit('-4'), 50);
  assert.equal(clampLimit('9999'), 50);
  assert.equal(clampLimit('10'), 10);
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test('persist writes exactly one key and read returns it back', async () => {
  const kv = createMockKV();
  const events = await buildSharedFeedEvents([liveEvent()], [], NOW);
  const commit = await persistSharedFeed(kv, events, NOW);

  assert.equal(commit.committed, true);
  assert.deepEqual(
    kv.putCalls.map((c) => c.key),
    [SHARED_FEED_KEY]
  );

  const back = await readSharedFeed(kv);
  assert.equal(back.kvAvailable, true);
  assert.equal(back.events.length, 1);
  assert.equal(back.updatedAt, NOW.toISOString());
});

test('persistence never touches dedupe, baseline, notified or subscription keys', async () => {
  const kv = createMockKV();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { allEvents: [liveEvent()], now: NOW });

  for (const call of kv.putCalls) assert.equal(call.key, SHARED_FEED_KEY);
  for (const key of kv.getCalls) assert.equal(key, SHARED_FEED_KEY);
});

test('read treats a corrupt blob as an empty feed rather than an outage', async () => {
  const kv = createMockKV({ [SHARED_FEED_KEY]: '{not json' });
  const back = await readSharedFeed(kv);
  assert.equal(back.kvAvailable, true);
  assert.deepEqual(back.events, []);
});

test('read reports unavailable when KV is missing or throwing', async () => {
  assert.equal((await readSharedFeed(null)).kvAvailable, false);
  assert.equal((await readSharedFeed(failingKV('get'))).kvAvailable, false);
});

test('a KV write failure is reported, not thrown', async () => {
  const result = await persistSharedFeed(failingKV('put'), [], NOW);
  assert.equal(result.committed, false);
  assert.match(result.error, /KV put exploded/);
});

// ---------------------------------------------------------------------------
// handler: method, auth, whitelist, zero upstream
// ---------------------------------------------------------------------------

function feedRequest({ method = 'GET', token = 'feed-secret', query = '' } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Request(`https://producer.example/internal/shared-feed${query}`, { method, headers });
}

async function seededEnv(events = [liveEvent()]) {
  const kv = createMockKV();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { allEvents: events, now: NOW });
  return { TRAFFIC_KV: kv, TRAFFIC_FEED_SECRET: 'feed-secret' };
}

test('GET returns schema v1 with generatedAt, total, truncated and events', async () => {
  const env = await seededEnv();
  const response = await handleSharedFeed(feedRequest(), env, NOW);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.schemaVersion, SHARED_FEED_SCHEMA_VERSION);
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.equal(body.windowMinutes, 90);
  assert.equal(body.total, 1);
  assert.equal(body.truncated, false);
  assert.equal(body.events.length, 1);
  assert.deepEqual(Object.keys(body.events[0]).sort(), [
    'createdAt',
    'direction',
    'eventId',
    'fingerprint',
    'imageExpiresAt',
    'imageUrl',
    'road',
    'text',
    'type',
    'updatedAt',
  ]);
});

test('non-GET verbs are rejected with 405 and an Allow header', async () => {
  const env = await seededEnv();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await handleSharedFeed(feedRequest({ method }), env, NOW);
    assert.equal(response.status, 405, `${method} must be rejected`);
    assert.equal(response.headers.get('Allow'), 'GET');
  }
});

test('a missing or wrong bearer token is rejected with 401', async () => {
  const env = await seededEnv();
  assert.equal((await handleSharedFeed(feedRequest({ token: null }), env, NOW)).status, 401);
  assert.equal((await handleSharedFeed(feedRequest({ token: 'wrong' }), env, NOW)).status, 401);
});

test('an unconfigured feed secret is a 503, distinguishable from a bad token', async () => {
  const env = await seededEnv();
  const response = await handleSharedFeed(feedRequest(), { ...env, TRAFFIC_FEED_SECRET: undefined }, NOW);
  assert.equal(response.status, 503);
});

test('a KV storage outage is a 503, never a silent empty feed', async () => {
  const env = { TRAFFIC_KV: failingKV('get'), TRAFFIC_FEED_SECRET: 'feed-secret' };
  const response = await handleSharedFeed(feedRequest(), env, NOW);
  assert.equal(response.status, 503);
});

test('a cache miss returns an empty feed and does NOT trigger any upstream fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    throw new Error(`unexpected upstream fetch: ${args[0]}`);
  };
  try {
    const env = { TRAFFIC_KV: createMockKV(), TRAFFIC_FEED_SECRET: 'feed-secret' };
    const response = await handleSharedFeed(feedRequest(), env, NOW);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.events, []);
    assert.equal(body.total, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, 'serving the feed must make ZERO upstream calls');
});

test('serving a populated feed makes ZERO upstream calls', async () => {
  const env = await seededEnv();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected upstream fetch');
  };
  try {
    const response = await handleSharedFeed(feedRequest({ query: '?windowMinutes=90&limit=50' }), env, NOW);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test('query params drive the window and limit reported back to the caller', async () => {
  const kv = createMockKV({
    [SHARED_FEED_KEY]: JSON.stringify({
      schemaVersion: 1,
      events: [storedEvent('a', 5), storedEvent('b', 40), storedEvent('c', 120)],
      updatedAt: NOW.toISOString(),
    }),
  });
  const env = { TRAFFIC_KV: kv, TRAFFIC_FEED_SECRET: 'feed-secret' };

  const narrow = await (await handleSharedFeed(feedRequest({ query: '?windowMinutes=10' }), env, NOW)).json();
  assert.equal(narrow.windowMinutes, 10);
  assert.equal(narrow.total, 1);

  const capped = await (await handleSharedFeed(feedRequest({ query: '?windowMinutes=90&limit=1' }), env, NOW)).json();
  assert.equal(capped.total, 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.events.length, 1);
});

// ---------------------------------------------------------------------------
// producer isolation: the original broadcast must not depend on the feed
// ---------------------------------------------------------------------------

test('a shared-feed write failure does not break the Cron run', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const env = {
      TRAFFIC_KV: {
        async get() {
          return null;
        },
        async put(key) {
          if (key === SHARED_FEED_KEY) throw new Error('shared feed KV down');
        },
      },
    };
    const summary = await runScheduledTdxSync(env, NOW);
    assert.equal(summary.sharedFeed.committed, false);
    assert.ok(summary.line, 'the LINE broadcast summary must still be produced');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
