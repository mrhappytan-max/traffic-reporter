// V1.4.1: TDX's RoadEvent normalizer and PBS's classifier both used to
// collapse "車多" (traffic is heavier than usual) and "壅塞"/"回堵"/"塞車"
// (genuinely congested/backed up) into the same bare `type: 'congestion'`,
// which messageFormat.js then always rendered as "🐢 嚴重壅塞" ("SEVERE
// congestion") — a real production bug: a mere "車多" report should never
// read as "severe".
//
// This module keeps `type` completely unchanged (still 'congestion' —
// congestionCluster.js, notified.js's cooldown path, and effectiveWindow's
// LIVE_TYPES all key off it and must keep working exactly as before) and
// adds a SEPARATE `congestionSeverity` field with three levels:
//
//   'moderate'  — "車多" text only. Renders as "車流偏多".
//   'congested' — "壅塞"/"回堵"/"塞車"/"擁擠"/"車潮" text (or the type was
//                 classified as congestion with no specific subtype
//                 keyword at all — a safe middle default). Renders as
//                 "壅塞".
//   'severe'    — NEVER set by keyword text alone. Only
//                 congestionValidation.js (real-time VD speed
//                 confirmation) is allowed to upgrade an event to this
//                 level. Renders as "嚴重壅塞".
//
// See messageFormat.js for the actual label/emoji/impact-line mapping.

const CONGESTION_SEVERITY_RULES = [
  // Checked BEFORE 'moderate' on purpose: if a report mentions BOTH
  // ("車多回堵" is common real phrasing), the stronger word wins.
  { severity: 'congested', patterns: [/壅塞/, /回堵/, /塞車/, /擁擠/, /車潮/] },
  { severity: 'moderate', patterns: [/車多/] },
];

/**
 * @param {string} text - the same source text that led to `type` being
 *   classified as 'congestion' (EventType/EventSubType/Category/
 *   description for TDX RoadEvent; CMS/bus alert text; PBS roadtype+
 *   comment).
 * @returns {'congested'|'moderate'|null} null when no recognizable
 *   subtype keyword is present at all — callers should treat null as
 *   'congested' (the safe middle default), never as 'severe'.
 */
export function classifyCongestionSeverity(text) {
  if (!text || typeof text !== 'string') return null;
  for (const { severity, patterns } of CONGESTION_SEVERITY_RULES) {
    if (patterns.some((p) => p.test(text))) return severity;
  }
  return null;
}

const SEVERITY_RANK = { severe: 3, congested: 2, moderate: 1 };

/** The more severe of two (possibly null/undefined) severities — used to merge congestionCluster.js members. */
export function mostSevereCongestion(a, b) {
  const rankA = SEVERITY_RANK[a] || 0;
  const rankB = SEVERITY_RANK[b] || 0;
  return rankB > rankA ? b || null : a || null;
}

/** What messageFormat.js/callers should treat an event as when `congestionSeverity` is null/unrecognized — see module comment. */
export const DEFAULT_CONGESTION_SEVERITY = 'congested';
