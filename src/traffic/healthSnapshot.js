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
 *   buildSummary) — as already computed this Cron run.
 * @param {object} pbsSummary - PBS pipeline summary (see pbs/pipeline.js)
 *   — as already computed this Cron run. May be the minimal
 *   `{ pbsOk: false, ... }` fallback shape scheduled.js uses when the PBS
 *   pipeline itself threw; every field is read defensively.
 * @param {object} lineSummary - broadcastPipeline.js's runLineBroadcast
 *   result — as already computed this Cron run.
 * @param {Date} now
 */
export function buildHealthSnapshot({ summary, pbsSummary, lineSummary, now = new Date() }) {
  const tdxSources = (summary.sources || []).map((s) => ({
    source: s.source,
    label: s.label,
    ok: Boolean(s.ok),
    httpStatus: typeof s.status === 'number' ? s.status : null,
  }));
  const successfulSourceCount = tdxSources.filter((s) => s.ok).length;
  const totalSourceCount = tdxSources.length;
  const tdxAllFailed = totalSourceCount > 0 && successfulSourceCount === 0;
  const tdxAnyFailed = successfulSourceCount < totalSourceCount;

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
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    status,

    tdx: {
      tokenOk: Boolean(summary.tokenOk),
      successfulSourceCount,
      totalSourceCount,
      sources: tdxSources,
    },

    pbs: {
      ok: Boolean(pbsSummary.pbsOk),
      relayOk: Boolean(pbsSummary.relayOk),
      relayStatus: typeof pbsSummary.relayStatus === 'number' ? pbsSummary.relayStatus : null,
      rawCount: pbsSummary.rawCount ?? 0,
      hsinchuCount: pbsSummary.hsinchuCount ?? 0,
      activeCount: pbsSummary.activeCount ?? 0,
      clearedCount: pbsSummary.clearedCount ?? 0,
      staleCount: pbsSummary.staleCount ?? 0,
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
