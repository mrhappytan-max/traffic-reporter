// PRODUCTION_VERSION_LINEAGE_RECONCILIATION (2026-08-25).
//
// src/version.js was last bumped on 2026-08-21 at V1.8.6.9 and then never
// again, while V1.8.7.0 through V1.8.7.14 all shipped. GET /version spent
// three weeks reporting the right commit and a stale version, and nobody
// noticed, because three different things each believed they knew the
// version and the one that fed /version was not the one that fed the
// Engineering Memory.
//
// These tests exist so that cannot happen silently again. They lock the
// SHAPE of the rule (one source, everyone derives from it), not the
// current number — asserting the literal version here would just create a
// fourth place to update and re-create the problem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { APP_VERSION, SCHEMA_VERSION } from '../src/version.js';
import { getPublicVersionInfo, getDeploymentStatus } from '../src/traffic/deploymentStatus.js';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

const VERSION_PATTERN = /^V\d+\.\d+\.\d+(?:\.\d+)?$/;

test('1. the canonical version is a single well-formed value', () => {
  assert.match(APP_VERSION, VERSION_PATTERN);
  // One product line only — never a parallel V1/V2/V57.x series.
  // V1.9.0 (2026-08-26) is the first three-part release — the prefix
  // check below moved from 'V1.8.7.' to 'V1.9.' in the SAME commit that
  // bumped APP_VERSION, per this file's own standing rule (see test 6's
  // comment and src/version.js's own scheme-switch note). VERSION_PATTERN
  // itself already accepted both four-part and three-part shapes and
  // needed no change.
  assert.ok(APP_VERSION.startsWith('V1.9.'), 'the current official series is V1.9.x');
  assert.equal(typeof SCHEMA_VERSION, 'number');
});

test('2. GET /version reports the canonical version, not a copy of its own', () => {
  const info = getPublicVersionInfo();
  assert.equal(info.appVersion, APP_VERSION);
  assert.equal(info.service, 'traffic-reporter');
});

test('3. /admin/deployment-status reports the same one version', () => {
  assert.equal(getDeploymentStatus({}).appVersion, APP_VERSION);
});

test('4. nothing under src/ hard-codes a product version string of its own', async () => {
  // Comments may cite historical versions freely ("V1.8.7.5 confirmed the
  // 國3 RoadID") — that is provenance, not a declaration. What must never
  // reappear is a second *assignment* of a version-shaped value.
  const files = ['../src/traffic/deploymentStatus.js', '../src/traffic/health.js', '../src/index.js'];
  for (const f of files) {
    const src = await read(f);
    const declarations = src.match(/^\s*(?:export\s+)?const\s+\w*VERSION\w*\s*=\s*['"]V[\d.]+['"]/gm) || [];
    assert.deepEqual(declarations, [], `${f} must import APP_VERSION, never declare its own`);
  }
});

test('5. src/version.js is the only file that assigns APP_VERSION', async () => {
  const src = await read('../src/version.js');
  assert.match(src, /export const APP_VERSION\s*=\s*'V[\d.]+'/);

  const consumer = await read('../src/traffic/deploymentStatus.js');
  assert.match(consumer, /import\s*\{[^}]*APP_VERSION[^}]*\}\s*from\s*'\.\.\/version\.js'/);
});

test('6. the Engineering Memory export reads src/version.js, not the git log', async () => {
  const src = await read('../scripts/export-meeting-room.mjs');

  assert.match(src, /function canonicalAppVersion\(\)/, 'the canonical reader must exist');
  assert.match(
    src,
    /const currentVersion = canonicalVersion;/,
    'the exported version must come from src/version.js'
  );
  assert.match(
    src,
    /const latestCompletedVersion = canonicalVersion;/,
    'latestCompleted must come from the same one source'
  );

  // The commit-message scrape may survive ONLY as a warning. If it is ever
  // assigned back into currentVersion/latestCompletedVersion, the drift
  // this task fixed has returned.
  assert.ok(
    !/const (?:currentVersion|latestCompletedVersion) = latestCommitVersion;/.test(src),
    'a version scraped from a commit message is a version nobody owns'
  );
});

test('7. the export refuses to guess when the canonical source is unreadable', async () => {
  const src = await read('../scripts/export-meeting-room.mjs');
  // Failing loudly is the point: falling back to the scrape is what let a
  // stale version look authoritative for three weeks.
  assert.match(src, /cannot read APP_VERSION from src\/version\.js/);
});
