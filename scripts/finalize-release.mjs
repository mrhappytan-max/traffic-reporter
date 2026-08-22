#!/usr/bin/env node
// npm run finalize:release — Meeting Room Engineering Memory.
//
// This is the LAST stage of the fixed release lifecycle, not the whole
// thing: Fix/Feature -> Tests -> main -> Push -> Deploy -> Verify ->
// **finalize:release** -> (Claude performs the Connector sync) -> only
// then accept the next task. It does NOT re-run your feature's own
// tests, does NOT merge/push/deploy anything — those must already be
// done by the time this runs. What it DOES do:
//
//   1. npm run check:deployment-policy — fast, local, 0-network sanity
//      check (reuses the existing tool, never a second copy of its
//      rules).
//   2. Meeting Room Export (scripts/export-meeting-room.mjs, in-process)
//      — regenerates meeting-room-export/ from THIS commit's real state.
//   3. Prepares the Google Drive CONNECTOR sync request (per-file
//      SHA-256 + the allowlist/folder IDs from
//      .engineering/MEETING_ROOM_SYNC.json), written to
//      .engineering/MEETING_ROOM_SYNC_REQUEST.json, and prints
//      GOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED. This script CANNOT call the
//      Connector itself — that's an MCP tool only the Claude Agent
//      session can invoke — so it stops here and hands off. See
//      scripts/prepare-connector-sync-request.mjs's own module comment.
//   4. Runs the Windows Drive-Desktop LOCAL FILESYSTEM fallback
//      (scripts/sync-meeting-room.mjs) as a SEPARATE, best-effort,
//      informational-only step — kept, never removed, but its result is
//      never conflated with real Connector completion (see the summary
//      output below: the two are printed under clearly different
//      labels).
//   5. Prints one combined summary.
//
// Exit code reflects steps 1-2 only (policy + export are real
// prerequisites for calling a release "封版"). Neither the Connector
// sync REQUEST (step 3) nor the Windows fallback (step 4) ever affects
// the exit code — completing the actual cloud sync is the Agent's job,
// performed AFTER this script exits, using the real Connector tools; see
// the permanent Agent Rule in PROJECT_HANDOFF.md for the full sequence a
// Claude session must follow once it sees
// GOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportMeetingRoom } from './export-meeting-room.mjs';
import { syncMeetingRoom } from './sync-meeting-room.mjs';
import { prepareConnectorSyncRequest, REQUEST_PATH } from './prepare-connector-sync-request.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function runPolicyCheck() {
  console.log('\n--- Step 1: check:deployment-policy ---');
  try {
    const out = execFileSync('node', [join(__dirname, 'check-deployment-policy.mjs')], { cwd: ROOT, encoding: 'utf8' });
    console.log(out.trim());
    return true;
  } catch (err) {
    console.error(err.stdout || err.message);
    return false;
  }
}

function main() {
  console.log('=== finalize-release (Meeting Room Engineering Memory) ===');

  const policyOk = runPolicyCheck();

  console.log('\n--- Step 2: Meeting Room Export ---');
  let exportResult;
  let exportOk = true;
  try {
    exportResult = exportMeetingRoom();
  } catch (err) {
    console.error(`❌ export FAILED: ${err.message}`);
    exportOk = false;
  }

  console.log('\n--- Step 3: Google Drive Connector sync request (this script cannot perform the sync itself) ---');
  let connectorRequest = null;
  let connectorRequestOk = false;
  if (exportOk) {
    try {
      connectorRequest = prepareConnectorSyncRequest();
      connectorRequestOk = true;
      console.log(`✅ wrote ${REQUEST_PATH.split('/').slice(-2).join('/')} (${connectorRequest.files.length} files, provider=${connectorRequest.provider})`);
    } catch (err) {
      console.error(`❌ connector sync request FAILED: ${err.message}`);
    }
  } else {
    console.warn('⚠️  skipped (export did not succeed)');
  }

  console.log('\n--- Step 4: Windows Drive-Desktop local-fs fallback (best-effort, informational only, never fails the release) ---');
  const fallbackResult = syncMeetingRoom();

  console.log('\n=== finalize-release SUMMARY ===');
  console.log(`check:deployment-policy: ${policyOk ? 'PASS' : 'FAIL'}`);
  console.log(`meeting-room-export: ${exportOk ? 'PASS' : 'FAIL'}`);
  if (exportOk) {
    console.log(`  source commit: ${exportResult.gitHead}`);
    console.log(`  generated at: ${exportResult.exportGeneratedAt}`);
    console.log(`  files: ${exportResult.files.length}`);
  }
  console.log(`connector-sync-request: ${connectorRequestOk ? 'PREPARED' : 'NOT PREPARED'}`);
  console.log(`windows-fallback-sync (informational only, NOT the Connector): ${fallbackResult.status}${fallbackResult.reason ? ` (${fallbackResult.reason})` : ''}`);

  const releaseSealed = policyOk && exportOk;
  console.log(`\nFINAL: ${releaseSealed ? 'RELEASE_SEALED' : 'RELEASE_SEAL_FAILED'}`);
  if (releaseSealed && connectorRequestOk) {
    console.log('GOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED');
    console.log(
      '(The Claude Agent session must now perform the real Connector sync itself using create-verify-archive-promote ' +
        `— see ${REQUEST_PATH.split('/').slice(-2).join('/')} for the exact files/hashes to sync, and ` +
        '.engineering/MEETING_ROOM_SYNC.json for the target folder/allowlist. This script never claims cloud sync ' +
        'is complete — only the Agent, after real Connector calls, may record that.)'
    );
  }
  console.log('(Neither the connector-sync-request nor the Windows fallback result affects this exit code.)');

  if (!releaseSealed) process.exit(1);
}

main();
