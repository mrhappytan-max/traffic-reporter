// Decides whether a nationwide Freeway/Highway event should reach the
// Hsinchu feed. Fails closed: if we can't reliably place an event, it is
// excluded rather than risking a false positive (e.g. a Kaohsiung 國道1號
// accident leaking into the Hsinchu broadcast). See hsinchuConfig.js for
// the actual ranges and their confidence caveats.

import { get } from '../tdx/extract.js';
import { FREEWAY_RULES, HIGHWAY_RULES, HSINCHU_BOUNDING_BOX, KM_BOUNDARY_BUFFER_KM } from './hsinchuConfig.js';

/** Parses TDX-style KM strings ("42K+000", "42K", "42.5") into a float. */
export function parseKM(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const str = String(value).trim();
  const match = str.match(/(-?\d+(?:\.\d+)?)\s*K(?:\s*\+\s*(\d+))?/i);
  if (match) {
    const km = parseFloat(match[1]);
    const meters = match[2] ? parseInt(match[2], 10) : 0;
    return km + meters / 1000;
  }

  const plain = parseFloat(str);
  return Number.isFinite(plain) ? plain : null;
}

function findRule(rules, roadName) {
  if (!roadName) return null;
  const normalized = String(roadName).trim();
  if (!normalized) return null;

  for (const [canonical, rule] of Object.entries(rules)) {
    if (normalized === canonical) return { canonical, ...rule };
    if (rule.aliases && rule.aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return { canonical, ...rule };
    }
    if (normalized.includes(canonical)) return { canonical, ...rule };
  }
  return null;
}

function extractPositions(raw) {
  const points = [];

  const pushPoint = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const lon = obj.PositionLon ?? obj.Longitude ?? obj.lon ?? obj.longitude;
    const lat = obj.PositionLat ?? obj.Latitude ?? obj.lat ?? obj.latitude;
    if (typeof lon === 'number' && typeof lat === 'number') points.push({ lon, lat });
  };

  const positionsArray = get(raw, 'Positions');
  if (Array.isArray(positionsArray)) {
    for (const point of positionsArray) pushPoint(point);
  }

  pushPoint(get(raw, 'Position'));

  return points;
}

function isInsideHsinchuBox({ lon, lat }) {
  return (
    lon >= HSINCHU_BOUNDING_BOX.minLon &&
    lon <= HSINCHU_BOUNDING_BOX.maxLon &&
    lat >= HSINCHU_BOUNDING_BOX.minLat &&
    lat <= HSINCHU_BOUNDING_BOX.maxLat
  );
}

/**
 * @param {object} normalizedEvent - output of normalizeRoadEvent (source,
 *   road, startKM, endKM, description, ...)
 * @param {object} rawRecord - the original TDX record, for SectionStart/
 *   SectionEnd/Positions that aren't part of the unified schema
 */
export function isHsinchuRelevant(normalizedEvent, rawRecord = {}) {
  const rules = normalizedEvent.source === 'freeway' ? FREEWAY_RULES : HIGHWAY_RULES;
  const rule = findRule(rules, normalizedEvent.road);
  if (!rule) return false; // not one of our priority roads — fail closed

  if (rule.wholeRouteInScope) return true; // e.g. 台68 is entirely within Hsinchu

  const startKM = parseKM(
    normalizedEvent.startKM ?? get(rawRecord, 'SectionStart') ?? get(rawRecord, 'Location.SectionStart')
  );
  const endKM = parseKM(
    normalizedEvent.endKM ?? get(rawRecord, 'SectionEnd') ?? get(rawRecord, 'Location.SectionEnd')
  );
  const kmPoints = [startKM, endKM].filter((v) => v !== null);

  if (kmPoints.length > 0) {
    if (kmPoints.some((km) => km >= rule.minKM && km <= rule.maxKM)) return true;

    const nearBoundary = kmPoints.some(
      (km) => km >= rule.minKM - KM_BOUNDARY_BUFFER_KM && km <= rule.maxKM + KM_BOUNDARY_BUFFER_KM
    );
    if (nearBoundary && /新竹/.test(normalizedEvent.description || '')) return true;

    // KM was parseable and confidently outside range — don't fall through
    // to weaker signals just because the road name also passes through
    // Hsinchu elsewhere in the country.
    return false;
  }

  // No usable KM at all — fall back to position, then fail closed.
  const positions = extractPositions(rawRecord);
  if (positions.length > 0) return positions.some(isInsideHsinchuBox);

  return false;
}
