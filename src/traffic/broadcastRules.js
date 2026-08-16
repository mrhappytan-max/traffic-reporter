// The 60-minute relevance rule for a driving audience: only "happening
// now" or "about to happen very soon" is worth an interruption.

const SIXTY_MINUTES_MS = 60 * 60 * 1000;

/**
 * @param {{ effectiveStart: string|null, effectiveEnd: string|null }} window
 *   - output of computeEffectiveWindow()
 * @param {Date} now
 */
export function isBroadcastRelevant(window, now = new Date()) {
  if (!window || !window.effectiveStart) return false; // can't tell -> don't broadcast

  const startMs = new Date(window.effectiveStart).getTime();
  if (!Number.isFinite(startMs)) return false;

  const nowMs = now.getTime();

  if (window.effectiveEnd) {
    const endMs = new Date(window.effectiveEnd).getTime();
    if (Number.isFinite(endMs) && endMs <= nowMs) return false; // already ended
  }

  if (startMs <= nowMs) return true; // already started (and not ended)

  return startMs <= nowMs + SIXTY_MINUTES_MS; // starts within 60 minutes
}

// V1.5: product repositioning — "路況播報員" no longer interrupts a
// professional driver for ORDINARY traffic flow (they already have
// Google Maps / 1968 for that). This service now exists only for
// sudden/abnormal/hard-for-a-nav-app-to-anticipate events that actually
// change a route decision: accidents, closures, control, and anything
// TDX/PBS can't classify into one of those structured buckets at all
// (falls to 'other' — see tdx/classify.js, pbs/classify.js — which
// covers the "一定播" list's less common cases: 大型掉落物/電線掉落/樹倒/
// 淹水/坍方/橋梁封閉/河川暴漲/火災 etc. already land in 'other' today
// without any new keyword rules needed here).
//
// 'congestion' (any congestionSeverity — 'moderate'/'congested'/even a
// VD-confirmed 'severe', see congestionSeverity.js) is the only type
// excluded. It is NOT removed from data collection anywhere — TDX/PBS
// still fetch/normalize/classify/cluster/VD-validate it exactly as
// before, and it still fully appears in GET /debug/status/GET
// /debug/pbs — only this one broadcast-eligibility gate changed.
//
// If the SAME real incident is independently reported as BOTH
// congestion AND accident/closure/etc (two different source records —
// same-source-different-type records are never merged into one, and
// PBS+TDX cross-source dedup only ever merges matching-type pairs), the
// congestion-typed record is excluded here while the accident/closure/
// etc record broadcasts normally on its own — so the incident still
// reaches LINE exactly once, framed by its more informative type, never
// as bare "壅塞".
const BROADCAST_INELIGIBLE_TYPES = new Set(['congestion']);

/** @param {{ type: string }} event */
export function isBroadcastEligibleType(event) {
  return !BROADCAST_INELIGIBLE_TYPES.has(event && event.type);
}
