// V1.8.6.7 — Pipeline Trace, end-to-end through the real pipeline
// (runLineBroadcast / runScheduledTdxSync), exercising the scenarios that
// need the REAL classification/eligibility/dedupe/gating/CCTV/LINE/Shared
// Feed machinery, not just buildTraceEntry called with hand-set inputs
// (see test/pipelineTrace.test.js for those — pure schema/anomaly/KV/
// admin-endpoint coverage).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';
// V1.9.2 — the real Cron path (scheduled.js) now writes via
// persistPipelineTraceBatch (one 'debug:pipeline-trace-batch:v2:...' key
// per round, see pipelineTrace.js), not one 'debug:pipeline-trace:v1:...'
// key per entry. listPipelineTrace already reads and merges BOTH schemas
// — using it here (instead of hand-scanning a hardcoded key prefix) is
// what makes these tests correct against either write path, matching how
// every real reader (the admin JSON/HTML endpoints) actually reads.
import { listPipelineTrace, TRACE_BATCH_KEY_PREFIX } from '../src/traffic/pipelineTrace.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };
const NOW = new Date('2026-08-20T20:20:00+08:00');
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
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
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

const CCTV_RECORDS = [
  { CCTVID: 'CCTV-N1-S-92.550-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '92K+550', VideoStreamURL: 'https://cctv1.freeway.gov.tw/a.jpg' },
  { CCTVID: 'CCTV-N1-S-94.090-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S', LocationMile: '94K+090', VideoStreamURL: 'https://cctv1.freeway.gov.tw/b.jpg' },
  { CCTVID: 'CCTV-N1-N-92.990-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'N', LocationMile: '92K+990', VideoStreamURL: 'https://cctv1.freeway.gov.tw/c.jpg' },
  { CCTVID: 'CCTV-N1-N-94.800-M', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'N', LocationMile: '94K+800', VideoStreamURL: 'https://cctv1.freeway.gov.tw/d.jpg' },
];

function metadataEnvelope(records = CCTV_RECORDS) {
  return JSON.stringify({ records, fetchedAt: NOW.toISOString() });
}

function freewayAccidentRaw(overrides = {}) {
  return {
    EventID: 'A1', EventType: '事故', EventSubType: '一般事故',
    Description: '北向93.5K處發生車輛事故，外側車道封閉',
    EffectiveTime: '2026-08-20T20:13:00+08:00', LastUpdateTime: '2026-08-20T20:13:48+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '93K+500', EndKM: '93K+000' } },
    Impact: { BlockedLanes: 1 },
    ...overrides,
  };
}

async function envWithSubscriber(extra) {
  const TRAFFIC_KV = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope(), ...(extra || {}) });
  await setUserEnabled(TRAFFIC_KV, 'U1', true, ENROLLED_AT);
  const bucket = r2Bucket();
  return { env: { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV, CCTV_IMAGES: bucket }, kv: TRAFFIC_KV, bucket };
}

function findTrace(result, rawId) {
  return result.pipelineTraceEntries.find((e) => e.identity.rawId === rawId);
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// --- 1: successful LINE broadcast trace ---------------------------------

test('1: successful LINE broadcast -> trace status line-sent, formattedOutput matches the real push', async () => {
  const { env } = await envWithSubscriber();
  priorFetch = globalThis.fetch;
  const pushed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      pushed.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  const trace = findTrace(result, 'A1');
  assert.equal(trace.status, 'line-sent');
  assert.equal(trace.delivery.lineAttempted, 1);
  assert.equal(trace.delivery.lineSucceeded, 1);
  assert.equal(trace.delivery.formattedOutput, pushed[0].messages[0].text);
});

// --- 2: eligibility reject trace -----------------------------------------

test('2: a congestion event (never broadcast-eligible) -> trace status ineligible, eligibilityReason recorded', async () => {
  const { env } = await envWithSubscriber();
  const event = normalizeRoadEvent(freewayAccidentRaw({ EventID: 'A2', EventType: '壅塞', EventSubType: undefined, Description: '北向93K車多回堵' }), 'freeway');
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW });

  const trace = findTrace(result, 'A2');
  assert.equal(trace.decision.eligibility, false);
  assert.equal(trace.status, 'ineligible');
  assert.ok(trace.decision.eligibilityReason);
});

// --- 3: dedupe trace (via scheduled.js's own duplicate handling) --------

test('3: a TDX duplicate (unchanged content) -> a standalone trace entry with dedupeResult "duplicate"', async () => {
  const { env } = await envWithSubscriber();
  env.TDX_CLIENT_ID = 'id';
  env.TDX_CLIENT_SECRET = 'secret';
  const raw = freewayAccidentRaw();
  priorFetch = globalThis.fetch;
  const tdxFetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) return new Response(JSON.stringify({ RoadEvents: [raw] }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Highway')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  globalThis.fetch = tdxFetch;

  // Tick 1 (fresh KV) seeds the dedupe baseline — dedupe.js classifies it
  // as baselineSeedEvents, not "new" (see classifyEvents), but the event
  // still genuinely broadcasts: mergeForBroadcast feeds runLineBroadcast
  // ALL of summary.allEvents regardless of dedupe status, and the real
  // "already pushed" gate is notified.js's own per-target check, which
  // (correctly) has no record yet either. Tick 2, same unchanged content,
  // is where dedupe.js's own classification first has something to
  // compare against — THIS is the actual duplicate this test targets.
  await runScheduledTdxSync(env, NOW);

  // +20min (not +10min): TDX is only fetched on a minute%20===0 tick (see
  // tdxSchedule.js) — NOW is :20, so the next TDX-scheduled tick is :40,
  // not :30. A +10min tick would skip TDX entirely and never reclassify
  // anything.
  const second = await runScheduledTdxSync(env, new Date(NOW.getTime() + 20 * 60_000));
  assert.equal(second.duplicateCount, 1);

  const { records } = await listPipelineTrace(env.TRAFFIC_KV, { limit: 100 });
  const duplicateTrace = records.find((r) => r.identity.rawId === 'A1' && r.decision.dedupeResult === 'duplicate');
  assert.ok(duplicateTrace, 'a duplicate-tick trace entry must exist');
  assert.equal(duplicateTrace.status, 'duplicate');
});

// --- 4: suppression trace -------------------------------------------------

test('4: an already-notified accident with no material change -> suppressionResult recorded, status suppressed', async () => {
  const { env } = await envWithSubscriber({
    'line:incident-suppression-state': JSON.stringify({
      incidents: { '國道一號|北向': [{ notificationKey: 'freeway:A1', km: 93.25, lastSeenAt: NOW.toISOString(), escalation: { type: 'accident', blockedLanes: 1, closureSignal: false } }] },
      updatedAt: NOW.toISOString(),
    }),
  });
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW });

  const trace = findTrace(result, 'A1');
  assert.equal(trace.decision.suppressionResult, 'same-incident-no-escalation');
  assert.equal(trace.status, 'suppressed');
  assert.equal(trace.delivery.lineAttempted, 0);
});

// --- 5: gating trace (V57.2 PBS freeway gate) ----------------------------

test('5: an unmatched 國道 PBS event -> standalone trace entry with gatingResult gated-freeway-no-tdx-match, status gated', async () => {
  const { env } = await envWithSubscriber();
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = {
    fetch: async () => new Response(JSON.stringify([{
      UID: 'PBS-1', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '事故',
      comment: '北向93公里處發生車輛事故', happendate: '2026-08-20', happentime: '20:10:00', modDttm: '2026-08-20 20:11:00',
    }]), { status: 200 }),
  };
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  // V1.9.3: PBS now only fetches on a 30-minute mark (see pbsSchedule.js)
  // — this test is specifically about a PBS-only tick, so it must land on
  // one; NOW itself (20:20) is not (this file's other tests pin NOW to a
  // TDX-scheduled minute instead, which need not also be a PBS one).
  const pbsScheduledNow = new Date(NOW.getTime() - 20 * 60_000); // 20:00 — divisible by both 20 and 30
  const result = await runScheduledTdxSync(env, pbsScheduledNow); // no TDX_CLIENT_ID -> TDX sits out, PBS-only tick
  assert.equal(result.pbs.freewayGatedCount, 1);

  const { records } = await listPipelineTrace(env.TRAFFIC_KV, { limit: 100 });
  const gatedTrace = records.find((r) => r.identity.rawId === 'PBS-1');
  assert.ok(gatedTrace);
  assert.equal(gatedTrace.decision.gatingResult, 'gated-freeway-no-tdx-match');
  assert.equal(gatedTrace.status, 'gated');
});

// --- 6: no subscriber trace -----------------------------------------------

test('6: no enrolled subscriber -> trace still built, lineAttempted 0 (0 targets, not a failure)', async () => {
  const TRAFFIC_KV = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope() });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV, CCTV_IMAGES: r2Bucket() };
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW });

  const trace = findTrace(result, 'A1');
  assert.equal(trace.decision.eligibility, true);
  assert.equal(trace.delivery.lineAttempted, 0);
  assert.equal(trace.status, 'eligible-no-target');
});

// --- 7: CCTV not eligible trace -------------------------------------------

test('7: a PBS-sourced accident (never CCTV-eligible) -> cctvEligible:false in the trace', async () => {
  const { env } = await envWithSubscriber();
  const event = {
    source: 'pbs', rawId: 'PBS-2', type: 'accident', road: '國道一號', direction: '北向',
    description: '事故', updatedAt: NOW.toISOString(), startTime: NOW.toISOString(),
    pipelineTraceUpstream: { EventType: '事故', EventSubType: null, Category: null, descriptionSummary: '事故', rawDirection: '北向', rawStartKM: null, rawEndKM: null, upstreamUpdatedAt: NOW.toISOString() },
  };
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW });

  const trace = findTrace(result, 'PBS-2');
  assert.equal(trace.enrichment.cctvEligible, false);
});

// --- 8: CCTV no camera trace ----------------------------------------------

test('8: CCTV-eligible but no camera near this KM -> imagePrepared:false, cctvSkippedByReason "no-camera"', async () => {
  // A usable pool holding only a 國3 camera, while the event is on 國道一號.
  // Seeding [] no longer produces this condition: CCTV_METADATA_RECOVERY_V1
  // treats an empty record set as unusable and falls back to the bundled
  // official inventory, so "no cameras at all" is no longer reachable.
  const { env } = await envWithSubscriber({
    [FREEWAY_METADATA_KEY]: metadataEnvelope([
      { CCTVID: 'CCTV-N3-S-096.700-M', RoadID: '000030', RoadName: '國道3號', RoadDirection: 'S', LocationMile: '96K+700', VideoStreamURL: 'https://cctv3.freeway.gov.tw/n3.jpg' },
    ]),
  });
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  const trace = findTrace(result, 'A1');
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.enrichment.imagePrepared, false);
  assert.equal(trace.enrichment.cctvSkippedByReason, 'no-camera');
});

// --- 9: CCTV image success trace ------------------------------------------

test('9: CCTV composes and publishes successfully -> imagePrepared/imageUrlPresent true, imageExpiresAt recorded', async () => {
  const { env, bucket } = await envWithSubscriber();
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  priorFetch = globalThis.fetch;
  const jpeg = await makeSolidJpeg(64, 64, [90, 90, 90]);
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    if (href.includes('freeway.gov.tw')) return new Response(jpeg, { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });

  const trace = findTrace(result, 'A1');
  assert.equal(trace.enrichment.imagePrepared, true);
  assert.equal(trace.enrichment.imageUrlPresent, true);
  assert.ok(trace.enrichment.imageExpiresAt);
  assert.equal(bucket.putCalls, 1);
});

// --- 10: LINE failure trace ------------------------------------------------

test('10: LINE push fails for the only target -> status line-failed', async () => {
  const { env } = await envWithSubscriber();
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{"message":"error"}', { status: 500 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW });

  const trace = findTrace(result, 'A1');
  assert.equal(trace.delivery.lineAttempted, 1);
  assert.equal(trace.delivery.lineSucceeded, 0);
  assert.equal(trace.status, 'line-failed');
});

// --- 11: Shared Feed with image trace (patched after Shared Feed persist) -

test('11: a full Cron run patches sharedFeedPersisted/sharedFeedWithImage from the ACTUAL persisted feed', async () => {
  // Pre-seed a STILL-VALID stored image for this exact event/fingerprint
  // (same carry-forward mechanism sharedFeedCctvTopUp.test.js's own tests
  // 2/8 use) — this run then needs 0 real CCTV compose (0 codec
  // dependency, which runScheduledTdxSync has no test-only override for
  // at all — see productionIntegrationFixtures.test.js's own comment on
  // why that file calls runLineBroadcast directly instead), so this test
  // can go through the REAL scheduled.js entry point end-to-end and still
  // deterministically end up with an image in the Shared Feed.
  const { eventIdOf, fingerprintOf, SHARED_FEED_KEY } = await import('../src/traffic/sharedFeed.js');
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  const stored = {
    eventId: eventIdOf(event),
    fingerprint: await fingerprintOf(event),
    text: 'previous text',
    imageUrl: 'https://traffic-reporter.mr-happytan.workers.dev/cctv/image/deadbeef',
    imageExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    road: '國道一號',
    type: 'accident',
    direction: '北向',
  };
  const { env } = await envWithSubscriber({
    [SHARED_FEED_KEY]: JSON.stringify({ schemaVersion: 1, events: [stored], updatedAt: NOW.toISOString() }),
  });
  env.TDX_CLIENT_ID = 'id';
  env.TDX_CLIENT_SECRET = 'secret';
  const raw = freewayAccidentRaw();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) return new Response(JSON.stringify({ RoadEvents: [raw] }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Highway')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch (must not need a real CCTV frame fetch — the image is carried forward): ${href}`);
  };

  await runScheduledTdxSync(env, NOW);

  const { records } = await listPipelineTrace(env.TRAFFIC_KV, { limit: 100 });
  const trace = records.find((r) => r.identity.rawId === 'A1' && r.status === 'line-sent');
  assert.ok(trace, 'a line-sent trace entry for this event must exist');
  assert.equal(trace.delivery.sharedFeedPersisted, true);
  assert.equal(trace.delivery.sharedFeedWithImage, true);
});

// --- 25: trace KV failure never affects the real broadcast ---------------

test('25: pipeline trace KV write failure never affects the real LINE push outcome', async () => {
  const { env } = await envWithSubscriber();
  const originalPut = env.TRAFFIC_KV.put.bind(env.TRAFFIC_KV);
  env.TRAFFIC_KV.put = async (key, value, options) => {
    if (key.startsWith(TRACE_BATCH_KEY_PREFIX)) throw new Error('trace KV outage');
    return originalPut(key, value, options);
  };
  env.TDX_CLIENT_ID = 'id';
  env.TDX_CLIENT_SECRET = 'secret';
  const raw = freewayAccidentRaw();
  priorFetch = globalThis.fetch;
  const pushed = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) return new Response(JSON.stringify({ RoadEvents: [raw] }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Highway')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    if (href.includes('api.line.me')) {
      pushed.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await runScheduledTdxSync(env, NOW);
  assert.equal(pushed.length, 1, 'the real LINE push must still succeed despite the trace KV outage');
  assert.equal(result.line.pushSucceeded, 1);
  assert.equal(result.pipelineTrace.failed > 0, true, 'the trace write failure IS visible in its own summary, just isolated');
});

// --- 26: 0 additional TDX/PBS/CCTV/LINE calls ------------------------------

test('26: recording/reading pipeline trace makes 0 additional TDX/PBS/CCTV/LINE calls beyond what the real push already made', async () => {
  const { env } = await envWithSubscriber();
  const event = normalizeRoadEvent(freewayAccidentRaw(), 'freeway');
  priorFetch = globalThis.fetch;
  let lineCalls = 0;
  const jpeg = await makeSolidJpeg(64, 64, [90, 90, 90]);
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      lineCalls += 1;
      return new Response('{}', { status: 200 });
    }
    if (href.includes('freeway.gov.tw')) return new Response(jpeg, { status: 200 });
    throw new Error(`the trace path must never call TDX/PBS: ${href}`);
  };
  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now: NOW, cctvCodecOverride: TEST_CODEC });
  assert.equal(lineCalls, 1, 'exactly one LINE call — building/writing the trace added zero more');
  assert.ok(result.pipelineTraceEntries.length >= 1);
});
