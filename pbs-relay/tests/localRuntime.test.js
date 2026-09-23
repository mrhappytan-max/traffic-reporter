import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireMonitorLock, purgeOldOperationalLogs, resolveStaleLockThresholdMs, touchMonitorLock,
  writeDebugPushLog, writeFailureLog, writeSuccessLog,
} from '../src/localRuntime.js';

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

test('a live PID with a stale heartbeat is treated as an abandoned lock and recovered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-heartbeat-'));
  const path = join(directory, 'monitor.lock');
  const staleHeartbeat = new Date('2026-09-23T00:00:00Z');
  await writeFile(path, JSON.stringify({ pid: 111, startedAt: staleHeartbeat.toISOString(), heartbeatAt: staleHeartbeat.toISOString() }));
  const now = new Date(staleHeartbeat.getTime() + 16 * 60 * 1000);
  const lock = await acquireMonitorLock(path, {
    pid: 222, now, processRunning: (pid) => pid === 111, staleAfterMs: 15 * 60 * 1000,
  });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, 222);
  await lock.release();
});

test('a live PID with a fresh heartbeat is still rejected as genuinely running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-fresh-heartbeat-'));
  const path = join(directory, 'monitor.lock');
  const freshHeartbeat = new Date('2026-09-23T00:00:00Z');
  await writeFile(path, JSON.stringify({ pid: 111, startedAt: freshHeartbeat.toISOString(), heartbeatAt: freshHeartbeat.toISOString() }));
  const now = new Date(freshHeartbeat.getTime() + 5 * 60 * 1000);
  await assert.rejects(
    acquireMonitorLock(path, { pid: 222, now, processRunning: (pid) => pid === 111, staleAfterMs: 15 * 60 * 1000 }),
    (error) => error.code === 'MONITOR_ALREADY_RUNNING',
  );
});

test('touchMonitorLock refreshes heartbeatAt on an existing lock without changing pid or startedAt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-touch-'));
  const path = join(directory, 'monitor.lock');
  const startedAt = new Date('2026-09-23T00:00:00Z');
  await writeFile(path, JSON.stringify({ pid: 333, startedAt: startedAt.toISOString(), heartbeatAt: startedAt.toISOString() }));
  const laterNow = new Date(startedAt.getTime() + 3 * 60 * 1000);
  await touchMonitorLock(path, laterNow);
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(updated.pid, 333);
  assert.equal(updated.startedAt, startedAt.toISOString());
  assert.equal(updated.heartbeatAt, laterNow.toISOString());
});

test('touchMonitorLock recreates a lock file that disappeared instead of throwing (ENOENT defense)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-touch-enoent-'));
  const path = join(directory, 'monitor.lock');
  const now = new Date('2026-09-23T00:00:00Z');
  await touchMonitorLock(path, now, { pid: 444 });
  const recreated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(recreated.pid, 444);
  assert.equal(recreated.heartbeatAt, now.toISOString());
});

test('resolveStaleLockThresholdMs defaults to heartbeat interval times the stale multiplier and honors overrides', () => {
  assert.equal(resolveStaleLockThresholdMs(), 15 * 60 * 1000);
  assert.equal(resolveStaleLockThresholdMs({ heartbeatIntervalMs: 60_000, staleMultiplier: 3 }), 180_000);
});
