// Turns a KM range on a national freeway into a label a driver actually
// understands ("竹北－湖口路段") instead of raw kilometer markers ("91K
// ～82K"). Deliberately its own module — not folded into messageFormat.js
// — so the KM→interchange mapping data doesn't get lost among display
// formatting code, per the project's existing pattern of centralizing
// tunable/calibratable data in one dedicated file (see hsinchuConfig.js).
//
// Scope this round: only 國道一號 and 國道三號 have anchor data, per the
// explicit instruction not to expand scope to 台1/台61/台68/etc — those
// roads fall through to `label: null`, and callers (messageFormat.js)
// fall back to the original raw-KM display for them. Never guess an
// interchange that isn't in the table below.
//
// IMPORTANT — confidence level, same caveat as hsinchuConfig.js: these KM
// anchors are best-effort estimates of where each interchange sits, not
// verified against official 公路局/國道局 里程樁 data. Recalibrate here
// if real StartKM/EndKM values (via GET /debug/status) show a mismatch
// against where a described interchange actually falls.

export const ROAD_SHORT_NAME = {
  國道一號: '國1',
  國道三號: '國3',
};

// A handful of aliases in case a TDX record ever uses a different Road
// string for the same two roads this module supports. Kept small and
// local (not a shared import from hsinchuConfig.js) so this module can be
// understood/edited on its own — see module comment.
const ROAD_ALIASES = {
  國道1號: '國道一號',
  中山高速公路: '國道一號',
  中山高: '國道一號',
  國道3號: '國道三號',
  福爾摩沙高速公路: '國道三號',
  二高: '國道三號',
};

// km: official-estimate distance marker. name: what a driver calls it.
// Ordered ascending by km — the algorithms below assume that.
const ROAD_ANCHORS = {
  國道一號: [
    { km: 83, name: '湖口' }, // 湖口交流道
    { km: 86, name: '湖口服務區' },
    { km: 91, name: '竹北' }, // 竹北交流道
    { km: 95, name: '新竹／科學園區' }, // 新竹交流道 (also serves 竹東/科學園區)
    { km: 99, name: '新竹系統' }, // 新竹系統交流道
  ],
  國道三號: [
    { km: 79, name: '關西' }, // 關西交流道
    { km: 90, name: '竹林' }, // 竹林交流道
    { km: 98, name: '寶山' }, // 寶山交流道
    { km: 100, name: '新竹系統' }, // 新竹系統交流道
    { km: 103, name: '茄苳' }, // 茄苳交流道
    { km: 109, name: '香山' }, // 香山交流道
  ],
};

// Points beyond the anchor table's first/last entry by more than this are
// genuinely unknown territory for this module — fall back to null rather
// than invent a label ("不要猜不存在的交流道").
const OUT_OF_TABLE_BUFFER_KM = 5;

// V1.2C follow-up — CORRIDOR_BOUNDARIES vs ROAD_ANCHORS, and why there
// are two separate tables:
//
// ROAD_ANCHORS (above) is fine-grained and used for the DISPLAY label —
// every named interchange gets its own point, so "竹北－湖口路段" reads
// precisely. That precision is exactly what makes it unsuitable for a
// notification-key identity: a real jam's reported range genuinely
// shrinks/grows tick to tick, and if the key snaps to "whichever anchor
// is nearest right now", a range that shrinks onto a single interchange
// (e.g. from 91K～82K down to 88K～93K) can flip which anchor pair it's
// keyed under mid-cooldown — exactly the bug this table exists to avoid.
//
// CORRIDOR_BOUNDARIES is deliberately coarser: interchanges that sit
// close together (e.g. 湖口 83K / 湖口服務區 86K, only 3km apart) are
// collapsed into ONE boundary, so a jam anywhere in that whole ~8km span
// keys the same way regardless of exactly how far it currently reaches.
// getCorridorId() below also matches by MAXIMUM OVERLAP against these
// wider segments (not "nearest single point"), which is what gives a
// shrinking/growing/drifting range hysteresis across a boundary — see
// module tests for the exact real-world progression this was built
// against (82.4K～91K shrinking through 84～91, 86～92, 88～93, all
// staying keyed to the same corridor).
const CORRIDOR_BOUNDARIES = {
  國道一號: [83, 91, 95, 99], // 湖口(+湖口服務區) | 竹北 | 新竹／科學園區 | 新竹系統
  國道三號: [79, 90, 98, 103, 109], // 關西 | 竹林 | 寶山(+新竹系統) | 茄苳 | 香山
};

// Roads without a curated boundary list (anything outside this round's
// 國道一號/國道三號 scope) still get a stable, overlap-matched corridor —
// just from a generic, wide (20km) absolute-position grid instead of
// named interchanges. Wider than the old fixed-width midpoint bucket
// this replaced, and — critically — matched by overlap, not by which
// single bucket the midpoint happens to fall in, so it has the same
// hysteresis property.
const GENERIC_CORRIDOR_WIDTH_KM = 20;

/** Parses TDX-style KM strings ("42K+000", "42K", "42.5", or a plain number) into a float. */
function parseKM(value) {
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

function resolveRoadKey(road) {
  if (!road) return null;
  const trimmed = String(road).trim();
  if (ROAD_ANCHORS[trimmed]) return trimmed;
  if (ROAD_ALIASES[trimmed]) return ROAD_ALIASES[trimmed];
  return null;
}

function nearestAnchor(anchors, km) {
  let nearest = anchors[0];
  let nearestDist = Math.abs(km - anchors[0].km);
  for (const anchor of anchors) {
    const dist = Math.abs(km - anchor.km);
    if (dist < nearestDist) {
      nearest = anchor;
      nearestDist = dist;
    }
  }
  return { anchor: nearest, dist: nearestDist };
}

/** For a single KM point: the nearest named anchor, or null if too far from every known anchor. */
function anchorForPoint(anchors, km) {
  const { anchor, dist } = nearestAnchor(anchors, km);
  if (dist <= OUT_OF_TABLE_BUFFER_KM) return anchor;
  return null;
}

/**
 * @param {{ road: string, direction?: string, startKM: string|number, endKM: string|number }} input
 * @returns {{ label: string|null, corridorId: string|null }}
 *   label: a driver-readable section name, or null if it can't be
 *     reliably determined (caller must fall back to raw KM display).
 *   corridorId: a stable identifier for this same physical corridor,
 *     independent of exactly which KM sub-range triggered it this run —
 *     for use as a congestion notification key component, not display.
 */
export function getRoadSectionLabel({ road, startKM, endKM }) {
  const roadKey = resolveRoadKey(road);
  if (!roadKey) return { label: null, corridorId: null };

  const anchors = ROAD_ANCHORS[roadKey];
  const start = parseKM(startKM);
  const end = parseKM(endKM);

  if (start === null && end === null) return { label: null, corridorId: null };

  // Single-KM-point input (only one of the two present) — treat as a point.
  if (start === null || end === null) {
    const point = start === null ? end : start;
    const anchor = anchorForPoint(anchors, point);
    if (!anchor) return { label: null, corridorId: null };
    return { label: `${anchor.name}附近`, corridorId: `${anchor.km}` };
  }

  // Two-end range — label each end by its own nearest anchor, in the
  // SAME order the caller's startKM/endKM came in (this preserves the
  // direction-of-travel ordering already used for the raw KM line, e.g.
  // 北向 91K→82K reads "竹北－湖口", 南向 83K→91K reads "湖口－竹北").
  const startAnchor = anchorForPoint(anchors, start);
  const endAnchor = anchorForPoint(anchors, end);
  if (!startAnchor || !endAnchor) return { label: null, corridorId: null };

  if (startAnchor.km === endAnchor.km) {
    return { label: `${startAnchor.name}附近`, corridorId: `${startAnchor.km}` };
  }

  const label = `${startAnchor.name}－${endAnchor.name}路段`;
  // corridorId is direction-agnostic on purpose (ascending km order) —
  // the caller combines it with `direction` separately, so 北向 and 南向
  // over the same physical stretch don't need two different corridor
  // spellings here.
  const corridorLo = Math.min(startAnchor.km, endAnchor.km);
  const corridorHi = Math.max(startAnchor.km, endAnchor.km);
  return { label, corridorId: `${corridorLo}-${corridorHi}` };
}

// Turns a sorted boundary list [b0, b1, ..., bn] into closed segments
// covering the whole number line: (-Inf, b0], [b0, b1], ..., [bn, +Inf).
// Adjacent segments deliberately share their boundary point (both sides
// "own" it) — a range landing exactly on a boundary can overlap either
// side equally, which is fine: buildCorridorSegments+matchByOverlap below
// just picks whichever segment has the larger overlap, and ties can only
// happen for a zero-width point sitting exactly on a boundary.
function buildCorridorSegments(boundaries) {
  const segments = [];
  segments.push({ lo: -Infinity, hi: boundaries[0], id: `lt${boundaries[0]}` });
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    segments.push({ lo: boundaries[i], hi: boundaries[i + 1], id: `${boundaries[i]}-${boundaries[i + 1]}` });
  }
  segments.push({ lo: boundaries[boundaries.length - 1], hi: Infinity, id: `gt${boundaries[boundaries.length - 1]}` });
  return segments;
}

// Picks the segment with the LARGEST overlap against [minKM, maxKM] —
// not "which segment contains the midpoint" — so a range that mostly
// still sits in its original corridor keeps that identity even after it
// creeps partway into the next one. A single KM point (minKM===maxKM)
// naturally falls back to "which segment contains this point".
function matchByOverlap(segments, minKM, maxKM) {
  let best = segments[0];
  let bestOverlap = -Infinity;
  for (const segment of segments) {
    const overlap = Math.min(maxKM, segment.hi) - Math.max(minKM, segment.lo);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = segment;
    }
  }
  return best.id;
}

function genericCorridorBoundaries(minKM, maxKM) {
  // Generates just enough fixed grid lines (multiples of
  // GENERIC_CORRIDOR_WIDTH_KM) to bracket this run's range, so the
  // segment-matching logic above works the same way it does for the
  // curated tables, without needing to enumerate a boundary list for
  // the entire country up front.
  const startIndex = Math.floor(minKM / GENERIC_CORRIDOR_WIDTH_KM) - 1;
  const endIndex = Math.ceil(maxKM / GENERIC_CORRIDOR_WIDTH_KM) + 1;
  const boundaries = [];
  for (let i = startIndex; i <= endIndex; i += 1) boundaries.push(i * GENERIC_CORRIDOR_WIDTH_KM);
  return boundaries;
}

/**
 * A congestion-notification-key-stable corridor identifier — see the
 * CORRIDOR_BOUNDARIES comment above for why this is a SEPARATE, coarser
 * concept from getRoadSectionLabel()'s corridorId. Always returns a
 * value (never null) for any road with usable KM input; roads outside
 * the curated table still get a stable answer from the generic grid.
 *
 * @param {{ road: string, startKM: string|number, endKM: string|number }} input
 * @returns {string|null} e.g. "83-91" — null only when neither KM value
 *   is usable at all (caller should fall back to some other key, e.g.
 *   source:rawId, for that one unplaceable event).
 */
export function getCorridorId({ road, startKM, endKM }) {
  const start = parseKM(startKM);
  const end = parseKM(endKM);
  if (start === null && end === null) return null;

  const minKM = Math.min(start ?? end, end ?? start);
  const maxKM = Math.max(start ?? end, end ?? start);

  const roadKey = resolveRoadKey(road);
  const boundaries = roadKey ? CORRIDOR_BOUNDARIES[roadKey] : null;
  const segments = buildCorridorSegments(boundaries || genericCorridorBoundaries(minKM, maxKM));
  return matchByOverlap(segments, minKM, maxKM);
}

/** Short display name ("國1") for a road, or the original string if unknown. */
export function getRoadShortName(road) {
  if (!road) return '';
  return ROAD_SHORT_NAME[road] || String(road);
}

export { parseKM };
