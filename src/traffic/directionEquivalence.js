// Single shared table of semantically-equivalent direction terms this
// project's sources use — 北上/南下/東行/西行/南行/北行 (PBS's own
// vocabulary) all mean exactly the same thing as this project's
// canonical 北向/南向/東向/西向 form. Extracted out of pbs/normalize.js
// (V1.8.6.8) into its own module specifically so BOTH pbs/normalize.js
// (which still exports `normalizePbsDirection` unchanged, for every
// existing importer) and traffic/pipelineTrace.js (which needs the SAME
// equivalence table to avoid flagging "北上" vs "北向" as a real
// DIRECTION_CHANGED anomaly) can import it without creating a circular
// dependency — pbs/normalize.js already imports buildUpstreamSnapshot
// FROM pipelineTrace.js (V1.8.6.7), so pipelineTrace.js importing
// normalizePbsDirection back FROM pbs/normalize.js would cycle.
//
// Not PBS-specific despite the historical name/origin — this is reused
// verbatim, never duplicated, by any consumer that needs to know two
// direction strings mean the same real-world direction.

const DIRECTION_MAP = {
  北上: '北向',
  南下: '南向',
  東行: '東向',
  西行: '西向',
  南行: '南向',
  北行: '北向',
  東向: '東向',
  西向: '西向',
  南向: '南向',
  北向: '北向',
};

/**
 * Maps any of this project's known equivalent direction terms onto the
 * canonical 北向/南向/東向/西向 form. An already-canonical value (or
 * anything unrecognized, e.g. "雙向") passes through unchanged — this
 * never guesses at a term it doesn't recognize.
 */
export function normalizePbsDirection(direction) {
  if (!direction) return '';
  const trimmed = String(direction).trim();
  return DIRECTION_MAP[trimmed] || trimmed;
}
