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

const TYPE_EMOJI = {
  accident: '🚨',
  construction: '🚧',
  closure: '🚧',
  control: '⚠️',
  congestion: '🐢',
  alert: 'ℹ️',
  other: 'ℹ️',
};

const TYPE_LABEL = {
  accident: '交通事故',
  construction: '道路施工',
  closure: '道路封閉',
  control: '交通管制',
  congestion: '嚴重壅塞',
  alert: '公車異動',
  other: '路況異常',
};

const TYPE_IMPACT_LINES = {
  accident: '事故影響通行\n請提前避開',
  construction: '施工影響通行\n請注意車道',
  closure: '道路封閉\n請改道行駛',
  control: '交通管制中\n請配合疏導',
  congestion: '車多回堵\n請預留時間',
  alert: '營運異動\n請留意公告',
  other: '請留意路況',
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
 * "road direction｜section" line, plus a second line that's purely the
 * KM range (when a section label was resolvable) or the original
 * location text (when it wasn't — e.g. a road roadSectionLabel.js
 * doesn't cover this round). Never repeats road+direction across both
 * lines either way.
 */
function buildRoadLines(event) {
  const shortRoad = getRoadShortName(event.road) || event.road || '';
  const roadDirection = [shortRoad, event.direction].filter(Boolean).join(' ');

  const section = getRoadSectionLabel({ road: event.road, startKM: event.startKM, endKM: event.endKM });

  if (section.label) {
    const firstLine = roadDirection ? `${roadDirection}｜${section.label}` : section.label;
    const secondLine = formatKmRange(event.startKM, event.endKM);
    return { firstLine, secondLine };
  }

  // Fallback (no section label available — road not in this round's
  // table, or no usable KM at all): keep the original road+direction
  // line, then only add a location line if it carries information beyond
  // that. Also strips the exact reported-bug shape where `location`
  // already starts with "road direction " (composeLocation's own
  // format), so the duplicate can't resurface here either.
  let secondLine = event.location && event.location !== roadDirection ? event.location : '';
  if (secondLine && event.road && event.direction) {
    const prefix = `${event.road} ${event.direction} `;
    if (secondLine.startsWith(prefix)) secondLine = secondLine.slice(prefix.length);
  }
  return { firstLine: roadDirection, secondLine };
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

  const emoji = TYPE_EMOJI[event.type] || 'ℹ️';
  const label = TYPE_LABEL[event.type] || '路況異常';
  const impactLines = TYPE_IMPACT_LINES[event.type] || '請留意路況';
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
