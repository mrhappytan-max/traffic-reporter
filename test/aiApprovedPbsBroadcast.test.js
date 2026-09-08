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

// ============================================================================
// V2.5.1 (路況-053, following 路況-046's own plan) — completedProduct now
// also carries cctvSkippedByReason/imageStrategy/r2ReadbackElapsedMs.
// KNOWN, DISCLOSED TEST-INFRASTRUCTURE LIMIT (same one V2.4.18's own tests
// above already documented, unchanged by this round): a genuine
// cctv.ok:true (or a late failure like 'r2-readback-failed', which itself
// requires having gotten through the same codec-dependent compose step
// first) cannot be reached from this call site in `node --test` without a
// codecOverride this file's caller does not expose. r2ReadbackElapsedMs is
// therefore only actually reachable, in this test environment, on its
// null/absent branch — the tests below prove that branch is handled
// correctly (never crashes, never fabricates a value), which is the real,
// achievable regression lock for the wiring THIS round adds.
// ============================================================================

test('V2.5.1: an eligible-but-failed CCTV attempt (no-frames) sets cctvSkippedByReason and imageStrategy, but leaves r2ReadbackElapsedMs null (that stage was never reached)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  await kv.put(FREEWAY_METADATA_KEY, JSON.stringify({ records: [freewayCctvRecord()], fetchedAt: new Date().toISOString() }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushAndCctvFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: { put: async () => {}, get: async () => null } };
  const event = pbsControlEvent({ displayKM: 94 });
  const result = await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  const product = result.completedProducts[0];
  assert.equal(product.cctvSkippedByReason, 'no-frames', 'all mocked frame fetches return 500, so every candidate fails to decode a frame');
  assert.equal(product.imageStrategy, 'quad', 'a strategy IS chosen — eligibility passed — even though the attempt then failed');
  assert.equal(product.r2ReadbackElapsedMs, null, 'never reached the R2 readback stage, so this must stay null, never undefined or a stale value');
  assert.equal(product.imageUrl, null);
  assert.equal(product.imageExpiresAt, null);
});

test('V2.5.1: an ineligible CCTV event (unsupported road) sets cctvSkippedByReason to the eligibility reason, and imageStrategy stays null (no strategy was ever chosen)', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushAndCctvFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, CCTV_IMAGES: { put: async () => {}, get: async () => null } };
  const event = pbsControlEvent({ road: '台68線', displayKM: 5 }); // not in CCTV_SUPPORTED_ROADS
  const result = await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  const product = result.completedProducts[0];
  assert.equal(product.cctvSkippedByReason, 'unresolvable-road');
  assert.equal(product.imageStrategy, null, 'ineligible before a strategy was ever chosen');
  assert.equal(product.r2ReadbackElapsedMs, null);
});

test('V2.5.1: when the CCTV try block never runs at all (e.g. quiet hours), completedProducts stays empty — the new fields simply never get the chance to be set, same as imageUrl/imageExpiresAt already behaved', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: new Date('2026-08-28T07:59:00+08:00') });
  assert.equal(result.withinBroadcastHours, false);
  assert.equal(result.completedProducts.length, 0, 'this early-return happens before completedProduct is even built — pre-existing behavior, unchanged');
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

// ============================================================================
// V2.5.0 (路況-052) — Telegram channel push, wired in as a synthetic
// `pendingTargets` entry (kind: 'telegram-channel') alongside real LINE
// targets — see aiApprovedPbsBroadcast.js's own V2.5.0 comments at the
// `targets` construction and inside the push loop.
// ============================================================================

let telegramCalls;
/**
 * One combined fetch mock covering BOTH LINE (api.line.me) and Telegram
 * (api.telegram.org) — routes by host, tracks each destination's calls
 * separately, and lets a test force either destination's HTTP status
 * independently (for the failure-isolation regression locks below).
 */
function mockLineAndTelegramFetch({ lineStatus = 200, telegramStatus = 200 } = {}) {
  pushCalls = [];
  telegramCalls = [];
  return async (url, init) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      telegramCalls.push({ url: u, body: JSON.parse(init.body) });
      return new Response(telegramStatus === 200 ? '{}' : 'error', { status: telegramStatus });
    }
    pushCalls.push({ url: u, body: JSON.parse(init.body) });
    return new Response(lineStatus === 200 ? '{}' : 'error', { status: lineStatus });
  };
}

const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: 'tg-tok', TELEGRAM_CHAT_ID: '-1004328365784' };

test('V2.5.0 (a): with Telegram configured, a real accident push sends to BOTH LINE and Telegram, once each', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1, 'LINE still gets exactly 1 push');
  assert.equal(telegramCalls.length, 1, 'Telegram gets exactly 1 push, same event');
  assert.equal(result.pushSucceeded, 2, 'both destinations count toward the COMBINED pushSucceeded — unchanged meaning, V2.6.0 keeps this field summed for existing readers (e.g. incident-memory bookkeeping)');
  assert.deepEqual(result.telegramErrors, []);
  // V2.6.0 (路況-055) — the NEW per-channel fields debugPush.js now reads
  // for lineSent/telegramSent, verified directly here.
  assert.deepEqual(result.line, { attempted: 1, succeeded: 1 });
  assert.deepEqual(result.telegram, { attempted: 1, succeeded: 1 });
  assert.equal(result.lineReady, true);
  assert.equal(result.telegramReady, true);
});

test('V2.5.0 (b) CRITICAL regression lock — Telegram failing (500) does NOT affect LINE\'s existing successful push', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch({ telegramStatus: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1, 'LINE call still happened');
  assert.equal(telegramCalls.length, 1, 'Telegram was attempted');
  assert.equal(result.pushSucceeded, 1, 'only the LINE target counts as succeeded (combined total)');
  assert.equal(result.lineErrors.length, 0, 'LINE has no errors of its own');
  assert.equal(result.telegramErrors.length, 1, 'the Telegram failure is recorded, separately from lineErrors');
  assert.match(result.telegramErrors[0], /telegram push failed/);
  // V2.6.0 — per-channel fields make the fix this round exists for
  // directly checkable: LINE's own count is untouched by Telegram's
  // failure, which is exactly the bug 路況-054/055 found in debugPush.js's
  // OLD lineSent computation (see that module's own V2.6.0 comment).
  assert.deepEqual(result.line, { attempted: 1, succeeded: 1 }, 'LINE succeeded==attempted, i.e. what a correct lineSent computation must see');
  assert.deepEqual(result.telegram, { attempted: 1, succeeded: 0 });
});

test('V2.5.0 (c) symmetric regression lock — LINE failing (500) does NOT affect Telegram\'s successful send', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch({ lineStatus: 500 });
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1, 'LINE was attempted');
  assert.equal(telegramCalls.length, 1, 'Telegram call still happened');
  assert.equal(result.pushSucceeded, 1, 'only the Telegram target counts as succeeded (combined total)');
  assert.equal(result.telegramErrors.length, 0, 'Telegram has no errors of its own');
  assert.equal(result.lineErrors.length, 1, 'the LINE failure is recorded, unaffected by Telegram succeeding');
  // V2.6.0 — symmetric per-channel check.
  assert.deepEqual(result.line, { attempted: 1, succeeded: 0 });
  assert.deepEqual(result.telegram, { attempted: 1, succeeded: 1 }, 'Telegram succeeded==attempted, i.e. what a correct telegramSent computation must see');
});

test('V2.5.0 (d): no CCTV image -> Telegram uses sendMessage, request body carries no photo field', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  // No CCTV_IMAGES R2 binding -> prepareCctvImageForEvent degrades to
  // {ok:false}, completedProduct.imageUrl stays null (same fixture used by
  // the pre-existing "CCTV failure never blocks the text push" test above).
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(telegramCalls.length, 1);
  assert.match(telegramCalls[0].url, /\/sendMessage$/);
  assert.equal('photo' in telegramCalls[0].body, false);
  assert.equal('caption' in telegramCalls[0].body, false);
  assert.ok(typeof telegramCalls[0].body.text === 'string' && telegramCalls[0].body.text.length > 0);
});

test('V2.5.0 (e) dedupe regression lock — the SAME event, unchanged content, called twice does NOT re-send to either channel a second time; V2.6.0 (路況-055) update — proves this now works via TWO SEPARATE notified-state KV records, not one shared record', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  const event = pbsAccidentEvent();
  await runAiApprovedPbsBroadcast(env, { event, now: WITHIN_HOURS });
  assert.equal(telegramCalls.length, 1);
  assert.equal(pushCalls.length, 1);
  // V2.6.0 — two DISTINCT KV records now exist, one per channel, proving
  // the persistence itself (not just the observable "don't resend"
  // behavior) is genuinely split — see notified.js's own V2.6.0 comment
  // on NOTIFIED_KEY becoming a parameter and aiApprovedPbsBroadcast.js's
  // own TELEGRAM_NOTIFIED_KEY.
  assert.ok(kv.store.has('line:notified-state'), 'LINE\'s own notified-state record exists');
  assert.ok(kv.store.has('telegram:notified-state'), 'Telegram has its OWN, separate notified-state record');
  assert.notEqual(kv.store.get('line:notified-state'), kv.store.get('telegram:notified-state'), 'the two records are not merely aliases of the same content by coincidence');
  await runAiApprovedPbsBroadcast(env, { event, now: new Date(WITHIN_HOURS.getTime() + 60_000) });
  assert.equal(telegramCalls.length, 1, 'identical content to the already-notified Telegram target must not resend — reads its OWN record');
  assert.equal(pushCalls.length, 1, 'LINE dedupe is unaffected, still 1 — reads its OWN record');
});

test('V2.5.0 (f) config-off regression lock — WITHOUT TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID configured, no telegram-channel target is ever added and 0 calls reach api.telegram.org', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv }; // no TELEGRAM_* vars at all
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(pushCalls.length, 1);
  assert.equal(telegramCalls.length, 0, 'Telegram must never be attempted when unconfigured');
  assert.equal(result.pushSucceeded, 1, 'exactly the same as pre-V2.5.0 behavior — only the LINE target (combined total)');
  assert.deepEqual(result.telegramErrors, []);
  // V2.6.0 — per-channel fields: Telegram unconfigured means telegramReady
  // stays false WITHOUT an error (a deliberate "feature off" state, never
  // a failure) and its own KV key is never even touched.
  assert.deepEqual(result.line, { attempted: 1, succeeded: 1 });
  assert.deepEqual(result.telegram, { attempted: 0, succeeded: 0 });
  assert.equal(result.telegramReady, false);
  assert.equal(kv.store.has('telegram:notified-state'), false, 'unconfigured Telegram must never touch its own KV key at all');
});

// ============================================================================
// V2.6.0 (路況-055, following 路況-054's own plan) — LINE and Telegram are
// now two fully independent delivery paths: independent readiness gates
// (deliverToLineTargets/deliverToTelegram, see that module's own V2.6.0
// comment), independent notified-state persistence (line:notified-state
// vs telegram:notified-state). The regression locks below are the ones
// order #路況-055 item 六-3/六-4 explicitly required: proof in BOTH
// directions that a readiness failure OR a notified-state KV failure on
// one channel has ZERO effect on the other.
// ============================================================================

test('V2.6.0 (a) readiness independence — LINE_CHANNEL_ACCESS_TOKEN missing -> LINE not ready, but Telegram (fully configured) still sends normally', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { TRAFFIC_KV: kv, ...TELEGRAM_ENV }; // no LINE_CHANNEL_ACCESS_TOKEN at all
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.lineReady, false);
  assert.equal(pushCalls.length, 0, 'LINE never attempted — no token');
  assert.equal(telegramCalls.length, 1, 'Telegram is completely unaffected by LINE missing its token');
  assert.equal(result.telegramReady, true);
  assert.deepEqual(result.telegram, { attempted: 1, succeeded: 1 });
  assert.match(result.lineErrors[0], /LINE_CHANNEL_ACCESS_TOKEN not configured/);
  assert.deepEqual(result.telegramErrors, []);
});

test('V2.6.0 (b) readiness independence, symmetric — Telegram not configured (no TELEGRAM_BOT_TOKEN) -> Telegram not ready, but LINE (fully configured) still sends normally', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, TELEGRAM_CHAT_ID: '-1004328365784' }; // no TELEGRAM_BOT_TOKEN
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.telegramReady, false);
  assert.equal(telegramCalls.length, 0, 'Telegram never attempted — missing bot token');
  assert.equal(pushCalls.length, 1, 'LINE is completely unaffected by Telegram missing its own token');
  assert.equal(result.lineReady, true);
  assert.deepEqual(result.line, { attempted: 1, succeeded: 1 });
  assert.deepEqual(result.telegramErrors, [], 'an unconfigured Telegram degrades silently — never an error');
});

test('V2.6.0 (c) notified-state KV independence — LINE\'s own notified-state KV read fails -> LINE fails closed, 0 push, but Telegram (own, healthy KV key) still sends normally', async () => {
  const store = new Map();
  // A KV whose get() throws ONLY for LINE's own key ('line:notified-state')
  // — subscriptions and Telegram's own key both work normally. Proves the
  // isolation is genuinely per-KEY, not merely per-env-var.
  const kv = {
    async get(key) {
      if (key === 'line:notified-state') throw new Error('line notified-state KV outage');
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.lineReady, false, 'LINE fails closed — its own notified-state KV read threw');
  assert.equal(pushCalls.length, 0, 'LINE never pushes when fail-closed, even though subscriptions/token were fine');
  assert.match(result.lineErrors.find((e) => e.includes('notified state unavailable')) || '', /notified state unavailable/);
  assert.equal(result.telegramReady, true, 'Telegram reads its OWN key (telegram:notified-state), untouched by the outage');
  assert.equal(telegramCalls.length, 1, 'Telegram sends normally, completely unaffected by LINE\'s KV outage');
  assert.deepEqual(result.telegram, { attempted: 1, succeeded: 1 });
});

test('V2.6.0 (d) notified-state KV independence, symmetric — Telegram\'s own notified-state KV read fails -> Telegram fails closed, 0 send, but LINE (own, healthy KV key) still sends normally', async () => {
  const store = new Map();
  const kv = {
    async get(key) {
      if (key === 'telegram:notified-state') throw new Error('telegram notified-state KV outage');
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineAndTelegramFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv, ...TELEGRAM_ENV };
  const result = await runAiApprovedPbsBroadcast(env, { event: pbsAccidentEvent(), now: WITHIN_HOURS });
  assert.equal(result.telegramReady, false, 'Telegram fails closed — its own notified-state KV read threw');
  assert.equal(telegramCalls.length, 0, 'Telegram never sends when fail-closed, even though its token/chat_id were fine');
  assert.match(result.telegramErrors.find((e) => e.includes('telegram notified state unavailable')) || '', /telegram notified state unavailable/);
  assert.equal(result.lineReady, true, 'LINE reads its OWN key (line:notified-state), untouched by the outage');
  assert.equal(pushCalls.length, 1, 'LINE sends normally, completely unaffected by Telegram\'s KV outage');
  assert.deepEqual(result.line, { attempted: 1, succeeded: 1 });
});
