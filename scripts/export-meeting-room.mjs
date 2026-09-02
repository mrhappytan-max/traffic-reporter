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
// - 04_PRODUCT_DECISIONS.md is COPIED verbatim from the repo's real
//   file (it IS the canonical document; duplicating its content by hand
//   here would just create a second, drifting copy).
// - 02_PROJECT_HANDOFF.md is a GENERATED CONCISE handoff (V1.1). The
//   repo's full PROJECT_HANDOFF.md is far too large for a single cloud
//   connector create_file call, which blocked full sync automation. The
//   full document is never modified -- it stays the Level 2/3 history
//   Source of Truth and is additionally split by section into _history/.
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
import { createHash } from 'node:crypto';
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
//
// V1.1 NOTE: 02_PROJECT_HANDOFF.md is deliberately NO LONGER a verbatim
// copy. The repo's own PROJECT_HANDOFF.md (~320KB) exceeds what a cloud
// sync connector can create in one call, which made full automation
// structurally impossible. It is now a generated CONCISE handoff
// (template + placeholders, size-guarded below), while the untouched
// full document remains the Level 2/3 history Source of Truth in the
// repo and is additionally split, by section, into _history/ for cloud
// readers. PRODUCT_DECISIONS.md is well under the limit and stays
// verbatim.
const VERBATIM_COPIES = {
  '04_PRODUCT_DECISIONS.md': 'PRODUCT_DECISIONS.md',
};

// The full engineering history that 02 used to duplicate. Never
// modified or truncated by this script -- only read, and split into
// _history/ chunks for cloud consumers.
const FULL_HISTORY_SOURCE = 'PROJECT_HANDOFF.md';
const HISTORY_DIR_NAME = '_history';

// Hard ceilings, enforced every run so a future edit cannot silently
// reintroduce the "too big to sync" problem that made 02 unsyncable.
//
// RAISED 2026-08-25 (PRODUCTION_VERSION_LINEAGE_RECONCILIATION), 50KB -> 80KB.
// The old 50KB figure was sized for a single Claude connector create_file
// call. DRIVE_SYNC_GOVERNANCE_V2 retired that flow: the mirror is now
// written by scripts/syncEngineeringMemory.mjs, which uploads through the
// Drive REST API (uploadType=multipart / media) and has no comparable
// per-file ceiling. The observed-good datapoint is 04_PRODUCT_DECISIONS.md
// at ~85KB, which has synced byte-exact every round for weeks.
//
// The guard is kept, not removed: it still catches runaway growth, and 80KB
// stays under the only size this project has actually proven in production.
// If a canonical file ever approaches it, the answer is to split the file,
// not to raise this number again.
const MAX_CANONICAL_BYTES = 80 * 1024;
const MAX_HISTORY_CHUNK_BYTES = 50 * 1024;
// 04 is a verbatim copy of a canonical repo doc that is already larger
// than the ceiling and is a known-good size for the connector; it is
// exempt so the guard targets regressions, not this known case.
const SIZE_GUARD_EXEMPT = new Set(['04_PRODUCT_DECISIONS.md']);

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

// The generation timestamp is the one field that would otherwise change
// on EVERY run even when nothing about the snapshot changed. Left naive,
// it makes every release look like a content change and defeats delta
// sync entirely. So content identity is computed with the timestamp
// masked, and the previous timestamp is reused verbatim whenever the
// masked content is unchanged -- making a no-op export byte-identical to
// the last one.
const GENERATED_AT_PLACEHOLDER = '__EXPORT_GENERATED_AT__';
const SYNC_MANIFEST_PATH = join(ROOT, '.engineering', 'MEETING_ROOM_SYNC.json');

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Previously synced content identity, or null when unavailable/untrusted. Never throws. */
function readPriorExportState() {
  try {
    const manifest = JSON.parse(readFileSync(SYNC_MANIFEST_PATH, 'utf8'));
    const last = manifest.lastSync;
    if (!last || !Array.isArray(last.files) || last.files.length === 0) return null;
    const byName = new Map();
    for (const f of last.files) {
      if (f && typeof f.name === 'string' && typeof f.contentSha256 === 'string') {
        byName.set(f.name, f.contentSha256);
      }
    }
    if (byName.size === 0) return null;
    return { contentHashes: byName, exportGeneratedAt: last.exportGeneratedAt || null };
  } catch {
    return null;
  }
}

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
// THE canonical product version, read from src/version.js — the single
// source GET /version itself uses. Deliberately a text scrape rather than
// an import: this script runs in plain Node against the repo, and must not
// pull a Worker module (and its transitive imports) into its own process.
function canonicalAppVersion() {
  try {
    const text = readFileSync(join(ROOT, 'src', 'version.js'), 'utf8');
    const m = text.match(/export const APP_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Numeric compare of two V-prefixed version strings. Returns >0 when a is
// newer, <0 when b is newer, 0 when equal. Missing trailing segments count
// as 0, so V1.8.7 < V1.8.7.1.
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^V/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Kept ONLY as a drift signal, never as the answer. Before
// PRODUCTION_VERSION_LINEAGE_RECONCILIATION (2026-08-25) this WAS the
// answer, which is how the memory came to report V1.8.7.7 while the
// deployed code reported V1.8.6.9 — a version scraped from a commit
// message is a version nobody owns.
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

/**
 * Split the repo's untouched full PROJECT_HANDOFF.md into section-aligned
 * chunks under `_history/`, each small enough for a single cloud-connector
 * create_file call.
 *
 * The source file is only ever READ here -- never rewritten, never
 * truncated. Splitting happens at level-2 ("## ") headings so each chunk
 * is semantically whole; a single section larger than the ceiling is
 * hard-split by lines rather than silently dropped, and the index records
 * that it continues.
 *
 * `_history/` is deliberately NOT canonical: a new agent never reads it by
 * default, and it is excluded from required-file validation. It exists so
 * root-cause archaeology is still possible from the cloud copy alone.
 */
function writeHistoryChunks() {
  const sourcePath = join(ROOT, FULL_HISTORY_SOURCE);
  if (!existsSync(sourcePath)) {
    console.warn(`⚠️  ${FULL_HISTORY_SOURCE} not found -- skipping _history/ generation.`);
    return [];
  }

  const full = readFileSync(sourcePath, 'utf8');
  const lines = full.split('\n');

  // Each written chunk carries a provenance header on top of its body,
  // so the packing budget must reserve room for it -- otherwise a chunk
  // packed exactly to the ceiling overflows once the header is added.
  const HEADER_RESERVE_BYTES = 1024;
  const bodyBudget = MAX_HISTORY_CHUNK_BYTES - HEADER_RESERVE_BYTES;

  // Group lines into level-2 sections (the preamble before the first
  // "## " heading becomes its own leading section).
  const sections = [];
  let current = { heading: '(preamble)', lines: [] };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current.lines.length > 0) sections.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) sections.push(current);

  // Pack sections into chunks under the ceiling, hard-splitting any
  // single oversized section.
  const chunks = [];
  let buffer = { headings: [], lines: [] };
  const bufferBytes = () => Buffer.byteLength(buffer.lines.join('\n'), 'utf8');

  function flush() {
    if (buffer.lines.length > 0) chunks.push(buffer);
    buffer = { headings: [], lines: [] };
  }

  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section.lines.join('\n'), 'utf8');

    if (sectionBytes > bodyBudget) {
      flush();
      let part = [];
      let partIndex = 1;
      for (const line of section.lines) {
        const candidate = Buffer.byteLength([...part, line].join('\n'), 'utf8');
        if (candidate > bodyBudget && part.length > 0) {
          chunks.push({ headings: [`${section.heading} (part ${partIndex})`], lines: part });
          partIndex += 1;
          part = [];
        }
        part.push(line);
      }
      if (part.length > 0) {
        chunks.push({ headings: [`${section.heading} (part ${partIndex})`], lines: part });
      }
      continue;
    }

    if (bufferBytes() + sectionBytes > bodyBudget && buffer.lines.length > 0) {
      flush();
    }
    buffer.headings.push(section.heading);
    buffer.lines.push(...section.lines);
  }
  flush();

  const historyDir = join(EXPORT_DIR, HISTORY_DIR_NAME);
  mkdirSync(historyDir, { recursive: true });

  const written = [];
  chunks.forEach((chunk, i) => {
    const name = `PROJECT_HANDOFF_${String(i + 1).padStart(2, '0')}of${String(chunks.length).padStart(2, '0')}.md`;
    const header =
      `<!-- title: 完整工程歷史 ${i + 1}/${chunks.length} -->\n\n` +
      `# PROJECT_HANDOFF（完整工程歷史）— 第 ${i + 1} 段／共 ${chunks.length} 段\n\n` +
      `> 非 canonical。這是 Repo 內未經刪減的 \`${FULL_HISTORY_SOURCE}\` 依章節切分後的第 ${i + 1} 段，\n` +
      `> 僅供追查歷史 Root Cause 時閱讀；日常接班請讀 \`02_PROJECT_HANDOFF.md\`。\n` +
      `> 完整且權威的版本永遠是 Repo 內的 \`${FULL_HISTORY_SOURCE}\`。\n\n---\n\n`;
    const content = header + chunk.lines.join('\n').replace(/^\n+/, '') + '\n';
    scanForSecrets(content, `${HISTORY_DIR_NAME}/${name}`);
    writeFileSync(join(historyDir, name), content, 'utf8');
    written.push({ name, headings: chunk.headings, bytes: Buffer.byteLength(content, 'utf8') });
  });

  const indexLines = [
    '<!-- title: 完整工程歷史索引 -->',
    '',
    '# _history — 完整工程歷史索引（非 canonical）',
    '',
    `來源：Repo 內 \`${FULL_HISTORY_SOURCE}\`（未刪減、未縮減，仍是唯一權威的完整工程歷史）。`,
    '',
    '這裡的分段檔只是為了讓雲端也能保存完整歷史。新 Agent **不預設讀取**這個資料夾——',
    '日常接班讀 `02_PROJECT_HANDOFF.md` 即可，只有需要追某一輪的 Root Cause 時才進來查。',
    '',
    `分段數：${written.length}　每段上限：${MAX_HISTORY_CHUNK_BYTES} bytes`,
    '',
    '| 檔案 | 大小 (bytes) | 涵蓋章節 |',
    '|---|---|---|',
  ];
  for (const w of written) {
    const headings = w.headings.map((h) => h.replace(/\|/g, '\\|')).join('；');
    indexLines.push(`| \`${w.name}\` | ${w.bytes} | ${headings} |`);
  }
  indexLines.push('');
  const indexContent = indexLines.join('\n');
  scanForSecrets(indexContent, `${HISTORY_DIR_NAME}/00_INDEX.md`);
  writeFileSync(join(historyDir, '00_INDEX.md'), indexContent, 'utf8');

  return [{ name: '00_INDEX.md', bytes: Buffer.byteLength(indexContent, 'utf8') }, ...written];
}


// TDX QUOTA PROTECTION (2026-08-23): the Engineering Memory's headline
// fields must state the quota pause without anyone remembering to pass an
// env var. Reading the deployed flag straight out of wrangler.jsonc keeps
// the memory honest by construction: when the flag flips back to ALL the
// wording reverts on its own, so it can never be left claiming a pause
// that has already ended.
function readLinePushPolicy() {
  // Same read-the-deployed-config approach as readTrafficSourceMode: the
  // memory must describe what is actually deployed, never a hardcoded guess.
  try {
    const text = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    const match = text.match(/"LINE_PUSH_POLICY"\s*:\s*"([^"]+)"/);
    return match ? match[1] : 'MAJOR_ACCIDENT_ONLY';
  } catch {
    return 'MAJOR_ACCIDENT_ONLY';
  }
}

function readTrafficSourceMode() {
  try {
    const raw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    const m = raw.match(/"TRAFFIC_SOURCE_MODE"\s*:\s*"([^"]*)"/);
    return m ? m[1].trim().toUpperCase() : 'ALL';
  } catch {
    return 'ALL';
  }
}

// V2.0.2 (Config Drift Hotfix) — same read-the-deployed-config approach
// as readTrafficSourceMode/readLinePushPolicy above: this var's own
// V2.0.2 history (a Dashboard-only value silently dropped by the next
// deploy) is exactly why the Engineering Memory must describe what
// wrangler.jsonc ACTUALLY declares, never a hardcoded guess that could
// itself drift out of sync with the canonical source.
function readPbsAiDecisionEnabled() {
  try {
    const raw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    const m = raw.match(/"PBS_AI_DECISION_ENABLED"\s*:\s*"([^"]*)"/);
    return m ? m[1].trim().toLowerCase() : '(not declared in wrangler.jsonc)';
  } catch {
    return '(not declared in wrangler.jsonc)';
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

  // --- Step 1a: break the Git SHA self-reference loop ---
  //
  // A snapshot must describe the official main commit it was generated
  // FROM (sourceMainHead). It must NOT be required to name the commit
  // that CONTAINS it (exportArtifactCommit) -- that commit does not
  // exist yet at generation time, and demanding the two be equal forces
  // an endless export -> commit -> stale -> re-export cycle.
  //
  // sourceMainHead therefore reads origin/main (falling back to the
  // local main ref), never HEAD -- so committing this export onto any
  // working branch leaves the recorded baseline unchanged, and a rerun
  // produces the same value.
  const localMainHead = git(['rev-parse', 'main']);
  const sourceMainHead = safe(
    git(['rev-parse', 'origin/main']),
    safe(localMainHead, 'unavailable (origin/main and local main both unresolvable)')
  );
  const sourceMainHeadOrigin = git(['rev-parse', 'origin/main'])
    ? 'origin/main'
    : localMainHead
      ? 'local main ref (origin/main unresolvable this run)'
      : 'unavailable';
  // Never self-referential: the artifact's own commit is unknowable
  // while the artifact is still being written.
  const exportArtifactCommit = 'uncommitted-at-generation-time (resolved by git history, never self-referenced)';

  // Working-tree status of the SOURCE tree only. Two paths are excluded
  // because the release pipeline writes them itself, and counting its own
  // output as "dirty source" is the same self-reference trap the
  // sourceMainHead/exportArtifactCommit split exists to avoid:
  //
  //   meeting-room-export/  this generator's own output
  //   .engineering/         cloud sync evidence, written AFTER a sync
  //                         completes -- recording "the sync happened"
  //                         must never make the next export look changed,
  //                         or delta sync never converges.
  const sourceDirty = git([
    'status',
    '--porcelain',
    '--',
    ':(exclude)meeting-room-export',
    ':(exclude).engineering',
  ]);
  const sourceWorkingTree =
    sourceDirty === null ? 'unknown' : sourceDirty === '' ? 'clean' : `dirty (${sourceDirty.split('\n').length} changed source file(s))`;
  const packageVersion = safe(readPackageVersion(), 'unknown');
  const latestCommitVersion = safe(latestVersionFromGitLog(), 'unknown');
  const docsVersion = latestVersionFromEngineeringStatus();

  if (docsVersion && latestCommitVersion !== 'unknown' && docsVersion !== latestCommitVersion) {
    // NOTE: neither side of this comparison is authoritative any more —
    // src/version.js is. This warning is kept because a disagreement here
    // still means a document needs review.
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
  // src/version.js is the authority; the git-log scrape and
  // ENGINEERING_STATUS.md are cross-checks that may only WARN.
  const canonicalVersion = canonicalAppVersion();
  if (!canonicalVersion) {
    throw new Error(
      'cannot read APP_VERSION from src/version.js — that file is the one canonical version source; ' +
        'refusing to fall back to a commit-message scrape, which is exactly the drift this replaced'
    );
  }
  // Only a commit-message version NEWER than the canonical one is a real
  // signal — that means a release shipped without bumping src/version.js.
  // A scrape that lags is expected and is not a defect:
  // PRODUCTION_VERSION_LINEAGE_RECONCILIATION assigned V1.8.7.8-V1.8.7.14
  // to commits that were already on main, deliberately without rewriting
  // their messages, so the scrape stays behind until the next release
  // commit happens to carry a label. Warning on that would be noise, and a
  // warning that cries wolf every run is a warning nobody reads.
  if (latestCommitVersion !== 'unknown' && compareVersions(latestCommitVersion, canonicalVersion) > 0) {
    console.warn(
      `⚠️  VERSION DRIFT: the newest version-labeled commit says ${latestCommitVersion}, which is ` +
        `NEWER than src/version.js (${canonicalVersion}). A release appears to have shipped without ` +
        `bumping the canonical source — bump it now rather than letting the two diverge again.`
    );
  }
  const currentVersion = canonicalVersion;
  const latestCompletedVersion = canonicalVersion;
  const trafficSourceMode = readTrafficSourceMode();
  const pbsOnly = trafficSourceMode === 'PBS_ONLY';

  const currentPhase = safe(
    process.env.EXPORT_CURRENT_PHASE,
    pbsOnly
      ? 'Production maintenance｜PBS-ONLY + 重大事故限定 LINE Push（維持不變）＋ TDX Freeway/Highway RoadEvent 已重新接入統一 Queue/AI/Memory pipeline，但 V2.4.4 緊急品質修復（服務區域洩漏＋一般道路管理誤發＋TDX 訊息遺失）已將 TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED 重設回 false（FETCH/QUEUE 仍 true），進入 PHASE_D_TDX_NOTIFY_OBSERVATION，待觀察後再由人類＋Claude Browser 決定重新開啟。雲端同步治理 V2 生效：Claude 對 Drive 唯讀、GitHub 為唯一寫入來源，GitHub Actions 自動鏡像至 Drive'
      : 'Maintenance — awaiting real-world confirmation of latest release'
  );
  const currentTask = safe(
    process.env.EXPORT_CURRENT_TASK,
    pbsOnly
      ? 'none。Latest completed task = V2_4_4_TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX，status = SEALED（前序歷程見 SYSTEM_STATE.json／06_VERSION_HISTORY.md）。CURRENT_RUNTIME_PHASE=PHASE_D_TDX_NOTIFY_OBSERVATION：TDX_ROADEVENT_FETCH_ENABLED/QUEUE_INGRESS_ENABLED 為 "true"，TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED 為 "false"（本輪刻意關閉，非缺陷），CCTV_METADATA_REFRESH 仍 "false"。雲端治理：Claude 對 Drive 唯讀，GitHub 為唯一寫入來源。V2.4.4：新增 resolveHsinchuOnlyProductionEligibility() 地名 denylist hard gate（新竹市／新竹縣以外一律擋下，含頭份／竹南／三灣）、AI prompt 第四類「一般道路管理狀態」語意錨點（例行施工/機動路肩開放關閉預設不通知）、TDX 訊息事實行（buildSourceFactLine 由 PBS-only 放寬為 PBS+TDX，60 字上限不變）。觀察中：確認真實 TDX 事件只剩新竹縣市 candidate、一般施工/路肩不再誤發、TDX facts 可完整組成 LINE 預覽後，再由人類＋Claude Browser 決定重新開啟 Production Notify'
      : 'None in progress — awaiting next assignment'
  );
  const knownBlocker = safe(
    process.env.EXPORT_KNOWN_BLOCKER,
    pbsOnly
      ? '無 blocker。TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED 目前為 false 是 V2.4.4 刻意的安全政策，非缺陷——FETCH/QUEUE 仍為 true。第一筆真實 TDX LINE 通知（Notify 重新開啟後）尚待現場證據——REAL_WORLD_CONFIRMATION_PENDING。AI 呼叫已有 45 秒 fail-fast timeout（V2.4.3），CLEARED 會取消舊事件 stale retry。EVENT_ID 11509010029-5 該筆歷史事件確切失敗階段仍無法獨立查證，未臆測。詳見 07_KNOWN_ISSUES.md'
      : `${latestCompletedVersion} real-world confirmation pending — see 07_KNOWN_ISSUES.md`
  );
  const nextAction = safe(
    process.env.EXPORT_NEXT_ACTION,
    pbsOnly
      ? '待辦：觀察真實 Production（FETCH=true／QUEUE=true／NOTIFY=false）確認只剩新竹縣市 candidate、一般施工不再誤判、TDX facts 可完整組成 LINE 預覽後，才由人類＋Claude Browser 決定改回 true——不得自行改回。一個月後依 ineligibleByReason 數據決定是否收緊主動播報政策'
      : 'Await next task assignment, or real-world confirmation evidence for the latest release'
  );
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
    EXPORT_GENERATED_AT: GENERATED_AT_PLACEHOLDER,
    MODULE_INVENTORY: moduleInventory(),
    SOURCE_MAIN_HEAD: sourceMainHead,
    SOURCE_MAIN_HEAD_ORIGIN: sourceMainHeadOrigin,
    EXPORT_ARTIFACT_COMMIT: exportArtifactCommit,
    SOURCE_WORKING_TREE: sourceWorkingTree,
    TRAFFIC_SOURCE_MODE: trafficSourceMode,
    LINE_PUSH_POLICY: readLinePushPolicy(),
    PBS_AI_DECISION_ENABLED: readPbsAiDecisionEnabled(),
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

  // --- Step 3: build every allowlisted output file (timestamp still masked) ---
  //
  // Two passes on purpose. Pass one renders each file with the
  // generation timestamp left as a placeholder, so its hash is the
  // file's CONTENT identity -- independent of when the export ran. Pass
  // two picks the timestamp (reusing the previous one when every file's
  // content identity is unchanged) and only then writes bytes to disk.
  const prior = readPriorExportState();
  const built = OUTPUT_FILES.map((outName) => {
    let templated;
    if (VERBATIM_COPIES[outName]) {
      templated = readFileSync(join(ROOT, VERBATIM_COPIES[outName]), 'utf8');
    } else {
      templated = substitute(readFileSync(join(TEMPLATE_DIR, outName), 'utf8'));
    }
    return { name: outName, templated, contentSha256: sha256(templated) };
  });

  const contentUnchanged =
    prior !== null &&
    prior.exportGeneratedAt !== null &&
    built.every((f) => prior.contentHashes.get(f.name) === f.contentSha256);

  const effectiveGeneratedAt = contentUnchanged ? prior.exportGeneratedAt : exportGeneratedAt;
  if (contentUnchanged) {
    console.log(`↻ content identical to last synced export -- reusing generatedAt ${effectiveGeneratedAt} (no false delta)`);
  }

  const written = [];
  for (const file of built) {
    const content = file.templated.split(GENERATED_AT_PLACEHOLDER).join(effectiveGeneratedAt);

    if (file.name.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (err) {
        throw new Error(`JSON validation FAILED for ${file.name}: ${err.message}`);
      }
    }

    scanForSecrets(content, file.name);

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (!SIZE_GUARD_EXEMPT.has(file.name) && byteLength > MAX_CANONICAL_BYTES) {
      throw new Error(
        `size guard FAILED for ${file.name}: ${byteLength} bytes exceeds the ${MAX_CANONICAL_BYTES}-byte ` +
          `canonical ceiling. Canonical files must stay small enough for a single cloud-connector ` +
          `create_file call, otherwise automated sync silently degrades to manual upload.`
      );
    }

    writeFileSync(join(EXPORT_DIR, file.name), content, 'utf8');
    written.push({ name: file.name, contentSha256: file.contentSha256, sha256: sha256(content), bytes: byteLength });
    console.log(`✅ wrote ${file.name} (${byteLength} bytes)`);
  }

  // --- Step 3a: split the untouched full history into _history/ ---
  const historyFiles = writeHistoryChunks();

  // --- Step 4: required-file validation ---
  const missing = OUTPUT_FILES.filter((f) => !existsSync(join(EXPORT_DIR, f)));
  if (missing.length > 0) {
    throw new Error(`required-file validation FAILED: missing ${missing.join(', ')}`);
  }

  console.log('✅ JSON validation: PASS');
  console.log(`✅ required-file validation: PASS (all ${OUTPUT_FILES.length} canonical files present)`);
  console.log(`✅ size guard: PASS (every non-exempt canonical file <= ${MAX_CANONICAL_BYTES} bytes)`);
  console.log(`✅ _history: ${historyFiles.length} chunk file(s), each <= ${MAX_HISTORY_CHUNK_BYTES} bytes`);
  console.log('✅ secret scan: PASS (no forbidden patterns found)');
  console.log(`✅ export complete: ${relative(ROOT, EXPORT_DIR)}/`);
  console.log(`   source main head: ${sourceMainHead} (from ${sourceMainHeadOrigin})`);
  console.log(`   generated from checkout: ${gitBranch} @ ${gitHead}`);
  console.log(`   generated at: ${effectiveGeneratedAt}`);

  return {
    exportDir: EXPORT_DIR,
    gitHead,
    sourceMainHead,
    exportGeneratedAt: effectiveGeneratedAt,
    contentUnchanged,
    files: OUTPUT_FILES,
    fileHashes: written,
  };
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
