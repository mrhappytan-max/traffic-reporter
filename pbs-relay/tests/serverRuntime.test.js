// 路況-080: tests for the Relay's new file-based operational logging
// (server.js had none before this). Mirrors the structure of
// localRuntime.test.js's own log-writing tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_HEALTH_LOG_MIN_INTERVAL_MS, DEFAULT_LOG_RETENTION_DAYS,
  createHealthCheckLogger, logServerStart, logSignal,
  logUncaughtException, logUnhandledRejection, purgeOldRelayLogs,
} from '../src/serverRuntime.js';

test('logServerStart writes a server_start record with the listening port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-start-'));
  const now = new Date('2026-09-23T03:00:00Z');
  const record = logServerStart(directory, { port: 3000 }, now);
  assert.equal(record.event, 'server_start');
  assert.equal(record.port, 3000);
  const log = await readFile(join(directory, '2026-09-23.jsonl'), 'utf8');
  assert.match(log, /"event":"server_start"/);
  assert.match(log, /"port":3000/);
});

test('health-check logging is throttled: same status inside the interval is suppressed', () => {
  const t0 = new Date('2026-09-23T03:00:00Z');
  let written = 0;
  // Point at a directory that will never actually be read back — this
  // test only cares about how many times writeRelayLog is invoked, which
  // we observe indirectly via the returned record being non-null.
  const directory = '/tmp/pbs-relay-runtime-throttle-unused';
  const logHealthCheck = createHealthCheckLogger(directory, { minIntervalMs: 60_000 });
  const first = logHealthCheck('ok', t0);
  if (first) written += 1;
  const second = logHealthCheck('ok', new Date(t0.getTime() + 1000)); // 1s later, same status
  assert.equal(second, null, 'same status well inside minIntervalMs must be suppressed');
});

test('health-check logging fires on state change even inside the interval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-statechange-'));
  const t0 = new Date('2026-09-23T03:00:00Z');
  const logHealthCheck = createHealthCheckLogger(directory, { minIntervalMs: 60_000 });
  logHealthCheck('ok', t0);
  const changed = logHealthCheck('error', new Date(t0.getTime() + 1000));
  assert.ok(changed, 'a status change must always be logged regardless of elapsed time');
  assert.equal(changed.status, 'error');
});

test('health-check logging fires again once minIntervalMs has elapsed, even with an unchanged status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-heartbeat-'));
  const t0 = new Date('2026-09-23T03:00:00Z');
  const logHealthCheck = createHealthCheckLogger(directory, { minIntervalMs: 60_000 });
  logHealthCheck('ok', t0);
  const suppressed = logHealthCheck('ok', new Date(t0.getTime() + 30_000));
  assert.equal(suppressed, null);
  const heartbeat = logHealthCheck('ok', new Date(t0.getTime() + 61_000));
  assert.ok(heartbeat, 'an unchanged status must still be logged once minIntervalMs has passed');
});

test('default health-check throttle interval is 15 minutes', () => {
  assert.equal(DEFAULT_HEALTH_LOG_MIN_INTERVAL_MS, 15 * 60 * 1000);
});

test('logUncaughtException records the error name, message and full stack trace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-uncaught-'));
  const now = new Date('2026-09-23T03:00:00Z');
  const error = new Error('simulated crash');
  const record = logUncaughtException(directory, error, now);
  assert.equal(record.event, 'uncaught_exception');
  assert.equal(record.errorName, 'Error');
  assert.equal(record.message, 'simulated crash');
  assert.ok(record.stack && record.stack.includes('simulated crash'));
  const log = await readFile(join(directory, '2026-09-23.jsonl'), 'utf8');
  assert.match(log, /"event":"uncaught_exception"/);
});

test('logUnhandledRejection records an Error-shaped rejection reason with its stack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-rejection-'));
  const now = new Date('2026-09-23T03:00:00Z');
  const record = logUnhandledRejection(directory, new TypeError('bad promise'), now);
  assert.equal(record.event, 'unhandled_rejection');
  assert.equal(record.errorName, 'TypeError');
  assert.equal(record.message, 'bad promise');
  assert.ok(record.stack);
});

test('logUnhandledRejection tolerates a non-Error rejection reason without throwing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-rejection-nonerror-'));
  const now = new Date('2026-09-23T03:00:00Z');
  const record = logUnhandledRejection(directory, 'plain string reason', now);
  assert.equal(record.event, 'unhandled_rejection');
  assert.equal(record.errorName, 'unknown');
  assert.equal(record.message, 'plain string reason');
  assert.equal(record.stack, null);
});

test('logSignal records SIGTERM and SIGINT', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-signal-'));
  const now = new Date('2026-09-23T03:00:00Z');
  logSignal(directory, 'SIGTERM', now);
  logSignal(directory, 'SIGINT', now);
  const log = await readFile(join(directory, '2026-09-23.jsonl'), 'utf8');
  assert.match(log, /"event":"signal","signal":"SIGTERM"/);
  assert.match(log, /"event":"signal","signal":"SIGINT"/);
});

test('a logging failure (unwritable directory) is caught and never thrown', () => {
  // Point logDirectory at a path that is itself an existing *file*, so
  // mkdirSync(..., {recursive:true}) inside writeRelayLog throws ENOTDIR
  // — this must be swallowed, not propagated, per this module's
  // "logging can never crash the Relay" contract.
  assert.doesNotThrow(() => {
    logServerStart('/etc/hosts/impossible-subdir', { port: 3000 });
  });
});

test('daily relay log retention removes files older than seven Taipei dates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-runtime-retention-'));
  await writeFile(join(directory, '2026-09-10.jsonl'), 'old\n');
  await writeFile(join(directory, '2026-09-17.jsonl'), 'keep\n');
  await purgeOldRelayLogs(directory, { now: new Date('2026-09-23T04:00:00Z'), retentionDays: DEFAULT_LOG_RETENTION_DAYS });
  await assert.rejects(readFile(join(directory, '2026-09-10.jsonl'), 'utf8'), (error) => error.code === 'ENOENT');
  assert.equal(await readFile(join(directory, '2026-09-17.jsonl'), 'utf8'), 'keep\n');
});
