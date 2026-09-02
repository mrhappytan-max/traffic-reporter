// V1.9.0 forensic investigation — 國3 96K+700 accident, 2026-08-26.
//
// REAL EVENT:
//   09:20 — event reached the Shared Feed, withImage=0. No completion
//           log for CCTV prepare at all (no imagePrepared, no
//           cctvSkippedByReason with a stage attached).
//   09:30 — the SAME event, reprocessed one Cron tick later:
//           candidates=1, eligible=1, attempted=1, attached=1, quad
//           image succeeded.
//
// Camera inventory, road resolution, and CCTV capability are therefore
// NOT permanently broken (09:30 proves that). The question is why the
// FIRST attempt produced nothing observable at all.
//
// ORDER: ROOT_CAUSE_FIRST = REQUIRED, RETRY_BEFORE_ROOT_CAUSE = FORBIDDEN.
// This file is Phase 1 (forensic reading, in the comments) + Phase 2
// (deterministic, instrumented reproduction) of that order. No fix is
// applied in this file — it only characterizes existing behavior so a
// fix (if any) can be chosen from evidence, not from a plausible guess.
//
// -----------------------------------------------------------------------
// PHASE 1 FINDINGS (real call path, read directly from source — see the
// file:line references inline below, not recalled from memory):
// -----------------------------------------------------------------------
//
// 1. The 4000ms timer (CCTV_PREPARE_BUDGET_MS, dynamicCollage.js) is
//    established in TWO places for the quad (accident) path:
//      a. broadcastPipeline.js's cctvRunDeadlineAt — ONE deadline shared
//         across every accident in the SAME Cron tick, lazily anchored
//         to the first accident that reaches CCTV processing. A second
//         accident in the same tick receives `remainingRunBudgetMs`
//         (whatever's left), NOT a fresh 4000ms.
//      b. prepareCctvImageForEvent's own `withTimeout(work, budgetMs, ...)`
//         races that (possibly already-reduced) budget against the real
//         work for THIS event.
//
// 2. `withTimeout` (dynamicCollage.js) is a bare setTimeout race with NO
//    AbortController threaded into `work`. When the timer wins:
//      - it resolves 'prepare-timeout' immediately;
//      - `work` (prepareCctvImageWork) is NEVER cancelled — it keeps
//        running to completion in the background, and its eventual
//        result is silently discarded. This is documented and
//        deliberate (see that function's own comment), not a bug in
//        itself — but it means TIMEOUT_ABORTS_UNDERLYING_WORK = NO.
//
// 3. prepareCctvImageWork (the quad path) carries NO stageTracker at
//    all — unlike prepareSingleCctvImageWork (the dynamic-shoulder
//    path), which mutates a caller-owned {stage} object at each step
//    precisely so a timeout can still report `timeoutStage`. The quad
//    path's 'prepare-timeout' result has never carried a stage, a
//    partial frame count, or any partial timing. THIS is the direct,
//    confirmed cause of "09:20 沒有 completion log": there is nothing
//    to log, because nothing inside the quad work records progress
//    anywhere the caller can see before/unless the whole call resolves.
//
// 4. Frame fetching (composeCollageFromCandidates, hsinchuCctvProbe.js)
//    is `Promise.all(candidates.map(...))` — FOUR candidates fetched
//    CONCURRENTLY, confirmed by test D below (measured wall time, not
//    asserted from reading the code alone).
//
// 5. Each individual frame fetch has its own AbortSignal.timeout(ms)
//    (extractFirstJpegFrame), where ms = frameTimeoutMs = whatever's
//    left of the run's shared deadline at the moment frame-fetching
//    starts (computed AFTER metadata read + camera selection). If an
//    earlier accident in the same tick has already spent most of the
//    shared 4000ms budget before this event's frame-fetch even begins,
//    frameTimeoutMs can be reduced all the way down to
//    MIN_FRAME_TIMEOUT_MS (300ms) — nowhere near enough for a real
//    freeway.gov.tw MJPEG fetch, which is confirmed in this codebase's
//    own established baseline (FRAME_TIMEOUT_MS default = 5000ms, the
//    same duration this file's own admin probe endpoint uses).
//
// 6. `composeQuadrantCollage` (collage.js) decodes each successfully
//    fetched frame SERIALLY, in a plain `for` loop (`await decodeJpeg`
//    per cell) — not the frame-fetch stage, but the same shared
//    remaining-budget window is what `prepareCctvImageWork` re-checks
//    just before the R2 publish, so a slow decode/encode (WASM codec
//    cold-load + up to 4 real JPEG decodes) can independently erode the
//    same clock. Tested directly in test E below.
//
// Conclusion from Phase 1 alone: this codebase has (at least) one
// mechanism that can starve a LATER accident in the same Cron tick of
// real frame-fetch time — the shared, lazily-anchored run deadline — and
// a SEPARATE, confirmed observability gap (no stage tracking on the quad
// path) that would make exactly that starvation invisible in Pipeline
// Trace. Phase 2 below proves each moving part with a controlled fixture
// rather than asserting this from reading code alone.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { decodeJpeg as REAL_decodeJpeg, encodeJpeg as REAL_encodeJpeg } from './testJpegCodec.js';

function kv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function r2Bucket({ putDelayMs = 0 } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
      if (putDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, putDelayMs));
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

function metadataEnvelope(records) {
  return JSON.stringify({ records, fetchedAt: new Date().toISOString() });
}

function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000030',
    RoadName: '國道3號',
    RoadDirection: 'S',
    LocationMile: '96K+700',
    PositionLon: 121.0,
    PositionLat: 24.7,
    VideoStreamURL: 'https://cctv3.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}

// Four quadrant-filling records around 國3 96.7K — S前/S後/N前/N後, same
// idiom as the real 96K+700 case this order is investigating.
const QUAD_RECORDS = [
  cctvRecord({ CCTVID: 'CAM-S-BEFORE', RoadDirection: 'S', LocationMile: '96K+500', VideoStreamURL: 'https://cctv3.freeway.gov.tw/s-before.jpg' }),
  cctvRecord({ CCTVID: 'CAM-S-AFTER', RoadDirection: 'S', LocationMile: '96K+900', VideoStreamURL: 'https://cctv3.freeway.gov.tw/s-after.jpg' }),
  cctvRecord({ CCTVID: 'CAM-N-BEFORE', RoadDirection: 'N', LocationMile: '96K+900', VideoStreamURL: 'https://cctv3.freeway.gov.tw/n-before.jpg' }),
  cctvRecord({ CCTVID: 'CAM-N-AFTER', RoadDirection: 'N', LocationMile: '96K+500', VideoStreamURL: 'https://cctv3.freeway.gov.tw/n-after.jpg' }),
];

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-96K700',
    type: 'accident',
    road: '國道三號',
    direction: '南向',
    startKM: '96K+500',
    endKM: '96K+900',
    description: '事故',
    // V2.4.5 — service-area gate evidence; official-polygon-confirmed
    // inside 新竹縣 (竹北市 vicinity, near 國道三號 96K).
    longitude: 121.0134,
    latitude: 24.8388,
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
  const bytes = await REAL_encodeJpeg({ data, width, height }, { quality: 70 });
  return new Uint8Array(bytes);
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

/**
 * A per-URL controllable frame fetch. `delays` maps a URL substring to a
 * delay in ms before responding (default 0 = immediate). `neverResolve`
 * lists URL substrings that hang until aborted (real fetch behavior
 * under AbortSignal.timeout — resolves only via the abort event, never
 * on its own). Records each call's start time so tests can assert
 * concurrency, not just outcome.
 */
function makeControllableFrameFetch({ delays = {}, neverResolve = [], frameJpeg }) {
  const calls = [];
  const fetchFn = (url, init) => {
    const href = String(url);
    const startedAt = Date.now();
    calls.push({ href, startedAt });
    if (!href.includes('freeway.gov.tw')) {
      return Promise.reject(new Error(`unexpected non-freeway.gov.tw fetch: ${href}`));
    }
    if (neverResolve.some((s) => href.includes(s))) {
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    const delayKey = Object.keys(delays).find((s) => href.includes(s));
    const delayMs = delayKey !== undefined ? delays[delayKey] : 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(frameJpeg, { status: 200 })), delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  return { fetchFn, calls };
}

// =======================================================================
// A. metadata instant, all 4 frames instant -> baseline success
// =======================================================================

test('A. baseline: metadata instant + all 4 frames instant -> quad succeeds well inside budget', async () => {
  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const env = {
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) }),
    CCTV_IMAGES: r2Bucket(),
  };
  const { fetchFn, calls } = makeControllableFrameFetch({ frameJpeg });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const started = Date.now();
  const result = await prepareCctvImageForEvent(
    env,
    accidentEvent(),
    {},
    { decodeJpeg: REAL_decodeJpeg, encodeJpeg: REAL_encodeJpeg },
    4000
  );
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 4, 'all four quadrant candidates were fetched');
  assert.ok(elapsed < 2000, `baseline should be fast, took ${elapsed}ms`);
});

// =======================================================================
// B. one frame delayed past the whole budget -> observe where it lands
// =======================================================================

test('B. one frame delayed 4500ms (past a 4000ms budget) -> the run still resolves at/near the budget, not at the slow frame\'s own delay', async () => {
  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const env = {
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) }),
    CCTV_IMAGES: r2Bucket(),
  };
  const { fetchFn, calls } = makeControllableFrameFetch({
    delays: { 's-before': 4500 },
    frameJpeg,
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const started = Date.now();
  const result = await prepareCctvImageForEvent(
    env,
    accidentEvent(),
    {},
    { decodeJpeg: REAL_decodeJpeg, encodeJpeg: REAL_encodeJpeg },
    4000
  );
  const elapsed = Date.now() - started;

  // The outer 4000ms budget is what actually governs the caller's wait —
  // NOT the 4500ms slow frame. Bounded well under the slow frame's delay.
  assert.ok(elapsed < 4700, `expected the caller to be released near the 4000ms budget, took ${elapsed}ms`);
  assert.equal(result.reason, 'prepare-timeout');
  // FIXED (V1.9.0): the quad path's timeout now carries a stage —
  // before this round, this was always `undefined`, which is the exact
  // "no completion log" symptom from 09:20.
  //
  // This scenario deliberately races TWO independent clocks that both
  // derive from the SAME `budgetMs`/`deadlineAt`, computed a few ms apart
  // at call entry — the outer withTimeout race, and prepareCctvImageWork's
  // own internal pre-publish recheck. Which one notices the deadline
  // first is genuinely non-deterministic (real timer jitter), so BOTH
  // outcomes below are correct, not a flake to paper over:
  //   'frame-fetch' — the outer race's timer won while composeCollage-
  //                   FromCandidates was still in flight (frame-fetch
  //                   duration alone was already ~at budget).
  //   'r2-publish'  — frame-fetch+compose finished a hair AFTER the
  //                   deadline had technically passed; work's OWN
  //                   pre-publish recheck caught it first and returned
  //                   before the outer timer even fired.
  // Either way, `timeoutStage` is populated — that is the actual fix
  // being proven here, not which of the two internal races wins.
  assert.ok(
    result.timeoutStage === 'frame-fetch' || result.timeoutStage === 'r2-publish',
    `expected a real stage, got ${result.timeoutStage}`
  );
  // metadata/camera-selection DID complete before the timeout (they are
  // near-instant, pure/local operations) — their timing is preserved
  // even though the overall call timed out, per the order's own
  // requirement ("留下最低限度 trace").
  assert.equal(typeof result.metadataElapsedMs, 'number');
  assert.equal(typeof result.cameraSelectionElapsedMs, 'number');
  if (result.timeoutStage === 'frame-fetch') {
    // frame-fetch/collage never got a chance to finish and report their
    // own numbers before the timer won — honestly absent, not fabricated.
    assert.equal(result.frameFetchElapsedMs, undefined);
  } else {
    // the 'r2-publish' branch means frame-fetch+collage DID finish —
    // their numbers are real and present.
    assert.equal(typeof result.frameFetchElapsedMs, 'number');
    assert.equal(typeof result.collageElapsedMs, 'number');
  }
  await new Promise((resolve) => setTimeout(resolve, 700)); // let the abandoned background work settle before the file exits
});

// =======================================================================
// C. one frame never resolves -> confirm the outer race still frees the
//    caller, and confirm the abandoned fetch is still reachable (i.e.
//    NOT forcibly aborted by the outer timeout)
// =======================================================================

test('C. one frame never resolves at all -> caller is still released at the budget; TIMEOUT_ABORTS_UNDERLYING_WORK = NO', async () => {
  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const env = {
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) }),
    CCTV_IMAGES: r2Bucket(),
  };
  let abortedCount = 0;
  const { fetchFn } = makeControllableFrameFetch({
    neverResolve: ['s-before'],
    frameJpeg,
  });
  const wrappedFetch = (url, init) => {
    init?.signal?.addEventListener('abort', () => {
      abortedCount += 1;
    });
    return fetchFn(url, init);
  };
  priorFetch = globalThis.fetch;
  globalThis.fetch = wrappedFetch;

  const started = Date.now();
  const smallBudgetMs = 300; // small so this test stays fast/deterministic
  const result = await prepareCctvImageForEvent(
    env,
    accidentEvent(),
    {},
    { decodeJpeg: REAL_decodeJpeg, encodeJpeg: REAL_encodeJpeg },
    smallBudgetMs
  );
  const elapsed = Date.now() - started;

  assert.equal(result.reason, 'prepare-timeout');
  assert.ok(elapsed < smallBudgetMs + 500, `caller released near the ${smallBudgetMs}ms budget, took ${elapsed}ms`);

  // The stuck frame's OWN per-frame AbortSignal.timeout (frameTimeoutMs,
  // floored at MIN_FRAME_TIMEOUT_MS=300ms) is what eventually aborts it
  // — NOT the outer prepare-timeout, which has no AbortController of its
  // own at all. Give that per-frame timeout time to fire.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(abortedCount >= 1, 'the abandoned fetch DOES eventually abort, but only via its OWN per-frame timeout — never because the outer prepare-timeout fired');
});

// =======================================================================
// D. all 4 frames delayed identically -> proves SERIAL vs PARALLEL
// =======================================================================

test('D. all 4 frames delayed 1200ms each -> total elapsed is ~1200ms (parallel), not ~4800ms (serial)', async () => {
  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const env = {
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) }),
    CCTV_IMAGES: r2Bucket(),
  };
  const { fetchFn, calls } = makeControllableFrameFetch({
    delays: { 's-before': 1200, 's-after': 1200, 'n-before': 1200, 'n-after': 1200 },
    frameJpeg,
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const started = Date.now();
  const result = await prepareCctvImageForEvent(
    env,
    accidentEvent(),
    {},
    { decodeJpeg: REAL_decodeJpeg, encodeJpeg: REAL_encodeJpeg },
    4000
  );
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 4);
  // All 4 calls must have STARTED within a few ms of each other — the
  // direct proof of concurrency, not just total elapsed time.
  const startSpread = Math.max(...calls.map((c) => c.startedAt)) - Math.min(...calls.map((c) => c.startedAt));
  assert.ok(startSpread < 100, `expected all 4 fetches to start together (parallel), spread was ${startSpread}ms`);
  // Serial would be >= 4 * 1200 = 4800ms; parallel is ~1200ms + compose.
  assert.ok(elapsed < 2500, `FRAME_FETCH_MODE=PARALLEL expected (~1200ms); took ${elapsed}ms, which would indicate serial fetching`);
});

// =======================================================================
// E. frames instant, collage compose artificially slow -> does compose
//    time count against the same budget?
// =======================================================================

test('E. all frames instant but collage decode is slow (3500ms) -> the SAME 4000ms budget covers compose, not just frame-fetch', async () => {
  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const env = {
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) }),
    CCTV_IMAGES: r2Bucket(),
  };
  const { fetchFn } = makeControllableFrameFetch({ frameJpeg });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const slowDecodeJpeg = async (bytes) => {
    await new Promise((resolve) => setTimeout(resolve, 900)); // called up to 4x serially in composeQuadrantCollage
    return REAL_decodeJpeg(bytes);
  };

  const started = Date.now();
  // Budget large enough to observe compose actually running (not swallowed
  // instantly by the outer race), small enough that 4x900ms=3600ms of
  // decode alone would overrun a tight budget.
  const result = await prepareCctvImageForEvent(
    env,
    accidentEvent(),
    {},
    { decodeJpeg: slowDecodeJpeg, encodeJpeg: REAL_encodeJpeg },
    2000
  );
  const elapsed = Date.now() - started;

  // With 4 successful frames and serial per-cell decode (900ms each),
  // decode alone costs ~3600ms — well past a 2000ms budget. This proves
  // compose time is charged against the SAME prepare-timeout clock as
  // frame-fetch, not a separately-budgeted stage.
  assert.equal(result.reason, 'prepare-timeout', 'a slow COMPOSE step alone is enough to exhaust the shared budget');
  assert.ok(elapsed < 2400, `caller released near the 2000ms budget despite slow decode, took ${elapsed}ms`);
});

// =======================================================================
// F. collage fast, R2 PUT artificially slow -> is R2 inside the budget?
// =======================================================================

test('F. collage fast but R2 PUT is slow (3000ms) -> confirms whether R2 publish time is inside the 4000ms budget', async () => {
  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const env = {
    TRAFFIC_KV: kv({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) }),
    CCTV_IMAGES: r2Bucket({ putDelayMs: 3000 }),
  };
  const { fetchFn } = makeControllableFrameFetch({ frameJpeg });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const started = Date.now();
  const result = await prepareCctvImageForEvent(
    env,
    accidentEvent(),
    {},
    { decodeJpeg: REAL_decodeJpeg, encodeJpeg: REAL_encodeJpeg },
    1200
  );
  const elapsed = Date.now() - started;

  // Frames + compose are fast (well under 1200ms); if R2's 3000ms PUT
  // were OUTSIDE the budget, this would succeed. It does not — R2 is
  // inside the same clock.
  assert.equal(result.reason, 'prepare-timeout', 'R2 PUT time is charged against the same 4000ms budget scope');
  assert.ok(elapsed < 1500, `caller released near the 1200ms budget despite slow R2, took ${elapsed}ms`);
});

// =======================================================================
// G. Pipeline Trace carries the new fields as numbers only — never a
//    stream URL, candidate record, or frame byte (same discipline as
//    the single path's own C1 test in cctvPrepareTimeoutStages.test.js)
// =======================================================================

test('G. Pipeline Trace records the quad path\'s new stage fields as plain numbers, never raw CCTV data', async () => {
  const { runLineBroadcast } = await import('../src/traffic/broadcastPipeline.js');
  const { setUserEnabled } = await import('../src/traffic/subscriptions.js');

  const frameJpeg = await makeSolidJpeg(80, 60, [10, 10, 10]);
  const kv = kv_({ [FREEWAY_METADATA_KEY]: metadataEnvelope(QUAD_RECORDS) });
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));

  const { fetchFn } = makeControllableFrameFetch({ frameJpeg });
  priorFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (String(url).includes('api.line.me')) return Promise.resolve(new Response('{}', { status: 200 }));
    return fetchFn(url, init);
  };

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now: new Date('2026-08-26T09:20:00+08:00'),
    cctvCodecOverride: { decodeJpeg: REAL_decodeJpeg, encodeJpeg: REAL_encodeJpeg },
  });

  const trace = result.pipelineTraceEntries[0];
  const serialized = JSON.stringify(trace);
  assert.equal(serialized.includes('freeway.gov.tw'), false);
  assert.equal(serialized.includes('videoStreamUrl'), false);
  assert.equal(serialized.includes('VideoStreamURL'), false);
  assert.equal(typeof trace.enrichment.metadataElapsedMs, 'number');
  assert.equal(typeof trace.enrichment.cameraSelectionElapsedMs, 'number');
  assert.equal(typeof trace.enrichment.frameFetchElapsedMs, 'number');
  assert.equal(typeof trace.enrichment.collageElapsedMs, 'number');
  assert.equal(trace.enrichment.successfulFrameCount, 4);
  assert.equal(trace.enrichment.failedFrameCount, 0);
  assert.equal(typeof trace.enrichment.r2PublishElapsedMs, 'number');
  assert.equal(trace.enrichment.timeoutStage, null); // never set on a success path
});

// Local alias — this file's own `kv()` helper already exists above; kept
// as a separate name here only to avoid a hoisting readability trip-up
// for a reader skimming just this last test.
function kv_(initial) {
  return kv(initial);
}
