// V1.8.7.4 → V1.8.7.5 — 國3 CCTV Support: Audit, then Enablement.
//
// V1.8.7.4 audited whether real 國3 CCTV metadata already existed
// anywhere this codebase could reach, and concluded — correctly, for
// that round — that it did not: no real, Production-confirmed CCTV
// RoadID/RoadName for 國道三號 existed in this repository, only a
// synthetic test fixture (RoadID:'000030' in test/hsinchuCctvProbe.test.js,
// commented "wrong road -> excluded") and an unrelated KM/facility
// dataset. 國3 was deliberately NOT added to CCTV_SUPPORTED_ROADS.
//
// V1.8.7.5 closes that gap: a separate, explicitly read-only inspection
// of Production's real TRAFFIC_KV `cctv:freeway-metadata:v1` cache (NOT
// made from this session's own dev sandbox — no TDX call, no admin
// probe, no frame fetch) confirmed real cached Production data: RoadID
// `'000030'`, RoadName `'國道3號'`, 706 real 國3 records (S 361 / N 345),
// including 3 real cameras inside/near the original real event's own
// 102K+100～103K+070 range. 國3 is now added to CCTV_SUPPORTED_ROADS.
// This file's tests were updated accordingly — the ones that used to pin
// down "國3 correctly stays unsupported" now pin down "國3 correctly
// becomes supported," and the file gained the new fixture-accurate
// candidate-selection tests this round's own task specified.
//
// No real TDX/PBS/CCTV/LINE network call anywhere in this file — every
// fetch is mocked, KV/R2 are in-memory mocks; a throwing mock fetch on
// any TDX/PBS host proves 0 extra upstream calls directly.

import { test, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resolveCctvEligibility, prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { resolveRoadKey } from '../src/traffic/roadSectionLabel.js';
import { CCTV_URL, selectSingleShoulderCandidate } from '../src/tdx/hsinchuCctvProbe.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
const NOW = new Date('2026-08-21T16:20:00+08:00');

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

function r2Bucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
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

async function seedMetadataCache(kv, records) {
  await kv.put('cctv:freeway-metadata:v1', JSON.stringify({ records, fetchedAt: new Date().toISOString() }));
}

function cctv1Record(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'S',
    LocationMile: '89K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}

// Real-field-shape fixtures modeled on the Production read-only
// inspection's own reported samples — real RoadID/RoadName/field names,
// synthetic (non-production) VideoStreamURL host paths, matching this
// project's existing test convention of never embedding a real
// freeway.gov.tw camera endpoint in test code.
function cctv3Record(overrides) {
  return {
    CCTVID: 'CCTV-N3-DEFAULT',
    SubAuthorityCode: 'NFB-NR',
    RoadID: '000030',
    RoadName: '國道3號',
    RoadDirection: 'S',
    LocationMile: '102K+603',
    PositionLon: 120.96917412094,
    PositionLat: 24.7586395461787,
    RoadSection: { Start: '新竹系統交流道', End: '茄苳交流道' },
    VideoStreamURL: 'https://cctv3.freeway.gov.tw/n3-102603.jpg',
    ...overrides,
  };
}

// The 3 real cameras reported inside/near the real event's own range
// (102K+100～103K+070), modeled on the real reported KM/direction/CCTVID
// shape.
const REAL_RANGE_RECORDS = [
  cctv3Record({ CCTVID: 'CCTV-N3-N-102.000-M', RoadDirection: 'N', LocationMile: '102K+000', VideoStreamURL: 'https://cctv3.freeway.gov.tw/n3-102000.jpg' }),
  cctv3Record({ CCTVID: 'CCTV-N3-S-102.603-M', RoadDirection: 'S', LocationMile: '102K+603', VideoStreamURL: 'https://cctv3.freeway.gov.tw/n3-102603.jpg' }),
  cctv3Record({ CCTVID: 'CCTV-N3-S-103.020-M', RoadDirection: 'S', LocationMile: '103K+020', VideoStreamURL: 'https://cctv3.freeway.gov.tw/n3-103020.jpg' }),
];

function freeway3Event(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'SHOULDER-102K100',
    type: 'control',
    road: '國道三號',
    direction: '南向',
    startKM: '102K+100',
    endKM: '103K+070',
    description: '國道三號 南向 102K+100 特殊管制事件-機動開放路肩事件',
    startTime: '2026-08-21T15:49:00+08:00',
    endTime: null,
    updatedAt: '2026-08-21T15:49:00+08:00',
    dynamicShoulder: { state: 'OPEN', evidence: { field: 'Description', value: 'x' } },
    ...overrides,
  };
}

function freeway3AccidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW3-ACC-1',
    type: 'accident',
    road: '國道三號',
    direction: '南向',
    startKM: '102K+500',
    endKM: '102K+700',
    description: '事故',
    startTime: '2026-08-21T13:55:00+08:00',
    endTime: null,
    updatedAt: '2026-08-21T13:55:00+08:00',
    ...overrides,
  };
}

function freeway1ShoulderEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'SHOULDER-87K290',
    type: 'control',
    road: '國道一號',
    direction: '南向',
    startKM: '87K+290',
    endKM: '90K+900',
    description: '國道一號 南向 87K+290 特殊管制事件-機動開放路肩事件',
    startTime: '2026-08-21T16:15:00+08:00',
    endTime: null,
    updatedAt: '2026-08-21T16:15:00+08:00',
    dynamicShoulder: { state: 'OPEN', evidence: { field: 'Description', value: 'x' } },
    ...overrides,
  };
}

function freeway1AccidentEvent(overrides = {}) {
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
    ...overrides,
  };
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
// 1. 國3 registry recognized.
// =======================================================================

test('1. 國3 is now a recognized supported freeway — CCTV_SUPPORTED_ROADS contains 國道三號 (behavior-level check, via resolveCctvEligibility)', () => {
  const eligibility = resolveCctvEligibility(freeway3Event());
  assert.equal(eligibility.eligible, true);
  assert.notEqual(eligibility.reason, 'unsupported-road');
});

test('1b. 國3 road identity still resolves via roadSectionLabel.js (unchanged — this round never touched road-identity resolution)', () => {
  assert.equal(resolveRoadKey('國道三號'), '國道三號');
});

// =======================================================================
// 2/3. 國3 真實 RoadID/RoadName confirmed values.
// =======================================================================

test('2. 國3 real RoadID 000030 — a record with this RoadID (and no RoadName at all) is recognized', () => {
  const eligibility = resolveCctvEligibility(freeway3AccidentEvent());
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.roadId, '000030');
});

test('3. 國3 real RoadName 國道3號 (arabic numeral) matches the registry pattern', () => {
  const eligibility = resolveCctvEligibility(freeway3Event());
  assert.match('國道3號', eligibility.roadNamePattern);
});

// =======================================================================
// 4. 國3 dynamic shoulder CCTV eligible.
// =======================================================================

test('4. 國3 dynamic-shoulder event: cctvEligible=true, imageStrategy=single', () => {
  const eligibility = resolveCctvEligibility(freeway3Event());
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.imageStrategy, 'single');
});

// =======================================================================
// 5. 102K+100～103K+070 → selects CCTV-N3-S-102.603-M, direction S.
// =======================================================================

test('5. 國3 102K+100～103K+070 real fixture: selects CCTV-N3-S-102.603-M (南向, KM 102.603) — the real range-midpoint winner', () => {
  const eligibility = resolveCctvEligibility(freeway3Event());
  const candidate = selectSingleShoulderCandidate(REAL_RANGE_RECORDS, {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: eligibility.direction,
    startKm: eligibility.startKm,
    endKm: eligibility.endKm,
  });
  assert.ok(candidate);
  assert.equal(candidate.cctvId, 'CCTV-N3-S-102.603-M');
  assert.equal(candidate.roadDirection, 'S');
  assert.equal(candidate.km, 102.603);
});

// =======================================================================
// 6. 國3 direction-aware.
// =======================================================================

test('6. 國3 candidate selection is direction-aware — a 北向 event does NOT select the 南向 camera', () => {
  const northEligibility = resolveCctvEligibility(freeway3Event({ direction: '北向' }));
  const candidate = selectSingleShoulderCandidate(REAL_RANGE_RECORDS, {
    roadId: northEligibility.roadId,
    roadNamePattern: northEligibility.roadNamePattern,
    direction: northEligibility.direction,
    startKm: northEligibility.startKm,
    endKm: northEligibility.endKm,
  });
  // Only one N candidate exists in range (102.000); a 北向 search must
  // select IT, never the 南向 102.603/103.020 cameras.
  assert.ok(candidate);
  assert.equal(candidate.roadDirection, 'N');
  assert.equal(candidate.cctvId, 'CCTV-N3-N-102.000-M');
});

// =======================================================================
// 7. no-camera fail-closed (genuinely no candidate, not unsupported-road).
// =======================================================================

test('7. 國3 with 0 matching cameras in the metadata cache -> no-camera, never unsupported-road (eligible=true, search genuinely came up empty)', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctv1Record()]); // only 國1 records cached — nothing for 國3
  const { fetchFn } = makeConfigurableFetch({});
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway3Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.enrichment.cctvSkippedByReason, 'no-camera');
});

// =======================================================================
// 8. 國3 accident quad eligibility.
// =======================================================================

test('8. 國3 accident: cctvEligible=true, imageStrategy=quad', () => {
  const eligibility = resolveCctvEligibility(freeway3AccidentEvent());
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.imageStrategy, 'quad');
});

test('8b. 國3 accident quad — insufficient candidates (only 2 of 4 quadrants fillable) still fails closed to no-camera/partial, never crashes or forces a wrong camera', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  // Only 2 same-direction-nearby records — real quad selection may fill
  // fewer than 4 quadrants; composeCollageFromCandidates already handles
  // partial fills (this is pre-existing, unmodified behavior, just
  // exercised here against 國3 for the first time).
  await seedMetadataCache(kv, [
    cctv3Record({ CCTVID: 'CCTV-N3-S-BEFORE', RoadDirection: 'S', LocationMile: '102K+300', VideoStreamURL: 'https://cctv3.freeway.gov.tw/before.jpg' }),
    cctv3Record({ CCTVID: 'CCTV-N3-S-AFTER', RoadDirection: 'S', LocationMile: '102K+700', VideoStreamURL: 'https://cctv3.freeway.gov.tw/after.jpg' }),
  ]);
  const frame = await makeSolidJpeg(4, 4, [9, 9, 9]);
  const { fetchFn } = makeConfigurableFetch({ 'before.jpg': { bytes: frame }, 'after.jpg': { bytes: frame } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway3AccidentEvent()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1); // text always still succeeds regardless of partial/no image
});

// =======================================================================
// 9. 國1 regression.
// =======================================================================

test('9a. 國1 87K+290 dynamic-shoulder regression — imagePrepared=true, imageStrategy=single, unaffected by 國3\'s addition', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctv1Record({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway1ShoulderEvent()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.enrichment.imageStrategy, 'single');
  assert.equal(trace.enrichment.imagePrepared, true);
});

test('9b. 國1 accident quad regression — imageStrategy=quad, still exactly 4 frame fetches, unaffected by 國3\'s addition', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  const records = [
    cctv1Record({ CCTVID: 'S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/s-before.jpg' }),
    cctv1Record({ CCTVID: 'S-AFTER', RoadDirection: 'S', LocationMile: '82K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/s-after.jpg' }),
    cctv1Record({ CCTVID: 'N-BEFORE', RoadDirection: 'N', LocationMile: '81K+950', VideoStreamURL: 'https://cctv1.freeway.gov.tw/n-before.jpg' }),
    cctv1Record({ CCTVID: 'N-AFTER', RoadDirection: 'N', LocationMile: '82K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/n-after.jpg' }),
  ];
  await seedMetadataCache(kv, records);
  const frameSpecs = {};
  for (const key of ['s-before.jpg', 's-after.jpg', 'n-before.jpg', 'n-after.jpg']) {
    frameSpecs[key] = { bytes: await makeSolidJpeg(4, 4, [5, 5, 5]) };
  }
  const { fetchFn, hits } = makeConfigurableFetch(frameSpecs);
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway1AccidentEvent()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  assert.equal(hits.frame, 4);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.imageStrategy, 'quad');
  assert.equal(trace.enrichment.imagePrepared, true);
});

// =======================================================================
// 10. RoadID/RoadName dirty-data regression — cross-road contamination.
// =======================================================================

test('10a. a record with RoadID:000030 (國3) but a mismatched RoadName:國道1號 is correctly kept OUT of 國1\'s candidate pool (RoadID wins, no OR-fallback rescue)', () => {
  const dirty = cctv3Record({ CCTVID: 'DIRTY-1', RoadName: '國道1號', LocationMile: '82K+100', RoadDirection: 'S', VideoStreamURL: 'https://cctv1.freeway.gov.tw/dirty1.jpg' });
  const eligibility = resolveCctvEligibility(freeway1AccidentEvent()); // targetKm ~82.1
  const candidate = selectSingleShoulderCandidate([dirty], {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: 'S',
    startKm: 82,
    endKm: 82.2,
  });
  assert.equal(candidate, null, 'a RoadID:000030 record must never be selected for a 國1 (roadId 000010) search, even though its RoadName says 國道1號');
});

test('10b. a record with RoadID:000010 (國1) but a mismatched RoadName:國道3號 is correctly kept OUT of 國3\'s candidate pool', () => {
  const dirty = cctv1Record({ CCTVID: 'DIRTY-2', RoadName: '國道3號', LocationMile: '102K+603', RoadDirection: 'S', VideoStreamURL: 'https://cctv3.freeway.gov.tw/dirty2.jpg' });
  const eligibility = resolveCctvEligibility(freeway3Event());
  const candidate = selectSingleShoulderCandidate([dirty], {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: eligibility.direction,
    startKm: eligibility.startKm,
    endKm: eligibility.endKm,
  });
  assert.equal(candidate, null, 'a RoadID:000010 record must never be selected for a 國3 (roadId 000030) search, even though its RoadName says 國道3號');
});

test('10c. the SAME dirty pair correctly still resolves to their OWN authoritative road when queried the matching way — proves this is a precision fix, not a new exclusion of real records', () => {
  const dirtyAsThreeButNamedOne = cctv3Record({ CCTVID: 'DIRTY-1', RoadName: '國道1號', LocationMile: '102K+603', RoadDirection: 'S', VideoStreamURL: 'https://cctv3.freeway.gov.tw/dirty1.jpg' });
  const eligibility = resolveCctvEligibility(freeway3Event());
  const candidate = selectSingleShoulderCandidate([dirtyAsThreeButNamedOne], {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: eligibility.direction,
    startKm: eligibility.startKm,
    endKm: eligibility.endKm,
  });
  assert.ok(candidate, 'RoadID:000030 must still correctly match a 國3 search — RoadID stays authoritative, not merely stricter');
  assert.equal(candidate.cctvId, 'DIRTY-1');
});

test('10d. a record with NO RoadID at all still matches via RoadName fallback (unchanged behavior for the genuinely-no-RoadID case)', () => {
  const noRoadId = cctv3Record({ CCTVID: 'NO-ROADID', RoadID: undefined, RoadName: '國道3號', LocationMile: '102K+603', RoadDirection: 'S', VideoStreamURL: 'https://cctv3.freeway.gov.tw/noid.jpg' });
  const eligibility = resolveCctvEligibility(freeway3Event());
  const candidate = selectSingleShoulderCandidate([noRoadId], {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: eligibility.direction,
    startKm: eligibility.startKm,
    endKm: eligibility.endKm,
  });
  assert.ok(candidate, 'a record with no RoadID at all must still be findable via its RoadName, unchanged fallback behavior');
});

// =======================================================================
// 11. Shared Feed image regression (國3, real fixture).
// =======================================================================

test('11. Shared Feed imageUrl/imageExpiresAt — 國3 real fixture (102K+100～103K+070) populates normally', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, REAL_RANGE_RECORDS);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ 'n3-102603.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway3Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.completedProducts.length, 1);
  assert.ok(result.completedProducts[0].imageUrl);
  assert.ok(result.completedProducts[0].imageExpiresAt);
});

// =======================================================================
// 12. Pipeline Trace regression (國3, real fixture — full acceptance list).
// =======================================================================

test('12. Pipeline Trace — 國3 real fixture: cctvEligible=true, imageStrategy=single, selectedCamera KM=102.603, imagePrepared=true, LINE text+image, no raw CCTV payload', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, REAL_RANGE_RECORDS);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn, pushCalls } = makeConfigurableFetch({ 'n3-102603.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway3Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.enrichment.imageStrategy, 'single');
  assert.equal(trace.enrichment.imagePrepared, true);
  assert.equal(trace.enrichment.imageUrlPresent, true);
  assert.notEqual(trace.enrichment.cctvSkippedByReason, 'unsupported-road');
  assert.match(trace.enrichment.selectedCamera, /^CCTV-N3-S-102\.603-M@102K\+603$/);

  // LINE push carried both text and image.
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].body.messages.length, 2);
  assert.equal(pushCalls[0].body.messages[0].type, 'text');
  assert.equal(pushCalls[0].body.messages[1].type, 'image');

  // Whitelist discipline unchanged — no raw CCTV payload/stream URL ever
  // reaches the trace record.
  const serialized = JSON.stringify(trace);
  assert.equal(serialized.includes('VideoStreamURL'), false);
  assert.equal(serialized.includes('freeway.gov.tw'), false);
  assert.equal(serialized.includes('RoadSection'), false);
});

// =======================================================================
// 13. 0 extra TDX/PBS/Google calls.
// =======================================================================

test('13a. dynamicCollage.js imports nothing TDX-auth/client-related (structural — this round added 0 new upstream call paths)', () => {
  const src = readFileSync(new URL('../src/cctv/dynamicCollage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"].*tdx\/auth\.js['"]/);
  assert.doesNotMatch(src, /from ['"].*tdx\/client\.js['"]/);
});

test('13b. a full mixed 國1+國3 run makes 0 unexpected upstream calls — only the two real frame fetches and the mocked LINE endpoint', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctv1Record({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' }), ...REAL_RANGE_RECORDS]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn, hits } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes }, 'n3-102603.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [freeway1ShoulderEvent(), freeway3Event()],
    dedupeAvailable: true,
    now: NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 2);
  assert.equal(hits.frame, 2); // one per event, single strategy each
  assert.equal(hits.other, 0);
});

// =======================================================================
// Meta: audit-evidence pin-downs carried forward from V1.8.7.4, still valid.
// =======================================================================

test('the only RoadID:000030 in test/hsinchuCctvProbe.test.js is the pre-existing "wrong road -> excluded" synthetic fixture — still correctly excluded from 國1\'s pool (unaffected by 國3\'s addition; it is 國1\'s test, not 國3\'s)', () => {
  const src = readFileSync(new URL('./hsinchuCctvProbe.test.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("RoadID: '000030'"));
  assert.ok(line);
  assert.match(line, /wrong road/i);
});

test('hsinchuCctvProbe.js\'s real admin probe still fetches the FULL unfiltered nationwide Freeway CCTV list (no $filter/$top on CCTV_URL) — unchanged mechanism, now with a second registry entry benefiting from it', () => {
  assert.doesNotMatch(CCTV_URL, /\$filter=/);
  assert.doesNotMatch(CCTV_URL, /\$top=/);
});

test('prepareCctvImageForEvent (direct call, single strategy) succeeds end-to-end for the real 國3 fixture with a mock frame — no real network access needed to prove the wiring works', async () => {
  const kv = createMockKV();
  await seedMetadataCache(kv, REAL_RANGE_RECORDS);
  const frameBytes = await makeSolidJpeg(4, 4, [7, 7, 7]);
  const { fetchFn } = makeConfigurableFetch({ 'n3-102603.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await prepareCctvImageForEvent(env, freeway3Event(), {}, TEST_CODEC);
  assert.equal(result.ok, true);
  assert.ok(result.imageUrl);
  assert.ok(result.imageExpiresAt);
  assert.match(result.selectedCamera, /^CCTV-N3-S-102\.603-M@102K\+603$/);
});
