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
