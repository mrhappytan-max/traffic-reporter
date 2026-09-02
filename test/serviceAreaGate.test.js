// SERVICE AREA GATE | 八堵 Production regression (2026-08-24).
//
// Production pushed a PBS 國道1號南向 accident at 八堵 (基隆), well outside
// the service area. Geography was filtered only at PBS ingestion;
// broadcastPipeline.js documented the assumption and never enforced it, so
// anything reaching the broadcast layer by any other path inherited
// broadcast rights it was never granted.
//
// The 八堵 record below is the permanent regression fixture, with the real
// reported coordinates. It is asserted at BOTH layers — the resolver and
// the broadcast gate — because the bug was precisely that passing one did
// not imply passing the other.
//
// The other half of this file is just as important: the positive cases.
// A gate that blocks everything would also "fix" 八堵, and would be a far
// worse bug. Every serviced place has to keep broadcasting.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveServiceAreaEligibility, isWithinServiceArea } from '../src/traffic/serviceArea.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { getLinePushPolicyDecision } from '../src/traffic/broadcastPolicy.js';
import { crossSourceDedup } from '../src/pbs/crossSourceDedup.js';
import { isTdxRuntimeEnabled } from '../src/traffic/sourceMode.js';
import { getAccessToken } from '../src/tdx/auth.js';
import { prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';

const PBS_ONLY_ENV = {
  TRAFFIC_SOURCE_MODE: 'PBS_ONLY',
  TDX_CLIENT_ID: 'test-id',
  TDX_CLIENT_SECRET: 'test-secret',
};

/** The exact Production event that leaked. Do not soften this fixture. */
const BADU_ACCIDENT = {
  source: 'pbs',
  rawId: 'PBS-BADU-REGRESSION',
  type: 'accident',
  pbsCategory: 'accident',
  road: '國道一號',
  direction: '南向',
  location: '八堵交流道－大華系統交流道',
  description: '國道1號南向八堵交流道－大華系統交流道約3公里發生事故',
  latitude: 25.10288,
  longitude: 121.71801,
};

function pbsAccident(overrides) {
  return {
    source: 'pbs',
    rawId: 'PBS-OK',
    type: 'accident',
    pbsCategory: 'accident',
    direction: '南向',
    ...overrides,
  };
}

function withFetchSpy(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    throw new Error(`unexpected network call in test: ${String(url)}`);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const tdxCalls = (calls) => calls.filter((c) => c.url.includes('tdx.transportdata.tw'));

/**
 * The real broadcast gate's ordering up to and including the LINE push
 * policy — deliberately NOT the location-quality gate that follows it
 * (2026-08-24), because this file's subject is geography. Keeping the
 * mirror short here is what lets these fixtures stay minimal; the full
 * three-gate ordering is exercised in
 * test/pbsAccidentTraceLocationQuality.test.js.
 */
function broadcastDecision(event, env) {
  const area = resolveServiceAreaEligibility(event);
  if (!area.eligible) return { allowed: false, reason: area.reason };
  const base = getBroadcastEligibility(event);
  if (!base.eligible) return { allowed: false, reason: base.reason };
  return getLinePushPolicyDecision(event, env);
}

// --- check 1: the actual Production bug ---------------------------------

test('1. 八堵 PBS accident is BLOCKED — the Production regression case', () => {
  const area = resolveServiceAreaEligibility(BADU_ACCIDENT);
  assert.equal(area.eligible, false, '八堵 must never be service-area eligible');
  assert.equal(area.reason, 'outside-service-area');

  // And blocked at the broadcast gate, which is where it actually leaked.
  const decision = broadcastDecision(BADU_ACCIDENT, PBS_ONLY_ENV);
  assert.equal(decision.allowed, false, '八堵 must never broadcast');
  assert.equal(decision.reason, 'outside-service-area');

  // Its classification was never the problem — it really is an accident,
  // and it would sail through every non-geographic rule. Geography is the
  // only thing standing between it and a LINE push, which is exactly why
  // that check cannot be left as an assumption.
  assert.equal(getBroadcastEligibility(BADU_ACCIDENT).eligible, true);
  assert.equal(getLinePushPolicyDecision(BADU_ACCIDENT, PBS_ONLY_ENV).allowed, true);
});

test('1b. 八堵 stays blocked with coordinates stripped, and with no KM in the text', () => {
  // The leak's exact shape is unknown, so the fixture is degraded in every
  // direction a real record might be: no coords, no parseable KM, and
  // both together.
  const variants = [
    { ...BADU_ACCIDENT, latitude: null, longitude: null },
    { ...BADU_ACCIDENT, description: '八堵交流道－大華系統交流道發生事故' },
    {
      ...BADU_ACCIDENT,
      latitude: null,
      longitude: null,
      description: '八堵交流道－大華系統交流道發生事故',
    },
    // Swapped lat/lng is a real-world data hazard; it must not become a pass.
    { ...BADU_ACCIDENT, latitude: 121.71801, longitude: 25.10288 },
  ];
  for (const [i, v] of variants.entries()) {
    assert.equal(isWithinServiceArea(v), false, `八堵 variant ${i} must stay blocked`);
    assert.equal(broadcastDecision(v, PBS_ONLY_ENV).allowed, false, `八堵 variant ${i} must not broadcast`);
  }
});

test('1c. other out-of-area places are blocked too — the rule is geography, not a 八堵 special case', () => {
  const outside = [
    ['基隆市', 25.1276, 121.7392],
    ['台北市', 25.033, 121.5654],
    ['桃園 (非服務區段)', 24.9937, 121.301],
    ['台中市', 24.1477, 120.6736],
    ['高雄市', 22.6273, 120.3014],
  ];
  for (const [name, latitude, longitude] of outside) {
    const event = pbsAccident({ road: '國道一號', latitude, longitude, description: `${name}事故`, location: name });
    assert.equal(isWithinServiceArea(event), false, `${name} must be outside`);
  }
});

// --- checks 2-7: the positive cases must keep working -------------------

test('2-5. 新竹／竹北／竹南／頭份 國道1號 accidents still broadcast', () => {
  const inside = [
    ['新竹市', 24.8039, 120.9647],
    ['竹北', 24.8387, 121.0125],
    ['竹南', 24.6857, 120.876],
    ['頭份', 24.6883, 120.908],
  ];
  for (const [name, latitude, longitude] of inside) {
    const event = pbsAccident({
      rawId: `PBS-${name}`,
      road: '國道一號',
      latitude,
      longitude,
      location: name,
      description: `國道1號南向${name}路段發生事故`,
    });
    assert.equal(isWithinServiceArea(event), true, `${name} must be inside the service area`);
    const decision = broadcastDecision(event, PBS_ONLY_ENV);
    assert.equal(decision.allowed, true, `${name} accident must broadcast`);
  }
});

test('6. 國道3號 accidents inside the service area still broadcast', () => {
  for (const [name, latitude, longitude] of [
    ['新竹', 24.8039, 120.9647],
    ['竹北', 24.8387, 121.0125],
    ['竹南', 24.6857, 120.876],
    ['頭份', 24.6883, 120.908],
  ]) {
    const event = pbsAccident({
      rawId: `PBS-N3-${name}`,
      road: '國道三號',
      latitude,
      longitude,
      location: name,
      description: `國道3號南向${name}路段發生事故`,
    });
    assert.equal(isWithinServiceArea(event), true, `國3 ${name} must be inside`);
    assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true, `國3 ${name} must broadcast`);
  }
});

test('7. 省道 accidents inside the service area still broadcast', () => {
  for (const [road, name, latitude, longitude] of [
    ['台1線', '新竹', 24.8039, 120.9647],
    ['台3線', '竹東', 24.7361, 121.0886],
    ['台61線', '竹北', 24.8387, 121.0125],
    ['台68線', '新竹', 24.8039, 120.9647],
  ]) {
    const event = pbsAccident({
      rawId: `PBS-${road}`,
      road,
      latitude,
      longitude,
      location: name,
      description: `${road}${name}路段發生事故`,
    });
    assert.equal(isWithinServiceArea(event), true, `${road} ${name} must be inside`);
    assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true, `${road} ${name} must broadcast`);
  }
});

// --- checks 6-7 of the order: the two gates are INDEPENDENT -------------

test('8. PBS_ONLY + inside the area + NO TDX match -> broadcasts', () => {
  const event = pbsAccident({
    rawId: 'PBS-NO-TDX',
    road: '國道一號',
    latitude: 24.8039,
    longitude: 120.9647,
    location: '新竹市',
    description: '國道1號南向新竹路段發生事故',
  });
  // No TDX events at all, and the freeway gate bypassed as in PBS_ONLY.
  const out = crossSourceDedup([event], [], { requireTdxCorrelationForFreeway: isTdxRuntimeEnabled(PBS_ONLY_ENV) });
  assert.equal(out.uniquePbsEvents.length, 1, 'must survive the TDX correlation gate');
  assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true, 'and must broadcast');
});

test('9. PBS_ONLY + OUTSIDE the area + no TDX match -> blocked, even though the TDX gate let it past', () => {
  // This is the pairing that must never regress: bypassing TDX
  // correlation must not imply bypassing geography.
  const out = crossSourceDedup([BADU_ACCIDENT], [], {
    requireTdxCorrelationForFreeway: isTdxRuntimeEnabled(PBS_ONLY_ENV),
  });
  assert.equal(out.uniquePbsEvents.length, 1, 'the TDX gate no longer stops it — by design');
  // ...and the service area gate is what actually stops it.
  const decision = broadcastDecision(BADU_ACCIDENT, PBS_ONLY_ENV);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'outside-service-area');
});

// --- checks 8-10: TDX call counts unchanged -----------------------------

test('10. the service area gate is pure — 0 TDX RoadEvent calls, 0 token calls, no I/O at all', async () => {
  await withFetchSpy(async (calls) => {
    assert.equal(isTdxRuntimeEnabled(PBS_ONLY_ENV), false);
    await assert.rejects(() => getAccessToken(PBS_ONLY_ENV), /TDX runtime disabled/);

    resolveServiceAreaEligibility(BADU_ACCIDENT);
    resolveServiceAreaEligibility(pbsAccident({ road: '國道一號', latitude: 24.8039, longitude: 120.9647 }));

    assert.equal(tdxCalls(calls).length, 0, 'geography must never call TDX');
    assert.equal(calls.filter((c) => c.url.includes('openid-connect/token')).length, 0);
  });
});

// --- checks 11-12: CCTV unchanged ---------------------------------------

test('11-12. CCTV stays optional enrichment: failure never blocks an in-area accident', async () => {
  const event = pbsAccident({
    road: '國道一號',
    startKM: '95',
    endKM: '96',
    latitude: 24.8039,
    longitude: 120.9647,
    location: '新竹市',
    description: '國道1號南向新竹95公里處事故 車道封閉',
  });

  await withFetchSpy(async (calls) => {
    const attempted = await prepareCctvImageForEvent(PBS_ONLY_ENV, event);
    assert.equal(attempted.ok, false, 'no R2 binding in this test env');
    assert.notEqual(attempted.reason, 'cctv-image-disabled');
    assert.equal(tdxCalls(calls).length, 0, 'CCTV must never call TDX');

    const disabled = await prepareCctvImageForEvent({ ...PBS_ONLY_ENV, CCTV_IMAGE_ENABLED: 'false' }, event);
    assert.equal(disabled.ok, false);
    assert.equal(disabled.reason, 'cctv-image-disabled');
  });

  // Either way the accident still broadcasts, TEXT-ONLY.
  assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true);
});

// --- checks 13-14: the push policy is not widened -----------------------

test('13. dynamic shoulder inside the service area still does not push', () => {
  for (const state of ['OPEN', 'STOPPED']) {
    const event = pbsAccident({
      type: 'control',
      road: '國道一號',
      latitude: 24.8039,
      longitude: 120.9647,
      location: '新竹市',
      description: state === 'OPEN' ? '新竹機動開放路肩' : '新竹機動路肩停止開放',
      dynamicShoulder: { state, evidence: { field: 'Description', value: 'x' } },
    });
    assert.equal(isWithinServiceArea(event), true, 'in-area, so geography is not what stops it');
    const decision = broadcastDecision(event, PBS_ONLY_ENV);
    assert.equal(decision.allowed, false, `${state} must not push`);
    assert.equal(decision.reason, `policy-dynamic-shoulder-${state.toLowerCase()}`);
  }
});

test('14. non-accident events inside the service area still do not push', () => {
  for (const type of ['closure', 'control', 'construction', 'other', 'congestion']) {
    const event = pbsAccident({
      type,
      road: '國道一號',
      latitude: 24.8039,
      longitude: 120.9647,
      location: '新竹市',
      description: `國道1號南向新竹路段 ${type} 車道封閉`,
    });
    assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, false, type);
  }
});

// --- checks 15-16: contracts and ALL mode -------------------------------

test('15. the gate only ever subtracts, and never mutates the event', () => {
  const before = JSON.parse(JSON.stringify(BADU_ACCIDENT));
  resolveServiceAreaEligibility(BADU_ACCIDENT);
  assert.deepEqual(BADU_ACCIDENT, before, 'the gate must be pure — Shared Feed shape untouched');
});

test('16. ALL mode: the service area gate applies exactly the same', () => {
  // The geographic rule is mode-independent by design. A future TDX
  // restore must not quietly re-open 基隆.
  const ALL_ENV = { TRAFFIC_SOURCE_MODE: 'ALL' };
  assert.equal(broadcastDecision(BADU_ACCIDENT, ALL_ENV).allowed, false, '八堵 blocked in ALL mode too');
  const inArea = pbsAccident({
    road: '國道一號',
    latitude: 24.8039,
    longitude: 120.9647,
    location: '新竹市',
    description: '國道1號南向新竹路段發生事故',
  });
  assert.equal(resolveServiceAreaEligibility(inArea).eligible, true, 'and in-area still passes in ALL mode');
});

test('16b. V2.4.5: TDX-sourced events are placed by the real official-boundary resolver — KM alone never confirms, and fail closed when unplaceable', () => {
  // V2.4.5 (V2_4_5_TDX_HSINCHU_GEO_RESOLVER) — KM/road heuristics alone
  // can no longer confirm eligibility for TDX (order section 九: "禁止再
  // 使用...這種人工估算表取得最終放行資格"). A KM-only event (no
  // coordinates, no explicit administrative-region text) now resolves to
  // the resolver's own UNKNOWN state, which this gate treats exactly like
  // a confirmed negative — see tdx/hsinchuGeoResolver.js.
  assert.equal(isWithinServiceArea({ source: 'freeway', road: '國道一號', startKM: 95, endKM: 95 }), false);
  // A real coordinate inside 新竹市/新竹縣 (official NLSC polygon) still
  // confirms; 八堵 (基隆) does not — this is the actual positive/negative
  // authority now, not the KM table.
  assert.equal(
    isWithinServiceArea({ source: 'freeway', road: '國道一號', latitude: 24.8066, longitude: 120.9686 }),
    true
  );
  assert.equal(
    isWithinServiceArea({ source: 'freeway', road: '國道一號', latitude: 25.10288, longitude: 121.71801 }),
    false
  );
  // Unknown source cannot be placed by either resolver -> blocked.
  const unknown = resolveServiceAreaEligibility({ source: 'cms', road: '國道一號' });
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.reason, 'service-area-unknown-source');
  // Garbage input must not throw and must not pass.
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(isWithinServiceArea(bad), false, String(bad));
  }
});
