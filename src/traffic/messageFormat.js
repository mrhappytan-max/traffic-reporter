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

  const section = getRoadSectionLabel({ road: event.road, startKM: event.startKM, endKM: event.endKM });
  const firstLine = section.label ? (roadDirection ? `${roadDirection}｜${section.label}` : section.label) : roadDirection;

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

  const emoji = congestionDisplay ? congestionDisplay.emoji : TYPE_EMOJI[event.type] || 'ℹ️';
  const label = congestionDisplay ? congestionDisplay.label : TYPE_LABEL[event.type] || '路況異常';
  const impactLines = congestionDisplay ? congestionDisplay.impactLines : TYPE_IMPACT_LINES[event.type] || '請留意路況';
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
