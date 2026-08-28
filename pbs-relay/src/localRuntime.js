import { appendFile, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_LOG_RETENTION_DAYS = 7;

function taipeiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function acquireMonitorLock(path, {
  pid = process.pid, now = new Date(), processRunning = isProcessRunning,
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tryAcquire = async () => {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid, startedAt: now.toISOString() })}\n`, 'utf8');
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await handle.close();
          try {
            const current = JSON.parse(await readFile(path, 'utf8'));
            if (current.pid === pid) await unlink(path);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existingPid = null;
      try { existingPid = JSON.parse(await readFile(path, 'utf8')).pid; } catch { /* stale malformed lock */ }
      if (processRunning(existingPid)) {
        const duplicate = new Error(`PBS Local Monitor is already running with PID ${existingPid}`);
        duplicate.code = 'MONITOR_ALREADY_RUNNING';
        throw duplicate;
      }
      await unlink(path);
      return tryAcquire();
    }
  };
  return tryAcquire();
}

export async function purgeOldOperationalLogs(logDirectory, {
  now = new Date(), retentionDays = DEFAULT_LOG_RETENTION_DAYS,
} = {}) {
  await mkdir(logDirectory, { recursive: true });
  const cutoff = new Date(now.getTime() - (retentionDays - 1) * 24 * 60 * 60 * 1000);
  const cutoffDate = taipeiDate(cutoff);
  for (const entry of await readdir(logDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
    if (entry.name.slice(0, 10) < cutoffDate) await unlink(join(logDirectory, entry.name));
  }
}

function baseRecord(now) {
  return { timestamp: now.toISOString(), taipeiDate: taipeiDate(now) };
}

export async function writeSuccessLog(logDirectory, summary, now = new Date()) {
  await purgeOldOperationalLogs(logDirectory, { now });
  const counts = summary.counts || {};
  const record = {
    ...baseRecord(now), fetchResult: 'PASS', rawRecords: summary.rawCount,
    relevantRecords: summary.relevantAccidentCount, activeEvents: summary.activeEventCount,
    NEW: counts.NEW || 0, UPDATED: counts.UPDATED || 0, CLEARED: counts.CLEARED || 0,
    MISSING_PENDING_CLEAR: counts.MISSING_PENDING_CLEAR || 0, UNCHANGED: counts.UNCHANGED || 0,
    SHOULD_PUSH: summary.shouldPush ? 'YES' : 'NO', durationMs: summary.durationMs,
    debugPushEnabled: summary.debugPush?.debugPushEnabled || false,
    debugPushAttemptedCount: summary.debugPush?.debugPushAttemptedCount || 0,
    debugPushAcceptedCount: summary.debugPush?.debugPushAcceptedCount || 0,
    debugPushDuplicateCount: summary.debugPush?.debugPushDuplicateCount || 0,
    debugPushFailedCount: summary.debugPush?.debugPushFailedCount || 0,
  };
  await appendFile(join(logDirectory, `${record.taipeiDate}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function writeFailureLog(logDirectory, error, now = new Date()) {
  await purgeOldOperationalLogs(logDirectory, { now });
  const record = {
    ...baseRecord(now), fetchResult: 'FAIL',
    errorClassification: error?.code || error?.name || 'unknown', SHOULD_PUSH: 'NO',
  };
  await appendFile(join(logDirectory, `${record.taipeiDate}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function writeDebugPushLog(logDirectory, result, now = new Date()) {
  await purgeOldOperationalLogs(logDirectory, { now });
  const record = {
    ...baseRecord(now), debugPushAttempted: true,
    debugPushResult: result.debugPushResult,
    httpStatus: result.httpStatus ?? null,
    requestId: result.requestId,
    eventId: result.eventId,
    lifecycle: result.lifecycle,
    accepted: result.accepted === true,
    duplicate: result.duplicate === true,
    durationMs: result.durationMs,
    attempts: result.attempts,
  };
  await appendFile(join(logDirectory, `${record.taipeiDate}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}
