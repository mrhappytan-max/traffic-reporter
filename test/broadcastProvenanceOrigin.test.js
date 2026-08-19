// V1.8.6.4 (provenance gap, follow-up round) — origin metadata: WHICH raw
// field actually produced `type`/`locationDescription`/`displayKM`.
//
// Covers: normalize.js/classify.js-level unit tests for TDX classification
// provenance (EventType/EventSubType/Category/description-fallback) and
// location provenance (LocationDescription/Location.Description), PBS
// classification/areaNm/displayKM provenance, plus pipeline-level proof
// that none of this changes event.type, formattedOutput, fingerprint,
// eligibility, or network call counts — and that a provenance KV failure
// still never affects the real LINE push.
//
// No TDX/PBS probe, no real LINE push, no deploy — local fixtures + mock
// KV/fetch only, same conventions as test/broadcastProvenance.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { classifyPbsEvent } from '../src/pbs/classify.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { computeNotificationFingerprint } from '../src/traffic/notified.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { runLineBroadcast } from '../src/traffic/broadcastPipeline.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { PROVENANCE_KEY_PREFIX } from '../src/traffic/broadcastProvenance.js';

// ===========================================================================
// 1/2/3/4. TDX classification provenance — which field won.
// ===========================================================================

test('1. TDX EventType wins -> classificationSource.field = "EventType"', () => {
  const raw = {
    EventID: 'T1',
    EventType: '事故',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向' } },
  };
  const event = normalizeRoadEvent(raw, 'freeway');
  assert.equal(event.type, 'accident');
  assert.equal(event.provenance.classificationSource.field, 'EventType');
  assert.equal(event.provenance.classificationSource.value, '事故');
  assert.equal(event.provenance.classificationSource.fallback, false);
});

test('2. TDX EventSubType wins (EventType unrecognized) -> classificationSource.field = "EventSubType"', () => {
  const raw = {
    EventID: 'T2',
    EventType: 'X999', // not in EVENT_TYPE_TEXT_MAP, not keyword-classifiable -> loop continues
    EventSubType: '施工',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '雙向' } },
  };
  const event = normalizeRoadEvent(raw, 'highway');
  assert.equal(event.type, 'construction');
  assert.equal(event.provenance.classificationSource.field, 'EventSubType');
  assert.equal(event.provenance.classificationSource.value, '施工');
});

test('3. TDX Category wins (EventType/EventSubType both unrecognized) -> classificationSource.field = "Category"', () => {
  const raw = {
    EventID: 'T3',
    EventType: 'X999',
    EventSubType: 'Y999',
    Category: '事故',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '南向' } },
  };
  const event = normalizeRoadEvent(raw, 'highway');
  assert.equal(event.type, 'accident');
  assert.equal(event.provenance.classificationSource.field, 'Category');
});

test('4. no structured field matches -> description keyword fallback, explicitly marked fallback:true', () => {
  const raw = {
    EventID: 'T4',
    Description: '路段發生車輛事故，請小心',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '北向' } },
  };
  const event = normalizeRoadEvent(raw, 'highway');
  assert.equal(event.type, 'accident');
  assert.equal(event.provenance.classificationSource.field, 'Description');
  assert.equal(event.provenance.classificationSource.fallback, true);
});

// ===========================================================================
// 5/6/7. TDX location provenance.
// ===========================================================================

test('5. LocationDescription hit -> locationSource.field = "LocationDescription"', () => {
  const raw = {
    EventID: 'T5',
    EventType: '施工',
    LocationDescription: '關西－橫山路段',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' } },
  };
  const event = normalizeRoadEvent(raw, 'highway');
  assert.equal(event.locationDescription, '關西－橫山路段');
  assert.equal(event.provenance.locationSource.field, 'LocationDescription');
  assert.equal(event.provenance.locationSource.value, '關西－橫山路段');
});

test('6. Location.Description hit (LocationDescription absent) -> locationSource.field = "Location.Description"', () => {
  const raw = {
    EventID: 'T6',
    EventType: '施工',
    Location: {
      Description: '關西鎮附近路段',
      FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' },
    },
  };
  const event = normalizeRoadEvent(raw, 'highway');
  assert.equal(event.locationDescription, '關西鎮附近路段');
  assert.equal(event.provenance.locationSource.field, 'Location.Description');
});

test('7. no human location field at all -> locationSource is never fabricated (absent, not guessed)', () => {
  const raw = {
    EventID: 'T7',
    EventType: '施工',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' } },
  };
  const event = normalizeRoadEvent(raw, 'highway');
  assert.equal(event.locationDescription, undefined);
  assert.equal(event.provenance.locationSource, undefined);
  assert.ok(!('locationSource' in event.provenance));
});

// ===========================================================================
// 8/9/10. PBS provenance.
// ===========================================================================

test('8. PBS classification provenance is identifiable (field + matched evidence)', () => {
  const result = classifyPbsEvent({ roadtype: '事故', comment: '西行內側車道發生事故' });
  assert.equal(result.type, 'accident');
  assert.equal(result.classificationSource.field, 'roadtype+comment'); // "事故" appears in both
  assert.equal(result.classificationSource.value, '事故');

  const commentOnly = classifyPbsEvent({ roadtype: '一般', comment: '路面施工中' });
  assert.equal(commentOnly.type, 'construction');
  assert.equal(commentOnly.classificationSource.field, 'comment');
});

test('9. PBS areaNm provenance is identifiable', () => {
  const event = normalizePbsEvent({
    UID: 'PBS-1',
    road: '台3線',
    direction: '南向',
    areaNm: '新竹縣關西鎮',
    roadtype: '事故',
    comment: '西行發生事故',
    happendate: '2026-08-19',
    happentime: '08:00:00',
    modDttm: '2026-08-19 08:05:00',
  });
  assert.equal(event.provenance.locationSource.field, 'areaNm');
  assert.equal(event.provenance.locationSource.value, '新竹縣關西鎮');
});

test('10. PBS displayKM provenance is identifiable as coming from comment, with only the matched substring kept', () => {
  const event = normalizePbsEvent({
    UID: 'PBS-2',
    road: '國道一號',
    direction: '南向',
    areaNm: '新竹市',
    roadtype: '事故',
    comment: '西行在8.1公里處內側車道發生交通事故',
    happendate: '2026-08-19',
    happentime: '08:00:00',
    modDttm: '2026-08-19 08:05:00',
  });
  assert.equal(event.displayKM, 8.1);
  assert.equal(event.provenance.displayKMSource.field, 'comment');
  assert.equal(event.provenance.displayKMSource.value, '8.1公里');
  // The full comment text is never stored under displayKMSource — only the matched substring.
  assert.doesNotMatch(event.provenance.displayKMSource.value, /西行在|內側車道/);
});

// ===========================================================================
// 11/12. Provenance never changes event.type or formattedOutput.
// ===========================================================================

test('11. adding provenance never changes the normalized event.type itself', () => {
  const withEventType = normalizeRoadEvent({ EventID: 'A', EventType: '施工', Location: { FreeExpressHighway: { Road: '台3線', Direction: '雙向' } } }, 'highway');
  assert.equal(withEventType.type, 'construction');

  const pbsEvent = normalizePbsEvent({
    UID: 'B',
    road: '台3線',
    direction: '南向',
    areaNm: '關西鎮',
    roadtype: '事故',
    comment: '事故',
    happendate: '2026-08-19',
    happentime: '08:00:00',
    modDttm: '2026-08-19 08:05:00',
  });
  assert.equal(pbsEvent.type, 'accident');
});

test('12. formatEventMessage output is byte-for-byte identical with or without the new provenance field present', () => {
  const baseEvent = {
    type: 'construction',
    road: '台3線',
    direction: '雙向',
    startKM: '78K+500',
    endKM: '79K+200',
    locationDescription: '關西－橫山路段',
    description: '施工',
    updatedAt: '2026-08-19T08:10:00+08:00',
  };
  const withoutProvenance = formatEventMessage(baseEvent);
  const withProvenance = formatEventMessage({
    ...baseEvent,
    provenance: { classificationSource: { field: 'EventType', value: '施工', fallback: false } },
  });
  assert.equal(withoutProvenance, withProvenance);
});

// ===========================================================================
// 13/14. Fingerprint / eligibility unaffected.
// ===========================================================================

test('13. computeNotificationFingerprint is identical with or without event.provenance present', () => {
  const baseEvent = { type: 'accident', road: '台3線', direction: '南向', startKM: '82K+300', description: '事故' };
  const fpWithout = computeNotificationFingerprint(baseEvent);
  const fpWith = computeNotificationFingerprint({ ...baseEvent, provenance: { classificationSource: { field: 'EventType', value: '事故' } } });
  assert.equal(fpWithout, fpWith);
});

test('14. getBroadcastEligibility is identical with or without event.provenance present', () => {
  const baseEvent = { type: 'construction', title: '施工', description: '車道封閉施工' };
  const withoutProvenance = getBroadcastEligibility(baseEvent);
  const withProvenance = getBroadcastEligibility({ ...baseEvent, provenance: { classificationSource: { field: 'EventType', value: '施工' } } });
  assert.deepEqual(withoutProvenance, withProvenance);
});

// ===========================================================================
// 15/16. End-to-end through runLineBroadcast: 0 extra network calls, and a
// provenance KV failure still never affects the real LINE push.
// ===========================================================================

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const ENROLLED_AT = new Date('2026-08-01T00:00:00+08:00');
let originalFetch;
let pushCalls;
let fetchCallCount;

function mockLinePushFetch() {
  pushCalls = [];
  fetchCallCount = 0;
  return async (url, init) => {
    fetchCallCount += 1;
    pushCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('15. a real TDX-origin push with full provenance data makes exactly 1 network call (the LINE push itself) — 0 extra TDX/PBS calls', async () => {
  const kv = createMockKV();
  await setUserEnabled(kv, 'U1', true, ENROLLED_AT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-19T09:00:00+08:00');

  const rawTdx = {
    EventID: 'FRW-PROV-1',
    EventType: '事故',
    LocationDescription: '關西－橫山路段',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' } },
  };
  const event = normalizeRoadEvent(rawTdx, 'highway');

  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(fetchCallCount, 1); // exactly the one real LINE push — no TDX/PBS re-query happened

  const provenanceKeys = [...kv.store.keys()].filter((k) => k.startsWith(`${PROVENANCE_KEY_PREFIX}:`));
  assert.equal(provenanceKeys.length, 1);
  const record = JSON.parse(kv.store.get(provenanceKeys[0]));
  assert.equal(record.classificationSource.field, 'EventType');
  assert.equal(record.locationSource.field, 'LocationDescription');
});

test('16. a provenance KV write failure (now carrying origin metadata) still never affects the real LINE push or notified-state', async () => {
  const inner = createMockKV();
  await setUserEnabled(inner, 'U1', true, ENROLLED_AT);
  const kv = {
    store: inner.store,
    async get(key) {
      return inner.get(key);
    },
    async put(key, value, options) {
      if (key.startsWith(`${PROVENANCE_KEY_PREFIX}:`)) throw new Error('simulated provenance KV outage');
      return inner.put(key, value, options);
    },
    async list(args) {
      return inner.list(args);
    },
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLinePushFetch();
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const now = new Date('2026-08-19T09:00:00+08:00');

  const rawTdx = {
    EventID: 'FRW-PROV-2',
    EventType: '施工',
    // Needs BOTH a parseable Chinese date range (construction is an
    // "announced" type — see effectiveWindow.js — active 08:00-12:00,
    // `now` below is 09:00, so it's currently active) AND a construction-
    // impact keyword (交通管制) to be broadcast-relevant AND eligible.
    Description: '8月19日8時至12時台3線雙向路段進行路面施工，交通管制中',
    LocationDescription: '關西－橫山路段',
    Location: { FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' } },
  };
  const event = normalizeRoadEvent(rawTdx, 'highway');

  const result = await runLineBroadcast(env, { allEvents: [event], dedupeAvailable: true, now });
  assert.equal(result.pushSucceeded, 1);
  assert.equal(fetchCallCount, 1);
  const provenanceKeys = [...inner.store.keys()].filter((k) => k.startsWith(`${PROVENANCE_KEY_PREFIX}:`));
  assert.equal(provenanceKeys.length, 0); // write failed, as simulated — but the real push above still succeeded
});
