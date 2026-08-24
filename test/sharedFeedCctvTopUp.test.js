// V57.1 — the Shared-Feed-only CCTV top-up
// (broadcastPipeline.js#topUpSharedFeedCctvImages), locked to the real
// Production incident it was written for.
//
// THE SCENARIO UNDER TEST (2026-08-20, 國1 南向 88K+000 交通事故):
//   08:10 — PBS reports it first. PBS-sourced accidents are structurally
//           CCTV-ineligible, so the LINE push is text-only. ACCEPTED, and
//           asserted below to be unchanged (test 4).
//   08:20 — the TDX `freeway` twin arrives, CCTV-eligible, cameras present
//           (87K+050 / 88K+590 / 87K+490 / 89K+300, exactly as in the real
//           metadata cache), but incident suppression matched it to the PBS
//           report -> pendingTargets === 0. Before V57.1 the push loop
//           `continue`d before CCTV preparation, so the Shared Feed could
//           only ever record imageUrl: null.
//
// DELIBERATELY NO REAL JPEG CODEC HERE. Every codec call goes through
// broadcastPipeline's existing TEST-ONLY cctvCodecOverride (pure dependency
// injection — see cctv/collage.js), with a trivial in-file fake. What these
// tests verify is ORCHESTRATION — how many times a collage is composed and
// published, whether LINE was touched, what lands in completedProducts —
// none of which depends on real JPEG bytes. test/broadcastCctvIntegration.js
// remains the place that exercises the real @jsquash codec.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import {
  SHARED_FEED_KEY,
  eventIdOf,
  fingerprintOf,
  runSharedFeedPersist,
  isStoredImageStillValid,
} from '../src/traffic/sharedFeed.js';
import { handleSharedFeed } from '../src/traffic/sharedFeedHandler.js';

const NOW = new Date('2026-08-20T08:20:00+08:00'); // the real 08:20 tick
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

// --- fakes -----------------------------------------------------------------

/** A minimal JPEG-shaped buffer: real SOI/EOI markers so extractFirstJpegFrame's scanner finds a complete frame. */
function fakeJpegBytes() {
  return new Uint8Array([0xff, 0xd8, ...new Array(64).fill(0x42), 0xff, 0xd9]);
}

/** Pure-JS stand-in for @jsquash/jpeg — see this file's header. */
const FAKE_CODEC = {
  async decodeJpeg() {
    const width = 8;
    const height = 8;
    return { data: new Uint8ClampedArray(width * height * 4).fill(120), width, height };
  },
  async encodeJpeg() {
    return new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]).buffer;
  },
};

function createMockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    gets: [],
    async get(key) {
      this.gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function r2Bucket() {
  const store = new Map();
  return {
    store,
    putCalls: 0,
    async put(key, value, options = {}) {
      this.putCalls += 1;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { value: bytes, customMetadata: options.customMetadata || {} });
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, async arrayBuffer() { return entry.value.buffer; } };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/** LINE push + freeway.gov.tw frames ONLY. Any other host (notably TDX) throws — an implicit "0 TDX calls" proof for every test here. */
function makeMock({ frameOk = true } = {}) {
  const pushCalls = [];
  const hits = { frame: 0 };
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushCalls.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      if (!frameOk) return new Response('nope', { status: 404 });
      return new Response(fakeJpegBytes(), { status: 200 });
    }
    throw new Error(`unexpected fetch (must never call TDX from the broadcast path): ${href}`);
  };
  return { fetchFn, pushCalls, hits };
}

// --- fixtures mirroring the real 88K incident -------------------------------

function freewayAccident(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'A15040100H-01-20260820080028537100020',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    location: '湖口服務區附近',
    description: '事故影響通行',
    startKM: '88K+000',
    endKM: '88K+000',
    startTime: '2026-08-20T08:00:00+08:00',
    endTime: null,
    updatedAt: '2026-08-20T08:00:00+08:00',
    ...overrides,
  };
}

function pbsAccident(overrides = {}) {
  return {
    source: 'pbs',
    rawId: '11508200006-5',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    location: '',
    description: '國道一號南向88K+000事故影響通行',
    startKM: null,
    endKM: null,
    // 2026-08-24 — added when the Location Quality Gate shipped. This is
    // not new information: pbs/normalize.js's extractDisplayKmFromText
    // already derives exactly 88 from the `description` two lines up, so
    // a real normalized PBS event of this shape has always carried it.
    // The fixture just hand-built the normalized object and skipped the
    // field, because what it pins is CCTV budget behaviour, not location.
    displayKM: 88,
    startTime: '2026-08-20T08:03:00+08:00',
    endTime: null,
    updatedAt: '2026-08-20T08:03:00+08:00',
    ...overrides,
  };
}

/** The four real mainline cameras around 88K, one per quadrant. */
const CCTV_RECORDS = [
  { CCTVID: 'CCTV-N1-S-87.050-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '87K+050', VideoStreamURL: 'https://cctv1.freeway.gov.tw/a.jpg' },
  { CCTVID: 'CCTV-N1-S-88.590-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '88K+590', VideoStreamURL: 'https://cctv1.freeway.gov.tw/b.jpg' },
  { CCTVID: 'CCTV-N1-N-87.490-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'N', LocationMile: '87K+490', VideoStreamURL: 'https://cctv1.freeway.gov.tw/c.jpg' },
  { CCTVID: 'CCTV-N1-N-89.300-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'N', LocationMile: '89K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/d.jpg' },
];

function metadataEnvelope() {
  return JSON.stringify({ records: CCTV_RECORDS, fetchedAt: NOW.toISOString() });
}

/** The exact production suppression record: the PBS report already notified, km 88, same road+direction. */
function suppressionStateSeed() {
  return JSON.stringify({
    incidents: {
      '國道一號|南向': [
        {
          notificationKey: 'pbs:11508200006-5',
          km: 88,
          lastSeenAt: '2026-08-20T08:10:00+08:00',
          escalation: { type: 'accident', blockedLanes: null, closureSignal: false },
        },
      ],
    },
    updatedAt: '2026-08-20T08:10:00+08:00',
  });
}

function feedSeed(events) {
  return JSON.stringify({ schemaVersion: 1, events, updatedAt: '2026-08-20T08:10:00+08:00' });
}

async function makeEnv({ seedSuppression = true, feedEvents = null } = {}) {
  const initial = { [FREEWAY_METADATA_KEY]: metadataEnvelope() };
  if (seedSuppression) initial['line:incident-suppression-state'] = suppressionStateSeed();
  if (feedEvents) initial[SHARED_FEED_KEY] = feedSeed(feedEvents);
  const kv = createMockKV(initial);
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const bucket = r2Bucket();
  return { env: { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: bucket }, kv, bucket };
}

function run(env, allEvents) {
  return runLineBroadcast(env, {
    allEvents,
    dedupeAvailable: true,
    now: NOW,
    cctvCodecOverride: FAKE_CODEC,
  });
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
});

// --- 1: the actual regression ----------------------------------------------

test('1: pendingTargets=0 + freeway-eligible + no stored image -> composes/publishes exactly ONCE and the completed product carries imageUrl + imageExpiresAt', async () => {
  const { env, bucket } = await makeEnv();
  const { fetchFn, pushCalls, hits } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [freewayAccident()]);

  assert.equal(result.pendingTargetCount, 0, 'incident suppression must still zero the pending targets');
  assert.equal(pushCalls.length, 0, 'this Worker must NOT re-push to LINE');
  assert.equal(result.pushAttempted, 0);

  assert.equal(result.cctvFeedOnlyAttemptedCount, 1);
  assert.equal(result.cctvFeedOnlyAttachedCount, 1);
  assert.equal(bucket.putCalls, 1, 'exactly one R2 publish');
  assert.equal(hits.frame, 4, 'four quadrant frames fetched once');

  assert.equal(result.completedProducts.length, 1);
  const product = result.completedProducts[0];
  assert.match(product.imageUrl, /^https:\/\/.+\/cctv\/image\/[0-9a-f]+$/);
  assert.ok(product.imageExpiresAt, 'imageExpiresAt must be recorded alongside the URL');

  // ...and it is the R2 object's OWN customMetadata expiry, never a recomputed one.
  const stored = [...bucket.store.values()][0];
  assert.equal(product.imageExpiresAt, stored.customMetadata.expiresAt);

  // The LINE-push counters stay untouched — nothing here was broadcast.
  assert.equal(result.cctvImagesAttachedCount, 0);
});

// --- 2: anti-redo guard -----------------------------------------------------

test('2: pendingTargets=0 + a still-valid stored image -> ZERO compose, ZERO frame fetch, ZERO R2 publish (reused instead)', async () => {
  const event = freewayAccident();
  const stored = {
    eventId: eventIdOf(event),
    fingerprint: await fingerprintOf(event),
    text: 'previous text',
    imageUrl: 'https://traffic-reporter.mr-happytan.workers.dev/cctv/image/deadbeef',
    imageExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    createdAt: '2026-08-20T08:10:00+08:00',
    updatedAt: '2026-08-20T08:10:00+08:00',
    road: '國道一號',
    type: 'accident',
    direction: '南向',
  };
  const { env, bucket } = await makeEnv({ feedEvents: [stored] });
  const { fetchFn, pushCalls, hits } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [event]);

  assert.equal(result.cctvFeedOnlyAttemptedCount, 0, 'must not re-enter the CCTV pipeline at all');
  assert.equal(result.cctvFeedOnlyReusedCount, 1);
  assert.equal(hits.frame, 0, 'no freeway.gov.tw frame fetch');
  assert.equal(bucket.putCalls, 0, 'no R2 publish');
  assert.equal(pushCalls.length, 0);

  const product = result.completedProducts[0];
  assert.equal(product.imageUrl, stored.imageUrl);
  assert.equal(product.imageExpiresAt, stored.imageExpiresAt);
});

// --- 3: expiry is what unlocks a redo --------------------------------------

test('3: pendingTargets=0 + an EXPIRED stored image -> composes exactly once more', async () => {
  const event = freewayAccident();
  const stored = {
    eventId: eventIdOf(event),
    fingerprint: await fingerprintOf(event),
    text: 'previous text',
    imageUrl: 'https://traffic-reporter.mr-happytan.workers.dev/cctv/image/deadbeef',
    imageExpiresAt: new Date(NOW.getTime() - 60_000).toISOString(), // one minute ago
    createdAt: '2026-08-20T08:00:00+08:00',
    updatedAt: '2026-08-20T08:00:00+08:00',
    road: '國道一號',
    type: 'accident',
    direction: '南向',
  };
  const { env, bucket } = await makeEnv({ feedEvents: [stored] });
  const { fetchFn, hits } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [event]);

  assert.equal(result.cctvFeedOnlyReusedCount, 0);
  assert.equal(result.cctvFeedOnlyAttemptedCount, 1);
  assert.equal(result.cctvFeedOnlyAttachedCount, 1);
  assert.equal(bucket.putCalls, 1);
  assert.equal(hits.frame, 4);
  assert.notEqual(result.completedProducts[0].imageUrl, stored.imageUrl, 'a fresh URL, not the expired one');
});

// --- 4: PBS stays exactly as it was ----------------------------------------

test('4: a PBS-sourced accident with pendingTargets=0 gets ZERO CCTV work — eligibility is untouched and the feed is never even read for it', async () => {
  const { env, kv, bucket } = await makeEnv();
  const { fetchFn, pushCalls, hits } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [pbsAccident()]);

  assert.equal(result.pendingTargetCount, 0);
  assert.equal(result.cctvFeedOnlyAttemptedCount, 0);
  assert.equal(result.cctvFeedOnlyAttachedCount, 0);
  assert.equal(result.cctvFeedOnlyReusedCount, 0);
  assert.equal(hits.frame, 0);
  assert.equal(bucket.putCalls, 0);
  assert.equal(pushCalls.length, 0);
  assert.equal(result.completedProducts[0].imageUrl, null);
  assert.ok(
    !kv.gets.includes(SHARED_FEED_KEY),
    'the pure eligibility gate must reject PBS before the pass does any I/O at all'
  );
});

// --- 5: this Worker's own LINE behaviour is unchanged -----------------------

test('5a: with a pending target, the push path behaves exactly as before and the top-up pass does nothing', async () => {
  const { env, bucket } = await makeEnv({ seedSuppression: false }); // nothing suppressed -> a real push
  const { fetchFn, pushCalls } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [freewayAccident()]);

  assert.equal(result.pushAttempted, 1);
  assert.equal(result.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1, 'exactly one LINE API call, as always');
  assert.equal(pushCalls[0].messages.length, 2, 'text + image in ONE request');
  assert.equal(result.cctvImagesAttachedCount, 1, 'counted on the push path, as before');
  assert.equal(result.cctvFeedOnlyAttemptedCount, 0, 'the top-up pass must not touch a pushed event');
  assert.equal(bucket.putCalls, 1, 'still exactly one publish overall');
});

test('5b: the top-up pass never increases this Worker\'s LINE push count, even when it does publish an image', async () => {
  const { env } = await makeEnv();
  const { fetchFn, pushCalls } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [freewayAccident()]);

  assert.equal(result.cctvFeedOnlyAttachedCount, 1, 'an image WAS produced...');
  assert.equal(pushCalls.length, 0, '...and still nothing was sent to LINE');
  assert.equal(result.pushAttempted, 0);
  assert.equal(result.pushSucceeded, 0);
  assert.equal(result.lastLinePushAt, null);
});

// --- 6: serving the feed still makes zero upstream calls --------------------

test('6: GET /internal/shared-feed makes 0 upstream calls and never composes anything', async () => {
  const { env, bucket, kv } = await makeEnv();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`the shared-feed READ path must never fetch anything: ${url}`);
  };

  await kv.put(
    SHARED_FEED_KEY,
    feedSeed([
      {
        eventId: 'freeway:X',
        fingerprint: 'abc123',
        text: '🚨 交通事故',
        imageUrl: 'https://traffic-reporter.mr-happytan.workers.dev/cctv/image/aa',
        imageExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        road: '國道一號',
        type: 'accident',
        direction: '南向',
      },
    ])
  );

  const request = new Request('https://example.com/internal/shared-feed', {
    headers: { authorization: 'Bearer s3cret' },
  });
  const res = await handleSharedFeed(request, { ...env, TRAFFIC_FEED_SECRET: 's3cret' }, NOW);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].imageExpiresAt, new Date(NOW.getTime() + 5 * 60_000).toISOString());
  assert.equal(bucket.putCalls, 0, 'serving the feed must never publish an image');
});

// --- 7: end-to-end — the feed actually ends up carrying the image -----------

test('7: end-to-end — a suppressed freeway accident lands in the Shared Feed WITH imageUrl and the R2 object\'s own imageExpiresAt', async () => {
  const { env, kv, bucket } = await makeEnv();
  const { fetchFn, pushCalls } = makeMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const result = await run(env, [freewayAccident()]);
  assert.equal(pushCalls.length, 0);

  const persisted = await runSharedFeedPersist(env, { completedProducts: result.completedProducts, now: NOW });
  assert.equal(persisted.committed, true);
  assert.equal(persisted.withImageCount, 1);

  const feed = JSON.parse(kv.store.get(SHARED_FEED_KEY));
  const entry = feed.events.find((e) => e.eventId === eventIdOf(freewayAccident()));
  assert.ok(entry, 'the freeway event must be in the feed');
  assert.match(entry.imageUrl, /^https:\/\//);
  const storedObject = [...bucket.store.values()][0];
  assert.equal(entry.imageExpiresAt, storedObject.customMetadata.expiresAt, 'the EXACT R2 expiry, never recomputed');
  assert.equal(isStoredImageStillValid(entry, entry.fingerprint, NOW), true);
});

// --- 8: a later tick must not silently drop a still-valid image -------------

test('8: a second tick with no new image carries the still-valid stored image forward instead of nulling it', async () => {
  const event = freewayAccident();
  const stored = {
    eventId: eventIdOf(event),
    fingerprint: await fingerprintOf(event),
    text: '🚨 交通事故',
    imageUrl: 'https://traffic-reporter.mr-happytan.workers.dev/cctv/image/keepme',
    imageExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    createdAt: '2026-08-20T08:20:00+08:00',
    updatedAt: '2026-08-20T08:20:00+08:00',
    road: '國道一號',
    type: 'accident',
    direction: '南向',
  };
  const { env, kv } = await makeEnv({ feedEvents: [stored] });

  // A product with no image at all (e.g. the top-up pass ran out of budget).
  const persisted = await runSharedFeedPersist(env, {
    completedProducts: [{ event, text: '🚨 交通事故', imageUrl: null, imageExpiresAt: null }],
    now: NOW,
  });

  assert.equal(persisted.withImageCount, 1, 'the still-valid image must survive the rebuild');
  const feed = JSON.parse(kv.store.get(SHARED_FEED_KEY));
  const entry = feed.events.find((e) => e.eventId === eventIdOf(event));
  assert.equal(entry.imageUrl, stored.imageUrl);
  assert.equal(entry.imageExpiresAt, stored.imageExpiresAt);
});

test('9: an EXPIRED stored image is NOT carried forward — the entry goes back to text-only', async () => {
  const event = freewayAccident();
  const stored = {
    eventId: eventIdOf(event),
    fingerprint: await fingerprintOf(event),
    text: '🚨 交通事故',
    imageUrl: 'https://traffic-reporter.mr-happytan.workers.dev/cctv/image/old',
    imageExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    createdAt: '2026-08-20T08:00:00+08:00',
    updatedAt: '2026-08-20T08:00:00+08:00',
    road: '國道一號',
    type: 'accident',
    direction: '南向',
  };
  const { env, kv } = await makeEnv({ feedEvents: [stored] });

  const persisted = await runSharedFeedPersist(env, {
    completedProducts: [{ event, text: '🚨 交通事故', imageUrl: null, imageExpiresAt: null }],
    now: NOW,
  });

  assert.equal(persisted.withImageCount, 0);
  const feed = JSON.parse(kv.store.get(SHARED_FEED_KEY));
  const entry = feed.events.find((e) => e.eventId === eventIdOf(event));
  assert.equal(entry.imageUrl, null);
  assert.equal(entry.imageExpiresAt, null);
});
