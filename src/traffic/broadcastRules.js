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
