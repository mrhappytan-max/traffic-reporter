// Multi-signal Hsinchu relevance check for PBS events. Deliberately NOT a
// single keyword match — the project has already seen a concrete false-
// positive risk here: "新豐" appears in both Hsinchu County's 新豐鄉 and
// Hualien's 新豐平大橋. Priority, per spec:
//   1. Coordinates (authoritative when present — either confirms Hsinchu
//      or rules it out, overriding any place-name match)
//   2. Road + KM (reuses src/traffic/hsinchuFilter.js's already-tested
//      FREEWAY_RULES/HIGHWAY_RULES range logic — PBS's normalized "台68"/
//      "台61"/"台1"/"台3"/"台15" already match those rules' existing
//      aliases, no separate PBS road config needed)
//   3+4. areaNm / comment place-name keywords — auxiliary ONLY. Per spec
//      "地名只能當輔助，不可單獨決定": a bare place-name match from EITHER
//      field alone is never sufficient; both areaNm AND comment must
//      independently agree before a place-name-only signal counts.
// Fails closed throughout — same "寧可少播" principle as everywhere else.

import { isHsinchuRelevant as isTdxHsinchuRelevant } from '../traffic/hsinchuFilter.js';
import { HSINCHU_BOUNDING_BOX } from '../traffic/hsinchuConfig.js';

const HSINCHU_PLACE_NAMES = [
  '新竹市',
  '竹北',
  '湖口',
  '新豐',
  '新埔',
  '關西',
  '芎林',
  '竹東',
  '寶山',
  '北埔',
  '峨眉',
  '橫山',
  '尖石',
  '五峰',
  '香山',
  '竹科',
];

function detectPbsSourceKind(road) {
  if (!road) return null;
  if (road.startsWith('國道')) return 'freeway';
  if (/^台\d/.test(road)) return 'highway';
  return null;
}

/** "在8.1公里" / "87.8公里" / "87K+800" style mentions in free text. */
function extractKmFromText(text) {
  if (!text) return { startKM: undefined, endKM: undefined };
  const kPlusMatch = text.match(/(\d+(?:\.\d+)?)\s*K\s*\+\s*(\d+)/i);
  if (kPlusMatch) {
    const km = parseFloat(kPlusMatch[1]) + parseInt(kPlusMatch[2], 10) / 1000;
    return { startKM: km, endKM: km };
  }
  const plainKmMatch = text.match(/(\d+(?:\.\d+)?)\s*公里/);
  if (plainKmMatch) {
    const km = parseFloat(plainKmMatch[1]);
    return { startKM: km, endKM: km };
  }
  return { startKM: undefined, endKM: undefined };
}

function isInsideHsinchuBox(lat, lon) {
  return (
    lon >= HSINCHU_BOUNDING_BOX.minLon &&
    lon <= HSINCHU_BOUNDING_BOX.maxLon &&
    lat >= HSINCHU_BOUNDING_BOX.minLat &&
    lat <= HSINCHU_BOUNDING_BOX.maxLat
  );
}

function matchesHsinchuPlaceName(text) {
  if (!text) return false;
  return HSINCHU_PLACE_NAMES.some((name) => text.includes(name));
}

export function isPbsEventHsinchuRelevant(event) {
  const sourceKind = detectPbsSourceKind(event.road);
  const hasCoords = event.latitude != null && event.longitude != null;

  if (sourceKind) {
    const { startKM, endKM } = extractKmFromText(event.description);
    const rawRecord = hasCoords
      ? { Positions: [{ PositionLon: event.longitude, PositionLat: event.latitude }] }
      : {};
    const pseudoTdxEvent = { source: sourceKind, road: event.road, startKM, endKM, description: event.description };

    if (isTdxHsinchuRelevant(pseudoTdxEvent, rawRecord)) return true;

    // We had an authoritative signal (a parsed KM, or coordinates) and it
    // said no — trust that rather than falling through to weaker
    // place-name signals just because the road name matched a priority
    // road (a national road/route spans far outside Hsinchu too).
    if (startKM !== undefined || endKM !== undefined || hasCoords) return false;
  }

  if (hasCoords) {
    return isInsideHsinchuBox(event.latitude, event.longitude);
  }

  const areaNmMatches = matchesHsinchuPlaceName(event.location);
  const commentMatches = matchesHsinchuPlaceName(event.description);
  return areaNmMatches && commentMatches;
}
