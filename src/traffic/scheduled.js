// Cron entry point (every 5 minutes, see wrangler.jsonc `triggers.crons`).
// This is the ONLY code path allowed to establish the baseline, write KV
// dedup state, mark events notified, or actually call the LINE push API —
// see runTdxPipelineAndCommit (pipeline.js) and runLineBroadcast
// (broadcastPipeline.js), both of which have read-only counterparts used
// by GET /debug/status.
//
// `now` defaults to the real clock; tests pass an explicit Date.

import { runTdxPipelineAndCommit } from './pipeline.js';
import { runLineBroadcast } from './broadcastPipeline.js';

export async function runScheduledTdxSync(env, now = new Date()) {
  const summary = await runTdxPipelineAndCommit(env, now);

  console.log(
    `[cron] tokenOk=${summary.tokenOk} baselineInitialized=${summary.baselineInitialized} ` +
      `kvAvailable=${summary.kvAvailable} kvError=${summary.kvError ?? 'none'} ` +
      `raw=${JSON.stringify(summary.rawCounts)} normalized=${summary.normalizedCount} ` +
      `hsinchuFiltered=${summary.hsinchuFilteredCount} new=${summary.newEventsCount} ` +
      `updated=${summary.updatedEventsCount} duplicate=${summary.duplicateCount} ` +
      `pushable=${summary.pushableEventsCount} baselineSeed=${summary.baselineSeedCount} ` +
      `failedSources=${summary.failedSources.map((f) => f.source).join(',') || 'none'}`
  );

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
    dryRun: false,
  });

  console.log(
    `[cron][line] withinHours=${lineSummary.withinBroadcastHours} ready=${lineSummary.lineReady} ` +
      `enabledUsers=${lineSummary.enabledUsersCount} enabledGroups=${lineSummary.enabledGroupsCount} ` +
      `relevant=${lineSummary.broadcastRelevantCount} activeNow=${lineSummary.activeNowCount} ` +
      `future60=${lineSummary.futureWithin60MinCount} pendingTargets=${lineSummary.pendingTargetCount} ` +
      `pushed=${lineSummary.pushSucceeded}/${lineSummary.pushAttempted} ` +
      `partialFailures=${lineSummary.partialPushFailures} ` +
      `errors=${lineSummary.lineErrors.length ? lineSummary.lineErrors.join('; ') : 'none'}`
  );

  return { ...summary, line: lineSummary };
}
