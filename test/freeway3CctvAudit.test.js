// V1.8.7.4 — 國3 CCTV Support Audit.
//
// TASK: real Production evidence showed 國3 南向 102K+100～103K+070 (a
// dynamic-shoulder event) had no CCTV image, previously diagnosed
// (V1.8.7.3) as cctvEligible=false/reason='unsupported-road'. This round
// audits whether real 國3 CCTV metadata already exists anywhere this
// codebase can reach, BEFORE assuming "the program just hasn't been
// taught about it yet" — see dynamicCollage.js's own V1.8.7.4 comment for
// the full audit writeup this file's tests pin down.
//
// CONCLUSION: no real, Production-confirmed CCTV RoadID/RoadName for
// 國道三號 exists anywhere in this repository — only (a) unrelated KM/
// facility data for 國3 (a different TDX dataset entirely), and (b) one
// SYNTHETIC test fixture (RoadID:'000030') explicitly built to test
// "wrong road excluded" logic, never captured from a real TDX response.
// Per this round's own "只有資料來源與測試證據足夠的道路才加入"
// instruction, 國3 is therefore NOT added to CCTV_SUPPORTED_ROADS this
// round. These tests pin that conclusion down as an explicit, checked
// fact — not a thing nobody thought to look at — and confirm 國1's
// existing CCTV pipeline (dynamic-shoulder single + accident quad) is
// completely unaffected by this audit.
//
// No real TDX/PBS/CCTV/LINE network call anywhere in this file — every
// fetch is mocked, KV/R2 are in-memory mocks; a throwing mock fetch on
// any TDX/PBS host proves 0 extra upstream calls directly.

import { test, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resolveCctvEligibility } from '../src/cctv/dynamicCollage.js';
import { resolveRoadKey } from '../src/traffic/roadSectionLabel.js';
import { CCTV_URL } from '../src/tdx/hsinchuCctvProbe.js';
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

function cctvRecord(overrides) {
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
// 1. 國3 recognized as a supported freeway for KM/section labels, but NOT
//    (yet) for CCTV — the audit's central distinction.
// =======================================================================

test('1. 國3 road identity resolves (roadSectionLabel.js DOES know 國道三號) — proves the road itself is a known entity, unrelated to CCTV support', () => {
  const roadKey = resolveRoadKey('國道三號');
  assert.equal(roadKey, '國道三號', '國3 must still resolve as a real, known road key — this audit never touched road identity/KM resolution');
});

// =======================================================================
// 2. 國3 dynamic shoulder CCTV eligibility — current, audited, correct
//    status is unsupported-road (never no-camera, never a guessed success).
// =======================================================================

test('2. 國3 dynamic-shoulder event: cctvEligible=false, reason=unsupported-road (audited conclusion, not a fresh diagnosis)', () => {
  const eligibility = resolveCctvEligibility(freeway3Event());
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'unsupported-road');
});

// =======================================================================
// 3. 國3 never reaches candidate selection — proves this is an
//    eligibility-gate outcome, not a failed camera search.
// =======================================================================

test('3. 國3 full pipeline never attempts a frame fetch — 0 CCTV attempt, confirming the gate fires before candidate selection', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  // Deliberately NO CCTV metadata cache seeded, and fetch throws on any
  // freeway.gov.tw call — if this event ever reached candidate selection/
  // frame-fetch, this test would fail loudly.
  const { fetchFn, hits } = makeConfigurableFetch({});
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway3Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(hits.frame, 0);
});

// =======================================================================
// 4. direction-awareness is N/A this round — 國3 was not added, so there
//    is no direction-aware candidate selection to exercise for it yet.
//    This test documents that explicitly rather than silently skipping it.
// =======================================================================

test('4. 國3 direction-aware candidate selection is not exercised this round (國3 not added to CCTV_SUPPORTED_ROADS) — both directions correctly gate identically', () => {
  const south = resolveCctvEligibility(freeway3Event({ direction: '南向' }));
  const north = resolveCctvEligibility(freeway3Event({ direction: '北向' }));
  assert.equal(south.eligible, false);
  assert.equal(south.reason, 'unsupported-road');
  assert.equal(north.eligible, false);
  assert.equal(north.reason, 'unsupported-road');
});

// =======================================================================
// 5. no-camera vs unsupported-road — must stay structurally distinct.
// =======================================================================

test('5. 國3 correctly reports unsupported-road, NEVER no-camera — no-camera would falsely imply a real nearby-camera search was attempted and failed', () => {
  const eligibility = resolveCctvEligibility(freeway3Event());
  assert.notEqual(eligibility.reason, 'no-camera');
  assert.equal(eligibility.reason, 'unsupported-road');
});

// =======================================================================
// 6. 國1 dynamic-shoulder single CCTV — regression, completely unaffected.
// =======================================================================

test('6. 國1 87K+290 dynamic-shoulder regression — imagePrepared=true, imageStrategy=single, unaffected by this audit', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
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

// =======================================================================
// 7. 國1 accident quad CCTV — regression, completely unaffected.
// =======================================================================

test('7. 國1 accident quad regression — imageStrategy=quad, 4-frame collage mechanism unaffected by this audit', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  const records = [
    cctvRecord({ CCTVID: 'S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/s-before.jpg' }),
    cctvRecord({ CCTVID: 'S-AFTER', RoadDirection: 'S', LocationMile: '82K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/s-after.jpg' }),
    cctvRecord({ CCTVID: 'N-BEFORE', RoadDirection: 'N', LocationMile: '81K+950', VideoStreamURL: 'https://cctv1.freeway.gov.tw/n-before.jpg' }),
    cctvRecord({ CCTVID: 'N-AFTER', RoadDirection: 'N', LocationMile: '82K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/n-after.jpg' }),
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
  assert.equal(hits.frame, 4); // still exactly 4 frames for an accident — quad mechanism untouched
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.imageStrategy, 'quad');
  assert.equal(trace.enrichment.imagePrepared, true);
});

// =======================================================================
// 8. Shared Feed image regression — 國1 imageUrl/imageExpiresAt still populate.
// =======================================================================

test('8. Shared Feed imageUrl/imageExpiresAt regression — still populated normally for a 國1 event', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway1ShoulderEvent()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.completedProducts.length, 1);
  assert.ok(result.completedProducts[0].imageUrl);
  assert.ok(result.completedProducts[0].imageExpiresAt);
});

// =======================================================================
// 9. Pipeline Trace reason regression — 國3 still shows the correct,
//    audited reason, and never a raw CCTV payload.
// =======================================================================

test('9. Pipeline Trace for a 國3 event: cctvEligible=false, cctvSkippedByReason=null (never-attempted, not attempted-and-failed), LINE text still pushed', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  const { fetchFn } = makeConfigurableFetch({});
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [freeway3Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.cctvEligible, false);
  assert.equal(trace.enrichment.cctvSkippedByReason, null);
  assert.equal(trace.enrichment.imagePrepared, null);
});

// =======================================================================
// 10. 0 extra TDX/PBS/Google calls — structural + behavioral confirmation.
// =======================================================================

test('10a. dynamicCollage.js imports nothing TDX-auth/client-related (structural — this audit added 0 new upstream call paths)', () => {
  const src = readFileSync(new URL('../src/cctv/dynamicCollage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"].*tdx\/auth\.js['"]/);
  assert.doesNotMatch(src, /from ['"].*tdx\/client\.js['"]/);
});

test('10b. a full mixed 國1+國3 run makes 0 unexpected upstream calls — only the one real 國1 frame fetch and the mocked LINE endpoint', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn, hits } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes } });
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
  assert.equal(hits.frame, 1); // only 國1's single frame — 國3 never attempts one
  assert.equal(hits.other, 0); // 0 unexpected calls (would throw otherwise)
});

// =======================================================================
// Meta: pin down the audit's own evidence so a future round can trust it
// without re-deriving it, and so the synthetic test fixture can never be
// silently mistaken for real captured data.
// =======================================================================

test('11. the only RoadID:000030 in this test suite is the synthetic "wrong road -> excluded" fixture in hsinchuCctvProbe.test.js, explicitly commented as such — not real captured 國3 data', () => {
  const src = readFileSync(new URL('./hsinchuCctvProbe.test.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("RoadID: '000030'"));
  assert.ok(line, 'expected to find the 000030 fixture line');
  assert.match(line, /wrong road/i);
});

test('12. CCTV_SUPPORTED_ROADS remains 國道一號-only this round — a future addition must be a deliberate, evidence-backed change, not silent', () => {
  // resolveCctvEligibility is the only public surface of the registry —
  // asserting behavior (not reading the private constant directly) so
  // this test tracks the real contract, not the module's internal shape.
  assert.equal(resolveCctvEligibility(freeway3Event()).reason, 'unsupported-road');
  assert.equal(resolveCctvEligibility({ source: 'freeway', type: 'accident', road: '國道一號', startKM: '82K+000', endKM: '82K+200' }).eligible, true);
});

test('13. hsinchuCctvProbe.js\'s real admin probe fetches the FULL unfiltered nationwide Freeway CCTV list (no $filter/$top on CCTV_URL) — confirms the metadata mechanism already captures 國3 records whenever a real probe runs in Production, even though this dev sandbox cannot read that cache', () => {
  assert.doesNotMatch(CCTV_URL, /\$filter=/);
  assert.doesNotMatch(CCTV_URL, /\$top=/);
  const src = readFileSync(new URL('../src/tdx/hsinchuCctvProbe.js', import.meta.url), 'utf8');
  // The full, unfiltered `records` array (not a road-filtered subset) is
  // what gets handed to writeFreewayCctvMetadataCache.
  assert.match(src, /await writeFreewayCctvMetadataCache\(env\.TRAFFIC_KV, records, new Date\(\)\)/);
});
