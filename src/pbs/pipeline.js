// Full PBS pipeline: fetch -> normalize -> classify -> Hsinchu filter ->
// lifecycle (active/cleared/stale) -> cross-source dedup against this
// run's TDX events. Mirrors the TDX pipeline's preview/commit split:
//
//   - runPbsPipelinePreview: read-only, used by GET /debug/status and
//     GET /debug/pbs. Never calls commitPbsLifecycleState.
//   - runPbsPipelineAndCommit: used by the Cron scheduled handler.
//
// A PBS fetch/parse failure never throws out of this module and never
// affects the TDX pipeline — see client.js/PbsFetchError.
//
// PBS_BROADCAST_ENABLED (pbsConfig.js) is false this round: callers
// (scheduled.js/debugStatus.js) simply never pass PBS events into
// runLineBroadcast — this module doesn't need to know about LINE at all.

import { fetchPbsData } from './client.js';
import { normalizePbsEvent } from './normalize.js';
import { isPbsEventHsinchuRelevant } from './hsinchuFilter.js';
import { readPbsLifecycleState, classifyPbsLifecycle, commitPbsLifecycleState } from './lifecycle.js';
import { crossSourceDedup } from './crossSourceDedup.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

async function runPbsCore(env, now) {
  let rawItems = [];
  let pbsOk = true;
  let pbsError = null;

  try {
    rawItems = await fetchPbsData();
  } catch (err) {
    pbsOk = false;
    pbsError = safeErrorMessage(err);
  }

  const normalized = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue; // skip malformed records
    try {
      normalized.push(normalizePbsEvent(raw));
    } catch {
      // one bad record shouldn't drop the whole feed
    }
  }

  const hsinchuFiltered = normalized.filter(isPbsEventHsinchuRelevant);
  const { clearedEvents, staleEvents, activeEvents, seenIds } = classifyPbsLifecycle(hsinchuFiltered, now);
  const lifecycleState = await readPbsLifecycleState(env.TRAFFIC_KV); // read-only, always

  return { rawItems, normalized, hsinchuFiltered, clearedEvents, staleEvents, activeEvents, seenIds, pbsOk, pbsError, lifecycleState };
}

function buildSummary(core, tdxEvents, commitResult) {
  const { rawItems, hsinchuFiltered, clearedEvents, staleEvents, activeEvents, pbsOk, pbsError, lifecycleState } = core;
  const { canonicalEvents, duplicatePbsEvents, uniquePbsEvents } = crossSourceDedup(activeEvents, tdxEvents);

  return {
    pbsOk,
    pbsError,
    kvAvailable: lifecycleState.kvAvailable,
    kvError: lifecycleState.kvError,
    committed: Boolean(commitResult && commitResult.committed),
    commitReason: commitResult ? commitResult.reason || null : null,
    rawCount: rawItems.length,
    hsinchuCount: hsinchuFiltered.length,
    activeCount: activeEvents.length,
    clearedCount: clearedEvents.length,
    staleCount: staleEvents.length,
    // Final, post-cross-source-dedup count of PBS events that add unique
    // information (not already represented by a matching TDX event).
    filteredCount: uniquePbsEvents.length,
    crossSourceDuplicateCount: duplicatePbsEvents.length,
    canonicalEventCount: canonicalEvents.length,
    canonicalEvents,
    uniquePbsEvents,
    activeEvents,
    rawSample: rawItems.slice(0, 2),
    normalizedSample: hsinchuFiltered.slice(0, 3),
    clearedSample: clearedEvents.slice(0, 2),
    staleSample: staleEvents.slice(0, 2),
    crossSourceSample: canonicalEvents.slice(0, 2),
  };
}

/** Read-only preview — GET /debug/status, GET /debug/pbs. Never writes to KV. */
export async function runPbsPipelinePreview(env, { tdxEvents = [], now = new Date() } = {}) {
  const core = await runPbsCore(env, now);
  return buildSummary(core, tdxEvents, null);
}

/** Cron path — reads, classifies, and commits PBS lifecycle state if possible. */
export async function runPbsPipelineAndCommit(env, { tdxEvents = [], now = new Date() } = {}) {
  const core = await runPbsCore(env, now);

  let commitResult = { committed: false, reason: 'kv-unavailable' };
  if (core.lifecycleState.kvAvailable) {
    commitResult = await commitPbsLifecycleState(
      env.TRAFFIC_KV,
      core.lifecycleState.pbsMap,
      { clearedEvents: core.clearedEvents, activeEvents: core.activeEvents, seenIds: core.seenIds },
      core.pbsOk,
      now
    );
  }

  return buildSummary(core, tdxEvents, commitResult);
}
