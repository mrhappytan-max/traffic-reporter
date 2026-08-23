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
 * 2026-08-23 — this is now INDEPENDENT of the TDX gate, and the change is
 * evidence-driven rather than a relaxation of the quota rule.
 *
 * When PBS-only mode was introduced this returned isTdxRuntimeEnabled(),
 * on the assumption that CCTV cost TDX quota. It does not. The broadcast
 * CCTV path reads camera metadata from the KV cache
 * (cctv/freewayCctvMetadataCache.js — "Read-only, cache-only — NEVER
 * calls TDX") and fetches frames from `*.freeway.gov.tw`, which is the
 * Freeway Bureau, not TDX. cctv/dynamicCollage.js imports neither
 * tdx/auth.js nor tdx/client.js, so no CCTV attempt can mint a TDX token
 * or refresh TDX metadata — the guarantee is structural, not a promise.
 *
 * So gating CCTV bought zero quota while costing every accident push its
 * picture. The product decision of 2026-08-23 (重大事故限定 LINE Push)
 * wants that picture back for the few events that still push.
 *
 * The quota guarantee is unaffected and still enforced in two places
 * that this function cannot reach: isTdxRuntimeEnabled() below, and
 * tdx/auth.js's hard refusal to issue a token in PBS_ONLY mode. If some
 * future edit ever did put a TDX call behind CCTV, it would fail closed
 * there rather than silently burn quota.
 */
export function isCctvImageEnabled(env) {
  const raw = env && typeof env.CCTV_IMAGE_ENABLED === 'string' ? env.CCTV_IMAGE_ENABLED.trim().toUpperCase() : '';
  return raw !== 'FALSE' && raw !== '0' && raw !== 'OFF';
}

/**
 * @deprecated Kept so nothing that still imports the old name silently
 * changes meaning. Now an explicit alias of isCctvImageEnabled — CCTV is
 * no longer tied to the TDX runtime gate; see that function for why.
 */
export function isTdxCctvEnabled(env) {
  return isCctvImageEnabled(env);
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
    // CCTV images are independent of the TDX gate (frames come from
    // freeway.gov.tw, metadata from the KV cache) — see
    // isCctvImageEnabled. tdxCctvMetadataRefreshEnabled stays pinned to
    // the TDX gate: reading the cache is allowed, refilling it from TDX
    // is not.
    cctvImageEnabled: isCctvImageEnabled(env),
    tdxCctvMetadataRefreshEnabled: tdxEnabled,
    tdxCctvEnabled: isCctvImageEnabled(env),
    pbsEnabled: true,
    // Present only while the restriction is on, so a reader is never left
    // guessing whether TDX is broken or deliberately paused.
    tdxPausedReason: tdxEnabled ? null : 'TDX API quota exhausted — temporary PBS-only mode. TDX code is preserved; see src/traffic/sourceMode.js for the restore entry point.',
  };
}
