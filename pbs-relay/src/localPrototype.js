import { createHash } from 'node:crypto';
import { isPbsEventHsinchuRelevant } from '../../src/pbs/hsinchuFilter.js';
import { normalizePbsRoad } from '../../src/pbs/roadName.js';

const ACCIDENT_PATTERNS = [/事故/, /擦撞/, /追撞/, /自撞/, /對撞/, /相撞/, /撞及/];
const CLEARED_PATTERNS = [/已排除/, /排除/, /已解除/, /解除/];
const HSINCHU_PLACE_PATTERNS = [
  /新竹市/,
  /新竹縣/,
  /竹北/,
  /湖口/,
  /新豐/,
  /新埔/,
  /關西/,
  /芎林/,
  /竹東/,
  /寶山/,
  /北埔/,
  /峨眉/,
  /橫山/,
  /尖石/,
  /五峰/,
  /香山/,
  /竹科/,
];

const MIAOLI_PLACE_PATTERNS = [
  /苗栗/, /竹南/, /頭份/, /三灣/, /南庄/, /獅潭/, /後龍/, /通霄/,
  /苑裡/, /造橋/, /西湖/, /公館/, /大湖/, /卓蘭/, /泰安/, /銅鑼/, /三義/,
];

const WINDOWS_FREEWAY_RANGES = {
  國道一號: { minKM: 83, maxKM: 100 },
  國道三號: { minKM: 75, maxKM: 104 },
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
  if (MIAOLI_PLACE_PATTERNS.some((pattern) => pattern.test(searchable))) return null;

  const normalizedRoad = normalizePbsRoad(text(raw?.road), text(raw?.areaNm));
  const kmMatch = searchable.match(/(\d+(?:\.\d+)?)\s*(?:K(?:\s*\+\s*(\d+))?|公里)/i);
  const km = kmMatch
    ? Number(kmMatch[1]) + (kmMatch[2] ? Number(kmMatch[2]) / 1000 : 0)
    : null;
  const windowsFreewayRange = WINDOWS_FREEWAY_RANGES[normalizedRoad];
  if (windowsFreewayRange && km !== null) {
    return km >= windowsFreewayRange.minKM && km <= windowsFreewayRange.maxKM
      ? `windows-service-area:road-km:${normalizedRoad}`
      : null;
  }

  const productionEvent = {
    source: 'pbs',
    road: normalizedRoad,
    description: text(raw?.comment),
    location: text(raw?.areaNm),
    // The old broad coordinate envelope overlaps Miaoli. Windows Phase 1
    // therefore never lets coordinates grant admission by themselves.
    longitude: null,
    latitude: null,
  };

  // Reuse the exact PBS resolver trusted by Production. Coordinates are
  // merely evidence supplied to that resolver; the removed prototype
  // envelope can no longer grant admission on its own. On priority roads,
  // parseable KM is authoritative (e.g. 國1 68.1K and 國3 55.8K fail
  // closed); 台68 remains whole-route-in-scope per the canonical rules.
  if (isPbsEventHsinchuRelevant(productionEvent)) {
    return normalizedRoad
      ? `production-service-area:road-km:${normalizedRoad}`
      : 'production-service-area:coordinates';
  }

  const placePattern = HSINCHU_PLACE_PATTERNS.find((pattern) => pattern.test(searchable));
  if (placePattern) return `text:${placePattern.source}`;
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
  const changes = { NEW: [], UPDATED: [], CLEARED: [], UNCHANGED: [], MISSING_PENDING_CLEAR: [] };
  const nextEvents = {};

  for (const event of active) {
    const previous = priorEvents?.[event.id];
    if (baseline) changes.UNCHANGED.push(event);
    else if (!previous) changes.NEW.push(event);
    else if (previous.fingerprint !== event.fingerprint) changes.UPDATED.push(event);
    else changes.UNCHANGED.push(event);

    // Seeing the UID again cancels any pending absence. Content equality is
    // still decided only by the fingerprint, so a reappearance with no real
    // content change stays UNCHANGED rather than becoming UPDATED.
    nextEvents[event.id] = {
      fingerprint: event.fingerprint,
      event,
      missingCount: 0,
      lastSeenAt: now.toISOString(),
      firstMissingAt: null,
    };
  }

  if (!baseline) {
    for (const [id, previous] of Object.entries(priorEvents)) {
      if (currentById.has(id)) continue;
      const explicit = explicitlyCleared.get(id);
      if (explicit) {
        changes.CLEARED.push({
          ...(previous.event || { id }),
          id,
          clearReason: 'explicit-clear-text',
          currentComment: explicit.comment,
        });
        continue;
      }

      const missingCount = Number.isInteger(previous.missingCount) && previous.missingCount >= 0
        ? previous.missingCount + 1
        : 1;
      if (missingCount >= 2) {
        changes.CLEARED.push({
          ...(previous.event || { id }),
          id,
          clearReason: 'confirmed-absence',
          missingCount,
        });
        continue;
      }

      const pending = {
        ...(previous.event || { id }),
        id,
        clearReason: 'missing-pending-clear',
        missingCount,
      };
      changes.MISSING_PENDING_CLEAR.push(pending);
      nextEvents[id] = {
        ...previous,
        missingCount,
        firstMissingAt: previous.firstMissingAt || now.toISOString(),
      };
    }
  }

  const state = {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    events: nextEvents,
  };
  const shouldPush = !baseline && (changes.NEW.length + changes.UPDATED.length + changes.CLEARED.length > 0);
  return { baseline, changes, state, shouldPush };
}
