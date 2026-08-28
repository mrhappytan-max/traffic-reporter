// Centralized PBS (警察廣播電臺) tunables — "不要散落 hard-code". None of
// these have been calibrated against live PBS traffic in this session:
// rtr.pbs.gov.tw is unreachable from this sandbox's network egress policy
// (same constraint that affected TDX in earlier rounds — see
// TDX_SOURCE_AUDIT.md). Recalibrate using GET /debug/pbs's raw/stale
// samples once deployed.

// Abort a single attempt if PBS hasn't responded within this long. Real
// production Cloudflare Worker traffic showed the previous 8s timeout
// tripping ("PBS request timed out after 8000ms") — raised to 15s.
export const PBS_FETCH_TIMEOUT_MS = 15000;

// At most this many total requests (1 initial + retries). Retries only
// happen for timeout/network-error/5xx — never for 4xx (see client.js's
// isRetryableFailure).
export const PBS_MAX_ATTEMPTS = 2;

// Short randomized backoff before the single retry attempt.
export const PBS_RETRY_BACKOFF_MIN_MS = 300;
export const PBS_RETRY_BACKOFF_MAX_MS = 1000;

// How old a NOT-explicitly-cleared PBS event may be (by updatedAt, falling
// back to happenedAt) before we stop treating it as currently active.
// Best-effort default per the "寧可少播" principle already established
// for TDX's effectiveWindow.
export const PBS_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

// Comment text indicating the reporter says the event is over. Keyword-
// based, not full NLP — matches the project's existing classify.js style.
export const CLEARED_COMMENT_PATTERNS = [/已排除/, /排除/, /已解除/, /解除/];

// How long a PBS UID may be *consecutively absent* from the live PBS feed
// before its lifecycle entry is pruned — same principle as TDX's
// ABSENCE_GRACE_PERIOD_MS in dedupe.js, own dedicated KV key though (see
// lifecycle.js), so it doesn't touch TDX's dedupe-state at all.
export const PBS_ABSENCE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

// Cross-source dedup thresholds (PBS vs TDX). Position uses the generous
// end of the spec's "500m-1km" range; TDX events don't carry coordinates
// today, so in practice this only fires when comparing two PBS records or
// once TDX gains coordinates — the km-difference threshold is what
// actually matters for PBS-vs-TDX matching right now.
export const CROSS_SOURCE_MAX_DISTANCE_METERS = 1000;
export const CROSS_SOURCE_MAX_TIME_DIFF_MS = 15 * 60 * 1000; // ±15 minutes
export const CROSS_SOURCE_MAX_KM_DIFF = 2; // km

// Feature flag: whether PBS events (merged with TDX via
// crossSourceDedup.mergeForBroadcast — see scheduled.js/debugStatus.js)
// are allowed to reach the LINE broadcast pipeline. This is the single
// on/off switch: when false, scheduled.js/debugStatus.js pass TDX's own
// event list straight through, unchanged, and PBS is purely observational
// (as it was through V1.3/the VPC relay rollout).
//
// V1.4 Alpha (single existing subscriber, see PROJECT context): flipped to
// true. This does NOT change who receives anything — it only changes
// WHAT the already-existing, already-enabled subscribers can receive
// (TDX events, now merged with matching/unique active PBS events). No
// subscription/target logic changes anywhere else.
export const PBS_BROADCAST_ENABLED = true;

// V1.9.8 — RETIREMENT of Cloudflare's own 30-minute PBS active fetch (order
// section 八). The production main line for PBS is now: Windows local edge
// monitor (fetches PBS every ~3 min, filters, classifies lifecycle) -> POST
// /internal/pbs-debug-push -> pbs/debugPush.js's own call into the SAME
// canonical runLineBroadcast() this file's `PBS_BROADCAST_ENABLED` merge
// path always used — see debugPush.js's module comment. Cloudflare no
// longer needs to fetch PBS itself at all.
//
// This is the module-level DEFAULT scheduled.js reads (see
// resolvePbsPollingEnabled() below) — flipping it back to `true` is the
// entire Production rollback: pbsSchedule.js's getPbsScheduleState(),
// pbs/pipeline.js's runPbsPipelineAndCommit(), and pbs/lifecycle.js's KV
// state machine are all left completely intact and untouched by this
// round, exactly as the order requires ("不要大量刪除可回復程式碼...只關閉
// runtime schedule/path"). Cron itself, TDX fetching, health snapshot,
// Shared Feed, and Pipeline Trace are entirely unaffected by this flag —
// only the PBS HTTP fetch branch of the existing 10-minute Cron tick
// stops firing.
//
// `env.PBS_30_MIN_POLLING_ENABLED` may override this default — same
// established idiom this project already uses for TRAFFIC_SOURCE_MODE/
// LINE_PUSH_POLICY (env-level override, code-level safe default). This
// exists SOLELY so this repo's own large pre-existing PBS/CCTV/dedup test
// suite (which exercises that still-completely-unchanged logic via
// runScheduledTdxSync's PBS-fetch entry point, for real fixture data, not
// because it tests the 30-minute schedule itself) can keep asserting on
// that unchanged logic without being rewritten wholesale — it is NOT a
// Production escape hatch: no Production env var sets it, so real
// deployed behavior is unconditionally `false` (retired) unless a human
// deliberately adds that var to wrangler.jsonc/the Cloudflare dashboard
// for an actual rollback.
//
// Known accepted side effect of retirement (documented, not a bug): with
// this false, `pbs:lifecycle-state` (pbs/lifecycle.js) simply stops being
// updated — Windows tracks PBS lifecycle (NEW/UPDATED/CLEARED, including
// its own 2-consecutive-miss CLEARED debounce) independently on the
// Windows machine, so nothing downstream depended on this KV key being
// live once the Windows ingress became the real source of truth. Likewise
// GET /health's `pbs` block freezes at whatever it last reported before
// retirement (healthSnapshot.js's own carry-forward logic, unchanged) —
// see 07_KNOWN_ISSUES.md's V1.9.8 record.
export const PBS_30_MIN_POLLING_ENABLED = false;

/** See PBS_30_MIN_POLLING_ENABLED's own comment above for the override rule. */
export function resolvePbsPollingEnabled(env) {
  if (env && typeof env.PBS_30_MIN_POLLING_ENABLED === 'boolean') return env.PBS_30_MIN_POLLING_ENABLED;
  return PBS_30_MIN_POLLING_ENABLED;
}
