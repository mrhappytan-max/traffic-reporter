// GET /debug/status — read-only preview of the full pipeline (fetch TDX ->
// normalize -> Hsinchu filter -> read KV dedup state -> classify -> LINE
// broadcast eligibility preview). Deliberately incapable of writing:
//
//   - runTdxPipelinePreview never calls commitDedupeState.
//   - runLineBroadcast is called with dryRun=true, which never calls the
//     LINE API, never calls persistNotifiedState, and never persists a
//     subscriptions migration.
//
// Opening this URL any number of times cannot create the baseline, write
// KV, mark anything notified, or send a real LINE message. Only the
// scheduled handler (src/traffic/scheduled.js) does any of that.
//
// Never includes: TDX Client ID/Secret, LINE token/secret, or full LINE
// user/group IDs (targets are only ever surfaced as counts here).

import { runTdxPipelinePreview } from './pipeline.js';
import { runLineBroadcast } from './broadcastPipeline.js';
import { formatTaipeiTime } from './broadcastHours.js';
import { runPbsPipelinePreview } from '../pbs/pipeline.js';
import { PBS_BROADCAST_ENABLED } from '../pbs/pbsConfig.js';
import { getLastTdxTokenSource } from '../tdx/auth.js';

// Safety cap so a runaway source can't blow up the response payload.
const MAX_LISTED_EVENTS = 100;

export async function handleDebugStatus(env) {
  const now = new Date();
  const summary = await runTdxPipelinePreview(env);

  const newUpdatedKeys = new Set(
    [...summary.newEvents, ...summary.updatedEvents].map((e) => `${e.source}:${e.rawId}`)
  );

  const lineSummary = await runLineBroadcast(env, {
    allEvents: summary.allEvents,
    dedupeAvailable: summary.kvAvailable,
    newUpdatedKeys,
    dedupeMapSnapshot: summary.dedupeMapSnapshot,
    prunedKeys: summary.prunedKeys,
    now,
    dryRun: true,
  });

  // PBS: fully separate, read-only preview (never writes KV, never
  // touches LINE). tdxEvents is passed only so cross-source dedup counts
  // are meaningful — PBS_BROADCAST_ENABLED stays false regardless.
  const pbsSummary = await runPbsPipelinePreview(env, { tdxEvents: summary.allEvents, now });

  const body = {
    lastRunAt: summary.lastRunAt,
    currentTaipeiTime: formatTaipeiTime(now),
    tokenOk: summary.tokenOk,
    // Diagnostic only, V1.2C.1 — which tier served the token this request
    // (see src/tdx/auth.js). Never the token itself.
    tdxTokenCache: getLastTdxTokenSource(),
    baselineInitialized: summary.baselineInitialized,
    kvAvailable: summary.kvAvailable,
    kvError: summary.kvError,
    sourceHealth: summary.sourceHealth,
    rawCounts: summary.rawCounts,
    normalizedCount: summary.normalizedCount,
    hsinchuFilteredCount: summary.hsinchuFilteredCount,
    newEventsCount: summary.newEventsCount,
    updatedEventsCount: summary.updatedEventsCount,
    duplicateCount: summary.duplicateCount,
    pushableEventsCount: summary.pushableEventsCount,
    baselineSeedCount: summary.baselineSeedCount,
    missingKeysCount: summary.missingKeysCount,
    failedSources: summary.failedSources,
    errors: summary.errors,
    sources: summary.sources,
    sample: summary.sample,
    pending: summary.pending.slice(0, MAX_LISTED_EVENTS),

    // LINE broadcast readiness preview — all read-only, see above. Only
    // counts, never raw userId/groupId values.
    withinBroadcastHours: lineSummary.withinBroadcastHours,
    enabledUsersCount: lineSummary.enabledUsersCount,
    enabledGroupsCount: lineSummary.enabledGroupsCount,
    subscriptionsCount: lineSummary.subscriptionsCount,
    notifiedEventCount: lineSummary.notifiedEventCount,
    broadcastRelevantCount: lineSummary.broadcastRelevantCount,
    activeNowCount: lineSummary.activeNowCount,
    futureWithin60MinCount: lineSummary.futureWithin60MinCount,
    pendingTargetCount: lineSummary.pendingTargetCount,
    partialPushFailures: lineSummary.partialPushFailures,
    lineReady: lineSummary.lineReady,
    lastLinePushAt: lineSummary.lastLinePushAt,
    lineErrors: lineSummary.lineErrors,

    // PBS — observation-only this round (see pbsConfig.js).
    pbsOk: pbsSummary.pbsOk,
    pbsRawCount: pbsSummary.rawCount,
    pbsHsinchuCount: pbsSummary.hsinchuCount,
    pbsActiveCount: pbsSummary.activeCount,
    pbsClearedCount: pbsSummary.clearedCount,
    pbsStaleCount: pbsSummary.staleCount,
    pbsFilteredCount: pbsSummary.filteredCount,
    crossSourceDuplicateCount: pbsSummary.crossSourceDuplicateCount,
    canonicalEventCount: pbsSummary.canonicalEventCount,
    pbsBroadcastEnabled: PBS_BROADCAST_ENABLED,
  };

  return Response.json(body, { status: summary.tokenOk ? 200 : 502 });
}
