// V1.8.6.5 — KM Location Resolver. ALL location data in this file is
// clearly-labeled TEST FIXTURE synthetic data, injected via the
// TEST-ONLY `datasetOverride` option (same pattern as e.g.
// broadcastPipeline.js's own cctvCodecOverride) — NEVER read from, and
// NEVER written to, data/road-location/generated/*.js. Production code
// never passes datasetOverride; see resolveKmLocation's own doc comment.
//
// Also covers: the resolver's behavior against the REAL (currently empty,
// because no official raw data has been imported yet — see
// data/road-location/raw/README.md) production datasets, to prove the
// fail-closed contract holds for actual Production data, not just mocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKmLocation, PROVINCIAL_TOLERANCE_KM, FREEWAY_MILESTONE_TOLERANCE_KM } from '../src/traffic/kmLocationResolver.js';

// --- TEST FIXTURE synthetic dataset (never real geography) ---
const TEST_FIXTURE_PROVINCIAL = {
  metadata: { sourceName: 'TEST FIXTURE', sourceUrl: null, sourceAgency: null, fetchedAt: null, datasetUpdatedAt: null, recordCount: 2, sha256: null },
  points: [
    { road: '台13甲', km: 9.0, county: '測試縣', township: '測試鄉', village: '測試村', label: null, lat: 24.8, lng: 121.0 },
    { road: '台13甲', km: 12.0, county: '測試縣', township: '測試鄉2', village: null, label: '測試官方位置描述', lat: null, lng: null },
  ],
};

const TEST_FIXTURE_FREEWAY = {
  metadata: { sourceName: 'TEST FIXTURE', sourceUrl: null, sourceAgency: null, fetchedAt: null, datasetUpdatedAt: null, recordCount: 3, sha256: null },
  points: [
    { road: '國道一號', km: 86.0, lat: 24.83, lng: 121.02 },
    { road: '國道一號', km: 88.0, lat: 24.85, lng: 121.03 },
    { road: '國道一號', km: 91.0, lat: 24.83, lng: 121.02 },
  ],
};

const TEST_FIXTURE_FREEWAY_FACILITIES = {
  metadata: { sourceName: 'TEST FIXTURE', sourceUrl: null, sourceAgency: null, fetchedAt: null, datasetUpdatedAt: null, recordCount: 2, sha256: null },
  facilities: [
    { road: '國道一號', km: 86.0, name: '測試服務區A', type: '服務區' },
    { road: '國道一號', km: 91.0, name: '測試交流道B', type: '交流道' },
  ],
};

const DATASET_OVERRIDE = {
  provincial: TEST_FIXTURE_PROVINCIAL,
  freeway: TEST_FIXTURE_FREEWAY,
  freewayFacilities: TEST_FIXTURE_FREEWAY_FACILITIES,
};

test('1. provincial: resolves via composed county+township+village when no 設置位置 label is present', () => {
  const result = resolveKmLocation({ road: '台13甲線', startKM: '9K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, true);
  assert.equal(result.dataset, 'provincial');
  assert.equal(result.locationLabel, '測試縣測試鄉測試村');
  assert.equal(result.coordinate.lat, 24.8);
  assert.equal(result.mapUrl, 'https://maps.google.com/?q=24.80000,121.00000');
});

test('2. provincial: prefers the official 設置位置 free-text label over composing county/township/village', () => {
  const result = resolveKmLocation({ road: '台13甲', startKM: '12K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, true);
  assert.equal(result.locationLabel, '測試官方位置描述');
  assert.equal(result.coordinate, null); // no lat/lng on this fixture row
  assert.equal(result.mapUrl, null);
});

test('3. provincial: a point outside PROVINCIAL_TOLERANCE_KM fails closed (never forces a match)', () => {
  const farKm = 12.0 + PROVINCIAL_TOLERANCE_KM + 5;
  const result = resolveKmLocation({ road: '台13甲', startKM: `${farKm}K+000` }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'too-far');
});

test('4. provincial: a road with no matching dataset points fails closed with reason "no-data"', () => {
  const result = resolveKmLocation({ road: '台7', startKM: '5K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'no-data');
});

test('5. unrecognized road string entirely fails closed with reason "unknown-road"', () => {
  const result = resolveKmLocation({ road: '中華路', startKM: '5K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'unknown-road');
});

test('6. freeway: 南向/東向 orders the segment ascending (lower KM facility first)', () => {
  const result = resolveKmLocation({ road: '國道一號', direction: '南向', startKM: '89K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, true);
  assert.equal(result.segmentFrom, '測試服務區A');
  assert.equal(result.segmentTo, '測試交流道B');
  assert.equal(result.locationLabel, '測試服務區A－測試交流道B路段');
});

test('7. freeway: 北向/西向 reverses the segment (higher KM facility first)', () => {
  const result = resolveKmLocation({ road: '國道一號', direction: '北向', startKM: '89K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, true);
  assert.equal(result.segmentFrom, '測試交流道B');
  assert.equal(result.segmentTo, '測試服務區A');
  assert.equal(result.locationLabel, '測試交流道B－測試服務區A路段');
});

test('8. freeway: unknown/missing direction falls back to the neutral ascending order (never guesses travel direction)', () => {
  const result = resolveKmLocation({ road: '國道一號', direction: '雙向', startKM: '89K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.segmentFrom, '測試服務區A');
  assert.equal(result.segmentTo, '測試交流道B');

  const noDirection = resolveKmLocation({ road: '國道一號', startKM: '89K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(noDirection.segmentFrom, '測試服務區A');
  assert.equal(noDirection.segmentTo, '測試交流道B');
});

test('9. freeway: only one bracketing facility within range collapses to a single "OO附近" label', () => {
  const result = resolveKmLocation({ road: '國道一號', startKM: '99K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, true);
  assert.equal(result.segmentFrom, '測試交流道B');
  assert.equal(result.segmentTo, null);
  assert.equal(result.locationLabel, '測試交流道B附近');
});

test('10. freeway: coordinate/mapUrl come from the nearest 100m milestone within FREEWAY_MILESTONE_TOLERANCE_KM', () => {
  const result = resolveKmLocation({ road: '國道一號', startKM: '88K+050' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.coordinate.lat, 24.85);
  assert.equal(result.coordinate.lng, 121.03);
  assert.equal(result.mapUrl, 'https://maps.google.com/?q=24.85000,121.03000');
  assert.equal(result.resolvedKm, 88.0);
});

test('11. freeway: milestone too far -> coordinate/mapUrl null, but a segment label can still resolve independently', () => {
  const farFromMilestone = 91.0 + FREEWAY_MILESTONE_TOLERANCE_KM + 1; // still within facility gap, not within milestone tolerance
  const result = resolveKmLocation({ road: '國道一號', startKM: `${farFromMilestone}K+000` }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.coordinate, null);
  assert.equal(result.mapUrl, null);
  assert.ok(result.locationLabel); // still resolved via the facility table
});

test('12. no KM at all (no startKM/endKM/displayKM) fails closed with reason "no-km"', () => {
  const result = resolveKmLocation({ road: '國道一號' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'no-km');
});

test('13. target KM selection: midpoint of startKM/endKM wins when both present', () => {
  const result = resolveKmLocation({ road: '國道一號', startKM: '86K+000', endKM: '88K+000' }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(result.targetKm, 87);
});

test('14. target KM selection: event.displayKM is used only as a last resort (lowest priority)', () => {
  const withStructured = resolveKmLocation({ road: '國道一號', startKM: '86K+000', displayKM: 999 }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(withStructured.targetKm, 86);

  const displayOnly = resolveKmLocation({ road: '國道一號', displayKM: 88 }, { datasetOverride: DATASET_OVERRIDE });
  assert.equal(displayOnly.targetKm, 88);
});

test('15. resolver never throws on malformed/garbage input', () => {
  assert.doesNotThrow(() => resolveKmLocation(null));
  assert.doesNotThrow(() => resolveKmLocation(undefined));
  assert.doesNotThrow(() => resolveKmLocation({}));
  assert.doesNotThrow(() => resolveKmLocation({ road: 123, startKM: {} }));
  assert.equal(resolveKmLocation(null).resolved, false);
});

test('16. against the REAL Production dataset (data.gov.tw 7040/95016/166496/8161, imported V1.8.6.5) — a road genuinely outside its coverage still fails closed with "no-data", never a guess', () => {
  // No datasetOverride here — this exercises the actual bundled
  // data/road-location/generated/*.js files. `台99` is not a real
  // provincial route, so this also guards against TEST FIXTURE data ever
  // leaking into Production's generated files (it would never resolve).
  const provincial = resolveKmLocation({ road: '台99', startKM: '9K+000' });
  assert.equal(provincial.resolved, false);
  assert.equal(provincial.reason, 'no-data');
});

// V1.8.6.5 — the two REQUIRED real acceptance resolutions, run against the
// actual imported official data (not a fixture, not a guess). Locks in the
// exact values resolveKmLocation() produced once real raw data existed —
// see PROJECT_HANDOFF.md's V1.8.6.5 section for the full report this was
// taken from.
test('17. REQUIRED acceptance test: 台13甲 9K+000 resolves to a real official location + coordinate', () => {
  const result = resolveKmLocation({ road: '台13甲線', startKM: '9K+000' });
  assert.equal(result.resolved, true);
  assert.equal(result.dataset, 'provincial');
  assert.equal(result.locationLabel, '苗栗縣造橋鄉造橋村');
  assert.ok(result.coordinate);
  assert.equal(result.mapUrl, 'https://maps.google.com/?q=24.62850,120.85280');
});

test('18. REQUIRED acceptance test: 國1 88K+000 南向 resolves to a real official segment + coordinate', () => {
  const result = resolveKmLocation({ road: '國道一號', direction: '南向', startKM: '88K+000' });
  assert.equal(result.resolved, true);
  assert.equal(result.dataset, 'freeway');
  assert.equal(result.segmentFrom, '湖口服務區');
  assert.equal(result.segmentTo, '竹北交流道');
  assert.equal(result.locationLabel, '湖口服務區－竹北交流道路段');
  assert.ok(result.coordinate);
  assert.equal(result.mapUrl, 'https://maps.google.com/?q=24.84951,121.01791');
});
