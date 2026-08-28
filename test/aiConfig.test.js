// V1.9.9 Phase 3B — src/pbs/aiConfig.js (order section 十八, kill switch).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PBS_AI_DECISION_ENABLED_DEFAULT, resolvePbsAiDecisionEnabled } from '../src/pbs/aiConfig.js';

test('PBS_AI_DECISION_ENABLED_DEFAULT is false — the safe rollout default', () => {
  assert.equal(PBS_AI_DECISION_ENABLED_DEFAULT, false);
});

test('resolvePbsAiDecisionEnabled(env) defaults to false with no env override', () => {
  assert.equal(resolvePbsAiDecisionEnabled({}), false);
  assert.equal(resolvePbsAiDecisionEnabled(undefined), false);
});

test('resolvePbsAiDecisionEnabled(env) honors an explicit env override', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: true }), true);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: false }), false);
});

test('resolvePbsAiDecisionEnabled(env) ignores a non-boolean value (fails to the safe default)', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'true' }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 1 }), false);
});
