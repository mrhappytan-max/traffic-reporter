#!/usr/bin/env node
// V1.8.6.9 — post-push Production deploy verification. Read-only against
// everything it touches: local git, this repo's own static config/docs,
// and (best-effort) a plain unauthenticated GET to the live Worker's
// public /version endpoint and a small fixed set of important routes.
//
// Run this AFTER pushing to `main` and letting Cloudflare's auto-deploy
// (Workers Builds) pick it up — see ENGINEERING_STATUS.md's canonical
// deploy-flow section. `npm run deploy:verify` / `npm run
// verify:production` are both plain aliases to this script (see
// package.json) — this script does NOT merge or push anything itself;
// that stays a decision Claude Code makes explicitly, this script only
// verifies what already happened.
//
// TWO-LAYER DESIGN (section VII of the V1.8.6.9 task) — this environment
// has previously hit a hard proxy-policy block reaching
// traffic-reporter.mr-happytan.workers.dev (CONNECT 403), so this script
// treats network reachability as an independent axis from correctness:
//   A. Network reachable  -> full verification: commit/branch match,
//      route smoke tests, PASS or FAIL based on what was actually seen.
//   B. Network blocked    -> explicitly reports NETWORK_VERIFICATION_BLOCKED
//      for the network-dependent steps, but STILL completes and reports
//      the git/static-policy steps, which need no network at all. This
//      is never silently treated as an overall FAIL — see the final
//      summary logic at the bottom.
//
// 0 TDX/PBS/CCTV/LINE calls, 0 GitHub API calls, 0 Cloudflare API calls,
// 0 Admin credentials used or required anywhere in this script (see
// PRODUCT_DECISIONS.md's V1.8.6.9 section for why /version exists at all
// — this script is exactly the reason).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkDeploymentPolicy } from './check-deployment-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FETCH_TIMEOUT_MS = 8000;

function tryGit(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Lightweight extraction — wrangler.jsonc is JSONC (has comments), so a
 * real JSON.parse would need a comment-stripping pass; a single targeted
 * regex for this one known-shape field is simpler and matches the same
 * "low complexity" approach already used by check-deployment-policy.mjs. */
function readPublicBaseUrl() {
  const raw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const match = raw.match(/"PUBLIC_BASE_URL"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * This environment's own outbound egress proxy (see /root/.ccr/README.md)
 * denies a not-allowlisted host by returning a REAL HTTP response — not a
 * thrown connection error — status 403, header `x-deny-reason:
 * host_not_allowed`, plain-text body "Host not in allowlist: ...". A
 * naive check would misread that as the Worker itself returning 403
 * (which would be a genuine, serious deploy problem for a route that's
 * supposed to be public). Detected here from the one unambiguous,
 * documented signal (`x-deny-reason` header) rather than guessing from
 * status code alone, since a real app-level 403 is also just a number.
 * If a different sandbox's proxy ever denies differently (a thrown
 * connection error instead of a 403 response), that's still caught
 * separately by this script's own try/catch around every fetch — this
 * function only handles the "denial disguised as a normal HTTP response"
 * case specifically observed in this project's own environment.
 */
function isProxyDenialResponse(res) {
  return res.headers.get('x-deny-reason') !== null;
}

/**
 * A route is considered PRESENT if it answers 200 (public route, or
 * Admin route with no auth check reached — never expected here) or 401
 * (Admin Auth correctly gated it — "未登入時 401 屬正常，但不能是 404",
 * the exact convention already established for this project's manual
 * verification rounds). 404 is a real FAIL — the route is missing. A
 * network-level throw is reported as blocked, not folded into either.
 */
async function smokeTestRoute(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' });
    if (isProxyDenialResponse(res)) return { path, ok: null, blocked: true, reason: 'egress proxy denied this host (x-deny-reason header present) — not the Worker' };
    if (res.status === 404) return { path, ok: false, status: res.status, reason: 'route not found (404)' };
    if (res.status === 200 || res.status === 401) return { path, ok: true, status: res.status, reason: res.status === 401 ? 'exists, Admin-Auth-gated (expected)' : 'exists, public' };
    return { path, ok: null, status: res.status, reason: `unexpected status ${res.status} (not a hard fail, needs a human look)` };
  } catch (err) {
    return { path, ok: null, blocked: true, reason: err && err.message ? err.message : 'network error' };
  }
}

async function main() {
  const lines = [];
  const log = (s = '') => {
    lines.push(s);
    console.log(s);
  };

  log('=== verify-production-deploy ===');
  let overallOk = true;
  let networkBlocked = false;

  // --- Step 1: local git state — what IS main's HEAD, right now -------
  log('\n-- Step 1: git state --');
  const currentBranch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = tryGit(['status', '--porcelain']);
  const localMainHead = tryGit(['rev-parse', 'origin/main']) || tryGit(['rev-parse', 'main']);

  log(`current branch (informational): ${currentBranch ?? '(unknown)'}`);
  log(`working tree clean: ${porcelain === '' ? 'yes' : porcelain === null ? '(unknown)' : 'no'}`);
  if (!localMainHead) {
    log('❌ could not resolve origin/main or main locally — cannot verify anything further');
    overallOk = false;
  } else {
    log(`✅ local main HEAD: ${localMainHead}`);
  }

  // --- Step 2: static deployment policy (reused, not duplicated) ------
  log('\n-- Step 2: static deployment policy --');
  const policy = checkDeploymentPolicy();
  for (const r of policy.results) log(`${r.ok ? '✅' : '❌'} ${r.name}: ${r.message}`);
  if (!policy.ok) overallOk = false;

  // --- Step 3: network verification (best-effort) ----------------------
  log('\n-- Step 3: Production network verification --');
  const baseUrl = readPublicBaseUrl();
  if (!baseUrl) {
    log('❌ could not read PUBLIC_BASE_URL from wrangler.jsonc');
    overallOk = false;
  } else {
    log(`target: ${baseUrl}`);
    let versionInfo = null;
    try {
      const res = await fetchWithTimeout(`${baseUrl}/version`, { method: 'GET' });
      if (isProxyDenialResponse(res)) {
        networkBlocked = true;
        log('⚠️  NETWORK_VERIFICATION_BLOCKED — this environment\'s egress proxy denied the host');
        log(`    (x-deny-reason: ${res.headers.get('x-deny-reason')}) — this is NOT the Worker responding.`);
        log('    This is NOT treated as a deploy failure — see this script\'s own header comment.');
        log('    A human (or a Claude session with network access to *.workers.dev) must complete');
        log('    the remaining network-dependent checks below.');
      } else if (!res.ok) {
        log(`❌ GET /version returned HTTP ${res.status}`);
        overallOk = false;
      } else {
        versionInfo = await res.json();
        log(`✅ GET /version reachable: deployedCommit=${versionInfo.deployedCommit} deployedBranch=${versionInfo.deployedBranch} appVersion=${versionInfo.appVersion}`);
      }
    } catch (err) {
      networkBlocked = true;
      log('⚠️  NETWORK_VERIFICATION_BLOCKED — could not reach Production from this environment');
      log(`    (${err && err.message ? err.message : err})`);
      log('    This is NOT treated as a deploy failure — see this script\'s own header comment.');
      log('    A human (or a Claude session with network access to *.workers.dev) must complete');
      log('    the remaining network-dependent checks below.');
    }

    if (versionInfo && localMainHead) {
      log('\n-- Step 4: commit/branch comparison --');
      const commitMatch = versionInfo.deployedCommit === localMainHead;
      const branchMatch = versionInfo.deployedBranch === 'main';
      log(`${commitMatch ? '✅' : '❌'} deployedCommit ${commitMatch ? '==' : '!='} local main HEAD (${versionInfo.deployedCommit} vs ${localMainHead})`);
      log(`${branchMatch ? '✅' : '❌'} deployedBranch ${branchMatch ? '==' : '!='} "main" (got "${versionInfo.deployedBranch}")`);
      if (!commitMatch || !branchMatch) overallOk = false;

      log('\n-- Step 5: route smoke tests --');
      const { IMPORTANT_ROUTES } = await import('../src/traffic/deploymentStatus.js');
      for (const path of IMPORTANT_ROUTES) {
        const result = await smokeTestRoute(baseUrl, path);
        if (result.blocked) {
          log(`⚠️  ${path}: blocked (${result.reason})`);
        } else if (result.ok === true) {
          log(`✅ ${path}: ${result.status} (${result.reason})`);
        } else if (result.ok === false) {
          log(`❌ ${path}: ${result.status} (${result.reason})`);
          overallOk = false;
        } else {
          log(`⚠️  ${path}: ${result.status} (${result.reason})`);
        }
      }
    }
  }

  // --- Final summary -----------------------------------------------------
  log('\n=== SUMMARY ===');
  log('dashboardOnlyChecks (never verifiable from this script — see deploymentStatus.js):');
  const { DASHBOARD_ONLY_CHECKS } = await import('../src/traffic/deploymentStatus.js');
  for (const c of DASHBOARD_ONLY_CHECKS) log(`  - ${c}`);

  let finalStatus;
  if (!overallOk) {
    finalStatus = 'FAIL';
  } else if (networkBlocked) {
    finalStatus = 'PASS_NETWORK_VERIFICATION_BLOCKED';
  } else {
    finalStatus = 'PASS';
  }
  log(`\nFINAL: ${finalStatus}`);

  // Only a genuine FAIL (git/policy failure, or a real commit/branch
  // mismatch when network WAS available) exits non-zero — a network
  // block alone must never make the whole verification look like a
  // deploy failure (section VII's explicit instruction).
  process.exitCode = finalStatus === 'FAIL' ? 1 : 0;
  return finalStatus;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };
