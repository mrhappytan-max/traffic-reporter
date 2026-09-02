// V2.4.5 — V2_4_5_TDX_HSINCHU_GEO_RESOLVER. TDX ONLY — never imported by
// or reused for PBS (see pbs/hsinchuFilter.js, which stays completely
// untouched this round; that resolver's own coordinate/KM/place-name
// logic is a SEPARATE, independent implementation, per the order's own
// "PBS 與 TDX 的服務區判定必須分開" architectural principle).
//
// WHY THIS EXISTS
// ----------------
// V2.4.4's own read-only audit (V2_4_4_TDX_RUNTIME_ARCHITECTURE_READONLY_
// AUDIT) found that TDX's existing service-area gates (traffic/
// hsinchuFilter.js's ingestion filter, and traffic/serviceArea.js's
// candidate-build gate, which for TDX re-invoked the SAME resolver) both
// rest on hsinchuConfig.js's own admittedly "best-effort, NOT verified
// against official 公路局/國道局 里程樁 data" KM ranges, and share one
// additional structural gap: a TDX event admitted purely via the raw
// bounding-box fallback (no KM at all) reaches the candidate-build gate
// with NO placeable geography at all (tdx/normalize.js never carried
// latitude/longitude forward onto the normalized event), which
// FAIL-OPENS ("service-area-deferred-to-ingestion") rather than
// re-confirming anything. A real Production leak (台61線 39K+600, actually
// 桃園市觀音區) resulted — see 07_KNOWN_ISSUES.md's V2.4.4 entry for the
// full root-cause record.
//
// THIS ROUND replaces "best-effort KM table + loose bounding box, fail
// open on missing evidence" with a genuine three-state resolver backed,
// for its ONLY positive-authority tier, by real official geometry — see
// data/hsinchu-boundary/raw/SOURCE_META.json for the full provenance
// record (內政部國土測繪中心, data.gov.tw dataset 7442, redistributed
// verbatim via the taiwan-atlas npm package — this sandbox has no direct
// network access to data.gov.tw itself; see that file's own "redistribution"
// notes and 07_KNOWN_ISSUES.md's V2.4.5 entry for the full decision
// record, including the explicit human decision that authorized using
// this specific official-data mirror after this sandbox's own
// data.gov.tw/WebFetch access was confirmed blocked).
//
// THREE-STATE OUTPUT, NEVER A BOOLEAN
// -------------------------------------
// CONFIRMED_HSINCHU — positively verified inside 新竹市 or 新竹縣.
// OUTSIDE_HSINCHU   — positively verified NOT inside either (a real,
//                     reachable coordinate/KM/text signal placed it
//                     elsewhere) — never a guess.
// UNKNOWN           — no reliable evidence either way. Production policy
//                     (order section 十一, section 十九's own acceptance
//                     criteria): UNKNOWN behaves EXACTLY like
//                     OUTSIDE_HSINCHU downstream (0 Queue, 0 AI, 0 LINE)
//                     — the two states are kept distinct here purely for
//                     observability (a human reviewing logs can tell
//                     "we know this is elsewhere" from "we simply
//                     couldn't tell"), never because UNKNOWN gets any
//                     more trust than OUTSIDE_HSINCHU.
//
// EVIDENCE TIERS, IN PRIORITY ORDER (order section 七/八/九/十)
// -----------------------------------------------------------------
//   1. COORDINATES — the ONLY tier that can produce CONFIRMED_HSINCHU
//      from geometry alone, because it is the only tier backed by real,
//      versioned, traceable official boundary data (see above). If every
//      coordinate this event carries falls inside the 新竹市 or 新竹縣
//      polygon, CONFIRMED. If ANY carried coordinate falls outside both,
//      OUTSIDE (a single confidently-placed point elsewhere is enough to
//      disprove Hsinchu — matches order section 七's "座標確實位於...才
//      回 CONFIRMED_HSINCHU" framing read together with section 十三's
//      "沒有證據=UNKNOWN=不通知" — a coordinate that IS evidence and
//      IS elsewhere is not "no evidence", it's OUTSIDE evidence).
//   2. KM (existing traffic/hsinchuConfig.js FREEWAY_RULES/HIGHWAY_RULES
//      table) — order section 九's own explicit instruction: "禁止再使用
//      ...這種人工估算表取得最終放行資格". This tier therefore NEVER
//      alone produces CONFIRMED_HSINCHU or OUTSIDE_HSINCHU — an
//      unverified table is not a reliable enough NEGATIVE signal either
//      (the exact same table wrongly said "inside" for the 39.6K leak; it
//      could just as easily wrongly say "outside" for a real Hsinchu
//      event near a range's edge). It is carried only as `evidence` on an
//      eventual UNKNOWN result, for future tuning/observability — never
//      decides the state.
//   3. TEXT — TDX's own description/locationDescription/location/title
//      explicitly naming 新竹市／新竹縣 (or a recognized district/
//      township) → CONFIRMED_HSINCHU; explicitly naming a DIFFERENT
//      top-level county/city → OUTSIDE_HSINCHU. A "往XXX方向"-shaped
//      travel-direction mention is excluded from BOTH readings (order
//      section 十's own explicit "往新竹方向...必須區分事件所在地與行車
//      方向／目的地方向", CASE 9).
//
// No tier ever needs "AI judgment" to decide a county — this whole module
// is deterministic, synchronous, pure, zero I/O (order section 八:
// "禁止依賴 AI 判定座標在哪個縣市").

import { HSINCHU_CITY, HSINCHU_COUNTY, HSINCHU_BOUNDARY_METADATA } from '../../data/hsinchu-boundary/generated/hsinchuBoundary.js';
import { FREEWAY_RULES, HIGHWAY_RULES, KM_BOUNDARY_BUFFER_KM } from '../traffic/hsinchuConfig.js';
import { parseKM, extractPositions as extractRawPositions } from '../traffic/hsinchuFilter.js';

export const HSINCHU_GEO_STATUS = Object.freeze({
  CONFIRMED_HSINCHU: 'CONFIRMED_HSINCHU',
  OUTSIDE_HSINCHU: 'OUTSIDE_HSINCHU',
  UNKNOWN: 'UNKNOWN',
});

// Re-exported so callers (and tests) can cite the exact same provenance
// record this module's decisions are backed by, without a second import.
export { HSINCHU_BOUNDARY_METADATA };

// ---------------------------------------------------------------------
// Tier 1 — coordinates, backed by real official polygons.
// ---------------------------------------------------------------------

/**
 * Standard ray-casting point-in-polygon (even-odd rule), applied across
 * ALL of a county's rings at once so a genuine interior hole/enclave (an
 * odd number of ring crossings still correctly flips inside/outside) is
 * handled correctly — see hsinchuBoundary.js's own generated-file comment.
 * Cross-validated (this round, build-time only, not shipped) against
 * @turf/boolean-point-in-polygon on 10 known reference points spanning
 * both counties and 5 neighboring counties; see 07_KNOWN_ISSUES.md's
 * V2.4.5 entry for the full validation record.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number[][][]} rings - flat array of closed [lon,lat][] rings
 * @returns {boolean}
 */
export function isPointInRings(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
  }
  return inside;
}

function isInHsinchuCity(lon, lat) {
  return isPointInRings(lon, lat, HSINCHU_CITY.rings);
}

function isInHsinchuCounty(lon, lat) {
  return isPointInRings(lon, lat, HSINCHU_COUNTY.rings);
}

/** @returns {boolean} */
function isInsideEitherHsinchuPolygon(lon, lat) {
  return isInHsinchuCity(lon, lat) || isInHsinchuCounty(lon, lat);
}

function isValidCoordinate(lon, lat) {
  return typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat);
}

/**
 * V2.4.5 — collects EVERY coordinate this event carries, from BOTH the
 * normalized event's own preserved fields (tdx/normalize.js's new
 * `positions`/`latitude`/`longitude` — see that module's own V2.4.5
 * comment) and, defensively, a raw record if the caller happens to still
 * have one (mirrors traffic/hsinchuFilter.js's own extractPositions field
 *-name tolerance: PositionLon/Longitude/lon/longitude,
 * PositionLat/Latitude/lat/latitude). Deduplicated.
 *
 * @param {object} event - a TDX-normalized event (or, for the rare test/
 *   defensive case, something raw-shaped)
 * @returns {{lon:number, lat:number}[]}
 */
function collectCoordinates(event) {
  const points = [];
  const seen = new Set();
  const push = (lon, lat) => {
    if (!isValidCoordinate(lon, lat)) return;
    const key = `${lon},${lat}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ lon, lat });
  };

  if (Array.isArray(event.positions)) {
    for (const p of event.positions) {
      if (p && typeof p === 'object') push(p.longitude, p.latitude);
    }
  }
  push(event.longitude, event.latitude);

  // Defensive fallback only — every real caller in this codebase passes
  // the ALREADY-normalized event (which carries `positions`/`latitude`/
  // `longitude` since this round's tdx/normalize.js change); this branch
  // exists so a raw-shaped object (e.g. a direct unit test) still works
  // without requiring every caller to pre-normalize first. Reuses traffic/
  // hsinchuFilter.js's own extractPositions — the SAME field-name-
  // tolerant extraction the ingestion filter uses — rather than a second
  // independent copy.
  for (const { lon, lat } of extractRawPositions(event)) push(lon, lat);

  return points;
}

function resolveByCoordinates(event) {
  const points = collectCoordinates(event);
  if (points.length === 0) return null; // no evidence at this tier — fall through

  const outside = points.find((p) => !isInsideEitherHsinchuPolygon(p.lon, p.lat));
  if (outside) {
    return {
      status: HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU,
      reason: 'coordinate_outside_authoritative_boundary',
      evidence: {
        tier: 'coordinate',
        checkedPoints: points,
        outsidePoint: outside,
        boundarySource: HSINCHU_BOUNDARY_METADATA.sourceName,
        boundaryDatasetId: HSINCHU_BOUNDARY_METADATA.datasetId,
      },
    };
  }

  // Every carried point is inside — record WHICH polygon(s) matched for
  // observability (a point can legitimately be near a shared edge and
  // match both, or an event with multiple points could span city+county).
  const matchedCounty = points.some((p) => isInHsinchuCity(p.lon, p.lat)) ? '新竹市' : null;
  const matchedCity = points.some((p) => isInHsinchuCounty(p.lon, p.lat)) ? '新竹縣' : null;
  return {
    status: HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU,
    reason: 'coordinate_inside_authoritative_boundary',
    evidence: {
      tier: 'coordinate',
      checkedPoints: points,
      matchedCounties: [matchedCounty, matchedCity].filter(Boolean),
      boundarySource: HSINCHU_BOUNDARY_METADATA.sourceName,
      boundaryDatasetId: HSINCHU_BOUNDARY_METADATA.datasetId,
    },
  };
}

// ---------------------------------------------------------------------
// Tier 2 — KM heuristic. Observability-only, per this module's own
// header comment — NEVER returns a state on its own.
// ---------------------------------------------------------------------

function findRoadRule(rules, roadName) {
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

/**
 * Never returns CONFIRMED/OUTSIDE — only a descriptive note attached to
 * evidence when the final result is UNKNOWN, so a human/future round can
 * still see "the old heuristic table thought X" without this module ever
 * acting on it. See this module's own header for why (order section 九).
 */
function describeKmHeuristic(event) {
  const rules = event.source === 'freeway' ? FREEWAY_RULES : HIGHWAY_RULES;
  const rule = findRoadRule(rules, event.road);
  if (!rule) return { checked: false };
  if (rule.wholeRouteInScope) return { checked: true, roadRecognized: true, wholeRouteInScope: true };

  const startKM = parseKM(event.startKM);
  const endKM = parseKM(event.endKM);
  const kmPoints = [startKM, endKM].filter((v) => v !== null);
  if (kmPoints.length === 0) return { checked: true, roadRecognized: true, kmAvailable: false };

  const heuristicInRange = kmPoints.some((km) => km >= rule.minKM - KM_BOUNDARY_BUFFER_KM && km <= rule.maxKM + KM_BOUNDARY_BUFFER_KM);
  return {
    checked: true,
    roadRecognized: true,
    kmAvailable: true,
    kmPoints,
    heuristicRange: [rule.minKM, rule.maxKM],
    heuristicInRange,
    note: 'UNVERIFIED heuristic table (hsinchuConfig.js) — observability only, never authoritative per order section 九',
  };
}

// ---------------------------------------------------------------------
// Tier 3 — explicit administrative-region text.
// ---------------------------------------------------------------------

// Full official names, plus the BARE place name (no 市/鎮/鄉/區 suffix) —
// real TDX `LocationDescription` text was found (this round, via the
// existing test suite's own pre-V2.4.5 fixtures) to commonly omit the
// administrative suffix entirely (e.g. "關西－橫山路段", not "關西鎮－
// 橫山鄉路段"). Every bare form here is a distinctive 2-character place
// name — safe from false-positiving on an unrelated word (unlike a bare
// "東"/"北", which IS a substring of common, unrelated text like "北向";
// those two districts are therefore listed ONLY in their full,
// suffixed form).
const HSINCHU_CITY_DISTRICTS = ['東區', '北區', '香山區', '香山'];
const HSINCHU_COUNTY_TOWNSHIPS = [
  '竹北市', '竹北', '竹東鎮', '竹東', '新埔鎮', '新埔', '關西鎮', '關西',
  '湖口鄉', '湖口', '新豐鄉', '新豐', '芎林鄉', '芎林', '橫山鄉', '橫山',
  '北埔鄉', '北埔', '寶山鄉', '寶山', '峨眉鄉', '峨眉', '尖石鄉', '尖石', '五峰鄉', '五峰',
];

// Same fixed, short, geography-only roster traffic/serviceArea.js's own
// V2.4.4 denylist gate already uses — duplicated locally per this
// project's established "each module stays independently readable"
// convention (see pbs/aiCandidate.js's own precedent), not re-exported
// from there, so this module's own logic never depends on Gate 3's
// internals (order section 十六: the two gates must stay independent).
const OTHER_TOP_LEVEL_PLACES = [
  '台北', '新北', '桃園', '台中', '台南', '高雄', '基隆', '嘉義',
  '苗栗', '彰化', '南投', '雲林', '屏東', '宜蘭', '花蓮', '台東',
  '澎湖', '金門', '連江',
  '頭份', '竹南', '三灣',
];

/**
 * Strips any "往ＸＸ方向"/"往ＸＸ"/"通往ＸＸ"/"前往ＸＸ" travel-direction
 * phrase before either positive or negative text matching runs — order
 * section 十／CASE 9's own explicit requirement: a direction mention must
 * never be misread as the event's own location. Requires an explicit
 * 往／通往／前往 marker (never a bare "…方向" with no such marker, which
 * would risk stripping a genuine location statement like "新竹市政府
 * 方向" — over-broad). Removes just the directional phrase, not the
 * whole text, so an event whose OWN location is separately, genuinely
 * stated elsewhere in the same string is still readable.
 */
function stripTravelDirectionPhrases(text) {
  return text
    .replace(/(?:往|通往|前往)\s*[^\s，。、；]{1,6}方向/g, '')
    .replace(/(?:往|通往|前往)\s*[^\s，。、；]{1,6}(?=[，。、；]|$)/g, '');
}

function collectEventText(event) {
  return [event.description, event.locationDescription, event.location, event.title]
    .filter((v) => typeof v === 'string' && v)
    .join(' ');
}

function resolveByText(event) {
  const rawText = collectEventText(event);
  if (!rawText) return null;
  const text = stripTravelDirectionPhrases(rawText);
  if (!text.trim()) return null;

  if (text.includes('新竹市') || text.includes('新竹縣')) {
    return {
      status: HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU,
      reason: 'text_explicit_hsinchu_county_or_city',
      evidence: { tier: 'text', matchedText: text.includes('新竹市') ? '新竹市' : '新竹縣' },
    };
  }
  const matchedDistrict = [...HSINCHU_CITY_DISTRICTS, ...HSINCHU_COUNTY_TOWNSHIPS].find((name) => text.includes(name));
  if (matchedDistrict) {
    return {
      status: HSINCHU_GEO_STATUS.CONFIRMED_HSINCHU,
      reason: 'text_explicit_hsinchu_district_or_township',
      evidence: { tier: 'text', matchedText: matchedDistrict },
    };
  }

  const matchedOther = OTHER_TOP_LEVEL_PLACES.find((name) => text.includes(name));
  if (matchedOther) {
    return {
      status: HSINCHU_GEO_STATUS.OUTSIDE_HSINCHU,
      reason: `text_explicit_non_hsinchu_place:${matchedOther}`,
      evidence: { tier: 'text', matchedText: matchedOther },
    };
  }

  return null;
}

// ---------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------

/**
 * TDX ONLY. The one canonical geography authority for whether a TDX
 * Freeway/Highway RoadEvent may proceed toward the AI Queue / Production
 * LINE at all (order section 二/十二).
 *
 * @param {object} event - a tdx/normalize.js#normalizeRoadEvent() output
 *   (source ∈ {freeway, highway}) — must already carry this round's
 *   preserved `positions`/`latitude`/`longitude` fields for the
 *   coordinate tier to see them.
 * @returns {{status: 'CONFIRMED_HSINCHU'|'OUTSIDE_HSINCHU'|'UNKNOWN', reason: string, evidence: object}}
 */
export function resolveTdxHsinchuGeography(event) {
  if (!event || typeof event !== 'object') {
    return { status: HSINCHU_GEO_STATUS.UNKNOWN, reason: 'event_missing', evidence: {} };
  }

  const coordinateResult = resolveByCoordinates(event);
  if (coordinateResult) return coordinateResult;

  const textResult = resolveByText(event);
  if (textResult) return textResult;

  // Neither tier 1 nor tier 3 reached a verdict — tier 2 (KM) is recorded
  // as observability evidence only, never as the decision (see this
  // module's own header + describeKmHeuristic's own comment).
  return {
    status: HSINCHU_GEO_STATUS.UNKNOWN,
    reason: 'no_reliable_geographic_evidence',
    evidence: {
      tier: 'none',
      kmHeuristic: describeKmHeuristic(event),
      note: 'no valid coordinates, no confident text match — order section 十一: UNKNOWN fails closed exactly like OUTSIDE_HSINCHU',
    },
  };
}
