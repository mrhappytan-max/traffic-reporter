import { appendFile, mkdir, open, readFile, readdir, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_LOG_RETENTION_DAYS = 7;

// Mirrors localMonitor.js's own PBS_LOCAL_INTERVAL_MS default (3 minutes).
// Kept as an independent constant here — rather than imported from
// localMonitor.js — to avoid a circular import between the two modules
// (localMonitor.js already imports from this file).
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;

// 路況-076/077: on 2026-09-21 LocalMonitor was terminated abnormally and
// never reached release()'s cleanup path, leaving data/local-monitor.lock
// behind with a PID that no longer belonged to the real process. Because
// acquireMonitorLock() only checked process.kill(pid, 0) — which merely
// confirms *some* process currently holds that PID, not that it is the
// original LocalMonitor — a later, unrelated process reusing the same PID
// number would be enough to make the stale lock look "alive" forever,
// permanently blocking every one-minute watchdog restart attempt. A lock
// whose heartbeat is older than this many polling intervals is now also
// treated as abandoned, even when its recorded PID still passes the
// liveness check.
export const DEFAULT_LOCK_STALE_MULTIPLIER = 5;

function taipeiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// PBS_LOCAL_INTERVAL_MS uses the same "Number(env || default)" pattern
// localMonitor.js's main() uses for the same env var, so an override
// there is picked up here too without the two modules importing from
// each other.
export function resolveStaleLockThresholdMs() {
  const intervalMs = Number(process.env.PBS_LOCAL_INTERVAL_MS) || DEFAULT_HEARTBEAT_INTERVAL_MS;
  return intervalMs * DEFAULT_LOCK_STALE_MULTIPLIER;
}

// Is the lock file's last-modified time older than the stale threshold?
// A lock nobody has touched in that long is treated as abandoned
// regardless of what isProcessRunning() says about its recorded PID.
async function isLockStale(path, { now = new Date(), staleAfterMs } = {}) {
  const stats = await stat(path);
  return now.getTime() - stats.mtimeMs > staleAfterMs;
}

// Call once per watch-loop round (success or failure alike — a failed PBS
// fetch still proves the process is alive and looping) so the lock's
// mtime reflects when its owning process was last known to be working,
// not just when it started. Never throws: a missed heartbeat should not
// crash the monitor, and if the lock file is already gone there is
// nothing to touch — acquireMonitorLock() will simply recreate it on the
// next round.
export async function touchMonitorLock(path, now = new Date()) {
  try {
    await utimes(path, now, now);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function acquireMonitorLock(path, {
  pid = process.pid, now = new Date(), processRunning = isProcessRunning,
  staleAfterMs = resolveStaleLockThresholdMs(),
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
      const alive = processRunning(existingPid);
      // A PID that still looks alive is not enough on its own — PID
      // numbers get reused once the original process is gone — so also
      // require a recent heartbeat before trusting the lock. If the lock
      // file vanishes between the readFile above and this stat() there is
      // nothing left to check; treat that race the same as "not alive".
      let stale = false;
      if (alive) {
        try {
          stale = await isLockStale(path, { now, staleAfterMs });
        } catch (statError) {
          if (statError?.code !== 'ENOENT') throw statError;
          stale = true;
        }
      }
      if (alive && !stale) {
        const duplicate = new Error(`PBS Local Monitor is already running with PID ${existingPid}`);
        duplicate.code = 'MONITOR_ALREADY_RUNNING';
        throw duplicate;
      }
      try {
        await unlink(path);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
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
