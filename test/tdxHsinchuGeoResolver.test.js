// V2.4.5 — V2_4_5_TDX_HSINCHU_GEO_RESOLVER dedicated test suite.
//
// This is the order's own required CASE 1-10 coverage (plus the fixed
// 39.6K regression case) for src/tdx/hsinchuGeoResolver.js in isolation —
// pure, synchronous, zero I/O, zero mocking needed. Ad-hoc `node -e`
// smoke tests during construction already verified every one of these
// scenarios; this file is that same coverage, committed as a real,
// permanent regression suite.
//
// Reference coordinates used below are either official-polygon-confirmed
// this round (新竹市/新竹縣 points — see hsinchuGeoResolver.js's own
// header + data/hsinchu-boundary/raw/SOURCE_META.json) or well-known
// neighboring county/city seats (city halls), each of which resolves
// OUTSIDE_HSINCHU as expected — see this file's own "reference points"
// note below each case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTdxHsinchuGeography,
  isPointInRings,
  HSINCHU_GEO_STATUS,
} from '../src/tdx/hsinchuGeoResolver.js';

// =============================================================================
// CASE 1-2 — coordinate tier, the ONLY tier that can positively confirm.
// =============================================================================

test('CASE 1: a coordinate genuinely inside 新竹市 (市政府, 120.9686/24.8066) -> CONFIRMED_HSINCHU via the coordinate tier', () => {
  const event = { source: 'freeway', road: '國道一號', longitude: 120.9686, latitude: 24.8066 };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(result.reason, 'coordinate_inside_authoritative_boundary');
  assert.equal(result.evidence.tier, 'coordinate');
});

test('CASE 2: a coordinate genuinely inside 新竹縣 (竹北市, 121.0134/24.8388) -> CONFIRMED_HSINCHU via the coordinate tier', () => {
  const event = { source: 'highway', road: '台68線', longitude: 121.0134, latitude: 24.8388 };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(result.reason, 'coordinate_inside_authoritative_boundary');
});

test('CASE 2b: multiple positions, ALL inside -> still CONFIRMED_HSINCHU (order: every carried point must be inside)', () => {
  const event = {
    source: 'freeway',
    positions: [
      { longitude: 120.9686, latitude: 24.8066 },
      { longitude: 121.0134, latitude: 24.8388 },
    ],
  };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
});

// =============================================================================
// CASE 3 — the real leaked event, permanently regression-locked: 台61線
// 39K+600 / 桃園市觀音區白玉里 must resolve OUTSIDE_HSINCHU, and must NEVER
// regress back to the old KM-table-as-authority behavior that let it
// leak through in real Production (see this module's own header + V2.4.4
// entry in 07_KNOWN_ISSUES.md). No coordinate was ever available for the
// real leaked event either — this is the real-world shape: text alone.
// =============================================================================

test('CASE 3 (PERMANENT REGRESSION LOCK): 台61線 39K+600, 桃園市觀音區白玉里, no coordinate -> OUTSIDE_HSINCHU, never CONFIRMED_HSINCHU again', () => {
  const event = {
    source: 'highway',
    road: '台61線',
    startKM: '39K+600',
    endKM: '39K+600',
    description: '西濱公路南向39K+600附近，桃園市觀音區白玉里，雙向道路封閉',
  };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.match(result.reason, /text_explicit_non_hsinchu_place:桃園/);
  // The KM heuristic is NEVER consulted to decide this — the module never
  // even reaches describeKmHeuristic() once the text tier resolves it,
  // proving text correctly overrides/pre-empts a table that (per the real
  // incident) would have wrongly said "inside".
});

test('CASE 3b: the SAME event with a real coordinate confirming 桃園 (25.035/121.033, west-coast 桃園觀音 vicinity) -> OUTSIDE_HSINCHU via the coordinate tier directly, KM/text never even needed', () => {
  const event = {
    source: 'highway',
    road: '台61線',
    startKM: '39K+600',
    endKM: '39K+600',
    longitude: 121.033,
    latitude: 25.035,
  };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.equal(result.reason, 'coordinate_outside_authoritative_boundary');
});

// =============================================================================
// CASE 4 — a coordinate that plainly disproves Hsinchu, even for a road
// whose KM table WOULD have said "inside" (proves coordinate evidence
// always wins over the demoted KM heuristic, order section 七/九).
// =============================================================================

test('CASE 4: 頭份市公所 coordinate (120.9143/24.6863, 苗栗縣) on a road the KM table treats as Hsinchu-relevant -> OUTSIDE_HSINCHU regardless', () => {
  const event = { source: 'freeway', road: '國道一號', startKM: '110K+000', endKM: '110K+000', longitude: 120.9143, latitude: 24.6863 };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.equal(result.reason, 'coordinate_outside_authoritative_boundary');
});

// =============================================================================
// CASE 5-6 — neighboring counties/cities, no coordinate, text tier only —
// each must resolve OUTSIDE_HSINCHU via its own explicit place name, never
// UNKNOWN (a named, recognized place is real negative evidence, not "no
// evidence").
// =============================================================================

test('CASE 5: 苗栗縣 named in text, no coordinate/KM -> OUTSIDE_HSINCHU via the text tier', () => {
  const event = { source: 'highway', road: '台13線', description: '苗栗縣公館鄉路段坍方' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.match(result.reason, /text_explicit_non_hsinchu_place:苗栗/);
});

test('CASE 6: 頭份 (bare, no 市 suffix) named in text -> OUTSIDE_HSINCHU (頭份/竹南/三灣 are explicitly OUT of scope per order section 五)', () => {
  const event = { source: 'highway', road: '台1線', description: '頭份路段車輛事故' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.match(result.reason, /text_explicit_non_hsinchu_place:頭份/);
});

// =============================================================================
// CASE 7 — explicit Hsinchu district/township text, no coordinate.
// =============================================================================

test('CASE 7: 竹東鎮 named in text, no coordinate -> CONFIRMED_HSINCHU via the text tier (township, 新竹縣)', () => {
  const event = { source: 'highway', road: '台3線', description: '竹東鎮軟橋路段事故' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(result.reason, 'text_explicit_hsinchu_district_or_township');
});

test('CASE 7b: 關西－橫山路段 (bare forms, no 鎮/鄉 suffix, the real TDX LocationDescription shape found during fixture remediation) -> CONFIRMED_HSINCHU', () => {
  const event = { source: 'highway', road: '台3線', location: '關西－橫山路段' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
});

// =============================================================================
// CASE 8 — no evidence at all -> UNKNOWN, fails closed exactly like
// OUTSIDE_HSINCHU downstream, never defaults to Hsinchu.
// =============================================================================

test('CASE 8: no coordinate, no placeable KM/road, no place-name text -> UNKNOWN (never assumed Hsinchu)', () => {
  const event = { source: 'freeway', road: '國道五號', description: '事故' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.equal(result.reason, 'no_reliable_geographic_evidence');
});

test('CASE 8b: a KM squarely inside the OLD heuristic table\'s range, but no coordinate and no text -> still UNKNOWN, never CONFIRMED_HSINCHU from KM alone', () => {
  const event = { source: 'freeway', road: '國道一號', startKM: '95K+000', endKM: '95K+000' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.UNKNOWN);
  // The KM heuristic is recorded as observability evidence only, never as
  // the decision — see evidence.kmHeuristic, never evidence.tier==='km'.
  assert.equal(result.evidence.tier, 'none');
  assert.ok(result.evidence.kmHeuristic);
});

// =============================================================================
// CASE 9 — the explicit anti-pattern: a travel-DIRECTION mention of 新竹
// must never be misread as the event's own location.
// =============================================================================

test('CASE 9: "往新竹方向" but the event itself is elsewhere (no coordinate, no Hsinchu place actually named as location) -> never CONFIRMED_HSINCHU from the word 新竹 alone', () => {
  const event = { source: 'freeway', road: '國道一號', description: '南向88K處車輛事故，往新竹方向車多壅塞' };
  const result = resolveTdxHsinchuGeography(event);
  // "往新竹方向" is stripped before matching — no coordinate/KM/other
  // place name is present, so this must fall through to UNKNOWN, not be
  // fooled into CONFIRMED_HSINCHU by the bare word "新竹" appearing in a
  // travel-direction phrase.
  assert.equal(result.status, HSINCHU_GEO_STATUS.UNKNOWN);
});

test('CASE 9b: "往新竹方向" PLUS a genuine coordinate elsewhere (苗栗市公所) -> OUTSIDE_HSINCHU via the coordinate tier, direction phrase never overrides real evidence', () => {
  const event = {
    source: 'freeway', road: '國道一號', description: '南向88K處車輛事故，往新竹方向車多壅塞',
    longitude: 120.8214, latitude: 24.5602,
  };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.equal(result.reason, 'coordinate_outside_authoritative_boundary');
});

test('CASE 9c: a genuine location statement ending in "…方向" without a 往/通往/前往 marker is NOT stripped (over-broad-stripping guard)', () => {
  const event = { source: 'highway', road: '台68線', description: '新竹市政府方向路段施工' };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
});

// =============================================================================
// CASE 10 — evidence priority: a coordinate always wins over conflicting
// text, and text always wins over conflicting KM (order section 七 priority).
// =============================================================================

test('CASE 10: text says 新竹市 but the real coordinate is 台北市政府 (121.5637/25.0375) -> OUTSIDE_HSINCHU, coordinate tier wins over text', () => {
  const event = {
    source: 'freeway', road: '國道一號', description: '新竹市路段事故',
    longitude: 121.5637, latitude: 25.0375,
  };
  const result = resolveTdxHsinchuGeography(event);
  assert.equal(result.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.equal(result.evidence.tier, 'coordinate');
});

// =============================================================================
// Structural / defensive checks.
// =============================================================================

test('isPointInRings: a simple known square correctly separates inside from outside (unit-level check of the ray-casting primitive itself)', () => {
  const square = [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]];
  assert.equal(isPointInRings(0.5, 0.5, square), true);
  assert.equal(isPointInRings(2, 2, square), false);
});

test('resolveTdxHsinchuGeography never throws on a missing/malformed event -> UNKNOWN', () => {
  assert.equal(resolveTdxHsinchuGeography(null).status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.equal(resolveTdxHsinchuGeography(undefined).status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.equal(resolveTdxHsinchuGeography({}).status, HSINCHU_GEO_STATUS.UNKNOWN);
});

test('resolveTdxHsinchuGeography is deterministic, synchronous, pure — calling it twice with the same input yields identical results', () => {
  const event = { source: 'freeway', longitude: 120.9686, latitude: 24.8066 };
  const a = resolveTdxHsinchuGeography(event);
  const b = resolveTdxHsinchuGeography(event);
  assert.deepEqual(a, b);
});
