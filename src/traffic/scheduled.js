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
import { isTdxRuntimeEnabled, describeSourceMode } from './sourceMode.js';
import { resolveLinePushPolicy } from './broadcastPolicy.js';
import { readDedupeState } from './dedupe.js';
import { PRODUCTION_TDX_SOURCE_IDS } from '../tdx/sources.js';
import { persistProductionTdxEventCache, readProductionTdxEventCache } from './tdxEventCache.js';
import { commitTdxUsageBatch, compactTdxUsageSummaryRecentDays } from '../tdx/usageLedger.js';
import { runSharedFeedPersist, readSharedFeed } from './sharedFeed.js';
import { buildTraceEntry, persistPipelineTraceEntries } from './pipelineTrace.js';

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
  // TDX QUOTA PROTECTION (2026-08-23): when TRAFFIC_SOURCE_MODE=PBS_ONLY
  // this tick must make ZERO TDX API calls. Rather than invent a second
  // "don't fetch" path, we reuse the one this Worker has always had for a
  // skipped tick — buildSkippedTdxSummary() below — and simply never
  // reach the 'scheduled' branch. That path is already proven in
  // production every PBS-only tick, and every downstream consumer
  // (health, usage ledger, PBS cross-source dedup) already handles it.
  //
  // The state is reported as its own value, not reused as
  // 'skipped-by-schedule', so nobody reads a deliberate quota pause as
  // either a TDX failure or a routine odd-minute tick.
  const tdxEnabled = isTdxRuntimeEnabled(env);
  const tdxScheduleState = tdxEnabled ? getTdxScheduleState(now) : 'disabled-quota';

  // V1.8.6 — TDX usage ledger: a fresh, request-scoped array only this
  // tick writes into (see usageLedger.js's module comment for why a
  // plain in-memory array threaded through fetchAllSources' Promise.all
  // needs no lock). Stays empty on a skipped/sleeping tick — 0 TDX calls
  // were attempted, so there is nothing to record, and the batch commit
  // below is a no-op for an empty array (commitTdxUsageBatch itself
  // checks records.length).
  const tdxUsageSink = [];

  const summary =
    tdxScheduleState === 'scheduled'
      ? await runTdxPipelineAndCommit(env, now, { sourceIds: PRODUCTION_TDX_SOURCE_IDS, usageSink: tdxUsageSink })
      : await buildSkippedTdxSummary(env, now);

  const sourceMode = describeSourceMode(env);
  const pushPolicy = resolveLinePushPolicy(env);
  console.log(
    `[cron][source-mode] trafficSourceMode=${sourceMode.trafficSourceMode} ` +
      `tdxRuntimeEnabled=${sourceMode.tdxRuntimeEnabled} ` +
      `cctvImageEnabled=${sourceMode.cctvImageEnabled} ` +
      `tdxCctvMetadataRefreshEnabled=${sourceMode.tdxCctvMetadataRefreshEnabled} ` +
      `pbsEnabled=${sourceMode.pbsEnabled} ` +
      `linePushPolicy=${pushPolicy} dynamicShoulderPush=${pushPolicy === 'ALL_ELIGIBLE' ? 'ON' : 'OFF'}` +
      `${sourceMode.tdxPausedReason ? ` reason="${sourceMode.tdxPausedReason}"` : ''}`
  );

  console.log(
    `[cron] tdxScheduleState=${tdxScheduleState} tokenOk=${summary.tokenOk} baselineInitialized=${summary.baselineInitialized} ` +
      `kvAvailable=${summary.kvAvailable} kvError=${summary.kvError ?? 'none'} ` +
      `raw=${JSON.stringify(summary.rawCounts)} normalized=${summary.normalizedCount} ` +
      `hsinchuFiltered=${summary.hsinchuFilteredCount} new=${summary.newEventsCount} ` +
      `updated=${summary.updatedEventsCount} duplicate=${summary.duplicateCount} ` +
      `pushable=${summary.pushableEventsCount} baselineSeed=${summary.baselineSeedCount} ` +
      `failedSources=${summary.failedSources.map((f) => f.source).join(',') || 'none'}`
  );

  // V1.6.2: persist a small cache of THIS run's TDX events so a later
  // PBS-only tick can still cross-source-dedup against them — see
  // tdxEventCache.js. Only written on a genuinely successful scheduled
  // fetch (at least one source ok); own try/catch, same isolation
  // principle as every other side-effect in this function.
  if (tdxScheduleState === 'scheduled' && summary.sources.some((s) => s.ok)) {
    try {
      const cacheCommit = await persistProductionTdxEventCache(env.TRAFFIC_KV, summary.allEvents, now);
      if (!cacheCommit.committed) console.error(`[cron][tdx-cache] write failed: ${cacheCommit.reason} ${cacheCommit.error ?? ''}`);
    } catch (err) {
      console.error(`[cron][tdx-cache] write failed: ${err && err.message}`);
    }
  }

  const newUpdatedKeys = new Set(
    [...summary.newEvents, ...summary.updatedEvents].map((e) => `${e.source}:${e.rawId}`)
  );

  // V1.6.2: what to feed PBS's own crossSourceDedup MATCHING step (see
  // pbs/crossSourceDedup.js) — THIS run's fresh TDX events when scheduled
  // (unchanged from before), otherwise the cached last-successful-fetch
  // events (empty if stale/missing — see tdxEventCache.js's 30-min
  // cutoff). This is used ONLY inside PBS's own pipeline for matching; it
  // never feeds dedupe.js's TDX new/updated classification (that already
  // happened above, entirely from `summary`, before this point) and is
  // NOT what gets passed to mergeForBroadcast below (that still only
  // ever receives THIS run's real summary.allEvents) — so a PBS event
  // that matches a CACHED (not-this-run) TDX event is correctly dropped
  // from this run's broadcast entirely (already reported once when TDX
  // itself saw it), never re-broadcast as new.
  const tdxEventsForPbsDedup =
    tdxScheduleState === 'scheduled' ? summary.allEvents : (await readProductionTdxEventCache(env.TRAFFIC_KV, now)).events;

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
    pbsSummary = await runPbsPipelineAndCommit(env, { tdxEvents: tdxEventsForPbsDedup, now });
    console.log(
      `[cron][pbs] pbsOk=${pbsSummary.pbsOk} pbsError=${pbsSummary.pbsError ?? 'none'} ` +
        `kvAvailable=${pbsSummary.kvAvailable} committed=${pbsSummary.committed} ` +
        `raw=${pbsSummary.rawCount} hsinchu=${pbsSummary.hsinchuCount} active=${pbsSummary.activeCount} ` +
        `cleared=${pbsSummary.clearedCount} stale=${pbsSummary.staleCount} filtered=${pbsSummary.filteredCount} ` +
        `crossSourceDuplicates=${pbsSummary.crossSourceDuplicateCount} canonical=${pbsSummary.canonicalEventCount} ` +
        `freewayGated=${pbsSummary.freewayGatedCount ?? 0}` // V57.2: 國道 PBS events with no TDX match this run — never broadcast, observability only
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
  // still exercised by their own unit tests. CORRECTION (found during the
  // V1.8.6 TDX-call-path inventory): GET /debug/status does NOT keep a VD
  // preview either — V1.6.2 removed that too (see debugStatus.js's own
  // comment), so vdSpeed.js's TDX calls are not reachable from any live
  // Production/debug/admin path today, only from its own unit tests.

  // V1.8.6.7 (Pipeline Trace) — dedupeResult/gatingResult for every event
  // that actually reaches runLineBroadcast's `allEvents`, sourced ENTIRELY
  // from decisions dedupe.js/crossSourceDedup.js already made above (never
  // re-derived): TDX new/updated events get dedupeResult; a TDX event
  // matched by PBS this run (now the canonical merged event, same
  // source:rawId as the original TDX identity — see buildCanonicalEvent)
  // additionally gets gatingResult:'enriched-by-pbs-match'; a PBS event
  // with no TDX match (source:'pbs') gets gatingResult:'unique-candidate'.
  const traceEventMeta = new Map();
  for (const event of summary.newEvents || []) {
    traceEventMeta.set(`${event.source}:${event.rawId}`, { dedupeResult: 'new', gatingResult: null });
  }
  for (const event of summary.updatedEvents || []) {
    traceEventMeta.set(`${event.source}:${event.rawId}`, { dedupeResult: 'updated', gatingResult: null });
  }
  for (const event of pbsSummary.canonicalEvents || []) {
    const key = `${event.source}:${event.rawId}`;
    const existing = traceEventMeta.get(key) || {};
    traceEventMeta.set(key, { ...existing, gatingResult: 'enriched-by-pbs-match' });
  }
  for (const event of pbsSummary.uniquePbsEvents || []) {
    traceEventMeta.set(`${event.source}:${event.rawId}`, { dedupeResult: null, gatingResult: 'unique-candidate' });
  }

  const lineSummary = await runLineBroadcast(env, {
    allEvents: broadcastEvents,
    dedupeAvailable: summary.kvAvailable,
    newUpdatedKeys,
    dedupeMapSnapshot: summary.dedupeMapSnapshot,
    prunedKeys: summary.prunedKeys,
    now,
    dryRun: false,
    eventMeta: traceEventMeta,
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
      sourceMode,
      previousTdx: previous.snapshot ? previous.snapshot.tdx : null,
    });
    const commit = await persistHealthSnapshot(env.TRAFFIC_KV, healthSnapshot);
    if (!commit.committed) console.error(`[cron][health] snapshot write failed: ${commit.reason} ${commit.error ?? ''}`);
  } catch (err) {
    console.error(`[cron][health] snapshot build/write failed: ${err && err.message}`);
  }

  // V1.8.6 — TDX usage ledger: write this tick's batch (if any real TDX
  // call was attempted), then recompact BOTH today's and yesterday's
  // summary rows from the raw entries (compactTdxUsageSummaryRecentDays —
  // catches a cross-midnight Debug/Admin invocation whose "yesterday"
  // entry only finished writing after yesterday's row was last frozen;
  // still just 2 bounded list() scans, never the full history). Neither
  // function ever throws (each reduces any KV failure to a returned
  // {committed:false, reason, error} — see usageLedger.js), so no extra
  // try/catch is needed here — same isolation principle as the health
  // snapshot write above and the tdx-cache write further up: a usage-
  // ledger outage must never affect the real TDX/PBS/LINE pipeline this
  // tick already fully completed by this point.
  const batchCommit = await commitTdxUsageBatch(env.TRAFFIC_KV, { context: 'production-cron', now, records: tdxUsageSink });
  if (!batchCommit.committed && batchCommit.reason === 'kv-error') {
    console.error(`[cron][tdx-usage] batch write failed: ${batchCommit.error ?? ''}`);
  }
  const compaction = await compactTdxUsageSummaryRecentDays(env.TRAFFIC_KV, now);
  if (!compaction.committed && compaction.reason === 'kv-error') {
    console.error(`[cron][tdx-usage] summary compaction failed: ${compaction.error ?? ''}`);
  }

  // V57 — persist this run's completed products (the exact finished text, and
  // the CCTV image URL this run already published) so another project can
  // consume them read-only. See src/traffic/sharedFeed.js.
  //
  // Deliberately the LAST step, in its own try/catch, and consuming only
  // `lineSummary.completedProducts` which is already in memory: it fetches
  // nothing, composes nothing, and this Worker's own TDX/PBS pipeline, LINE
  // broadcast, health snapshot and usage ledger have all fully completed
  // before it starts. A failure here can never reduce or delay this Worker's
  // own broadcast — it is log-only, best effort.
  let sharedFeedSummary;
  try {
    sharedFeedSummary = await runSharedFeedPersist(env, {
      completedProducts: lineSummary.completedProducts,
      now,
    });
    console.log(
      `[cron][shared-feed] committed=${sharedFeedSummary.committed} ` +
        `events=${sharedFeedSummary.eventCount} withImage=${sharedFeedSummary.withImageCount} ` +
        `error=${sharedFeedSummary.error ?? 'none'}`
    );
  } catch (err) {
    console.error(`[cron][shared-feed] persistence failed: ${err && err.message}`);
    sharedFeedSummary = { committed: false, error: err && err.message, eventCount: 0, withImageCount: 0 };
  }

  // V1.8.6.7 — 24h Pipeline Trace. Deliberately the VERY LAST step, in its
  // own try/catch, strictly AFTER Shared Feed persistence: this is the
  // one place in the whole Cron run that can answer "did this event's
  // image actually reach the Shared Feed" for the trace-view's own
  // SHARED_FEED_IMAGE_LOST check (see pipelineTrace.js's own comment).
  // Consumes ONLY data this run already computed (lineSummary's own
  // per-event trace inputs, TDX's duplicateEvents, PBS's
  // freewayGatedEvents) — never a new TDX/PBS/CCTV/LINE call. A failure
  // here can never reduce or delay this Worker's own broadcast, which
  // (including the Shared Feed write above) already fully completed.
  let pipelineTraceSummary;
  try {
    // One extra, read-only KV get (not a `list`) so this run's trace
    // entries can carry the ACTUAL persisted Shared Feed outcome, not
    // just "did runSharedFeedPersist report committed:true" — the whole
    // point of this check is to catch a case where those two disagree.
    const feedAfterPersist = sharedFeedSummary.committed ? await readSharedFeed(env.TRAFFIC_KV) : { events: [] };
    const feedById = new Map((feedAfterPersist.events || []).map((e) => [e.eventId, e]));

    const patchedLineEntries = (lineSummary.pipelineTraceEntries || []).map((entry) => {
      const feedEntry = feedById.get(entry.eventKey);
      return {
        ...entry,
        delivery: {
          ...entry.delivery,
          sharedFeedPersisted: Boolean(feedEntry),
          sharedFeedWithImage: feedEntry ? Boolean(feedEntry.imageUrl) : false,
        },
      };
    });

    // V1.8.6.7 — events whose lifecycle ended BEFORE runLineBroadcast ever
    // saw them: a TDX-level duplicate (dedupe.js — unchanged content, same
    // as last run) never enters `pushableEvents`/`broadcastEvents` at all;
    // a 國道 PBS event with no TDX match this run (V57.2's own gate — see
    // crossSourceDedup.js) never enters `uniquePbsEvents`/`broadcastEvents`
    // either. Both still "entered the pipeline" this run (they were
    // fetched, normalized, Hsinchu-filtered) and are exactly the kind of
    // "why didn't this broadcast" question this trace exists to answer —
    // built here, directly, from arrays those two modules already
    // computed above (summary.duplicateEvents, pbsSummary.freewayGatedEvents).
    const dropoutEntries = [
      ...(summary.duplicateEvents || []).map((event) => buildTraceEntry({ event, now, dedupeResult: 'duplicate' })),
      ...(pbsSummary.freewayGatedEvents || []).map((event) =>
        buildTraceEntry({ event, now, gatingResult: 'gated-freeway-no-tdx-match' })
      ),
    ];

    pipelineTraceSummary = await persistPipelineTraceEntries(env.TRAFFIC_KV, [...patchedLineEntries, ...dropoutEntries], now);
    console.log(
      `[cron][pipeline-trace] attempted=${pipelineTraceSummary.attempted} ` +
        `committed=${pipelineTraceSummary.committed} failed=${pipelineTraceSummary.failed}`
    );
  } catch (err) {
    console.error(`[cron][pipeline-trace] persistence failed: ${err && err.message}`);
    pipelineTraceSummary = { attempted: 0, committed: 0, failed: 0, error: err && err.message };
  }

  return { ...summary, line: lineSummary, pbs: pbsSummary, sharedFeed: sharedFeedSummary, pipelineTrace: pipelineTraceSummary };
}
