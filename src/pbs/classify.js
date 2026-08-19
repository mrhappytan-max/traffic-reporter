// Classifies a PBS record into the existing unified `type` enum
// (accident|construction|closure|control|congestion|alert|other) based on
// roadtype + comment. Several PBS categories (散落物/故障車/危險駕駛 etc.)
// deliberately collapse to "other" rather than expanding the enum — but
// `pbsCategory` keeps the finer-grained PBS-native label for internal use
// (message building, cross-source matching, /debug/pbs visibility).
//
// V1.8.6.4 (provenance gap, follow-up round): also returns
// `classificationSource` — debug-only, WHICH field (`roadtype`/`comment`/
// both) the winning keyword actually matched in, from this SAME decision
// (not a second classification pass — the matched pattern itself is
// reused to test `roadtype`/`comment` individually, purely for
// provenance). `null` only when nothing matched at all (the final 'other'/
// 'other' fallback). Never read by anything except
// broadcastProvenance.js's debug record.

const ACCIDENT_PATTERNS = [/事故/, /擦撞/, /追撞/, /自撞/, /對撞/, /相撞/, /撞及/];
const OBSTRUCTION_PATTERNS = [/散落物/, /輪胎皮/, /保險桿/, /布鉤繩/, /掉落物/, /異物/, /落物/];
const BREAKDOWN_PATTERNS = [/故障車/, /拋錨/];
const CONSTRUCTION_PATTERNS = [/施工/, /道路工程/, /維修工程/];
const CONTROL_PATTERNS = [/交通管制/, /匝道儀控/, /封閉/, /管制/];
const CONGESTION_PATTERNS = [/壅塞/, /回堵/, /車多/, /車潮/];
const DANGEROUS_DRIVING_PATTERNS = [/危險駕駛/, /蛇行/, /路肩逆向/, /逆向行駛/, /大型車異常/];

const CLASSIFICATION_RULES = [
  { patterns: ACCIDENT_PATTERNS, type: 'accident', pbsCategory: 'accident' },
  { patterns: OBSTRUCTION_PATTERNS, type: 'other', pbsCategory: 'obstruction' },
  { patterns: BREAKDOWN_PATTERNS, type: 'other', pbsCategory: 'breakdown' },
  { patterns: CONSTRUCTION_PATTERNS, type: 'construction', pbsCategory: 'construction' },
  { patterns: CONTROL_PATTERNS, type: 'control', pbsCategory: 'control' },
  { patterns: CONGESTION_PATTERNS, type: 'congestion', pbsCategory: 'congestion' },
  { patterns: DANGEROUS_DRIVING_PATTERNS, type: 'other', pbsCategory: 'dangerous-driving' },
];

const PROVENANCE_VALUE_MAX_CHARS = 80;
function truncateForDebug(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > PROVENANCE_VALUE_MAX_CHARS ? `${text.slice(0, PROVENANCE_VALUE_MAX_CHARS)}…` : text;
}

/** Which of the two raw fields the ALREADY-matched pattern also matches individually — provenance only, never a second classification decision. */
function fieldForMatch(roadtype, comment, pattern) {
  const inRoadtype = pattern.test(roadtype || '');
  const inComment = pattern.test(comment || '');
  if (inRoadtype && inComment) return 'roadtype+comment';
  if (inRoadtype) return 'roadtype';
  if (inComment) return 'comment';
  return 'roadtype+comment'; // defensive: matched only across the joined "roadtype comment" text itself
}

/**
 * @param {{ roadtype?: string, comment?: string }} input
 * @returns {{ type: string, pbsCategory: string, classificationSource: {field:string,value:string}|null }}
 */
export function classifyPbsEvent({ roadtype, comment }) {
  const text = `${roadtype || ''} ${comment || ''}`;

  for (const rule of CLASSIFICATION_RULES) {
    const matchedPattern = rule.patterns.find((p) => p.test(text));
    if (matchedPattern) {
      const match = text.match(matchedPattern);
      const field = fieldForMatch(roadtype, comment, matchedPattern);
      return {
        type: rule.type,
        pbsCategory: rule.pbsCategory,
        classificationSource: { field, value: truncateForDebug(match ? match[0] : '') },
      };
    }
  }

  return { type: 'other', pbsCategory: 'other', classificationSource: null };
}
