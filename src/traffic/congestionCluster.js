// Merges same-run congestion (type==='congestion') events that clearly
// describe the same traffic jam into one synthetic "cluster candidate",
// so a driver hears about one continuous backup once, not once per TDX
// tick as the reported KM range wobbles (91K～82K -> 89K～82K -> ...).
//
// Only congestion is clustered here — accident/construction/closure/
// control/alert/other pass through completely untouched, in their
// original order, per the explicit "事故不要套壅塞冷卻" requirement (that
// requirement is really enforced in broadcastPipeline.js/notified.js, but
// clustering only ever touching congestion is the first line of it).
//
// This module never mutates or replaces the original TDX events — dedupe.js's
// own source:rawId based state (traffic:dedupe-state) is completely
// untouched by anything here; a cluster candidate is a brand new object,
// and `members` on each cluster keeps references to the real underlying
// events for callers that need to reason about their individual lifecycle
// (see broadcastPipeline.js's cluster-aware contentSince computation).

import { parseKM } from './roadSectionLabel.js';

// "彼此距離 <= 1 km" — same constant referenced by name everywhere a gap
// threshold is needed, per "不要硬寫 magic number 到很多地方".
export const CONGESTION_CLUSTER_MAX_GAP_KM = 1;

function groupKey(event) {
  return `${event.road}|${event.direction}`;
}

function latestIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function earliestValidIso(values) {
  const valid = values.filter((v) => v && Number.isFinite(new Date(v).getTime()));
  if (valid.length === 0) return null;
  return valid.reduce((min, v) => (new Date(v).getTime() < new Date(min).getTime() ? v : min));
}

// The notification key's corridor component is DELIBERATELY not the
// same precise anchor-pair the display label uses (getRoadSectionLabel's
// own corridorId) — a real jam's reported range genuinely shrinks/grows
// tick to tick (e.g. 91K～82K -> 89K～82K -> 83K～84K, all "the same"
// backup as it clears), and snapping to the nearest anchor PAIR per tick
// would flip which anchors are "touched" as soon as the range narrows
// onto just one of them — defeating the whole point of the cooldown.
// Instead: bucket the cluster's own midpoint into a wide, fixed zone.
// Wide enough that the shrink/grow patterns actually seen in production
// reports stay in the same zone; still fine enough that two genuinely
// distant jams on the same road+direction don't share one cooldown.
const CORRIDOR_ZONE_WIDTH_KM = 10;

function corridorZoneId(minKM, maxKM) {
  const midpoint = (minKM + maxKM) / 2;
  return `z${Math.floor(midpoint / CORRIDOR_ZONE_WIDTH_KM)}`;
}

function buildCandidate(members, road, direction) {
  // members: [{ event, startKM, endKM, min, max }], all same road+direction.
  const minKM = Math.min(...members.map((m) => m.min));
  const maxKM = Math.max(...members.map((m) => m.max));

  // Direction-of-travel KM ordering (91→82 vs 83→91) is consistent per
  // direction in real TDX data — reuse whichever member's own start>end
  // sign is present so the merged candidate's KM line still reads in
  // direction-of-travel order, not always-ascending.
  const descending = members.some((m) => m.startKM > m.endKM);
  const startKM = descending ? maxKM : minKM;
  const endKM = descending ? minKM : maxKM;

  const updatedAt = members.reduce((acc, m) => latestIso(acc, m.event.updatedAt), null);
  const startTime = earliestValidIso(members.map((m) => m.event.startTime));
  const description = members.reduce((acc, m) => (m.event.updatedAt === updatedAt ? m.event.description : acc), members[0].event.description);

  // The driver-readable label itself is intentionally NOT computed here —
  // messageFormat.js calls getRoadSectionLabel() fresh on the candidate's
  // startKM/endKM at message-format time, exactly like it does for any
  // other event. Only the coarse notification-key zone is computed here.
  const notificationKey = `congestion:${road}:${direction}:${corridorZoneId(minKM, maxKM)}`;

  const kmFmt = (km) => `${km}K`;
  const location = `${road} ${direction} ${kmFmt(startKM)} - ${kmFmt(endKM)}`.trim();

  const candidate = {
    source: 'congestion-cluster',
    rawId: members.map((m) => `${m.event.source}:${m.event.rawId}`).sort().join('+'),
    type: 'congestion',
    title: `${road} ${direction} 嚴重壅塞`,
    description,
    road,
    direction,
    location,
    startTime,
    endTime: null, // congestion is a "live" event type — open-ended until it drops out of the feed, see effectiveWindow.js
    updatedAt,
    startKM,
    endKM,
  };

  return {
    candidate,
    notificationKey,
    members: members.map((m) => m.event),
    minKM,
    maxKM,
  };
}

/**
 * @param {object[]} events - this run's Hsinchu-filtered, normalized events
 *   (any mix of types).
 * @returns {{ nonCongestionEvents: object[], congestionClusters: Array<{
 *   candidate: object, notificationKey: string, members: object[],
 *   minKM: number, maxKM: number
 * }> }}
 */
export function clusterCongestionEvents(events) {
  const nonCongestionEvents = [];
  const congestionByGroup = new Map();

  for (const event of events) {
    if (event.type !== 'congestion') {
      nonCongestionEvents.push(event);
      continue;
    }

    const startKM = parseKM(event.startKM);
    const endKM = parseKM(event.endKM);
    if (startKM === null || endKM === null) {
      // Can't place it on the map — never silently drop a congestion
      // event just because clustering can't group it; treat it as its
      // own singleton "cluster" (still routed through notified state
      // via source:rawId, since there's no reliable corridor to key on).
      nonCongestionEvents.push(event);
      continue;
    }

    const key = groupKey(event);
    if (!congestionByGroup.has(key)) congestionByGroup.set(key, []);
    congestionByGroup.get(key).push({
      event,
      startKM: event.startKM,
      endKM: event.endKM,
      min: Math.min(startKM, endKM),
      max: Math.max(startKM, endKM),
    });
  }

  const congestionClusters = [];

  for (const items of congestionByGroup.values()) {
    const { road, direction } = items[0].event;
    const sorted = [...items].sort((a, b) => a.min - b.min);

    let current = [sorted[0]];
    let currentMax = sorted[0].max;

    for (let i = 1; i < sorted.length; i += 1) {
      const item = sorted[i];
      if (item.min <= currentMax + CONGESTION_CLUSTER_MAX_GAP_KM) {
        current.push(item);
        currentMax = Math.max(currentMax, item.max);
      } else {
        congestionClusters.push(buildCandidate(current, road, direction));
        current = [item];
        currentMax = item.max;
      }
    }
    congestionClusters.push(buildCandidate(current, road, direction));
  }

  return { nonCongestionEvents, congestionClusters };
}
