// V2.4.5 — V2_4_5_TDX_ROAD_MANAGEMENT_POLICY_GATE dedicated test suite.
//
// This is the supplement order's own required CASE 1-10 coverage for
// src/tdx/roadManagementPolicyGate.js in isolation — pure, synchronous,
// zero I/O. Ad-hoc `node -e` smoke tests during construction already
// verified every one of these scenarios (including the two bugs found
// and fixed then — classifyByKeyword() masking a closure signal on
// construction-typed text, and a too-broad bare "封閉" pattern); this
// file is that same coverage, committed as a real, permanent regression
// suite. Assumes every event here has ALREADY passed the Hsinchu
// geography gate (tdx/hsinchuGeoResolver.js) — this module's own scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTdxRoadManagementEligibility,
  parseTrustedBlockedLanesCount,
  ROAD_MANAGEMENT_GATE_REASON,
} from '../src/tdx/roadManagementPolicyGate.js';

// =============================================================================
// CASE 1-2 — dynamic shoulder open/close: never eligible, unconditional.
// =============================================================================

test('CASE 1: 機動路肩開放 (dynamicShoulder.state=OPEN) -> ineligible, road-shoulder-open', () => {
  const event = { type: 'control', dynamicShoulder: { state: 'OPEN', evidence: { field: 'Description', value: '機動開放路肩' } } };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.SHOULDER_OPEN);
});

test('CASE 2: 機動路肩關閉 (dynamicShoulder.state=STOPPED) -> ineligible, road-shoulder-close', () => {
  const event = { type: 'control', dynamicShoulder: { state: 'STOPPED', evidence: { field: 'Description', value: '機動路肩關閉' } } };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.SHOULDER_CLOSE);
});

// =============================================================================
// CASE 3-4 — routine construction, 0/1 blocked lanes -> ineligible.
// =============================================================================

test('CASE 3: 一般施工, blockedLanes=0 -> ineligible, construction-insufficient-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '內側車道施工作業', blockedLanes: 0 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_INSUFFICIENT_LANES);
});

test('CASE 4: 一般施工, blockedLanes=1 -> ineligible, construction-insufficient-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '外側車道封閉施工', blockedLanes: 1 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_INSUFFICIENT_LANES);
});

// =============================================================================
// CASE 5-6 — routine construction, >=2 blocked lanes -> eligible (AI
// eligibility only, NOT an automatic LINE push).
// =============================================================================

test('CASE 5: 一般施工, blockedLanes=2 -> eligible, construction-sufficient-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '外側及中線車道封閉施工', blockedLanes: 2 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_SUFFICIENT_LANES);
});

test('CASE 6: 一般施工, blockedLanes=3 -> eligible, construction-sufficient-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '三車道封閉施工', blockedLanes: 3 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_SUFFICIENT_LANES);
});

// =============================================================================
// CASE 7 — data-insufficiency: missing/unparseable blockedLanes -> ineligible
// (fail-closed, never assumed eligible).
// =============================================================================

test('CASE 7: 一般施工, blockedLanes missing entirely -> ineligible, construction-unknown-blocked-lanes (fail-closed, not fail-open)', () => {
  const event = { type: 'construction', title: '施工', description: '車道施工作業' };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_UNKNOWN_LANES);
});

test('CASE 7b: 一般施工, blockedLanes unparseable ("多") -> ineligible, construction-unknown-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '車道施工作業', blockedLanes: '多' };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_UNKNOWN_LANES);
});

test('CASE 7c: 一般施工, blockedLanes negative (-1, untrustworthy) -> ineligible, construction-unknown-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '車道施工作業', blockedLanes: -1 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_UNKNOWN_LANES);
});

test('CASE 7d: 一般施工, blockedLanes fractional (1.5, not a whole number) -> ineligible, construction-unknown-blocked-lanes', () => {
  const event = { type: 'construction', title: '施工', description: '車道施工作業', blockedLanes: 1.5 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_UNKNOWN_LANES);
});

// =============================================================================
// CASE 8-9 — the explicit anti-false-positive requirement: a genuinely
// major event must NOT be misjudged as routine construction just because
// it also contains "施工"/is classified 'construction'.
// =============================================================================

test('CASE 8: 施工造成雙向道路完全封閉 (type=construction, but textually a major closure) -> eligible via the escape valve, never blocked by the lane-count gate', () => {
  const event = { type: 'construction', title: '施工事故', description: '施工造成雙向道路完全封閉', blockedLanes: 0 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.MAJOR_EVENT_ESCAPE_VALVE);
});

test('CASE 9: 施工工地發生車禍事故 (type=construction, but textually a real accident) -> eligible via the escape valve', () => {
  const event = { type: 'construction', title: '施工路段事故', description: '施工工地發生車禍事故，人員受傷', blockedLanes: 1 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.MAJOR_EVENT_ESCAPE_VALVE);
});

test('CASE 9b: 施工路段坍方 (non-collision anomaly keyword, via detectNonCollisionAnomaly reuse) -> eligible via the escape valve', () => {
  const event = { type: 'construction', title: '施工路段坍方', description: '施工便道坍方，請小心慢行', blockedLanes: 0 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.MAJOR_EVENT_ESCAPE_VALVE);
});

test('the escape valve does NOT over-trigger on ordinary lane-closure construction text containing a bare "封閉" ("外側車道封閉施工") — narrower than tdx/classify.js\'s own generic closure list', () => {
  const event = { type: 'construction', title: '施工', description: '外側車道封閉施工', blockedLanes: 2 };
  const result = resolveTdxRoadManagementEligibility(event);
  // Must resolve via the ORDINARY lane-count path, not the escape valve —
  // proves bare "封閉" alone never trips MAJOR_CLOSURE_KEYWORD_PATTERNS.
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_SUFFICIENT_LANES);
});

// =============================================================================
// CASE 10 — this gate's own scope never expands beyond what the order
// asks: the geography gate (a separate module) must run FIRST and this
// gate must never let a high lane count override a geography rejection.
// This module itself has no geography awareness at all — it is exercised
// here purely to document/lock the contract that tdxQueueIngress.js's own
// two-step Gate A (geography, then this) enforces geography FIRST; see
// tdxQueueIngress.test.js for the actual end-to-end ordering proof.
// =============================================================================

test('CASE 10 (documentation of scope): this module alone has no geography awareness — a 桃園 event with blockedLanes=3 would still show eligible=true from THIS gate in isolation; tdxQueueIngress.js\'s own geography-first ordering (not this module) is what actually blocks it end-to-end', () => {
  const event = { type: 'construction', title: '施工', description: '桃園市觀音區施工路段，三車道封閉', blockedLanes: 3 };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true); // by design — geography is a separate, earlier gate
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.CONSTRUCTION_SUFFICIENT_LANES);
});

// =============================================================================
// Non-construction, non-shoulder types — untouched, always eligible from
// THIS gate's perspective (order section 四's explicit scope limit).
// =============================================================================

test('an accident event is never in this gate\'s scope -> always eligible, not-road-management-event', () => {
  const event = { type: 'accident', title: '車禍事故', description: '北向92K車輛事故' };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.NOT_ROAD_MANAGEMENT);
});

test('a closure event (type=closure, not construction) is never in this gate\'s scope -> always eligible', () => {
  const event = { type: 'closure', title: '道路封閉', description: '道路坍方全線封閉' };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.NOT_ROAD_MANAGEMENT);
});

test('a congestion event is never in this gate\'s scope -> always eligible', () => {
  const event = { type: 'congestion', title: '壅塞', description: '南向回堵' };
  const result = resolveTdxRoadManagementEligibility(event);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, ROAD_MANAGEMENT_GATE_REASON.NOT_ROAD_MANAGEMENT);
});

// =============================================================================
// parseTrustedBlockedLanesCount — direct unit coverage of the numeric
// parsing discipline this gate's construction branch depends on.
// =============================================================================

test('parseTrustedBlockedLanesCount: a clean non-negative integer (number or numeric string) parses correctly', () => {
  assert.equal(parseTrustedBlockedLanesCount(2), 2);
  assert.equal(parseTrustedBlockedLanesCount('3'), 3);
  assert.equal(parseTrustedBlockedLanesCount(0), 0);
});

test('parseTrustedBlockedLanesCount: missing/empty/non-numeric/negative/fractional all return null (untrustworthy)', () => {
  assert.equal(parseTrustedBlockedLanesCount(undefined), null);
  assert.equal(parseTrustedBlockedLanesCount(null), null);
  assert.equal(parseTrustedBlockedLanesCount(''), null);
  assert.equal(parseTrustedBlockedLanesCount('多'), null);
  assert.equal(parseTrustedBlockedLanesCount(-1), null);
  assert.equal(parseTrustedBlockedLanesCount(1.5), null);
});

test('resolveTdxRoadManagementEligibility never throws on a missing/malformed event -> ineligible, not-road-management-event', () => {
  const a = resolveTdxRoadManagementEligibility(null);
  assert.equal(a.eligible, false);
  assert.equal(a.reason, ROAD_MANAGEMENT_GATE_REASON.NOT_ROAD_MANAGEMENT);
  const b = resolveTdxRoadManagementEligibility(undefined);
  assert.equal(b.eligible, false);
});
