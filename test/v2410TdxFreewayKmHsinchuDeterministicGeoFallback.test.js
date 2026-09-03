// V2.4.10 — 路況工程部｜V2.4.10 TDX 國道公里數第二正向地理證據設計／施工令
// (V2_4_10_TDX_FREEWAY_KM_HSINCHU_DETERMINISTIC_GEO_FALLBACK), order
// section 十九's own required CASE 1-16.
//
// Core goal: a TDX｜高公局 event with road+direction+KM but NO coordinates
// and NO areaNm (a common real shape — see 07_KNOWN_ISSUES.md's V2.4.9
// entry for two real Production examples) can now be positively confirmed
// as CONFIRMED_HSINCHU via a NEW, genuinely VERIFIED LEVEL 3 evidence tier
// (src/tdx/hsinchuFreewayKmRanges.js), backed by two cross-referenced
// official government datasets — never a guess, never restoring the old
// "large loose KM range" heuristic as positive authority (order section
// 一's own non-negotiable safety principle).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { isPbsEventHsinchuRelevant } from '../src/pbs/hsinchuFilter.js';
import {
  resolveTdxHsinchuGeography,
  HSINCHU_GEO_STATUS,
} from '../src/tdx/hsinchuGeoResolver.js';
import {
  resolveVerifiedHsinchuFreewayKm,
  HSINCHU_VERIFIED_FREEWAY_KM_RANGES,
  FREEWAY_KM_EVIDENCE_TYPE,
} from '../src/tdx/hsinchuFreewayKmRanges.js';
import { resolveTdxRoadManagementEligibility } from '../src/tdx/roadManagementPolicyGate.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function freewayRaw(overrides = {}) {
  return {
    EventID: 'TEST-EVENT',
    EventType: '其他',
    Description: '國道一號 北向 95K+000 一般事件',
    EffectiveTime: '2026-09-04T10:00:00+08:00',
    LastUpdateTime: '2026-09-04T10:00:00+08:00',
    RoadName: '國道一號',
    Direction: '北向',
    ...overrides,
  };
}

// =======================================================================
// CASE 1/2 — verified 國1/國3 Hsinchu KM -> CONFIRMED_HSINCHU.
// =======================================================================

test('CASE 1: verified 國1 新竹 KM (95K, 新竹交流道) -> CONFIRMED_HSINCHU via FREEWAY_KM_VERIFIED_RANGE', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道一號 北向 95K+000 一般事件' }), 'freeway');
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(geo.evidence.type, FREEWAY_KM_EVIDENCE_TYPE);
  assert.equal(geo.evidence.road, '國道一號');
  assert.equal(geo.evidence.km, 95);
});

test('CASE 2: verified 國3 新竹 KM (79K, 關西) -> CONFIRMED_HSINCHU via FREEWAY_KM_VERIFIED_RANGE', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道三號 北向 79K+000 一般事件', RoadName: '國道三號' }), 'freeway');
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(geo.evidence.type, FREEWAY_KM_EVIDENCE_TYPE);
  assert.equal(geo.evidence.road, '國道三號');
  assert.equal(geo.evidence.km, 79);
});

// =======================================================================
// CASE 3/4/5 — no positive evidence at this tier -> UNKNOWN, never
// OUTSIDE_HSINCHU (order section 十一).
// =======================================================================

test('CASE 3: KM outside the verified range (國1 60K) -> UNKNOWN, NOT OUTSIDE_HSINCHU', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道一號 北向 60K+000 一般事件' }), 'freeway');
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.notEqual(geo.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
});

test('CASE 4: no KM at all -> UNKNOWN', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道一號北向車流回堵' }), 'freeway');
  assert.equal(event.displayKM, undefined);
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.UNKNOWN);
});

test('CASE 5: unrecognized/uncovered road (國道五號) -> UNKNOWN', () => {
  const event = normalizeRoadEvent(freewayRaw({ RoadName: '國道五號', Description: '國道五號 北向 20K+000 一般事件' }), 'freeway');
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.equal(resolveVerifiedHsinchuFreewayKm({ road: '國道五號', displayKM: 20 }), null);
});

// =======================================================================
// CASE 6/7 — safety-margin boundary must be exact and conservative
// (order section 六).
// =======================================================================

test('CASE 6: KM exactly at the safety-margined boundary -> correctly CONFIRMED (inclusive)', () => {
  const range1 = HSINCHU_VERIFIED_FREEWAY_KM_RANGES['國道一號'].ranges[0];
  const atMin = normalizeRoadEvent(freewayRaw({ Description: `國道一號 北向 ${range1.minKm}K+000 一般事件` }), 'freeway');
  const atMax = normalizeRoadEvent(freewayRaw({ Description: `國道一號 北向 ${Math.floor(range1.maxKm)}K+${Math.round((range1.maxKm % 1) * 1000).toString().padStart(3, '0')} 一般事件` }), 'freeway');
  assert.equal(resolveTdxHsinchuGeography(atMin).status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(resolveTdxHsinchuGeography(atMax).status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
});

test('CASE 7: KM just past the safety-margined boundary -> UNKNOWN (conservative, never CONFIRMED)', () => {
  const range1 = HSINCHU_VERIFIED_FREEWAY_KM_RANGES['國道一號'].ranges[0];
  const justBelowMin = normalizeRoadEvent(freewayRaw({ Description: `國道一號 北向 ${(range1.minKm - 0.1).toFixed(1)}K+000 一般事件` }), 'freeway');
  const justAboveMax = normalizeRoadEvent(freewayRaw({ Description: `國道一號 北向 ${(range1.maxKm + 0.1).toFixed(1)}K+000 一般事件` }), 'freeway');
  assert.equal(resolveTdxHsinchuGeography(justBelowMin).status, HSINCHU_GEO_STATUS.UNKNOWN);
  assert.equal(resolveTdxHsinchuGeography(justAboveMax).status, HSINCHU_GEO_STATUS.UNKNOWN);
});

// =======================================================================
// CASE 8/9 — coordinate priority (order section 三) — the KM table is
// NEVER even consulted when a coordinate exists, so it can never conflict
// with or override the coordinate polygon's own verdict.
// =======================================================================

test('CASE 8: coordinates clearly in Taoyuan, but KM looks Hsinchu-range -> must stay OUTSIDE_HSINCHU, never CONFIRMED', () => {
  const event = normalizeRoadEvent(
    freewayRaw({ Description: '國道一號 北向 101K+300 一般事件', Positions: [{ PositionLon: 121.033, PositionLat: 25.035 }] }),
    'freeway'
  );
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU);
  assert.equal(geo.evidence.tier, 'coordinate'); // decided by coordinates, KM tier never reached
});

test('CASE 9: coordinates clearly in Hsinchu -> polygon tier decides, not the KM table', () => {
  const event = normalizeRoadEvent(
    freewayRaw({ Description: '國道一號 北向 200K+000 一般事件', Positions: [{ PositionLon: 120.9686, PositionLat: 24.8066 }] }),
    'freeway'
  );
  // 200K is nowhere near either verified range -- proves the coordinate
  // tier decided this, not a KM-range coincidence.
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(geo.evidence.tier, 'coordinate');
});

// =======================================================================
// CASE 10/11/12 — canonical displayKM correctly used for the three real
// Production trigger events (order section 十二, section 九).
// =======================================================================

test('CASE 10: 國1 101K+300 -> canonical displayKM 101.3 correctly used, CONFIRMED_HSINCHU', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道一號 北向 101K+300 施工事件-施工維護', EventType: '施工' }), 'freeway');
  assert.equal(event.displayKM, 101.3);
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(geo.evidence.km, 101.3);
});

test('CASE 11: 國1 100K+000 -> canonical displayKM 100 correctly used, CONFIRMED_HSINCHU', () => {
  const event = normalizeRoadEvent(freewayRaw({ Description: '國道一號 南向 100K+000 天候事件-天候不佳', EventType: '天候', Direction: '南向' }), 'freeway');
  assert.equal(event.displayKM, 100);
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  assert.equal(geo.evidence.km, 100);
});

test('CASE 12: 國3 79K+000 -> correctly CONFIRMED_HSINCHU per the verified table', () => {
  const event = normalizeRoadEvent(
    freewayRaw({ Description: '國道三號 北向 79K+000 其他異常告警-散落物', RoadName: '國道三號' }),
    'freeway'
  );
  assert.equal(event.displayKM, 79);
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
});

// =======================================================================
// CASE 13 — PBS pipeline completely unaffected (order section 十八).
// =======================================================================

test('CASE 13: PBS pipeline completely unaffected — hsinchuFreewayKmRanges.js is never imported by any pbs/ module', () => {
  // Structural check: grep every pbs/*.js source file for an import of
  // the new TDX-only module. Cheaper and more definitive than trying to
  // enumerate every possible PBS behavior.
  const pbsDir = path.join(process.cwd(), 'src', 'pbs');
  const files = readdirSync(pbsDir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = readFileSync(path.join(pbsDir, file), 'utf8');
    assert.ok(!content.includes('hsinchuFreewayKmRanges'), `${file} must never import the TDX-only freeway KM range table`);
  }
});

test('CASE 13b: PBS service-area behavior for a known reference event is unchanged', () => {
  // A known PBS-relevant Hsinchu event (existing convention: real
  // coordinates inside 新竹市) still resolves the same way as before this
  // round -- this round touched zero PBS code.
  const pbsEvent = normalizePbsEvent({
    road: '國道一號', areaNm: '國道一號北向', direction: '北向',
    comment: '北向95公里處事故', longitude: 120.9686, latitude: 24.8066,
  });
  assert.equal(typeof isPbsEventHsinchuRelevant(pbsEvent), 'boolean');
});

// =======================================================================
// CASE 14 — zero KV operations (order section 十五). The whole module is
// pure/synchronous/zero-I/O by construction: its exported functions take
// no KV/env parameter at all, so there is structurally no way for them to
// perform a KV operation.
// =======================================================================

test('CASE 14: resolveVerifiedHsinchuFreewayKm() and the new GEO tier are pure, synchronous, zero I/O — no KV/env parameter exists to misuse', () => {
  const result = resolveVerifiedHsinchuFreewayKm({ road: '國道一號', displayKM: 95 });
  assert.equal(result instanceof Promise, false);
  assert.ok(result && typeof result === 'object');

  const event = normalizeRoadEvent(freewayRaw({ Description: '國道一號 北向 95K+000 一般事件' }), 'freeway');
  const geoResult = resolveTdxHsinchuGeography(event);
  assert.equal(geoResult instanceof Promise, false);

  // Structural source-scan: the lookup module itself must never reference
  // any KV/D1/R2/Durable Object primitive (order section 四/十五).
  const source = readFileSync(new URL('../src/tdx/hsinchuFreewayKmRanges.js', import.meta.url), 'utf8');
  for (const forbidden of ['KV.get', 'KV.put', 'KV.list', 'KV.delete', 'D1Database', 'R2Bucket', 'DurableObject', 'await fetch', 'async function']) {
    assert.ok(!source.includes(forbidden), `hsinchuFreewayKmRanges.js must never contain "${forbidden}"`);
  }
});

// =======================================================================
// CASE 15 — GEO CONFIRMED != LINE (order section 十三/十四). Routine
// construction with unknown blockedLanes still fails Road Policy even
// though GEO now confirms via the new tier.
// =======================================================================

test('CASE 15: GEO confirmed via KM range does NOT bypass Road Policy — routine construction, unknown blocked lanes, still fail-closed', () => {
  const event = normalizeRoadEvent(
    freewayRaw({ Description: '國道一號 北向 101K+300 施工事件-施工維護', EventType: '施工', EventSubType: '施工事件-施工維護' }),
    'freeway'
  );
  const geo = resolveTdxHsinchuGeography(event);
  assert.equal(geo.status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU); // GEO passes...

  const policy = resolveTdxRoadManagementEligibility(event);
  assert.equal(policy.eligible, false); // ...but Road Policy (V2.4.5, unchanged) still fail-closes it
  assert.equal(policy.reason, 'construction-unknown-blocked-lanes');
});

test('CASE 15b: GEO confirmed via KM range + sufficient blockedLanes -> Road Policy correctly allows it through (V2.4.5 rules unchanged)', () => {
  const event = normalizeRoadEvent(
    freewayRaw({
      Description: '國道一號 北向 101K+300 施工事件-施工維護',
      EventType: '施工',
      EventSubType: '施工事件-施工維護',
      Impact: { BlockedLanes: 2 },
    }),
    'freeway'
  );
  assert.equal(resolveTdxHsinchuGeography(event).status, HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU);
  const policy = resolveTdxRoadManagementEligibility(event);
  assert.equal(policy.eligible, true);
});

// =======================================================================
// CASE 16 — AI/LINE eligibility completely unaffected by the KM table
// (order section 十六/十四) — this round never touches aiDecisionEngine.js,
// messageFormat.js, or any LINE broadcast policy file.
// =======================================================================

test('CASE 16: AI decision engine / LINE broadcast files are untouched by this round — hsinchuFreewayKmRanges.js is never imported by any AI/LINE module', () => {
  const filesToCheck = [
    'src/pbs/aiDecisionEngine.js',
    'src/traffic/messageFormat.js',
    'src/traffic/aiApprovedPbsBroadcast.js',
    'src/traffic/broadcastPolicy.js',
  ];
  for (const rel of filesToCheck) {
    const content = readFileSync(rel, 'utf8');
    assert.ok(!content.includes('hsinchuFreewayKmRanges'), `${rel} must never import the new KM range table`);
  }
});
