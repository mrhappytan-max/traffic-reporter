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
import { runPbsPipelineAndCommit } from '../pbs/pipeline.js';
import { runSharedFeedPersist } from './sharedFeed.js';

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

  // PBS runs as a fully separate step: its own KV key
  // (pbs:lifecycle-state), its own fetch, its own failure isolation. It
  // is NOT included in `allEvents` passed to runLineBroadcast above — PBS
  // never reaches the LINE push pipeline this round (PBS_BROADCAST_ENABLED
  // = false, see pbsConfig.js). tdxEvents is passed only for cross-source
  // dedup observability (canonical event matching), not for anything
  // that gets sent anywhere.
  let pbsSummary;
  try {
    pbsSummary = await runPbsPipelineAndCommit(env, { tdxEvents: summary.allEvents, now });
    console.log(
      `[cron][pbs] pbsOk=${pbsSummary.pbsOk} pbsError=${pbsSummary.pbsError ?? 'none'} ` +
        `kvAvailable=${pbsSummary.kvAvailable} committed=${pbsSummary.committed} ` +
        `raw=${pbsSummary.rawCount} hsinchu=${pbsSummary.hsinchuCount} active=${pbsSummary.activeCount} ` +
        `cleared=${pbsSummary.clearedCount} stale=${pbsSummary.staleCount} filtered=${pbsSummary.filteredCount} ` +
        `crossSourceDuplicates=${pbsSummary.crossSourceDuplicateCount} canonical=${pbsSummary.canonicalEventCount}`
    );
  } catch (err) {
    // Belt-and-suspenders: PBS must never be able to take down the Cron
    // run even if something in this brand-new pipeline throws
    // unexpectedly — TDX + LINE above have already completed by now.
    console.error(`[cron][pbs] pipeline failed: ${err && err.message}`);
    pbsSummary = { pbsOk: false, pbsError: err && err.message };
  }

  // V57: persist the completed products (the same finished LINE text this
  // Worker just broadcast) so another project can consume them read-only —
  // see src/traffic/sharedFeed.js.
  //
  // Deliberately the LAST step, in its own try/catch, and consuming only
  // `summary.allEvents` which is already in memory: it fetches nothing, and
  // this Worker's own TDX pipeline and LINE broadcast have both fully
  // completed before it starts. A failure here can therefore never reduce
  // or delay this Worker's own broadcast — it is log-only, best effort.
  let sharedFeedSummary;
  try {
    sharedFeedSummary = await runSharedFeedPersist(env, { allEvents: summary.allEvents, now });
    console.log(
      `[cron][shared-feed] committed=${sharedFeedSummary.committed} ` +
        `events=${sharedFeedSummary.eventCount} error=${sharedFeedSummary.error ?? 'none'}`
    );
  } catch (err) {
    console.error(`[cron][shared-feed] persistence failed: ${err && err.message}`);
    sharedFeedSummary = { committed: false, error: err && err.message, eventCount: 0 };
  }

  return { ...summary, line: lineSummary, pbs: pbsSummary, sharedFeed: sharedFeedSummary };
}
