// V1.9.9 Phase 3B — src/pbs/aiDecisionEngine.js unit tests: prompt
// building, structured-output validation, and the cache-lookup -> AI-call
// -> validate -> persist orchestration (resolveAiDecision), using a
// deterministic mocked env.AI.run adapter — never a real Workers AI call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PBS_AI_MODEL_ID,
  buildAiRequest,
  validateAiDecisionResponse,
  resolveAiDecision,
} from '../src/pbs/aiDecisionEngine.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { buildAiCandidate } from '../src/pbs/aiCandidate.js';

function countingKV() {
  const store = new Map();
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

function candidateFor(comment) {
  const raw = {
    UID: 'PBS-UID-1',
    road: '國道一號',
    areaNm: '國道一號北向',
    direction: '北向',
    roadtype: '',
    comment,
    happendate: '2026-08-28',
    happentime: '10:00:00',
    modDttm: '2026-08-28 10:00:00',
    x1: 121.0,
    y1: 24.8,
    srcdetail: 'test',
  };
  return buildAiCandidate(normalizePbsEvent(raw), { lifecycle: 'NEW', generatedAt: '2026-08-28T10:00:00+08:00' });
}

function mockAi(responseText, { throwError, usage } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (throwError) throw throwError;
      return { response: responseText, usage };
    },
  };
}

// --- buildAiRequest ------------------------------------------------------

test('buildAiRequest: fixed model id, chat-shaped messages, minimal candidate fields only', () => {
  const candidate = candidateFor('國道一號北向94公里處發生追撞事故，雙向封閉');
  const request = buildAiRequest(candidate);
  assert.equal(request.model, '@cf/qwen/qwen3-30b-a3b-fp8');
  assert.equal(request.model, PBS_AI_MODEL_ID);
  assert.equal(request.input.messages.length, 2);
  assert.equal(request.input.messages[0].role, 'system');
  assert.equal(request.input.messages[1].role, 'user');
  const userPayload = JSON.parse(request.input.messages[1].content);
  // V2.4.5 — blockedLanes added (order section 七/八): a deterministic
  // structured fact, always present (null when the candidate carries
  // none — same shape as displayKM), so the model never has to re-derive
  // a lane count from free text. See aiCandidate.js/aiDecisionEngine.js's
  // own V2.4.5 comments.
  // V2.4.11 — debrisRisk added (order section 九): traffic/debrisRiskPolicy.js's
  // own deterministic classification, same "always present, null when
  // absent" shape as blockedLanes/displayKM.
  assert.deepEqual(
    Object.keys(userPayload).sort(),
    ['areaNm', 'blockedLanes', 'comment', 'debrisRisk', 'displayKM', 'direction', 'eventType', 'road', 'sourceDetail'].sort()
  );
  assert.equal(userPayload.blockedLanes, null); // this fixture's candidate never sets it
  assert.equal(userPayload.debrisRisk.isDebrisEvent, false); // this fixture's candidate is a non-debris (accident) event
  assert.equal(userPayload.debrisRisk.classification, null);
  // Never a full PBS batch / trace / KV state / LINE state / CCTV metadata:
  assert.ok(!('notify' in userPayload));
  assert.ok(!('locationQuality' in userPayload));
});

test('buildAiRequest: system prompt never reproduces the retired MAJOR_ACCIDENT_ONLY/type-whitelist vocabulary', () => {
  const candidate = candidateFor('國道一號北向94公里處施工');
  const request = buildAiRequest(candidate);
  const systemPrompt = request.input.messages[0].content;
  assert.ok(!systemPrompt.includes('MAJOR_ACCIDENT_ONLY'));
  assert.ok(!systemPrompt.includes('accident'));
});

// --- validateAiDecisionResponse -------------------------------------------

test('validateAiDecisionResponse: a clean, valid response passes', () => {
  const result = validateAiDecisionResponse('{"notify": true, "impact": "HIGH", "reason": "雙向封閉，營業車必須改道", "confidence": 0.95}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision, { notify: true, impact: 'HIGH', reason: '雙向封閉，營業車必須改道', confidence: 0.95, cleanSummary: null });
});

test('validateAiDecisionResponse: tolerates surrounding prose around the JSON object', () => {
  const result = validateAiDecisionResponse('這是我的判斷：\n```json\n{"notify": false, "impact": "LOW", "reason": "短時間可通行", "confidence": 0.6}\n```\n希望有幫助！');
  assert.equal(result.ok, true);
  assert.equal(result.decision.notify, false);
});

test('validateAiDecisionResponse: empty response -> AI_DECISION_INVALID', () => {
  assert.equal(validateAiDecisionResponse('').ok, false);
  assert.equal(validateAiDecisionResponse('   ').ok, false);
  assert.equal(validateAiDecisionResponse(null).reason, 'AI_DECISION_INVALID');
});

test('validateAiDecisionResponse: not valid JSON -> AI_DECISION_INVALID', () => {
  const result = validateAiDecisionResponse('{notify: true, this is not json}');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AI_DECISION_INVALID');
});

test('validateAiDecisionResponse: notify not boolean -> invalid', () => {
  const result = validateAiDecisionResponse('{"notify": "yes", "impact": "HIGH", "reason": "x", "confidence": 0.5}');
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'notify-not-boolean');
});

test('validateAiDecisionResponse: impact outside HIGH/LOW enum -> invalid', () => {
  const result = validateAiDecisionResponse('{"notify": true, "impact": "MEDIUM", "reason": "x", "confidence": 0.5}');
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'impact-invalid');
});

test('validateAiDecisionResponse: missing reason -> invalid', () => {
  const result = validateAiDecisionResponse('{"notify": true, "impact": "HIGH", "confidence": 0.5}');
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'reason-missing');
});

test('validateAiDecisionResponse: confidence out of [0,1] range -> invalid', () => {
  assert.equal(validateAiDecisionResponse('{"notify": true, "impact": "HIGH", "reason": "x", "confidence": 1.5}').ok, false);
  assert.equal(validateAiDecisionResponse('{"notify": true, "impact": "HIGH", "reason": "x", "confidence": -0.1}').ok, false);
  assert.equal(validateAiDecisionResponse('{"notify": true, "impact": "HIGH", "reason": "x", "confidence": "0.5"}').ok, false);
});

test('validateAiDecisionResponse: reason longer than 80 chars is truncated, not rejected', () => {
  const longReason = '極'.repeat(100);
  const result = validateAiDecisionResponse(`{"notify": true, "impact": "HIGH", "reason": "${longReason}", "confidence": 0.9}`);
  assert.equal(result.ok, true);
  assert.ok(result.decision.reason.length <= 81); // 80 chars + ellipsis
});

// --- resolveAiDecision (cache + call orchestration) ------------------------

test('resolveAiDecision: cache miss -> calls Workers AI exactly once, persists a valid decision', async () => {
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, AI: mockAi('{"notify": true, "impact": "HIGH", "reason": "雙向封閉", "confidence": 0.9}') };
  const candidate = candidateFor('國道一號北向94公里處雙向封閉');
  const result = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp1' }, new Date());
  assert.equal(result.source, 'ai-call');
  assert.equal(result.ok, true);
  assert.equal(result.decision.notify, true);
  assert.equal(env.AI.calls.length, 1);
  assert.equal(kv.putCalls, 1, 'a validated decision must be persisted to the cache');
});

test('resolveAiDecision: cache hit -> 0 Workers AI calls, reuses the persisted decision', async () => {
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, AI: mockAi('{"notify": true, "impact": "HIGH", "reason": "雙向封閉", "confidence": 0.9}') };
  const candidate = candidateFor('國道一號北向94公里處雙向封閉');
  const first = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp-same' }, new Date());
  assert.equal(first.source, 'ai-call');
  assert.equal(env.AI.calls.length, 1);

  const second = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp-same' }, new Date());
  assert.equal(second.source, 'cache-hit');
  assert.equal(second.ok, true);
  assert.deepEqual(second.decision, first.decision);
  assert.equal(env.AI.calls.length, 1, 'a cache hit must never call Workers AI again');
});

test('resolveAiDecision: a changed fingerprint for the same eventId is a cache miss -> new AI call', async () => {
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, AI: mockAi('{"notify": true, "impact": "HIGH", "reason": "雙向封閉", "confidence": 0.9}') };
  const candidate = candidateFor('國道一號北向94公里處雙向封閉');
  await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp-a' }, new Date());
  await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp-b' }, new Date());
  assert.equal(env.AI.calls.length, 2);
});

test('resolveAiDecision: Workers AI binding missing -> AI_CALL_FAILED, no throw', async () => {
  const env = { TRAFFIC_KV: countingKV() }; // no env.AI at all
  const candidate = candidateFor('國道一號北向94公里處雙向封閉');
  const result = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp1' }, new Date());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AI_CALL_FAILED');
  assert.equal(result.detail, 'ai-binding-missing');
});

test('resolveAiDecision: Workers AI run() throws (network/5xx/429-shaped) -> AI_CALL_FAILED, no throw, not cached', async () => {
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, AI: mockAi(null, { throwError: new Error('429 Too Many Requests') }) };
  const candidate = candidateFor('國道一號北向94公里處雙向封閉');
  const result = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp1' }, new Date());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AI_CALL_FAILED');
  assert.equal(kv.putCalls, 0, 'a failed call must never be cached');
});

test('resolveAiDecision: Workers AI returns invalid JSON -> AI_DECISION_INVALID, not cached', async () => {
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, AI: mockAi('這不是JSON喔') };
  const candidate = candidateFor('國道一號北向94公里處雙向封閉');
  const result = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp1' }, new Date());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AI_DECISION_INVALID');
  assert.equal(kv.putCalls, 0, 'an invalid decision must never be cached (a later retry should get a fresh attempt)');
});

test('resolveAiDecision: notify=false is a valid, cacheable decision (not an error)', async () => {
  const kv = countingKV();
  const env = { TRAFFIC_KV: kv, AI: mockAi('{"notify": false, "impact": "LOW", "reason": "短時間可通行", "confidence": 0.7}') };
  const candidate = candidateFor('國道一號北向94公里處小型事故，車輛已排除');
  const result = await resolveAiDecision(env, candidate, { eventId: 'E1', fingerprint: 'fp1' }, new Date());
  assert.equal(result.ok, true);
  assert.equal(result.decision.notify, false);
  assert.equal(kv.putCalls, 1);
});
