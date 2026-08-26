import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchPbsUpstream } from './upstreamClient.js';
import { compareWithPreviousState, filterRelevantAccidents, parsePbsPayload } from './localPrototype.js';
import { readLocalState, writeLocalState } from './localState.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_PATH = resolve(moduleDirectory, '..', 'data', 'relevant-state.json');

export async function runLocalMonitor({
  fetchImpl = globalThis.fetch,
  statePath = process.env.PBS_LOCAL_STATE_PATH || DEFAULT_STATE_PATH,
  now = new Date(),
} = {}) {
  const { rawText, attempts, durationMs } = await fetchPbsUpstream({ fetchImpl, requestId: `local-${now.getTime()}` });
  const rawItems = parsePbsPayload(rawText);
  const relevantAccidents = filterRelevantAccidents(rawItems);
  const previousState = await readLocalState(statePath);
  const comparison = compareWithPreviousState(relevantAccidents, previousState, now);
  await writeLocalState(statePath, comparison.state);

  return {
    source: 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata',
    statePath,
    fetchedAt: now.toISOString(),
    attempts,
    durationMs,
    rawCount: rawItems.length,
    relevantAccidentCount: relevantAccidents.length,
    baseline: comparison.baseline,
    counts: Object.fromEntries(Object.entries(comparison.changes).map(([key, value]) => [key, value.length])),
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

  do {
    try {
      printSummary(await runLocalMonitor());
    } catch (error) {
      console.error(`[PBS local prototype] ${error.message}`);
      console.log('SHOULD_PUSH=NO');
      if (!watch) process.exitCode = 1;
    }
    if (watch) await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  } while (watch);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) await main();
