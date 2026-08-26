import { createHash } from 'node:crypto';

const ACCIDENT_PATTERNS = [/事故/, /擦撞/, /追撞/, /自撞/, /對撞/, /相撞/, /撞及/];
const CLEARED_PATTERNS = [/已排除/, /排除/, /已解除/, /解除/];
const SERVICE_AREA_PATTERNS = [
  /新竹市/,
  /新竹縣/,
  /竹北/,
  /竹南/,
  /頭份/,
];

// Generous prototype-only envelope covering Hsinchu City/County plus
// Zhunan/Toufen. Text matches remain visible in matchReason for calibration.
const SERVICE_AREA_BOX = {
  minLat: 24.45,
  maxLat: 24.95,
  minLon: 120.80,
  maxLon: 121.35,
};

function text(value) {
  return value == null ? '' : String(value).trim();
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parsePbsPayload(rawText) {
  const parsed = JSON.parse(rawText);
  const items = Array.isArray(parsed) ? parsed : parsed?.result;
  if (!Array.isArray(items)) {
    throw new Error('PBS payload does not contain an array in result');
  }
  return items;
}

export function isAccident(raw) {
  const searchable = `${text(raw?.roadtype)} ${text(raw?.comment)}`;
  return ACCIDENT_PATTERNS.some((pattern) => pattern.test(searchable));
}

export function getServiceAreaMatch(raw) {
  const searchable = [raw?.areaNm, raw?.comment, raw?.road, raw?.region]
    .map(text)
    .join(' ');
  const placePattern = SERVICE_AREA_PATTERNS.find((pattern) => pattern.test(searchable));
  if (placePattern) return `text:${placePattern.source}`;

  const longitude = numberOrNull(raw?.x1);
  const latitude = numberOrNull(raw?.y1);
  if (
    longitude != null &&
    latitude != null &&
    longitude >= SERVICE_AREA_BOX.minLon &&
    longitude <= SERVICE_AREA_BOX.maxLon &&
    latitude >= SERVICE_AREA_BOX.minLat &&
    latitude <= SERVICE_AREA_BOX.maxLat
  ) {
    return 'coordinates:prototype-envelope';
  }
  return null;
}

export function normalizeRelevantAccident(raw) {
  const id = text(raw?.UID);
  if (!id || !isAccident(raw)) return null;
  const matchReason = getServiceAreaMatch(raw);
  if (!matchReason) return null;

  const event = {
    id,
    roadtype: text(raw.roadtype),
    road: text(raw.road),
    areaNm: text(raw.areaNm),
    region: text(raw.region),
    direction: text(raw.direction),
    comment: text(raw.comment),
    happenedDate: text(raw.happendate),
    happenedTime: text(raw.happentime),
    modifiedAt: text(raw.modDttm),
    longitude: numberOrNull(raw.x1),
    latitude: numberOrNull(raw.y1),
    sourceDetail: text(raw.srcdetail),
    matchReason,
  };
  event.cleared = CLEARED_PATTERNS.some((pattern) => pattern.test(event.comment));
  event.fingerprint = fingerprintEvent(event);
  return event;
}

export function fingerprintEvent(event) {
  const stableContent = {
    roadtype: event.roadtype,
    road: event.road,
    areaNm: event.areaNm,
    region: event.region,
    direction: event.direction,
    comment: event.comment,
    longitude: event.longitude,
    latitude: event.latitude,
    sourceDetail: event.sourceDetail,
  };
  return createHash('sha256').update(JSON.stringify(stableContent)).digest('hex');
}

export function filterRelevantAccidents(items) {
  return items.map(normalizeRelevantAccident).filter(Boolean);
}

export function compareWithPreviousState(events, previousState, now = new Date()) {
  const priorEvents = previousState?.events && typeof previousState.events === 'object'
    ? previousState.events
    : null;
  const baseline = priorEvents === null;
  const active = events.filter((event) => !event.cleared);
  const explicitlyCleared = new Map(events.filter((event) => event.cleared).map((event) => [event.id, event]));
  const currentById = new Map(active.map((event) => [event.id, event]));
  const changes = { NEW: [], UPDATED: [], CLEARED: [], UNCHANGED: [] };

  for (const event of active) {
    const previous = priorEvents?.[event.id];
    if (baseline) changes.UNCHANGED.push(event);
    else if (!previous) changes.NEW.push(event);
    else if (previous.fingerprint !== event.fingerprint) changes.UPDATED.push(event);
    else changes.UNCHANGED.push(event);
  }

  if (!baseline) {
    for (const [id, previous] of Object.entries(priorEvents)) {
      if (currentById.has(id)) continue;
      const explicit = explicitlyCleared.get(id);
      changes.CLEARED.push({
        ...(previous.event || { id }),
        id,
        clearReason: explicit ? 'explicit-clear-text' : 'absent-from-current-feed',
        ...(explicit ? { currentComment: explicit.comment } : {}),
      });
    }
  }

  const state = {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    events: Object.fromEntries(active.map((event) => [event.id, {
      fingerprint: event.fingerprint,
      event,
    }])),
  };
  const shouldPush = !baseline && (changes.NEW.length + changes.UPDATED.length + changes.CLEARED.length > 0);
  return { baseline, changes, state, shouldPush };
}

export { SERVICE_AREA_BOX };
