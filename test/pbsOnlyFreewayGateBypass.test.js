// PBS_ONLY | 解除「國道無 TDX 對應」播報閘門 (2026-08-24).
//
// The bug this pins: V57.2's 國道 gate (crossSourceDedup.js) drops a PBS
// 國道 event that has no TDX match this run, on the premise that a more
// authoritative TDX report is coming. Under TRAFFIC_SOURCE_MODE=PBS_ONLY
// TDX is switched off, so that report never arrives and the gate becomes
// a permanent veto by a disabled data source. Production showed exactly
// that: a correctly-classified 國道一號南向 accident dropped with
// gatingResult 'gated-freeway-no-tdx-match'.
//
// The fix is a BYPASS, not a deletion, so this file pins BOTH directions:
// bypassed in PBS_ONLY, and V57.2 fully intact in ALL mode. The ALL-mode
// half is the one that matters most — it is what stops this round from
// quietly becoming a permanent removal of the gate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crossSourceDedup, mergeForBroadcast } from '../src/pbs/crossSourceDedup.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { getLinePushPolicyDecision } from '../src/traffic/broadcastPolicy.js';
import { isTdxRuntimeEnabled } from '../src/traffic/sourceMode.js';
import { getAccessToken } from '../src/tdx/auth.js';
import { prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';

const PBS_ONLY_ENV = {
  TRAFFIC_SOURCE_MODE: 'PBS_ONLY',
  TDX_CLIENT_ID: 'test-id',
  TDX_CLIENT_SECRET: 'test-secret',
};
const ALL_ENV = { TRAFFIC_SOURCE_MODE: 'ALL', TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' };

/** The real Production shape from the Pipeline Trace case that triggered this fix. */
function freewayPbsAccident(overrides = {}) {
  return {
    source: 'pbs',
    rawId: 'PBS-FREEWAY-1',
    type: 'accident',
    pbsCategory: 'accident',
    road: '國道1號',
    direction: '南向',
    title: '國道一號南向事故',
    description: '國道一號南向100公里處事故',
    startTime: '2026-08-24T09:00:00+08:00',
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

/** What pbs/pipeline.js derives the flag from — asserted rather than assumed. */
const requireCorrelation = (env) => isTdxRuntimeEnabled(env);

// --- check 1: the actual bug -------------------------------------------

test('1. PBS_ONLY: a qualifying 國道 PBS accident with NO TDX match is a broadcast candidate', () => {
  const event = freewayPbsAccident();

  // The pre-fix behaviour, still reachable, still correct in ALL mode.
  const gated = crossSourceDedup([event], [], { requireTdxCorrelationForFreeway: true });
  assert.equal(gated.uniquePbsEvents.length, 0, 'sanity: the gate really did drop it');
  assert.equal(gated.filteredFreewayEvents.length, 1);

  // PBS_ONLY: the flag the caller derives is false, so it survives.
  assert.equal(requireCorrelation(PBS_ONLY_ENV), false);
  const open = crossSourceDedup([event], [], {
    requireTdxCorrelationForFreeway: requireCorrelation(PBS_ONLY_ENV),
  });
  assert.equal(open.uniquePbsEvents.length, 1, 'must reach the broadcast candidate list');
  assert.equal(open.filteredFreewayEvents.length, 0, 'nothing is gated any more');

  // ...and it actually reaches broadcastPipeline.js's allEvents.
  const merged = mergeForBroadcast([], open.canonicalEvents, open.uniquePbsEvents);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].rawId, 'PBS-FREEWAY-1');

  // ...and passes the downstream gates that decide a real push.
  assert.equal(getBroadcastEligibility(merged[0]).eligible, true);
  assert.equal(getLinePushPolicyDecision(merged[0], PBS_ONLY_ENV).allowed, true);
});

test('1b. bypassing the gate does not disturb matching or 省道 handling', () => {
  const freeway = freewayPbsAccident();
  const highway = freewayPbsAccident({ rawId: 'PBS-HWY-1', road: '台61線' });
  const opts = { requireTdxCorrelationForFreeway: false };

  const out = crossSourceDedup([freeway, highway], [], opts);
  assert.equal(out.uniquePbsEvents.length, 2, '省道 was never gated and still is not');
  assert.equal(out.canonicalEvents.length, 0);
  assert.equal(out.duplicatePbsEvents.length, 0);
});

// --- checks 2-3: CCTV is enrichment, never a precondition ---------------

test('2-3. CCTV success or failure never decides whether the accident broadcasts', async () => {
  const event = freewayPbsAccident({ startKM: '95', endKM: '96', road: '國道一號' });

  await withFetchSpy(async (calls) => {
    // CCTV genuinely attempted (past the kill switch), and cannot finish
    // here because there is no R2/KV binding — the text product must not
    // depend on the outcome either way.
    const attempted = await prepareCctvImageForEvent(PBS_ONLY_ENV, event);
    assert.equal(attempted.ok, false);
    assert.notEqual(attempted.reason, 'cctv-image-disabled');
    assert.equal(tdxCalls(calls).length, 0, 'CCTV must never call TDX');

    // Hard-disabled CCTV: resolves, never throws, does no I/O.
    const disabled = await prepareCctvImageForEvent({ ...PBS_ONLY_ENV, CCTV_IMAGE_ENABLED: 'false' }, event);
    assert.equal(disabled.ok, false);
    assert.equal(disabled.reason, 'cctv-image-disabled');
  });

  // In BOTH cases the event is still a broadcast candidate and still pushes.
  const out = crossSourceDedup([event], [], { requireTdxCorrelationForFreeway: false });
  assert.equal(out.uniquePbsEvents.length, 1);
  assert.equal(getBroadcastEligibility(event).eligible, true);
  assert.equal(getLinePushPolicyDecision(event, PBS_ONLY_ENV).allowed, true);
});

// --- checks 4-5: the quota guarantee is unchanged by this round ---------

test('4-5. PBS_ONLY: TDX RoadEvent calls = 0 and TDX token calls = 0', async () => {
  await withFetchSpy(async (calls) => {
    assert.equal(isTdxRuntimeEnabled(PBS_ONLY_ENV), false);
    await assert.rejects(() => getAccessToken(PBS_ONLY_ENV), /TDX runtime disabled/);

    // Running the gate bypass itself is pure computation — no I/O at all.
    crossSourceDedup([freewayPbsAccident()], [], { requireTdxCorrelationForFreeway: false });

    assert.equal(tdxCalls(calls).length, 0);
    assert.equal(calls.filter((c) => c.url.includes('openid-connect/token')).length, 0);
  });
});

// --- checks 6-7: the push policy is NOT widened by this round -----------

test('6. PBS_ONLY: dynamic shoulder still does not push, gate bypass or not', () => {
  for (const state of ['OPEN', 'STOPPED']) {
    const event = freewayPbsAccident({
      type: 'control',
      description: state === 'OPEN' ? '機動開放路肩' : '機動路肩停止開放',
      dynamicShoulder: { state, evidence: { field: 'Description', value: 'x' } },
    });
    const out = crossSourceDedup([event], [], { requireTdxCorrelationForFreeway: false });
    // It may now reach the candidate list — the push policy is what stops it.
    assert.equal(out.uniquePbsEvents.length, 1);
    const decision = getLinePushPolicyDecision(event, PBS_ONLY_ENV);
    assert.equal(decision.allowed, false, `${state} must not push`);
    assert.equal(decision.reason, `policy-dynamic-shoulder-${state.toLowerCase()}`);
  }
});

test('7. PBS_ONLY: non-accident 國道 events still do not enter proactive push', () => {
  const cases = [
    { type: 'closure', description: '國道一號南向道路封閉' },
    { type: 'control', description: '國道一號南向交通管制' },
    { type: 'construction', description: '國道一號南向施工 車道封閉' },
    { type: 'other', description: '國道一號南向 掉落物' },
    { type: 'congestion', description: '國道一號南向壅塞' },
  ];
  for (const c of cases) {
    const event = freewayPbsAccident({ ...c, rawId: `PBS-${c.type}` });
    // The bypass lets them past the 國道 gate...
    const out = crossSourceDedup([event], [], { requireTdxCorrelationForFreeway: false });
    assert.equal(out.uniquePbsEvents.length, 1, c.type);
    // ...and the accident-only policy is what still withholds them.
    assert.equal(getLinePushPolicyDecision(event, PBS_ONLY_ENV).allowed, false, c.type);
  }
});

// --- check 8: ALL mode is untouched ------------------------------------

test('8. ALL mode: V57.2 behaves exactly as before — the gate is bypassed, never removed', () => {
  assert.equal(requireCorrelation(ALL_ENV), true, 'ALL mode must still require correlation');
  assert.equal(requireCorrelation({}), true, 'an absent flag must also require correlation');

  const event = freewayPbsAccident();
  const out = crossSourceDedup([event], [], {
    requireTdxCorrelationForFreeway: requireCorrelation(ALL_ENV),
  });
  assert.equal(out.uniquePbsEvents.length, 0, 'unmatched 國道 PBS is still gated in ALL mode');
  assert.equal(out.filteredFreewayEvents.length, 1);
  assert.equal(mergeForBroadcast([], out.canonicalEvents, out.uniquePbsEvents).length, 0);
});

test('8b. the option DEFAULTS to the conservative behaviour when omitted entirely', () => {
  // A future caller that forgets the flag must never silently widen what
  // broadcasts — it must fall back to V57.2, not to the bypass.
  const out = crossSourceDedup([freewayPbsAccident()], []);
  assert.equal(out.uniquePbsEvents.length, 0);
  assert.equal(out.filteredFreewayEvents.length, 1);
});

test('8c. ALL mode still merges a genuine TDX match into one canonical event', () => {
  // Proves the bypass did not disturb the matching path the gate sits next to.
  // timesMatch() reads updatedAt/happenedAt (not startTime), and
  // directionsMatch() requires both sides to carry a direction — so the
  // fixture has to supply them or the "match" would be vacuous.
  const when = '2026-08-24T09:00:00+08:00';
  const pbs = freewayPbsAccident({ latitude: 24.8, longitude: 121.0, updatedAt: when, happenedAt: when });
  const tdx = {
    source: 'freeway',
    rawId: 'TDX-1',
    type: 'accident',
    road: '國道1號',
    direction: '南向',
    latitude: 24.8,
    longitude: 121.0,
    startTime: when,
    updatedAt: when,
  };
  const out = crossSourceDedup([pbs], [tdx], { requireTdxCorrelationForFreeway: true });
  assert.equal(out.canonicalEvents.length, 1, 'a real match still merges');
  assert.equal(out.duplicatePbsEvents.length, 1);
  assert.equal(out.filteredFreewayEvents.length, 0, 'a matched event is never gated');
});

// --- checks 9-10: contracts unchanged ----------------------------------

test('9-10. Shared Feed and Consumer contract shapes are untouched by this change', () => {
  // This round only changes WHICH events reach the pipeline, never the
  // shape of what the Producer publishes. mergeForBroadcast still returns
  // plain unified events with their own source:rawId identity, which is
  // what sharedFeed.js keys completedProducts on.
  const event = freewayPbsAccident();
  const out = crossSourceDedup([event], [], { requireTdxCorrelationForFreeway: false });
  const [candidate] = mergeForBroadcast([], out.canonicalEvents, out.uniquePbsEvents);

  assert.equal(candidate.source, 'pbs', 'source identity preserved');
  assert.equal(candidate.rawId, 'PBS-FREEWAY-1', 'rawId identity preserved');
  assert.equal(candidate.type, 'accident', 'classification untouched by the gate');
  assert.equal(candidate.pbsCategory, 'accident');
  // The gate must not have mutated the event on its way through.
  assert.deepEqual(candidate, event);
});
