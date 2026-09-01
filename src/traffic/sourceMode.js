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

// V2.4.0 — TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE, order section
// 五/十二. Granular source switches, ADDITIONAL to (never a replacement
// for) TRAFFIC_SOURCE_MODE above — order section 四's own explicit
// instruction: "不得直接 TRAFFIC_SOURCE_MODE = ALL". TRAFFIC_SOURCE_MODE
// stays exactly as it is (PBS_ONLY today); these three new vars are how
// TDX RoadEvent fetch / Queue ingress / CCTV metadata refresh get their
// OWN independent on/off switches instead of inheriting one coarse
// binary flag that also happens to control everything else TDX. Each
// resolver below follows the EXACT same strict-string-parsing discipline
// TRAFFIC_SOURCE_MODE/PBS_AI_DECISION_ENABLED already established in this
// codebase (Cloudflare injects Workers Variables as strings, never a bare
// JSON boolean — see PBS_AI_DECISION_ENABLED's own V1.9.9 Phase 3D
// history in 07_KNOWN_ISSUES.md): only the exact string 'true'
// (case/whitespace-insensitive) turns a switch on; anything else
// (missing, 'false', a typo) is off. All three DEFAULT OFF — this round
// builds the mechanism; a human operator flips these in wrangler.jsonc
// when ready to actually begin Phase A (order section 二十), never this
// round itself (see this round's own final report for why: making real
// TDX API calls spends real, previously-exhausted quota, a production
// decision this codebase has always treated as requiring an explicit,
// separate operator action — see TDX_QUOTA_PROTECTION_PBS_ONLY's own
// sealed history).
function resolveBooleanVar(env, varName) {
  const raw = env && typeof env[varName] === 'string' ? env[varName].trim().toLowerCase() : '';
  return raw === 'true';
}

/** May the Cron path fetch TDX freeway/highway RoadEvent data at all this tick (independent of TRAFFIC_SOURCE_MODE)? Phase A gate. */
export function isTdxRoadEventFetchEnabled(env) {
  return resolveBooleanVar(env, 'TDX_ROADEVENT_FETCH_ENABLED');
}

/** May a fetched new/updated TDX freeway/highway event be enqueued onto PBS_AI_QUEUE for AI judgment? Phase B gate — see debugPush.js's own V2.4.0 comment for why this still never reaches a real LINE push on its own. */
export function isTdxRoadEventQueueIngressEnabled(env) {
  return resolveBooleanVar(env, 'TDX_ROADEVENT_QUEUE_INGRESS_ENABLED');
}

/** May the Admin-Auth-gated /admin/cctv-hsinchu-probe actually call TDX to refresh cctv:freeway-metadata:v1? Independent of the two switches above — CCTV metadata refresh stays manual/on-demand either way (order section 三), this only decides whether that manual trigger is itself allowed to make the one TDX call it needs. */
export function isTdxCctvMetadataRefreshEnabled(env) {
  return resolveBooleanVar(env, 'TDX_CCTV_METADATA_REFRESH_ENABLED');
}

/**
 * The ONE gate tdx/auth.js actually enforces before ever issuing a TDX
 * OAuth token — broadened (V2.4.0) from "is TRAFFIC_SOURCE_MODE not
 * PBS_ONLY" to "is TDX access permitted for ANY reason right now",
 * because auth.js has no way to know which of the three call sites above
 * is asking (it's a single shared token layer) — the FINER distinction
 * (does RoadEvent fetch itself proceed, does the CCTV probe itself
 * proceed) is enforced separately, at each call site, using the specific
 * resolver functions above. This function is purely additive: with all
 * three new switches at their default (false), it evaluates to EXACTLY
 * isTdxRuntimeEnabled(env) — today's behavior, unchanged byte-for-byte.
 */
export function isTdxTokenAccessPermitted(env) {
  return isTdxRuntimeEnabled(env) || isTdxRoadEventFetchEnabled(env) || isTdxCctvMetadataRefreshEnabled(env);
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
  const roadEventFetchEnabled = isTdxRoadEventFetchEnabled(env);
  const roadEventQueueIngressEnabled = isTdxRoadEventQueueIngressEnabled(env);
  const cctvMetadataRefreshEnabled = isTdxCctvMetadataRefreshEnabled(env);
  return {
    trafficSourceMode: mode,
    tdxRuntimeEnabled: tdxEnabled,
    // CCTV images are independent of the TDX gate (frames come from
    // freeway.gov.tw, metadata from the KV cache) — see
    // isCctvImageEnabled.
    cctvImageEnabled: isCctvImageEnabled(env),
    // V2.4.0 — tdxCctvMetadataRefreshEnabled now reflects the dedicated
    // TDX_CCTV_METADATA_REFRESH_ENABLED switch (isTdxCctvMetadataRefreshEnabled),
    // no longer pinned 1:1 to the coarse TDX runtime gate — see this
    // module's own V2.4.0 comment block above for the full reasoning.
    // `|| tdxEnabled` keeps this permissive under TRAFFIC_SOURCE_MODE=ALL
    // even before anyone sets the new var explicitly, so a legacy
    // "restore TDX" (flip TRAFFIC_SOURCE_MODE back to ALL) still behaves
    // the way 07_KNOWN_ISSUES.md's existing RESTORE TDX procedure
    // documents, unchanged.
    tdxCctvMetadataRefreshEnabled: cctvMetadataRefreshEnabled || tdxEnabled,
    tdxCctvEnabled: isCctvImageEnabled(env),
    pbsEnabled: true,
    // V2.4.0 — the two new granular RoadEvent switches, surfaced
    // read-only for /health and Pipeline Trace-style observability (order
    // section 十六). Neither is derived from tdxEnabled — see
    // isTdxRoadEventFetchEnabled/isTdxRoadEventQueueIngressEnabled.
    tdxRoadEventFetchEnabled: roadEventFetchEnabled,
    tdxRoadEventQueueIngressEnabled: roadEventQueueIngressEnabled,
    // Present only while the restriction is on, so a reader is never left
    // guessing whether TDX is broken or deliberately paused.
    tdxPausedReason: tdxEnabled ? null : 'TDX API quota exhausted — temporary PBS-only mode. TDX code is preserved; see src/traffic/sourceMode.js for the restore entry point.',
  };
}
