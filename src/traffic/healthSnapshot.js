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
// tick during 08:00–22:00 Asia/Taipei (see tdxSchedule.js); PBS still
// writes this snapshot every tick, 24/7. A tick that did NOT attempt a
// TDX fetch (skipped-by-schedule, or night-sleep) must NEVER be read as a
// TDX failure — see the requirement "TDX skipped/sleeping 不得因此降級".
// Handled by carrying the `tdx` block FORWARD unchanged from the previous
// snapshot whenever this tick didn't fetch — only `tdx.scheduledThisRun`/
// `tdx.sleeping` themselves reflect THIS tick; `tdx.tokenOk`/
// `successfulSourceCount`/`totalSourceCount`/`sources`/`lastFetchedAt`
// always reflect the LAST REAL TDX fetch, however long ago that was. This
// is also why TDX must NOT reuse health.js's whole-snapshot 10/15-minute
// staleness rule (that rule is about the Cron itself being alive, still
// valid since PBS keeps generatedAt fresh every 10 min) — TDX positions
// itself only via lastFetchedAt/scheduledThisRun/sleeping, deliberately
// with no separate auto-escalating threshold of its own.

const HEALTH_SNAPSHOT_KEY = 'health:snapshot:v1';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
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

  const pbsFailed = !pbsSummary.pbsOk;

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

    tdx,

    pbs: {
      ok: Boolean(pbsSummary.pbsOk),
      relayOk: Boolean(pbsSummary.relayOk),
      relayStatus: typeof pbsSummary.relayStatus === 'number' ? pbsSummary.relayStatus : null,
      rawCount: pbsSummary.rawCount ?? 0,
      hsinchuCount: pbsSummary.hsinchuCount ?? 0,
      activeCount: pbsSummary.activeCount ?? 0,
      clearedCount: pbsSummary.clearedCount ?? 0,
      staleCount: pbsSummary.staleCount ?? 0,
      // PBS runs unconditionally every Cron tick (24/7, no schedule gate
      // — see scheduled.js), so this is always "now": PBS just attempted
      // a fetch this tick, whether or not it succeeded.
      lastFetchedAt: now.toISOString(),
    },

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

/** The only write. Never throws — a failure here must never break the Cron run (see scheduled.js). */
export async function persistHealthSnapshot(kv, snapshot) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    await kv.put(HEALTH_SNAPSHOT_KEY, JSON.stringify(snapshot)); // no TTL — staleness is judged by `generatedAt`, not key expiry
    return { committed: true };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
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
