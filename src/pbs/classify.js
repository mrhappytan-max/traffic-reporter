// Classifies a PBS record into the existing unified `type` enum
// (accident|construction|closure|control|congestion|alert|other) based on
// roadtype + comment. Several PBS categories (散落物/故障車/危險駕駛 etc.)
// deliberately collapse to "other" rather than expanding the enum — but
// `pbsCategory` keeps the finer-grained PBS-native label for internal use
// (message building, cross-source matching, /debug/pbs visibility).

const ACCIDENT_PATTERNS = [/事故/, /擦撞/, /追撞/, /自撞/, /對撞/, /相撞/, /撞及/];
const OBSTRUCTION_PATTERNS = [/散落物/, /輪胎皮/, /保險桿/, /布鉤繩/, /掉落物/, /異物/, /落物/];
const BREAKDOWN_PATTERNS = [/故障車/, /拋錨/];
const CONSTRUCTION_PATTERNS = [/施工/, /道路工程/, /維修工程/];
const CONTROL_PATTERNS = [/交通管制/, /匝道儀控/, /封閉/, /管制/];
const CONGESTION_PATTERNS = [/壅塞/, /回堵/, /車多/, /車潮/];
const DANGEROUS_DRIVING_PATTERNS = [/危險駕駛/, /蛇行/, /路肩逆向/, /逆向行駛/, /大型車異常/];

/**
 * @param {{ roadtype?: string, comment?: string }} input
 * @returns {{ type: string, pbsCategory: string }}
 */
export function classifyPbsEvent({ roadtype, comment }) {
  const text = `${roadtype || ''} ${comment || ''}`;

  if (ACCIDENT_PATTERNS.some((p) => p.test(text))) return { type: 'accident', pbsCategory: 'accident' };
  if (OBSTRUCTION_PATTERNS.some((p) => p.test(text))) return { type: 'other', pbsCategory: 'obstruction' };
  if (BREAKDOWN_PATTERNS.some((p) => p.test(text))) return { type: 'other', pbsCategory: 'breakdown' };
  if (CONSTRUCTION_PATTERNS.some((p) => p.test(text))) return { type: 'construction', pbsCategory: 'construction' };
  if (CONTROL_PATTERNS.some((p) => p.test(text))) return { type: 'control', pbsCategory: 'control' };
  if (CONGESTION_PATTERNS.some((p) => p.test(text))) return { type: 'congestion', pbsCategory: 'congestion' };
  if (DANGEROUS_DRIVING_PATTERNS.some((p) => p.test(text))) return { type: 'other', pbsCategory: 'dangerous-driving' };

  return { type: 'other', pbsCategory: 'other' };
}
