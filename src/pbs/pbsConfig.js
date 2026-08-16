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

// Feature flag: PBS events are fetched/normalized/filtered/tracked this
// round, but must never reach the LINE broadcast pipeline yet — see
// broadcastPipeline.js callers in scheduled.js/debugStatus.js, which
// simply never include PBS events in what they pass to runLineBroadcast.
// This flag exists so that fact is explicit and greppable, and so a
// future round can flip it in one place.
export const PBS_BROADCAST_ENABLED = false;
