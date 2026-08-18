// Maps a raw PBS record onto the unified-ish PBS event schema. PBS-
// specific extra fields (latitude/longitude/sourceDetail/happenedAt/
// roadtype/pbsCategory) ride alongside the common source/type/title/
// description/road/direction/location/startTime/endTime/updatedAt shape
// used elsewhere in this project.
//
// Time format assumption (unverified live — see pbsConfig.js's module
// comment): happendate ("2026-08-15") + happentime ("22:14:00") and
// modDttm are both Asia/Taipei local time, "YYYY-MM-DD HH:MM:SS"-shaped.

import { normalizePbsRoad } from './roadName.js';
import { classifyPbsEvent } from './classify.js';
import { classifyCongestionSeverity } from '../traffic/congestionSeverity.js';

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

export function normalizePbsDirection(direction) {
  if (!direction) return '';
  const trimmed = String(direction).trim();
  return DIRECTION_MAP[trimmed] || trimmed;
}

/** Asia/Taipei is fixed UTC+8 (no DST) — same approach used throughout this project. */
function taipeiPartsToUtcIso(year, month, day, hour, minute, second) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second)).toISOString();
}

/** happendate ("2026-08-15") + happentime ("22:14:00") -> ISO instant. */
export function parseHappenedAt(happendate, happentime) {
  if (!happendate) return null;
  const dateMatch = String(happendate).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return null;
  const timeMatch = String(happentime || '00:00:00').match(/(\d{2}):(\d{2}):(\d{2})/);
  const [, y, m, d] = dateMatch;
  const [, hh, mm, ss] = timeMatch || [null, '00', '00', '00'];
  return taipeiPartsToUtcIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
}

/** modDttm ("2026-08-15 22:20:00" or "2026-08-15T22:20:00") -> ISO instant. */
export function parsePbsDateTime(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return taipeiPartsToUtcIso(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
}

function toFiniteNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// V1.8.5.1 — production repro (2026-08-18): a real 17:05 accident LINE
// message showed no KM at all, only a route-name string ("中山高速公路-
// 國道1號") on the second line. Root cause: PBS never carries a
// structured KM field (see module comment — road/direction/areaNm/
// roadtype/comment/dates/x1/y1/srcdetail is the ENTIRE raw shape), so
// `startKM`/`endKM` are simply never set on a PBS event — but PBS's own
// `comment` free text frequently DOES state an official kilometer marker
// (the already-confirmed real fixture below: "西行在8.1公里處內側車道發生
// 交通事故"). This extracts that as a DISPLAY-ONLY value.
//
// `displayKM` is deliberately NEVER treated as reliable positional data:
// - cctv/dynamicCollage.js's eventTargetKm() reads ONLY startKM/endKM —
//   never displayKM — so a PBS accident can never gain CCTV eligibility
//   just because its comment happened to mention a kilometer. CCTV stays
//   restricted to source==='freeway' with genuine TDX structured KM, per
//   V1.8.5's own scope boundary — unchanged by this round.
// - notified.js's computeNotificationFingerprint() and
//   incidentSuppression.js's own (separate, pre-existing,
//   parseKmFromDescription) free-text KM parser are BOTH untouched by
//   this field — deliberately two independent parsers reading the same
//   comment text for two different purposes, so a bug in the new
//   display-only parser can never change what already-working
//   suppression/fingerprint logic decides.
//
// Deliberately strict: only digits immediately followed by a "K"/
// "K+NNN" unit or "公里" count — a bare number in unrelated text (e.g.
// "2車事故、3人受傷、17:05") must never be misread as a kilometer.
const DISPLAY_KM_K_PLUS_PATTERN = /(\d+(?:\.\d+)?)\s*K\s*\+\s*(\d{1,3})/i; // "93K+300"
const DISPLAY_KM_BARE_K_PATTERN = /(\d+(?:\.\d+)?)\s*K(?!\s*\+)\b/i; // "93K", "93.3K"
const DISPLAY_KM_PLAIN_PATTERN = /(\d+(?:\.\d+)?)\s*公里/; // "93公里", "93.3公里", "8.1公里處"

/**
 * Parses a single official kilometer marker out of PBS free text, for
 * DISPLAY ONLY — never returns a range (PBS comment text was never
 * observed to state a range, only a single point). Returns a plain
 * number (km, e.g. 93.3) or null if nothing recognizable is present.
 */
export function extractDisplayKmFromText(text) {
  if (!text) return null;

  const kPlusMatch = text.match(DISPLAY_KM_K_PLUS_PATTERN);
  if (kPlusMatch) return parseFloat(kPlusMatch[1]) + parseInt(kPlusMatch[2], 10) / 1000;

  const bareKMatch = text.match(DISPLAY_KM_BARE_K_PATTERN);
  if (bareKMatch) return parseFloat(bareKMatch[1]);

  const plainKmMatch = text.match(DISPLAY_KM_PLAIN_PATTERN);
  if (plainKmMatch) return parseFloat(plainKmMatch[1]);

  return null;
}

export function normalizePbsEvent(raw) {
  const road = normalizePbsRoad(raw.road, raw.areaNm);
  const direction = normalizePbsDirection(raw.direction);
  const description = (raw.comment || '').trim();
  const happenedAt = parseHappenedAt(raw.happendate, raw.happentime);
  const updatedAt = parsePbsDateTime(raw.modDttm);
  const { type, pbsCategory } = classifyPbsEvent({ roadtype: raw.roadtype, comment: description });
  const displayKM = extractDisplayKmFromText(description);

  return {
    source: 'pbs',
    rawId: String(raw.UID ?? ''),
    type,
    title: description ? description.slice(0, 30) : 'PBS 路況通報',
    description,
    road,
    direction,
    location: raw.areaNm || '',
    startTime: happenedAt,
    endTime: null,
    updatedAt,
    latitude: toFiniteNumberOrNull(raw.y1),
    longitude: toFiniteNumberOrNull(raw.x1),
    sourceDetail: raw.srcdetail || '',
    // Extra fields beyond the base schema example, used by lifecycle/
    // cross-source-dedup — kept on the event rather than re-deriving them
    // repeatedly downstream.
    happenedAt,
    roadtype: raw.roadtype || '',
    pbsCategory,
    // V1.4.1 — same 車多(moderate)/壅塞(congested) distinction as TDX's
    // RoadEvent normalizer, see congestionSeverity.js. `roadtype`+
    // `description` is the same text classifyPbsEvent() itself just used
    // to decide `type === 'congestion'`.
    ...(type === 'congestion'
      ? { congestionSeverity: classifyCongestionSeverity(`${raw.roadtype || ''} ${description}`) }
      : {}),
    // V1.8.5.1 — display-only, see the module comment above this function.
    ...(displayKM !== null ? { displayKM } : {}),
  };
}
