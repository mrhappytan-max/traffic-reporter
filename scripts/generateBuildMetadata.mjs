#!/usr/bin/env node
// V1.8.6.9 — build-time deployment identity injection.
//
// WHY THIS EXISTS: the Worker runtime must be able to answer "what
// commit/branch am I actually running" WITHOUT ever calling GitHub or
// the Cloudflare API at runtime (see PRODUCT_DECISIONS.md's V1.8.6.9
// section for the full reasoning) — the only place that information can
// come from is the build itself, captured once and bundled in as a plain
// JS module. This script is that capture step.
//
// RUN ORDER: wired into package.json's `predeploy` script, which npm
// runs automatically immediately before `deploy` (a plain npm lifecycle
// convention — `npm run deploy` == `predeploy && deploy`) — so ANY
// invocation of `npm run deploy` (including Cloudflare Workers Builds'
// own build step, which this project's package.json makes the deploy
// entry point) regenerates src/generated/buildMetadata.js fresh, from
// whatever commit is actually checked out at that moment, before
// wrangler ever bundles the Worker. Also safely runnable standalone
// (`node scripts/generateBuildMetadata.mjs`) for a Cloudflare build
// command that bypasses npm scripts entirely — see this project's docs
// for the one-time Dashboard step that would require (a
// `dashboardOnlyChecks` item — this repo cannot configure Cloudflare's
// own build command, only document what it should be).
//
// HONESTY OVER GUESSING ("不要假裝讀到了"): every field records not just
// its value but WHERE it came from (`commitSource`/`branchSource`/
// `expectedMainCommitSource`) — a CI-provided env var, a local git
// command, or an honest 'unknown'/'assumed' when neither resolved. The
// runtime drift check (deploymentStatus.js) only ever flags a REAL
// mismatch it can prove from these sources, never one it merely assumes.
//
// ZERO network calls — every value comes from either an already-set
// environment variable or a local `git` command against the checkout
// this script is already running inside. Never throws: any single field
// that can't be determined degrades to 'unknown', not a failed build.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'src', 'generated', 'buildMetadata.js');

// Plausible CI-provided env var names for the commit/branch actually
// being built, checked in this order. None of these are independently
// confirmed to exist in Cloudflare Workers Builds' own environment (this
// repo has no way to verify that without a real build to inspect) — they
// are checked defensively, cheaply, and in a clearly-labeled order;
// `git` is always the guaranteed fallback since Cloudflare Workers
// Builds necessarily checks out the real git repository to build it.
const COMMIT_ENV_CANDIDATES = ['WORKERS_CI_COMMIT_SHA', 'CF_PAGES_COMMIT_SHA', 'GITHUB_SHA', 'CI_COMMIT_SHA'];
const BRANCH_ENV_CANDIDATES = ['WORKERS_CI_BRANCH', 'CF_PAGES_BRANCH', 'GITHUB_REF_NAME', 'CI_COMMIT_BRANCH'];

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return { value: String(value).trim(), source: `env:${name}` };
  }
  return null;
}

function tryGit(args) {
  try {
    return execFileSync('git', args, { cwd: join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // no .git dir, detached/shallow checkout missing the ref, git not installed, etc. — never throw the build over this
  }
}

function resolveCommit() {
  const fromEnv = firstEnv(COMMIT_ENV_CANDIDATES);
  if (fromEnv) return fromEnv;
  const fromGit = tryGit(['rev-parse', 'HEAD']);
  if (fromGit) return { value: fromGit, source: 'git' };
  return { value: 'unknown', source: 'unknown' };
}

function resolveBranch() {
  const fromEnv = firstEnv(BRANCH_ENV_CANDIDATES);
  if (fromEnv) return fromEnv;
  // A CI checkout is frequently a detached HEAD (checked out by SHA, not
  // by branch name) — `git branch --show-current` correctly returns
  // empty in that case rather than a wrong guess; `symbolic-ref` behaves
  // the same way. Both are tried, in that order, before giving up.
  const viaShowCurrent = tryGit(['branch', '--show-current']);
  if (viaShowCurrent) return { value: viaShowCurrent, source: 'git' };
  const viaSymbolicRef = tryGit(['symbolic-ref', '--short', 'HEAD']);
  if (viaSymbolicRef) return { value: viaSymbolicRef, source: 'git' };
  return { value: 'unknown', source: 'unknown' };
}

/**
 * "What does origin/main currently point to, per THIS checkout's own
 * remote-tracking ref" — resolved independently from `deployedCommit`
 * above (which is "what did we actually check out"), so the two can
 * genuinely disagree if a build ever runs against a stale/wrong ref. A
 * shallow or detached checkout that never fetched origin/main at all
 * cannot resolve this — in that case this function returns null and the
 * caller falls back to ASSUMING deployedCommit is correct (source
 * 'assumed-same-as-deployed'), never fabricating a comparison it can't
 * actually make.
 */
function resolveExpectedMainCommit() {
  const viaRemote = tryGit(['rev-parse', 'origin/main']);
  if (viaRemote) return { value: viaRemote, source: 'git:origin/main' };
  return null;
}

function main() {
  const commit = resolveCommit();
  const branch = resolveBranch();
  const expectedMain = resolveExpectedMainCommit();

  const metadata = {
    deployedCommit: commit.value,
    commitSource: commit.source,
    deployedBranch: branch.value,
    branchSource: branch.source,
    expectedMainCommit: expectedMain ? expectedMain.value : commit.value,
    expectedMainCommitSource: expectedMain ? expectedMain.source : 'assumed-same-as-deployed',
    buildTime: new Date().toISOString(),
  };

  const fileContent = `// GENERATED FILE — do not edit by hand.
//
// Written by scripts/generateBuildMetadata.mjs at ${metadata.buildTime}.
// See that script's own module comment for how each field was
// determined and package.json's "predeploy" script for when this runs.
export const BUILD_METADATA = ${JSON.stringify(metadata, null, 2)};
`;

  writeFileSync(OUTPUT_PATH, fileContent, 'utf8');
  console.log(`[generateBuildMetadata] wrote ${OUTPUT_PATH}`);
  console.log(`[generateBuildMetadata] deployedCommit=${metadata.deployedCommit} (${metadata.commitSource})`);
  console.log(`[generateBuildMetadata] deployedBranch=${metadata.deployedBranch} (${metadata.branchSource})`);
  console.log(`[generateBuildMetadata] expectedMainCommit=${metadata.expectedMainCommit} (${metadata.expectedMainCommitSource})`);
}

main();
