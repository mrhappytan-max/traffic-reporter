// TDX QUOTA PROTECTION — temporary PBS-only mode (2026-08-23).
//
// WHY THIS EXISTS
// ---------------
// TDX's API quota was exhausted. This module is the single runtime switch
// that stops this Worker making ANY further TDX API call from the Cron
// path, while 警廣 PBS keeps running completely unchanged.
//
// It is deliberately a GATE, not a removal. No TDX module, formatter,
// credential, KV key or R2 object is deleted by this change — the TDX code
// path is intact and dormant, so restoring service is a configuration flip,
// not a re-implementation.
//
// RESTORE ENTRY POINT (the whole restore procedure, in one place)
// --------------------------------------------------------------
//   1. Confirm with TDX that quota is actually available again.
//   2. In wrangler.jsonc, set   "TRAFFIC_SOURCE_MODE": "ALL"
//      (or delete the var entirely — absent means ALL).
//   3. Push to main. Workers Builds redeploys; the next Cron tick resumes
//      TDX freeway/highway fetching and CCTV enrichment on its normal
//      schedule (tdxSchedule.js is untouched by this module).
//   4. Verify: GET /health shows trafficSourceMode=ALL and the next
//      minute-00/20/40 tick reports tdxScheduleState=scheduled.
// Nothing else has to change. There is no second switch.
//
// WHAT IS AND IS NOT GATED
// ------------------------
// Gated (these are the real TDX API callers):
//   - TDX RoadEvent fetching (freeway + highway) on the Cron path
//   - the TDX OAuth token request itself (auth.js hard-guards on this
//     flag, so "0 TDX calls" is enforced mechanically rather than merely
//     arranged by the caller)
//   - CCTV enrichment on the broadcast path
//
// Worth knowing when reasoning about quota: CCTV *frames* are fetched
// from `*.freeway.gov.tw`, NOT from TDX, and the broadcast path reads
// camera metadata from the KV cache rather than calling TDX. So CCTV
// enrichment was already costing 0 TDX calls. It is gated anyway because
// the quota-protection order requires a text-only degrade, and because
// the cached metadata is TDX-derived data.
//
// NOT gated: PBS. Nothing in this module can disable 警廣 PBS — see
// isPbsEnabled() below, which is a constant on purpose.

export const SOURCE_MODE_ALL = 'ALL';
export const SOURCE_MODE_PBS_ONLY = 'PBS_ONLY';

/**
 * Resolve the configured traffic source mode.
 *
 * Strict on purpose: ONLY the exact string 'PBS_ONLY' (case/whitespace
 * insensitive) turns the restriction on. Anything else resolves to ALL —
 * i.e. normal, full-source operation — so a missing var can never silently
 * starve production of TDX data.
 *
 * The trade-off is the opposite failure: a typo ("PBS-ONLY", "pbsonly")
 * would silently keep TDX running and keep burning quota. That is why an
 * unrecognised NON-EMPTY value is logged loudly rather than ignored.
 */
export function resolveTrafficSourceMode(env) {
  const raw = env && typeof env.TRAFFIC_SOURCE_MODE === 'string' ? env.TRAFFIC_SOURCE_MODE.trim().toUpperCase() : '';
  if (raw === SOURCE_MODE_PBS_ONLY) return SOURCE_MODE_PBS_ONLY;
  if (raw !== '' && raw !== SOURCE_MODE_ALL) {
    console.warn(
      `[source-mode] unrecognised TRAFFIC_SOURCE_MODE=${JSON.stringify(env.TRAFFIC_SOURCE_MODE)} — ` +
        `falling back to ${SOURCE_MODE_ALL} (TDX ENABLED). If you meant to protect TDX quota, the exact value is "${SOURCE_MODE_PBS_ONLY}".`
    );
  }
  return SOURCE_MODE_ALL;
}

/** May this Worker make TDX API calls at all (RoadEvent + the OAuth token)? */
export function isTdxRuntimeEnabled(env) {
  return resolveTrafficSourceMode(env) !== SOURCE_MODE_PBS_ONLY;
}

/**
 * May the broadcast path attempt CCTV enrichment?
 *
 * Tied to the same flag rather than given its own: two independent
 * switches would let a future operator restore one and forget the other,
 * and there is no scenario in this incident where "TDX off but CCTV on"
 * is the intended state.
 */
export function isTdxCctvEnabled(env) {
  return isTdxRuntimeEnabled(env);
}

/**
 * PBS is never gated by this module. It is a function (not a bare `true`)
 * so call sites read symmetrically with the TDX ones, and so that any
 * future attempt to make PBS conditional has to change this file — where
 * the "PBS must never be affected" rule is written down.
 */
export function isPbsEnabled() {
  return true;
}

/** Flat, log/health-friendly view of the current mode. */
export function describeSourceMode(env) {
  const mode = resolveTrafficSourceMode(env);
  const tdxEnabled = mode !== SOURCE_MODE_PBS_ONLY;
  return {
    trafficSourceMode: mode,
    tdxRuntimeEnabled: tdxEnabled,
    tdxCctvEnabled: tdxEnabled,
    pbsEnabled: true,
    // Present only while the restriction is on, so a reader is never left
    // guessing whether TDX is broken or deliberately paused.
    tdxPausedReason: tdxEnabled ? null : 'TDX API quota exhausted — temporary PBS-only mode. TDX code is preserved; see src/traffic/sourceMode.js for the restore entry point.',
  };
}
