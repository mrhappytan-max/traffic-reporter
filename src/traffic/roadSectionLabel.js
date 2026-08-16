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

/** Short display name ("國1") for a road, or the original string if unknown. */
export function getRoadShortName(road) {
  if (!road) return '';
  return ROAD_SHORT_NAME[road] || String(road);
}

export { parseKM };
