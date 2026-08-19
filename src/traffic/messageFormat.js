// Builds the short LINE text for a driving audience. Never dumps the raw
// TDX Description onto the message — always a short, synthesized line set
// built from road/direction/location/type.
//
// V1.2C: the first two lines used to repeat "road direction" twice (e.g.
// "國道一號 北向\n國道一號 北向 91K+000 - 82K+400" — the exact bug reported
// from production) and showed raw KM markers a driver can't place on a
// map. Now: line 1 is a short road name + direction + (when resolvable) a
// human section label ("國1 北向｜竹北－湖口路段"); line 2 is purely the KM
// range ("91K+000～82K+400") as a second layer of detail — never both the
// road name AND the KM crammed onto one repeated line. See
// roadSectionLabel.js for the KM→interchange mapping (國道一號/國道三號
// only this round — everything else falls back to the original
// location-based line, per "不要擴大 scope").
//
// V1.8.6.4 — reported symptom (台3線): a 省道 LINE message showed only
// bare KM, with no place-name context at all — because line 1 only ever
// considered `getRoadSectionLabel()`'s curated 國1/國3 anchor table, and
// any road outside that table (every 省道) has nothing else to fall back
// on. NOTE — provenance-audit correction: this repo has no persisted raw
// TDX payload for the specific historical event that was reported, so
// whether that ONE event actually carried a populated human location
// field TDX's own `composeLocation()` then shadowed is NOT independently
// confirmed (see PROJECT_HANDOFF.md's "V1.8.6.4 — provenance audit"
// section). What IS confirmed, by reading
// `tdx/normalize.js`'s old code directly (a structural fact, not
// dependent on any one event): whenever structured KM was present,
// `composeLocation()` UNCONDITIONALLY shadowed any human location text a
// raw record might carry, before it ever reached this file — a genuine
// bug regardless of whether it fired on that specific historical event.
// Fixed at the source (see that module's own comment, including the
// per-field confidence levels for `LocationDescription`/
// `Location.Description`/`RoadSection` — none of them are confirmed to
// exist on a real RoadEvent response) by preserving them as a NEW,
// separate, fully optional `event.locationDescription` field; this file
// now prefers that genuine source text (when present) over an
// anchor-table label whenever it looks like real place text (not just
// another KM string) — see `pickHumanLocationText` below. Priority, per
// the round's own principle
// ("來源本來有的人類位置資訊 > 經可靠對照的路段名稱 > KM > 不顯示"):
//   1. `event.locationDescription` (TDX-supplied human text, filtered)
//   2. `getRoadSectionLabel()`'s curated anchor label (國1/國3 only —
//      no fabricated anchor table was added for 台1/台3/etc since this
//      repo has no independently-confirmed KM-anchor data for them;
//      guessing interchange positions is exactly what this project's
//      "不要猜" rule forbids)
//   3. raw KM (unchanged, second line)
//   4. nothing (bare road+direction only — never an invented address)
// Deliberately NEVER extended to PBS's own `event.location` (areaNm) —
// that field is already covered by V1.8.5.1's own explicit "KM must win
// over a route-name-shaped location string" regression test, which this
// round must not regress (see required regression test 10 below / this
// file's own test suite).

import { getRoadShortName, getRoadSectionLabel } from './roadSectionLabel.js';
import { DEFAULT_CONGESTION_SEVERITY } from './congestionSeverity.js';

const TYPE_EMOJI = {
  accident: '🚨',
  construction: '🚧',
  closure: '🚧',
  control: '⚠️',
  alert: 'ℹ️',
  other: 'ℹ️',
};

const TYPE_LABEL = {
  accident: '交通事故',
  construction: '道路施工',
  closure: '道路封閉',
  control: '交通管制',
  alert: '公車異動',
  other: '路況異常',
};

const TYPE_IMPACT_LINES = {
  accident: '事故影響通行\n請提前避開',
  construction: '施工影響通行\n請注意車道',
  closure: '道路封閉\n請改道行駛',
  control: '交通管制中\n請配合疏導',
  alert: '營運異動\n請留意公告',
  other: '請留意路況',
};

// V1.8.6.4 — direction-aware impact wording. `event.direction === '雙向'`
// is a real structured TDX/PBS field, not a guess — so when it's set,
// naming it in the impact line ("雙向施工管制" instead of a direction-
// silent "施工影響通行") gives the driver real information the source
// already supports. Deliberately does NOT invent extra severity: a
// construction event still reads "雙向施工管制" (management/control),
// never "雙向道路封閉" — only `type==='closure'` ever says 封閉. Only the
// 4 types that actually reach a driver's LINE message today
// (accident/construction/closure/control — congestion is never
// broadcast, per broadcastRules.js) have a variant; `other`/`alert` keep
// their existing direction-silent wording unchanged, since this project
// has no reliably structured signal for which direction(s) an 'other'
// anomaly actually impacts.
const BIDIRECTIONAL_IMPACT_LINES = {
  accident: '事故影響雙向通行\n請提前避開',
  construction: '雙向施工管制\n請注意車道',
  closure: '雙向道路封閉\n請改道行駛',
  control: '雙向交通管制\n請配合疏導',
};

// V1.8.6.4 — production repro: an 'other'-typed event that legitimately
// passed broadcastRules.js's OTHER_ANOMALY_PATTERNS eligibility gate
// (積水/落石/坍方/樹倒/電線掉落/掉落物/火災/橋梁異常/道路中斷/etc — see
// that module) still rendered as a generic "ℹ️ 路況異常" here, because
// this file never looked at WHICH keyword matched, only that `type`
// stayed 'other'. Fixed with a display-only re-classification (does NOT
// touch `event.type`, dedupe/fingerprint semantics, or broadcast
// eligibility itself — those all still key off the plain 'other' type,
// completely unchanged) that picks the single most specific label for
// the headline. `無法通行` is deliberately excluded from this table (it
// only says "impassable", not WHY — no specific icon/label to show
// without guessing a cause that isn't actually in the source text).
const ANOMALY_DETAIL_RULES = [
  { emoji: '🌊', label: '道路積水', patterns: [/淹水/, /積水/, /涵洞/, /河川暴漲/, /溪水暴漲/] },
  { emoji: '⛰️', label: '落石', patterns: [/落石/] },
  { emoji: '⛰️', label: '邊坡坍方', patterns: [/坍方/, /路基流失/] },
  { emoji: '🌳', label: '路樹倒塌', patterns: [/樹倒/] },
  { emoji: '⚡', label: '電線倒塌', patterns: [/電線掉落/, /電線桿倒/] },
  { emoji: '⚠️', label: '掉落物', patterns: [/掉落物/, /貨物散落/] },
  { emoji: '🔥', label: '火災', patterns: [/火災/] },
  { emoji: '⚠️', label: '橋梁異常', patterns: [/橋梁封閉/, /橋梁異常/] },
  { emoji: '⚠️', label: '道路中斷', patterns: [/道路中斷/] },
];

// PBS already carries a finer-grained, STRUCTURED category
// (`pbsCategory` — see pbs/classify.js) for exactly this situation, more
// reliable than re-parsing free text — checked first, before falling
// back to the keyword table above (which still applies to a plain TDX
// 'other' event, which has no `pbsCategory` at all).
const PBS_CATEGORY_ANOMALY_DETAIL = {
  obstruction: { emoji: '⚠️', label: '掉落物' },
  breakdown: { emoji: '🚗', label: '故障車' },
  'dangerous-driving': { emoji: '⚠️', label: '危險駕駛' },
};

/** @returns {{emoji:string,label:string}|null} null -> keep the generic "ℹ️ 路況異常" (never guessed beyond what the source text/category actually says). */
function resolveOtherAnomalyDetail(event) {
  if (event.pbsCategory && PBS_CATEGORY_ANOMALY_DETAIL[event.pbsCategory]) {
    return PBS_CATEGORY_ANOMALY_DETAIL[event.pbsCategory];
  }
  const text = `${event.title || ''} ${event.description || ''}`;
  for (const rule of ANOMALY_DETAIL_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return { emoji: rule.emoji, label: rule.label };
  }
  return null;
}

// V1.4.1: congestion is no longer a single flat label — see
// congestionSeverity.js. 'severe' is only ever reached when
// congestionValidation.js has confirmed a real-time low VD speed
// upstream; a bare keyword match (or an unrecognized subtype, which
// falls back to DEFAULT_CONGESTION_SEVERITY='congested') can never
// produce "嚴重壅塞" on its own — that's the exact bug this fixes.
const CONGESTION_SEVERITY_DISPLAY = {
  moderate: { emoji: '🚗', label: '車流偏多', impactLines: '車流略多\n請留意路況' },
  congested: { emoji: '🐢', label: '壅塞', impactLines: '車多回堵\n請預留時間' },
  severe: { emoji: '🐢', label: '嚴重壅塞', impactLines: '嚴重回堵\n請提前改道' },
};

function toTaipeiHHMM(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime();
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// event.startKM/endKM is a raw TDX-formatted string ("91K+000") for a
// normal single event, but a plain number (91, 82.4) on a
// congestionCluster.js merged candidate — accept and format both the
// same way.
function formatKM(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value; // already TDX-formatted
  if (typeof value === 'number' && Number.isFinite(value)) {
    const whole = Math.floor(value);
    const meters = Math.round((value - whole) * 1000);
    return `${whole}K+${String(meters).padStart(3, '0')}`;
  }
  return String(value);
}

function formatKmRange(startKM, endKM) {
  const start = formatKM(startKM);
  const end = formatKM(endKM);
  if (start && end && start !== end) return `${start}～${end}`;
  return start || end || '';
}

// True for text that is ITSELF just a KM point/range in disguise (e.g. a
// raw `LocationDescription` that happens to hold "92K+000", exactly as
// observed on TDX's sibling CCTV dataset — see normalize.js's comment).
// Showing that as if it were a place name would be redundant with the KM
// line below it, not genuinely new information — so it's treated the
// same as "no human text available", never displayed as a section label.
const KM_ONLY_TEXT_PATTERN = /^-?\d+(?:\.\d+)?\s*K(?:\s*\+\s*\d+)?(?:\s*[-~～]\s*-?\d+(?:\.\d+)?\s*K(?:\s*\+\s*\d+)?)?$/i;

/**
 * V1.8.6.4 — the source-text half of "來源本來有的人類位置資訊 > 經可靠
 * 對照的路段名稱 > KM > 不顯示". Only ever returns text the source
 * ITSELF supplied (`event.locationDescription`, see normalize.js) —
 * never synthesizes or guesses a place name. Rejects it only when it
 * carries no information beyond what's already shown elsewhere: empty,
 * purely a KM string (see above), or identical to the road/direction
 * line it would sit next to.
 */
function pickHumanLocationText(event, roadDirection) {
  const candidate = (event.locationDescription || '').trim();
  if (!candidate) return null;
  if (KM_ONLY_TEXT_PATTERN.test(candidate)) return null;
  if (candidate === roadDirection) return null;
  if (event.road && candidate === String(event.road)) return null;
  return candidate;
}

/**
 * Builds the first two message lines for an event: a short
 * "road direction｜section" (or just "road direction", when no section
 * label resolves) line, plus a second line dedicated purely to the
 * kilometer marker. Never repeats road+direction across both lines
 * either way.
 *
 * V1.8.5.1 — production repro (2026-08-18): a real accident had genuine
 * structured `startKM`/`endKM` (or, for a PBS event, a genuine free-text
 * `displayKM` — see pbs/normalize.js), but `getRoadSectionLabel` couldn't
 * resolve a named-interchange label for it (out of the curated anchor
 * table, or the road wasn't recognized by roadSectionLabel.js at all) —
 * so the OLD code fell all the way through to `event.location`, which
 * for a PBS event is a raw route-name string like "中山高速公路-國道1號",
 * not a kilometer at all. The event's own official KM was silently
 * dropped even though it was right there on the event. Fixed: KM display
 * priority is now independent of whether a section label resolved —
 * "不要因為無法產生 section label 就把明確 KM 丟掉":
 *   1. structured `startKM`/`endKM` (works whether or not a section
 *      label was resolvable)
 *   2. `event.displayKM` (PBS-only, free-text-derived, display-only —
 *      never treated as reliable enough for CCTV/fingerprint/suppression,
 *      see pbs/normalize.js's module comment)
 *   3. nothing recognizable as KM at all -> the original location-text
 *      fallback, unchanged from before this round.
 */
function buildRoadLines(event) {
  const shortRoad = getRoadShortName(event.road) || event.road || '';
  const roadDirection = [shortRoad, event.direction].filter(Boolean).join(' ');

  // Tier 1 (source's own human text) beats tier 2 (curated anchor
  // table) — only fall back to getRoadSectionLabel()'s resolution when
  // the source didn't supply usable location text of its own. See the
  // V1.8.6.4 module comment above for the full priority rationale.
  const humanLocationText = pickHumanLocationText(event, roadDirection);
  const section = humanLocationText ? null : getRoadSectionLabel({ road: event.road, startKM: event.startKM, endKM: event.endKM });
  const sectionLabel = humanLocationText || (section && section.label);
  const firstLine = sectionLabel ? (roadDirection ? `${roadDirection}｜${sectionLabel}` : sectionLabel) : roadDirection;

  const structuredKmLine =
    event.startKM !== undefined || event.endKM !== undefined ? formatKmRange(event.startKM, event.endKM) : '';
  if (structuredKmLine) {
    return { firstLine, secondLine: structuredKmLine };
  }

  if (typeof event.displayKM === 'number' && Number.isFinite(event.displayKM)) {
    return { firstLine, secondLine: formatKM(event.displayKM) };
  }

  // Fallback (no KM recognizable at all, structured or displayKM): keep
  // the original road+direction line, then only add a location line if
  // it carries information beyond that. Also strips the exact
  // reported-bug shape where `location` already starts with
  // "road direction " (composeLocation's own format), so the duplicate
  // can't resurface here either.
  let secondLine = event.location && event.location !== roadDirection ? event.location : '';
  if (secondLine && event.road && event.direction) {
    const prefix = `${event.road} ${event.direction} `;
    if (secondLine.startsWith(prefix)) secondLine = secondLine.slice(prefix.length);
  }
  // V1.8.6.4: don't repeat the same text on both lines if `event.location`
  // happens to duplicate the human location text already shown in
  // `sectionLabel` on line 1.
  if (secondLine && secondLine === sectionLabel) secondLine = '';
  return { firstLine, secondLine };
}

/**
 * @param {object} event - normalized unified event
 * @param {{ forecast?: boolean, minutesUntilStart?: number|null }} [options]
 *   forecast=true renders the "60分鐘路況預報" template for an event that
 *   hasn't started yet but falls inside the 60-minute window.
 */
export function formatEventMessage(event, { forecast = false, minutesUntilStart = null } = {}) {
  const { firstLine, secondLine } = buildRoadLines(event);

  if (forecast) {
    const lines = [
      '⚠️ 60分鐘路況預報',
      firstLine,
      secondLine,
      minutesUntilStart != null ? `約${minutesUntilStart}分鐘後開始` : '即將開始',
      '建議提前改道',
    ].filter(Boolean);
    return lines.join('\n');
  }

  const congestionDisplay =
    event.type === 'congestion'
      ? CONGESTION_SEVERITY_DISPLAY[event.congestionSeverity] || CONGESTION_SEVERITY_DISPLAY[DEFAULT_CONGESTION_SEVERITY]
      : null;

  // V1.8.6.4: a genuinely-classifiable 'other' anomaly (積水/落石/坍方/...)
  // gets its own specific headline instead of always falling through to
  // the generic "路況異常" — see resolveOtherAnomalyDetail's own comment.
  const anomalyDetail = !congestionDisplay && event.type === 'other' ? resolveOtherAnomalyDetail(event) : null;

  const emoji = congestionDisplay ? congestionDisplay.emoji : anomalyDetail ? anomalyDetail.emoji : TYPE_EMOJI[event.type] || 'ℹ️';
  const label = congestionDisplay ? congestionDisplay.label : anomalyDetail ? anomalyDetail.label : TYPE_LABEL[event.type] || '路況異常';

  // V1.8.6.4: a real, structured direction==='雙向' gets direction-aware
  // impact wording (see BIDIRECTIONAL_IMPACT_LINES's own comment) —
  // congestion keeps its own severity-driven impact text unchanged.
  const impactLines = congestionDisplay
    ? congestionDisplay.impactLines
    : (event.direction === '雙向' && BIDIRECTIONAL_IMPACT_LINES[event.type]) || TYPE_IMPACT_LINES[event.type] || '請留意路況';
  const updatedHHMM = toTaipeiHHMM(event.updatedAt);

  const lines = [
    `${emoji} ${label}`,
    firstLine,
    secondLine,
    impactLines,
    updatedHHMM ? `🕒 ${updatedHHMM}更新` : null,
  ].filter(Boolean);

  return lines.join('\n');
}
