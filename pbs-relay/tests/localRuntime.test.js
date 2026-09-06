import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireMonitorLock, purgeOldOperationalLogs, writeDebugPushLog, writeFailureLog, writeSuccessLog } from '../src/localRuntime.js';

test('duplicate-instance lock rejects a live PID and recovers a stale lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-'));
  const path = join(directory, 'monitor.lock');
  await writeFile(path, JSON.stringify({ pid: 111, startedAt: '2026-08-27T00:00:00Z' }));
  await assert.rejects(acquireMonitorLock(path, { pid: 222, processRunning: (pid) => pid === 111 }),
    (error) => error.code === 'MONITOR_ALREADY_RUNNING');
  const lock = await acquireMonitorLock(path, { pid: 222, processRunning: () => false });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, 222);
  await lock.release();
  await assert.rejects(readFile(path, 'utf8'), (error) => error.code === 'ENOENT');
});

test('operational logs contain bounded fields and never secret-like extras', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-log-'));
  const now = new Date('2026-08-27T03:00:00Z');
  await writeSuccessLog(directory, {
    rawCount: 1000, relevantAccidentCount: 2, activeEventCount: 0,
    counts: { NEW: 0, UPDATED: 0, CLEARED: 0, MISSING_PENDING_CLEAR: 0, UNCHANGED: 0 },
    shouldPush: false, durationMs: 173, RELAY_TOKEN: 'must-not-log', Authorization: 'must-not-log',
  }, now);
  await writeFailureLog(directory, Object.assign(new Error('secret-message-must-not-log'), { code: 'network' }), now);
  const log = await readFile(join(directory, '2026-08-27.jsonl'), 'utf8');
  assert.match(log, /"rawRecords":1000/);
  assert.match(log, /"errorClassification":"network"/);
  assert.doesNotMatch(log, /must-not-log|Authorization|RELAY_TOKEN|secret-message/);
});

test('daily log retention removes files older than seven Taipei dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-retention-'));
  await writeFile(join(directory, '2026-08-20.jsonl'), 'old\n');
  await writeFile(join(directory, '2026-08-21.jsonl'), 'keep\n');
  await purgeOldOperationalLogs(directory, { now: new Date('2026-08-27T04:00:00Z'), retentionDays: 7 });
  await assert.rejects(readFile(join(directory, '2026-08-20.jsonl'), 'utf8'), (error) => error.code === 'ENOENT');
  assert.equal(await readFile(join(directory, '2026-08-21.jsonl'), 'utf8'), 'keep\n');
});

test('round and per-event debug logs contain only bounded counters and safe ACK fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-debug-log-'));
  const now = new Date('2026-08-27T03:00:00Z');
  await writeSuccessLog(directory, {
    rawCount: 1, relevantAccidentCount: 1, activeEventCount: 1, counts: { NEW: 1 }, shouldPush: true, durationMs: 1,
    debugPush: { debugPushEnabled: true, debugPushAttemptedCount: 1, debugPushAcceptedCount: 1, debugPushDuplicateCount: 0, debugPushFailedCount: 0 },
  }, now);
  await writeDebugPushLog(directory, {
    debugPushResult: 'ACK', httpStatus: 200, requestId: 'pbs:A:NEW:abc', eventId: 'A', lifecycle: 'NEW',
    accepted: true, duplicate: false, attempts: 1, durationMs: 3, Authorization: 'must-not-log', secret: 'must-not-log',
  }, now);
  const log = await readFile(join(directory, '2026-08-27.jsonl'), 'utf8');
  assert.match(log, /"debugPushAttemptedCount":1/);
  assert.match(log, /"accepted":true/);
  assert.doesNotMatch(log, /must-not-log|Authorization|secret/);
});
