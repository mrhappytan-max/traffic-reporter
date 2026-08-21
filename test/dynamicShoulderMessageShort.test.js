// V1.8.7.2 — Dynamic Shoulder Message Simplification. Formatter-only
// change: src/traffic/messageFormat.js's DYNAMIC_SHOULDER_DISPLAY/
// formatEventMessage. Nothing in classification, CCTV, Shared Feed,
// dedupe, kmLocationResolver, or Pipeline Trace's own logic was touched
// this round — the targeted tests below confirm both the new short
// format AND that those other layers stayed exactly as they were.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { resolveCctvEligibility } from '../src/cctv/dynamicCollage.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { decodeJpeg, encodeJpeg } from './testJpegCodec.js';

const TEST_CODEC = { decodeJpeg, encodeJpeg };

// The real Production fixture (91K+590～93K+320, 國道一號 南向).
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

const OPEN_EVENT = shoulderEvent('OPEN');
const STOPPED_EVENT = shoulderEvent('STOPPED');

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-ACC-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '93K+500',
    endKM: '93K+000',
    description: '事故',
    updatedAt: '2026-08-21T10:00:00Z',
    ...overrides,
  };
}

function constructionEvent(overrides = {}) {
  return {
    type: 'construction',
    title: '施工',
    description: '國道一號 北向 50K 車道封閉施工',
    road: '國道一號',
    direction: '北向',
    startKM: '50K+000',
    endKM: '50K+500',
    source: 'freeway',
    updatedAt: '2026-08-21T10:00:00Z',
    ...overrides,
  };
}

// =======================================================================
// 1-2: exact short format
// =======================================================================

test('1. OPEN renders exactly the 4-line short format from this round\'s spec, nothing more', () => {
  const text = formatEventMessage(OPEN_EVENT);
  assert.equal(
    text,
    ['🛣️ 機動開放路肩', '國1 南向｜竹北交流道－新竹交流道路段', '91K+590～93K+320', '路肩開放通行'].join('\n')
  );
  assert.equal(text.split('\n').length, 4);
});

test('2. STOPPED renders exactly the 4-line short format from this round\'s spec, nothing more', () => {
  const text = formatEventMessage(STOPPED_EVENT);
  assert.equal(
    text,
    ['⛔ 路肩停止開放', '國1 南向｜竹北交流道－新竹交流道路段', '91K+590～93K+320', '路肩停止開放'].join('\n')
  );
  assert.equal(text.split('\n').length, 4);
});

// =======================================================================
// 3-7: removed content
// =======================================================================

test('3-4. neither OPEN nor STOPPED ever contains a maps.google.com link', () => {
  assert.doesNotMatch(formatEventMessage(OPEN_EVENT), /maps\.google\.com/);
  assert.doesNotMatch(formatEventMessage(STOPPED_EVENT), /maps\.google\.com/);
  assert.doesNotMatch(formatEventMessage(OPEN_EVENT), /📍/);
  assert.doesNotMatch(formatEventMessage(STOPPED_EVENT), /📍/);
});

test('5. neither OPEN nor STOPPED contains "請依現場標誌及號誌行駛"', () => {
  assert.doesNotMatch(formatEventMessage(OPEN_EVENT), /請依現場標誌及號誌行駛/);
  assert.doesNotMatch(formatEventMessage(STOPPED_EVENT), /請依現場標誌及號誌行駛/);
});

test('6. neither OPEN nor STOPPED contains "請回主線車道"', () => {
  assert.doesNotMatch(formatEventMessage(OPEN_EVENT), /請回主線車道/);
  assert.doesNotMatch(formatEventMessage(STOPPED_EVENT), /請回主線車道/);
});

test('7. neither OPEN nor STOPPED contains an updated-time line ("更新")', () => {
  assert.doesNotMatch(formatEventMessage(OPEN_EVENT), /更新/);
  assert.doesNotMatch(formatEventMessage(STOPPED_EVENT), /更新/);
  assert.doesNotMatch(formatEventMessage(OPEN_EVENT), /🕒/);
  assert.doesNotMatch(formatEventMessage(STOPPED_EVENT), /🕒/);
});

// =======================================================================
// 8-10: retained essential content, fail-closed fallback
// =======================================================================

test('8. the official range-resolved section label is still retained', () => {
  assert.match(formatEventMessage(OPEN_EVENT), /竹北交流道－新竹交流道路段/);
});

test('9. the KM range is still retained', () => {
  assert.match(formatEventMessage(OPEN_EVENT), /91K\+590～93K\+320/);
});

test('10. resolver failure (no facility resolves) still produces a normal, valid short message — never withheld for lack of a section name', () => {
  const event = shoulderEvent('OPEN', { startKM: '900K+000', endKM: '901K+000' });
  const text = formatEventMessage(event);
  assert.equal(text, ['🛣️ 機動開放路肩', '國1 南向', '900K+000～901K+000', '路肩開放通行'].join('\n'));
  assert.equal(text.split('\n').length, 4);
});

// =======================================================================
// 11-12: CCTV single / Shared Feed image — unaffected
// =======================================================================

test('11. CCTV single-strategy eligibility is completely unaffected by the formatter change', () => {
  const elig = resolveCctvEligibility(OPEN_EVENT);
  assert.equal(elig.eligible, true);
  assert.equal(elig.imageStrategy, 'single');
  const eligStopped = resolveCctvEligibility(STOPPED_EVENT);
  assert.equal(eligStopped.imageStrategy, 'single');
});

let originalFetch;
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
  resetTdxTokenCache();
});

test('12. Shared Feed still carries the shoulder event\'s own imageUrl/imageExpiresAt, and LINE still gets the short text + single image', async () => {
  const store = new Map();
  const kv = {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const r2Store = new Map();
  const bucket = {
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      r2Store.set(key, { value: bytes, customMetadata: options.customMetadata || {} });
    },
    async get(key) {
      const entry = r2Store.get(key);
      if (!entry) return null;
      return { customMetadata: entry.customMetadata, async arrayBuffer() { return entry.value.buffer; } };
    },
    async delete(key) { r2Store.delete(key); },
  };
  await kv.put(
    'cctv:freeway-metadata:v1',
    JSON.stringify({
      records: [
        {
          CCTVID: 'CCTV-C', RoadID: '000010', RoadName: '國道1號', RoadDirection: 'S',
          LocationMile: '92K+000', PositionLon: 120.9, PositionLat: 24.8,
          VideoStreamURL: 'https://cctv1.freeway.gov.tw/c.jpg',
        },
      ],
      fetchedAt: new Date().toISOString(),
    })
  );

  const data = new Uint8ClampedArray(4 * 4 * 4).fill(200);
  const frameBytes = new Uint8Array(await encodeJpeg({ data, width: 4, height: 4 }, { quality: 80 }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('freeway.gov.tw')) return new Response(frameBytes, { status: 200 });
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };

  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: bucket };
  const result = await runLineBroadcast(env, {
    allEvents: [OPEN_EVENT],
    dedupeAvailable: true,
    now: new Date('2026-08-21T14:00:00+08:00'),
    cctvCodecOverride: TEST_CODEC,
  });

  assert.equal(result.pushSucceeded, 1);
  assert.equal(result.completedProducts.length, 1);
  const product = result.completedProducts[0];
  assert.ok(product.imageUrl);
  assert.ok(product.imageExpiresAt);
  // The text carried into the Shared Feed is the NEW short format.
  assert.equal(product.text.split('\n').length, 4);
  assert.doesNotMatch(product.text, /maps\.google\.com/);
});

// =======================================================================
// 13-14: accident / construction formatters completely unchanged
// =======================================================================

test('13. accident formatter output is byte-identical to before this round', () => {
  const text = formatEventMessage(accidentEvent());
  assert.equal(
    text,
    [
      '🚨 交通事故',
      '國1 北向｜新竹交流道－竹北交流道路段',
      '93K+500～93K+000',
      '事故影響通行',
      '請提前避開',
      '📍 地圖 https://maps.google.com/?q=24.80605,121.00998',
      '🕒 18:00更新',
    ].join('\n')
  );
});

test('14. construction formatter output is byte-identical to before this round', () => {
  const text = formatEventMessage(constructionEvent());
  assert.equal(
    text,
    [
      '🚧 道路施工',
      '國1 北向｜機場系統交流道－桃園交流道路段',
      '50K+000～50K+500',
      '施工影響通行',
      '請注意車道',
      '📍 地圖 https://maps.google.com/?q=25.03210,121.28917',
      '🕒 18:00更新',
    ].join('\n')
  );
});

// =======================================================================
// 15: Pipeline Trace rangeResolution unaffected
// =======================================================================

test('15. Pipeline Trace rangeResolution is still populated correctly for a dynamic-shoulder event, unaffected by the shorter LINE text', async () => {
  const store = new Map();
  const kv = {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
  // rangeResolution is only computed once a per-target push is actually
  // attempted (see broadcastPipeline.js's per-event loop) — needs a real
  // token + enrolled subscriber + a working LINE mock to reach that code,
  // not just a fail-closed early return.
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv }; // no CCTV_IMAGES -> text-only, irrelevant to rangeResolution
  const result = await runLineBroadcast(env, {
    allEvents: [OPEN_EVENT],
    dedupeAvailable: true,
    now: new Date('2026-08-21T14:00:00+08:00'),
  });
  assert.equal(result.pipelineTraceEntries.length, 1);
  const trace = result.pipelineTraceEntries[0];
  assert.deepEqual(trace.enrichment.rangeResolution, {
    segmentFrom: '竹北交流道',
    segmentTo: '新竹交流道',
    locationLabel: '竹北交流道－新竹交流道路段',
  });
  assert.equal(trace.normalized.eventSemantic, 'dynamic-shoulder');
  assert.equal(trace.normalized.shoulderState, 'OPEN');
});
