import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLocalMonitor } from '../src/localMonitor.js';
import { writeLocalState } from '../src/localState.js';

test('PBS fetch failure does not increment missingCount or alter local state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-local-fetch-failure-'));
  const statePath = join(directory, 'state.json');
  const state = {
    schemaVersion: 1,
    updatedAt: '2026-08-27T01:03:00.000Z',
    events: {
      A: {
        fingerprint: 'a'.repeat(64),
        event: { id: 'A' },
        missingCount: 1,
        lastSeenAt: '2026-08-27T01:00:00.000Z',
        firstMissingAt: '2026-08-27T01:03:00.000Z',
      },
    },
  };
  await writeLocalState(statePath, state);
  const before = await readFile(statePath, 'utf8');

  await assert.rejects(
    runLocalMonitor({
      statePath,
      fetchImpl: async () => { throw new TypeError('simulated PBS outage'); },
      now: new Date('2026-08-27T01:06:00Z'),
    }),
    /Network error calling PBS upstream/
  );

  assert.equal(await readFile(statePath, 'utf8'), before);
});
