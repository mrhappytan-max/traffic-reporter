// V1.8.5 — end-to-end: runLineBroadcast's dynamic CCTV image enrichment
// (src/cctv/dynamicCollage.js) wired into the real LINE push loop
// (src/traffic/broadcastPipeline.js). Exercises the REAL Worker pipeline
// (not just dynamicCollage.js in isolation — see test/dynamicCollage.test.js
// for that) with every fetch (LINE push + freeway.gov.tw frames) mocked,
// and the real JPEG codec via test/testJpegCodec.js's Node-compatible
// codec override (cctvCodecOverride — see broadcastPipeline.js's doc
// comment).
//
// CORRECTION (post-review, two Production blockers fixed):
//   1. The broadcast path is now CACHE-ONLY for CCTV metadata — it must
//      NEVER call TDX. Every fixture below seeds (or deliberately omits)
//      cctv:freeway-metadata:v1 in KV directly instead of relying on a
//      mocked TDX response; the shared fetch mock (makeFullMock) doesn't
//      even recognize a TDX URL any more — any accidental TDX call in
//      this file throws immediately, an implicit "0 TDX calls" proof for
//      every single test here.
//   2. CCTV enrichment now runs under a hard time budget
//      (cctvPrepareBudgetMs, threaded through runLineBroadcast for
//      tests) — see the new timeout tests (5/6/7 below).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled, setGroupEnabled } from '../src/traffic/subscriptions.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');

function metadataEnvelope(records) {
  return JSON.stringify({ records, fetchedAt: new Date().toISOString() });
}

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

// V2.4.5 — carries a real coordinate, confirmed this round inside 新竹市
// by the official NLSC polygon (see tdx/hsinchuGeoResolver.js), so this
// fixture still represents what it always meant to (a genuine Hsinchu
// TDX accident) under the new coordinate-backed service-area gate.
function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '82K附近',
    description: '事故',
    startKM: '82K+000',
    endKM: '82K+200',
    startTime: '2026-08-15T07:30:00+08:00',
    endTime: null,
    updatedAt: '2026-08-15T07:30:00+08:00',
    longitude: 120.9686,
    latitude: 24.8066,
    ...overrides,
  };
}

function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'S',
    LocationMile: '82K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/default.jpg',
    ...overrides,
  };
}
const CCTV_RECORDS = [
  cctvRecord({ CCTVID: 'CCTV-S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900' }),
  cctvRecord({ CCTVID: 'CCTV-S-AFTER', RoadDirection: 'S', LocationMile: '82K+300' }),
  cctvRecord({ CCTVID: 'CCTV-N-AFTER', RoadDirection: 'N', LocationMile: '82K+400' }),
];

/** env with the shared CCTV metadata cache pre-seeded (as if an Admin had already run /admin/cctv-hsinchu-probe recently). */
function envWithCctvCache(overrides = {}) {
  return {
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    TRAFFIC_KV: createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) }),
    CCTV_IMAGES: r2Bucket(),
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

/**
 * Combined mock: LINE push URL + freeway.gov.tw frames ONLY. This
 * module's broadcast path must NEVER call TDX (cache-only metadata) —
 * so unlike earlier rounds' mock, there is deliberately no
 * openid-connect/token or /Road/Traffic/CCTV/Freeway handling here at
 * all; any such call throws, which is itself the "0 TDX calls" proof
 * for every test in this file.
 */
function makeFullMock({ frameJpeg, linePushStatus = 200 } = {}) {
  const pushCalls = [];
  const hits = { frame: 0 };
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushCalls.push({ url: href, body: JSON.parse(init.body) });
      return new Response(linePushStatus === 200 ? '{}' : 'server error', { status: linePushStatus });
    }
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      if (!frameJpeg) return new Response('not found', { status: 404 });
      return new Response(frameJpeg, { status: 200 });
    }
    throw new Error(`unexpected fetch in test (must never call TDX from the broadcast path): ${href}`);
  };
  return { fetchFn, pushCalls, hits };
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// --- 10/11/12/13: successful CCTV -> exactly 2 messages, text first, image second, urls match, https ---

test('10/11/12/13: a successful CCTV compose sends exactly 2 messages (text then image), originalContentUrl===previewImageUrl, both HTTPS', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn, pushCalls } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [10, 20, 30]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 1);
  assert.equal(result.cctvImagesAttachedCount, 1);
  assert.equal(pushCalls.length, 1);
  const messages = pushCalls[0].body.messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[1].type, 'image');
  assert.equal(messages[1].originalContentUrl, messages[1].previewImageUrl);
  assert.match(messages[1].originalContentUrl, /^https:\/\//);
});

// --- 14: text-only path (ineligible event) still exactly 1 message ---

test('14: a CCTV-ineligible accident (no KM) still sends exactly 1 (text-only) message', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn, pushCalls } = makeFullMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ startKM: undefined, endKM: undefined })],
    dedupeAvailable: true,
    now,
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 1);
  assert.equal(result.cctvImagesAttachedCount, 0);
  assert.equal(pushCalls[0].body.messages.length, 1);
  assert.equal(pushCalls[0].body.messages[0].type, 'text');
});

// --- 15: multiple targets, same event -> compose once, R2 put once ---

test('15: the same event with multiple LINE targets composes/publishes the CCTV image exactly ONCE and shares one imageUrl', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'U2', true, ENROLLED_AT);
  await setGroupEnabled(kv, 'G1', true, ENROLLED_AT);
  const bucket = r2Bucket();
  const env = envWithCctvCache({ TRAFFIC_KV: kv, CCTV_IMAGES: bucket });
  const { fetchFn, pushCalls } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [5, 6, 7]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 3);
  assert.equal(bucket.putCalls, 1, 'expected exactly 1 R2 publish for 3 targets of the same event');
  assert.equal(pushCalls.length, 3);
  const imageUrls = pushCalls.map((c) => c.body.messages[1].originalContentUrl);
  assert.equal(new Set(imageUrls).size, 1, 'all 3 targets must share the exact same imageUrl');
});

// --- 16/17: partial failure semantics preserved; a failed target isn't marked notified ---

test('16/17: LINE text+image request failing (500) for one target -> that target NOT marked notified, other targets unaffected', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await setUserEnabled(kv, 'U2', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });

  let callCount = 0;
  const { fetchFn: baseFetch } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [1, 1, 1]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      callCount += 1;
      if (callCount === 1) return new Response('server error', { status: 500 }); // U1's push fails
      return baseFetch(url, init); // U2's push succeeds
    }
    return baseFetch(url, init);
  };

  const now = new Date('2026-08-15T09:00:00+08:00');
  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushAttempted, 2);
  assert.equal(result.pushSucceeded, 1);
  assert.equal(result.partialPushFailures, 1);
  assert.match(result.lineErrors.join(' '), /500/);

  // Inspect notified-state directly: the failed target (U1) must NEVER
  // be recorded as notified; the succeeded target (U2) must be. (Not
  // re-run through a second full runLineBroadcast tick here — for
  // type==='accident' events, V1.5.1's incident-suppression layer
  // independently decides "same real incident, no material change ->
  // suppressed" on the NEXT tick regardless of any single target's own
  // per-target retry state, which is pre-existing V1.5.1 behavior this
  // round must not touch/re-litigate — see broadcastPipeline.js's
  // accidentRelevant branch. This assertion instead directly confirms
  // the thing V1.8.5 actually changed: per-target notified-state
  // tracking through the new pushLineMessages() call path is unaffected
  // by carrying an image.)
  const { readNotifiedState } = await import('../src/traffic/notified.js');
  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  const eventKeyStr = 'freeway:FRW-1';
  const targets = notifiedState.notifiedMap[eventKeyStr]?.targets || {};
  assert.ok(!targets['user:U1'], 'the failed target (U1) must not be marked notified');
  assert.ok(targets['user:U2'], 'the succeeded target (U2) must be marked notified');
});

// --- 18: no same-round fallback re-send of text-only after a text+image failure ---

test('18: a failed text+image push is NEVER followed by a same-round fallback text-only resend (exactly 1 LINE call per target, always)', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn: baseFetch } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [2, 2, 2]) });
  let lineCallCount = 0;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      lineCallCount += 1;
      return new Response('server error', { status: 500 });
    }
    return baseFetch(url, init);
  };

  const now = new Date('2026-08-15T09:00:00+08:00');
  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.pushSucceeded, 0);
  assert.equal(lineCallCount, 1, 'exactly one LINE call attempted for the one pending target — no second fallback call this same round');
});

// --- 19/20: incident suppression / material escalation interplay with CCTV ---

test('19: incident suppression — the next tick with no material change does not push again, so no new CCTV image is generated either', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [3, 3, 3]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const t0 = new Date('2026-08-15T09:00:00+08:00');
  const first = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now: t0, cctvCodecOverride: TEST_CODEC });
  assert.equal(first.pushSucceeded, 1);
  assert.equal(first.cctvImagesAttachedCount, 1);

  // Next tick, 5 minutes later, same event content (no escalation) — same
  // real incident, slightly different rawId even (as if TDX reissued it).
  const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
  const second = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ rawId: 'FRW-1-REISSUED' })],
    dedupeAvailable: true,
    now: t1,
    cctvCodecOverride: TEST_CODEC,
  });
  assert.equal(second.pushSucceeded, 0);
  assert.equal(second.cctvImagesAttachedCount, 0);
});

test('20: material escalation DOES allow a rebroadcast with a freshly-generated CCTV image', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [8, 8, 8]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const t0 = new Date('2026-08-15T09:00:00+08:00');
  const first = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now: t0, cctvCodecOverride: TEST_CODEC });
  assert.equal(first.pushSucceeded, 1);

  // Material escalation: now type escalates to 'closure' — see
  // incidentSuppression.js's isMaterialEscalation (type change is
  // material). getBroadcastEligibility already allows 'closure' through.
  const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
  const escalated = await runLineBroadcast(env, {
    allEvents: [accidentEvent({ rawId: 'FRW-1-ESCALATED', description: '禁止通行' })],
    dedupeAvailable: true,
    now: t1,
    cctvCodecOverride: TEST_CODEC,
  });
  assert.equal(escalated.materialRebroadcastCount, 1);
  assert.equal(escalated.pushSucceeded, 1);
});

// --- 21: image URL never influences the notification fingerprint ---

test('21: the notified-state fingerprint never includes anything CCTV/image-URL-derived (re-running the identical event does not look "new")', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [9, 9, 9]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const t0 = new Date('2026-08-15T09:00:00+08:00');
  const first = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now: t0, cctvCodecOverride: TEST_CODEC });
  assert.equal(first.pushSucceeded, 1);

  // Same exact event (same rawId, same content) again shortly after —
  // even though a NEW CCTV image would get a NEW random opaque id/URL if
  // it were regenerated, the event is unchanged, so this must be fully
  // suppressed by the per-target fingerprint check, proving the
  // (never-changing) event fields — not any image URL — drive it.
  const t1 = new Date(t0.getTime() + 2 * 60 * 1000);
  const second = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now: t1, cctvCodecOverride: TEST_CODEC });
  assert.equal(second.pushSucceeded, 0);
  assert.equal(second.pendingTargetCount, 0);
});

// --- 8/22: dryRun -> 0 TDX CCTV metadata, 0 freeway CCTV fetch, 0 R2 write, 0 LINE ---

test('8/22: dryRun computes cctvEligibleAccidentCount (pure) but performs 0 CCTV metadata fetch, 0 frame fetch, 0 R2 write, 0 LINE push', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const bucket = r2Bucket();
  const env = envWithCctvCache({ TRAFFIC_KV: kv, CCTV_IMAGES: bucket });
  const { fetchFn, pushCalls, hits } = makeFullMock({ frameJpeg: await makeSolidJpeg(80, 60, [11, 11, 11]) });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const result = await runLineBroadcast(env, { allEvents: [accidentEvent()], dedupeAvailable: true, now, dryRun: true, cctvCodecOverride: TEST_CODEC });

  assert.equal(result.cctvEligibleAccidentCount, 1, 'the pure eligibility count must still be populated under dryRun');
  assert.equal(hits.frame, 0);
  assert.equal(bucket.putCalls, 0);
  assert.equal(pushCalls.length, 0);
  assert.equal(result.cctvImagesAttachedCount, 0);
});

// =======================================================================
// 5/6/7: hard time budget, end-to-end through runLineBroadcast
// =======================================================================

/** A frame fetch mock that hangs like a real stuck connection — only reacts to the AbortSignal extractFirstJpegFrame passes in, matching real `fetch` behavior under AbortSignal.timeout. */
function makeHungFrameAndLineMock() {
  const pushCalls = [];
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushCalls.push({ url: href, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }
    if (href.includes('freeway.gov.tw')) {
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { fetchFn, pushCalls };
}

test('5/6/7: CCTV prepare exceeding its budget -> text-only, LINE text still succeeds, notified normally, exactly 1 LINE call (no second fallback)', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn, pushCalls } = makeHungFrameAndLineMock();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const smallBudgetMs = 80; // tiny budget so the test stays fast/deterministic
  const started = Date.now();
  const result = await runLineBroadcast(env, {
    allEvents: [accidentEvent()],
    dedupeAvailable: true,
    now,
    cctvCodecOverride: TEST_CODEC,
    cctvPrepareBudgetMs: smallBudgetMs,
  });
  const elapsed = Date.now() - started;

  // 5. exceeded budget -> text-only.
  assert.equal(result.cctvImagesAttachedCount, 0);
  assert.equal(result.cctvSkippedByReason['prepare-timeout'], 1);
  assert.ok(elapsed < smallBudgetMs + 1000, `expected the whole broadcast to proceed near the ${smallBudgetMs}ms budget, took ${elapsed}ms`);

  // 6. LINE text still succeeds, notified normally.
  assert.equal(result.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].body.messages.length, 1);
  assert.equal(pushCalls[0].body.messages[0].type, 'text');
  const { readNotifiedState } = await import('../src/traffic/notified.js');
  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  assert.ok(notifiedState.notifiedMap['freeway:FRW-1']?.targets?.['user:U1'], 'the target must be marked notified from the successful text-only push');

  // 7. no second LINE request.
  assert.equal(pushCalls.length, 1, 'exactly 1 LINE request — no second request after the CCTV timeout');

  // Let the abandoned background frame fetch settle before the test ends
  // (see dynamicCollage.test.js's equivalent note).
  await new Promise((resolve) => setTimeout(resolve, 400));
});

// =======================================================================
// CORRECTION (post-review): the budget above is per-EVENT, not
// automatically per-RUN — broadcastPipeline.js's loop is sequential, so
// N eligible accidents each getting their own fresh budget could
// accumulate to N*budget of delay before the last event's text is even
// considered. These tests cover the fix: ONE shared deadline for the
// whole run.
// =======================================================================

/** A frame fetch mock that hangs (only reacts to the AbortSignal) + counts how many distinct frame-fetch attempts were made, for verifying event 2/3 never even tried. */
function makeHungFrameAndLineMockWithCounter() {
  const pushCalls = [];
  let frameAttempts = 0;
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushCalls.push({ url: href, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }
    if (href.includes('freeway.gov.tw')) {
      frameAttempts += 1;
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { fetchFn, pushCalls, frameAttemptsRef: () => frameAttempts };
}

test('1: 3 eligible accidents whose CCTV work never completes share ONE run-wide budget (~one budget total, not 3x) — all 3 end text-only, all 3 LINE texts succeed, notified-state normal', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = envWithCctvCache({ TRAFFIC_KV: kv });
  const { fetchFn, pushCalls } = makeHungFrameAndLineMockWithCounter();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const runBudgetMs = 60; // small so the test stays fast; shared across all 3 events
  const started = Date.now();
  const result = await runLineBroadcast(env, {
    allEvents: [
      // Distinct, well-separated KM (>1.5km apart — see
      // incidentSuppression.js's INCIDENT_MAX_KM_DIFF) so V1.5.1's
      // incident-level suppression treats these as 3 DIFFERENT real
      // incidents, not 3 sightings of the same one (which would
      // suppress B/C entirely before they ever reach the CCTV/push
      // loop this test is exercising).
      accidentEvent({ rawId: 'FRW-A', startKM: '82K+000', endKM: '82K+200' }),
      accidentEvent({ rawId: 'FRW-B', startKM: '95K+000', endKM: '95K+200' }),
      accidentEvent({ rawId: 'FRW-C', startKM: '108K+000', endKM: '108K+200' }),
    ],
    dedupeAvailable: true,
    now,
    cctvCodecOverride: TEST_CODEC,
    cctvPrepareBudgetMs: runBudgetMs,
  });
  const elapsed = Date.now() - started;

  // NOT 3x the budget — proves the budget is shared across the whole
  // run, not reset fresh for each event. A generous ceiling (well under
  // what 3 independent budgets, even this small, plus per-event
  // overhead would need) without being a flaky exact-ms assertion.
  assert.ok(elapsed < runBudgetMs * 2 + 600, `expected ~1 run budget total, not 3x — took ${elapsed}ms for a ${runBudgetMs}ms budget`);

  // All 3 accidents end up text-only.
  assert.equal(result.cctvImagesAttachedCount, 0);
  const skippedTotal = Object.values(result.cctvSkippedByReason).reduce((a, b) => a + b, 0);
  assert.equal(skippedTotal, 3);
  // At least one event actually attempted CCTV and hit the timeout, and
  // at least one was skipped WITHOUT even attempting (the run budget was
  // already gone by the time its turn came) — this is what proves the
  // budget is genuinely shared/exhausted, not just individually applied
  // 3 times.
  assert.ok(result.cctvSkippedByReason['prepare-timeout'] >= 1, 'expected at least one real timeout');
  assert.ok(
    result.cctvSkippedByReason['run-budget-exhausted'] >= 1,
    'expected at least one event to be skipped with 0 remaining run budget, never even attempting CCTV'
  );

  // All 3 LINE texts still succeed, independent of the shared CCTV budget.
  assert.equal(result.pushSucceeded, 3);
  assert.equal(pushCalls.length, 3);
  for (const call of pushCalls) {
    assert.equal(call.body.messages.length, 1);
    assert.equal(call.body.messages[0].type, 'text');
  }

  // Notified-state normal for all 3.
  const { readNotifiedState } = await import('../src/traffic/notified.js');
  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  for (const rawId of ['FRW-A', 'FRW-B', 'FRW-C']) {
    assert.ok(notifiedState.notifiedMap[`freeway:${rawId}`]?.targets?.['user:U1'], `${rawId} must be marked notified`);
  }

  // Let any still-running background frame fetch(es) settle.
  await new Promise((resolve) => setTimeout(resolve, 400));
});

test('2: the first event exhausting the run budget makes the second event skip CCTV entirely — run-budget-exhausted, 0 additional frame fetch, 0 R2 put for it', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(CCTV_RECORDS) });
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const bucket = r2Bucket();
  const env = envWithCctvCache({ TRAFFIC_KV: kv, CCTV_IMAGES: bucket });
  const { fetchFn, frameAttemptsRef } = makeHungFrameAndLineMockWithCounter();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const now = new Date('2026-08-15T09:00:00+08:00');
  const runBudgetMs = 50;
  const result = await runLineBroadcast(env, {
    allEvents: [
      accidentEvent({ rawId: 'FRW-A', startKM: '82K+000', endKM: '82K+200' }),
      accidentEvent({ rawId: 'FRW-B', startKM: '95K+000', endKM: '95K+200' }),
    ],
    dedupeAvailable: true,
    now,
    cctvCodecOverride: TEST_CODEC,
    cctvPrepareBudgetMs: runBudgetMs,
  });

  // Event A: actually attempted CCTV (consumed the run's whole budget on
  // a hung frame fetch) -> prepare-timeout.
  assert.equal(result.cctvSkippedByReason['prepare-timeout'], 1);
  // Event B: 0 remaining run budget by the time its turn came -> skipped
  // WITHOUT ever calling prepareCctvImageForEvent at all.
  assert.equal(result.cctvSkippedByReason['run-budget-exhausted'], 1);

  // The only frame-fetch attempts came from event A (up to 4 candidate
  // slots); event B triggered ZERO additional attempts.
  const framesFromEventA = frameAttemptsRef();
  assert.ok(framesFromEventA > 0 && framesFromEventA <= 4, `expected 1-4 frame attempts from event A only, got ${framesFromEventA}`);

  // 0 R2 put at all — event A's frame fetch never even completed
  // (hung), so it never reached compose/publish; event B never tried.
  assert.equal(bucket.putCalls, 0);

  await new Promise((resolve) => setTimeout(resolve, 400));
});
