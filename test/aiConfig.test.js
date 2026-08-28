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

test('resolvePbsAiDecisionEnabled(env) ignores a non-boolean, non-string value (fails to the safe default)', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 1 }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: {} }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: [] }), false);
});

// V1.9.9 Phase 3D hotfix — Cloudflare Dashboard/CLI Variables inject
// PBS_AI_DECISION_ENABLED as a STRING, not a real boolean. This is the
// root cause GPT Work hit: "true" (string) previously fell through to the
// safe default and Production silently stayed on the legacy path.
test('resolvePbsAiDecisionEnabled(env) accepts the real boolean true/false', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: true }), true);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: false }), false);
});

test('resolvePbsAiDecisionEnabled(env) accepts the Cloudflare-runtime string "true"', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'true' }), true);
});

test('resolvePbsAiDecisionEnabled(env) accepts the Cloudflare-runtime string "false"', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'false' }), false);
});

test('resolvePbsAiDecisionEnabled(env) is case-insensitive and trims surrounding whitespace', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: ' TRUE ' }), true);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'True' }), true);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: ' FALSE ' }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'False' }), false);
});

test('resolvePbsAiDecisionEnabled(env) treats undefined/null/empty string as the safe default (false)', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: undefined }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: null }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: '' }), false);
});

test('resolvePbsAiDecisionEnabled(env) does NOT do a loose truthy check on other common spellings — fails safe to false', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: '1' }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'yes' }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'on' }), false);
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'random' }), false);
});
