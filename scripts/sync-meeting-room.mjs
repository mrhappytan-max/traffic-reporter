#!/usr/bin/env node
// Meeting Room Engineering Memory v1 — syncs the already-generated
// meeting-room-export/ (see scripts/export-meeting-room.mjs; this script
// never generates content itself, only copies) to
// TRAFFIC_MEETING_ROOM_SYNC_DIR (a LOCAL filesystem path — typically a
// Google Drive Desktop-mounted folder, e.g. on Windows:
// H:\我的雲端硬碟\路況播報員_工程記憶).
//
// HARD BOUNDARY: this script never fails a release. Per this round's own
// instruction ("如果 Drive 暫時離線：Repo 封版仍算成功... 不能因此丟失
// 本機工程紀錄"), any failure to reach the sync directory is reported as
// GOOGLE_DRIVE_SYNC=FAILED or GOOGLE_DRIVE_SYNC=PENDING (never thrown as
// an uncaught error that would abort scripts/finalize-release.mjs) — the
// repo-side export in meeting-room-export/ is the durable record
// regardless of whether this copy step ever succeeds.
//
// A GENUINE STRUCTURAL LIMIT WORTH NAMING EXPLICITLY: this script can
// only ever reach a filesystem path this PROCESS can see. In a cloud
// execution sandbox (no access to a user's own Windows machine or their
// Google Drive Desktop mount), TRAFFIC_MEETING_ROOM_SYNC_DIR will
// correctly, honestly resolve to "not found" every time — that is not a
// bug in this script, and no amount of retrying fixes it. This script is
// designed to work correctly wherever it actually runs somewhere with
// real access to that path (the user's own machine, a self-hosted
// runner, a future environment with Drive mounted) — see this repo's own
// PROJECT_HANDOFF.md for the explicit disclosure of which environment
// this was authored/tested from.
//
// SCOPE: only copies the CLOSED allowlist of files
// scripts/export-meeting-room.mjs already wrote into meeting-room-export/
// (imported directly, never re-derived) — never a whole-repo copy, never
// anything outside that directory.

import { existsSync, mkdirSync, copyFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_DIR, OUTPUT_FILES } from './export-meeting-room.mjs';

function main() {
  console.log('=== sync-meeting-room ===');

  const targetDir = process.env.TRAFFIC_MEETING_ROOM_SYNC_DIR;

  if (!targetDir) {
    console.warn('⚠️  TRAFFIC_MEETING_ROOM_SYNC_DIR is not set in this environment.');
    return report('PENDING', 'TRAFFIC_MEETING_ROOM_SYNC_DIR not set', []);
  }

  console.log(`target: ${targetDir}`);

  // REAL BUG CAUGHT WHILE BUILDING THIS (documented, not hypothetical):
  // on a non-Windows process (this cloud sandbox is Linux), Node's fs
  // calls do NOT reject a Windows-style path like
  // "H:\我的雲端硬碟\路況播報員_工程記憶" — they silently treat the
  // whole string, backslashes and all, as a single literal directory
  // NAME and happily create/write it inside the current working
  // directory. That is not a sync to the user's real Google Drive at
  // all; it is a meaninglessly-named local folder that would have been
  // reported as GOOGLE_DRIVE_SYNC=SUCCESS without this check. Detected
  // by actually running this script with the real target value during
  // this round's own build/test pass — see PROJECT_HANDOFF.md for the
  // full writeup. Refuse outright rather than silently "succeeding" into
  // the wrong place whenever the path looks like a Windows drive path
  // but this process is not running on Windows.
  const looksLikeWindowsPath = /^[A-Za-z]:\\/.test(targetDir) || targetDir.includes('\\');
  if (looksLikeWindowsPath && process.platform !== 'win32') {
    console.warn(
      `⚠️  TRAFFIC_MEETING_ROOM_SYNC_DIR ("${targetDir}") looks like a Windows path, ` +
        `but this process is running on "${process.platform}", not Windows. Refusing to ` +
        `create a same-named local folder here -- that would NOT be the user's real Google ` +
        `Drive location and would falsely report success. This script must be run somewhere ` +
        `with actual filesystem access to that path (the user's own Windows machine with ` +
        `Google Drive Desktop mounted, or an environment where this path is real).`
    );
    return report('FAILED', `path looks like a Windows path but process.platform is "${process.platform}" (not win32) -- refusing to create a locally-misnamed folder`, []);
  }

  if (!existsSync(EXPORT_DIR)) {
    console.warn('⚠️  meeting-room-export/ does not exist — run `npm run export:meeting-room` first.');
    return report('FAILED', 'meeting-room-export/ missing (export not run yet)', []);
  }

  let dirExists = existsSync(targetDir);
  if (!dirExists) {
    // Attempt to create it (a fresh Drive-synced folder that simply
    // hasn't been created yet is a normal first-run case, not an error)
    // — but never treat a failure to create it as fatal to the release.
    try {
      mkdirSync(targetDir, { recursive: true });
      dirExists = true;
      console.log('created target directory (did not previously exist)');
    } catch (err) {
      console.warn(`⚠️  target directory does not exist and could not be created: ${err.message}`);
      return report('FAILED', `directory unreachable from this process: ${err.message}`, []);
    }
  }

  try {
    accessSync(targetDir, constants.W_OK);
  } catch (err) {
    console.warn(`⚠️  target directory exists but is not writable from this process: ${err.message}`);
    return report('FAILED', `directory not writable: ${err.message}`, []);
  }

  const copied = [];
  for (const fileName of OUTPUT_FILES) {
    const src = join(EXPORT_DIR, fileName);
    const dest = join(targetDir, fileName);
    try {
      copyFileSync(src, dest);
      copied.push(fileName);
      console.log(`✅ synced ${fileName}`);
    } catch (err) {
      console.warn(`⚠️  failed to copy ${fileName}: ${err.message}`);
    }
  }

  if (copied.length === OUTPUT_FILES.length) {
    console.log(`✅ GOOGLE_DRIVE_SYNC=SUCCESS (${copied.length}/${OUTPUT_FILES.length} files)`);
    return report('SUCCESS', null, copied);
  }
  console.warn(`⚠️  partial sync: ${copied.length}/${OUTPUT_FILES.length} files copied`);
  return report('FAILED', `partial sync: only ${copied.length}/${OUTPUT_FILES.length} files copied`, copied);
}

function report(status, reason, copiedFiles) {
  const result = { status: `GOOGLE_DRIVE_SYNC=${status}`, reason, copiedFiles, targetDir: process.env.TRAFFIC_MEETING_ROOM_SYNC_DIR || null };
  console.log(JSON.stringify(result));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as syncMeetingRoom };
