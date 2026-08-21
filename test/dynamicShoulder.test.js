// V1.8.7.0 — Dynamic Shoulder Broadcast + Single-CCTV Strategy.
//
// Covers, in order (see this round's own task spec, section 十七
// "targeted tests", items 1-28):
//   §A classification (1,2,3)               — dynamicShoulderClassification.js / tdx/normalize.js
//   §B range resolver (4,5,6,7)              — kmLocationResolver.js's resolveKmRange
//   §C fingerprint/dedupe push behavior (8-12) — dedupe.js / notified.js / broadcastPipeline.js
//   §D single-camera CCTV (13-19)            — hsinchuCctvProbe.js / cctv/dynamicCollage.js
//   §E end-to-end LINE/Shared Feed/Trace (20-22) — broadcastPipeline.js
//   §F regression (23-27)                    — accident quad, construction, V57.2 gating, broadcast hours
//   §G 0 extra upstream calls (28)
//
// No real TDX/PBS/CCTV/LINE/Google call anywhere in this file — every
// fetch is mocked, KV/R2 are in-memory mocks, same convention as
// dynamicCollage.test.js / broadcastPipeline.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { detectDynamicShoulder, classifyShoulderStateFromText } from '../src/traffic/dynamicShoulderClassification.js';
import { resolveKmRange } from '../src/traffic/kmLocationResolver.js';
import { computeFingerprint } from '../src/traffic/dedupe.js';
import { computeNotificationFingerprint } from '../src/traffic/notified.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { resolveCctvEligibility, prepareCctvImageForEvent, CCTV_PREPARE_BUDGET_MS } from '../src/cctv/dynamicCollage.js';
import { selectSingleShoulderCandidate } from '../src/tdx/hsinchuCctvProbe.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { crossSourceDedup } from '../src/pbs/crossSourceDedup.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

// --- shared fixtures -----------------------------------------------------

// The REAL Production fixture this round's task spec names verbatim
// (section 三). EventType/EventSubType are the raw NUMERIC codes actually
// observed — the whole point of this round's classification design is
// that these numbers carry no meaning on their own; only the Description
// text evidence does (see dynamicShoulderClassification.js).
function shoulderOpenRaw(overrides = {}) {
  return {
    EventID: 'A15040100H-01-20260821094306288100033',
    EventType: 4,
    EventSubType: 498,
    Description: '國道一號 南向 91K+590 特殊管制事件-機動開放路肩事件',
    EffectiveTime: '2026-08-21T09:43:06+08:00',
    LastUpdateTime: '2026-08-21T09:43:06+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '91K+590', EndKM: '93K+320' } },
    ...overrides,
  };
}

// Self-built STOPPED fixture (section 十六 — "自行建立最接近真實 TDX
// schema 的 STOPPED fixture"), same shape/road/KM/EventType, different
// EventSubType-carrying-no-meaning + Description evidence, later
// timestamp — plausible as either a same-rawId update or a fresh record;
// this round's design treats both identically (see dedupe.js's own
// comment on why relying on description-text-alone would be fragile).
function shoulderStoppedRaw(overrides = {}) {
  return {
    EventID: 'A15040100H-01-20260821110000288100034',
    EventType: 4,
    EventSubType: 499,
    Description: '國道一號 南向 91K+590 特殊管制事件-機動路肩停止開放事件',
    EffectiveTime: '2026-08-21T11:00:00+08:00',
    LastUpdateTime: '2026-08-21T11:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '91K+590', EndKM: '93K+320' } },
    ...overrides,
  };
}

// A normal, non-shoulder control event — same EventType=4 bucket, no
// shoulder-open/stop text anywhere — used for item 3 ("其他 control 不
// 誤判").
function ordinaryControlRaw(overrides = {}) {
  return {
    EventID: 'A15040100H-01-20260821120000288100099',
    EventType: 4,
    EventSubType: 401,
    Description: '國道一號 南向 91K+590 車道管制作業',
    EffectiveTime: '2026-08-21T12:00:00+08:00',
    LastUpdateTime: '2026-08-21T12:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '91K+000', EndKM: '91K+500' } },
    ...overrides,
  };
}

// Normalized-event-shaped fixture for dedupe/fingerprint/broadcast tests
// (mirrors this file's own normalizeRoadEvent output, so these tests
// don't need to re-run normalization every time).
function shoulderEvent(state, overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'A15040100H-01-20260821094306288100033',
    type: 'control',
    road: '國道一號',
    direction: '南向',
    startKM: '91K+590',
    endKM: '93K+320',
    description:
      state === 'OPEN'
        ? '國道一號 南向 91K+590 特殊管制事件-機動開放路肩事件'
        : '國道一號 南向 91K+590 特殊管制事件-機動路肩停止開放事件',
    startTime: '2026-08-21T09:43:06+08:00',
    endTime: null,
    updatedAt: '2026-08-21T09:43:06+08:00',
    dynamicShoulder: { state, evidence: { field: 'Description', value: 'x' } },
    ...overrides,
  };
}

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
    startTime: '2026-08-21T09:00:00+08:00',
    endTime: null,
    updatedAt: '2026-08-21T09:00:00+08:00',
    ...overrides,
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
const IN_HOURS_NOW = new Date('2026-08-21T09:50:00+08:00'); // 09:50 Taipei — inside 08:00-22:00

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
      if (failPut) throw new Error('R2 write outage');
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

/** Only ever allows freeway.gov.tw frame fetches — any other URL (TDX, Google, LINE) throws loudly, proving this pipeline never calls them. */
function makeFrameFetch({ frameJpeg } = {}) {
  const hits = { frame: 0, other: 0 };
  const fetchFn = async (url) => {
    const href = String(url);
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      if (!frameJpeg) return new Response('not found', { status: 404 });
      return new Response(frameJpeg, { status: 200 });
    }
    hits.other += 1;
    throw new Error(`unexpected non-freeway.gov.tw fetch in test (this module must never call TDX/Google/LINE directly here): ${href}`);
  };
  return { fetchFn, hits };
}

/** freeway.gov.tw frame fetches AND LINE push calls — for full runLineBroadcast integration tests. Anything else throws. */
function makeFullPipelineFetch({ frameJpeg } = {}) {
  const hits = { frame: 0, line: 0, other: 0 };
  const pushCalls = [];
  const fetchFn = async (url, init) => {
    const href = String(url);
    if (href.includes('freeway.gov.tw')) {
      hits.frame += 1;
      if (!frameJpeg) return new Response('not found', { status: 404 });
      return new Response(frameJpeg, { status: 200 });
    }
    if (href.includes('api.line.me')) {
      hits.line += 1;
      pushCalls.push({ url: href, body: JSON.parse(init.body) });
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

// =======================================================================
// §A — classification (items 1, 2, 3)
// =======================================================================

test('1. real EventSubType 498 fixture classifies as dynamic-shoulder OPEN, never hardcoded off the numeric code alone', () => {
  const event = normalizeRoadEvent(shoulderOpenRaw(), 'freeway');
  assert.deepEqual(event.dynamicShoulder, {
    state: 'OPEN',
    evidence: { field: 'Description', value: '國道一號 南向 91K+590 特殊管制事件-機動開放路肩事件' },
  });
  // `type` itself is untouched by the dynamic-shoulder tag — still
  // resolves via the ordinary keyword classification (管制 -> control).
  assert.equal(event.type, 'control');
  assert.equal(event.direction, '南向');
  assert.equal(event.startKM, '91K+590');
  assert.equal(event.endKM, '93K+320');
  assert.equal(event.rawId, 'A15040100H-01-20260821094306288100033');

  // A bare numeric EventSubType alone must never classify anything — the
  // evidence came from Description text, confirming this isn't secretly
  // keyed off "498".
  const noText = detectDynamicShoulder({ eventType: 4, eventSubType: 498, category: null, description: null });
  assert.equal(noText, null);
});

test('2. STOPPED classification — self-built fixture, same road/KM/EventType, different evidence text', () => {
  const event = normalizeRoadEvent(shoulderStoppedRaw(), 'freeway');
  assert.equal(event.dynamicShoulder.state, 'STOPPED');
  assert.equal(event.dynamicShoulder.evidence.field, 'Description');
  assert.equal(event.type, 'control');

  // Pure pattern-level check too — a STOPPED phrase must never register
  // as OPEN just because it also contains "開放" as a substring.
  assert.equal(classifyShoulderStateFromText('機動路肩停止開放'), 'STOPPED');
  assert.equal(classifyShoulderStateFromText('路肩恢復禁止行駛'), 'STOPPED');
  assert.equal(classifyShoulderStateFromText('機動開放路肩'), 'OPEN');
  assert.equal(classifyShoulderStateFromText('路肩開放'), 'OPEN');
});

test('3. an ordinary control event (施工管制, no shoulder text) is never misjudged as dynamic-shoulder; other control events keep original behavior', () => {
  const event = normalizeRoadEvent(ordinaryControlRaw(), 'freeway');
  assert.equal(event.dynamicShoulder, undefined);
  assert.equal(event.type, 'control'); // unaffected — same as before this round

  // A bare "路肩" mention with no open/stop verb (e.g. 路肩施工/路肩維修)
  // must also fail closed — EventType=4 alone is never enough evidence.
  assert.equal(classifyShoulderStateFromText('路肩施工'), null);
  assert.equal(classifyShoulderStateFromText('路肩維修作業'), null);
  assert.equal(detectDynamicShoulder({ eventType: 4, eventSubType: 401, category: null, description: '國道一號 南向 91K+590 車道管制作業' }), null);
});

// =======================================================================
// §B — range resolver (items 4, 5, 6, 7)
// =======================================================================

test('4. resolveKmRange resolves the real fixture range to an official interchange-bracketed section, from the real generated dataset', () => {
  const result = resolveKmRange({ road: '國道一號', direction: '南向', startKM: '91K+590', endKM: '93K+320' });
  assert.equal(result.resolved, true);
  assert.equal(result.road, '國道一號');
  assert.equal(result.direction, '南向');
  assert.equal(result.startKm, 91.59);
  assert.equal(result.endKm, 93.32);
  assert.equal(result.segmentFrom, '竹北交流道');
  assert.equal(result.segmentTo, '新竹交流道');
  assert.equal(result.locationLabel, '竹北交流道－新竹交流道路段');
  assert.match(result.mapUrl, /^https:\/\/maps\.google\.com\/\?q=/);
});

test('5. direction-aware facility order — 南向(ascending) reads From-竹北 To-新竹; 北向(descending) reads the reverse, for the SAME KM range', () => {
  const south = resolveKmRange({ road: '國道一號', direction: '南向', startKM: '91K+590', endKM: '93K+320' });
  const north = resolveKmRange({ road: '國道一號', direction: '北向', startKM: '91K+590', endKM: '93K+320' });
  assert.deepEqual([south.segmentFrom, south.segmentTo], ['竹北交流道', '新竹交流道']);
  assert.deepEqual([north.segmentFrom, north.segmentTo], ['新竹交流道', '竹北交流道']);
});

test('6. no-data / unrecognized road fails closed — never guesses a section name', () => {
  const unknownRoad = resolveKmRange({ road: '不存在的路', direction: '北向', startKM: '10K+000', endKM: '12K+000' });
  assert.equal(unknownRoad.resolved, false);
  assert.equal(unknownRoad.reason, 'unknown-road');
  assert.equal(unknownRoad.segmentFrom, undefined);

  const noKm = resolveKmRange({ road: '國道一號', direction: '南向' });
  assert.equal(noKm.resolved, false);
  assert.equal(noKm.reason, 'no-km');
});

test('7. resolveKmRange reuses the SAME short maps.google.com URL format as resolveKmLocation (no API key, ?q= form)', () => {
  const result = resolveKmRange({ road: '國道一號', direction: '南向', startKM: '91K+590', endKM: '93K+320' });
  assert.match(result.mapUrl, /^https:\/\/maps\.google\.com\/\?q=-?\d+\.\d{5},-?\d+\.\d{5}$/);
  assert.equal(typeof result.representativeCoordinate.lat, 'number');
  assert.equal(typeof result.representativeCoordinate.lng, 'number');
});

// =======================================================================
// §C — fingerprint/dedupe + push behavior across state transitions (8-12)
// =======================================================================

test('dedupe.js/notified.js fingerprints change on OPEN<->STOPPED, stay identical for the same state+content', () => {
  const open1 = shoulderEvent('OPEN');
  const open2 = shoulderEvent('OPEN'); // same content, fresh object
  const stopped = shoulderEvent('STOPPED');

  assert.equal(computeFingerprint(open1), computeFingerprint(open2));
  assert.notEqual(computeFingerprint(open1), computeFingerprint(stopped));
  assert.equal(computeNotificationFingerprint(open1), computeNotificationFingerprint(open2));
  assert.notEqual(computeNotificationFingerprint(open1), computeNotificationFingerprint(stopped));

  // A plain accident/construction event's fingerprint shape is
  // byte-for-byte unchanged (no dynamicShoulderState key at all) — "不要
  // 破壞既有 accident/construction fingerprint".
  const acc = accidentEvent();
  assert.doesNotMatch(computeFingerprint(acc), /dynamicShoulderState/);
  assert.doesNotMatch(computeNotificationFingerprint(acc), /dynamicShoulderState/);
});

test('8-12. OPEN first push -> OPEN duplicate (0) -> OPEN->STOPPED push -> STOPPED duplicate (0) -> STOPPED->OPEN push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const { fetchFn, pushCalls } = makeFullPipelineFetch();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv }; // no CCTV_IMAGES -> text-only, isolates push-count behavior

  // 8. OPEN, first time -> pushed.
  let r = await runLineBroadcast(env, { allEvents: [shoulderEvent('OPEN')], dedupeAvailable: true, now: IN_HOURS_NOW });
  assert.equal(r.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);
  assert.match(pushCalls[0].body.messages[0].text, /機動開放路肩/);

  // 9. OPEN again, unchanged content -> NOT pushed again (same fingerprint).
  r = await runLineBroadcast(env, { allEvents: [shoulderEvent('OPEN')], dedupeAvailable: true, now: new Date(IN_HOURS_NOW.getTime() + 60000) });
  assert.equal(r.pushSucceeded, 0);
  assert.equal(pushCalls.length, 1);

  // 10. Same rawId, now STOPPED -> a real content change -> pushed again.
  r = await runLineBroadcast(env, { allEvents: [shoulderEvent('STOPPED')], dedupeAvailable: true, now: new Date(IN_HOURS_NOW.getTime() + 120000) });
  assert.equal(r.pushSucceeded, 1);
  assert.equal(pushCalls.length, 2);
  assert.match(pushCalls[1].body.messages[0].text, /路肩停止開放/);

  // 11. STOPPED again, unchanged -> NOT pushed again.
  r = await runLineBroadcast(env, { allEvents: [shoulderEvent('STOPPED')], dedupeAvailable: true, now: new Date(IN_HOURS_NOW.getTime() + 180000) });
  assert.equal(r.pushSucceeded, 0);
  assert.equal(pushCalls.length, 2);

  // 12. Back to OPEN -> pushed again.
  r = await runLineBroadcast(env, { allEvents: [shoulderEvent('OPEN')], dedupeAvailable: true, now: new Date(IN_HOURS_NOW.getTime() + 240000) });
  assert.equal(r.pushSucceeded, 1);
  assert.equal(pushCalls.length, 3);
  assert.match(pushCalls[2].body.messages[0].text, /機動開放路肩/);
});

// =======================================================================
// §D — single-camera CCTV (items 13-19)
// =======================================================================

test('13-14. dynamic-shoulder event is CCTV-eligible with imageStrategy="single" (never "quad")', () => {
  const elig = resolveCctvEligibility(shoulderEvent('OPEN'));
  assert.equal(elig.eligible, true);
  assert.equal(elig.imageStrategy, 'single');
  assert.equal(elig.direction, '南向');
  assert.equal(elig.startKm, 91.59);
  assert.equal(elig.endKm, 93.32);
});

test('15. single frame selection: an in-range, same-direction camera wins over one outside the range', () => {
  const records = [
    cctvRecord({ CCTVID: 'CCTV-INSIDE', RoadDirection: 'S', LocationMile: '92K+000' }), // inside 91.59-93.32
    cctvRecord({ CCTVID: 'CCTV-OUTSIDE', RoadDirection: 'S', LocationMile: '85K+000' }), // far outside
  ];
  const picked = selectSingleShoulderCandidate(records, { direction: '南向', startKm: 91.59, endKm: 93.32 });
  assert.equal(picked.cctvId, 'CCTV-INSIDE');
});

test('16. midpoint selection: with TWO in-range candidates, the one closest to the range midpoint wins', () => {
  // midpoint = (91.59+93.32)/2 = 92.455; 93K+000 (dist 0.545) beats 91K+800 (dist 0.655).
  const records = [
    cctvRecord({ CCTVID: 'CCTV-FAR-FROM-MID', RoadDirection: 'S', LocationMile: '91K+800' }),
    cctvRecord({ CCTVID: 'CCTV-NEAR-MID', RoadDirection: 'S', LocationMile: '93K+000' }),
  ];
  const picked = selectSingleShoulderCandidate(records, { direction: '南向', startKm: 91.59, endKm: 93.32 });
  assert.equal(picked.cctvId, 'CCTV-NEAR-MID');

  // Opposite direction cameras in the same range must never be picked.
  const wrongDirection = [cctvRecord({ CCTVID: 'CCTV-WRONG-DIR', RoadDirection: 'N', LocationMile: '92K+400' })];
  assert.equal(selectSingleShoulderCandidate(wrongDirection, { direction: '南向', startKm: 91.59, endKm: 93.32 }), null);
});

test('17. fallback nearest-camera: nothing inside the range -> nearest same-direction camera within radius is used', () => {
  // Range 91.59-93.32, midpoint 92.455. No candidate inside it, but one
  // 0.5km past the end (93.82) is within NEAR_RADIUS_KM (2km) of the midpoint.
  const records = [cctvRecord({ CCTVID: 'CCTV-JUST-OUTSIDE', RoadDirection: 'S', LocationMile: '93K+820' })];
  const picked = selectSingleShoulderCandidate(records, { direction: '南向', startKm: 91.59, endKm: 93.32 });
  assert.equal(picked.cctvId, 'CCTV-JUST-OUTSIDE');

  // Nothing within even the wide radius -> null, never reach further.
  const tooFar = [cctvRecord({ CCTVID: 'CCTV-TOO-FAR', RoadDirection: 'S', LocationMile: '120K+000' })];
  assert.equal(selectSingleShoulderCandidate(tooFar, { direction: '南向', startKm: 91.59, endKm: 93.32 }), null);
});

test('18. no camera at all -> prepareCctvImageForEvent fails closed to no-camera; the notification itself is never withheld', async () => {
  const kv = createMockKV();
  await seedMetadataCache(kv, []); // empty metadata pool
  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const cctv = await prepareCctvImageForEvent(env, shoulderEvent('OPEN'), {}, TEST_CODEC, CCTV_PREPARE_BUDGET_MS);
  assert.equal(cctv.ok, false);
  assert.equal(cctv.reason, 'no-camera');
});

test('19. successful single-camera publish writes EXACTLY ONE R2 object, with the raw fetched frame bytes unchanged (no collage compose, no re-encode)', async () => {
  const kv = createMockKV();
  const records = [cctvRecord({ CCTVID: 'CCTV-92', RoadDirection: 'S', LocationMile: '92K+000' })];
  await seedMetadataCache(kv, records);
  const frameBytes = await makeSolidJpeg(4, 4, [10, 20, 30]);
  const { fetchFn, hits } = makeFrameFetch({ frameJpeg: frameBytes });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const bucket = r2Bucket();
  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: bucket };
  const cctv = await prepareCctvImageForEvent(env, shoulderEvent('OPEN'), {}, TEST_CODEC, CCTV_PREPARE_BUDGET_MS);

  assert.equal(cctv.ok, true);
  assert.equal(hits.frame, 1); // exactly 1 frame fetch — never 4
  assert.equal(bucket.store.size, 1); // exactly 1 R2 object
  assert.equal(cctv.selectedCamera, 'CCTV-92@92K+000');
  const stored = [...bucket.store.values()][0];
  assert.deepEqual([...stored.value], [...frameBytes]); // byte-identical — never decoded/re-encoded/composed
});

// =======================================================================
// §E — end-to-end LINE / Shared Feed / Pipeline Trace (items 20, 21, 22)
// =======================================================================

test('20-22. full pipeline: LINE gets text+single image, completedProduct/Shared-Feed carries the SAME imageUrl, Pipeline Trace records imageStrategy=single', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const records = [cctvRecord({ CCTVID: 'CCTV-92', RoadDirection: 'S', LocationMile: '92K+000' })];
  await seedMetadataCache(kv, records);
  const frameBytes = await makeSolidJpeg(4, 4, [50, 60, 70]);
  const { fetchFn, pushCalls } = makeFullPipelineFetch({ frameJpeg: frameBytes });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const result = await runLineBroadcast(env, {
    allEvents: [shoulderEvent('OPEN')],
    dedupeAvailable: true,
    now: IN_HOURS_NOW,
    cctvCodecOverride: TEST_CODEC,
  });

  // 20. LINE text + single image (exactly 2 message parts, not the quad
  // path's own text+1-collage-image shape difference — the SHAPE is the
  // same either way at the LINE-API level, but this confirms it actually
  // fired for a control-typed dynamic-shoulder event, not just accident).
  assert.equal(result.pushSucceeded, 1);
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].body.messages.length, 2);
  assert.equal(pushCalls[0].body.messages[0].type, 'text');
  assert.equal(pushCalls[0].body.messages[1].type, 'image');
  const imageUrl = pushCalls[0].body.messages[1].originalContentUrl;
  assert.match(imageUrl, /\/cctv\/image\//);

  // 21. Shared Feed's own completedProduct carries the IDENTICAL imageUrl
  // — never a second, independently-composed image for the feed.
  assert.equal(result.completedProducts.length, 1);
  assert.equal(result.completedProducts[0].imageUrl, imageUrl);
  assert.ok(result.completedProducts[0].imageExpiresAt);

  // 22. Pipeline Trace shows imageStrategy=single, a minimal
  // selectedCamera reference (never the raw CCTV record), and the
  // eventSemantic/shoulderState/rangeResolution fields from §A/§B.
  assert.equal(result.pipelineTraceEntries.length, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.equal(trace.enrichment.imageStrategy, 'single');
  assert.equal(trace.enrichment.selectedCamera, 'CCTV-92@92K+000');
  assert.equal(trace.enrichment.cctvEligible, true);
  assert.equal(trace.normalized.eventSemantic, 'dynamic-shoulder');
  assert.equal(trace.normalized.shoulderState, 'OPEN');
  assert.deepEqual(trace.enrichment.rangeResolution, {
    segmentFrom: '竹北交流道',
    segmentTo: '新竹交流道',
    locationLabel: '竹北交流道－新竹交流道路段',
  });
});

// =======================================================================
// §F — regression: accident stays quad, construction/V57.2/hours unaffected (23-27)
// =======================================================================

const RECORDS_QUAD_82 = [
  cctvRecord({ CCTVID: 'CCTV-82-S-BEFORE', RoadDirection: 'S', LocationMile: '81K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-s-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-S-AFTER', RoadDirection: 'S', LocationMile: '82K+300', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-s-after.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-N-BEFORE', RoadDirection: 'N', LocationMile: '81K+950', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-n-before.jpg' }),
  cctvRecord({ CCTVID: 'CCTV-82-N-AFTER', RoadDirection: 'N', LocationMile: '82K+400', VideoStreamURL: 'https://cctv1.freeway.gov.tw/82-n-after.jpg' }),
];

test('23. accident regression — resolveCctvEligibility still resolves imageStrategy="quad", never "single"', () => {
  const elig = resolveCctvEligibility(accidentEvent());
  assert.equal(elig.eligible, true);
  assert.equal(elig.imageStrategy, 'quad');
  assert.equal(elig.targetKm, 82.1);
});

test('24. accident regression — an eligible accident still produces a real 4-frame quad collage (larger than one raw frame), never the single-frame path', async () => {
  const kv = createMockKV();
  await seedMetadataCache(kv, RECORDS_QUAD_82);
  const frameBytes = await makeSolidJpeg(320, 240, [80, 90, 100]);
  const { fetchFn, hits } = makeFrameFetch({ frameJpeg: frameBytes });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const bucket = r2Bucket();
  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: bucket };
  const cctv = await prepareCctvImageForEvent(env, accidentEvent(), {}, TEST_CODEC, CCTV_PREPARE_BUDGET_MS);

  assert.equal(cctv.ok, true);
  assert.equal(hits.frame, 4); // still 4 frame fetches for an accident — unchanged
  assert.equal(cctv.selectedCamera, undefined); // quad path never sets this
  const stored = [...bucket.store.values()][0];
  // A composed 2x2 collage of four 320x240 frames is necessarily much
  // larger than one raw input frame's own byte size — this distinguishes
  // "still really composing a collage" from "accidentally fell through
  // to the single-frame path."
  assert.ok(stored.value.length > frameBytes.length * 1.5, `expected a real composed collage, got ${stored.value.length} bytes vs one frame's ${frameBytes.length}`);
});

test('25. construction regression — a construction event with impact keyword is unaffected: normal eligibility, normal wording, never CCTV-eligible', () => {
  const event = {
    type: 'construction',
    title: '施工',
    description: '國道一號 北向 50K 車道封閉施工',
    road: '國道一號',
    direction: '北向',
    startKM: '50K+000',
    endKM: '50K+500',
    source: 'freeway',
  };
  assert.equal(getBroadcastEligibility(event).eligible, true);
  assert.equal(getBroadcastEligibility(event).reason, 'construction-impact-keyword');
  const text = formatEventMessage(event);
  assert.match(text, /🚧 道路施工/);
  assert.doesNotMatch(text, /機動開放路肩|路肩停止開放/);
  assert.equal(resolveCctvEligibility(event).eligible, false);
  assert.equal(resolveCctvEligibility(event).reason, 'not-accident');
});

test('26. V57.2 gating regression — crossSourceDedup unaffected: an unmatched 國道 PBS event is still gated out, entirely untouched by this round', () => {
  const pbsEvent = { source: 'pbs', rawId: 'PBS-1', road: '國道一號', direction: '南向', type: 'accident', description: 'x' };
  const result = crossSourceDedup([pbsEvent], []); // no TDX events this run -> no match
  assert.equal(result.canonicalEvents.length, 0);
  assert.equal(result.uniquePbsEvents.length, 0);
  assert.equal(result.filteredFreewayEvents.length, 1);
  assert.equal(result.filteredFreewayEvents[0], pbsEvent);
});

test('27. dynamic-shoulder is gated by the SAME 08:00-22:00 Asia/Taipei broadcast-hours rule — no second hours policy', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const { fetchFn, pushCalls } = makeFullPipelineFetch();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };

  const before = await runLineBroadcast(env, {
    allEvents: [shoulderEvent('OPEN')],
    dedupeAvailable: true,
    now: new Date('2026-08-21T07:59:00+08:00'),
  });
  assert.equal(before.withinBroadcastHours, false);
  assert.equal(before.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);

  const after = await runLineBroadcast(env, {
    allEvents: [shoulderEvent('OPEN')],
    dedupeAvailable: true,
    now: new Date('2026-08-21T22:00:00+08:00'),
  });
  assert.equal(after.withinBroadcastHours, false);
  assert.equal(after.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

// =======================================================================
// §G — 0 extra TDX/PBS/Google calls (item 28)
// =======================================================================

test('28. the single-camera CCTV pipeline makes 0 TDX calls, 0 Google Maps API calls — only freeway.gov.tw frame fetches and cache-only metadata reads', async () => {
  const kv = createMockKV();
  const records = [cctvRecord({ CCTVID: 'CCTV-92', RoadDirection: 'S', LocationMile: '92K+000' })];
  await seedMetadataCache(kv, records);
  const frameBytes = await makeSolidJpeg(4, 4, [1, 2, 3]);
  // makeFrameFetch throws on ANY non-freeway.gov.tw URL — a TDX call
  // (tdx.transportdata.tw) or a Google Maps API call would both fail
  // this test outright, proving neither happens.
  const { fetchFn, hits } = makeFrameFetch({ frameJpeg: frameBytes });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const env = { TRAFFIC_KV: kv, CCTV_IMAGES: r2Bucket() };
  const cctv = await prepareCctvImageForEvent(env, shoulderEvent('OPEN'), {}, TEST_CODEC, CCTV_PREPARE_BUDGET_MS);
  assert.equal(cctv.ok, true);
  assert.equal(hits.other, 0); // 0 non-freeway.gov.tw fetches of any kind
  assert.equal(hits.frame, 1);
  // resolveKmRange (called for the LINE text's map link) is itself pure/
  // 0-I/O — verified structurally by this whole test never needing a
  // mocked Google endpoint at all for the map URL to resolve.
  const range = resolveKmRange({ road: '國道一號', direction: '南向', startKM: '91K+590', endKM: '93K+320' });
  assert.ok(range.mapUrl);
});
