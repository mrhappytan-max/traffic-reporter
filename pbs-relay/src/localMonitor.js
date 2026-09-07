import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchPbsUpstream } from './upstreamClient.js';
import { compareWithPreviousState, filterRelevantPbsEvents, parsePbsPayload } from './localPrototype.js';
import { readLocalState, writeLocalState } from './localState.js';
import { acquireMonitorLock, writeFailureLog, writeSuccessLog } from './localRuntime.js';
import { dispatchDebugChanges, isDebugPushEnabled } from './localDebugPush.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_PATH = resolve(moduleDirectory, '..', 'data', 'relevant-state.json');
export const DEFAULT_LOCK_PATH = resolve(moduleDirectory, '..', 'data', 'local-monitor.lock');
export const DEFAULT_LOG_DIRECTORY = resolve(moduleDirectory, '..', 'logs');

export async function runLocalMonitor({
  fetchImpl = globalThis.fetch,
  statePath = process.env.PBS_LOCAL_STATE_PATH || DEFAULT_STATE_PATH,
  now = new Date(),
} = {}) {
  const { rawText, attempts, durationMs } = await fetchPbsUpstream({ fetchImpl, requestId: `local-${now.getTime()}` });
  const rawItems = parsePbsPayload(rawText);
  const relevantEvents = filterRelevantPbsEvents(rawItems);
  const previousState = await readLocalState(statePath);
  const comparison = compareWithPreviousState(relevantEvents, previousState, now);
  await writeLocalState(statePath, comparison.state);

  return {
    source: 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata',
    statePath,
    fetchedAt: now.toISOString(),
    attempts,
    durationMs,
    rawCount: rawItems.length,
    relevantAccidentCount: relevantEvents.length,
    activeEventCount: relevantEvents.filter((event) => !event.cleared).length,
    baseline: comparison.baseline,
    counts: Object.fromEntries(Object.entries(comparison.changes).map(([key, value]) => [key, value.length])),
    pendingMissingEvents: comparison.changes.MISSING_PENDING_CLEAR.length,
    changes: comparison.changes,
    shouldPush: comparison.shouldPush,
  };
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
  console.log(`SHOULD_PUSH=${summary.shouldPush ? 'YES' : 'NO'}`);
}

async function main() {
  const watch = process.argv.includes('--watch');
  const intervalMs = Number(process.env.PBS_LOCAL_INTERVAL_MS || 3 * 60 * 1000);
  if (watch && (!Number.isFinite(intervalMs) || intervalMs < 10_000)) {
    throw new Error('PBS_LOCAL_INTERVAL_MS must be at least 10000 in watch mode');
  }

  const lockPath = process.env.PBS_LOCAL_LOCK_PATH || DEFAULT_LOCK_PATH;
  const logDirectory = process.env.PBS_LOCAL_LOG_DIRECTORY || DEFAULT_LOG_DIRECTORY;
  let lock;
  try {
    lock = await acquireMonitorLock(lockPath);
    do {
      const roundTime = new Date();
      try {
        const summary = await runLocalMonitor({ now: roundTime });
        summary.debugPush = await dispatchDebugChanges(summary, {
          enabled: isDebugPushEnabled(), logDirectory,
        });
        await writeSuccessLog(logDirectory, summary, roundTime);
        printSummary(summary);
      } catch (error) {
        await writeFailureLog(logDirectory, error, roundTime);
        console.error(`[PBS local prototype] ${error?.code || error?.name || 'unknown'}`);
        console.log('SHOULD_PUSH=NO');
        if (!watch) process.exitCode = 1;
      }
      if (watch) await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    } while (watch);
  } catch (error) {
    console.error(`[PBS local prototype] ${error?.code || error?.name || 'startup-failed'}`);
    process.exitCode = 1;
  } finally {
    if (lock) await lock.release();
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) await main();
