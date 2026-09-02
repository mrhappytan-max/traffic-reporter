// Integration regression fixtures — branch integration/v57.2-v1.8.6.5-production.
//
// Two REAL, named Production events (verbatim rawIds), run through the
// REAL normalize/classify code (src/tdx/normalize.js's normalizeRoadEvent
// — exactly what runScheduledTdxSync's TDX fetch step calls) and then the
// REAL broadcast pipeline (runLineBroadcast) + Shared Feed persistence
// (runSharedFeedPersist) exactly as scheduled.js's real cron handler
// chains them, using the real @jsquash JPEG codec (via
// test/testJpegCodec.js — same pattern as broadcastCctvIntegration.test.js)
// so Fixture A's CCTV compose is not just mocked away.
//
// Fixture A — rawId A15040100H-01-20260820201348494100020, source
//   freeway, 國1 北向 93K+500, genuine accident. Must produce: type
//   accident, direction 北向 unchanged, KM 93K+500, an official
//   human-readable location + short Maps URL, CCTV-eligible, and — the
//   actual bug this fixture targets — when image prepare succeeds, BOTH
//   the LINE payload AND the Shared Feed must carry the SAME imageUrl
//   with a correct imageExpiresAt (never a null Shared-Feed image when
//   R2 publish actually succeeded).
//
// Fixture B — rawId A15040100H-01-20260820200616953100035, source
//   freeway, 國1 南向 92K+800, "其他異常告警－行人誤闖". Must produce:
//   type other, direction 南向 unchanged, must NOT show "交通事故"/
//   "事故影響通行", must have an official human-readable location + short
//   Maps URL, CCTV must NOT be eligible, and the absence of an image must
//   never alter the text broadcast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { runSharedFeedPersist } from '../src/traffic/sharedFeed.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const NOW = new Date('2026-08-20T20:20:00+08:00'); // a real TDX-scheduled tick, matches the R2 evidence window
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

function createMockKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
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
      store.set(key, { value: bytes, customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} });
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, httpMetadata: entry.httpMetadata, async arrayBuffer() { return entry.value.buffer; } };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

async function realJpegBytes() {
  const width = 8;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 90;
    data[i * 4 + 1] = 90;
    data[i * 4 + 2] = 90;
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(await encodeJpeg({ data, width, height }, { quality: 80 }));
}

// Four quadrant cameras around 93.5K on 國道一號 — same shape/spacing as
// the real production metadata already used elsewhere in this suite
// (sharedFeedCctvTopUp.test.js's 88K set), just re-centered.
const CCTV_RECORDS = [
  { CCTVID: 'CCTV-N1-S-92.550-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '92K+550', VideoStreamURL: 'https://cctv1.freeway.gov.tw/a.jpg' },
  { CCTVID: 'CCTV-N1-S-94.090-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '94K+090', VideoStreamURL: 'https://cctv1.freeway.gov.tw/b.jpg' },
  { CCTVID: 'CCTV-N1-N-92.990-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'N', LocationMile: '92K+990', VideoStreamURL: 'https://cctv1.freeway.gov.tw/c.jpg' },
  { CCTVID: 'CCTV-N1-N-94.800-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'N', LocationMile: '94K+800', VideoStreamURL: 'https://cctv1.freeway.gov.tw/d.jpg' },
];

function metadataEnvelope() {
  return JSON.stringify({ records: CCTV_RECORDS, fetchedAt: NOW.toISOString() });
}

// --- raw TDX records, shaped exactly like normalizeRoadEvent's real
// confirmed field mapping (see test/fixtures.js) -----------------------

function fixtureARaw() {
  return {
    EventID: 'A15040100H-01-20260820201348494100020',
    EventTitle: '國道一號北向93.5K車輛事故',
    EventType: '事故',
    EventSubType: '一般事故',
    Description: '北向93.5K處發生車輛事故，外側車道封閉，請小心慢行',
    EffectiveTime: '2026-08-20T20:13:00+08:00',
    LastUpdateTime: '2026-08-20T20:13:48+08:00',
    Location: {
      FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '93K+500', EndKM: '93K+000' },
    },
    Impact: { BlockedLanes: 1 },
    // V2.4.5 — service-area gate evidence; official-polygon-confirmed
    // inside 新竹市 (near 國道一號 93K).
    Positions: [{ PositionLon: 120.9686, PositionLat: 24.8066 }],
  };
}

function fixtureBRaw() {
  return {
    EventID: 'A15040100H-01-20260820200616953100035',
    EventTitle: '國道一號南向92.8K其他異常告警',
    EventType: '事故',
    EventSubType: '其他異常告警－行人誤闖',
    Description: '南向92.8K處行人誤闖路權，請小心慢行',
    EffectiveTime: '2026-08-20T20:06:00+08:00',
    LastUpdateTime: '2026-08-20T20:06:16+08:00',
    Location: {
      FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '92K+800', EndKM: '92K+800' },
    },
  };
}

async function makeFetch({ frameOk = true } = {}) {
  const pushCalls = [];
  const frameHits = { count: 0 };
  const frameBytes = await realJpegBytes();
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushCalls.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    if (href.includes('freeway.gov.tw')) {
      frameHits.count += 1;
      if (!frameOk) return new Response('nope', { status: 404 });
      return new Response(frameBytes, { status: 200 });
    }
    throw new Error(`unexpected fetch (broadcast path must never call TDX): ${href}`);
  };
  return { fetchFn, pushCalls, frameHits };
}

async function makeEnv() {
  const TRAFFIC_KV = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope() });
  await setUserEnabled(TRAFFIC_KV, 'U1', true, ENROLLED_AT);
  const bucket = r2Bucket();
  return { env: { LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV, CCTV_IMAGES: bucket }, kv: TRAFFIC_KV, bucket };
}

// --- Fixture A: genuine accident — the CCTV/Shared-Feed image-handoff regression ---

test('Fixture A: genuine 國1 北向 93K+500 accident — type/direction/KM preserved, KM resolver + map URL active, CCTV attached, and the Shared Feed carries the SAME imageUrl (never null when R2 publish succeeded)', async () => {
  const event = normalizeRoadEvent(fixtureARaw(), 'freeway');

  // --- classification / direction / KM fidelity, unchanged by the merge ---
  assert.equal(event.type, 'accident');
  assert.equal(event.direction, '北向');
  assert.equal(event.startKM, '93K+500');
  assert.equal(event.rawId, 'A15040100H-01-20260820201348494100020');

  const { env, kv: store, bucket } = await makeEnv();
  const { fetchFn, pushCalls, frameHits } = await makeFetch();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  let result;
  try {
    result = await runLineBroadcast(env, {
      allEvents: [event],
      dedupeAvailable: true,
      newUpdatedKeys: new Set([`${event.source}:${event.rawId}`]),
      now: NOW,
      cctvCodecOverride: TEST_CODEC,
    });
  } finally {
    globalThis.fetch = priorFetch;
  }

  const product = result.completedProducts.find((p) => p.event.rawId === event.rawId);
  assert.ok(product, 'the event must produce a completed product');

  // --- KM Location Resolver + short Google Maps URL genuinely wired into
  // the V57.2 broadcaster path (messageFormat.js, unchanged by V57.2, is
  // what actually builds `text` inside runLineBroadcast) ---
  assert.match(product.text, /📍 地圖 https:\/\/maps\.google\.com\/\?q=-?\d+\.\d{5},-?\d+\.\d{5}/, 'a resolved coordinate must produce a short map URL line');
  assert.doesNotMatch(product.text, /新竹／科學園區/, 'must not fall back to the stale curated anchor label when the official resolver succeeds');

  // --- CCTV: eligible, attached, and reaches the real LINE push ---
  assert.equal(result.cctvEligibleAccidentCount, 1);
  assert.equal(result.cctvImagesAttachedCount, 1);
  assert.equal(bucket.putCalls, 1, 'exactly one R2 publish');
  assert.equal(frameHits.count, 4, 'four quadrant frames fetched once');
  assert.equal(pushCalls.length, 1, 'a genuinely new accident with an enrolled subscriber must push');
  assert.equal(pushCalls[0].messages.length, 2, 'text + image in ONE LINE request');

  // --- the actual regression: completedProduct carries the image ---
  assert.match(product.imageUrl, /^https:\/\/.+\/cctv\/image\/[0-9a-f]+$/);
  assert.ok(product.imageExpiresAt);

  // --- and, critically, the PERSISTED Shared Feed carries the SAME URL/expiry ---
  const persisted = await runSharedFeedPersist(env, { completedProducts: result.completedProducts, now: NOW });
  assert.equal(persisted.committed, true);
  assert.equal(persisted.withImageCount, 1, 'the Shared Feed must NOT show withImage:0 when R2 publish actually succeeded');
  const feed = JSON.parse(store.store.get('traffic:shared-feed'));
  const feedEntry = feed.events.find((e) => e.eventId === `freeway:${event.rawId}`);
  assert.ok(feedEntry, 'the event must be present in the Shared Feed');
  assert.equal(feedEntry.imageUrl, product.imageUrl, 'Shared Feed imageUrl must be the SAME URL the LINE push carried');
  assert.equal(feedEntry.imageExpiresAt, product.imageExpiresAt);
  assert.notEqual(feedEntry.imageUrl, null);

  // The R2 object's own customMetadata.expiresAt is the source of truth —
  // never a recomputed approximation on either side.
  const stored = [...bucket.store.values()][0];
  assert.equal(feedEntry.imageExpiresAt, stored.customMetadata.expiresAt);

  // --- V1.8.6.4 provenance: written, and carries the KM resolution + image facts ---
  const provenanceKeys = [...store.store.keys()].filter((k) => k.startsWith('debug:broadcast-provenance:v1:'));
  assert.equal(provenanceKeys.length, 1, 'exactly one provenance record for the one successful push');
  const record = JSON.parse(store.store.get(provenanceKeys[0]));
  assert.equal(record.rawId, event.rawId);
  assert.equal(record.type, 'accident');
  assert.equal(record.direction, '北向');
  assert.equal(record.imageAttached, true);
  assert.equal(record.imageUrlPresent, true);
  assert.ok(record.imageExpiresAt);
  assert.equal(record.kmLocationResolution.resolved, true);
  assert.ok(record.kmLocationResolution.locationLabel);
  // Sanitized evidence view only — never the raw coordinate/URL in the debug log.
  assert.equal('coordinate' in record.kmLocationResolution, false);
  assert.equal('mapUrl' in record.kmLocationResolution, false);
});

// --- Fixture B: pedestrian anomaly — must classify as other, not accident ---

test('Fixture B: 國1 南向 92K+800 "其他異常告警－行人誤闖" — classified as other (not accident), direction preserved, KM resolver active, CCTV ineligible, image absence never alters text', async () => {
  const event = normalizeRoadEvent(fixtureBRaw(), 'freeway');

  // --- the actual V1.8.6.6 regression: must NOT be misclassified as accident ---
  assert.equal(event.type, 'other');
  assert.equal(event.direction, '南向');
  assert.equal(event.startKM, '92K+800');
  assert.equal(event.rawId, 'A15040100H-01-20260820200616953100035');
  assert.equal(event.nonCollisionAnomalyDetail && event.nonCollisionAnomalyDetail.label, '行人闖入');

  const { env, kv: store } = await makeEnv();
  const { fetchFn, pushCalls, frameHits } = await makeFetch();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  let result;
  try {
    result = await runLineBroadcast(env, {
      allEvents: [event],
      dedupeAvailable: true,
      newUpdatedKeys: new Set([`${event.source}:${event.rawId}`]),
      now: NOW,
      cctvCodecOverride: TEST_CODEC,
    });
  } finally {
    globalThis.fetch = priorFetch;
  }

  const product = result.completedProducts.find((p) => p.event.rawId === event.rawId);
  assert.ok(product);

  assert.doesNotMatch(product.text, /交通事故/);
  assert.doesNotMatch(product.text, /事故影響通行/);
  assert.match(product.text, /🚶 行人闖入/, 'the specific pedestrian-intrusion label, not the generic 路況異常');

  // --- KM resolver still active for a non-accident type ---
  assert.match(product.text, /📍 地圖 https:\/\/maps\.google\.com\/\?q=-?\d+\.\d{5},-?\d+\.\d{5}/);

  // --- CCTV must never be attempted for a non-accident event ---
  assert.equal(result.cctvEligibleAccidentCount, 0);
  assert.equal(frameHits.count, 0, '0 CCTV frame fetches for a reclassified anomaly');
  assert.equal(product.imageUrl, null);
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].messages.length, 1, 'text-only — image absence must never block or alter the text broadcast');

  // --- Shared Feed: present, text-only, never null-image-shaped confusion ---
  const persisted = await runSharedFeedPersist(env, { completedProducts: result.completedProducts, now: NOW });
  assert.equal(persisted.committed, true);
  const feed = JSON.parse(store.store.get('traffic:shared-feed'));
  const feedEntry = feed.events.find((e) => e.eventId === `freeway:${event.rawId}`);
  assert.ok(feedEntry);
  assert.equal(feedEntry.type, 'other');
  assert.equal(feedEntry.direction, '南向');
  assert.equal(feedEntry.imageUrl, null);

  // --- provenance: classificationEvidence must show the override, not a genuine collision ---
  const provenanceKeys = [...store.store.keys()].filter((k) => k.startsWith('debug:broadcast-provenance:v1:'));
  assert.equal(provenanceKeys.length, 1);
  const record = JSON.parse(store.store.get(provenanceKeys[0]));
  assert.equal(record.type, 'other');
  assert.equal(record.imageAttached, false);
  assert.equal(record.imageUrlPresent, false);
  assert.equal(record.imageExpiresAt, null);
  assert.equal(record.kmLocationResolution.resolved, true);
});
