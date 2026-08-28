// V1.9.9 Phase 3B — the ONE safety kill switch for Workers AI-driven PBS
// broadcast decisions. Same idiom as pbs/pbsConfig.js's own
// PBS_30_MIN_POLLING_ENABLED / resolvePbsPollingEnabled(env): a safe
// code-level default, optionally overridden by env for testing, NEVER
// declared in Production wrangler.jsonc `vars` (so no Production env var
// flips this on by accident).
//
// WHY THIS EXISTS (order section 十八)
// -------------------------------------
// Claude pushes this round's code to main; Cloudflare Workers Builds then
// auto-deploys it. At that moment the `AI` binding (Workers AI) may not
// exist yet in the real Cloudflare Dashboard — GPT Work still has to
// create it, verify it, and only then explicitly enable AI decisions.
// If this defaulted to true, a deploy landing before the binding exists
// would make every genuinely accepted Windows PBS event fail the AI call
// (env.AI undefined) and, per this round's own fail-closed AI failure
// policy (never fall back to the legacy hard-rule decision — see
// traffic/aiApprovedPbsBroadcast.js's module comment), silently push
// ZERO of them to LINE — a real Production regression from a repo push
// alone, before any human decision to activate AI. Defaulting to false
// means: code deployed -> AI decision disabled -> the existing V1.9.8/
// Phase 2 legacy path (traffic/broadcastPipeline.js#runLineBroadcast)
// keeps running exactly as it already does today -> GPT Work sets up and
// verifies the binding -> a human explicitly flips this on.
export const PBS_AI_DECISION_ENABLED_DEFAULT = false;

// V1.9.9 Phase 3D hotfix — Cloudflare Dashboard/CLI Variables are injected
// into the Worker as STRINGS, never as real booleans. GPT Work set
// PBS_AI_DECISION_ENABLED = "true" in the Dashboard; the strict
// `typeof === 'boolean'` check below never matched a string, so Production
// silently stayed on the legacy path — not a Dashboard mistake, a resolver
// bug. Fix: accept the real boolean AND the Cloudflare-runtime string form
// (case-insensitive, trimmed), everything else — including other common
// truthy spellings like "1"/"yes"/"on" that this repo's config convention
// has never used elsewhere (see pbsConfig.js#resolvePbsPollingEnabled,
// same boolean-only idiom) — fails safe to false. No loose truthy check.
const TRUE_STRING = 'true';
const FALSE_STRING = 'false';

/** See PBS_AI_DECISION_ENABLED_DEFAULT's own comment for the override rule. */
export function resolvePbsAiDecisionEnabled(env) {
  const raw = env && env.PBS_AI_DECISION_ENABLED;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === TRUE_STRING) return true;
    if (normalized === FALSE_STRING) return false;
  }
  return PBS_AI_DECISION_ENABLED_DEFAULT;
}
