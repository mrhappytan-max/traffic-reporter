// V1.8.7.3 — Dynamic Shoulder CCTV prepare-timeout root-cause fix.
//
// PRODUCTION EVIDENCE (2026-08-21 afternoon, real events):
//   Case 1: 國1 南向 87K+290～90K+900, dynamic shoulder, ~16:20 — CCTV
//           eligible=true, but cctvSkippedByReason='prepare-timeout',
//           imagePrepared=false, imageUrlPresent=false.
//   Case 2: 國3 南向 102K+100～103K+070, ~15:49/~16:00 — LINE text
//           succeeded, Shared Feed persisted, but no image at all.
//
// ROOT CAUSE (case 1) — see cctv/dynamicCollage.js's own module comment
// (search "V1.8.7.3") for the full writeup: SINGLE_CCTV_PER_EVENT_BUDGET_MS
// was 1500ms, but the ONLY real network I/O this path performs
// (extractFirstJpegFrame, fetching a live MJPEG frame from
// freeway.gov.tw) is the SAME function tdx/hsinchuCctvProbe.js's own
// admin single-frame probe endpoint already uses with a 5000ms default
// (FRAME_TIMEOUT_MS) — an already-established, pre-existing-in-this-
// codebase baseline for how long that call may reasonably take. 1500ms
// gave it less than a third of that. Fixed by raising
// SINGLE_CCTV_PER_EVENT_BUDGET_MS to 6000ms (frame-fetch headroom +
// margin for R2 publish), NOT by removing any of the fairness/isolation/
// cap architecture V1.8.7.1 already built — this file's tests confirm
// both halves.
//
// ROOT CAUSE (case 2) — see the "國3 102K+100" test below:
// cctv/dynamicCollage.js's CCTV_SUPPORTED_ROADS registry has only ever
// contained 國道一號 (documented, deliberate — no Production-confirmed
// CCTV RoadID exists for 國道三號 in this codebase). A 國3 event is
// therefore `unsupported-road`, structurally ineligible, and never even
// reaches the timeout/frame-fetch machinery at all — correctly
// fail-closed, not a bug, and NOT the same root cause as case 1.
//
// No real TDX/PBS/CCTV/LINE network call anywhere in this file — every
// fetch is mocked, KV/R2 are in-memory mocks. This round changes no
// classification/eligibility/dedupe/suppression/broadcastHours/Shared-
// Feed/LINE behavior — only the CCTV single-event budget constant and
// additive, whitelist-only Pipeline Trace instrumentation fields.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import {
  resolveCctvEligibility,
  SINGLE_CCTV_PER_EVENT_BUDGET_MS,
  prepareCctvImageForEvent,
} from '../src/cctv/dynamicCollage.js';
import { FRAME_TIMEOUT_MS } from '../src/tdx/hsinchuCctvProbe.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
const NOW = new Date('2026-08-21T16:20:00+08:00'); // matches Production's own case-1 evidence

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

function r2Bucket({ failPut } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
      if (failPut) throw new Error('R2 write outage (test-only)');
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
    LocationMile: '89K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}

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

// Case 1's exact real event, per the Production evidence above.
function case1Event(overrides = {}) {
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

// Case 2's exact real event — 國3, which this codebase has never had a
// Production-confirmed CCTV RoadID for.
function case2Event(overrides = {}) {
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
// Budget value itself
// =======================================================================

test('A0: SINGLE_CCTV_PER_EVENT_BUDGET_MS is now 6000ms, comfortably >= FRAME_TIMEOUT_MS (5000ms) — the module-internal baseline this fix is grounded in', () => {
  assert.equal(SINGLE_CCTV_PER_EVENT_BUDGET_MS, 6000);
  assert.ok(SINGLE_CCTV_PER_EVENT_BUDGET_MS >= FRAME_TIMEOUT_MS, 'the per-event budget must comfortably cover a real single-frame fetch at the codebase\'s own established baseline');
});

// =======================================================================
// Case 1 (國1 87K+290) — the exact real Production regression
// =======================================================================

test('A1: case 1 regression — a frame latency that would have timed out under the OLD 1500ms budget now succeeds under the real 6000ms default', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  // 2500ms: comfortably beyond the OLD 1500ms budget, comfortably inside
  // the NEW 6000ms one — deliberately NOT tuned to the exact edge, this
  // is a "realistic-latency" value, not a boundary probe (see A2 below
  // for near-the-real-FRAME_TIMEOUT_MS-baseline latency).
  const { fetchFn, hits } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes, delayMs: 2500 } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  // Production default budget (no override) — this is the real fix being verified.
  const result = await runLineBroadcast(env, { allEvents: [case1Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.enrichment.imagePrepared, true, 'expected the real case-1 regression to now succeed under the corrected budget');
  assert.equal(trace.enrichment.imageUrlPresent, true);
  assert.equal(trace.enrichment.cctvSkippedByReason, null);
  assert.equal(hits.frame, 1); // single strategy — exactly 1 frame fetch, never 4
  // Stage-level instrumentation present and consistent with a genuine success.
  assert.ok(trace.enrichment.frameFetchDurationMs >= 2500, `frameFetchDurationMs should reflect the real ~2500ms delay, got ${trace.enrichment.frameFetchDurationMs}`);
  assert.equal(typeof trace.enrichment.r2PublishDurationMs, 'number');
  assert.equal(trace.enrichment.timeoutStage, null); // no timeout happened
});

test('A2: latency close to real Production values (near FRAME_TIMEOUT_MS, e.g. 4500ms) must not spuriously timeout under the new budget', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes, delayMs: 4500 } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [case1Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.imagePrepared, true, 'a 4500ms frame fetch — near the codebase\'s own 5000ms baseline — must not spuriously timeout under the new 6000ms budget');
});

test('A3: a genuine timeout (frame fetch that truly exceeds even the new budget) still correctly resolves text-only, with timeoutStage=frame-fetch', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes, delayMs: 2000 } }); // far exceeds the small test budget below
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  // V1.8.7.3 note on test determinism: asserting WHICH stage a race
  // against the timer landed on is only meaningful once the metadata
  // read (a real, if tiny, KV-mock await) is no longer part of the race
  // — otherwise this assertion would be timing-flaky (metadata itself
  // racing the same short budget) rather than testing the thing this
  // test exists to test. Warming `runCache.metadataPromise` first, via
  // one throwaway direct call sharing the SAME runCache, removes that
  // variable: by the time the timed call below starts, metadata is
  // already a resolved Promise, so the only real async work left is the
  // (deliberately slow, 2000ms) frame fetch — exactly the stage this
  // test means to catch the timeout mid-flight in.
  const runCache = {};
  await prepareCctvImageForEvent(env, case1Event({ rawId: 'WARMUP' }), runCache, TEST_CODEC, undefined, { budgetMs: 10000 });

  const result = await prepareCctvImageForEvent(env, case1Event(), runCache, TEST_CODEC, undefined, { budgetMs: 50 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'prepare-timeout');
  assert.equal(result.timeoutStage, 'frame-fetch', 'stageTracker should show the timeout hit while the frame fetch was still in flight');
});

test('A3b: end-to-end (runLineBroadcast) — a genuine per-event timeout never blocks the LINE text push, regardless of which stage it lands on', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes, delayMs: 300 } }); // exceeds the tiny 50ms test budget below
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [case1Event()],
    dedupeAvailable: true,
    now: NOW,
    cctvCodecOverride: TEST_CODEC,
    singleCctvBudgetOverrides: { budgetMs: 50 }, // deterministic, TEST-ONLY — a genuinely-too-slow frame for its own budget
  });

  assert.equal(result.pushSucceeded, 1, 'CCTV timeout must never block the LINE text push');
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.imagePrepared, false);
  assert.equal(trace.enrichment.cctvSkippedByReason, 'prepare-timeout');
  assert.ok(
    ['metadata', 'candidate-selection', 'frame-fetch', 'r2-publish'].includes(trace.enrichment.timeoutStage),
    `timeoutStage should be one of the known stages, got ${trace.enrichment.timeoutStage}`
  );
});

// =======================================================================
// Case 2 (國3 102K+100) — independent diagnosis, NOT the same cause as case 1
//
// V1.8.7.5 integration note: at the time this file was originally
// written, 國3 was NOT in CCTV_SUPPORTED_ROADS (V1.8.7.3's own diagnosis
// — see this file's own module comment above — correctly found
// 'unsupported-road' as case 2's THEN-current, accurate root cause). This
// file is now integrated onto a `main` where V1.8.7.5 has since added a
// real, Production-confirmed 國道三號 registry entry (see
// cctv/dynamicCollage.js's own CCTV_SUPPORTED_ROADS and its V1.8.7.4→
// V1.8.7.5 comment for the full provenance) — so case 2 is no longer
// ineligible. The two tests below were updated to assert the CURRENT,
// integrated behavior (eligible, cache-miss fail-closed under this
// file's own no-metadata-seeded fixture) rather than silently keep
// asserting a now-superseded finding — see test/freeway3CctvAudit.test.js
// for the FULL 國3 CCTV regression suite (real fixture, camera
// selection, dirty-data protection, etc); these two tests exist only to
// keep this file's own case-2 narrative consistent with reality, not to
// re-cover ground that file already owns.
// =======================================================================

test('B1: case 2 — 國3 102K+100 is now cctvEligible=true (V1.8.7.5 added a confirmed 國3 registry entry) — was unsupported-road when this file was first written, per V1.8.7.3\'s own then-current, correct diagnosis', () => {
  const eligibility = resolveCctvEligibility(case2Event());
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.imageStrategy, 'single');
});

test('B2: case 2 regression — the full pipeline for a 國3 dynamic-shoulder event pushes LINE text + persists to Shared Feed; with no CCTV metadata cache seeded, CCTV fails closed to metadata-cache-unavailable (0 frame fetch) rather than unsupported-road', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  // Deliberately NO CCTV metadata cache seeded, and fetch throws on any
  // freeway.gov.tw call — proves this event never even reaches the
  // frame-fetch stage, confirming this is a cache-miss (fail-closed), not
  // a frame-fetch failure.
  const { fetchFn, hits } = makeConfigurableFetch({});
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [case2Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1); // LINE text still succeeds
  assert.equal(hits.frame, 0); // never attempted a frame fetch — metadata cache miss happens first
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.enrichment.imagePrepared, false); // attempted, failed closed on the cache miss
  assert.equal(trace.enrichment.cctvSkippedByReason, 'metadata-cache-unavailable');
  assert.equal(result.completedProducts.length, 1);
  assert.ok(result.completedProducts[0].text); // Shared Feed product still exists, text-only
  assert.equal(result.completedProducts[0].imageUrl, null);
});

// =======================================================================
// Instrumentation privacy — no full CCTV payload ever stored
// =======================================================================

test('C1: the new instrumentation fields are numbers/short strings only — never a stream URL, candidate record, or frame bytes', async () => {
  const kv = createMockKV();
  await enrollUser(kv);
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, { allEvents: [case1Event()], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  const trace = result.pipelineTraceEntries[0];
  const serialized = JSON.stringify(trace);
  assert.equal(serialized.includes('VideoStreamURL'), false);
  assert.equal(serialized.includes('videoStreamUrl'), false);
  assert.equal(serialized.includes('freeway.gov.tw'), false);
  assert.equal(typeof trace.enrichment.frameFetchDurationMs, 'number');
  assert.equal(typeof trace.enrichment.r2PublishDurationMs, 'number');
});

// =======================================================================
// Direct unit-level check of prepareCctvImageForEvent's returned shape
// =======================================================================

test('D1: prepareCctvImageForEvent (single strategy, direct call) returns frameFetchDurationMs/r2PublishDurationMs on success', async () => {
  const kv = createMockKV();
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { bytes: frameBytes, delayMs: 20 } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await prepareCctvImageForEvent(env, case1Event(), {}, TEST_CODEC);

  assert.equal(result.ok, true);
  assert.ok(result.frameFetchDurationMs >= 20);
  assert.equal(typeof result.r2PublishDurationMs, 'number');
  assert.equal(result.timeoutStage, undefined); // never set on a success path
});

test('D2: prepareCctvImageForEvent (single strategy, direct call) returns reason=no-frames + frameFetchDurationMs on a 404', async () => {
  const kv = createMockKV();
  await seedMetadataCache(kv, [cctvRecord({ CCTVID: 'CCTV-89', LocationMile: '89K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/89.jpg' })]);
  const { fetchFn } = makeConfigurableFetch({ '89.jpg': { fail: true } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await prepareCctvImageForEvent(env, case1Event(), {}, TEST_CODEC);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-frames');
  assert.equal(typeof result.frameFetchDurationMs, 'number');
});
