#!/usr/bin/env node
// npm run finalize:release — Meeting Room Engineering Memory v1.
//
// This is the LAST stage of the fixed release lifecycle, not the whole
// thing: Fix/Feature -> Tests -> main -> Push -> Deploy -> Verify ->
// **finalize:release** -> (Meeting Room Export -> Google Drive Sync) ->
// only then accept the next task. It does NOT re-run your feature's own
// tests, does NOT merge/push/deploy anything — those must already be
// done by the time this runs. What it DOES do:
//
//   1. npm run check:deployment-policy — fast, local, 0-network sanity
//      check (reuses the existing tool, never a second copy of its
//      rules).
//   2. Meeting Room Export (scripts/export-meeting-room.mjs, in-process)
//      — regenerates meeting-room-export/ from THIS commit's real state.
//   3. Google Drive Sync (scripts/sync-meeting-room.mjs, in-process) —
//      best-effort copy to TRAFFIC_MEETING_ROOM_SYNC_DIR. NEVER fails
//      the release — see that script's own module comment.
//   4. Prints one combined summary.
//
// Exit code reflects steps 1-2 only (policy + export are real
// prerequisites for calling a release "封版"). Step 3 (Drive sync)
// NEVER affects the exit code — a Drive outage, or this process simply
// running somewhere without access to that path, must never make a
// release look like it "failed."

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exportMeetingRoom } from './export-meeting-room.mjs';
import { syncMeetingRoom } from './sync-meeting-room.mjs';

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
  console.log('=== finalize-release (Meeting Room Engineering Memory v1) ===');

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

  console.log('\n--- Step 3: Google Drive Sync (best-effort, never fails the release) ---');
  const syncResult = syncMeetingRoom();

  console.log('\n=== finalize-release SUMMARY ===');
  console.log(`check:deployment-policy: ${policyOk ? 'PASS' : 'FAIL'}`);
  console.log(`meeting-room-export: ${exportOk ? 'PASS' : 'FAIL'}`);
  if (exportOk) {
    console.log(`  source commit: ${exportResult.gitHead}`);
    console.log(`  generated at: ${exportResult.exportGeneratedAt}`);
    console.log(`  files: ${exportResult.files.length}`);
  }
  console.log(`google-drive-sync: ${syncResult.status}${syncResult.reason ? ` (${syncResult.reason})` : ''}`);

  const releaseSealed = policyOk && exportOk;
  console.log(`\nFINAL: ${releaseSealed ? 'RELEASE_SEALED' : 'RELEASE_SEAL_FAILED'}`);
  console.log('(Drive sync status is informational only and never affects this result — see sync-meeting-room.mjs.)');

  if (!releaseSealed) process.exit(1);
}

main();
