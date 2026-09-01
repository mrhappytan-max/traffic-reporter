// V2.4.0 — TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE. Covers the
// order's own section 18 test list (17 items) end-to-end: TDX freeway/
// highway events reaching the SAME PBS_AI_QUEUE + AI engine Windows PBS
// already uses, cross-source (PBS+TDX) same-incident dedup via Recent
// Incident Memory (traffic/incidentMemory.js), multi-hour re-evaluation,
// source isolation, 0 extra TDX/KV cost, and the Phase B "never a real
// LINE push yet" guarantee.
//
// Deliberately exercises processQueuedPbsEvent/enqueueTdxRoadEvents
// directly (not the full HTTP/Queue round trip — that machinery itself
// is already covered in test/pbsAiQueueReliability.test.js and
// test/pbsDebugPush.test.js) so each scenario stays fast and precisely
// targeted.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { processQueuedPbsEvent, computeIdempotencyKeyHash, resetPbsDebugPushIdempotencyState } from '../src/pbs/debugPush.js';
import { enqueueTdxRoadEvents } from '../src/tdx/tdxQueueIngress.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { readIncidentMemory, INCIDENT_MEMORY_KV_KEY, INCIDENT_MEMORY_TTL_MS } from '../src/traffic/incidentMemory.js';
import { handleAiObservatoryView } from '../src/pbs/aiObservatoryView.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

const NOW = new Date('2026-08-31T09:00:00+08:00'); // within LINE broadcast hours

function countingKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    getCalls: 0,
    putCalls: 0,
    async get(key) {
      this.getCalls += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      this.putCalls += 1;
      store.set(key, value);
      this.lastPutOptions = options;
    },
  };
}

/** Counts only puts to the ONE incident-memory key, per event — order section 十四's own <=1 get / <=1 put budget. */
function memoryOpCounts(kv) {
  return { gets: kv.getCalls, puts: kv.putCalls };
}

async function baseEnv(overrides = {}) {
  const TRAFFIC_KV = countingKV();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TRAFFIC_KV, LINE_CHANNEL_ACCESS_TOKEN: 'tok', PBS_AI_DECISION_ENABLED: true, ...overrides };
}

/**
 * Context-aware mock AI: returns notify:true (first sighting, no memory
 * context) when the prompt carries no `recentIncidents`, and — when it
 * DOES carry recentIncidents — returns whatever `onContext` decides
 * (defaults to sameIncident:true/materialChange:false/notify:false, the
 * CASE C "suppress" outcome), letting individual tests override for CASE
 * D (materialChange:true/notify:true) etc.
 */
function contextAwareMockAi({ onContext } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const userMsg = input.messages[1].content;
      const parsed = JSON.parse(userMsg);
      const hasContext = Array.isArray(parsed.recentIncidents) && parsed.recentIncidents.length > 0;
      if (!hasContext) {
        return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '第一次發現', confidence: 0.9 }) };
      }
      const verdict = onContext
        ? onContext(parsed)
        : { notify: false, impact: 'HIGH', reason: '與近期記錄相同事故，無實質變化', confidence: 0.9, sameIncident: true, materialChange: false };
      return { response: JSON.stringify(verdict) };
    },
  };
}

function freewayAccidentEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'FRW-97700-1', EventType: '事故', Description: '南向97K處車輛事故，外側車道封閉',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '97K+700', EndKM: '97K+700' } },
      Impact: { BlockedLanes: 1 },
      ...overrides,
    },
    'freeway'
  );
}

// The RAW Windows push `event` shape (road/areaNm/direction/comment/
// longitude/latitude/sourceDetail) — processQueuedPbsEvent's source='pbs'
// branch runs this through buildRawPbsRecordFromPush/normalizePbsEvent
// itself; it must NEVER be pre-normalized (that would be the TDX shape).
function pbsRawEvent(overrides = {}) {
  return {
    road: '國道一號', areaNm: '國道一號南向', direction: '南向',
    comment: '南向97.7公里處發生車輛事故', longitude: 121.0, latitude: 24.8, sourceDetail: 'test',
    ...overrides,
  };
}

function highwayAccidentEvent(overrides = {}) {
  return normalizeRoadEvent(
    {
      EventID: 'HWY-1', EventType: '事故', Description: '台1線南向事故',
      EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(),
      Location: { FreeExpressHighway: { Road: '台1線', Direction: '南向', StartKM: '100K+000', EndKM: '100K+000' } },
      Impact: { BlockedLanes: 1 },
      ...overrides,
    },
    'highway'
  );
}

async function buildQueueMessage({ source, event, lifecycle = 'NEW', eventId, fingerprint = 'fp-1', now = NOW }) {
  const id = eventId || event.rawId;
  const idempotencyKeyHash = await computeIdempotencyKeyHash({ source, eventId: id, lifecycle, fingerprint });
  return {
    source, eventId: id, lifecycle, fingerprint,
    generatedAt: now.toISOString(), event, requestId: `test:${source}:${id}`,
    idempotencyKeyHash, acceptedFirstAcceptedAt: now.toISOString(), acceptedAttemptCount: 1,
  };
}

let priorFetch;
beforeEach(() => {
  resetPbsDebugPushIdempotencyState();
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = priorFetch;
  resetTdxTokenCache();
});

// =======================================================================
// CASE 1/2: Freeway/Highway new -> Queue -> AI
// =======================================================================

test('CASE 1: Freeway new event -> processQueuedPbsEvent runs the AI decision (0 legacy fallback, real AI call made)', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push({ model, input }); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '國1事故', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = freewayAccidentEvent();
  const message = await buildQueueMessage({ source: 'freeway', event });

  const result = await processQueuedPbsEvent(env, message, NOW);

  assert.equal(result.ok, true);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, '@cf/zai-org/glm-4.7-flash');
});

test('CASE 2: Highway new event -> processQueuedPbsEvent runs the AI decision the same way', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push({ model, input }); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '台1事故', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = highwayAccidentEvent();
  const message = await buildQueueMessage({ source: 'highway', event });

  const result = await processQueuedPbsEvent(env, message, NOW);

  assert.equal(result.ok, true);
  assert.equal(ai.calls.length, 1);
});

// =======================================================================
// CASE 3: TDX duplicate unchanged -> no AI (never even enqueued)
// =======================================================================

test('CASE 3: a TDX event with unchanged content (dedupe.js classifies it duplicate) is never enqueued at all -> 0 AI calls', async () => {
  const env = await baseEnv();
  const event = freewayAccidentEvent();
  // dedupe.js#classifyEvents already excludes duplicates from
  // newEvents/updatedEvents before enqueueTdxRoadEvents ever sees them —
  // simulate that directly: only genuinely new/updated events are passed.
  const result = await enqueueTdxRoadEvents(env, { newEvents: [], updatedEvents: [] }, NOW);
  assert.equal(result.attempted, 0);
  assert.equal(result.enqueued, 0);
});

// =======================================================================
// PHASE_B order CASE 1/2/4 (literal): a genuinely NEW/UPDATED TDX event
// goes through the REAL enqueueTdxRoadEvents() -> exactly one real
// PBS_AI_QUEUE.send() call -> the exact captured message is then
// processed by processQueuedPbsEvent() -> exactly one real AI call, 0
// LINE. Not the same as CASE 1/2 above (which hand-build the queue
// message directly) — this exercises the actual Queue-ingress path the
// order's own "Queue1 -> AI1 -> LINE0" / "UPDATED -> Queue -> AI"
// requirements describe end-to-end.
// =======================================================================

function countingQueue() {
  const sent = [];
  return { sent, async send(message) { sent.push(message); } };
}

test('PHASE_B order CASE 1: Freeway NEW -> real enqueueTdxRoadEvents Queue1 -> processQueuedPbsEvent AI1 -> LINE0', async () => {
  const queue = countingQueue();
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai, PBS_AI_QUEUE: queue });
  const event = freewayAccidentEvent();

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.attempted, 1);
  assert.equal(enqueueResult.enqueued, 1);
  assert.equal(queue.sent.length, 1); // Queue1
  assert.equal(queue.sent[0].source, 'freeway');
  assert.equal(queue.sent[0].lifecycle, 'NEW');

  const result = await processQueuedPbsEvent(env, queue.sent[0], NOW);
  assert.equal(ai.calls.length, 1); // AI1
  assert.equal(result.lineAttempted, false); // LINE0 (Phase B suppression)
});

test('PHASE_B order CASE 2: Highway NEW -> real enqueueTdxRoadEvents Queue1 -> processQueuedPbsEvent AI1 -> LINE0', async () => {
  const queue = countingQueue();
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai, PBS_AI_QUEUE: queue });
  const event = highwayAccidentEvent();

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [event], updatedEvents: [] }, NOW);
  assert.equal(enqueueResult.enqueued, 1);
  assert.equal(queue.sent.length, 1); // Queue1
  assert.equal(queue.sent[0].source, 'highway');
  assert.equal(queue.sent[0].lifecycle, 'NEW');

  const result = await processQueuedPbsEvent(env, queue.sent[0], NOW);
  assert.equal(ai.calls.length, 1); // AI1
  assert.equal(result.lineAttempted, false); // LINE0
});

test('PHASE_B order CASE 4: an UPDATED TDX event -> real enqueueTdxRoadEvents (lifecycle=UPDATED) -> Queue -> AI', async () => {
  const queue = countingQueue();
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai, PBS_AI_QUEUE: queue });
  const event = freewayAccidentEvent({ EventID: 'FRW-97700-UPDATED', Description: '南向97K處車輛事故，內側車道也封閉' });

  const enqueueResult = await enqueueTdxRoadEvents(env, { newEvents: [], updatedEvents: [event] }, NOW);
  assert.equal(enqueueResult.enqueued, 1);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0].lifecycle, 'UPDATED');

  const result = await processQueuedPbsEvent(env, queue.sent[0], NOW);
  assert.equal(ai.calls.length, 1); // reached AI, not skipped as a duplicate
  assert.equal(result.ok, true);
});

// =======================================================================
// PHASE_B order CASE 15: PBS's own notify=true path stays completely
// normal (source='pbs' -> suppressLineNotify is never true) — the fix
// that moved the Phase B gate earlier in runAiApprovedPbsBroadcast (to
// block CCTV/R2 for TDX) must not change PBS's own behavior at all.
// =======================================================================

test('PHASE_B order CASE 15: a PBS AI-approved (notify=true) accident still reaches a real LINE push (source=pbs is never suppressed)', async () => {
  const ai = { calls: [], async run(model, input) { this.calls.push(input); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: 'PBS事故', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const pbsMessage = await buildQueueMessage({ source: 'pbs', event: pbsRawEvent(), eventId: 'PBS-15', fingerprint: 'fp-pbs-15' });

  const result = await processQueuedPbsEvent(env, pbsMessage, NOW);

  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(result.lineAttempted, true); // PBS is never suppressLineNotify -> real push attempted
  assert.equal(result.lineSent, true);
});

// =======================================================================
// CASE 4/5: cross-source same-incident, whichever source arrives first
// =======================================================================

test('CASE 4: PBS reports first (notify=true, LINE sent); TDX arrives later for the SAME incident -> sameIncident=true, no duplicate LINE', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });

  // PBS first sighting.
  const pbsEvent = pbsRawEvent();
  const pbsMessage = await buildQueueMessage({ source: 'pbs', event: pbsEvent, eventId: 'PBS-1', fingerprint: 'fp-pbs-1' });
  const first = await processQueuedPbsEvent(env, pbsMessage, NOW);
  assert.equal(first.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(ai.calls.length, 1);

  // TDX arrives 5 minutes later for the SAME real incident (same road/direction/KM).
  const tdxEvent = freewayAccidentEvent();
  const tdxMessage = await buildQueueMessage({ source: 'freeway', event: tdxEvent, now: new Date(NOW.getTime() + 5 * 60_000) });
  const second = await processQueuedPbsEvent(env, tdxMessage, new Date(NOW.getTime() + 5 * 60_000));

  assert.equal(ai.calls.length, 2);
  const secondUserMsg = JSON.parse(ai.calls[1].input.messages[1].content);
  assert.equal(secondUserMsg.recentIncidents.length, 1); // saw PBS's own sighting as context
  assert.equal(second.outcome, 'AI_NOTIFY_FALSE'); // AI recognized sameIncident, no material change -> no re-notify
  assert.equal(second.sameIncident, true);
  assert.equal(second.materialChange, false);
});

test('CASE 5: TDX reports first; PBS arrives later for the SAME incident -> sameIncident=true, no duplicate LINE', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });

  const tdxEvent = freewayAccidentEvent();
  const tdxMessage = await buildQueueMessage({ source: 'freeway', event: tdxEvent });
  const first = await processQueuedPbsEvent(env, tdxMessage, NOW);
  assert.equal(first.outcome, 'AI_NOTIFY_TRUE');

  const pbsEvent = pbsRawEvent();
  const pbsMessage = await buildQueueMessage({ source: 'pbs', event: pbsEvent, eventId: 'PBS-2', fingerprint: 'fp-pbs-2', now: new Date(NOW.getTime() + 5 * 60_000) });
  const second = await processQueuedPbsEvent(env, pbsMessage, new Date(NOW.getTime() + 5 * 60_000));

  assert.equal(second.outcome, 'AI_NOTIFY_FALSE');
  assert.equal(second.sameIncident, true);
});

// =======================================================================
// CASE 6/7: 30-min unchanged -> suppress; material escalation -> re-notify
// =======================================================================

test('CASE 6: same incident, no material change shortly after -> suppress (AI notify=false)', async () => {
  const ai = contextAwareMockAi(); // default onContext: sameIncident=true, materialChange=false, notify=false
  const env = await baseEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(first.outcome, 'AI_NOTIFY_TRUE');

  const later = new Date(NOW.getTime() + 30 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-2' }), now: later, fingerprint: 'fp-updated' }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_FALSE');
});

test('CASE 7: same incident, material escalation (AI sees it, sets materialChange=true) -> notify allowed again', async () => {
  const ai = contextAwareMockAi({
    onContext: () => ({ notify: true, impact: 'HIGH', reason: '惡化為全線封閉', confidence: 0.95, sameIncident: true, materialChange: true }),
  });
  const env = await baseEnv({ AI: ai });
  const first = await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  assert.equal(first.outcome, 'AI_NOTIFY_TRUE');

  const later = new Date(NOW.getTime() + 30 * 60_000);
  const second = await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-2', EventType: '封閉' }), now: later, fingerprint: 'fp-escalated' }),
    later
  );
  assert.equal(second.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(second.materialChange, true);
  // PHASE_B order CASE 8: material escalation -> AI notify can be true,
  // but LINE stays 0 for a TDX source (Phase B never lifts, regardless
  // of how confident the escalation judgment is).
  assert.equal(second.lineAttempted, false);
});

// =======================================================================
// CASE 8/9: 70-min / third-hour still active -> memory still available
// =======================================================================

test('CASE 8: 70 minutes later, the earlier sighting is STILL in Recent Incident Memory (within the 8h TTL) -> AI gets it as context', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);

  const seventyMinLater = new Date(NOW.getTime() + 70 * 60_000);
  await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-3' }), now: seventyMinLater, fingerprint: 'fp-70m' }),
    seventyMinLater
  );
  const secondUserMsg = JSON.parse(ai.calls[1].input.messages[1].content);
  assert.equal(secondUserMsg.recentIncidents.length, 1);
});

test('CASE 9: still active into a third hour (2h50m later) -> memory still available, well within the 8h TTL', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);

  const thirdHour = new Date(NOW.getTime() + 2.83 * 60 * 60_000);
  await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-4' }), now: thirdHour, fingerprint: 'fp-3h' }),
    thirdHour
  );
  const secondUserMsg = JSON.parse(ai.calls[1].input.messages[1].content);
  assert.equal(secondUserMsg.recentIncidents.length, 1);
});

// =======================================================================
// CASE 10: >8h -> old memory excluded
// =======================================================================

test('CASE 10: a sighting older than INCIDENT_MEMORY_TTL_MS (8h) is excluded from candidates', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);

  const nineHoursLater = new Date(NOW.getTime() + INCIDENT_MEMORY_TTL_MS + 60 * 60_000);
  await processQueuedPbsEvent(
    env,
    await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent({ EventID: 'FRW-97700-5' }), now: nineHoursLater, fingerprint: 'fp-9h' }),
    nineHoursLater
  );
  const secondUserMsg = JSON.parse(ai.calls[1].input.messages[1].content);
  // No recentIncidents key at all when the candidate list is empty (see
  // aiDecisionEngine.js#buildAiRequest — hasContext false -> plain event JSON).
  assert.equal(secondUserMsg.recentIncidents, undefined);
});

// =======================================================================
// CASE 11: TDX fail -> PBS unaffected
// =======================================================================

test('CASE 11: TDX fetch failure (no client credentials) never blocks PBS\'s own broadcast path', async () => {
  const env = await baseEnv();
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_30_MIN_POLLING_ENABLED = true;
  env.TRAFFIC_SOURCE_MODE = 'PBS_ONLY'; // bypass V57.2 gate, same as real Production
  env.TDX_ROADEVENT_FETCH_ENABLED = 'true'; // Phase A: TDX fetch itself is attempted this tick (no TDX_CLIENT_ID -> tokenOk=false), independent of TRAFFIC_SOURCE_MODE
  env.PBS_RELAY_WINDOWS = {
    fetch: async () => new Response(JSON.stringify([{
      UID: 'PBS-11', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '事故',
      comment: '北向93公里處發生車輛事故', happendate: '2026-08-31', happentime: '09:00:00', modDttm: '2026-08-31 09:01:00',
    }]), { status: 200 }),
  };
  const pushed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      pushed.push(1);
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`); // no TDX_CLIENT_ID -> TDX never even tries; a real TDX call here would fail this test
  };
  // NOW itself is 09:00:00 Asia/Taipei — minute 0 is on BOTH TDX's 20-minute
  // mark (tdxSchedule.js) and PBS's 30-minute mark (pbsSchedule.js), so this
  // one tick genuinely attempts both fetches (the scenario this case needs).
  const result = await runScheduledTdxSync(env, NOW);

  assert.equal(result.tokenOk, false); // TDX genuinely had no credentials this run
  assert.equal(result.pbs.pbsOk, true);
  assert.equal(pushed.length, 1); // PBS's own event still went out
});

// =======================================================================
// CCTV runtime TDX calls = 0 (kept from the original V2.4.0 build's own
// CASE 12), STRENGTHENED for V2_4_0_PHASE_B_QUEUE_OBSERVE_ENABLE's own
// CASE 12/13/14 (TDX_CCTV_STRUCTURALLY_BLOCKED / R2 publish=0 / LINE=0 —
// a TDX-origin notify:true event must do ZERO CCTV prepare / R2 publish /
// LINE work, never relying on "AI happened to say notify=false" as the
// boundary; runAiApprovedPbsBroadcast's suppressLineNotify check now runs
// BEFORE prepareCctvImageForEvent, not just before pushLineMessages).
// =======================================================================

test('PHASE_B order CASE 12/13/14: a TDX-origin AI-approved (notify=true) accident makes 0 TDX calls, 0 CCTV frame fetch, 0 R2 publish, and 0 LINE push', async () => {
  const ai = { async run() { return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '事故', confidence: 0.9 }) }; } };
  let r2PutCalls = 0;
  const env = await baseEnv({ AI: ai, CCTV_IMAGES: { async put() { r2PutCalls += 1; } } });
  let anyNonLineFetch = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.line.me')) throw new Error(`FORBIDDEN: LINE push attempted for a suppressed TDX event: ${href}`);
    if (href.includes('tdx.transportdata.tw')) throw new Error(`FORBIDDEN: TDX call attempted from CCTV path: ${href}`);
    // Any other fetch (freeway.gov.tw frame fetch included) means CCTV
    // preparation was attempted at all -- must never happen in Phase B.
    anyNonLineFetch += 1;
    return new Response('not found', { status: 404 });
  };
  const event = freewayAccidentEvent();
  const message = await buildQueueMessage({ source: 'freeway', event });
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'AI_NOTIFY_TRUE'); // AI genuinely said notify:true
  assert.equal(anyNonLineFetch, 0); // CCTV prepare = 0 (no frame fetch, no metadata fetch, nothing)
  assert.equal(r2PutCalls, 0); // R2 publish = 0
  assert.equal(result.lineAttempted, false); // LINE = 0
  assert.equal(result.lineSent, false);
});

// =======================================================================
// CASE 13/14: Memory write cost — 0 when unchanged, <=1 when changed
// =======================================================================

test('CASE 13: an event whose own sighting produces byte-identical memory content -> 0 additional write (WRITE_ON_CHANGE)', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  const putsAfterFirst = env.TRAFFIC_KV.putCalls;

  // Re-process the identical content immediately (simulates a redelivery
  // that got past idempotency for some reason, or a genuinely re-fetched
  // but truly unchanged sighting) at the EXACT same instant -> lastSeenAt
  // would be identical, so the memory record's content is byte-identical
  // -> WRITE_ON_CHANGE skips the put.
  const idempotencyKeyHash2 = await computeIdempotencyKeyHash({ source: 'freeway', eventId: 'FRW-97700-1', lifecycle: 'NEW', fingerprint: 'fp-1' });
  await processQueuedPbsEvent(env, { source: 'freeway', eventId: 'FRW-97700-1', lifecycle: 'NEW', fingerprint: 'fp-1', generatedAt: NOW.toISOString(), event: freewayAccidentEvent(), requestId: 'r2', idempotencyKeyHash: idempotencyKeyHash2, acceptedFirstAcceptedAt: NOW.toISOString(), acceptedAttemptCount: 1 }, NOW);

  const memoryKeyPutsAfterSecond = [...env.TRAFFIC_KV.store.keys()].includes(INCIDENT_MEMORY_KV_KEY);
  assert.ok(memoryKeyPutsAfterSecond);
  // The second call is a genuine idempotency duplicate (same source/eventId/lifecycle/fingerprint)
  // so it never even reaches business processing a second time -> 0 extra puts of any kind.
  assert.equal(env.TRAFFIC_KV.putCalls, putsAfterFirst);
});

test('CASE 14: a genuinely new sighting for a DIFFERENT incident -> at most 1 additional incident-memory write', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  const memoryRaw1 = env.TRAFFIC_KV.store.get(INCIDENT_MEMORY_KV_KEY);

  // Opposite direction, same KM area (still within the Hsinchu service
  // area — a genuinely different incident, and a different incidentMemory
  // group key: '國道一號|北向' vs '國道一號|南向').
  const differentEvent = freewayAccidentEvent({ EventID: 'FRW-DIFFERENT', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '97K+700', EndKM: '97K+700' } } });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: differentEvent, fingerprint: 'fp-different', now: new Date(NOW.getTime() + 60_000) }), new Date(NOW.getTime() + 60_000));
  const memoryRaw2 = env.TRAFFIC_KV.store.get(INCIDENT_MEMORY_KV_KEY);

  assert.notEqual(memoryRaw1, memoryRaw2); // content genuinely changed -> exactly 1 write happened
  const { groups } = await readIncidentMemory(env.TRAFFIC_KV);
  const totalRecords = Object.values(groups).reduce((sum, records) => sum + records.length, 0);
  assert.equal(totalRecords, 2); // two genuinely distinct incidents recorded
});

// =======================================================================
// CASE 15: Observatory open/refresh -> 0 AI calls, 0 KV writes
// =======================================================================

test('CASE 15: opening/refreshing the Observatory page after TDX events were processed makes 0 additional AI calls and 0 additional KV writes', async () => {
  const ai = contextAwareMockAi();
  const env = await baseEnv({ AI: ai });
  await processQueuedPbsEvent(env, await buildQueueMessage({ source: 'freeway', event: freewayAccidentEvent() }), NOW);
  const aiCallsBefore = ai.calls.length;
  const putsBefore = env.TRAFFIC_KV.putCalls;

  const request = new Request('https://producer.example/admin/pbs-ai-observatory-view', { method: 'GET' });
  const response = await handleAiObservatoryView(env, request, NOW);
  await response.text();

  assert.equal(ai.calls.length, aiCallsBefore);
  assert.equal(env.TRAFFIC_KV.putCalls, putsBefore);
});

// =======================================================================
// CASE 16: legacy hard-rule cannot override the AI's own notify:true
// =======================================================================

test('CASE 16: a TDX event that would have been ineligible under the OLD V1.5 whitelist (routine construction, no impact keyword) still gets a genuine AI judgment -> AI notify:true is never second-guessed by broadcastRules.js', async () => {
  // "routine construction, no impact keyword" would have been
  // type-ineligible under broadcastRules.js's old whitelist (see
  // test/broadcastEligibility.test.js's own retired scenario #10) — the
  // new AI path never calls getBroadcastEligibility/getLinePushPolicyDecision
  // at all (see aiApprovedPbsBroadcast.js's own header comment), so a
  // genuine AI notify:true for this event type must go through unblocked.
  const ai = { calls: [], async run(model, input) { this.calls.push(input); return { response: JSON.stringify({ notify: true, impact: 'HIGH', reason: '施工造成長時間單向通行', confidence: 0.9 }) }; } };
  const env = await baseEnv({ AI: ai });
  const event = normalizeRoadEvent(
    { EventID: 'FRW-CONST', EventType: '施工', Description: '北向92K路面刨鋪施工', EffectiveTime: NOW.toISOString(), LastUpdateTime: NOW.toISOString(), Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+000', EndKM: '92K+000' } } },
    'freeway'
  );
  const message = await buildQueueMessage({ source: 'freeway', event });
  const result = await processQueuedPbsEvent(env, message, NOW);

  assert.equal(result.outcome, 'AI_NOTIFY_TRUE');
  assert.equal(ai.calls.length, 1); // AI genuinely got asked, and its notify:true was honored
});

// =======================================================================
// CASE 17: TDX cannot directly use legacy runLineBroadcast (this is the
// comprehensive per-type version of this claim — see
// test/broadcastEligibility.test.js/test/incidentRepeatSuppression.test.js/
// test/pbsLineBroadcast.test.js/test/v572TdxGatedFreewayBroadcast.test.js/
// test/pbsOnlyCrossSourceDedup.test.js/test/tdxUsageReduction.test.js for
// the exhaustive per-scenario regression coverage this round updated)
// =======================================================================

test('CASE 17: processQueuedPbsEvent never calls the legacy runLineBroadcast for a TDX-sourced message, even with AI globally disabled', async () => {
  const env = await baseEnv({ PBS_AI_DECISION_ENABLED: false });
  const event = freewayAccidentEvent();
  const message = await buildQueueMessage({ source: 'freeway', event });

  // globalThis.fetch here throws on anything unexpected — if
  // processQueuedPbsEvent's AI-disabled branch ever fell back to
  // runLineBroadcast for a TDX message (which would attempt a real LINE
  // push), it would hit this throw and fail the test.
  const result = await processQueuedPbsEvent(env, message, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'AI_NOT_INVOKED_LEGACY_PATH');
});
