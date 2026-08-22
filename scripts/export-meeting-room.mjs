#!/usr/bin/env node
// V1.8.7.8-ish (Meeting Room Engineering Memory v1) — generates
// meeting-room-export/ from this repo's own Source of Truth: git state,
// the three canonical docs (ENGINEERING_STATUS.md / PROJECT_HANDOFF.md /
// PRODUCT_DECISIONS.md), wrangler.jsonc, package.json, and the actual
// src/ module tree — never from chat history, never guessed.
//
// DESIGN
// ------
// - Volatile facts (git HEAD/branch/working tree/version) are derived
//   HERE, mechanically, every run — never hand-typed into a template.
// - Narrative facts (current task / next action / known blocker) default
//   to sensible, evidence-grounded values but are overridable via env
//   vars (EXPORT_CURRENT_TASK, EXPORT_NEXT_ACTION, EXPORT_KNOWN_BLOCKER,
//   EXPORT_CURRENT_PHASE, EXPORT_PRODUCTION_STATUS,
//   EXPORT_PRODUCTION_VERIFICATION, EXPORT_REAL_WORLD_CONFIRMATION) so a
//   future finalize:release run can set them without editing this file.
// - 02_PROJECT_HANDOFF.md and 04_PRODUCT_DECISIONS.md are COPIED
//   verbatim from the repo's real files (they ARE the canonical
//   documents; duplicating their content by hand here would just create
//   a second, drifting copy).
// - Every other .md is a hand-authored template
//   (scripts/meeting-room-templates/*.md) with {{PLACEHOLDER}}
//   substitution for the volatile fields only.
// - Docs-vs-code Drift check: if ENGINEERING_STATUS.md's own "Latest
//   completed work" version label disagrees with the version derived
//   from the actual latest matching git commit subject, this is
//   reported as a WARNING in the export (never silently resolved either
//   way) — "以目前 main 可驗證事實為準，並標記文件 Drift".
// - Output allowlist is closed: only the files this script explicitly
//   writes ever land in meeting-room-export/. A secret scan runs over
//   every generated/copied file before this script reports success.
//
// FORBIDDEN IN OUTPUT (enforced by SECRET_PATTERNS below): any real
// token/secret/password value. This script never reads .env/.dev.vars/
// any Cloudflare Secret — it has no access to real credential values in
// the first place, but the scan exists as defense-in-depth against a
// future template accidentally embedding one.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATE_DIR = join(__dirname, 'meeting-room-templates');
const EXPORT_DIR = join(ROOT, 'meeting-room-export');

// The ONLY files this script will ever write into EXPORT_DIR. Closed
// allowlist — nothing else is ever copied/generated there.
const OUTPUT_FILES = [
  '00_CURRENT_STATE.md',
  '01_FOUR_DEPARTMENT_GOVERNANCE.md',
  '02_PROJECT_HANDOFF.md',
  '03_ARCHITECTURE.md',
  '04_PRODUCT_DECISIONS.md',
  '05_CROSS_PROJECT_BOUNDARY.md',
  '06_VERSION_HISTORY.md',
  '07_KNOWN_ISSUES.md',
  'SYSTEM_STATE.json',
  'PRODUCTION_MANIFEST.json',
];

// Files copied verbatim from the repo's own canonical docs (never
// hand-duplicated as separate template content, so they cannot drift
// from the real source).
const VERBATIM_COPIES = {
  '02_PROJECT_HANDOFF.md': 'PROJECT_HANDOFF.md',
  '04_PRODUCT_DECISIONS.md': 'PRODUCT_DECISIONS.md',
};

// Case-insensitive patterns that must NEVER appear in generated output.
// Deliberately broad (better a false-positive abort than a leaked
// secret) — filenames/keywords, not just literal known values, since a
// future template could reference a real one by accident.
const SECRET_PATTERNS = [
  /TDX_CLIENT_SECRET\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i,
  /LINE_CHANNEL_ACCESS_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i,
  /LINE_CHANNEL_SECRET\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i,
  /ADMIN_PASSWORD\s*[:=]\s*['"]?[A-Za-z0-9_\-]{4,}/i,
  /TRAFFIC_FEED_SECRET\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i,
  /CLOUDFLARE_API_TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}/,
];

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function safe(value, fallback) {
  return value === null || value === undefined || value === '' ? fallback : value;
}

/** Latest "V<major>.<minor>.<patch>[.<build>]" version label found in a git commit subject, newest first. Never guessed -- null if none found. */
function latestVersionFromGitLog() {
  const log = git(['log', '--oneline', '-n', '200']);
  if (!log) return null;
  for (const line of log.split('\n')) {
    const m = line.match(/V\d+\.\d+\.\d+(?:\.\d+)?/);
    if (m) return m[0];
  }
  return null;
}

/** The version label named in ENGINEERING_STATUS.md's first "## Latest completed work" heading, if any -- for the docs-vs-code drift check. */
function latestVersionFromEngineeringStatus() {
  try {
    const text = readFileSync(join(ROOT, 'ENGINEERING_STATUS.md'), 'utf8');
    const m = text.match(/## Latest completed work.*?(V\d+\.\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function moduleInventory() {
  const srcDir = join(ROOT, 'src');
  const groups = [];
  function walk(dir, label) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name).sort();
    const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length > 0) groups.push({ label, files });
    for (const d of dirs) walk(join(dir, d.name), label ? `${label}/${d.name}` : d.name);
  }
  walk(srcDir, '');
  const lines = [];
  for (const g of groups) {
    lines.push(`- **src/${g.label || '.'}/**: ${g.files.join(', ')}`);
  }
  return lines.join('\n');
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function scanForSecrets(text, fileLabel) {
  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      throw new Error(`secret-scan FAILED on ${fileLabel}: matched pattern ${pattern} (found: "${match[0].slice(0, 40)}...")`);
    }
  }
}

function main() {
  console.log('=== export-meeting-room ===');

  // --- Step 1: gather volatile facts, mechanically, every run ---
  const gitBranch = safe(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'unknown');
  const gitHead = safe(git(['rev-parse', 'HEAD']), 'unknown');
  const gitHeadDate = safe(git(['log', '-1', '--format=%cI']), 'unknown');
  const originMainHead = safe(git(['rev-parse', 'origin/main']), 'unavailable (no network / not fetched this session)');
  const dirtyFiles = git(['status', '--porcelain']);
  const workingTreeStatus = dirtyFiles === null ? 'unknown' : dirtyFiles === '' ? 'clean' : `dirty (${dirtyFiles.split('\n').length} changed file(s))`;
  const packageVersion = safe(readPackageVersion(), 'unknown');
  const latestCommitVersion = safe(latestVersionFromGitLog(), 'unknown');
  const docsVersion = latestVersionFromEngineeringStatus();

  if (docsVersion && latestCommitVersion !== 'unknown' && docsVersion !== latestCommitVersion) {
    console.warn(
      `⚠️  DOCS DRIFT: ENGINEERING_STATUS.md's "Latest completed work" says ${docsVersion}, ` +
        `but the newest version-labeled commit on this branch is ${latestCommitVersion}. ` +
        `Treating git (${latestCommitVersion}) as the verifiable fact per project convention -- ` +
        `ENGINEERING_STATUS.md should be reviewed.`
    );
  }

  // Narrative fields: sensible, evidence-grounded defaults, overridable
  // via env vars so a future finalize:release run doesn't require
  // editing this script.
  const currentVersion = latestCommitVersion;
  const latestCompletedVersion = latestCommitVersion;
  const currentPhase = safe(process.env.EXPORT_CURRENT_PHASE, 'Maintenance — awaiting real-world confirmation of latest release');
  const currentTask = safe(process.env.EXPORT_CURRENT_TASK, 'None in progress — awaiting next assignment');
  const knownBlocker = safe(process.env.EXPORT_KNOWN_BLOCKER, `${latestCompletedVersion} real-world confirmation pending — see 07_KNOWN_ISSUES.md`);
  const nextAction = safe(process.env.EXPORT_NEXT_ACTION, 'Await next task assignment, or real-world confirmation evidence for the latest release');
  const productionStatus = safe(process.env.EXPORT_PRODUCTION_STATUS, 'DEPLOYED');
  const productionVerification = safe(process.env.EXPORT_PRODUCTION_VERIFICATION, 'Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why)');
  const realWorldConfirmation = safe(process.env.EXPORT_REAL_WORLD_CONFIRMATION, 'REAL_WORLD_CONFIRMATION_PENDING');
  const exportGeneratedAt = new Date().toISOString();

  const substitutions = {
    GIT_BRANCH: gitBranch,
    GIT_HEAD: gitHead,
    GIT_HEAD_DATE: gitHeadDate,
    ORIGIN_MAIN_HEAD: originMainHead,
    WORKING_TREE_STATUS: workingTreeStatus,
    PACKAGE_VERSION: packageVersion,
    CURRENT_VERSION: currentVersion,
    LATEST_COMPLETED_VERSION: latestCompletedVersion,
    CURRENT_PHASE: currentPhase,
    CURRENT_TASK: currentTask,
    KNOWN_BLOCKER: knownBlocker,
    NEXT_ACTION: nextAction,
    PRODUCTION_STATUS: productionStatus,
    PRODUCTION_VERIFICATION: productionVerification,
    REAL_WORLD_CONFIRMATION: realWorldConfirmation,
    EXPORT_GENERATED_AT: exportGeneratedAt,
    MODULE_INVENTORY: moduleInventory(),
  };

  function substitute(text) {
    let out = text;
    for (const [key, value] of Object.entries(substitutions)) {
      out = out.split(`{{${key}}}`).join(String(value));
    }
    return out;
  }

  // --- Step 2: clean + recreate output dir ---
  if (existsSync(EXPORT_DIR)) rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });

  // --- Step 3: write every allowlisted output file ---
  for (const outName of OUTPUT_FILES) {
    let content;
    if (VERBATIM_COPIES[outName]) {
      content = readFileSync(join(ROOT, VERBATIM_COPIES[outName]), 'utf8');
    } else {
      const templatePath = join(TEMPLATE_DIR, outName);
      content = substitute(readFileSync(templatePath, 'utf8'));
    }

    if (outName.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (err) {
        throw new Error(`JSON validation FAILED for ${outName}: ${err.message}`);
      }
    }

    scanForSecrets(content, outName);
    writeFileSync(join(EXPORT_DIR, outName), content, 'utf8');
    console.log(`✅ wrote ${outName} (${content.length} bytes)`);
  }

  // --- Step 4: required-file validation ---
  const missing = OUTPUT_FILES.filter((f) => !existsSync(join(EXPORT_DIR, f)));
  if (missing.length > 0) {
    throw new Error(`required-file validation FAILED: missing ${missing.join(', ')}`);
  }

  console.log('✅ JSON validation: PASS');
  console.log('✅ required-file validation: PASS (all 10 files present)');
  console.log('✅ secret scan: PASS (no forbidden patterns found)');
  console.log(`✅ export complete: ${relative(ROOT, EXPORT_DIR)}/`);
  console.log(`   source commit: ${gitHead}`);
  console.log(`   generated at: ${exportGeneratedAt}`);

  return { exportDir: EXPORT_DIR, gitHead, exportGeneratedAt, files: OUTPUT_FILES };
}

// Run when invoked directly (node scripts/export-meeting-room.mjs), but
// also exported so scripts/finalize-release.mjs can call it in-process
// without a second child process.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`❌ export-meeting-room FAILED: ${err.message}`);
    process.exit(1);
  }
}

export { main as exportMeetingRoom, EXPORT_DIR, OUTPUT_FILES };
