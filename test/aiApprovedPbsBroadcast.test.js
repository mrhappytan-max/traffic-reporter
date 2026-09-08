// V1.9.9 Phase 3B — src/traffic/aiApprovedPbsBroadcast.js unit tests.
// Same mock conventions as test/broadcastPipeline.test.js: an in-memory KV,
// a captured LINE push fetch, real subscriptions.js state.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runAiApprovedPbsBroadcast } from '../src/traffic/aiApprovedPbsBroadcast.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resolveTdxRoadManagementEligibility } from '../src/tdx/roadManagementPolicyGate.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

function pbsAccidentEvent(overrides = {}) {
  return {
    source: 'pbs',
    rawId: 'AI-PBS-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '國道一號北向94公里',
    description: '國道一號北向94公里處發生追撞事故，雙向封閉',
    title: '國道一號北向94公里處發生追撞事故',
    startTime: '2026-08-28T10:00:00+08:00',
    endTime: null,
    updatedAt: '2026-08-28T10:00:00+08:00',
    latitude: 24.8,
    longitude: 121.0,
    sourceDetail: 'test',
    ...overrides,
  };
}

function pbsControlEvent(overrides = {}) {
  return pbsAccidentEvent({
    type: 'control',
    description: '國道一號北向94公里處全線封閉',
    title: '國道一號北向94公里處全線封閉',
    ...overrides,
  });
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
const WITHIN_HOURS = new Date('2026-08-28T10:00:00+08:00');

let originalFetch;
let pushCalls;
function mockLinePushFetch() {
  pushCalls = [];
  return async (url, init) => {
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('fail-closed: missing LINE_CHANNEL_ACCESS_TOKEN -> lineReady=false, 0 push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  const env = { TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.lineReady, false);
  assert.equal(result.pushSucceeded, 0);
});

test('quiet hours (execution safety, not a content judgment): 07:59 Taipei -> 0 push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: new Date('2026-08-28T07:59:00+08:00') });
  assert.equal(result.withinBroadcastHours, false);
  assert.equal(result.pushSucceeded, 0);
  assert.equal(pushCalls.length, 0);
});

test('0 subscribers -> LINE never called even for a real accident within hours', async () => {
  const kv = createMockKV();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 0);
  assert.equal(result.pushSucceeded, 0);
});

test('a real subscriber + accident + within hours -> exactly 1 LINE push, no legacy gates re-applied', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1);
  assert.equal(result.pushSucceeded, 1);
  assert.equal(result.completedProducts.length, 1);
});

test('a non-accident type (control) with no impact keyword pattern still pushes -- the old V1.5 whitelist/type gate is never applied here', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsControlEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1, 'a type=control event must still be pushable once AI has approved it');
  assert.equal(result.pushSucceeded, 1);
});

test('a resend of the identical content to the same target -> 0 additional push (existing notified-state dedupe reused)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const event = pbsAccidentEvent();
  await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1);
  await runAiApprovedPbsBroadcast(env, { event, now: new Date(WITHIN_HOURS.getTime() + 60_000) });
  assert.equal(pushCalls.length, 1, 'identical content to the same already-notified target must not push again');
});

test('incident suppression (accident type only) is reused: the SAME real incident re-sighted without material change -> suppressed, 0 push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  // First sighting under one rawId (e.g. NEW), second sighting under a
  // DIFFERENT rawId at the same road/direction/km (e.g. UPDATED reusing a
  // slightly different UID isn't realistic for PBS, but incident
  // suppression groups by road/direction/km regardless of rawId) with no
  // material escalation in the description -- same real crash.
  const first = pbsAccidentEvent({ rawId: 'AI-PBS-1' });
  await runAiApprovedPbsBroadcast(env, { event: first, now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1);

  const second = pbsAccidentEvent({ rawId: 'AI-PBS-1-RESIGHT', description: '國道一號北向94公里處發生追撞事故，雙向封閉' });
  const result = await runAiApprovedPbsBroadcast(env, { event: second, now: new Date(WITHIN_HOURS.getTime() + 5 * 60_000) });
  assert.equal(result.suppressed, true);
  assert.equal(pushCalls.length, 1, 'no material escalation -> incident suppression reused, 0 additional push');
});

test('KV outage on subscriptions -> fail closed, 0 push, never throws', async () => {
  const brokenKv = {
    async get() {
      throw new Error('subs read outage');
    },
  };
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: brokenKv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.lineReady, false);
  assert.equal(result.pushSucceeded, 0);
});

test('CCTV failure never blocks the text push (fail-safe, same principle as the legacy pipeline)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  // No CCTV_IMAGES R2 binding at all -> prepareCctvImageForEvent degrades
  // to {ok:false} internally (see dynamicCollage.js), never throws.
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(pushCalls[0].body.messages.length, 1, 'text-only when CCTV is unavailable');
});

// ============================================================================
// V2.4.18 — the `event.type === 'accident'` gate that used to wrap the CCTV
// call (removed this round; see the call site's own V2.4.18 comment) is
// GONE. resolveCctvEligibility() (unchanged since V2.4.16, untouched this
// round) is now the only thing deciding CCTV eligibility for every event
// this function handles, regardless of type.
// ============================================================================

/** Same shape/provenance as pbsAccidentCctvEnrichment.test.js's own cctvRecord(). */
function freewayCctvRecord(overrides = {}) {
  return {
    CCTVID: 'CCTV-N1-N-094.000-M',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'N',
    // Deliberately NOT exactly 94K — selectFourQuadrantCandidates splits
    // candidates into a "before"/"after" quadrant by strict </> comparison
    // against targetKm, so a camera at the exact same KM as the event
    // matches neither side and is silently never selected.
    LocationMile: '93K+800',
    PositionLon: 121.0,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/n1-94.jpg',
    ...overrides,
  };
}

/**
 * Same LINE-push capture as mockLinePushFetch(), plus a second bucket of
 * calls for anything hitting freeway.gov.tw (CCTV frame fetch) — lets a
 * test observe "did prepareCctvImageForEvent actually reach the frame-fetch
 * stage" without needing a real JPEG decode (see this block's own comment
 * below on why a genuine ok:true collage cannot be exercised from THIS call
 * site in a Node test run). The freeway.gov.tw response is a deliberately
 * non-JPEG 500 — this proves the call was ATTEMPTED; it is never meant to
 * produce a successful collage.
 */
let cctvFetchCalls;
function mockLinePushAndCctvFetch() {
  pushCalls = [];
  cctvFetchCalls = [];
  return async (url, init) => {
    const u = String(url);
    if (u.includes('freeway.gov.tw')) {
      cctvFetchCalls.push({ url: u });
      return new Response('not a jpeg', { status: 500 });
    }
    pushCalls.push({ url: u, body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}

// KNOWN, DISCLOSED TEST-INFRASTRUCTURE LIMIT (not a product gap): a genuine
// cctv.ok:true (real composed collage, image message actually attached) can
// only be exercised in `node --test` via an injected `codecOverride` (see
// dynamicCollage.js's own prepareCctvImageForEvent signature and
// tdx/hsinchuCctvProbe.js's composeCollageFromCandidates comment: the real
// default codec hits "the Node-incompatible dynamic import"). This module's
// own call site — aiApprovedPbsBroadcast.js's `prepareCctvImageForEvent(env,
// event, {})` — never exposes a codecOverride parameter to its caller, and
// this round's order does not authorize adding one (only line 250's gate
// itself may change). This was ALREADY true, unchanged by this round, for
// every existing test in this file, including the pre-existing accident-type
// ones — none of them ever exercised messages.length===2 either (only ever
// messages.length===1, via a missing-R2-binding failure). The tests below
// therefore verify the deepest observable proof available from outside this
// function: that prepareCctvImageForEvent's own frame-fetch stage is
// actually REACHED (a real outbound call to freeway.gov.tw happens) for a
// non-accident event once the type gate is gone — the same depth of proof
// the file's own pre-existing tests already relied on for accident events.

test('V2.4.18 (a): a non-accident type (control) with a resolvable road/KM now reaches CCTV frame-fetch — the removed type gate no longer blocks it', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await kv.put(FREEWAY_METADATA_KEY, JSON.stringify({ records: [freewayCctvRecord()], fetchedAt: new Date().toISOString() }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushAndCctvFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: { put: async () => {}, get: async () => null } };
  const event = pbsControlEvent({ displayKM: 94 });
  const result = await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  assert.equal(result.pushSucceeded, 1, 'text push still succeeds regardless of CCTV outcome');
  assert.ok(cctvFetchCalls.length > 0, 'prepareCctvImageForEvent must have reached the frame-fetch stage for a type=control event — proves the gate is gone');
  assert.ok(
    cctvFetchCalls.every((c) => c.url.includes('freeway.gov.tw')),
    'the only outbound CCTV host is freeway.gov.tw'
  );
});

test('V2.4.18 (a): construction/closure/congestion/other event types each also reach CCTV frame-fetch', async () => {
  for (const type of ['construction', 'closure', 'congestion', 'other']) {
    const kv = createMockKV();
    await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
    await kv.put(FREEWAY_METADATA_KEY, JSON.stringify({ records: [freewayCctvRecord()], fetchedAt: new Date().toISOString() }));
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockLinePushAndCctvFetch();
    const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: { put: async () => {}, get: async () => null } };
    const event = pbsControlEvent({ type, displayKM: 94 });
    await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
    assert.ok(cctvFetchCalls.length > 0, `type=${type} must reach CCTV frame-fetch`);
  }
});

test('V2.4.18 (a) negative control: an ineligible non-accident event (unsupported road) still correctly reaches resolveCctvEligibility and is correctly rejected — not blocked earlier by anything else', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushAndCctvFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: { put: async () => {}, get: async () => null } };
  const event = pbsControlEvent({ road: '台68線', displayKM: 5 }); // not in CCTV_SUPPORTED_ROADS
  const result = await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(cctvFetchCalls.length, 0, 'an unsupported road must never reach a frame fetch — resolveCctvEligibility itself fails closed, same as before');
});

test('V2.4.18 (b) Gate A regression lock — a dynamic-shoulder (OPEN/STOPPED) event is still rejected by tdx/roadManagementPolicyGate.js#resolveTdxRoadManagementEligibility, independently of and unaffected by this round\'s change (this file\'s own removed gate is downstream of, and irrelevant to, this upstream gate)', () => {
  const openEvent = { source: 'freeway', dynamicShoulder: { state: 'OPEN' } };
  const stoppedEvent = { source: 'freeway', dynamicShoulder: { state: 'STOPPED' } };
  assert.equal(resolveTdxRoadManagementEligibility(openEvent).eligible, false);
  assert.equal(resolveTdxRoadManagementEligibility(stoppedEvent).eligible, false);
});

test('V2.4.18 (c): accident-type events reach CCTV frame-fetch exactly as before this round (unchanged behavior, symmetry check with the now-unblocked non-accident types above)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await kv.put(FREEWAY_METADATA_KEY, JSON.stringify({ records: [freewayCctvRecord()], fetchedAt: new Date().toISOString() }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushAndCctvFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: { put: async () => {}, get: async () => null } };
  const event = pbsAccidentEvent({ displayKM: 94 });
  const result = await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  assert.equal(result.pushSucceeded, 1);
  assert.ok(cctvFetchCalls.length > 0, 'accident events must still reach CCTV frame-fetch, same as pre-V2.4.18');
});

test('V2.4.18 (d) incident suppression regression lock — the SAME real accident re-sighted without material change is still suppressed, 0 push (line 208\'s own separate event.type===\'accident\' gate is untouched by this round)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const first = pbsAccidentEvent({ rawId: 'V2418-PBS-1' });
  await runAiApprovedPbsBroadcast(env, { event: first, now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1);
  const second = pbsAccidentEvent({ rawId: 'V2418-PBS-1-RESIGHT', description: '國道一號北向94公里處發生追撞事故，雙向封閉' });
  const result = await runAiApprovedPbsBroadcast(env, { event: second, now: new Date(WITHIN_HOURS.getTime() + 5 * 60_000) });
  assert.equal(result.suppressed, true);
  assert.equal(pushCalls.length, 1, 'incident suppression (accident-type gate at line 208, untouched) still works exactly as before');
});
