// 2026-08-30 — DIRECT_COORDINATE_MAP_FALLBACK hotfix (order:
// PBS_COORDINATE_DIRECT_MAP_FALLBACK). Real incident: EVENT_ID=
// 11508260158-0 — a 竹60線 (county road) landslide-closure event in
// 新竹縣尖石鄉 carried valid PBS x1/y1 coordinates the whole way through
// (PBS/Windows/Cloudflare all confirmed present, AI completed normally,
// LINE sent), but the pushed LINE message had NO Google Maps link at
// all. Root cause (see src/traffic/kmLocationResolver.js's own header
// comment on buildDirectCoordinateMapUrl for the full writeup):
// resolveKmLocation() and resolveCoordinateLocation() BOTH require
// event.road to canonicalize to a recognized 國道/省道 name before
// EITHER will even attempt to use a coordinate — a county/township road
// like 竹60線 never can, since this project only bundles official
// freeway (95016) and provincial (7040) KM-marker datasets, never
// county/township ones. The coordinate fallback therefore discarded a
// perfectly valid coordinate purely because the ROAD wasn't recognized.
//
// This file covers the new LAST-resort tier only
// (buildDirectCoordinateMapUrl / its wiring into messageFormat.js's
// buildRoadLines) — the pre-existing KM/road resolution logic itself is
// exhaustively covered by test/kmLocationResolver.test.js and
// test/kmLocationMessageIntegration.test.js, both untouched and both
// still passing unchanged by this round (confirming
// EXISTING_KM_RESOLUTION_UNCHANGED).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectCoordinateMapUrl } from '../src/traffic/kmLocationResolver.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';

// --- unit: buildDirectCoordinateMapUrl() itself ----------------------------

test('buildDirectCoordinateMapUrl: a valid coordinate pair produces the exact short-form Google Maps URL', () => {
  assert.equal(buildDirectCoordinateMapUrl(24.594933, 121.28194), 'https://maps.google.com/?q=24.59493,121.28194');
});

test('buildDirectCoordinateMapUrl: null/undefined -> null', () => {
  assert.equal(buildDirectCoordinateMapUrl(null, null), null);
  assert.equal(buildDirectCoordinateMapUrl(undefined, undefined), null);
  assert.equal(buildDirectCoordinateMapUrl(24.59, undefined), null);
  assert.equal(buildDirectCoordinateMapUrl(undefined, 121.28), null);
});

test('buildDirectCoordinateMapUrl: NaN/Infinity -> null', () => {
  assert.equal(buildDirectCoordinateMapUrl(NaN, 121.28), null);
  assert.equal(buildDirectCoordinateMapUrl(24.59, NaN), null);
  assert.equal(buildDirectCoordinateMapUrl(Infinity, 121.28), null);
  assert.equal(buildDirectCoordinateMapUrl(24.59, -Infinity), null);
});

test('buildDirectCoordinateMapUrl: exactly (0,0) "null island" -> null (never a real Taiwan location)', () => {
  assert.equal(buildDirectCoordinateMapUrl(0, 0), null);
});

test('buildDirectCoordinateMapUrl: out-of-range latitude/longitude -> null', () => {
  assert.equal(buildDirectCoordinateMapUrl(91, 121.28), null);
  assert.equal(buildDirectCoordinateMapUrl(-91, 121.28), null);
  assert.equal(buildDirectCoordinateMapUrl(24.59, 181), null);
  assert.equal(buildDirectCoordinateMapUrl(24.59, -181), null);
});

test('buildDirectCoordinateMapUrl: non-number types (string, object) -> null', () => {
  assert.equal(buildDirectCoordinateMapUrl('24.59', '121.28'), null);
  assert.equal(buildDirectCoordinateMapUrl({}, []), null);
});

// --- integration: formatEventMessage() end-to-end via a PBS-shaped event ---

function pbsControlEventOverride(overrides = {}) {
  return {
    road: '新竹縣-尖石鄉', // normalizePbsRoad()'s own areaNm-passthrough result — never hardcoded 竹60
    direction: undefined,
    location: '新竹縣-尖石鄉',
    type: 'control',
    description: '竹60線雙向.23.5K因坍方.管制中',
    title: '竹60線雙向.23.5K因坍方.管制中',
    startTime: null,
    endTime: null,
    updatedAt: null,
    source: 'pbs',
    rawId: 'CASE-TEST',
    sourceDetail: '橫山分局',
    ...overrides,
  };
}

// CASE 1 — 竹60 event (unknown road) with valid coordinates -> map link YES,
// exact expected URL, and the road name is NOT guessed/renamed.
test('CASE 1: an unknown-road (county road) event with valid coordinates gets a map link with the exact expected URL', () => {
  const event = pbsControlEventOverride({ latitude: 24.594933, longitude: 121.28194 });
  const text = formatEventMessage(event);
  assert.ok(text.includes('📍 地圖 https://maps.google.com/?q=24.59493,121.28194'), 'expected the direct-coordinate map link');
  const lines = text.split('\n');
  assert.equal(lines[1], '新竹縣-尖石鄉', 'road/location line must stay exactly the unrecognized road/areaNm text — never guessed into 竹60 or any anchor label');
});

// CASE 2 — existing 台68/國道/省道 events: covered by test/kmLocationMessageIntegration.test.js
// and test/kmLocationResolver.test.js, both re-run unchanged this round
// (see this round's own regression report) — not duplicated here. A
// direct assertion that the KM path still wins over this new fallback
// when it resolves successfully:
test('CASE 2: when the existing KM/road resolution path already succeeds, the direct-coordinate fallback is never reached (KM-path mapUrl wins, unchanged behavior)', () => {
  const event = {
    road: '國道一號',
    direction: '北向',
    startKM: '91K+000',
    endKM: '91K+000',
    location: '',
    type: 'accident',
    description: '國道一號北向91K事故',
    title: '國道一號北向91K事故',
    // deliberately WRONG coordinates that would produce a different pin if
    // the fallback were mistakenly reached — proves the KM path's own
    // resolver-dataset coordinate is what's used, not the raw event ones.
    latitude: 1,
    longitude: 1,
  };
  const text = formatEventMessage(event);
  assert.ok(text.includes('📍 地圖 https://maps.google.com/?q=24.82443,121.01774'), 'must still be the KM-path resolver dataset coordinate, not the raw (1,1) fallback coordinate');
});

// CASE 3 — unknown-road + valid coordinates -> map link YES (same shape as
// CASE 1, phrased per the order's own targeted-test list).
test('CASE 3: unknown-road + valid coordinates -> MAP_LINK = YES', () => {
  const event = pbsControlEventOverride({ latitude: 24.594933, longitude: 121.28194 });
  const text = formatEventMessage(event);
  assert.ok(text.includes('📍 地圖'));
});

// CASE 4 — unknown-road + no coordinates at all -> map link NO.
test('CASE 4: unknown-road + no coordinates -> MAP_LINK = NO', () => {
  const event = pbsControlEventOverride({ latitude: undefined, longitude: undefined });
  const text = formatEventMessage(event);
  assert.ok(!text.includes('📍'));
});

// CASE 5 — unknown-road + invalid coordinates (NaN / 0,0 / out-of-range) -> map link NO.
test('CASE 5: unknown-road + invalid coordinates -> MAP_LINK = NO', () => {
  for (const [latitude, longitude] of [
    [NaN, 121.28194],
    [0, 0],
    [91, 121.28194],
    [24.594933, 181],
  ]) {
    const event = pbsControlEventOverride({ latitude, longitude });
    const text = formatEventMessage(event);
    assert.ok(!text.includes('📍'), `expected no map link for latitude=${latitude} longitude=${longitude}`);
  }
});

// CASE 6 — the direct-coordinate fallback must never invent a road name,
// section label, or location label — only the trailing map line may
// change; the location/label line is computed entirely independently of
// mapUrl (see buildRoadLines()'s own structure) and must be byte-identical
// with and without a resolvable coordinate.
test('CASE 6: the direct-coordinate fallback never changes sectionLabel/locationLabel/firstLine — only whether a map link is appended', () => {
  const withCoords = formatEventMessage(pbsControlEventOverride({ latitude: 24.594933, longitude: 121.28194 }));
  const withoutCoords = formatEventMessage(pbsControlEventOverride({ latitude: undefined, longitude: undefined }));
  const firstLineWith = withCoords.split('\n')[1];
  const firstLineWithout = withoutCoords.split('\n')[1];
  assert.equal(firstLineWith, firstLineWithout, 'the road/location label line must be identical regardless of whether a map link was appended');
  assert.equal(firstLineWith, '新竹縣-尖石鄉', 'must never guess a road name (e.g. 竹60) or an anchor-table label');
});

// --- real event regression fixture: EVENT_ID=11508260158-0 -----------------

function realIncidentRawPbsRecord() {
  return {
    UID: '11508260158-0',
    road: '', // PBS's own road field was empty for this real event
    areaNm: '新竹縣-尖石鄉',
    direction: '',
    comment:
      '.竹60線雙向.23.5K因坍方.管制中.從8/25~8/30.每日18時~隔日07時.全線封閉.其餘時段採單線管制.請依現場人員指示通行',
    roadtype: '',
    happendate: '2026-08-25',
    happentime: '10:09:00',
    modDttm: '2026-08-25 10:09:00',
    x1: '121.28194',
    y1: '24.594933',
    srcdetail: '橫山分局',
  };
}

test('REAL EVENT REGRESSION (EVENT_ID=11508260158-0): HAS_VALID_COORDS=YES, OLD_RESULT would have been NO map link, NEW_RESULT is YES — road stays 新竹縣-尖石鄉, never hardcoded to 竹60', () => {
  const normalized = normalizePbsEvent(realIncidentRawPbsRecord());

  // Confirms the real diagnosed root cause still reproduces exactly:
  // road ends up as the areaNm passthrough, never "竹60線".
  assert.equal(normalized.road, '新竹縣-尖石鄉');
  assert.equal(normalized.latitude, 24.594933, 'HAS_VALID_COORDS: raw.y1 -> latitude');
  assert.equal(normalized.longitude, 121.28194, 'HAS_VALID_COORDS: raw.x1 -> longitude');

  const text = formatEventMessage(normalized);
  assert.ok(text.includes('📍 地圖 https://maps.google.com/?q=24.59493,121.28194'), 'NEW_RESULT: a map link must now be present for this real event');

  const lines = text.split('\n');
  assert.equal(lines[1], '新竹縣-尖石鄉', 'ROAD_NAME must stay exactly the unrecognized road text — never hardcoded to 竹60 to make this test pass');
});
