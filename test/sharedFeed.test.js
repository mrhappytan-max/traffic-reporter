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
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { publishCollageImage } from '../src/cctv/publishedImage.js';

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

const NOW = new Date('2026-08-19T06:00:00.000Z'); // 14:00 Asia/Taipei

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    title: '國道事故',
    description: '國道1號北向88K發生事故，內側車道封閉',
    road: '國道1號',
    direction: '北向',
    location: '國道1號 北向 88K+000',
    startTime: '2026-08-19T05:50:00.000Z',
    endTime: null,
    updatedAt: '2026-08-19T05:55:00.000Z',
    startKM: '88K+000',
    blockedLanes: 1,
    ...overrides,
  };
}

function product(event, overrides = {}) {
  return {
    eventKeyStr: eventIdOf(event),
    fingerprint: 'ignored-by-feed',
    text: '🚨 交通事故\n國道1號 北向\n事故影響通行\n請提前避開',
    event,
    imageUrl: null,
    imageExpiresAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// eventId / fingerprint contracts
// ---------------------------------------------------------------------------

test('eventId is source:rawId and is stable across content updates', () => {
  const a = accidentEvent();
  const b = accidentEvent({ description: '事故已排除中', updatedAt: '2026-08-19T05:59:00.000Z' });
  assert.equal(eventIdOf(a), 'freeway:FRW-1');
  assert.equal(eventIdOf(a), eventIdOf(b));
});

test('a congestion cluster keeps a deterministic, stable eventId', () => {
  const cluster = { source: 'congestion-cluster', rawId: 'freeway:A+freeway:B', type: 'congestion' };
  assert.equal(eventIdOf(cluster), 'congestion-cluster:freeway:A+freeway:B');
});

test('fingerprint ignores updatedAt-only churn but changes on real content change', async () => {
  const base = accidentEvent();
  const timestampOnly = accidentEvent({ updatedAt: '2026-08-19T05:59:59.000Z' });
  const contentChanged = accidentEvent({ description: '事故已排除' });

  assert.equal(await fingerprintOf(base), await fingerprintOf(timestampOnly));
  assert.notEqual(await fingerprintOf(base), await fingerprintOf(contentChanged));
});

test('fingerprint is a short stable hex digest, not the raw content blob', async () => {
  assert.match(await fingerprintOf(accidentEvent()), /^[0-9a-f]{24}$/);
});

// ---------------------------------------------------------------------------
// snapshot building from completed products
// ---------------------------------------------------------------------------

test('build produces the whitelisted schema using the broadcast text verbatim', async () => {
  const event = accidentEvent();
  const events = await buildSharedFeedEvents([product(event)], [], NOW);
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
  assert.equal(entry.text, '🚨 交通事故\n國道1號 北向\n事故影響通行\n請提前避開');
  assert.equal(entry.createdAt, NOW.toISOString());
  assert.equal(entry.updatedAt, NOW.toISOString());
});

test('the CCTV image URL and its exact expiry are carried into the feed', async () => {
  const expiresAt = new Date(NOW.getTime() + 15 * 60_000).toISOString();
  const events = await buildSharedFeedEvents(
    [product(accidentEvent(), { imageUrl: 'https://tr.example/cctv/image/abc', imageExpiresAt: expiresAt })],
    [],
    NOW
  );
  assert.equal(events[0].imageUrl, 'https://tr.example/cctv/image/abc');
  assert.equal(events[0].imageExpiresAt, expiresAt);
});

test('an event with no image published this run carries null image fields', async () => {
  const events = await buildSharedFeedEvents([product(accidentEvent())], [], NOW);
  assert.equal(events[0].imageUrl, null);
  assert.equal(events[0].imageExpiresAt, null);
});

test('feed output never leaks raw TDX payload fields', async () => {
  const event = accidentEvent({ raw: { EventID: 'X', Secret: 'do-not-leak' } });
  const events = await buildSharedFeedEvents([product(event)], [], NOW);
  const serialised = JSON.stringify(events.map(toPublicEvent));
  assert.ok(!serialised.includes('do-not-leak'));
  assert.ok(!serialised.includes('EventID'));
});

test('updatedAt only advances when the fingerprint changes; createdAt is carried forward', async () => {
  const first = await buildSharedFeedEvents([product(accidentEvent())], [], NOW);

  const later = new Date(NOW.getTime() + 10 * 60_000);
  const unchanged = await buildSharedFeedEvents(
    [product(accidentEvent({ updatedAt: '2026-08-19T06:09:00.000Z' }))],
    first,
    later
  );
  assert.equal(unchanged[0].updatedAt, NOW.toISOString(), 'timestamp churn must not advance updatedAt');
  assert.equal(unchanged[0].createdAt, NOW.toISOString());

  const evenLater = new Date(NOW.getTime() + 20 * 60_000);
  const changed = await buildSharedFeedEvents(
    [product(accidentEvent({ description: '事故已排除' }))],
    unchanged,
    evenLater
  );
  assert.equal(changed[0].updatedAt, evenLater.toISOString(), 'a real content change must advance updatedAt');
  assert.equal(changed[0].createdAt, NOW.toISOString(), 'createdAt must survive a content update');
});

test('malformed products are skipped without throwing', async () => {
  const events = await buildSharedFeedEvents(
    [null, {}, { event: { source: 'freeway' } }, { ...product(accidentEvent()), text: '   ' }, product(accidentEvent())],
    [],
    NOW
  );
  assert.equal(events.length, 1);
});

test('an event absent from this run is retained with a frozen updatedAt', async () => {
  const first = await buildSharedFeedEvents([product(accidentEvent())], [], NOW);
  const later = new Date(NOW.getTime() + 30 * 60_000);
  const afterDisappearance = await buildSharedFeedEvents([], first, later);

  assert.equal(afterDisappearance.length, 1);
  assert.equal(afterDisappearance[0].updatedAt, NOW.toISOString());
});

test('a quiet night outside broadcast hours does not wipe the feed', async () => {
  const first = await buildSharedFeedEvents([product(accidentEvent())], [], NOW);
  let carried = first;
  for (let tick = 1; tick <= 6; tick += 1) {
    carried = await buildSharedFeedEvents([], carried, new Date(NOW.getTime() + tick * 10 * 60_000));
  }
  assert.equal(carried.length, 1);
  assert.equal(carried[0].updatedAt, NOW.toISOString());
});

test('a retained event is dropped once it passes the retention horizon', async () => {
  const first = await buildSharedFeedEvents([product(accidentEvent())], [], NOW);
  const wayLater = new Date(NOW.getTime() + 181 * 60_000);
  assert.equal((await buildSharedFeedEvents([], first, wayLater)).length, 0);
});

test('snapshot is sorted newest-first with a deterministic tie-break', async () => {
  const events = await buildSharedFeedEvents(
    [product(accidentEvent({ rawId: 'FRW-B' })), product(accidentEvent({ rawId: 'FRW-A' }))],
    [],
    NOW
  );
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
  const result = selectFeedWindow([storedEvent('a', 5), storedEvent('b', 95), storedEvent('c', 30)], {
    windowMinutes: 90,
    limit: 50,
    now: NOW,
  });
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.events.map((e) => e.eventId),
    ['a', 'c']
  );
});

test('window selection reports truncated and drops the OLDEST entries', () => {
  const stored = Array.from({ length: 7 }, (_, i) => storedEvent(`e${i}`, i + 1));
  const result = selectFeedWindow(stored, { windowMinutes: 90, limit: 5, now: NOW });

  assert.equal(result.total, 7);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.events.map((e) => e.eventId),
    ['e0', 'e1', 'e2', 'e3', 'e4']
  );
});

test('window selection drops structurally invalid stored entries', () => {
  const stored = [storedEvent('ok', 1), { eventId: 'bad' }, null, { ...storedEvent('x', 1), text: '' }];
  assert.deepEqual(
    selectFeedWindow(stored, { windowMinutes: 90, limit: 50, now: NOW }).events.map((e) => e.eventId),
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
// persistence isolation
// ---------------------------------------------------------------------------

test('persist writes exactly one key and read returns it back', async () => {
  const kv = createMockKV();
  const events = await buildSharedFeedEvents([product(accidentEvent())], [], NOW);
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

test('persistence never touches dedupe, baseline, notified, subscription or ledger keys', async () => {
  const kv = createMockKV();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(accidentEvent())], now: NOW });

  for (const call of kv.putCalls) assert.equal(call.key, SHARED_FEED_KEY);
  for (const key of kv.getCalls) assert.equal(key, SHARED_FEED_KEY);
});

test('read treats a corrupt blob as an empty feed rather than an outage', async () => {
  const back = await readSharedFeed(createMockKV({ [SHARED_FEED_KEY]: '{not json' }));
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

async function seededEnv(products = [product(accidentEvent())]) {
  const kv = createMockKV();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: products, now: NOW });
  return { TRAFFIC_KV: kv, TRAFFIC_FEED_SECRET: 'feed-secret' };
}

test('GET returns schema v1 with generatedAt, total, truncated and events', async () => {
  const response = await handleSharedFeed(feedRequest(), await seededEnv(), NOW);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.schemaVersion, SHARED_FEED_SCHEMA_VERSION);
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.equal(body.windowMinutes, 90);
  assert.equal(body.total, 1);
  assert.equal(body.truncated, false);
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

test('an unconfigured feed secret is a 503, never an anonymous feed', async () => {
  const env = await seededEnv();
  const response = await handleSharedFeed(feedRequest(), { ...env, TRAFFIC_FEED_SECRET: undefined }, NOW);
  assert.equal(response.status, 503);
});

test('a KV storage outage is a 503, never a silent empty feed', async () => {
  const env = { TRAFFIC_KV: failingKV('get'), TRAFFIC_FEED_SECRET: 'feed-secret' };
  assert.equal((await handleSharedFeed(feedRequest(), env, NOW)).status, 503);
});

test('a cache miss returns an empty feed and triggers ZERO upstream fetches', async () => {
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

test('serving a populated feed makes ZERO upstream calls and composes no collage', async () => {
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
  // No R2 binding was ever provided to the handler's env, so a composition
  // attempt could not even have succeeded silently.
  assert.equal(env.CCTV_IMAGES, undefined);
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
// completedProducts contract inside the real broadcast pipeline
// ---------------------------------------------------------------------------

function broadcastEnv(subscriptions, notified = { events: {} }) {
  const store = new Map([
    ['line:subscriptions', JSON.stringify(subscriptions)],
    ['line:notified-state', JSON.stringify(notified)],
  ]);
  return {
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    TRAFFIC_KV: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async put(key, value) {
        store.set(key, value);
      },
    },
  };
}

test('completedProducts records an event even when every target is already notified', async () => {
  const event = accidentEvent();
  const eventKey = eventIdOf(event);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const subscriptions = { users: { U1: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z' } }, groups: {} };

    const first = await runLineBroadcast(broadcastEnv(subscriptions), {
      allEvents: [event],
      dedupeAvailable: true,
      now: NOW,
    });
    assert.equal(first.completedProducts.length, 1);
    assert.equal(first.completedProducts[0].eventKeyStr, eventKey);
    assert.ok(first.completedProducts[0].text.includes('交通事故'));

    // Now replay with that exact target already marked notified for this
    // fingerprint: nothing is pushed, but the finished product must still be
    // visible to the feed.
    const notified = {
      events: { [eventKey]: { targets: { 'user:U1': { fingerprint: first.completedProducts[0].fingerprint, notifiedAt: NOW.toISOString() } } } },
    };
    const second = await runLineBroadcast(broadcastEnv(subscriptions, notified), {
      allEvents: [event],
      dedupeAvailable: true,
      now: NOW,
    });
    assert.equal(second.pushAttempted, 0, 'nothing should be pushed the second time');
    assert.equal(second.completedProducts.length, 1, 'the feed must still see the finished product');
    assert.equal(second.completedProducts[0].text, first.completedProducts[0].text);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('completedProducts is empty under dryRun and when failing closed', async () => {
  const subscriptions = { users: { U1: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z' } }, groups: {} };

  const dry = await runLineBroadcast(broadcastEnv(subscriptions), {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now: NOW,
    dryRun: true,
  });
  assert.deepEqual(dry.completedProducts, []);

  const failClosed = await runLineBroadcast(broadcastEnv(subscriptions), {
    allEvents: [accidentEvent()],
    dedupeAvailable: false,
    now: NOW,
  });
  assert.deepEqual(failClosed.completedProducts, []);
});

test('completedProducts is empty outside broadcast hours', async () => {
  const threeAmTaipei = new Date('2026-08-18T19:00:00.000Z');
  const subscriptions = { users: { U1: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z' } }, groups: {} };
  const result = await runLineBroadcast(broadcastEnv(subscriptions), {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now: threeAmTaipei,
  });
  assert.equal(result.withinBroadcastHours, false);
  assert.deepEqual(result.completedProducts, []);
});

test('the feed never causes a CCTV composition of its own (no R2 binding, no image)', async () => {
  const subscriptions = { users: { U1: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z' } }, groups: {} };
  const env = broadcastEnv(subscriptions); // deliberately no CCTV_IMAGES binding
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  let result;
  try {
    result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(result.cctvImagesAttachedCount, 0);
  assert.equal(result.completedProducts[0].imageUrl, null);
  assert.equal(result.completedProducts[0].imageExpiresAt, null);

  const kv = createMockKV();
  const summary = await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: result.completedProducts, now: NOW });
  assert.equal(summary.withImageCount, 0);
});

test('publishCollageImage returns the exact expiresAt it stored in R2 metadata', async () => {
  const puts = [];
  const bucket = {
    async put(key, body, options) {
      puts.push({ key, options });
    },
  };
  const published = await publishCollageImage(bucket, new Uint8Array([1, 2, 3]), NOW);

  assert.equal(published.ok, true);
  assert.equal(published.expiresAt, puts[0].options.customMetadata.expiresAt);
  assert.equal(published.expiresAt, new Date(NOW.getTime() + published.expiresIn * 1000).toISOString());
});
