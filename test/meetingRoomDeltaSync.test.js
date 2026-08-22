// Meeting Room Engineering Memory V1.1 — DELTA SYNC policy.
//
// The rule under test: NORMAL RELEASE = DELTA SYNC, FULL VERIFY =
// EXCEPTION ONLY. The expensive failure mode this guards against is an
// agent re-verifying all ten canonical files "just to be safe" on a
// release where nothing changed — every one of those connector calls is
// pure waste. So the assertions below are mostly about what must NOT
// happen: unchanged files must produce zero actionable work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  computeSyncPlan,
  assessManifestEvidence,
  FULL_VERIFY_EXCEPTIONS,
  HASH_ALGORITHM,
} from '../scripts/meeting-room-delta.mjs';

const CANONICAL = [
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

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Hashes for a "nothing has changed since last sync" baseline. */
function baselineFiles() {
  return CANONICAL.map((name) => ({ name, sha256: sha256(`content-of-${name}`), bytes: 100 }));
}

function manifestFrom(files, overrides = {}) {
  return {
    hashAlgorithm: HASH_ALGORITHM,
    allowlist: CANONICAL,
    lastSync: {
      status: 'success',
      files: files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes })),
      ...(overrides.lastSync || {}),
    },
    ...overrides.top,
  };
}

/** Mutate N files so their hashes differ from the baseline. */
function withChanged(files, names) {
  return files.map((f) => (names.includes(f.name) ? { ...f, sha256: sha256(`CHANGED-${f.name}`) } : f));
}

test('1. all ten files unchanged -> zero connector actions requested', () => {
  const files = baselineFiles();
  const plan = computeSyncPlan({ manifest: manifestFrom(files), currentFiles: files });

  assert.equal(plan.mode, 'delta');
  assert.equal(plan.syncRequired, false);
  assert.equal(plan.status, 'NOT_REQUIRED');
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.unchanged.length, 10);
  // The load-bearing assertion: nothing is eligible for a connector call.
  assert.deepEqual(plan.connectorCallsAllowedFor, []);
});

test('2. exactly one file changed -> only that one file is listed', () => {
  const files = baselineFiles();
  const current = withChanged(files, ['00_CURRENT_STATE.md']);
  const plan = computeSyncPlan({ manifest: manifestFrom(files), currentFiles: current });

  assert.equal(plan.mode, 'delta');
  assert.equal(plan.syncRequired, true);
  assert.equal(plan.status, 'SYNC_REQUIRED');
  assert.deepEqual(plan.connectorCallsAllowedFor, ['00_CURRENT_STATE.md']);
  assert.equal(plan.unchanged.length, 9);

  const [entry] = plan.changed;
  assert.equal(entry.name, '00_CURRENT_STATE.md');
  assert.equal(entry.oldHash, files[0].sha256);
  assert.equal(entry.newHash, current[0].sha256);
  assert.equal(entry.reason, 'content hash changed');
  // Old and new hash must both be reported, so a human can audit the diff claim.
  assert.notEqual(entry.oldHash, entry.newHash);
});

test('3. four files changed -> exactly those four are listed, other six skipped', () => {
  const files = baselineFiles();
  const changedNames = [
    '00_CURRENT_STATE.md',
    '02_PROJECT_HANDOFF.md',
    'SYSTEM_STATE.json',
    'PRODUCTION_MANIFEST.json',
  ];
  const current = withChanged(files, changedNames);
  const plan = computeSyncPlan({ manifest: manifestFrom(files), currentFiles: current });

  assert.equal(plan.mode, 'delta');
  assert.deepEqual(plan.connectorCallsAllowedFor.sort(), [...changedNames].sort());
  assert.equal(plan.unchanged.length, 6);
  for (const name of changedNames) {
    assert.ok(!plan.unchanged.includes(name), `${name} must not be treated as unchanged`);
  }
  // The six unchanged files must be untouched even though a sync IS happening
  // for the other four — a partial sync must not escalate into a full one.
  assert.equal(plan.syncRequired, true);
  assert.equal(plan.changed.length, 4);
});

test('4. full verify requires an explicit, allowlisted exception flag', () => {
  const files = baselineFiles();
  const manifest = manifestFrom(files);

  // No flag on an all-unchanged release: delta, and nothing to do.
  assert.equal(computeSyncPlan({ manifest, currentFiles: files }).mode, 'delta');

  // A made-up reason is refused outright rather than quietly downgraded,
  // so "for safety" can never become a de-facto eighth exception.
  assert.throws(
    () => computeSyncPlan({ manifest, currentFiles: files, fullVerifyReason: 'just-to-be-safe' }),
    /not one of the allowed exceptions/
  );

  // Every declared exception is accepted and forces all ten files.
  for (const reason of FULL_VERIFY_EXCEPTIONS) {
    const plan = computeSyncPlan({ manifest, currentFiles: files, fullVerifyReason: reason });
    assert.equal(plan.mode, 'full-verify', `${reason} should force full verify`);
    assert.equal(plan.fullVerifyReason, reason);
    assert.equal(plan.changed.length, 10);
    assert.equal(plan.unchanged.length, 0);
    assert.equal(plan.syncRequired, true);
  }
});

test('5. invalid or missing manifest evidence auto-escalates to full verify', () => {
  const files = baselineFiles();

  const cases = [
    ['manifest absent', undefined],
    ['no lastSync block', { hashAlgorithm: HASH_ALGORITHM }],
    ['lastSync not successful', manifestFrom(files, { lastSync: { status: 'PENDING' } })],
    ['no per-file evidence', manifestFrom(files, { lastSync: { files: [] } })],
    [
      'a hash is not a sha256 digest',
      manifestFrom(files, { lastSync: { files: files.map((f, i) => ({ name: f.name, sha256: i === 3 ? 'not-a-hash' : f.sha256 })) } }),
    ],
    [
      'a canonical file has no recorded hash',
      manifestFrom(files, { lastSync: { files: files.slice(1).map((f) => ({ name: f.name, sha256: f.sha256 })) } }),
    ],
    ['wrong hash algorithm', manifestFrom(files, { top: { hashAlgorithm: 'md5' } })],
  ];

  for (const [label, manifest] of cases) {
    const plan = computeSyncPlan({ manifest, currentFiles: files });
    assert.equal(plan.mode, 'full-verify', `${label} should escalate`);
    assert.equal(plan.fullVerifyReason, 'manifest-evidence-untrustworthy', label);
    assert.equal(plan.changed.length, 10, label);
    // Escalation must be explained, never silent.
    assert.ok(plan.evidenceReason && plan.evidenceReason.length > 0, `${label} must report why`);
  }

  // And a good manifest must NOT escalate.
  assert.equal(assessManifestEvidence(manifestFrom(files), CANONICAL).trustworthy, true);
});

test('6. delta policy never weakens the secret scan', async () => {
  // The secret scan runs inside the export, over every generated file,
  // before any hashing or delta decision exists — so no sync mode can
  // skip it. Assert the export module still enforces it.
  const mod = await import('../scripts/export-meeting-room.mjs');
  assert.equal(typeof mod.exportMeetingRoom, 'function');

  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../scripts/export-meeting-room.mjs', import.meta.url), 'utf8')
  );
  assert.match(source, /scanForSecrets\(content, file\.name\)/);
  assert.match(source, /secret-scan FAILED/);
  // The delta module must not be able to gate the scan.
  const delta = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../scripts/meeting-room-delta.mjs', import.meta.url), 'utf8')
  );
  assert.doesNotMatch(delta, /scanForSecrets/);
});

test('unchanged files carry zero actionable work regardless of how many changed', () => {
  const files = baselineFiles();
  for (let n = 0; n <= CANONICAL.length; n += 1) {
    const changedNames = CANONICAL.slice(0, n);
    const current = withChanged(files, changedNames);
    const plan = computeSyncPlan({ manifest: manifestFrom(files), currentFiles: current });

    assert.equal(plan.changed.length, n);
    assert.equal(plan.unchanged.length, CANONICAL.length - n);
    assert.equal(plan.connectorCallsAllowedFor.length, n);
    assert.equal(plan.syncRequired, n > 0);
    assert.equal(plan.status, n > 0 ? 'SYNC_REQUIRED' : 'NOT_REQUIRED');
    for (const name of plan.unchanged) {
      assert.ok(!plan.connectorCallsAllowedFor.includes(name));
    }
  }
});
