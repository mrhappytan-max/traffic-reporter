import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_LOCK_STALE_MULTIPLIER,
  acquireMonitorLock, purgeOldOperationalLogs, resolveStaleLockThresholdMs,
  touchMonitorLock, writeDebugPushLog, writeFailureLog, writeSuccessLog,
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

// 路況-078 regression: a live PID (process.kill(pid, 0) succeeds) whose
// lock heartbeat is older than the stale threshold must still be
// reclaimed. This is the exact 2026-09-21/22 incident shape — the
// recorded PID looked alive (whether genuinely hung, or reused by an
// unrelated later process) but the lock was never refreshed.
test('a live PID with a stale (un-refreshed) heartbeat is treated as abandoned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-stale-'));
  const path = join(directory, 'monitor.lock');
  const staleAfterMs = 1000;
  await writeFile(path, JSON.stringify({ pid: 111, startedAt: '2026-08-27T00:00:00Z' }));
  const longAgo = new Date(Date.now() - staleAfterMs * 10);
  await utimes(path, longAgo, longAgo);

  const lock = await acquireMonitorLock(path, {
    pid: 222, processRunning: (pid) => pid === 111, staleAfterMs,
  });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, 222);
  await lock.release();
});

// Guard against over-eager reclaiming: a live PID with a heartbeat inside
// the threshold must still block a second instance exactly as before.
test('a live PID with a recent heartbeat is still rejected as MONITOR_ALREADY_RUNNING', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-fresh-'));
  const path = join(directory, 'monitor.lock');
  const staleAfterMs = 60_000;
  await writeFile(path, JSON.stringify({ pid: 111, startedAt: '2026-08-27T00:00:00Z' }));
  // writeFile above already left the lock's mtime at "now" — well inside
  // staleAfterMs — so no extra utimes() call is needed to make it fresh.
  await assert.rejects(
    acquireMonitorLock(path, { pid: 222, processRunning: (pid) => pid === 111, staleAfterMs }),
    (error) => error.code === 'MONITOR_ALREADY_RUNNING'
  );
});

// Regression: a dead PID must still be reclaimed immediately regardless
// of heartbeat recency — the staleness check is an *additional* path to
// reclaiming a lock, never a stricter gate on the existing one.
test('a dead PID is reclaimed even with a fresh heartbeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-lock-dead-'));
  const path = join(directory, 'monitor.lock');
  await writeFile(path, JSON.stringify({ pid: 111, startedAt: '2026-08-27T00:00:00Z' }));
  const lock = await acquireMonitorLock(path, {
    pid: 222, processRunning: () => false, staleAfterMs: 60_000,
  });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, 222);
  await lock.release();
});

test('touchMonitorLock refreshes the lock file mtime and never throws if the lock is gone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-runtime-heartbeat-'));
  const path = join(directory, 'monitor.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: '2026-08-27T00:00:00Z' }));
  const longAgo = new Date(Date.now() - 60_000);
  await utimes(path, longAgo, longAgo);
  const before = (await stat(path)).mtimeMs;

  await touchMonitorLock(path);
  const after = (await stat(path)).mtimeMs;
  assert.ok(after > before);

  // Missing lock file: must be a no-op, never a thrown error.
  await touchMonitorLock(join(directory, 'missing.lock'));
});

test('default stale-lock threshold is five polling intervals unless PBS_LOCAL_INTERVAL_MS overrides it', () => {
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 3 * 60 * 1000);
  assert.equal(DEFAULT_LOCK_STALE_MULTIPLIER, 5);
  assert.equal(resolveStaleLockThresholdMs(), DEFAULT_HEARTBEAT_INTERVAL_MS * DEFAULT_LOCK_STALE_MULTIPLIER);
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
