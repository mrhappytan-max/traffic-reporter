// V1.8.7.1 — Multi-event Single CCTV Budget / Fairness Fix.
//
// Root cause (Production Pipeline Trace evidence, ~14:00 Asia/Taipei, 3
// dynamic-shoulder events same Cron tick): a single, shared, absolute
// `cctvRunDeadlineAt` governed BOTH quad (accident) and single (dynamic-
// shoulder) CCTV attempts — whichever event reached the CCTV block FIRST
// consumed as much of that one shared ~4s clock as its own real
// processing took, leaving arbitrarily little (often 0) for every LATER
// event, regardless of how cheap a single-frame fetch actually is. Not a
// TDX/PBS/classification/KM-resolver/LINE/Shared-Feed problem — see
// dynamicShoulder.test.js for that layer's own (unaffected) coverage.
//
// Fix: single-strategy events now get their OWN independent per-event
// budget (SINGLE_CCTV_PER_EVENT_BUDGET_MS) plus a per-run cap
// (MAX_SINGLE_CCTV_EVENTS_PER_RUN) — see cctv/dynamicCollage.js's
// prepareSingleCctvImageForEvent. Quad's own shared deadline is
// unchanged in every respect except being lazily anchored to the first
// accident this run actually reaches, so preceding single-event
// processing can never erode it either.
//
// No real TDX/PBS/CCTV/LINE call anywhere in this file — every fetch is
// mocked, KV/R2 are in-memory mocks.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resolveCctvEligibility, SINGLE_CCTV_PER_EVENT_BUDGET_MS, MAX_SINGLE_CCTV_EVENTS_PER_RUN } from '../src/cctv/dynamicCollage.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { computeFingerprint } from '../src/traffic/dedupe.js';
import { computeNotificationFingerprint } from '../src/traffic/notified.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { crossSourceDedup } from '../src/pbs/crossSourceDedup.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

// --- fixtures --------------------------------------------------------

// The real Production regression fixture (section 十一): 3 dynamic-
// shoulder OPEN events, same tick, all 國道一號 南向.
// V2.4.5 — carries a real coordinate, confirmed this round inside 新竹市
// by the official NLSC polygon (tdx/hsinchuGeoResolver.js), so these
// fixtures still represent what they always meant to (a real Hsinchu
// event) under the new coordinate-backed service-area gate.
function shoulderEventAt(rawId, startKM, endKM, overrides = {}) {
  return {
    source: 'freeway',
    rawId,
    type: 'control',
    road: '國道一號',
    direction: '南向',
    startKM,
    endKM,
    description: `國道一號 南向 ${startKM} 特殊管制事件-機動開放路肩事件`,
    startTime: '2026-08-21T13:55:00+08:00',
    endTime: null,
    updatedAt: '2026-08-21T13:55:00+08:00',
    dynamicShoulder: { state: 'OPEN', evidence: { field: 'Description', value: 'x' } },
    longitude: 120.9686,
    latitude: 24.8066,
    ...overrides,
  };
}

const EVENT_A = shoulderEventAt('SHOULDER-A', '84K+500', '86K+200');
const EVENT_B = shoulderEventAt('SHOULDER-B', '87K+290', '90K+900');
const EVENT_C = shoulderEventAt('SHOULDER-C', '91K+590', '93K+320');

// V2.4.5 — same coordinate-preservation note as shoulderEventAt() above.
function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-ACC-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '82K+000',
    endKM: '82K+200',
    description: '事故',
    startTime: '2026-08-21T13:55:00+08:00',
    endTime: null,
    updatedAt: '2026-08-21T13:55:00+08:00',
    longitude: 120.9686,
    latitude: 24.8066,
    ...overrides,
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
const IN_HOURS_NOW = new Date('2026-08-21T14:00:00+08:00'); // matches Production's own ~14:00 evidence

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// Fails R2 `put` on specific 0-based call indices only ("A's R2 publish
// fails, B/C succeed") — every other call behaves normally.
function r2Bucket({ failOnPutIndices = new Set() } = {}) {
  const store = new Map();
  let putCallIndex = 0;
  return {
    store,
    async put(key, value, options = {}) {
      const idx = putCallIndex;
      putCallIndex += 1;
      if (failOnPutIndices.has(idx)) throw new Error('R2 write outage (selective, test-only)');
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

function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'S',
    LocationMile: '92K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}

// Cameras placed INSIDE each real event's own KM range, so the real
// selectSingleShoulderCandidate priority (in-range, closest to midpoint)
// picks each deterministically.
const RECORDS_ABC = [
  cctvRecord({ CCTVID: 'CCTV-A', LocationMile: '85K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/a.jpg' }), // inside 84.5-86.2
  cctvRecord({ CCTVID: 'CCTV-B', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/b.jpg' }), // inside 87.29-90.9
  cctvRecord({ CCTVID: 'CCTV-C', LocationMile: '92K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/c.jpg' }), // inside 91.59-93.32
];

const RECORDS_QUAD_82 = [
  cctvRecord({ CCTVID: 'CCTV-82-S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-s-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-S-AFTER', RoadDirection: 'S', LocationMile: '82K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-s-after.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-N-BEFORE', RoadDirection: 'N', LocationMile: '81K+950', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-n-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-N-AFTER', RoadDirection: 'N', LocationMile: '82K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-n-after.jpg' }),
];

async function seedMetadataCache(kv, records) {
  await kv.put('cctv:freeway-metadata:v1', JSON.stringify({ records, fetchedAt: new Date().toISOString() }));
}

async function makeSolidJpeg(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return new Uint8Array(await encodeJpeg({ data, width, height }, { quality: 80 }));
}

/**
 * A single configurable fetch mock covering CCTV frames (per-URL-
 * substring behavior: bytes / delayMs / fail) AND LINE pushes (per-
 * message-text substring failure) — anything else throws loudly, proving
 * 0 extra TDX/PBS/Google calls.
 *
 * @param {object} frameSpecs - { [urlSubstring]: {bytes, delayMs?, fail?} }
 * @param {string[]} [lineFailTextSubstrings] - a LINE push whose message
 *   text contains any of these strings fails with a 500.
 */
function makeConfigurableFetch(frameSpecs, lineFailTextSubstrings = []) {
  const hits = { frame: 0, line: 0, other: 0 };
  const pushCalls = [];
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      const entry = Object.entries(frameSpecs).find(([key]) => href.includes(key));
      if (!entry) return new Response('not found', { status: 404 });
      const [, spec] = entry;
      if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
      if (spec.fail) return new Response('server error', { status: 500 });
      return new Response(spec.bytes, { status: 200 });
    }
    if (href.includes('api.line.me')) {
      hits.line += 1;
      const body = JSON.parse(init.body);
      pushCalls.push({ url: href, body });
      const text = (body.messages && body.messages[0] && body.messages[0].text) || '';
      if (lineFailTextSubstrings.some((s) => text.includes(s))) {
        return new Response('line outage (test-only)', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }
    hits.other += 1;
    throw new Error(`unexpected fetch in test (0 extra TDX/PBS/Google calls expected): ${href}`);
  };
  return { fetchFn, hits, pushCalls };
}

let originalFetch;
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  resetTdxTokenCache();
});

async function enrollUser(kv, id = 'U1') {
  await setUserEnabled(kv, id, true, ENROLLED_AT);
}

// =======================================================================
// 1-3: single / 3-singles Production fixture / 5-singles bounded
// =======================================================================

test('1. a single dynamic-shoulder event gets imagePrepared=true', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-A', LocationMile: '85K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/a.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ 'a.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [EVENT_A], dedupeAvailable: true, now: IN_HOURS_NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.imagePrepared, true);
  assert.equal(trace.enrichment.imageStrategy, 'single');
});

test('2. Production regression fixture — same tick, 3 dynamic-shoulder OPEN events at their real KM ranges — ALL THREE get imagePrepared=true, LINE text, and their own Shared Feed imageUrl/imageExpiresAt', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  const frameA = await makeSolidJpeg(4, 4, [10, 0, 0]);
  const frameB = await makeSolidJpeg(4, 4, [0, 10, 0]);
  const frameC = await makeSolidJpeg(4, 4, [0, 0, 10]);
  const { fetchFn, pushCalls, hits } = makeConfigurableFetch({
    'a.jpg': { bytes: frameA },
    'b.jpg': { bytes: frameB },
    'c.jpg': { bytes: frameC },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  // All 3 LINE texts pushed.
  assert.equal(result.pushSucceeded, 3);
  assert.equal(pushCalls.length, 3);

  // All 3 got imagePrepared=true — the exact real-world regression.
  assert.equal(result.pipelineTraceEntries.length, 3);
  for (const trace of result.pipelineTraceEntries) {
    assert.equal(trace.enrichment.imagePrepared, true, `expected imagePrepared=true for ${trace.identity.rawId}`);
    assert.equal(trace.enrichment.imageUrlPresent, true);
    assert.equal(trace.enrichment.cctvSkippedByReason, null);
  }

  // Exactly 1 frame fetch per event — never 4 (quad), never re-fetched.
  assert.equal(hits.frame, 3);

  // Shared Feed: 3 DISTINCT imageUrls, each with its own imageExpiresAt —
  // the first event's image must never be reused/misattributed to another.
  assert.equal(result.completedProducts.length, 3);
  const urls = result.completedProducts.map((p) => p.imageUrl);
  assert.equal(new Set(urls).size, 3);
  for (const p of result.completedProducts) {
    assert.ok(p.imageUrl);
    assert.ok(p.imageExpiresAt);
  }
});

test('3. 5 singles same tick, within the cap — all 5 get a genuine attempt and (with working frames) succeed', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  const events = [];
  const records = [];
  const frameSpecs = {};
  const frameBytesByIndex = [];
  for (let i = 0; i < 5; i += 1) {
    const startKm = 84.5 + i * 2;
    const km = `${Math.floor(startKm)}K+${String(Math.round((startKm - Math.floor(startKm)) * 1000)).padStart(3, '0')}`;
    events.push(shoulderEventAt(`SHOULDER-${i}`, km, km));
    const urlKey = `cam${i}.jpg`;
    records.push(cctvRecord({ CCTVID: `CCTV-${i}`, LocationMile: km, VideoStreamURL: `https://cctv1.freeway.gov.tw/${urlKey}` }));
    // eslint-disable-next-line no-await-in-loop
    const bytes = await makeSolidJpeg(4, 4, [i, i, i]);
    frameBytesByIndex.push(bytes);
    frameSpecs[urlKey] = { bytes };
  }
  await seedMetadataCache(kv, records);
  const { fetchFn, hits } = makeConfigurableFetch(frameSpecs);
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: events, dedupeAvailable: true, now: IN_HOURS_NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 5);
  assert.equal(hits.frame, 5); // every one of the 5 got a real attempt, 1 fetch each
  const preparedCount = result.pipelineTraceEntries.filter((t) => t.enrichment.imagePrepared).length;
  assert.equal(preparedCount, 5);
  // Every one attempted within the cap, no cap-reached skip anywhere.
  for (const t of result.pipelineTraceEntries) {
    assert.notEqual(t.enrichment.cctvSkippedByReason, 'single-event-cap-reached');
  }
});

// =======================================================================
// 4-6: slow / failed frame / failed R2 — per-event isolation
// =======================================================================

test('4. first event slow (exceeds its OWN small budget) -> times out on its own, but B and C still get their FULL fresh budget and succeed', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  const frameB = await makeSolidJpeg(4, 4, [0, 10, 0]);
  const frameC = await makeSolidJpeg(4, 4, [0, 0, 10]);
  const { fetchFn } = makeConfigurableFetch({
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]), delayMs: 300 }, // exceeds the 50ms test budget
    'b.jpg': { bytes: frameB },
    'c.jpg': { bytes: frameC },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
    singleCctvBudgetOverrides: { budgetMs: 50 }, // small, deterministic — A's 300ms frame cannot possibly finish in time
  });

  assert.equal(result.pushSucceeded, 3); // text still goes out for all 3 regardless of image outcome
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['SHOULDER-A'].enrichment.imagePrepared, false);
  assert.equal(byRawId['SHOULDER-A'].enrichment.cctvSkippedByReason, 'prepare-timeout');
  // B and C each got their OWN fresh 50ms budget, unaffected by A's slowness.
  assert.equal(byRawId['SHOULDER-B'].enrichment.imagePrepared, true);
  assert.equal(byRawId['SHOULDER-C'].enrichment.imagePrepared, true);
});

test('5. first event frame fetch fails (404) -> that event stays text-only, B and C are NOT aborted and continue normally', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  const { fetchFn } = makeConfigurableFetch({
    'a.jpg': { fail: true },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 3);
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['SHOULDER-A'].enrichment.imagePrepared, false);
  assert.equal(byRawId['SHOULDER-A'].enrichment.cctvSkippedByReason, 'no-frames');
  assert.equal(byRawId['SHOULDER-B'].enrichment.imagePrepared, true);
  assert.equal(byRawId['SHOULDER-C'].enrichment.imagePrepared, true);
});

test('6. first event R2 publish fails -> A stays text-only, B and C still publish successfully; run never aborts', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  const { fetchFn } = makeConfigurableFetch({
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket({ failOnPutIndices: new Set([0]) }) }; // A is the first R2 put this run
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 3);
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['SHOULDER-A'].enrichment.imagePrepared, false);
  assert.equal(byRawId['SHOULDER-A'].enrichment.cctvSkippedByReason, 'r2-publish-failed');
  assert.equal(byRawId['SHOULDER-B'].enrichment.imagePrepared, true);
  assert.equal(byRawId['SHOULDER-C'].enrichment.imagePrepared, true);
});

// =======================================================================
// 7-9: no camera / global cap
// =======================================================================

test('7. no matching camera for one event -> its own text still pushes; siblings unaffected', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [
    // B's camera placed near the FAR end of its own range (still inside
    // 87.29-90.9) so it's also >4km (this module's own WIDE_RADIUS_KM)
    // from A's midpoint (85.35) — otherwise the existing nearest-camera
    // fallback would legitimately find it for A too, which is correct
    // behavior but not what THIS test is isolating.
    cctvRecord({ CCTVID: 'CCTV-B', LocationMile: '89K+700', VideoStreamURL: 'https://cctv1.freeway.gov.tw/b.jpg' }),
    cctvRecord({ CCTVID: 'CCTV-C', LocationMile: '92K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/c.jpg' }),
    // no camera anywhere near EVENT_A's own range at all
  ]);
  const { fetchFn } = makeConfigurableFetch({
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 3);
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['SHOULDER-A'].enrichment.cctvSkippedByReason, 'no-camera');
  assert.equal(byRawId['SHOULDER-B'].enrichment.imagePrepared, true);
  assert.equal(byRawId['SHOULDER-C'].enrichment.imagePrepared, true);
});

test('8-9. global cap genuinely exhausted, distinct from a real per-event timeout in the SAME run', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  const events = [];
  const records = [];
  const frameSpecs = {};
  for (let i = 0; i < 4; i += 1) {
    const km = `${84 + i}K+000`;
    events.push(shoulderEventAt(`SHOULDER-${i}`, km, km));
    const urlKey = `cam${i}.jpg`;
    records.push(cctvRecord({ CCTVID: `CCTV-${i}`, LocationMile: km, VideoStreamURL: `https://cctv1.freeway.gov.tw/${urlKey}` }));
    if (i === 0) {
      frameSpecs[urlKey] = { bytes: await makeSolidJpeg(4, 4, [1, 1, 1]), delayMs: 300 }; // slot 1: genuinely too slow for its own tiny budget
    } else {
      frameSpecs[urlKey] = { bytes: await makeSolidJpeg(4, 4, [i, i, i]) }; // fast
    }
  }
  await seedMetadataCache(kv, records);
  const { fetchFn } = makeConfigurableFetch(frameSpecs);
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: events,
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
    singleCctvBudgetOverrides: { budgetMs: 50, cap: 2 }, // slot 1 times out, slot 2 succeeds, slots 3-4 are beyond the cap
  });

  assert.equal(result.pushSucceeded, 4); // text always goes out regardless of image outcome
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));

  // 8. genuinely exhausted (slot 1, within the cap, but its own budget ran out).
  assert.equal(byRawId['SHOULDER-0'].enrichment.cctvSkippedByReason, 'prepare-timeout');
  // slot 2, within the cap, fast enough -> succeeds.
  assert.equal(byRawId['SHOULDER-1'].enrichment.imagePrepared, true);
  // 9. slots 3-4 are beyond the cap -> a DIFFERENT, distinguishable reason,
  // never confused with a real per-event timeout.
  assert.equal(byRawId['SHOULDER-2'].enrichment.cctvSkippedByReason, 'single-event-cap-reached');
  assert.equal(byRawId['SHOULDER-3'].enrichment.cctvSkippedByReason, 'single-event-cap-reached');
  assert.notEqual(byRawId['SHOULDER-2'].enrichment.cctvSkippedByReason, byRawId['SHOULDER-0'].enrichment.cctvSkippedByReason);
});

// =======================================================================
// 10-11: strategy / frame-count invariants
// =======================================================================

test('10-11. imageStrategy remains "single" for every dynamic-shoulder event, and each ever fetches exactly ONE frame', async () => {
  for (const event of [EVENT_A, EVENT_B, EVENT_C]) {
    const elig = resolveCctvEligibility(event);
    assert.equal(elig.eligible, true);
    assert.equal(elig.imageStrategy, 'single');
  }
  assert.equal(SINGLE_CCTV_PER_EVENT_BUDGET_MS > 0, true);
  assert.equal(MAX_SINGLE_CCTV_EVENTS_PER_RUN >= 3, true); // must comfortably cover the real 3-event Production evidence
});

// =======================================================================
// 12-14: accident quad regression + mixed events
// =======================================================================

test('12-13. accident regression — resolveCctvEligibility still "quad", and a real accident still produces a genuine 4-frame collage', async () => {
  const elig = resolveCctvEligibility(accidentEvent());
  assert.equal(elig.imageStrategy, 'quad');

  const kv = createMockKV();
  await seedMetadataCache(kv, RECORDS_QUAD_82);
  const frameBytes = await makeSolidJpeg(320, 240, [80, 90, 100]);
  const { fetchFn, hits } = makeConfigurableFetch({
    '82-s-before.jpg': { bytes: frameBytes },
    '82-s-after.jpg': { bytes: frameBytes },
    '82-n-before.jpg': { bytes: frameBytes },
    '82-n-after.jpg': { bytes: frameBytes },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const { prepareCctvImageForEvent } = await import('../src/cctv/dynamicCollage.js');
  const bucket = r2Bucket();
  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: bucket };
  const cctv = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC, 4000);
  assert.equal(cctv.ok, true);
  assert.equal(hits.frame, 4); // still 4 — never fell through to the single-frame path
  const stored = [...bucket.store.values()][0];
  assert.ok(stored.value.length > frameBytes.length * 1.5, 'expected a real composed collage, not a single passthrough frame');
});

test('14. mixed round — 1 accident (quad) + 3 dynamic-shoulder (single) same tick — accident still gets its own full quad image, all 3 shoulders still get images too', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [...RECORDS_QUAD_82, ...RECORDS_ABC]);
  const quadFrame = await makeSolidJpeg(320, 240, [50, 50, 50]);
  const { fetchFn, hits } = makeConfigurableFetch({
    '82-s-before.jpg': { bytes: quadFrame },
    '82-s-after.jpg': { bytes: quadFrame },
    '82-n-before.jpg': { bytes: quadFrame },
    '82-n-after.jpg': { bytes: quadFrame },
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent(), EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 4);
  assert.equal(hits.frame, 4 + 3); // quad's own 4 + one per shoulder
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['FRW-ACC-1'].enrichment.imagePrepared, true);
  assert.equal(byRawId['FRW-ACC-1'].enrichment.imageStrategy, 'quad');
  assert.equal(byRawId['FRW-ACC-1'].enrichment.cctvBudgetClass, 'quad-shared');
  for (const rawId of ['SHOULDER-A', 'SHOULDER-B', 'SHOULDER-C']) {
    assert.equal(byRawId[rawId].enrichment.imagePrepared, true, `expected ${rawId} to have an image too`);
    assert.equal(byRawId[rawId].enrichment.cctvBudgetClass, 'single-per-event');
  }
});

// =======================================================================
// 15-17: LINE isolation, Shared Feed separate URLs, imageExpiresAt
// =======================================================================

test('15. one event\'s LINE push failing does not block the others in the same run', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  // Fail only event A's own push — keyed off A's own KM line (the one
  // part of the message text that's unique per event; all 3 events share
  // the same headline).
  const { fetchFn, pushCalls } = makeConfigurableFetch(
    {
      'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
      'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
      'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
    },
    ['84K+500']
  );
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 2); // B and C succeed, A fails
  assert.equal(pushCalls.length, 3); // all 3 were attempted
  assert.match(result.lineErrors.join(' '), /push failed/);
  // A's own CCTV outcome and B/C's are still independently correct —
  // a LINE failure never retroactively undoes a completed CCTV attempt.
  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['SHOULDER-B'].enrichment.imagePrepared, true);
  assert.equal(byRawId['SHOULDER-C'].enrichment.imagePrepared, true);
});

test('16-17. Shared Feed carries each event\'s OWN separate imageUrl/imageExpiresAt — never the first event\'s image reused for another', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  const { fetchFn } = makeConfigurableFetch({
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  const byRawId = Object.fromEntries(result.completedProducts.map((p) => [p.event.rawId, p]));
  assert.equal(new Set([byRawId['SHOULDER-A'].imageUrl, byRawId['SHOULDER-B'].imageUrl, byRawId['SHOULDER-C'].imageUrl]).size, 3);
  for (const p of Object.values(byRawId)) {
    assert.ok(p.imageUrl);
    assert.ok(p.imageExpiresAt);
    assert.ok(Number.isFinite(new Date(p.imageExpiresAt).getTime()));
  }
});

// =======================================================================
// 18: Pipeline Trace budget evidence
// =======================================================================

test('18. Pipeline Trace records cctvBudgetClass/singleSlotIndex/singleSlotLimit/processingDurationMs for single events', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, RECORDS_ABC);
  const { fetchFn } = makeConfigurableFetch({
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  const byRawId = Object.fromEntries(result.pipelineTraceEntries.map((t) => [t.identity.rawId, t]));
  assert.equal(byRawId['SHOULDER-A'].enrichment.singleSlotIndex, 1);
  assert.equal(byRawId['SHOULDER-B'].enrichment.singleSlotIndex, 2);
  assert.equal(byRawId['SHOULDER-C'].enrichment.singleSlotIndex, 3);
  for (const rawId of ['SHOULDER-A', 'SHOULDER-B', 'SHOULDER-C']) {
    const e = byRawId[rawId].enrichment;
    assert.equal(e.singleSlotLimit, MAX_SINGLE_CCTV_EVENTS_PER_RUN);
    assert.equal(e.cctvBudgetClass, 'single-per-event');
    assert.equal(typeof e.processingDurationMs, 'number');
    assert.ok(e.processingDurationMs >= 0);
  }
});

// =======================================================================
// 19: CCTV top-up regression (fairness applies there too)
// =======================================================================

test('19. Shared-Feed-only top-up (pendingTargets=0 duplicates) still applies the same single-event fairness — multiple already-notified shoulder duplicates each still get their own image', async () => {
  const kv = createMockKV();
  // No enrolled user at all -> pendingTargets is always 0 for every
  // event -> every single-strategy event goes through
  // topUpSharedFeedCctvImages, never the main push loop's own CCTV block.
  await seedMetadataCache(kv, RECORDS_ABC);
  const { fetchFn, hits } = makeConfigurableFetch({
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 0); // 0 subscribers -> 0 real LINE pushes
  assert.equal(result.cctvFeedOnlyAttemptedCount, 3);
  assert.equal(result.cctvFeedOnlyAttachedCount, 3);
  assert.equal(hits.frame, 3); // still exactly 1 frame per event, even via the top-up path
  const byRawId = Object.fromEntries(result.completedProducts.map((p) => [p.event.rawId, p]));
  assert.ok(byRawId['SHOULDER-A'].imageUrl);
  assert.ok(byRawId['SHOULDER-B'].imageUrl);
  assert.ok(byRawId['SHOULDER-C'].imageUrl);
  assert.equal(new Set([byRawId['SHOULDER-A'].imageUrl, byRawId['SHOULDER-B'].imageUrl, byRawId['SHOULDER-C'].imageUrl]).size, 3);
});

// =======================================================================
// 20-23: unaffected-layer regression smoke tests
// =======================================================================

test('20. V57.2 gating regression — crossSourceDedup untouched by this round', () => {
  const pbsEvent = { source: 'pbs', rawId: 'PBS-1', road: '國道一號', direction: '南向', type: 'accident', description: 'x' };
  const result = crossSourceDedup([pbsEvent], []);
  assert.equal(result.filteredFreewayEvents.length, 1);
});

test('21. dynamic-shoulder classification regression — real fixture still classifies OPEN correctly', () => {
  const raw = {
    EventID: 'A15040100H-01-20260821094306288100033',
    EventType: 4,
    EventSubType: 498,
    Description: '國道一號 南向 91K+590 特殊管制事件-機動開放路肩事件',
    EffectiveTime: '2026-08-21T09:43:06+08:00',
    LastUpdateTime: '2026-08-21T09:43:06+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '91K+590', EndKM: '93K+320' } },
  };
  const event = normalizeRoadEvent(raw, 'freeway');
  assert.equal(event.dynamicShoulder.state, 'OPEN');
  assert.equal(event.type, 'control');
});

test('22. OPEN/STOPPED fingerprint regression — still change on state transition, stay identical for same state', () => {
  const open1 = shoulderEventAt('X', '91K+590', '93K+320', { dynamicShoulder: { state: 'OPEN', evidence: {} } });
  const open2 = shoulderEventAt('X', '91K+590', '93K+320', { dynamicShoulder: { state: 'OPEN', evidence: {} } });
  const stopped = shoulderEventAt('X', '91K+590', '93K+320', { dynamicShoulder: { state: 'STOPPED', evidence: {} } });
  assert.equal(computeFingerprint(open1), computeFingerprint(open2));
  assert.notEqual(computeFingerprint(open1), computeFingerprint(stopped));
  assert.equal(computeNotificationFingerprint(open1), computeNotificationFingerprint(open2));
  assert.notEqual(computeNotificationFingerprint(open1), computeNotificationFingerprint(stopped));
});

test('23. normal accident regression — eligibility and wording completely unaffected', () => {
  const event = accidentEvent();
  assert.equal(getBroadcastEligibility(event).eligible, true);
  assert.equal(getBroadcastEligibility(event).reason, 'eligible-type');
  const text = formatEventMessage(event);
  assert.match(text, /🚨 交通事故/);
});

// =======================================================================
// 24: 0 extra upstream calls, across a full mixed-event run
// =======================================================================

test('24. a full mixed accident+3-shoulder run makes 0 TDX calls, 0 Google Maps calls, 0 extra metadata reads — only freeway.gov.tw frames and the mocked LINE endpoint', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [...RECORDS_QUAD_82, ...RECORDS_ABC]);
  const quadFrame = await makeSolidJpeg(320, 240, [50, 50, 50]);
  const { fetchFn, hits } = makeConfigurableFetch({
    '82-s-before.jpg': { bytes: quadFrame },
    '82-s-after.jpg': { bytes: quadFrame },
    '82-n-before.jpg': { bytes: quadFrame },
    '82-n-after.jpg': { bytes: quadFrame },
    'a.jpg': { bytes: await makeSolidJpeg(4, 4, [10, 0, 0]) },
    'b.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 10, 0]) },
    'c.jpg': { bytes: await makeSolidJpeg(4, 4, [0, 0, 10]) },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent(), EVENT_A, EVENT_B, EVENT_C],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 4);
  assert.equal(hits.other, 0); // 0 non-freeway.gov.tw/non-LINE fetches of any kind
  assert.equal(hits.frame, 7); // 4 (quad) + 3 (one per shoulder) — metadata read once, cached, never re-fetched
});
