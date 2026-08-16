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
import { mergeForBroadcast } from '../pbs/crossSourceDedup.js';
import { PBS_BROADCAST_ENABLED } from '../pbs/pbsConfig.js';

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

  // PBS runs BEFORE the LINE broadcast now (V1.4: PBS+TDX merge, Alpha),
  // so its cross-source dedup result can be folded into what actually
  // gets pushed below. Still fully isolated: its own KV key
  // (pbs:lifecycle-state), its own fetch — and critically, its own
  // try/catch here, so a PBS failure can NEVER prevent or reduce TDX's
  // own broadcast (see the mergeForBroadcast call below, and requirement
  // "PBS 掛掉時 TDX 必須繼續正常播報").
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
    // run even if something in this pipeline throws unexpectedly.
    console.error(`[cron][pbs] pipeline failed: ${err && err.message}`);
    pbsSummary = { pbsOk: false, pbsError: err && err.message, canonicalEvents: [], uniquePbsEvents: [] };
  }

  // V1.4 Alpha: fold PBS's cross-source dedup result into what gets
  // broadcast — same real incident reported by both TDX and an active PBS
  // event becomes exactly one canonical message; an active PBS event with
  // no TDX match is its own message; cleared/stale PBS events never reach
  // here at all (pipeline.js's crossSourceDedup only ever sees
  // `activeEvents`). Gated on PBS_BROADCAST_ENABLED (pbsConfig.js) — when
  // false, or when PBS's own pipeline failed above (empty arrays),
  // mergeForBroadcast returns `summary.allEvents` completely unchanged,
  // so this is byte-for-byte the pre-V1.4 TDX-only behavior either way.
  const broadcastEvents = PBS_BROADCAST_ENABLED
    ? mergeForBroadcast(summary.allEvents, pbsSummary.canonicalEvents || [], pbsSummary.uniquePbsEvents || [])
    : summary.allEvents;

  const lineSummary = await runLineBroadcast(env, {
    allEvents: broadcastEvents,
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

  return { ...summary, line: lineSummary, pbs: pbsSummary };
}
