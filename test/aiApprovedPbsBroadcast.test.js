// V1.9.9 Phase 3B — src/traffic/aiApprovedPbsBroadcast.js unit tests.
// Same mock conventions as test/broadcastPipeline.test.js: an in-memory KV,
// a captured LINE push fetch, real subscriptions.js state.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runAiApprovedPbsBroadcast } from '../src/traffic/aiApprovedPbsBroadcast.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

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
