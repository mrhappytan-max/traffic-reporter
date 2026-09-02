// V1.8.6.5 — broadcastProvenance.js's kmLocationResolution field. Covers
// buildProvenanceRecord()'s sanitizeKmLocationResolution() in isolation
// (pure, no KV, no resolver call — `kmLocationResolution` is passed in
// directly, exactly as broadcastPipeline.js's own second resolveKmLocation()
// call would produce it) plus the end-to-end pipeline wiring against the
// real (currently empty) Production road-location dataset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { buildProvenanceRecord, PROVENANCE_KEY_PREFIX } from '../src/traffic/broadcastProvenance.js';

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
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

test('1. buildProvenanceRecord: an unresolved kmLocationResolution is captured as {resolved:false, reason}, never dropped silently', () => {
  const record = buildProvenanceRecord({
    event: { type: 'construction', road: '台3線' },
    formattedOutput: 'x',
    kmLocationResolution: { resolved: false, reason: 'no-data', dataset: 'provincial', road: '台3' },
  });
  assert.deepEqual(record.kmLocationResolution, { resolved: false, reason: 'no-data' });
});

test('2. buildProvenanceRecord: a resolved kmLocationResolution keeps evidence fields but drops the raw coordinate/mapUrl', () => {
  const record = buildProvenanceRecord({
    event: { type: 'construction', road: '台3線' },
    formattedOutput: 'x',
    kmLocationResolution: {
      resolved: true,
      dataset: 'provincial',
      road: '台3',
      targetKm: 78.85,
      resolvedKm: 79,
      locationLabel: '測試縣測試鄉測試村',
      segmentFrom: null,
      segmentTo: null,
      coordinate: { lat: 24.8, lng: 121.0 },
      mapUrl: 'https://maps.google.com/?q=24.80000,121.00000',
    },
  });
  assert.equal(record.kmLocationResolution.resolved, true);
  assert.equal(record.kmLocationResolution.dataset, 'provincial');
  assert.equal(record.kmLocationResolution.locationLabel, '測試縣測試鄉測試村');
  assert.equal(record.kmLocationResolution.coordinateAvailable, true);
  assert.equal('coordinate' in record.kmLocationResolution, false);
  assert.equal('mapUrl' in record.kmLocationResolution, false);
});

test('3. buildProvenanceRecord: kmLocationResolution omitted entirely -> null, never throws', () => {
  const record = buildProvenanceRecord({ event: { type: 'other' }, formattedOutput: 'x' });
  assert.equal(record.kmLocationResolution, null);
});

test('4. end-to-end: a real successful push writes a provenance record whose kmLocationResolution reflects the real imported Production dataset (data.gov.tw 7040), with coordinateAvailable true but no raw lat/lng/mapUrl in the stored record', async () => {
  const kv = createMockKV();
  const now = new Date('2026-08-20T08:00:00+08:00');
  await setUserEnabled(kv, 'U1', true, now);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  const event = {
    source: 'highway',
    rawId: 'HWY-KMLOC-1',
    type: 'accident',
    road: '台3線',
    direction: '雙向',
    startKM: '78K+500',
    endKM: '79K+200',
    location: '台3線 雙向 事故',
    description: '台3線雙向事故',
    startTime: now.toISOString(),
    endTime: null,
    updatedAt: now.toISOString(),
    // V2.4.5 — service-area gate evidence only (kmLocationResolution
    // itself, asserted below, still comes from kmLocationResolver.js's
    // own road+KM resolution against the real dataset, untouched by
    // this). Confirmed this round inside 新竹縣 (關西/橫山 vicinity — the
    // real-world location 78.5-79.2K on 台3線 corresponds to) by the
    // official NLSC polygon.
    longitude: 121.15,
    latitude: 24.78,
  };

  try {
    await runLineBroadcast({ TRAFFIC_KV: kv, LINE_CHANNEL_ACCESS_TOKEN: 'tok' }, { allEvents: [event], dedupeAvailable: true, now });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const keys = [...kv.store.keys()].filter((k) => k.startsWith(`${PROVENANCE_KEY_PREFIX}:`));
  assert.equal(keys.length, 1);
  const record = JSON.parse(kv.store.get(keys[0]));
  assert.ok(record.kmLocationResolution);
  assert.equal(record.kmLocationResolution.resolved, true);
  assert.equal(record.kmLocationResolution.dataset, 'provincial');
  assert.equal(record.kmLocationResolution.road, '台3');
  assert.equal(record.kmLocationResolution.coordinateAvailable, true);
  assert.equal('coordinate' in record.kmLocationResolution, false);
  assert.equal('mapUrl' in record.kmLocationResolution, false);
});
