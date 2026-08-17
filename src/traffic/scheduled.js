// Cron entry point (every 10 minutes, see wrangler.jsonc `triggers.crons`).
// This is the ONLY code path allowed to establish the baseline, write KV
// dedup state, mark events notified, or actually call the LINE push API —
// see runTdxPipelineAndCommit (pipeline.js) and runLineBroadcast
// (broadcastPipeline.js), both of which have read-only counterparts used
// by GET /debug/status.
//
// V1.6.1 — "資料來源與 TDX 用量瘦身": PBS still runs every tick, 24/7.
// TDX (國道+省道 only, see ../tdx/sources.js's PRODUCTION_TDX_SOURCE_IDS)
// is now only fetched every 2nd tick (minute 00/20/40), and only
// 08:00–21:59:59 Asia/Taipei — see tdxSchedule.js. A tick that doesn't
// fetch TDX still runs PBS + the LINE broadcast step normally (PBS-only
// broadcasts must never be blocked just because TDX itself sat this tick
// out) — only the TDX-specific portion of the pipeline is skipped.
//
// `now` defaults to the real clock; tests pass an explicit Date.

import { runTdxPipelineAndCommit } from './pipeline.js';
import { runLineBroadcast } from './broadcastPipeline.js';
import { runPbsPipelineAndCommit } from '../pbs/pipeline.js';
import { mergeForBroadcast } from '../pbs/crossSourceDedup.js';
import { PBS_BROADCAST_ENABLED } from '../pbs/pbsConfig.js';
import { buildHealthSnapshot, persistHealthSnapshot, readHealthSnapshot } from './healthSnapshot.js';
import { getTdxScheduleState } from './tdxSchedule.js';
import { readDedupeState } from './dedupe.js';
import { PRODUCTION_TDX_SOURCE_IDS } from '../tdx/sources.js';

/**
 * Shape-compatible with pipeline.js's buildSummary() output (every field
 * every downstream consumer here reads), but for a tick that made ZERO
 * TDX calls: no fetch, no dedupe read/classify/commit for TDX events at
 * all — a genuinely absent fetch must never be misread as "0 events
 * found this run" (which would incorrectly start the missing-event
 * absence clock in dedupe.js). The one KV read below is ONLY so
 * `kvAvailable` is accurate for the LINE broadcast step further down —
 * PBS-only broadcasts must not fail closed just because TDX sat this
 * tick out.
 */
async function buildSkippedTdxSummary(env, now) {
  const dedupeState = await readDedupeState(env.TRAFFIC_KV);
  return {
    lastRunAt: now.toISOString(),
    tokenOk: null,
    baselineInitialized: dedupeState.baselineInitialized,
    kvAvailable: dedupeState.kvAvailable,
    kvError: dedupeState.kvError,
    sourceHealth: {},
    rawCounts: {},
    normalizedCount: 0,
    hsinchuFilteredCount: 0,
    newEventsCount: 0,
    updatedEventsCount: 0,
    duplicateCount: 0,
    pushableEventsCount: 0,
    baselineSeedCount: 0,
    missingKeysCount: 0,
    failedSources: [],
    errors: [],
    sources: [],
    sample: { new: [], updated: [], duplicate: [] },
    pending: [],
    allEvents: [],
    newEvents: [],
    updatedEvents: [],
    duplicateEvents: [],
    dedupeMapSnapshot: dedupeState.dedupeMap,
    prunedKeys: [],
  };
}

export async function runScheduledTdxSync(env, now = new Date()) {
  const tdxScheduleState = getTdxScheduleState(now); // 'scheduled' | 'skipped-by-schedule' | 'night-sleep'

  const summary =
    tdxScheduleState === 'scheduled'
      ? await runTdxPipelineAndCommit(env, now, { sourceIds: PRODUCTION_TDX_SOURCE_IDS })
      : await buildSkippedTdxSummary(env, now);

  console.log(
    `[cron] tdxScheduleState=${tdxScheduleState} tokenOk=${summary.tokenOk} baselineInitialized=${summary.baselineInitialized} ` +
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
  // "PBS 掛掉時 TDX 必須繼續正常播報"). Unconditional — PBS runs every
  // tick, 24/7, regardless of tdxScheduleState.
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
  // On a tick that skipped TDX, `summary.allEvents` is simply empty, so
  // this run's broadcast candidates are PBS-only — exactly as intended.
  const broadcastEvents = PBS_BROADCAST_ENABLED
    ? mergeForBroadcast(summary.allEvents, pbsSummary.canonicalEvents || [], pbsSummary.uniquePbsEvents || [])
    : summary.allEvents;

  // V1.6.1: congestion severity validation (an extra TDX VD API call) has
  // been removed from this Cron path entirely — V1.5 already excludes
  // EVERY congestion event from broadcast regardless of severity (see
  // broadcastRules.js's NEVER_ELIGIBLE_TYPES), so confirming/upgrading a
  // congestion event's severity here served no production purpose
  // anymore ("VD 不再具有正式播報用途，不得再因 congestion 額外呼叫任何
  // VD API"). congestionValidation.js/vdSpeed.js are left intact and
  // still exercised by their own unit tests, and GET /debug/status keeps
  // its own read-only preview of this exact same confirmation step
  // unchanged (diagnostic-only, never scheduled).

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

  // V1.6: write a compact health snapshot for GET /health, using ONLY
  // what this run already computed above — no extra TDX/PBS/LINE calls.
  // V1.6.1: also reads the PREVIOUS snapshot first (one extra read-only
  // KV read) so buildHealthSnapshot can carry the `tdx` block forward
  // unchanged on a tick that skipped/slept — see healthSnapshot.js.
  // Own try/catch: a bug here must never break the Cron run itself, same
  // isolation principle as the PBS step above. If this write itself
  // fails, the snapshot already in KV just keeps aging — /health's own
  // staleness check (see health.js) is what correctly surfaces that as
  // critical, no separate "write failed" flag needed here.
  try {
    const previous = await readHealthSnapshot(env.TRAFFIC_KV);
    const healthSnapshot = buildHealthSnapshot({
      summary,
      pbsSummary,
      lineSummary,
      now,
      tdxScheduleState,
      previousTdx: previous.snapshot ? previous.snapshot.tdx : null,
    });
    const commit = await persistHealthSnapshot(env.TRAFFIC_KV, healthSnapshot);
    if (!commit.committed) console.error(`[cron][health] snapshot write failed: ${commit.reason} ${commit.error ?? ''}`);
  } catch (err) {
    console.error(`[cron][health] snapshot build/write failed: ${err && err.message}`);
  }

  return { ...summary, line: lineSummary, pbs: pbsSummary };
}
