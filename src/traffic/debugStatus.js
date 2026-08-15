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

  const body = {
    lastRunAt: summary.lastRunAt,
    currentTaipeiTime: formatTaipeiTime(now),
    tokenOk: summary.tokenOk,
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
  };

  return Response.json(body, { status: summary.tokenOk ? 200 : 502 });
}
