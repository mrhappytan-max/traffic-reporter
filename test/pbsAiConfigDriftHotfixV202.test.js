// V2.0.2 — Config Drift Hotfix (order section 七). PBS_AI_DECISION_ENABLED
// had lived ONLY as a Dashboard Variable, silently dropped by Workers
// Builds on the next deploy (wrangler.jsonc is authoritative). Targeted,
// minimal proof this round's own order asks for — not a re-test of the
// AI decision engine itself (already covered by test/aiConfig.test.js,
// test/aiDecisionEngine.test.js, test/pbsAiDecisionScenarios.test.js,
// all untouched this round).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolvePbsAiDecisionEnabled } from '../src/pbs/aiConfig.js';
import { PBS_AI_MODEL_ID } from '../src/pbs/aiDecisionEngine.js';
import { APP_VERSION } from '../src/version.js';
import { checkDeploymentPolicy } from '../scripts/check-deployment-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wranglerRaw = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

test('1: wrangler.jsonc declares PBS_AI_DECISION_ENABLED = "true" (the canonical, non-Dashboard-only source of truth)', () => {
  const match = wranglerRaw.match(/"PBS_AI_DECISION_ENABLED"\s*:\s*"([^"]*)"/);
  assert.ok(match, 'PBS_AI_DECISION_ENABLED must be declared in wrangler.jsonc');
  assert.equal(match[1], 'true', 'must be the STRING "true" — Cloudflare injects Workers Variables as strings, never real booleans');
});

test('1b: PBS_AI_DECISION_ENABLED is declared as a string literal, never a bare JSON boolean', () => {
  assert.ok(!/"PBS_AI_DECISION_ENABLED"\s*:\s*true\b/.test(wranglerRaw), 'must not be a bare JSON `true` — the resolver expects the Cloudflare-runtime STRING form');
});

test('2: aiConfig resolver — the exact wrangler.jsonc value "true" resolves to enabled', () => {
  assert.equal(resolvePbsAiDecisionEnabled({ PBS_AI_DECISION_ENABLED: 'true' }), true);
});

test('3: default-false behavior is unchanged — no env override still resolves to disabled', () => {
  assert.equal(resolvePbsAiDecisionEnabled({}), false);
  assert.equal(resolvePbsAiDecisionEnabled(undefined), false);
});

test('4: existing AI binding "AI" is still declared in wrangler.jsonc, untouched by this round', () => {
  assert.match(wranglerRaw, /"ai"\s*:\s*\{\s*"binding"\s*:\s*"AI"\s*\}/);
});

test('5: model is unchanged — PBS_AI_MODEL_ID is still @cf/zai-org/glm-4.7-flash', () => {
  assert.equal(PBS_AI_MODEL_ID, '@cf/zai-org/glm-4.7-flash');
});

test('6: APP_VERSION is V2.0.2', () => {
  assert.equal(APP_VERSION, 'V2.0.2');
});

test('7: deployment/config-related checkDeploymentPolicy() PASSes, including the new pbs-ai-decision-enabled-var guard', () => {
  const { ok, results } = checkDeploymentPolicy();
  const guard = results.find((r) => r.name === 'pbs-ai-decision-enabled-var');
  assert.ok(guard, 'the new config-drift guard must be registered in checkDeploymentPolicy()');
  assert.equal(guard.ok, true, guard.message);
  assert.equal(ok, true, 'checkDeploymentPolicy() must PASS overall');
});

test('no Secret name (PBS_DEBUG_PUSH_SECRET / LINE / TDX / password / credential) was added to wrangler.jsonc vars this round', () => {
  const varsBlockMatch = wranglerRaw.match(/"vars"\s*:\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(varsBlockMatch, 'vars block must be findable');
  const varsBlock = varsBlockMatch[0];
  for (const forbidden of ['PBS_DEBUG_PUSH_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'TDX_CLIENT_SECRET', 'TDX_CLIENT_ID', 'ADMIN_PASSWORD', 'TRAFFIC_FEED_SECRET']) {
    assert.ok(!varsBlock.includes(forbidden), `${forbidden} must never appear in the vars block — Secrets stay Secrets`);
  }
});

test('no keep_vars was added to wrangler.jsonc — repo config stays authoritative, not Dashboard state', () => {
  assert.ok(!/keep_vars/i.test(wranglerRaw), 'keep_vars would let Dashboard-only settings keep drifting back in — exactly the failure mode this round retires');
});
