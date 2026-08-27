import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalState, writeLocalState } from '../src/localState.js';

test('state is absent initially and survives an atomic write/read round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-local-state-'));
  const path = join(directory, 'nested', 'state.json');
  assert.equal(await readLocalState(path), null);
  const expected = { schemaVersion: 1, updatedAt: '2026-08-26T00:00:00.000Z', events: {} };
  await writeLocalState(path, expected);
  assert.deepEqual(await readLocalState(path), expected);
  assert.match(await readFile(path, 'utf8'), /"schemaVersion": 1/);
});

test('pending missing metadata survives a Windows/Node-style state reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-local-reboot-'));
  const path = join(directory, 'state.json');
  const expected = {
    schemaVersion: 1,
    updatedAt: '2026-08-27T01:03:00.000Z',
    events: {
      '11508260013-5': {
        fingerprint: 'a'.repeat(64),
        event: { id: '11508260013-5' },
        missingCount: 1,
        lastSeenAt: '2026-08-27T01:00:00.000Z',
        firstMissingAt: '2026-08-27T01:03:00.000Z',
      },
    },
  };
  await writeLocalState(path, expected);
  assert.deepEqual(await readLocalState(path), expected);
});
