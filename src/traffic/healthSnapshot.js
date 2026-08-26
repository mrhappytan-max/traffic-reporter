// V1.6 — "路況播報員人工健康頁" (GET /health). Read/compute/write split,
// same pattern as dedupe.js/notified.js:
//
//   - buildHealthSnapshot(): PURE, no I/O. Takes the Cron run's ALREADY-
//     COMPUTED summary/pbsSummary/lineSummary (scheduled.js) and reduces
//     them to a compact snapshot. Never re-fetches TDX/PBS/LINE — the
//     whole point of this feature is that a human refreshing /health
//     must NEVER trigger a new TDX/PBS request (see health.js).
//   - persistHealthSnapshot()/readHealthSnapshot(): the only I/O, one KV
//     key (health:snapshot:v1), isolated from every other state key in
//     this project (traffic:dedupe-state, line:notified-state,
//     pbs:lifecycle-state, line:incident-suppression-state) — a bug here
//     must never affect any of those, and vice versa.
//
// Design notes carried over from the proposal:
//   - Only HTTP status codes / booleans / counts go in the snapshot —
//     never a raw upstream error message, never a token, never a LINE
//     userId/groupId. Human-readable reason text ("429 -> API 流量限制")
//     is derived at RENDER time in health.js, not baked in here, so a
//     copy change never needs a new Cron write to take effect.
//   - `status` here is computed from what THIS Cron run actually knows
//     (TDX/PBS/LINE/KV health at write time) — it deliberately does NOT
//     know how stale it will be by the time a human loads /health later.
//     health.js layers a SEPARATE staleness check (generatedAt age) on
//     top when reading, which is also what takes over if a future
//     persistHealthSnapshot() call itself fails to write: the snapshot
//     already in KV simply keeps aging, and staleness alone will
//     eventually (correctly) surface that as critical — no separate
//     "write failed" flag is needed inside the snapshot for this to work.
//   - `lastLinePushAt` and "0 events this run" are NEVER inputs to
//     `status` — a quiet Cron tick with nothing broadcast-worthy is
//     completely normal, not unhealthy. Only actual TDX/PBS/LINE/KV
//     failure signals participate in the computation below.
//
// V1.6.1 addition — "資料來源與 TDX 用量瘦身": TDX (國道+省道 only, see
// ../tdx/sources.js) is no longer fetched every Cron tick, only every 2nd
// tick during 08:00–22:00 Asia/Taipei (see tdxSchedule.js). A tick that
// did NOT attempt a TDX fetch (skipped-by-schedule, or night-sleep) must
// NEVER be read as a TDX failure — see the requirement "TDX
// skipped/sleeping 不得因此降級". Handled by carrying the `tdx` block
// FORWARD unchanged from the previous snapshot whenever this tick didn't
// fetch — only `tdx.scheduledThisRun`/`tdx.sleeping` themselves reflect
// THIS tick; `tdx.tokenOk`/`successfulSourceCount`/`totalSourceCount`/
// `sources`/`lastFetchedAt` always reflect the LAST REAL TDX fetch,
// however long ago that was. This is also why TDX must NOT reuse
// health.js's whole-snapshot 10/15-minute staleness rule (that rule is
// about the Cron itself being alive, still valid since this snapshot is
// written on WRITE_ON_CHANGE terms — see V1.9.3 below, not on a fixed
// "every tick" cadence) — TDX positions itself only via
// lastFetchedAt/scheduledThisRun/sleeping, deliberately with no separate
// auto-escalating threshold of its own.
//
// V1.9.3 (KV Write Optimization Phase 2) addition — TWO further changes:
//   1. PBS (see pbsSchedule.js) is no longer fetched every Cron tick
//      either — same carry-forward idiom as TDX above, now applied to the
//      `pbs` block too (see buildHealthSnapshot's `pbsScheduleState`/
//      `previousPbs` params). A PBS skip/sleep tick must never read as a
//      PBS failure, for the exact same reason as TDX above.
//   2. persistHealthSnapshot itself is now WRITE_ON_CHANGE: a tick whose
//      REAL health content (ignoring the handful of fields that only ever
//      represent "this tick ran again" — see stripVolatileTimeFields
//      below) is identical to what's already in KV skips the write
//      entirely. Workers Logs still get a heartbeat every tick regardless
//      (see scheduled.js's own [cron] log lines) — a human must never
//      mistake "KV wasn't rewritten" for "the Worker didn't run".

import { contentEqual } from '../util/contentEqual.js';

const HEALTH_SNAPSHOT_KEY = 'health:snapshot:v1';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

// V1.9.3 (KV Write Optimization Phase 2, item 一) — real Cloudflare
// account alert (see 07_KNOWN_ISSUES.md's V1.9.2/V1.9.3 records): this key
// was rewritten on EVERY Cron tick even when nothing about actual health
// changed at all, because `generatedAt`/`tdx.lastFetchedAt`/
// `pbs.lastFetchedAt` always differ. This is the exact list of fields that
// represent ONLY "this tick ran again", never a real health-state change —
// stripped before comparing two snapshots so "PBS OK -> OK" (only the
// timestamp moved) reads as unchanged, while "PBS OK -> FAIL" (a real
// field flips) always still reads as changed. Deliberately does NOT strip
// `line.lastLinePushAt`: unlike the other two, it only ever moves when a
// real LINE push actually succeeded (see broadcastPipeline.js — it's
// re-read from persisted notified-state and left untouched on a
// no-push tick), so a change there already means real activity, not mere
// bookkeeping — however, per this round's own instruction that ONLY true
// health-state changes should gate the write (not "a push happened"),
// `line.lastLinePushAt` is stripped anyway: `line.pushAttempted`/
// `pushSucceeded`/`partialPushFailures` already carry the real signal a
// human needs, without a timestamp that would force a write merely
// because a push occurred, independent of any actual health change.
function stripVolatileTimeFields(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const clone = structuredClone(snapshot);
  delete clone.generatedAt;
  if (clone.tdx && typeof clone.tdx === 'object') {
    delete clone.tdx.lastFetchedAt;
    // `scheduledThisRun`/`sleeping` are THIS tick's schedule position
    // (tdxSchedule.js), not a health fact — they flip true/false every
    // 20-minute mark by design, same "this tick ran again" category as
    // the timestamps above, just spelled as booleans instead of an ISO
    // string. Discovered via this round's own deterministic fixture
    // (test/kvWriteQuantificationV193.test.js): without stripping these,
    // a genuinely quiet PBS_ONLY day still wrote health:snapshot:v1 on
    // every schedule-state transition (~60/day), defeating WRITE_ON_CHANGE
    // entirely. Trade-off, accepted per this round's own instruction: the
    // STORED snapshot's scheduledThisRun/sleeping can lag until the next
    // REAL content change — /health's "本輪執行狀態" row may show a tick
    // or two old, Workers Logs (unconditional every tick) is the source
    // of truth for "did this exact tick run", not this KV key.
    delete clone.tdx.scheduledThisRun;
    delete clone.tdx.sleeping;
  }
  if (clone.pbs && typeof clone.pbs === 'object') {
    delete clone.pbs.lastFetchedAt;
    delete clone.pbs.scheduledThisRun; // same reasoning as tdx above
    delete clone.pbs.sleeping;
  }
  if (clone.line && typeof clone.line === 'object') delete clone.line.lastLinePushAt;
  // `broadcast` (broadcastRelevantCount/pendingTargetCount/
  // typeIneligibleCount/ineligibleByReason/incidentSuppressedCount) is
  // THIS TICK's own momentary processing counts, not standing health
  // state — none of it feeds computeStatus (unlike partialPushFailures,
  // deliberately left untouched above). Discovered via this round's own
  // deterministic fixture: a single persistent, completely unchanged PBS
  // accident still made incidentSuppressedCount flip 1/0 every round
  // purely because PBS itself only fetches every 30 minutes now (a tick
  // that skipped PBS naturally re-evaluates 0 candidate events) — the
  // exact same "did this tick happen to run" category as scheduledThisRun
  // above, just one level deeper. Excluded for the same reason.
  delete clone.broadcast;
  return clone;
}

/** Exported for tests only — the exact comparison persistHealthSnapshot uses to decide WRITE_ON_CHANGE. */
export function healthSnapshotContentEqual(a, b) {
  return contentEqual(stripVolatileTimeFields(a), stripVolatileTimeFields(b));
}

/**
 * @param {'normal'|'degraded'|'critical'} status inputs, see comment above
 */
function computeStatus({ kvAvailable, lineReady, tdxAllFailed, tdxAnyFailed, pbsFailed, partialPushFailures }) {
  if (!kvAvailable) return 'critical';
  if (!lineReady) return 'critical';
  if (tdxAllFailed && pbsFailed) return 'critical';
  if (tdxAnyFailed || pbsFailed || partialPushFailures > 0) return 'degraded';
  return 'normal';
}

/**
 * Pure — no I/O, no wall-clock reads beyond the `now` passed in.
 *
 * @param {object} summary - TDX pipeline summary (see pipeline.js's
 *   buildSummary, or scheduled.js's own skipped-tick fallback shape) — as
 *   already computed this Cron run.
 * @param {object} pbsSummary - PBS pipeline summary (see pbs/pipeline.js)
 *   — as already computed this Cron run. May be the minimal
 *   `{ pbsOk: false, ... }` fallback shape scheduled.js uses when the PBS
 *   pipeline itself threw; every field is read defensively.
 * @param {object} lineSummary - broadcastPipeline.js's runLineBroadcast
 *   result — as already computed this Cron run.
 * @param {Date} now
 * @param {'scheduled'|'skipped-by-schedule'|'night-sleep'} [tdxScheduleState]
 *   - V1.6.1, see tdxSchedule.js. Defaults to 'scheduled' so every
 *   existing/direct caller (all tests that build a snapshot from a real
 *   fetch) keeps computing the `tdx` block from `summary` unchanged.
 * @param {object|null} [previousTdx] - the `tdx` block from the
 *   PREVIOUSLY persisted snapshot (see readHealthSnapshot), used to carry
 *   real TDX health forward on a tick that didn't fetch. null/undefined
 *   on the very first snapshot ever (nothing to carry forward yet).
 */
export function buildHealthSnapshot({
  summary,
  pbsSummary,
  lineSummary,
  now = new Date(),
  tdxScheduleState = 'scheduled',
  previousTdx = null,
  // V1.9.3 — PBS fetch schedule gate (see pbsSchedule.js). Same
  // three-state idiom as tdxScheduleState; defaults to 'scheduled' so
  // every existing/direct caller (tests that build a snapshot from a real
  // PBS fetch) keeps computing the `pbs` block from `pbsSummary` unchanged.
  pbsScheduleState = 'scheduled',
  // V1.9.3 — the `pbs` block from the PREVIOUSLY persisted snapshot (see
  // readHealthSnapshot), used to carry real PBS health forward on a tick
  // that didn't fetch — same principle as `previousTdx`. null/undefined on
  // the very first snapshot ever.
  previousPbs = null,
  sourceMode = null,
  // 2026-08-25 (CCTV_METADATA_RECOVERY_V1) — describeFreewayCctvMetadata()'s
  // result, carried verbatim. A real 國1 93K accident lost its image because
  // the camera inventory had silently expired out of KV and nothing was
  // allowed to put it back; nobody found out until the accident happened.
  // Surfacing it here means a missing or ancient inventory is visible on
  // /health BEFORE the next one. null when the caller did not supply it.
  cctvMetadata = null,
}) {
  const scheduledThisRun = tdxScheduleState === 'scheduled';
  const sleeping = tdxScheduleState === 'night-sleep';

  let tdx;
  if (scheduledThisRun) {
    const tdxSources = (summary.sources || []).map((s) => ({
      source: s.source,
      label: s.label,
      ok: Boolean(s.ok),
      httpStatus: typeof s.status === 'number' ? s.status : null,
    }));
    tdx = {
      tokenOk: Boolean(summary.tokenOk),
      successfulSourceCount: tdxSources.filter((s) => s.ok).length,
      totalSourceCount: tdxSources.length,
      sources: tdxSources,
      lastFetchedAt: now.toISOString(),
      scheduledThisRun: true,
      sleeping: false,
    };
  } else {
    // This tick did not attempt a TDX fetch at all — carry the LAST REAL
    // fetch's health forward untouched (see module comment above). Only
    // scheduledThisRun/sleeping themselves reflect THIS tick.
    const prior = previousTdx || {};
    tdx = {
      tokenOk: prior.tokenOk ?? null,
      successfulSourceCount: prior.successfulSourceCount ?? 0,
      totalSourceCount: prior.totalSourceCount ?? 0,
      sources: prior.sources ?? [],
      lastFetchedAt: prior.lastFetchedAt ?? null,
      scheduledThisRun: false,
      sleeping,
    };
  }

  // Derived from the (possibly carried-forward) `tdx` block above, NEVER
  // from whether THIS tick happened to fetch — a skip/sleep tick reuses
  // whatever the last real fetch's health was, so it can only ever show
  // degraded/critical if that LAST REAL fetch genuinely had a problem.
  // totalSourceCount===0 (no real fetch yet at all, e.g. moments after a
  // fresh deploy) is treated as "unknown", not "failed" — same reasoning
  // as skip/sleep: absence of data must never be misread as bad data.
  const tdxAllFailed = tdx.totalSourceCount > 0 && tdx.successfulSourceCount === 0;
  const tdxAnyFailed = tdx.totalSourceCount > 0 && tdx.successfulSourceCount < tdx.totalSourceCount;

  // V1.9.3 — same carry-forward idiom as `tdx` above, now that PBS itself
  // is on a schedule gate (pbsSchedule.js) instead of fetching every tick.
  // A 'skipped-by-schedule'/'night-sleep' tick must NEVER be misread as a
  // PBS failure — only `pbsScheduledThisRun`/`pbsSleeping` themselves
  // reflect THIS tick; every other pbs field reuses the LAST REAL fetch's
  // health, however long ago that was.
  const pbsScheduledThisRun = pbsScheduleState === 'scheduled';
  const pbsSleeping = pbsScheduleState === 'night-sleep';

  let pbs;
  if (pbsScheduledThisRun) {
    pbs = {
      ok: Boolean(pbsSummary.pbsOk),
      relayOk: Boolean(pbsSummary.relayOk),
      relayStatus: typeof pbsSummary.relayStatus === 'number' ? pbsSummary.relayStatus : null,
      rawCount: pbsSummary.rawCount ?? 0,
      hsinchuCount: pbsSummary.hsinchuCount ?? 0,
      activeCount: pbsSummary.activeCount ?? 0,
      clearedCount: pbsSummary.clearedCount ?? 0,
      staleCount: pbsSummary.staleCount ?? 0,
      lastFetchedAt: now.toISOString(),
      scheduledThisRun: true,
      sleeping: false,
    };
  } else {
    const prior = previousPbs || {};
    pbs = {
      ok: prior.ok ?? null,
      relayOk: prior.relayOk ?? null,
      relayStatus: prior.relayStatus ?? null,
      rawCount: prior.rawCount ?? 0,
      hsinchuCount: prior.hsinchuCount ?? 0,
      activeCount: prior.activeCount ?? 0,
      clearedCount: prior.clearedCount ?? 0,
      staleCount: prior.staleCount ?? 0,
      lastFetchedAt: prior.lastFetchedAt ?? null,
      scheduledThisRun: false,
      sleeping: pbsSleeping,
    };
  }

  // Derived from the (possibly carried-forward) `pbs` block above, NEVER
  // from whether THIS tick happened to fetch — a skip/sleep tick reuses
  // whatever the last real fetch's health was. `ok === null` (no real PBS
  // fetch yet at all, e.g. moments after a fresh deploy) is treated as
  // "unknown", not "failed" — same reasoning as TDX's totalSourceCount===0.
  const pbsFailed = pbs.ok === false;

  const kvAvailable = Boolean(summary.kvAvailable);
  const lineReady = Boolean(lineSummary.lineReady);
  const partialPushFailures = lineSummary.partialPushFailures || 0;

  const status = computeStatus({
    kvAvailable,
    lineReady,
    tdxAllFailed,
    tdxAnyFailed,
    pbsFailed,
    partialPushFailures,
  });

  return {
    schemaVersion: 2, // V1.6.1: tdx.lastFetchedAt/scheduledThisRun/sleeping, pbs.lastFetchedAt added
    generatedAt: now.toISOString(),
    status,
    // TDX QUOTA PROTECTION (2026-08-23) — surfaced so an engineer (or the
    // next agent) can tell "TDX is deliberately paused for quota" apart
    // from "TDX is broken" without reading code. Carried verbatim from
    // sourceMode.describeSourceMode(env); null when the caller did not
    // supply it (e.g. older tests), never guessed.
    sourceMode: sourceMode ?? null,
    cctvMetadata: cctvMetadata ?? null,

    tdx,

    pbs,

    line: {
      ready: lineReady,
      enabledUsersCount: lineSummary.enabledUsersCount || 0,
      enabledGroupsCount: lineSummary.enabledGroupsCount || 0,
      pushAttempted: lineSummary.pushAttempted || 0,
      pushSucceeded: lineSummary.pushSucceeded || 0,
      partialPushFailures,
      lastLinePushAt: lineSummary.lastLinePushAt || null,
    },

    kv: {
      available: kvAvailable,
    },

    broadcast: {
      broadcastRelevantCount: lineSummary.broadcastRelevantCount || 0,
      pendingTargetCount: lineSummary.pendingTargetCount || 0,
      typeIneligibleCount: lineSummary.typeIneligibleCount || 0,
      ineligibleByReason: lineSummary.ineligibleByReason || {},
      incidentSuppressedCount: lineSummary.incidentSuppressedCount || 0,
    },
  };
}

/**
 * The only write. Never throws — a failure here must never break the Cron
 * run (see scheduled.js).
 *
 * V1.9.3 (KV Write Optimization Phase 2, item 一) — WRITE_ON_CHANGE:
 * `previousSnapshot` (the snapshot already read this tick for the
 * tdx/pbs carry-forward above — no extra KV read needed) is compared
 * against the new one with the volatile timestamp fields stripped (see
 * stripVolatileTimeFields). A truly first-ever snapshot (`previousSnapshot`
 * null/undefined) always writes, establishing the key exactly as before.
 * Returns `written: false` (distinct from `committed`, which stays true —
 * nothing failed) when the write was skipped because content didn't
 * really change, mirroring sharedFeed.js's runSharedFeedPersist shape so
 * scheduled.js's [kv-write-budget] log can report it the same way.
 */
export async function persistHealthSnapshot(kv, snapshot, previousSnapshot = null) {
  if (!kv) return { committed: false, written: false, reason: 'no-kv' };

  if (previousSnapshot && healthSnapshotContentEqual(previousSnapshot, snapshot)) {
    return { committed: true, written: false };
  }

  try {
    await kv.put(HEALTH_SNAPSHOT_KEY, JSON.stringify(snapshot)); // no TTL — staleness is judged by `generatedAt`, not key expiry
    return { committed: true, written: true };
  } catch (err) {
    return { committed: false, written: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/** Read-only. The ONLY thing GET /health is allowed to do — never calls TDX/PBS/LINE. */
export async function readHealthSnapshot(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', snapshot: null };
  }
  try {
    const raw = await kv.get(HEALTH_SNAPSHOT_KEY);
    if (!raw) return { kvAvailable: true, kvError: null, snapshot: null };
    try {
      const parsed = JSON.parse(raw);
      return { kvAvailable: true, kvError: null, snapshot: parsed && typeof parsed === 'object' ? parsed : null };
    } catch {
      return { kvAvailable: true, kvError: null, snapshot: null }; // corrupt blob -> treat as "no snapshot yet"
    }
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), snapshot: null };
  }
}
