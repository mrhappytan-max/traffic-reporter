#!/usr/bin/env node
// Meeting Room Engineering Memory — Google Drive Connector Direct Sync V1.
//
// WHY THIS IS A SEPARATE MODULE FROM finalize-release.mjs: a plain Node
// script (this repo's CI/local `npm run` process) has NO ability to call
// Claude's own Google Drive Connector — that connector is a tool only the
// Claude Agent session itself can invoke (an MCP tool call), never
// something a child `node` process can reach. So this module's job ends
// at PREPARING everything the Claude Agent needs to perform that sync
// itself afterward: a per-file content hash (so the Agent can verify a
// create/read-back round-trip actually matches, and so a rerun can tell
// "did content actually change since the last cloud sync" without
// re-uploading unchanged files) and the from-manifest allowlist/folder
// IDs, written to `.engineering/MEETING_ROOM_SYNC_REQUEST.json`.
//
// finalize-release.mjs prints GOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED and
// stops there for the Connector path — it must NEVER claim
// GOOGLE_DRIVE_SYNC=PASS/cloud sync complete on this provider's behalf,
// since it structurally cannot verify (or even attempt) that sync itself.
// Only the Claude Agent, after actually performing the
// create-verify-archive-promote protocol via the real Connector tools,
// may write a lastSync.status of "success" back into
// .engineering/MEETING_ROOM_SYNC.json — see that file's own comment and
// PROJECT_HANDOFF.md for the full protocol writeup.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXPORT_DIR, OUTPUT_FILES } from './export-meeting-room.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, '.engineering', 'MEETING_ROOM_SYNC.json');
const REQUEST_PATH = join(ROOT, '.engineering', 'MEETING_ROOM_SYNC_REQUEST.json');

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`.engineering/MEETING_ROOM_SYNC.json not found -- create it first (see that file's own comment for the required shape)`);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Prepares (never uploads) the Connector sync request: allowlist +
 * per-file SHA-256 + byte length, from the CURRENT meeting-room-export/
 * on disk (assumes exportMeetingRoom() already ran this same process --
 * see finalize-release.mjs's own step ordering).
 *
 * @returns {{provider, targetFolderId, targetFolderName, archiveFolderName, files: Array<{name, sha256, bytes}>, generatedAt}}
 */
export function prepareConnectorSyncRequest() {
  const manifest = readManifest();
  if (!existsSync(EXPORT_DIR)) {
    throw new Error('meeting-room-export/ does not exist -- run the export step first');
  }

  const files = OUTPUT_FILES.map((name) => {
    if (!manifest.allowlist.includes(name)) {
      throw new Error(`${name} is in OUTPUT_FILES but NOT in .engineering/MEETING_ROOM_SYNC.json's allowlist -- refusing to prepare a sync request outside the declared allowlist`);
    }
    const content = readFileSync(join(EXPORT_DIR, name), 'utf8');
    return { name, sha256: sha256(content), bytes: Buffer.byteLength(content, 'utf8') };
  });

  const request = {
    schemaVersion: 1,
    provider: manifest.provider,
    targetFolderId: manifest.targetFolderId,
    targetFolderName: manifest.targetFolderName,
    archiveFolderName: manifest.archiveFolderName,
    strategy: manifest.strategy,
    mainHead: gitHead(),
    generatedAt: new Date().toISOString(),
    files,
  };

  writeFileSync(REQUEST_PATH, JSON.stringify(request, null, 2) + '\n', 'utf8');
  return request;
}

export { MANIFEST_PATH, REQUEST_PATH };

if (import.meta.url === `file://${process.argv[1]}`) {
  const request = prepareConnectorSyncRequest();
  console.log(JSON.stringify(request, null, 2));
  console.log('\nGOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED');
}
