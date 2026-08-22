#!/usr/bin/env node
// Meeting Room Engineering Memory — DELTA SYNC policy (V1.1).
//
// PERMANENT RULE
// --------------
//   NORMAL RELEASE = DELTA SYNC
//   FULL VERIFY    = EXCEPTION ONLY
//
// A normal release compares each canonical file's SHA-256 against the
// last successful sync manifest and touches the cloud ONLY for files
// whose hash actually changed. An unchanged file must cost ZERO
// connector calls: no search, no read-back, no download, no create, no
// archive, no byte diff. "Just to be safe, re-verify all ten" is exactly
// the behaviour this module exists to make impossible by default -- it
// burns quota and connector calls to re-prove something the hash already
// proved.
//
// This module is deliberately PURE: it takes a manifest object and the
// current file hashes and returns a plan. It performs no I/O, calls no
// connector, and decides nothing about HOW to sync -- so it can be unit
// tested exhaustively without a network, a Drive folder, or a real
// export on disk.

/**
 * The only reasons a full verify may run. Anything else is a normal
 * release and MUST use delta. Kept as a closed set so "I felt like it"
 * cannot become an eighth exception.
 */
export const FULL_VERIFY_EXCEPTIONS = Object.freeze([
  // 1. Nothing has ever been synced, so there is no baseline to diff.
  'first-build',
  // 2. The sync mechanism itself changed (provider, protocol, tooling).
  'sync-architecture-change',
  // 3. Recovering from a connector failure that may have left the cloud
  //    in a partially-written state.
  'connector-failure-recovery',
  // 4. The canonical file set itself changed (added/removed/renamed).
  'canonical-structure-change',
  // 5. The archive / replacement protocol changed.
  'archive-protocol-change',
  // 6. The manifest/hash evidence cannot be trusted, so the diff would
  //    be meaningless. This is the one reason that may be raised
  //    AUTOMATICALLY -- see computeSyncPlan.
  'manifest-evidence-untrustworthy',
  // 7. A human explicitly asked for a complete audit.
  'human-explicit-audit-request',
]);

export const HASH_ALGORITHM = 'sha256';

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Is the recorded sync evidence good enough to diff against?
 *
 * Being strict here is the safe direction: a false "trustworthy" would
 * silently skip a file that never actually reached the cloud, while a
 * false "untrustworthy" only costs one extra full verify.
 *
 * @returns {{trustworthy: boolean, reason: string|null}}
 */
export function assessManifestEvidence(manifest, canonicalFiles) {
  if (!manifest || typeof manifest !== 'object') {
    return { trustworthy: false, reason: 'manifest missing or not an object' };
  }
  if (manifest.hashAlgorithm && manifest.hashAlgorithm !== HASH_ALGORITHM) {
    return { trustworthy: false, reason: `manifest hashAlgorithm is ${manifest.hashAlgorithm}, expected ${HASH_ALGORITHM}` };
  }
  const last = manifest.lastSync;
  if (!last || typeof last !== 'object') {
    return { trustworthy: false, reason: 'no lastSync block -- nothing has been synced yet' };
  }
  if (last.status !== 'success') {
    return { trustworthy: false, reason: `lastSync.status is ${JSON.stringify(last.status)}, not "success"` };
  }
  if (!Array.isArray(last.files) || last.files.length === 0) {
    return { trustworthy: false, reason: 'lastSync.files is empty -- no per-file hash evidence' };
  }

  const recorded = new Map();
  for (const entry of last.files) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') {
      return { trustworthy: false, reason: 'a lastSync.files entry is missing name or sha256' };
    }
    if (!SHA256_RE.test(entry.sha256)) {
      return { trustworthy: false, reason: `lastSync hash for ${entry.name} is not a sha256 digest` };
    }
    recorded.set(entry.name, entry.sha256);
  }

  const missing = canonicalFiles.filter((name) => !recorded.has(name));
  if (missing.length > 0) {
    return { trustworthy: false, reason: `no recorded hash for: ${missing.join(', ')}` };
  }
  return { trustworthy: true, reason: null };
}

/**
 * Decide what this release must actually sync.
 *
 * @param {object}   args
 * @param {object}   args.manifest        parsed .engineering/MEETING_ROOM_SYNC.json
 * @param {Array<{name: string, sha256: string, bytes?: number}>} args.currentFiles
 *        hashes of the freshly exported canonical files
 * @param {string|null} [args.fullVerifyReason]
 *        one of FULL_VERIFY_EXCEPTIONS to force a full verify; anything
 *        else throws, so an agent cannot hand-wave its way past delta
 * @returns {{
 *   mode: 'delta'|'full-verify',
 *   fullVerifyReason: string|null,
 *   changed: Array<{name: string, oldHash: string|null, newHash: string, reason: string}>,
 *   unchanged: string[],
 *   syncRequired: boolean,
 *   connectorCallsAllowedFor: string[],
 *   status: 'SYNC_REQUIRED'|'NOT_REQUIRED'
 * }}
 */
export function computeSyncPlan({ manifest, currentFiles, fullVerifyReason = null }) {
  if (!Array.isArray(currentFiles) || currentFiles.length === 0) {
    throw new Error('computeSyncPlan requires a non-empty currentFiles array');
  }
  if (fullVerifyReason !== null && !FULL_VERIFY_EXCEPTIONS.includes(fullVerifyReason)) {
    throw new Error(
      `FULL_VERIFY_REASON ${JSON.stringify(fullVerifyReason)} is not one of the allowed exceptions: ` +
        `${FULL_VERIFY_EXCEPTIONS.join(', ')}. A normal release must use delta sync.`
    );
  }

  const canonicalNames = currentFiles.map((f) => f.name);
  const evidence = assessManifestEvidence(manifest, canonicalNames);

  // An untrustworthy manifest is the one exception that may be raised
  // automatically: without a usable baseline a diff is meaningless, so
  // escalating is the only honest option.
  let mode = 'delta';
  let reason = fullVerifyReason;
  if (fullVerifyReason !== null) {
    mode = 'full-verify';
  } else if (!evidence.trustworthy) {
    mode = 'full-verify';
    reason = 'manifest-evidence-untrustworthy';
  }

  if (mode === 'full-verify') {
    const changed = currentFiles.map((f) => ({
      name: f.name,
      oldHash: null,
      newHash: f.sha256,
      reason: reason === 'manifest-evidence-untrustworthy' ? `full-verify: ${evidence.reason}` : `full-verify: ${reason}`,
    }));
    return {
      mode,
      fullVerifyReason: reason,
      evidenceReason: evidence.reason,
      changed,
      unchanged: [],
      syncRequired: true,
      connectorCallsAllowedFor: changed.map((c) => c.name),
      status: 'SYNC_REQUIRED',
    };
  }

  const recorded = new Map(manifest.lastSync.files.map((f) => [f.name, f.sha256]));
  const changed = [];
  const unchanged = [];
  for (const file of currentFiles) {
    const oldHash = recorded.get(file.name) ?? null;
    if (oldHash === file.sha256) {
      unchanged.push(file.name);
    } else {
      changed.push({
        name: file.name,
        oldHash,
        newHash: file.sha256,
        reason: oldHash === null ? 'no previously synced hash' : 'content hash changed',
      });
    }
  }

  const syncRequired = changed.length > 0;
  return {
    mode,
    fullVerifyReason: null,
    evidenceReason: null,
    changed,
    unchanged,
    syncRequired,
    // The hard rule, made mechanical: an unchanged file never appears
    // here, so it can never justify a connector call.
    connectorCallsAllowedFor: changed.map((c) => c.name),
    status: syncRequired ? 'SYNC_REQUIRED' : 'NOT_REQUIRED',
  };
}

/** Human-readable one-screen summary of a plan, for release output. */
export function formatSyncPlan(plan) {
  const lines = [];
  lines.push(`sync mode: ${plan.mode}`);
  if (plan.mode === 'full-verify') {
    lines.push(`FULL_VERIFY_REASON = ${plan.fullVerifyReason}`);
    if (plan.evidenceReason) lines.push(`  evidence: ${plan.evidenceReason}`);
  }
  lines.push(`changed files: ${plan.changed.length}`);
  for (const c of plan.changed) {
    lines.push(`  - ${c.name}`);
    lines.push(`      old: ${c.oldHash ?? '(none)'}`);
    lines.push(`      new: ${c.newHash}`);
    lines.push(`      why: ${c.reason}`);
  }
  lines.push(`unchanged files (ZERO connector calls): ${plan.unchanged.length}${plan.unchanged.length ? ` -- ${plan.unchanged.join(', ')}` : ''}`);
  lines.push(`sync required: ${plan.syncRequired ? 'yes' : 'no'}`);
  return lines.join('\n');
}
