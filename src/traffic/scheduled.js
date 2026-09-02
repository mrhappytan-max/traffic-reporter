// Cron entry point (every 10 minutes, see wrangler.jsonc `triggers.crons`).
// This is the ONLY code path allowed to establish the baseline, write KV
// dedup state, mark events notified, or actually call the LINE push API —
// see runTdxPipelineAndCommit (pipeline.js) and runLineBroadcast
// (broadcastPipeline.js), both of which have read-only counterparts used
// by GET /debug/status.
//
// V1.6.1 — "資料來源與 TDX 用量瘦身": TDX (國道+省道 only, see
// ../tdx/sources.js's PRODUCTION_TDX_SOURCE_IDS) is only fetched every 2nd
// tick (minute 00/20/40), and only 08:00–21:59:59 Asia/Taipei — see
// tdxSchedule.js. A tick that doesn't fetch TDX still runs PBS + the LINE
// broadcast step normally (PBS-only broadcasts must never be blocked just
// because TDX itself sat this tick out) — only the TDX-specific portion
// of the pipeline is skipped.
//
// V1.9.3 (KV Write Optimization Phase 2) — PBS is likewise no longer
// fetched every tick: at most every 30 minutes, only 07:00–22:00 Asia/
// Taipei — see pbsSchedule.js. Cron ITSELF still runs every 10 minutes
// unchanged; a tick that skips the PBS fetch still runs the LINE broadcast
// step normally against whatever TDX/cached-PBS candidates exist.
//
// `now` defaults to the real clock; tests pass an explicit Date.

import { runTdxPipelineAndCommit } from './pipeline.js';
import { runLineBroadcast } from './broadcastPipeline.js';
import { runPbsPipelineAndCommit } from '../pbs/pipeline.js';
import { PBS_BROADCAST_ENABLED, resolvePbsPollingEnabled } from '../pbs/pbsConfig.js';
import { buildHealthSnapshot, persistHealthSnapshot, readHealthSnapshot } from './healthSnapshot.js';
import { getTdxScheduleState } from './tdxSchedule.js';
import { getPbsScheduleState } from './pbsSchedule.js';
import { hasPipelineTraceRelevantChange } from './pipelineTrace.js';
import { isTdxRuntimeEnabled, isTdxRoadEventFetchEnabled, isTdxRoadEventQueueIngressEnabled, describeSourceMode } from './sourceMode.js';
import { enqueueTdxRoadEvents } from '../tdx/tdxQueueIngress.js';
import { resolveLinePushPolicy } from './broadcastPolicy.js';
import { readDedupeState } from './dedupe.js';
import { PRODUCTION_TDX_SOURCE_IDS } from '../tdx/sources.js';
import { persistProductionTdxEventCache, readProductionTdxEventCache } from './tdxEventCache.js';
import { runSharedFeedPersist, readSharedFeed } from './sharedFeed.js';
import { buildTraceEntry, persistPipelineTraceBatch } from './pipelineTrace.js';
import { describeFreewayCctvMetadata } from '../cctv/freewayCctvMetadataCache.js';

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
/**
 * V1.9.3 (KV Write Optimization Phase 2, item 二) — shape-compatible with
 * pbs/pipeline.js's buildSummary() output for a tick that made ZERO PBS
 * calls at all (see pbsSchedule.js — outside the 07:00–22:00 Asia/Taipei
 * window, or not on a 30-minute mark). No fetch, no lifecycle read/write,
 * no cross-source dedup — a genuinely absent fetch must never be misread
 * as "0 active PBS events this run" (which would incorrectly start
 * absence/staleness clocks). `pbsOk` is deliberately `null` here (not
 * `false`) — healthSnapshot.js's carry-forward reads the REAL last-fetch
 * health from the previous snapshot, not from this placeholder; `null`
 * only means "this shape itself carries no health opinion", so nothing
 * downstream can mistake a schedule skip for a PBS failure.
 */
function buildSkippedPbsSummary() {
  return {
    pbsOk: null,
    pbsError: null,
    kvAvailable: true,
    kvError: null,
    committed: false,
    commitReason: 'skipped-by-schedule',
    pbsNewCount: 0,
    pbsUpdatedCount: 0,
    pbsNewlyClearedCount: 0,
    rawCount: 0,
    hsinchuCount: 0,
    activeCount: 0,
    clearedCount: 0,
    staleCount: 0,
    filteredCount: 0,
    crossSourceDuplicateCount: 0,
    canonicalEventCount: 0,
    canonicalEvents: [],
    uniquePbsEvents: [],
    freewayGatedCount: 0,
    freewayGatedEvents: [],
    relayOk: null,
    relayStatus: null,
  };
}

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
  // V2.4.0 — order section 五/十二's own granular switch: TDX RoadEvent
  // fetch may now also be independently enabled via
  // TDX_ROADEVENT_FETCH_ENABLED, without touching TRAFFIC_SOURCE_MODE
  // (order section 四's own explicit "不得直接 TRAFFIC_SOURCE_MODE=ALL").
  // With the new switch at its default (false), this is EXACTLY
  // isTdxRuntimeEnabled(env) — today's behavior, unchanged.
  const tdxEnabled = isTdxRuntimeEnabled(env) || isTdxRoadEventFetchEnabled(env);
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
      // 2026-08-24: V57.2's 國道 gate defers PBS to TDX, which is only
      // meaningful while TDX runs. Logged next to the mode it derives
      // from so 'why did this 國道 PBS accident broadcast' is answerable
      // straight from one log line.
      `tdxCorrelationRequired=${sourceMode.tdxRuntimeEnabled} ` +
      // 2026-08-24: the two always-on gates, logged as literal true so a
      // future reader can see at a glance that neither is mode-dependent
      // — "TDX 佐證不需要" must never be misread as "什麼都可以播".
      `serviceAreaRequired=true locationQualityRequired=true ` +
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

  // V2.4.0 — order section 六/七, Phase A/B (order section 二十). Only
  // when TDX_ROADEVENT_QUEUE_INGRESS_ENABLED is on (default off — see
  // sourceMode.js's own V2.4.0 comment) does a genuinely new/updated TDX
  // freeway/highway sighting this tick get handed to the SAME
  // PBS_AI_QUEUE Windows PBS already uses. `summary.newEvents`/
  // `summary.updatedEvents` are already exactly what dedupe.js#
  // classifyEvents decided this run (empty on a non-'scheduled' tick, or
  // when kvAvailable is false — see pipeline.js's own buildSummary fail-
  // closed comment) — never re-classified here. A duplicate is never
  // enqueued (it simply never appears in either array). This never calls
  // runLineBroadcast, directly or indirectly — see tdxQueueIngress.js's
  // own module comment.
  let tdxQueueIngress = { attempted: 0, enqueued: 0, failed: 0, droppedOutsideHsinchu: 0, droppedUnknownHsinchu: 0, droppedRoadManagement: 0 };
  if (tdxScheduleState === 'scheduled' && isTdxRoadEventQueueIngressEnabled(env)) {
    try {
      tdxQueueIngress = await enqueueTdxRoadEvents(env, { newEvents: summary.newEvents, updatedEvents: summary.updatedEvents }, now);
    } catch (err) {
      console.error(`[cron][tdx-queue-ingress] failed: ${err && err.message}`);
    }
    // V2.4.5 — droppedOutsideHsinchu/droppedUnknownHsinchu (Gate A, tdx/
    // hsinchuGeoResolver.js) and droppedRoadManagement (Gate A, tdx/
    // roadManagementPolicyGate.js) are new, purely-additive observability
    // fields — see tdxQueueIngress.js's own V2.4.5 comment.
    console.log(
      `[cron][tdx-queue-ingress] attempted=${tdxQueueIngress.attempted} enqueued=${tdxQueueIngress.enqueued} ` +
        `failed=${tdxQueueIngress.failed} droppedOutsideHsinchu=${tdxQueueIngress.droppedOutsideHsinchu ?? 0} ` +
        `droppedUnknownHsinchu=${tdxQueueIngress.droppedUnknownHsinchu ?? 0} ` +
        `droppedRoadManagement=${tdxQueueIngress.droppedRoadManagement ?? 0}` +
        `${tdxQueueIngress.reason ? ` reason=${tdxQueueIngress.reason}` : ''}`
    );
  }

  // V1.6.2: persist a small cache of THIS run's TDX events so a later
  // PBS-only tick can still cross-source-dedup against them — see
  // tdxEventCache.js. Only written on a genuinely successful scheduled
  // fetch (at least one source ok); own try/catch, same isolation
  // principle as every other side-effect in this function.
  const tdxEventCacheAttempted = tdxScheduleState === 'scheduled' && summary.sources.some((s) => s.ok);
  let tdxEventCacheWritten = false;
  if (tdxEventCacheAttempted) {
    try {
      const cacheCommit = await persistProductionTdxEventCache(env.TRAFFIC_KV, summary.allEvents, now);
      tdxEventCacheWritten = Boolean(cacheCommit.committed);
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
  // NOT the same thing as `broadcastEvents` below (V2.4.0: TDX's own
  // fetched events no longer reach that variable at all — see its own
  // comment) — so a PBS event
  // that matches a CACHED (not-this-run) TDX event is correctly dropped
  // from this run's broadcast entirely (already reported once when TDX
  // itself saw it), never re-broadcast as new.
  const tdxEventsForPbsDedup =
    tdxScheduleState === 'scheduled' ? summary.allEvents : (await readProductionTdxEventCache(env.TRAFFIC_KV, now)).events;

  // V1.9.3 (KV Write Optimization Phase 2, item 二) — PBS is no longer
  // fetched every Cron tick: at most every 30 minutes, only 07:00–22:00
  // Asia/Taipei (see pbsSchedule.js's own module comment for the full
  // safety analysis — every PBS lifecycle rule this could plausibly
  // affect is wall-clock-based, not tick-based, and comfortably larger
  // than the gap this introduces). Cron itself still runs every 10
  // minutes unchanged.
  // V1.9.8 — RETIRED (order section 八): resolvePbsPollingEnabled(env)
  // defaults to false, meaning this tick NEVER performs the PBS fetch
  // itself in real Production, regardless of what pbsScheduleState would
  // otherwise say — PBS's production main line is now the Windows ingress
  // (see pbs/debugPush.js / pbsConfig.js's own comment on this flag).
  // getPbsScheduleState(now) is still computed unchanged (so
  // healthSnapshot.js's existing night-sleep/skipped-by-schedule/scheduled
  // carry-forward logic needs no change at all — see that module) — only
  // whether this tick ACTS on it is now gated. Rollback is either an env
  // var (env.PBS_30_MIN_POLLING_ENABLED=true) or, permanently, flipping
  // pbsConfig.js's own PBS_30_MIN_POLLING_ENABLED constant back to true.
  const pbsScheduleState = getPbsScheduleState(now);
  const pbsFetchPerformed = resolvePbsPollingEnabled(env) && pbsScheduleState === 'scheduled';

  // PBS runs BEFORE the LINE broadcast now (V1.4: PBS+TDX merge, Alpha),
  // so its cross-source dedup result can be folded into what actually
  // gets pushed below. Still fully isolated: its own KV key
  // (pbs:lifecycle-state), its own fetch — and critically, its own
  // try/catch here, so a PBS failure can NEVER prevent or reduce TDX's
  // own broadcast (see the mergeForBroadcast call below, and requirement
  // "PBS 掛掉時 TDX 必須繼續正常播報").
  let pbsSummary;
  if (pbsFetchPerformed) {
    try {
      pbsSummary = await runPbsPipelineAndCommit(env, { tdxEvents: tdxEventsForPbsDedup, now });
      console.log(
        `[cron][pbs] pbsOk=${pbsSummary.pbsOk} pbsError=${pbsSummary.pbsError ?? 'none'} ` +
          `kvAvailable=${pbsSummary.kvAvailable} committed=${pbsSummary.committed} ` +
          `raw=${pbsSummary.rawCount} hsinchu=${pbsSummary.hsinchuCount} active=${pbsSummary.activeCount} ` +
          `cleared=${pbsSummary.clearedCount} stale=${pbsSummary.staleCount} filtered=${pbsSummary.filteredCount} ` +
          `crossSourceDuplicates=${pbsSummary.crossSourceDuplicateCount} canonical=${pbsSummary.canonicalEventCount} ` +
          `freewayGated=${pbsSummary.freewayGatedCount ?? 0} ` + // V57.2: 國道 PBS events with no TDX match this run — never broadcast, observability only
          `new=${pbsSummary.pbsNewCount ?? 0} updated=${pbsSummary.pbsUpdatedCount ?? 0} newlyCleared=${pbsSummary.pbsNewlyClearedCount ?? 0}`
      );
    } catch (err) {
      // Belt-and-suspenders: PBS must never be able to take down the Cron
      // run even if something in this pipeline throws unexpectedly.
      console.error(`[cron][pbs] pipeline failed: ${err && err.message}`);
      pbsSummary = {
        pbsOk: false,
        pbsError: err && err.message,
        canonicalEvents: [],
        uniquePbsEvents: [],
        pbsNewCount: 0,
        pbsUpdatedCount: 0,
        pbsNewlyClearedCount: 0,
      };
    }
  } else {
    pbsSummary = buildSkippedPbsSummary();
  }
  console.log(
    `[cron][pbs-schedule] state=${pbsScheduleState} pbsFetchPerformed=${pbsFetchPerformed} ` +
      `pbsFetchSkippedSchedule=${!pbsFetchPerformed}`
  );

  // V1.4 Alpha (fold PBS's cross-source dedup result into what gets
  // broadcast) — RETIRED FOR TDX, V2.4.0 (order section 四:
  // LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT). This used to pass
  // `summary.allEvents` (this tick's own fetched TDX events) into
  // mergeForBroadcast so an unmatched TDX event broadcast on its own via
  // the legacy hard-rule pipeline below. TDX RoadEvent broadcast now ONLY
  // happens through the new Queue/AI ingress above
  // (enqueueTdxRoadEvents/TDX_ROADEVENT_QUEUE_INGRESS_ENABLED) — this is
  // load-bearing, not cosmetic: Phase A (TDX_ROADEVENT_FETCH_ENABLED=true,
  // QUEUE_INGRESS still false) is supposed to be fetch-only/observe-only
  // (order section 二十); if `summary.allEvents` still reached
  // runLineBroadcast here, flipping ONLY the fetch switch would silently
  // let a real TDX event broadcast via the OLD V1.5 hard rules the moment
  // TDX resumed — exactly what Phase A promises never happens.
  //
  // pbsSummary.canonicalEvents/uniquePbsEvents are UNCHANGED and STILL
  // flow through here — this is PBS's own (currently dormant, since
  // resolvePbsPollingEnabled(env) defaults false — see pbsFetchPerformed
  // above) legacy-polling cross-source result, not TDX's own events, and
  // order section 四 only asks to retire TDX's own RoadEvent broadcast,
  // not PBS's pre-existing (already-dormant) polling fallback. TDX's own
  // fetched data is still available to PBS's OWN cross-source matching
  // via `tdxEventsForPbsDedup` above (V57.2's 國道 corroboration gate) —
  // only TDX's fetched events broadcasting IN THEIR OWN RIGHT is retired.
  const broadcastEvents = PBS_BROADCAST_ENABLED ? [...(pbsSummary.canonicalEvents || []), ...(pbsSummary.uniquePbsEvents || [])] : [];

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
  // V1.9.3 (KV Write Optimization Phase 2, item 一): that SAME previous
  // snapshot also carries the `pbs` block forward on a PBS schedule skip,
  // AND is passed into persistHealthSnapshot so it can skip the write
  // entirely when the real content hasn't changed (WRITE_ON_CHANGE) — no
  // second KV read needed for either purpose.
  // Own try/catch: a bug here must never break the Cron run itself, same
  // isolation principle as the PBS step above. If this write itself
  // fails, the snapshot already in KV just keeps aging — /health's own
  // staleness check (see health.js) is what correctly surfaces that as
  // critical, no separate "write failed" flag needed here.
  let healthSnapshotCommitted = false;
  let healthSnapshotWritten = false;
  try {
    const previous = await readHealthSnapshot(env.TRAFFIC_KV);
    // One extra KV read, no network, no TDX — describeFreewayCctvMetadata
    // falls back to the bundled official inventory and never throws.
    const cctvMetadata = await describeFreewayCctvMetadata(env.TRAFFIC_KV);
    const healthSnapshot = buildHealthSnapshot({
      summary,
      pbsSummary,
      lineSummary,
      now,
      tdxScheduleState,
      pbsScheduleState,
      sourceMode,
      cctvMetadata: {
        source: cctvMetadata.source,
        recordCount: cctvMetadata.records.length,
        fetchedAt: cctvMetadata.fetchedAt,
        sourceName: cctvMetadata.sourceName,
        sourceUpdatedAt: cctvMetadata.sourceUpdatedAt,
      },
      previousTdx: previous.snapshot ? previous.snapshot.tdx : null,
      previousPbs: previous.snapshot ? previous.snapshot.pbs : null,
    });
    const commit = await persistHealthSnapshot(env.TRAFFIC_KV, healthSnapshot, previous.snapshot);
    healthSnapshotCommitted = Boolean(commit.committed);
    healthSnapshotWritten = Boolean(commit.written);
    if (!commit.committed) console.error(`[cron][health] snapshot write failed: ${commit.reason} ${commit.error ?? ''}`);
  } catch (err) {
    console.error(`[cron][health] snapshot build/write failed: ${err && err.message}`);
  }

  // V1.9.2 (TDX Usage Summary retirement) — this used to be where the
  // TDX usage ledger's per-tick batch write (commitTdxUsageBatch,
  // 'tdx:usage:entry:v1:*') and the compacted-summary recompaction
  // (compactTdxUsageSummaryRecentDays, 'tdx:usage:summary:v1') happened,
  // unconditionally, EVERY Cron tick — 144 times/day regardless of
  // whether TDX made any real calls this tick. A real person now checks
  // TDX's own official back-office dashboard directly for quota/usage,
  // so this Worker no longer maintains its own duplicate summary. Both
  // KV keys are RETIRED (0 writes/day) — see usageLedger.js's own header
  // comment and 07_KNOWN_ISSUES.md's V1.9.2 record for the full
  // reasoning (the raw ledger existed solely to feed the now-retired
  // summary/dashboard and had no other reader — TDX runtime, auth,
  // RoadEvent/CCTV metadata fetching, source-mode switching, and the 9/1
  // TDX quota restore path are all completely independent of this ledger
  // and are untouched). `tdxUsageSink` above is still collected in
  // memory (recordTdxDataCall/recordTdxOAuthCall — harmless, unpersisted)
  // purely because fetchAllSources/getAccessToken still accept it.

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
  let pipelineTraceEntryCount = 0;
  let pipelineTraceRelevantChange = false;
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

    // V1.9.3 (KV Write Optimization Phase 2, item 三) — NO_RELEVANT_CHANGE:
    // when this round has no new/updated/cleared service-area event and no
    // LINE push failure (see hasPipelineTraceRelevantChange's own comment
    // for the exact rule and why CCTV anomalies need no separate check),
    // skip the batch write entirely — the entries this round would have
    // produced are the SAME still-active-and-unchanged events the last
    // relevant round already traced once. Computed here, not inside
    // persistPipelineTraceBatch itself, so that function's own existing
    // "always write whatever I'm given" contract (and its own tests) stay
    // untouched.
    const allEntries = [...patchedLineEntries, ...dropoutEntries];
    pipelineTraceEntryCount = allEntries.length;
    const relevantChange = hasPipelineTraceRelevantChange({ summary, pbsSummary, lineSummary });
    pipelineTraceRelevantChange = relevantChange;
    if (relevantChange) {
      // V1.9.2 — batched: one KV `put` per Cron round (occasionally a few,
      // only if this round's entries are genuinely too large for one key —
      // see chunkEntriesForTraceBatch), replacing the old one-`put`-per-
      // entry write. See pipelineTrace.js's own TRACE_BATCH_KEY_PREFIX
      // comment for the full backward-compatibility write-up.
      pipelineTraceSummary = await persistPipelineTraceBatch(env.TRAFFIC_KV, allEntries, now);
    } else {
      pipelineTraceSummary = {
        attempted: allEntries.length,
        committed: 0,
        failed: 0,
        batchCount: 0,
        batchesCommitted: 0,
        skippedNoRelevantChange: true,
      };
    }
    console.log(
      `[cron][pipeline-trace] attempted=${pipelineTraceSummary.attempted} ` +
        `committed=${pipelineTraceSummary.committed} failed=${pipelineTraceSummary.failed} ` +
        `batchCount=${pipelineTraceSummary.batchCount} relevantChange=${relevantChange}`
    );
  } catch (err) {
    console.error(`[cron][pipeline-trace] persistence failed: ${err && err.message}`);
    pipelineTraceSummary = { attempted: 0, committed: 0, failed: 0, batchCount: 0, error: err && err.message };
  }

  // V1.9.2 — KV Write Optimization observability. Workers Logs ONLY —
  // deliberately creates no new KV key (per this round's own instruction)
  // — a single console.log line per Cron tick reporting exactly which of
  // this project's own KV-writing categories attempted a write, how many
  // actually reached KV, and (for the three WRITE_ON_CHANGE keys) how
  // many were skipped because their real content hadn't changed.
  // `attempted`/`performed`/`skippedUnchanged` are counted per-category
  // below; `tdxUsageSummary`/`tdxUsageEntry` are permanently 0/0/0 — kept
  // as their own named categories (rather than removed outright) so this
  // log line itself is the ongoing, visible proof that the V1.9.2
  // retirement holds on every single Production tick, not just at
  // deploy time.
  const budgetCategories = {
    tdxUsageSummary: { attempted: 0, performed: 0, skippedUnchanged: 0 }, // RETIRED V1.9.2 — see above
    tdxUsageEntry: { attempted: 0, performed: 0, skippedUnchanged: 0 }, // RETIRED V1.9.2 — see above
    healthSnapshot: {
      attempted: 1,
      performed: healthSnapshotWritten ? 1 : 0,
      skippedUnchanged: healthSnapshotCommitted && !healthSnapshotWritten ? 1 : 0,
    },
    tdxEventCache: {
      attempted: tdxEventCacheAttempted ? 1 : 0,
      performed: tdxEventCacheWritten ? 1 : 0,
      skippedUnchanged: 0,
    },
    sharedFeed: {
      attempted: 1,
      performed: sharedFeedSummary.written ? 1 : 0,
      skippedUnchanged: sharedFeedSummary.written ? 0 : 1,
    },
    incidentSuppression: {
      attempted: lineSummary.incidentSuppressionWriteAttempted ? 1 : 0,
      performed: lineSummary.incidentSuppressionWriteWritten ? 1 : 0,
      skippedUnchanged: lineSummary.incidentSuppressionWriteAttempted && !lineSummary.incidentSuppressionWriteWritten ? 1 : 0,
    },
    notifiedState: {
      attempted: lineSummary.notifiedStateWriteAttempts || 0,
      performed: lineSummary.notifiedStateWriteCommitted || 0,
      skippedUnchanged: 0, // never gated by WRITE_ON_CHANGE — per-event failure isolation is preserved as-is
    },
    pipelineTraceBatch: {
      // V1.9.3: when this round had entries but no relevant change,
      // report it as "attempted 1, skipped 1" (a real decision was made
      // NOT to write) rather than silently 0/0/0, which would look
      // indistinguishable from "there was nothing to trace at all".
      attempted:
        pipelineTraceRelevantChange || pipelineTraceEntryCount === 0 ? pipelineTraceSummary.batchCount || 0 : 1,
      performed: pipelineTraceSummary.batchesCommitted || 0,
      skippedUnchanged: !pipelineTraceRelevantChange && pipelineTraceEntryCount > 0 ? 1 : 0,
    },
  };
  const totals = Object.values(budgetCategories).reduce(
    (acc, c) => ({
      attempted: acc.attempted + c.attempted,
      performed: acc.performed + c.performed,
      skippedUnchanged: acc.skippedUnchanged + c.skippedUnchanged,
    }),
    { attempted: 0, performed: 0, skippedUnchanged: 0 }
  );
  const categoryLog = Object.entries(budgetCategories)
    .map(([name, c]) => `${name}=${c.attempted}/${c.performed}/${c.skippedUnchanged}`)
    .join(' ');
  console.log(
    `[kv-write-budget] attemptedWrites=${totals.attempted} performedWrites=${totals.performed} ` +
      `skippedUnchangedWrites=${totals.skippedUnchanged} ${categoryLog} ` +
      `traceEntryCount=${pipelineTraceSummary.attempted || 0} traceBatchCount=${pipelineTraceSummary.batchCount || 0}`
  );

  return { ...summary, line: lineSummary, pbs: pbsSummary, sharedFeed: sharedFeedSummary, pipelineTrace: pipelineTraceSummary };
}
