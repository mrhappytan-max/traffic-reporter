// PBS + CCTV | 重大事故限定 LINE Push (2026-08-23).
//
// Covers the twelve checks the product change was ordered against. The
// TDX-quota assertions are deliberately re-verified here rather than left
// to tdxQuotaPbsOnlyMode.test.js: this round RE-ENABLES CCTV, and the
// whole safety of that move rests on "CCTV costs zero TDX calls". A test
// that only proved it before CCTV came back would prove nothing about the
// state actually shipped.
//
// Every TDX assertion works by counting real fetch() calls to
// tdx.transportdata.tw, not by trusting a flag — a flag can be read
// correctly and the call made anyway.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getLinePushPolicyDecision, resolveLinePushPolicy, resolveRoadImpact } from '../src/traffic/broadcastPolicy.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { isCctvImageEnabled, isTdxRuntimeEnabled, describeSourceMode } from '../src/traffic/sourceMode.js';
import { getAccessToken } from '../src/tdx/auth.js';

const PBS_ONLY_ENV = {
  TRAFFIC_SOURCE_MODE: 'PBS_ONLY',
  TDX_CLIENT_ID: 'test-id',
  TDX_CLIENT_SECRET: 'test-secret',
};

/** Installs a fetch spy that records every requested host. */
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

// --- the shipped policy ------------------------------------------------

test('1-2. PBS_ONLY: TDX RoadEvent and token calls are both 0, and the token is refused outright', async () => {
  await withFetchSpy(async (calls) => {
    assert.equal(isTdxRuntimeEnabled(PBS_ONLY_ENV), false);
    await assert.rejects(() => getAccessToken(PBS_ONLY_ENV), /TDX runtime disabled/);
    assert.equal(tdxCalls(calls).length, 0, 'no TDX host may be contacted at all');
    assert.equal(calls.filter((c) => c.url.includes('openid-connect/token')).length, 0);
  });
});

test('3-4. CCTV is ON in PBS_ONLY mode and reaching it makes no TDX call', async () => {
  assert.equal(isCctvImageEnabled(PBS_ONLY_ENV), true, 'CCTV must be re-enabled');

  await withFetchSpy(async (calls) => {
    // A 國道一號 accident with a real KM — i.e. an event that genuinely
    // gets PAST the eligibility check and tries to do CCTV work. With no
    // KV/R2 bindings it cannot finish, which is the point: whatever it
    // did try, none of it may be TDX.
    const result = await prepareCctvImageForEvent(PBS_ONLY_ENV, {
      type: 'accident',
      road: '國道一號',
      direction: '南下',
      startKM: '95',
      endKM: '96',
      title: '國道一號南下95公里處事故 車道封閉',
      description: '國道一號南下95公里處事故 車道封閉',
    });

    assert.equal(result.ok, false, 'no R2 binding in this test env');
    assert.notEqual(result.reason, 'cctv-image-disabled', 'must not be short-circuited by the kill switch');
    assert.equal(tdxCalls(calls).length, 0, 'CCTV must never call TDX');
  });
});

test('4b. the CCTV kill switch still works, and never reports itself as a TDX pause', () => {
  assert.equal(isCctvImageEnabled({ ...PBS_ONLY_ENV, CCTV_IMAGE_ENABLED: 'false' }), false);
  const described = describeSourceMode(PBS_ONLY_ENV);
  assert.equal(described.cctvImageEnabled, true);
  // Reading the cache is allowed; refilling it from TDX is not.
  assert.equal(described.tdxCctvMetadataRefreshEnabled, false);
  assert.equal(described.pbsEnabled, true);
});

test('5. an accident still produces its text product when CCTV yields nothing', async () => {
  await withFetchSpy(async (calls) => {
    const result = await prepareCctvImageForEvent(
      { ...PBS_ONLY_ENV, CCTV_IMAGE_ENABLED: 'false' },
      { type: 'accident', road: '國道一號', startKM: '95', endKM: '96', description: '事故 車道封閉' }
    );
    // The contract that makes text-only safe: a resolved {ok:false},
    // never a throw, and no I/O on the way out.
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cctv-image-disabled');
    assert.equal(calls.length, 0, 'a disabled CCTV attempt must do no I/O whatsoever');
  });

  // And the event itself is still a push: CCTV is enrichment, never a
  // precondition for the accident going out.
  const event = { type: 'accident', title: '事故', description: '國道一號南下 車道封閉' };
  assert.equal(getBroadcastEligibility(event).eligible, true);
  assert.equal(getLinePushPolicyDecision(event, PBS_ONLY_ENV).allowed, true);
});

test('6-7. dynamic shoulder OPEN and STOPPED are both withheld from proactive push', () => {
  for (const state of ['OPEN', 'STOPPED']) {
    const event = {
      type: 'control',
      title: '機動路肩',
      description: state === 'OPEN' ? '機動開放路肩' : '機動路肩停止開放',
      dynamicShoulder: { state, evidence: { field: 'Description', value: 'x' } },
    };
    // The V1.5 whitelist still considers it eligible — the capability is
    // intentionally preserved, only the product is withheld.
    assert.equal(getBroadcastEligibility(event).eligible, true, `${state}: detection must be untouched`);

    const decision = getLinePushPolicyDecision(event, PBS_ONLY_ENV);
    assert.equal(decision.allowed, false, `${state} must not push`);
    assert.equal(decision.reason, `policy-dynamic-shoulder-${state.toLowerCase()}`);
  }
});

test('7b. a shoulder event is blocked by its own rule, not merely by not being an accident', () => {
  // Guards against the exclusion silently disappearing if the accident
  // rule is ever loosened.
  const shoulderAccident = {
    type: 'accident',
    description: '車道封閉',
    dynamicShoulder: { state: 'OPEN', evidence: { field: 'Description', value: 'x' } },
  };
  const decision = getLinePushPolicyDecision(shoulderAccident, PBS_ONLY_ENV);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'policy-dynamic-shoulder-open');
});

test('8. a PBS accident that states real road impact is broadcast', () => {
  const cases = [
    ['國道一號南下100公里處事故，外側車道封閉', 'policy-major-accident-impact-keyword'],
    ['自撞事故 車道阻塞 請改道', 'policy-major-accident-impact-keyword'],
    ['聯結車翻覆 雙向中斷', 'policy-major-accident-impact-keyword'],
    ['事故 佔用內側車道 搶修中', 'policy-major-accident-impact-keyword'],
  ];
  for (const [description, expectedReason] of cases) {
    const event = { type: 'accident', source: 'pbs', title: description.slice(0, 30), description };
    assert.equal(getBroadcastEligibility(event).eligible, true, description);
    const decision = getLinePushPolicyDecision(event, PBS_ONLY_ENV);
    assert.equal(decision.allowed, true, description);
    assert.equal(decision.reason, expectedReason);
  }
});

test('8b. a structured blocked-lane count counts as impact on its own', () => {
  // Dormant while PBS-only (PBS has no such field) but already correct
  // for the day TDX is restored.
  const event = { type: 'accident', description: '事故', blockedLanes: 2 };
  assert.equal(resolveRoadImpact(event).evidence, 'blocked-lanes');
  assert.equal(getLinePushPolicyDecision(event, PBS_ONLY_ENV).reason, 'policy-major-accident-blocked-lanes');
  assert.equal(getLinePushPolicyDecision(event, PBS_ONLY_ENV).allowed, true);

  // Zero/absent/garbage must never be read as impact.
  for (const blockedLanes of [0, '0', null, undefined, '', 'N/A']) {
    assert.equal(resolveRoadImpact({ type: 'accident', description: '事故', blockedLanes }).impacted, false, String(blockedLanes));
  }
});

test('9. events outside the accident-only policy do not push', () => {
  const withheld = [
    [{ type: 'closure', description: '道路封閉' }, 'policy-not-accident'],
    [{ type: 'control', description: '交通管制' }, 'policy-not-accident'],
    [{ type: 'construction', description: '施工 車道封閉' }, 'policy-not-accident'],
    [{ type: 'other', description: '落石' }, 'policy-not-accident'],
  ];
  for (const [event, expectedReason] of withheld) {
    // Each of these IS eligible under the untouched V1.5 whitelist...
    assert.equal(getBroadcastEligibility(event).eligible, true, JSON.stringify(event));
    // ...and is withheld only by the new policy layer.
    const decision = getLinePushPolicyDecision(event, PBS_ONLY_ENV);
    assert.equal(decision.allowed, false, JSON.stringify(event));
    assert.equal(decision.reason, expectedReason);
  }
});

test('9b. the policy only ever subtracts — it can never re-admit a V1.5 rejection', () => {
  // congestion is the canonical never-eligible type; even worded so that
  // every impact pattern matches, it must stay out.
  const event = { type: 'congestion', description: '車道封閉 回堵 壅塞 道路中斷' };
  assert.equal(getBroadcastEligibility(event).eligible, false);
  assert.equal(getBroadcastEligibility(event).reason, 'congestion-excluded');
});

test('9c. the policy is reversible and fails to the restrictive side', () => {
  assert.equal(resolveLinePushPolicy(PBS_ONLY_ENV), 'MAJOR_ACCIDENT_ONLY', 'restrictive by default');
  assert.equal(resolveLinePushPolicy({ LINE_PUSH_POLICY: 'ALL_ELIGIBLE' }), 'ALL_ELIGIBLE');
  // A typo must NOT silently open the floodgates.
  assert.equal(resolveLinePushPolicy({ LINE_PUSH_POLICY: 'all-eligible' }), 'MAJOR_ACCIDENT_ONLY');
  assert.equal(resolveLinePushPolicy({ LINE_PUSH_POLICY: 'EVERYTHING' }), 'MAJOR_ACCIDENT_ONLY');

  // Under ALL_ELIGIBLE the pre-policy behaviour returns intact.
  const closure = { type: 'closure', description: '道路封閉' };
  assert.equal(getLinePushPolicyDecision(closure, { LINE_PUSH_POLICY: 'ALL_ELIGIBLE' }).allowed, true);
});

test('8c. an accident with no stated impact still pushes, and is labelled as such', () => {
  // The adopted rule: accident type is the gate; impact evidence is
  // RECORDED, not required. Pinned explicitly because reversing it is a
  // deliberate product decision for the one-month review to make on real
  // numbers — not something that should drift in silently.
  const bare = { type: 'accident', description: '國道一號南下100公里處發生事故' };
  const decision = getLinePushPolicyDecision(bare, PBS_ONLY_ENV);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'policy-accident-no-stated-impact');
  assert.equal(resolveRoadImpact(bare).impacted, false);
});
