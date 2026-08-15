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

export function normalizePbsEvent(raw) {
  const road = normalizePbsRoad(raw.road, raw.areaNm);
  const direction = normalizePbsDirection(raw.direction);
  const description = (raw.comment || '').trim();
  const happenedAt = parseHappenedAt(raw.happendate, raw.happentime);
  const updatedAt = parsePbsDateTime(raw.modDttm);
  const { type, pbsCategory } = classifyPbsEvent({ roadtype: raw.roadtype, comment: description });

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
  };
}
