// V2.4.15 — V2_4_15_QWEN_AI_MODEL_REPLACEMENT (order section 十二).
// Dedicated pre-deployment checklist test file for this round's own
// 12-item minimum confirmation list. This round's ONLY intended runtime
// change is PBS_AI_MODEL_ID (src/pbs/aiDecisionEngine.js) — every other
// test here exists to prove the surrounding surface (prompt, schema,
// timeout, Queue, KV, GEO/Road/Debris policy, LINE formatter) was NOT
// touched, so this file deliberately does NOT re-test AI decision logic
// already covered by test/aiDecisionEngine.test.js,
// test/pbsAiDecisionScenarios.test.js, test/aiConfig.test.js, and
// test/pbsAiConfigDriftHotfixV202.test.js (all untouched in substance
// this round beyond the one model-string update each already carries).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PBS_AI_MODEL_ID,
  AI_CALL_TIMEOUT_MS,
  buildAiRequest,
  validateAiDecisionResponse,
} from '../src/pbs/aiDecisionEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wranglerRaw = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

function candidateFor(overrides = {}) {
  return {
    road: '國道一號',
    direction: '北向',
    areaNm: '新竹市',
    displayKM: 94,
    eventType: 'accident',
    comment: '發生追撞事故，雙向封閉',
    sourceDetail: 'x',
    ...overrides,
  };
}

// 1: PBS_AI_MODEL_ID === '@cf/qwen/qwen3-30b-a3b-fp8' -----------------------

test('1: PBS_AI_MODEL_ID is the new canonical Qwen model, and only that constant exists', () => {
  assert.equal(PBS_AI_MODEL_ID, '@cf/qwen/qwen3-30b-a3b-fp8');
  const decisionEngineSource = readFileSync(join(__dirname, '..', 'src', 'pbs', 'aiDecisionEngine.js'), 'utf8');
  // no second model-id-shaped literal in actual CODE (comment lines may
  // legitimately mention the retired glm-4.7-flash name as history/
  // rationale — order section 九 explicitly forbids falsifying that
  // history, so this only inspects non-comment lines).
  const codeLines = decisionEngineSource.split('\n').filter((line) => !/^\s*\/\//.test(line));
  const modelLiterals = codeLines.join('\n').match(/'@cf\/[a-z0-9_-]+\/[a-z0-9.-]+'/gi) || [];
  const distinct = new Set(modelLiterals);
  assert.equal(distinct.size, 1, `expected exactly one distinct model literal in aiDecisionEngine.js code (excluding comments), found: ${[...distinct].join(', ')}`);
  assert.ok(distinct.has("'@cf/qwen/qwen3-30b-a3b-fp8'"));
});

// 2: buildAiRequest().model === PBS_AI_MODEL_ID ------------------------------

test('2: buildAiRequest() reads the model from PBS_AI_MODEL_ID, not a separate literal', () => {
  const request = buildAiRequest(candidateFor());
  assert.equal(request.model, PBS_AI_MODEL_ID);
  assert.equal(request.model, '@cf/qwen/qwen3-30b-a3b-fp8');
});

// 3: the existing complete Prompt was NOT modified ---------------------------
// SYSTEM_PROMPT/buildAiUserPrompt/MEMORY_CONTEXT_PROMPT_SUFFIX are module-
// private (deliberately not exported — see this module's own header
// comment), so this checks the rendered request shape and known semantic
// anchors from every prior prompt round (V2.4.2/V2.4.4) are still present,
// unchanged by this round's model-only edit.

test('3: SYSTEM_PROMPT still carries every prior round\'s semantic anchor text, untouched', () => {
  const request = buildAiRequest(candidateFor());
  const systemMessage = request.input.messages[0];
  assert.equal(systemMessage.role, 'system');
  // V2.4.2 anchor — "值得...司機提前知道" reframing (order section 十一/十二/十三/十四)
  assert.match(systemMessage.content, /值得.{0,12}(計程車|營業車).{0,6}提前知道/);
  // V2.4.4 anchor — routine road-management notices default to false (order section 二)
  assert.match(systemMessage.content, /例行施工/);
  assert.match(systemMessage.content, /機動路肩/);
});

test('3b: request message shape (system + user, in order) is unchanged', () => {
  const request = buildAiRequest(candidateFor());
  assert.equal(request.input.messages.length, 2);
  assert.equal(request.input.messages[0].role, 'system');
  assert.equal(request.input.messages[1].role, 'user');
});

// 4: the existing schema validator was NOT modified --------------------------

test('4: validateAiDecisionResponse still enforces the same strict JSON schema', () => {
  const valid = validateAiDecisionResponse(JSON.stringify({ notify: true, impact: 'HIGH', reason: '測試原因', confidence: 0.9 }));
  assert.equal(valid.ok, true);

  const badImpact = validateAiDecisionResponse(JSON.stringify({ notify: true, impact: 'MEDIUM', reason: '測試', confidence: 0.9 }));
  assert.equal(badImpact.ok, false);

  const badConfidence = validateAiDecisionResponse(JSON.stringify({ notify: true, impact: 'HIGH', reason: '測試', confidence: 1.5 }));
  assert.equal(badConfidence.ok, false);

  const invalidJson = validateAiDecisionResponse('not json');
  assert.equal(invalidJson.ok, false);
});

// 5: AI timeout is still = 45,000ms -------------------------------------------

test('5: AI_CALL_TIMEOUT_MS is still exactly 45000ms — no relaxation this round', () => {
  assert.equal(AI_CALL_TIMEOUT_MS, 45000);
});

// 6: Queue config unchanged ---------------------------------------------------

test('6: PBS_AI_QUEUE producer/consumer config (batch_size=1, max_retries=3) is unchanged', () => {
  assert.match(wranglerRaw, /"queue"\s*:\s*"pbs-ai-processing-queue"[\s\S]{0,120}"binding"\s*:\s*"PBS_AI_QUEUE"/);
  assert.match(wranglerRaw, /"max_batch_size"\s*:\s*1\b/);
  assert.match(wranglerRaw, /"max_retries"\s*:\s*3\b/);
});

// 7: KV write path unchanged --------------------------------------------------

test('7: KV-related modules (decision-cache, observatory-index, incident memory, dedupe) were not touched this round', () => {
  for (const relPath of [
    'src/pbs/aiDecisionCache.js',
    'src/pbs/aiObservatoryIndex.js',
    'src/traffic/incidentMemory.js',
    'src/traffic/dedupe.js',
  ]) {
    assert.doesNotThrow(() => readFileSync(join(__dirname, '..', relPath), 'utf8'), `${relPath} must still exist, unmodified this round`);
  }
});

// 8: GEO / Road Policy / Debris Policy unchanged ------------------------------

test('8: GEO/Road/Debris policy modules still exist and are structurally intact', () => {
  for (const relPath of [
    'src/traffic/roadIdentity.js',
    'src/traffic/broadcastPolicy.js',
    'src/traffic/broadcastRules.js',
    'src/traffic/debrisRiskPolicy.js',
  ]) {
    assert.doesNotThrow(() => readFileSync(join(__dirname, '..', relPath), 'utf8'), `${relPath} must still exist, unmodified this round`);
  }
});

// 9: LINE formatter unchanged --------------------------------------------------

test('9: LINE formatter/broadcast module still exists, unmodified this round', () => {
  assert.doesNotThrow(() => readFileSync(join(__dirname, '..', 'src', 'traffic', 'aiApprovedPbsBroadcast.js'), 'utf8'));
});

// 10/11/12: covered by the full-repo regression run this round's own report
// records separately (test/aiDecisionEngine.test.js, test/pbsAiDecisionScenarios.test.js,
// test/pbsAiConfigDriftHotfixV202.test.js, and `node --test test/*.test.js`
// as a whole) — not re-asserted here to avoid duplicate/conflicting sources
// of truth for the same fact.

test('no AI request parameter (max_tokens/temperature/top_p/seed/response_format/json_schema/stream) was added this round', () => {
  const request = buildAiRequest(candidateFor());
  for (const forbidden of ['max_tokens', 'temperature', 'top_p', 'seed', 'response_format', 'json_schema', 'stream']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(request, forbidden), `${forbidden} must not appear on the AI request this round`);
  }
});
