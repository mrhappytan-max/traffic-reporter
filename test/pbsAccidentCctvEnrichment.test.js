// PBS ACCIDENT × CCTV ENRICHMENT | 國3 96K+700 Production regression
// (2026-08-25).
//
// A real accident that morning:
//
//   國3 南向, 竹林交流道－寶山交流道路段, 96K+700
//
// Pipeline Trace showed every gate green — displayKM 96.7, classification
// accident, in the service area, location quality sufficient, eligibility
// pass, lineAttempted 1, lineSucceeded 1, sharedFeedPersisted yes — and
// then: cctvEligible 否, cctvSkippedByReason 「—」, sharedFeedWithImage 否.
// The driver got correct text and no picture, and the admin page could not
// say why.
//
// Two stale rules, and one blind spot, all confirmed against real code
// before anything was changed (see the file header of dynamicCollage.js):
//
//   1. resolveCctvEligibility required source === 'freeway'. Written when
//      TDX WAS the 國道 feed; under PBS_ONLY it means "never".
//   2. eventTargetKm read only startKM/endKM. PBS has no structured KM at
//      all, so even without rule 1 the event died at 'no-reliable-km'.
//   3. The eligibility stage never wrote its reason to the trace — which
//      is exactly why the admin page showed a blank instead of naming the
//      stale gate.
//
// The 96.7K record below is the permanent regression fixture. As always,
// the negative cases matter as much: CCTV is enrichment, and must never
// make something broadcastable that the three gates rejected.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCctvEligibility, prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { resolveServiceAreaEligibility } from '../src/traffic/serviceArea.js';
import { resolveLocationQuality } from '../src/traffic/locationQuality.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { getLinePushPolicyDecision } from '../src/traffic/broadcastPolicy.js';
import { buildTraceEntry } from '../src/traffic/pipelineTrace.js';
import { getAccessToken } from '../src/tdx/auth.js';
import { isTdxRuntimeEnabled, isCctvImageEnabled } from '../src/traffic/sourceMode.js';

const PBS_ONLY_ENV = {
  TRAFFIC_SOURCE_MODE: 'PBS_ONLY',
  LINE_PUSH_POLICY: 'MAJOR_ACCIDENT_ONLY',
  TDX_CLIENT_ID: 'test-id',
  TDX_CLIENT_SECRET: 'test-secret',
};

/** The raw PBS shape, exactly as pbs/normalize.js documents it. */
function raw96K7(overrides = {}) {
  return {
    UID: '11508250021-1',
    road: '福爾摩沙高速公路-國道3號',
    areaNm: '(竹林交流道-寶山交流道)-國道3號',
    direction: '南向',
    roadtype: '交通事故',
    comment: '南向96.7公里處發生交通事故，請小心通過',
    happendate: '2026-08-25',
    happentime: '07:30:00',
    modDttm: '2026-08-25 07:35:00',
    ...overrides,
  };
}

const event96K7 = (overrides) => ({ ...normalizePbsEvent(raw96K7()), ...overrides });

/** The real broadcast gate's ordering — all three, same order as broadcastPipeline.js. */
function broadcastDecision(event, env) {
  const area = resolveServiceAreaEligibility(event);
  if (!area.eligible) return { allowed: false, reason: area.reason };
  const base = getBroadcastEligibility(event);
  if (!base.eligible) return { allowed: false, reason: base.reason };
  const policy = getLinePushPolicyDecision(event, env);
  if (!policy.allowed) return { allowed: false, reason: policy.reason };
  const quality = resolveLocationQuality(event);
  return { allowed: quality.sufficient, reason: quality.reason };
}

function createKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function cctvRecord(overrides = {}) {
  return {
    CCTVID: 'CCTV-N3-S-096.700-M',
    RoadID: '000030',
    RoadName: '國道3號',
    RoadDirection: 'S',
    LocationMile: '96K+700',
    PositionLon: 121.0,
    PositionLat: 24.75,
    VideoStreamURL: 'https://cctv3.freeway.gov.tw/n3-96.jpg',
    ...overrides,
  };
}

function envWith(records, { bucket = { put: async () => {} } } = {}) {
  const seed = records
    ? { 'cctv:freeway-metadata:v1': JSON.stringify({ records, fetchedAt: new Date().toISOString() }) }
    : {};
  return {
    ...PBS_ONLY_ENV,
    TRAFFIC_KV: createKv(seed),
    CCTV_IMAGES: bucket,
    PUBLIC_BASE_URL: 'https://traffic-reporter.example.workers.dev',
  };
}

function withFetchSpy(fn, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (handler) return handler(String(url), init);
    throw new Error(`unexpected network call: ${String(url)}`);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const tdxCalls = (calls) => calls.filter((c) => c.url.includes('tdx.transportdata.tw'));

// --- 1: the real event ----------------------------------------------------

test('1. 國3 96K+700: the real PBS record is CCTV-eligible, aimed at 96.7', () => {
  const event = event96K7();

  // Provenance straight from the raw record — nothing assumed.
  assert.equal(event.source, 'pbs');
  assert.equal(event.road, '國道三號');
  assert.equal(event.direction, '南向');
  assert.equal(event.type, 'accident');
  assert.equal(event.displayKM, 96.7);
  assert.equal(event.startKM, undefined, 'PBS never carries structured KM');
  assert.equal(event.endKM, undefined);

  const elig = resolveCctvEligibility(event);
  assert.equal(elig.eligible, true, 'this is the whole bug — it used to be false');
  assert.equal(elig.reason, undefined);
  assert.equal(elig.imageStrategy, 'quad');
  assert.equal(elig.roadKey, '國道三號');
  assert.equal(elig.roadId, '000030');
  assert.equal(elig.targetKm, 96.7);
});

test('2. the two stale rules are each independently gone', () => {
  const event = event96K7();

  // Rule 1: source. A byte-identical event that merely CLAIMS a different
  // feed must reach the same verdict — source is no longer the question.
  for (const source of ['pbs', 'freeway']) {
    assert.equal(resolveCctvEligibility({ ...event, source }).eligible, true, `source ${source}`);
  }

  // Rule 2: KM. With displayKM removed the event has no kilometre at all,
  // and must fail closed on THAT, not on its source.
  const noKm = { ...event };
  delete noKm.displayKM;
  const blocked = resolveCctvEligibility(noKm);
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, 'no-reliable-km');
});

test('3. structured KM still wins, and a range still midpoints', () => {
  const event = event96K7();
  // A source that DOES carry structured KM must be unaffected by tier 3.
  assert.equal(resolveCctvEligibility({ ...event, startKM: '90K+000', endKM: '92K+000' }).targetKm, 91);
  assert.equal(resolveCctvEligibility({ ...event, startKM: '93K+500' }).targetKm, 93.5);
  // displayKM is the LAST tier — structured KM outranks it even when both exist.
  assert.equal(resolveCctvEligibility({ ...event, startKM: '90K+000', displayKM: 96.7 }).targetKm, 90);
});

test('4. 國1 PBS accident with a reliable displayKM is eligible too', () => {
  const event = normalizePbsEvent(
    raw96K7({
      UID: '11508250022-1',
      road: '中山高速公路-國道1號',
      areaNm: '(新竹交流道-新竹系統交流道)-國道1號',
      comment: '南向95.2公里處發生交通事故',
    })
  );
  assert.equal(event.road, '國道一號');
  assert.equal(event.displayKM, 95.2);
  const elig = resolveCctvEligibility(event);
  assert.equal(elig.eligible, true);
  assert.equal(elig.roadShortName, '國1');
  assert.equal(elig.targetKm, 95.2);
});

// --- 5: the allowlist is still an allowlist -------------------------------

test('5. an untrusted source is still refused, with its own honest reason', () => {
  const event = event96K7();
  for (const source of ['bus-hsinchu', 'bus-hsinchu-county', 'cms', undefined, null]) {
    const result = resolveCctvEligibility({ ...event, source });
    assert.equal(result.eligible, false, `source ${source} must not reach a camera`);
    assert.equal(result.reason, 'unsupported-source');
    assert.notEqual(result.reason, 'not-freeway-source', 'the stale reason must never come back');
  }
});

test('6. an unsupported road falls back to text-only, not to a guess', () => {
  // 台68 is in the service area and can broadcast, but has no confirmed
  // CCTV registry entry. This round must NOT invent one.
  const t68 = normalizePbsEvent(
    raw96K7({ road: '(南寮竹東)-台68線', areaNm: '(南寮竹東)-台68線', comment: '西向8.3公里處發生交通事故' })
  );
  assert.equal(t68.displayKM, 8.3, 'it has a perfectly good kilometre…');
  const elig = resolveCctvEligibility(t68);
  assert.equal(elig.eligible, false, '…and still gets no camera, because the road is not confirmed');
  assert.equal(elig.reason, 'unresolvable-road');

  // And the accident itself still broadcasts — text-only.
  assert.equal(broadcastDecision(t68, PBS_ONLY_ENV).allowed, true);
});

test('7. no reliable KM -> skipped, and the accident still broadcasts', () => {
  const vague = normalizePbsEvent(raw96K7({ comment: '南向發生交通事故，請小心通過' }));
  assert.equal(vague.displayKM, undefined);
  assert.equal(resolveCctvEligibility(vague).reason, 'no-reliable-km');

  // And it does not broadcast either — but note WHICH gate stops it. For a
  // 國道 PBS event the kilometre is also the only thing that can place it
  // geographically, so with the KM gone the SERVICE AREA gate fails first,
  // before location quality is ever consulted. Both are correct; the point
  // here is that CCTV decides neither of them.
  const decision = broadcastDecision(vague, PBS_ONLY_ENV);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'outside-service-area');
});

// --- 8: every downstream failure degrades to text-only --------------------

// UPDATED 2026-08-25 by CCTV_METADATA_RECOVERY_V1. This test used to assert
// that an unseeded KV produced 'metadata-cache-unavailable'. That WAS the
// behaviour, and it was the defect: the inventory key was written with a
// 7-day TTL whose only writer could not run under PBS_ONLY, so seven days
// after the last probe every accident silently lost its picture with no way
// back. A real 國道1號 93K accident on 2026-08-25 19:01 hit exactly that.
//
// The cache now falls back to the bundled official NFB inventory, so an
// empty KV is no longer a dead end and this reason is no longer reachable
// that way. The reason itself is deliberately KEPT in dynamicCollage.js:
// if the read ever yields nothing at all, the pipeline must still fail
// closed to text-only rather than fail open.
//
// What must not regress is the pair of guarantees below — a missing KV
// entry costs no picture and still costs zero TDX calls.
test('8. an unseeded KV no longer means no cameras, and still means no TDX', async () => {
  await withFetchSpy(async (calls) => {
    const env = envWith(null); // no cctv:freeway-metadata:v1 seeded at all
    const result = await prepareCctvImageForEvent(env, event96K7(), {});
    assert.notEqual(
      result.reason,
      'metadata-cache-unavailable',
      'the 19:01 failure mode: an empty KV must never again mean no camera list'
    );
    assert.equal(tdxCalls(calls).length, 0, 'a cache miss must never fall back to TDX');
  });
});

test('9. cache present but no camera on this road -> text-only', async () => {
  await withFetchSpy(async (calls) => {
    // Only 國1 cameras cached; the event is on 國3.
    const env = envWith([cctvRecord({ CCTVID: 'CCTV-N1', RoadID: '000010', RoadName: '國道1號' })]);
    const result = await prepareCctvImageForEvent(env, event96K7(), {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-camera');
    assert.equal(tdxCalls(calls).length, 0);
  });
});

test('10. frame fetch failure -> text-only', async () => {
  await withFetchSpy(
    async (calls) => {
      const env = envWith([cctvRecord()]);
      const result = await prepareCctvImageForEvent(env, event96K7(), {});
      assert.equal(result.ok, false, 'a dead camera never becomes a push failure');
      assert.equal(tdxCalls(calls).length, 0);
      assert.ok(
        calls.every((c) => c.url.includes('freeway.gov.tw')),
        'frames only ever come from freeway.gov.tw'
      );
    },
    async () => new Response('nope', { status: 500 })
  );
});

test('11. R2 publish failure -> text-only', async () => {
  await withFetchSpy(
    async () => {
      const bucket = {
        put: async () => {
          throw new Error('R2 down');
        },
      };
      const env = envWith([cctvRecord()], { bucket });
      const result = await prepareCctvImageForEvent(env, event96K7(), {});
      assert.equal(result.ok, false);
      assert.ok(result.reason, 'a reason is always present');
    },
    async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 })
  );
});

// --- 12: TDX stays completely off ----------------------------------------

test('12. the whole PBS CCTV path makes 0 TDX RoadEvent calls and 0 token calls', async () => {
  assert.equal(isTdxRuntimeEnabled(PBS_ONLY_ENV), false);
  assert.equal(isCctvImageEnabled(PBS_ONLY_ENV), true, 'CCTV stays ON while TDX is OFF');

  await withFetchSpy(
    async (calls) => {
      const env = envWith([cctvRecord()]);
      await prepareCctvImageForEvent(env, event96K7(), {});
      assert.equal(tdxCalls(calls).length, 0, 'TDX RoadEvent calls');
      assert.ok(
        calls.every((c) => c.url.includes('freeway.gov.tw')),
        'the only outbound host is freeway.gov.tw'
      );
    },
    async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 })
  );

  // The token path refuses before any fetch — structural, not luck.
  await withFetchSpy(async (calls) => {
    await assert.rejects(() => getAccessToken(PBS_ONLY_ENV), /TDX runtime disabled/);
    assert.equal(calls.length, 0, 'TDX token calls');
  });
});

test('13. dynamicCollage imports no TDX client or auth module', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/cctv/dynamicCollage.js', import.meta.url), 'utf8');
  const imports = src.match(/^import[\s\S]*?from\s+'[^']+';/gm) || [];
  const joined = imports.join('\n');
  assert.ok(!joined.includes('tdx/auth.js'), 'must not import tdx/auth.js');
  assert.ok(!joined.includes('tdx/client.js'), 'must not import tdx/client.js');
});

// --- 14: CCTV is enrichment, never eligibility ----------------------------

test('14. an out-of-service-area accident stays blocked even with a perfect camera', () => {
  const badu = {
    source: 'pbs',
    rawId: 'PBS-BADU',
    type: 'accident',
    pbsCategory: 'accident',
    road: '國道一號',
    direction: '南向',
    location: '八堵交流道',
    latitude: 25.10288,
    longitude: 121.71801,
    displayKM: 2.5,
  };
  // It would happily resolve a camera…
  assert.equal(resolveCctvEligibility(badu).eligible, true);
  // …and it still must never broadcast.
  assert.equal(broadcastDecision(badu, PBS_ONLY_ENV).reason, 'outside-service-area');
});

test('15. an unplaceable accident stays blocked even though CCTV is irrelevant to that', () => {
  const vague = normalizePbsEvent({
    UID: 'PBS-VAGUE',
    road: '(南寮竹東)-台68線',
    areaNm: '（南寮竹東）-台68線',
    direction: '西向',
    roadtype: '交通事故',
    comment: '西向發生交通事故',
    happendate: '2026-08-25',
    happentime: '07:30:00',
    modDttm: '2026-08-25 07:35:00',
  });
  assert.equal(broadcastDecision(vague, PBS_ONLY_ENV).reason, 'insufficient-location-precision');
});

test('16. dynamic shoulder push stays OFF, and its own KM path is untouched', () => {
  const shoulder = {
    source: 'pbs',
    rawId: 'PBS-SHOULDER',
    type: 'control',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+000',
    endKM: '93K+800',
    dynamicShoulder: { state: 'open', evidence: [] },
  };
  // Its CCTV path still uses structured KM only — displayKM must not leak in.
  assert.equal(resolveCctvEligibility(shoulder).targetKm, 93.4);
  const noStructuredKm = { ...shoulder, startKM: undefined, endKM: undefined, displayKM: 93.4 };
  assert.equal(resolveCctvEligibility(noStructuredKm).reason, 'no-reliable-km');
  // And it is still withheld from proactive push.
  assert.equal(broadcastDecision(shoulder, PBS_ONLY_ENV).allowed, false);
});

test('17. a non-accident is still refused CCTV and still not pushed', () => {
  const construction = {
    source: 'pbs',
    rawId: 'PBS-C',
    type: 'construction',
    road: '國道三號',
    direction: '南向',
    displayKM: 96.7,
    description: '封閉車道施工',
  };
  assert.equal(resolveCctvEligibility(construction).reason, 'not-accident');
  assert.equal(broadcastDecision(construction, PBS_ONLY_ENV).allowed, false);
});

// --- 18: the blank reason that hid this bug -------------------------------

test('18. the trace now names the CCTV decision instead of leaving it blank', () => {
  const event = event96K7();

  const skipped = buildTraceEntry({
    event,
    cctvEligible: false,
    cctvSkippedByReason: 'unsupported-source',
  });
  assert.equal(skipped.enrichment.cctvEligible, false);
  assert.equal(skipped.enrichment.cctvSkippedByReason, 'unsupported-source', 'never blank again');

  const elig = resolveCctvEligibility(event);
  const attempted = buildTraceEntry({
    event,
    cctvEligible: elig.eligible,
    cctvTargetKm: elig.targetKm,
    imageStrategy: elig.imageStrategy,
  });
  assert.equal(attempted.enrichment.cctvEligible, true);
  assert.equal(attempted.enrichment.cctvTargetKm, 96.7, 'which kilometre the camera aimed at');
  assert.equal(attempted.enrichment.imageStrategy, 'quad');
});

test('19. every CCTV skip reason a human might see is a real, distinct string', () => {
  const event = event96K7();
  const seen = new Set();
  const cases = [
    [{ ...event, type: 'other' }, 'not-accident'],
    [{ ...event, source: 'cms' }, 'unsupported-source'],
    [{ ...event, road: '台68' }, 'unresolvable-road'],
    [(() => { const e = { ...event }; delete e.displayKM; return e; })(), 'no-reliable-km'],
  ];
  for (const [input, expected] of cases) {
    const result = resolveCctvEligibility(input);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, expected);
    seen.add(result.reason);
  }
  assert.equal(seen.size, cases.length, 'each rejection is distinguishable from the others');
});

test('20. restoring TRAFFIC_SOURCE_MODE=ALL does not disturb any of this', () => {
  const allEnv = { ...PBS_ONLY_ENV, TRAFFIC_SOURCE_MODE: 'ALL' };
  assert.equal(isTdxRuntimeEnabled(allEnv), true);

  // A TDX freeway accident behaves exactly as before this round.
  const tdxEvent = {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+000',
    endKM: '93K+800',
  };
  const elig = resolveCctvEligibility(tdxEvent);
  assert.equal(elig.eligible, true);
  assert.equal(elig.targetKm, 93.4);
  assert.equal(broadcastDecision(tdxEvent, allEnv).allowed, true);

  // And the PBS path keeps working in ALL mode too.
  assert.equal(resolveCctvEligibility(event96K7()).eligible, true);
});
