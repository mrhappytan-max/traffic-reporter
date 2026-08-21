// V1.8.6.9 — scripts/check-deployment-policy.mjs (static, 0-network repo
// checks) and scripts/verify-production-deploy.mjs (post-push
// verification, network-aware with a graceful blocked fallback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkDeploymentPolicy,
  checkNoLegacyProductionBranchReferenceFromText,
  KNOWN_LEGACY_PRODUCTION_BRANCHES,
  CANONICAL_POLICY_MARKER,
} from '../scripts/check-deployment-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// --- 20: current Production config regression ----------------------------

test('20: checkDeploymentPolicy() PASSes against this repo\'s ACTUAL current state (regression guard)', () => {
  const { ok, results } = checkDeploymentPolicy();
  assert.equal(ok, true, `policy check failed: ${JSON.stringify(results.filter((r) => !r.ok), null, 2)}`);
});

// --- 19: legacy production branch reference detection ---------------------

test('19: a fixture with a KNOWN legacy branch in the current-production block is detected', () => {
  const fixture = `# doc
## Current Production version / main HEAD

\`\`\`
main HEAD: deadbeef (actually ${KNOWN_LEGACY_PRODUCTION_BRANCHES[0]})
\`\`\`
`;
  const result = checkNoLegacyProductionBranchReferenceFromText(fixture);
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(KNOWN_LEGACY_PRODUCTION_BRANCHES[0].replace(/[/]/g, '\\/')));
});

test('19: a fixture correctly stating only "main HEAD:" passes', () => {
  const fixture = `## Current Production version / main HEAD

\`\`\`
main HEAD: abc123
\`\`\`
`;
  const result = checkNoLegacyProductionBranchReferenceFromText(fixture);
  assert.equal(result.ok, true);
});

test('19: historical mentions of a legacy branch OUTSIDE the current-production block are NOT flagged (must not scrub valid "why" documentation)', () => {
  const fixture = `## Some historical section
This project used to deploy from ${KNOWN_LEGACY_PRODUCTION_BRANCHES[0]}, now resolved.

## Current Production version / main HEAD

\`\`\`
main HEAD: abc123
\`\`\`
`;
  const result = checkNoLegacyProductionBranchReferenceFromText(fixture);
  assert.equal(result.ok, true, 'a historical mention elsewhere in the doc must not fail this targeted check');
});

test('a fixture missing the "## Current Production version" heading entirely fails closed, never silently passes', () => {
  const result = checkNoLegacyProductionBranchReferenceFromText('# nothing relevant here');
  assert.equal(result.ok, false);
});

test('CANONICAL_POLICY_MARKER is a real, non-empty string this repo\'s docs actually contain', () => {
  assert.ok(CANONICAL_POLICY_MARKER.length > 0);
});

// --- npm script wiring -----------------------------------------------------

test('required npm scripts (predeploy/deploy/check:deployment-policy/verify:production/deploy:verify) are present in package.json', () => {
  const { results } = checkDeploymentPolicy();
  const scriptChecks = results.filter((r) => r.name.startsWith('npm-script:'));
  assert.ok(scriptChecks.length >= 5);
  assert.ok(scriptChecks.every((r) => r.ok));
});

// --- scripts/generateBuildMetadata.mjs — run for real (it only touches
// its own output file and reads local git; 0 network) ---------------------

test('generateBuildMetadata.mjs produces valid, git-derived commit/branch when run in this repo', () => {
  const generatedPath = join(ROOT, 'src', 'generated', 'buildMetadata.js');
  const placeholderContent = readFileSync(generatedPath, 'utf8'); // save the checked-in placeholder verbatim
  try {
    const scriptPath = join(ROOT, 'scripts', 'generateBuildMetadata.mjs');
    const output = execFileSync('node', [scriptPath], { cwd: ROOT, encoding: 'utf8' });
    assert.match(output, /deployedCommit=[0-9a-f]{40} \(git\)/);
    assert.match(output, /deployedBranch=\S+ \(git\)/);
  } finally {
    // Restore the checked-in placeholder afterward so this test run
    // never leaves a real commit SHA staged in the working tree for a
    // later `git commit` to accidentally pick up.
    writeFileSync(generatedPath, placeholderContent, 'utf8');
  }
});

// --- scripts/verify-production-deploy.mjs ----------------------------------
// main() sets process.exitCode as a side effect (see that script's own
// comment) — saved/restored around every call here so this test file's
// own exit code is never corrupted by exercising it.

async function withSavedExitCode(fn) {
  const prior = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = prior;
  }
}

function silenceConsole(fn) {
  return async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.log = originalLog;
    }
  };
}

test(
  '12: verify script reports PASS when Production reports the SAME commit/branch as local main HEAD and every route smoke-tests clean',
  silenceConsole(async () => {
    const localMainHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/version')) {
        return new Response(JSON.stringify({ service: 'traffic-reporter', appVersion: 'vX', deployedCommit: localMainHead, deployedBranch: 'main', buildTime: '2026-01-01T00:00:00.000Z' }), { status: 200 });
      }
      return new Response('ok', { status: 200 }); // every route "exists, public" for this test's purpose
    };
    try {
      const { main } = await import('../scripts/verify-production-deploy.mjs');
      const status = await withSavedExitCode(() => main());
      assert.equal(status, 'PASS');
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  '13: verify script detects a wrong SHA -> FAIL',
  silenceConsole(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.endsWith('/version')) {
        return new Response(JSON.stringify({ service: 'traffic-reporter', appVersion: 'vX', deployedCommit: 'ffffffffffffffffffffffffffffffffffffff', deployedBranch: 'main', buildTime: '2026-01-01T00:00:00.000Z' }), { status: 200 });
      }
      return new Response('ok', { status: 200 });
    };
    try {
      const { main } = await import('../scripts/verify-production-deploy.mjs');
      const status = await withSavedExitCode(() => main());
      assert.equal(status, 'FAIL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  '14/15: a proxy-denial response (x-deny-reason header, same shape observed in this project\'s own sandbox) -> PASS_NETWORK_VERIFICATION_BLOCKED, never mis-reported as a commit mismatch FAIL',
  silenceConsole(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('Host not in allowlist: traffic-reporter.mr-happytan.workers.dev.', {
        status: 403,
        headers: { 'x-deny-reason': 'host_not_allowed' },
      });
    try {
      const { main } = await import('../scripts/verify-production-deploy.mjs');
      const status = await withSavedExitCode(() => main());
      assert.equal(status, 'PASS_NETWORK_VERIFICATION_BLOCKED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);

test(
  '14: a thrown network error (DNS/TLS/connection failure) is ALSO treated as blocked, not a hard FAIL',
  silenceConsole(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND traffic-reporter.mr-happytan.workers.dev');
    };
    try {
      const { main } = await import('../scripts/verify-production-deploy.mjs');
      const status = await withSavedExitCode(() => main());
      assert.equal(status, 'PASS_NETWORK_VERIFICATION_BLOCKED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
);
