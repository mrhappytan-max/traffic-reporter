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
import { mergeForBroadcast } from '../pbs/crossSourceDedup.js';
import { PBS_BROADCAST_ENABLED } from '../pbs/pbsConfig.js';
import { getLastTdxTokenSource } from '../tdx/auth.js';
import { applyCongestionSeverityValidation } from './congestionValidation.js';

// Safety cap so a runaway source can't blow up the response payload.
const MAX_LISTED_EVENTS = 100;

export async function handleDebugStatus(env) {
  const now = new Date();
  const summary = await runTdxPipelinePreview(env);

  const newUpdatedKeys = new Set(
    [...summary.newEvents, ...summary.updatedEvents].map((e) => `${e.source}:${e.rawId}`)
  );

  // PBS: fully separate, read-only preview (never writes KV, never calls
  // LINE — runLineBroadcast below is always called with dryRun=true
  // regardless of what's in `broadcastEvents`). Computed BEFORE the LINE
  // preview so its cross-source dedup result can be folded in exactly the
  // way the real Cron run (scheduled.js) does, keeping this preview
  // truthful about what would actually be pushed.
  const pbsSummary = await runPbsPipelinePreview(env, { tdxEvents: summary.allEvents, now });

  const mergedEvents = PBS_BROADCAST_ENABLED
    ? mergeForBroadcast(summary.allEvents, pbsSummary.canonicalEvents || [], pbsSummary.uniquePbsEvents || [])
    : summary.allEvents;

  // Same lazy/fail-safe congestion-severity confirmation as the real
  // Cron run (see scheduled.js/congestionValidation.js) — still entirely
  // read-only (only ever reads TDX VD data, changes nothing in KV).
  let broadcastEvents = mergedEvents;
  try {
    broadcastEvents = await applyCongestionSeverityValidation(mergedEvents, env);
  } catch {
    // Preview only — leave severity unchanged, same as scheduled.js.
  }

  const lineSummary = await runLineBroadcast(env, {
    allEvents: broadcastEvents,
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
    // V1.5: how many merged events this run were excluded by the
    // whitelist/keyword eligibility gate (see broadcastRules.js) before
    // ever reaching relevance/pending-target computation, and WHY
    // (congestion-excluded / alert-excluded / construction-no-impact-
    // keyword / other-no-anomaly-keyword / unrecognized-type) — proof
    // that every excluded event is still fully collected/classified,
    // just never pushed.
    typeIneligibleCount: lineSummary.typeIneligibleCount,
    ineligibleByReason: lineSummary.ineligibleByReason,
    // V1.5.1: accident-specific incident-level suppression (see
    // incidentSuppression.js) — how many accident events this run were
    // the SAME real incident as one already notified with no material
    // change (never pushed, broken down by reason), and how many were
    // allowed through specifically because something actually escalated
    // (closure/control upgrade, more lanes blocked, a new closure/
    // impassable signal).
    incidentSuppressedCount: lineSummary.incidentSuppressedCount,
    incidentSuppressedByReason: lineSummary.incidentSuppressedByReason,
    materialRebroadcastCount: lineSummary.materialRebroadcastCount,
    broadcastRelevantCount: lineSummary.broadcastRelevantCount,
    activeNowCount: lineSummary.activeNowCount,
    futureWithin60MinCount: lineSummary.futureWithin60MinCount,
    pendingTargetCount: lineSummary.pendingTargetCount,
    partialPushFailures: lineSummary.partialPushFailures,
    lineReady: lineSummary.lineReady,
    lastLinePushAt: lineSummary.lastLinePushAt,
    lineErrors: lineSummary.lineErrors,

    // PBS — its own read-only stats; whether it's actually folded into
    // the `broadcastRelevantCount`/`pendingTargetCount`/etc. LINE fields
    // above depends on PBS_BROADCAST_ENABLED (see pbsConfig.js).
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

  // Response.json()'s Content-Type header behavior across runtimes isn't
  // guaranteed to honor a custom charset override, and mobile browsers
  // opening this URL directly (no explicit charset) were mis-rendering
  // the Chinese text as mojibake — so this is spelled out explicitly via
  // a plain Response instead, which is unambiguous everywhere.
  return new Response(JSON.stringify(body, null, 2), {
    status: summary.tokenOk ? 200 : 502,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
