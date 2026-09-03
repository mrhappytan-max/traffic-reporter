// V2.4.7 — 路況工程部｜V2.4.6 TDX 地理資料缺失查修施工令
// (V2_4_6_TDX_GEO_INPUT_MISSING_DIAGNOSIS_AND_FIX).
//
// Real Production event: EVENT_ID=A15040100H-01-20260903103244766100023
// (TDX｜高公局, 國道三號 北向 79K+000 其他異常告警-散落物). §一 read-only
// code-path audit found NO bug in tdx/normalize.js's structured-field
// extraction itself (unconditional, every candidate field genuinely
// absent for this event) — the real gap is structural: tdx/normalize.js
// never had a description-text KM fallback at all (pbs/normalize.js has
// long had an analogous one for PBS's own `displayKM`). Fixed by reusing
// hsinchuFilter.js's own TDX-KM-token shape (parseKM's pattern) via a new
// extractKmTokenFromText(), never a second/independent KM-string format.
//
// SAFETY (order section 四, verified by CASE 7 below): a successfully
// parsed KM is stored as `startKM`/`endKM` in the SAME string shape a
// structured field already carries, so it only ever reaches
// hsinchuGeoResolver.js's Tier-2 KM-heuristic tier — which remains
// permanently OBSERVABILITY-ONLY (unchanged this round) and can never by
// itself produce CONFIRMED_HSINCHU. Zero change to any Gate A drop
// decision, the geo resolver's own tier logic, the road-management gate,
// the AI prompt, or LINE policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { extractKmTokenFromText, parseKM } from '../src/traffic/hsinchuFilter.js';
import { resolveTdxHsinchuGeography, HSINCHU_GEO_STATUS } from '../src/tdx/hsinchuGeoResolver.js';

function freewayRaw(overrides = {}) {
  return {
    EventID: 'A15040100H-01-20260903103244766100023',
    EventType: '事故',
    EventSubType: '其他異常告警-散落物',
    Description: '國道三號 北向 79K+000 其他異常告警-散落物',
    EffectiveTime: '2026-09-03T10:32:44+08:00',
    LastUpdateTime: '2026-09-03T10:32:44+08:00',
    RoadName: '國道三號',
    Direction: '北向',
    ...overrides,
  };
}

// =======================================================================
// extractKmTokenFromText — pure unit coverage.
// =======================================================================

test('extractKmTokenFromText: "79K+000" embedded in free text -> "79K+000" token', () => {
  assert.equal(extractKmTokenFromText('國道三號 北向 79K+000 其他異常告警-散落物'), '79K+000');
});

test('extractKmTokenFromText: "79K+500" -> "79K+500" token, parseKM -> 79.5', () => {
  const token = extractKmTokenFromText('北向79K+500處車輛拋錨');
  assert.equal(token, '79K+500');
  assert.equal(parseKM(token), 79.5);
});

test('extractKmTokenFromText: bare "80K" (no +NNN) -> "80K" token, parseKM -> 80', () => {
  const token = extractKmTokenFromText('南向80K附近施工');
  assert.equal(token, '80K');
  assert.equal(parseKM(token), 80);
});

test('extractKmTokenFromText: no KM-shaped text -> null (never guesses)', () => {
  assert.equal(extractKmTokenFromText('國道三號 北向 車流量大'), null);
  assert.equal(extractKmTokenFromText(''), null);
  assert.equal(extractKmTokenFromText(null), null);
});

// =======================================================================
// CASE 1-3 — tdx/normalize.js's own description-text KM fallback.
// =======================================================================

test('CASE 1: 國3 北向 79K+000 其他異常告警-散落物 (real event shape, no structured KM at all) -> startKM/endKM/displayKM correctly recovered from Description', () => {
  const event = normalizeRoadEvent(freewayRaw(), 'freeway');
  assert.equal(event.startKM, '79K+000');
  assert.equal(event.endKM, '79K+000');
  assert.equal(event.displayKM, 79);
  assert.equal(event.road, '國道三號');
  assert.equal(event.direction, '北向');
  assert.equal(event.provenance.kmSource.field, 'description-text-fallback');
});

test('CASE 2: "79K+500" in description -> displayKM 79.5', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道三號 北向 79K+500 其他異常告警-散落物' }), 'freeway');
  assert.equal(event.startKM, '79K+500');
  assert.equal(event.displayKM, 79.5);
});

test('CASE 3: bare "80K" in description (no +NNN) -> displayKM 80', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道三號 北向 80K 其他異常告警-散落物' }), 'freeway');
  assert.equal(event.startKM, '80K');
  assert.equal(event.displayKM, 80);
});

// =======================================================================
// CASE 4 — structured KM, when present, is NEVER overridden by the text
// fallback (order's own "structured KM 優先，不被 description 覆蓋").
// =======================================================================

test('CASE 4: structured Location.FreeExpressHighway.StartKM present -> used as-is, description text (even with a DIFFERENT KM) never overrides it', () => {
  const event = normalizeRoadEvent(
    freewayRaw({
      Description: '國道三號 北向 79K+000 其他異常告警-散落物（結構化欄位另有其他公里數）',
      Location: { FreeExpressHighway: { Road: '國道三號', Direction: '北向', StartKM: '93K+500', EndKM: '93K+000' } },
    }),
    'freeway'
  );
  assert.equal(event.startKM, '93K+500'); // the STRUCTURED value, not the "79K+000" in the text
  assert.equal(event.endKM, '93K+000');
  assert.equal(event.displayKM, 93.5);
  assert.equal(event.provenance.kmSource, undefined); // fallback never even attempted
});

// =======================================================================
// CASE 5 — no KM anywhere (structured or text) -> never guessed.
// =======================================================================

test('CASE 5: no structured KM, no KM-shaped text in description -> displayKM stays absent, never fabricated', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道三號北向車流回堵' }), 'freeway');
  assert.equal(event.displayKM, undefined);
  assert.equal(event.provenance.kmSource, undefined);
});

// =======================================================================
// CASE 6 — PBS events completely unaffected.
// =======================================================================

test('CASE 6: a PBS event (never touches tdx/normalize.js at all) is completely unaffected by this fix', () => {
  const pbsEvent = normalizePbsEvent({
    UID: 'PBS-1', road: '國道三號', areaNm: '國道三號北向', direction: '北向',
    comment: '北向79K處其他異常告警散落物', happendate: '2026-09-03', happentime: '10:32:44', modDttm: '2026-09-03 10:32:44',
  });
  // PBS's own long-standing displayKM path (pbs/normalize.js) is
  // untouched by this round — still whatever it always was, never routed
  // through tdx/normalize.js's new fallback.
  assert.equal(pbsEvent.source, 'pbs');
  assert.equal(pbsEvent.road, '國道三號');
});

// =======================================================================
// CASE 7 (order section 四, non-negotiable safety requirement) — a
// successfully-parsed KM does NOT by itself confirm Hsinchu; the geo
// resolver still correctly returns UNKNOWN with zero coordinate/text
// evidence, and the event is still NOT AI-eligible.
// =======================================================================

test('CASE 7: KM successfully parsed (79K+000, inside the KM-heuristic table\'s observability range) but no coordinate/place-name evidence -> Geographic Resolver still UNKNOWN, never CONFIRMED_HSINCHU from KM alone', () => {
  const event = normalizeRoadEvent(freewayRaw(), 'freeway');
  assert.equal(event.displayKM, 79); // KM WAS recovered
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.UNKNOWN); // still UNKNOWN -> still 0 AI, 0 LINE
  assert.notEqual(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  // The KM-heuristic tier now has real evidence to show (observability
  // improvement), but it is explicitly documented as never authoritative.
  assert.equal(geo.evidence.kmHeuristic.kmAvailable, true);
  assert.equal(geo.evidence.tier, 'none'); // no tier actually DECIDED the outcome
});

test('CASE 7b: the SAME event WITH a real coordinate inside Hsinchu -> CONFIRMED_HSINCHU via the coordinate tier, proving KM alone never decided CASE 7\'s UNKNOWN result', () => {
  const event = normalizeRoadEvent(
    freewayRaw({ Positions: [{ PositionLon: 120.9686, PositionLat: 24.8066 }] }),
    'freeway'
  );
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
});
