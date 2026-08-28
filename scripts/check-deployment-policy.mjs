#!/usr/bin/env node
// V1.8.6.9 — static, repo-only deployment policy checks. 0 network calls,
// 0 Cloudflare/GitHub API calls, 0 TDX/PBS/CCTV/LINE calls — everything
// here reads only files already in this checkout.
//
// Exported as a library (checkDeploymentPolicy()) so
// scripts/verify-production-deploy.mjs can reuse these EXACT same checks
// as its own "preflight/policy" step rather than a second, drifting copy
// — per this round's own instruction ("複製相同規則到多個... 禁止").
// Also runnable standalone: `node scripts/check-deployment-policy.mjs`
// (wired as `npm run check:deployment-policy`).
//
// WHAT THIS CAN AND CANNOT VERIFY: this script can only ever see what's
// actually IN this git checkout — wrangler.jsonc, package.json, this
// project's own docs. It has NO way to read Cloudflare Dashboard
// settings (which branch Workers Builds is actually configured to
// deploy from, the real Cron Trigger config, real traffic split) — see
// DASHBOARD_ONLY_CHECKS (also re-exported from deploymentStatus.js, same
// list, not a second copy) for exactly what's out of reach here and why.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Branch names this project has, at some point, actually had Production
// running from by mistake (see PROJECT_HANDOFF.md §22) — a regression
// guard against the SAME class of drift recurring, not a claim that
// these are the only possible bad values. New entries should be added
// here if a future round discovers another stray Production branch.
const KNOWN_LEGACY_PRODUCTION_BRANCHES = [
  'claude/v57.2-tdx-gated-freeway-broadcast',
  'integration/v57.2-v1.8.6.5-production',
];

// The fixed canonical-policy marker this round's docs update adds to
// ENGINEERING_STATUS.md (see that file) — checked for presence here so a
// future edit that accidentally removes the "one true deploy flow"
// statement (reintroducing "two 正式發布流程" — explicitly forbidden by
// this round's own task) gets caught automatically, not just by review.
const CANONICAL_POLICY_MARKER = 'Production 唯一正式來源';

function readText(relativePath) {
  const full = join(ROOT, relativePath);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

function checkCronSchedule(results) {
  const raw = readText('wrangler.jsonc');
  if (raw === null) {
    results.push({ ok: false, name: 'cron-schedule', message: 'wrangler.jsonc not found' });
    return;
  }
  const match = raw.match(/"crons"\s*:\s*\[\s*"([^"]+)"/);
  const ok = Boolean(match && match[1] === '*/10 * * * *');
  results.push({
    ok,
    name: 'cron-schedule',
    message: ok
      ? 'wrangler.jsonc crons = "*/10 * * * *" (expected)'
      : `wrangler.jsonc crons = ${match ? `"${match[1]}"` : '(not found)'}, expected "*/10 * * * *"`,
  });
}

function checkRequiredBindings(results) {
  const raw = readText('wrangler.jsonc');
  if (raw === null) {
    results.push({ ok: false, name: 'required-bindings', message: 'wrangler.jsonc not found' });
    return;
  }
  const required = [
    { name: 'TRAFFIC_KV', pattern: /"binding"\s*:\s*"TRAFFIC_KV"/ },
    { name: 'CCTV_IMAGES', pattern: /"binding"\s*:\s*"CCTV_IMAGES"/ },
    { name: 'PBS_RELAY_WINDOWS', pattern: /"binding"\s*:\s*"PBS_RELAY_WINDOWS"/ },
  ];
  for (const b of required) {
    const ok = b.pattern.test(raw);
    results.push({ ok, name: `binding:${b.name}`, message: ok ? `${b.name} declared in wrangler.jsonc` : `${b.name} missing from wrangler.jsonc` });
  }
}

// V2.0.2 (Config Drift Hotfix) — guards against the exact failure this
// round exists to fix: PBS_AI_DECISION_ENABLED living ONLY as a
// Dashboard Variable, which Workers Builds silently drops on the next
// deploy since wrangler.jsonc is authoritative (same mechanism as
// TRAFFIC_SOURCE_MODE's own long-standing comment in that file). If a
// future edit removes this var from wrangler.jsonc, Production AI
// decisions would fall back to disabled without anyone changing this
// switch on purpose — this check exists so that regresses loudly here,
// not silently in Production. Must be the exact STRING "true" (Cloudflare
// injects Workers Variables as strings, never real booleans — see
// src/pbs/aiConfig.js#resolvePbsAiDecisionEnabled()).
function checkPbsAiDecisionEnabledVar(results) {
  const raw = readText('wrangler.jsonc');
  if (raw === null) {
    results.push({ ok: false, name: 'pbs-ai-decision-enabled-var', message: 'wrangler.jsonc not found' });
    return;
  }
  const match = raw.match(/"PBS_AI_DECISION_ENABLED"\s*:\s*"([^"]*)"/);
  const ok = Boolean(match && match[1] === 'true');
  results.push({
    ok,
    name: 'pbs-ai-decision-enabled-var',
    message: ok
      ? 'wrangler.jsonc vars.PBS_AI_DECISION_ENABLED = "true" (canonical, not Dashboard-only)'
      : `wrangler.jsonc vars.PBS_AI_DECISION_ENABLED = ${match ? `"${match[1]}"` : '(not declared)'}, expected the string "true" — see V2.0.2's own Config Drift Hotfix history before changing this`,
  });
}

/**
 * Extracts the fenced code block immediately following the
 * "## Current Production version / main HEAD" heading in
 * ENGINEERING_STATUS.md — the ONE place this project's docs state which
 * branch/commit Production is currently understood to run from. Scoped
 * deliberately narrow: the rest of this project's docs legitimately
 * mention retired branch names as HISTORICAL record (see PROJECT_HANDOFF.md
 * §22) — a whole-file grep would false-positive on that valuable "why"
 * documentation, which must stay, not be scrubbed.
 */
function extractCurrentProductionBlock(engineeringStatusText) {
  const headingIndex = engineeringStatusText.indexOf('## Current Production version');
  if (headingIndex === -1) return null;
  const afterHeading = engineeringStatusText.slice(headingIndex);
  const fenceMatch = afterHeading.match(/```([\s\S]*?)```/);
  return fenceMatch ? fenceMatch[1] : null;
}

/**
 * Pure — given the text of ENGINEERING_STATUS.md (or any equivalently-
 * shaped fixture), decides whether the "## Current Production version"
 * block is clean. Exported separately from the file-reading wrapper
 * below so tests can exercise the actual detection logic against a
 * synthetic fixture, without needing a temp file on disk.
 */
export function checkNoLegacyProductionBranchReferenceFromText(engineeringStatusText) {
  const block = extractCurrentProductionBlock(engineeringStatusText);
  if (block === null) {
    return { ok: false, name: 'no-legacy-branch-reference', message: '"## Current Production version" section/code block not found in ENGINEERING_STATUS.md' };
  }
  const legacyHit = KNOWN_LEGACY_PRODUCTION_BRANCHES.find((b) => block.includes(b));
  const declaresMain = /\bmain HEAD:/.test(block);
  const ok = !legacyHit && declaresMain;
  return {
    ok,
    name: 'no-legacy-branch-reference',
    message: legacyHit
      ? `ENGINEERING_STATUS.md's current-production block still references a known-legacy branch: "${legacyHit}"`
      : declaresMain
        ? 'ENGINEERING_STATUS.md correctly states main HEAD as the current Production reference'
        : 'ENGINEERING_STATUS.md\'s current-production block does not state "main HEAD:" at all',
  };
}

function checkNoLegacyProductionBranchReference(results) {
  const raw = readText('ENGINEERING_STATUS.md');
  if (raw === null) {
    results.push({ ok: false, name: 'no-legacy-branch-reference', message: 'ENGINEERING_STATUS.md not found' });
    return;
  }
  results.push(checkNoLegacyProductionBranchReferenceFromText(raw));
}

function checkCanonicalPolicyStatementPresent(results) {
  const engStatus = readText('ENGINEERING_STATUS.md') || '';
  const readme = readText('README.md') || '';
  const ok = engStatus.includes(CANONICAL_POLICY_MARKER) || readme.includes(CANONICAL_POLICY_MARKER);
  results.push({
    ok,
    name: 'canonical-deploy-flow-statement',
    message: ok
      ? 'The single canonical deploy-flow statement is present in docs'
      : `Neither ENGINEERING_STATUS.md nor README.md contains the canonical marker "${CANONICAL_POLICY_MARKER}" — docs may have drifted to describing two deploy flows`,
  });
}

function checkPackageJsonScripts(results) {
  const raw = readText('package.json');
  if (raw === null) {
    results.push({ ok: false, name: 'package-json-scripts', message: 'package.json not found' });
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    results.push({ ok: false, name: 'package-json-scripts', message: 'package.json is not valid JSON' });
    return;
  }
  const scripts = pkg.scripts || {};
  const required = ['predeploy', 'deploy', 'check:deployment-policy', 'verify:production', 'deploy:verify'];
  for (const name of required) {
    const ok = Boolean(scripts[name]);
    results.push({ ok, name: `npm-script:${name}`, message: ok ? `npm script "${name}" present` : `npm script "${name}" missing` });
  }
}

/**
 * Runs every static check and returns {ok, results}. Never throws, never
 * touches the network, never reads a Secret.
 */
export function checkDeploymentPolicy() {
  const results = [];
  checkCronSchedule(results);
  checkRequiredBindings(results);
  checkPbsAiDecisionEnabledVar(results);
  checkNoLegacyProductionBranchReference(results);
  checkCanonicalPolicyStatementPresent(results);
  checkPackageJsonScripts(results);
  return { ok: results.every((r) => r.ok), results };
}

export { KNOWN_LEGACY_PRODUCTION_BRANCHES, CANONICAL_POLICY_MARKER };

function main() {
  const { ok, results } = checkDeploymentPolicy();
  console.log('=== check-deployment-policy ===');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}: ${r.message}`);
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
}

// Only auto-run when invoked directly (`node scripts/check-deployment-policy.mjs`),
// never when imported as a library (see verify-production-deploy.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
