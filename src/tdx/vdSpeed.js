// TDX Freeway VD (Vehicle Detector) real-time speed — used ONLY to
// confirm/upgrade a RoadEvent/PBS "congestion" report to 'severe' (see
// ../traffic/congestionValidation.js, ../traffic/congestionSeverity.js).
// This module NEVER produces a broadcast event on its own, and a
// failure anywhere in it must never propagate — see fetchFreewayVdSpeeds
// below, which always resolves (never throws) and reports `ok:false`
// instead.
//
// SCHEMA CONFIDENCE — read before "fixing" a field name here:
// this sandbox's network egress policy blocks tdx.transportdata.tw
// entirely (same limitation TDX_SOURCE_AUDIT.md documents for the rest
// of this project — see also pbsConfig.js's identical caveat about
// rtr.pbs.gov.tw), so the exact response shape below could NOT be
// verified against a live response before this round shipped. The
// endpoint paths follow TDX's own established `Live/{Type}` convention
// already confirmed correct elsewhere in this codebase (Live/CMS,
// RoadEvent/LiveEvent/Freeway — see sources.js), but the FIELD names
// inside each record are a best-effort guess at TDX's standard VD
// schema — deliberately read via multiple candidate names (the same
// firstDefined()/extractArray() defensive pattern normalize.js already
// uses) so a slightly different real shape degrades to "no usable
// reading" rather than crashing or misreporting. Confirm the real shape
// via GET /debug/tdx-vd once deployed and tighten the candidate lists
// below if anything doesn't match — same "verify once deployed"
// workflow already established for every other TDX source (see
// TDX_SOURCE_AUDIT.md).

import { fetchTdxJson } from './client.js';
import { extractArray, firstDefined, get } from './extract.js';
import { getAccessToken } from './auth.js';
import { parseKM } from '../traffic/roadSectionLabel.js';

const VD_STATIC_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/Freeway?$format=JSON';
const VD_LIVE_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON';

// TDX VD datasets commonly report direction as a single compass letter
// rather than the Chinese "北向"/"南向" RoadEvent/PBS events use —
// normalize both conventions to the Chinese form so matching against a
// unified event's `direction` field works either way.
const DIRECTION_CODE_MAP = { N: '北向', S: '南向', E: '東向', W: '西向' };

function normalizeVdDirection(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  return DIRECTION_CODE_MAP[trimmed.toUpperCase()] || trimmed;
}

function toFiniteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** VD static metadata record -> { vdid, road, direction, km } | null if unusable. */
function normalizeVdStatic(raw) {
  const vdid = firstDefined(raw, ['VDID', 'VDId', 'ID'], null);
  if (!vdid) return null;

  const road = String(firstDefined(raw, ['RoadName', 'RoadID'], ''));
  const direction = normalizeVdDirection(firstDefined(raw, ['RoadDirection', 'Direction'], ''));
  const kmRaw = firstDefined(raw, ['LocationMile', 'RoadSection.Start', 'Mile'], undefined);
  const km = parseKM(kmRaw);

  if (!road || km === null) return null; // no usable geo signal -> not joinable, skip
  return { vdid: String(vdid), road, direction, km };
}

/**
 * A single VD live record can report several lanes; take the SLOWEST
 * (minimum) reported speed as this detector's representative reading —
 * the conservative choice for "is this genuinely congested", never the
 * fastest lane. Tries a couple of plausible shapes defensively (see
 * module comment); returns null if nothing usable is found.
 */
function extractSlowestSpeedKph(raw) {
  const speeds = [];

  const linkFlows = Array.isArray(raw.LinkFlows) ? raw.LinkFlows : [];
  for (const link of linkFlows) {
    const lanes = Array.isArray(link && link.Lanes) ? link.Lanes : [];
    for (const lane of lanes) {
      const speed = toFiniteNumberOrNull(get(lane, 'Speed'));
      // TDX commonly uses -99/-1 as "no data" sentinels — never treat
      // those as a real (very slow) reading.
      if (speed !== null && speed >= 0) speeds.push(speed);
    }
  }

  // Fallback shape: a bare Speed directly on the record, or a flat
  // Lanes array with no LinkFlows wrapper.
  if (speeds.length === 0) {
    const directSpeed = toFiniteNumberOrNull(get(raw, 'Speed'));
    if (directSpeed !== null && directSpeed >= 0) speeds.push(directSpeed);
    const flatLanes = Array.isArray(raw.Lanes) ? raw.Lanes : [];
    for (const lane of flatLanes) {
      const speed = toFiniteNumberOrNull(get(lane, 'Speed'));
      if (speed !== null && speed >= 0) speeds.push(speed);
    }
  }

  return speeds.length > 0 ? Math.min(...speeds) : null;
}

/**
 * Fetches + joins VD static metadata and live speed into a flat list of
 * `{ road, direction, km, speedKph }` readings. NEVER throws — any
 * network/parse/shape failure resolves to `{ ok: false, records: [] }`
 * so a caller (congestionValidation.js) can treat "can't confirm" as a
 * normal, expected outcome, not an error to handle specially.
 */
export async function fetchFreewayVdSpeeds(env) {
  try {
    const accessToken = await getAccessToken(env);

    const [staticJson, liveJson] = await Promise.all([
      fetchTdxJson(VD_STATIC_URL, accessToken, { source: 'vd-static' }),
      fetchTdxJson(VD_LIVE_URL, accessToken, { source: 'vd-live' }),
    ]);

    const staticByVdid = new Map();
    for (const raw of extractArray(staticJson, ['VDs', 'Data'])) {
      const meta = normalizeVdStatic(raw);
      if (meta) staticByVdid.set(meta.vdid, meta);
    }

    const records = [];
    for (const raw of extractArray(liveJson, ['VDLives', 'Data'])) {
      const vdid = String(firstDefined(raw, ['VDID', 'VDId', 'ID'], ''));
      const meta = staticByVdid.get(vdid);
      if (!meta) continue; // no static geo info for this detector -> can't place it, skip

      const speedKph = extractSlowestSpeedKph(raw);
      if (speedKph === null) continue;

      records.push({ road: meta.road, direction: meta.direction, km: meta.km, speedKph });
    }

    return { ok: true, records, error: null };
  } catch (err) {
    return { ok: false, records: [], error: err && err.message ? err.message : 'Unknown error' };
  }
}

// How far (KM) a VD detector may be from a reported congestion event's
// own KM and still count as "nearby" evidence for it — same order of
// magnitude as PBS/TDX cross-source matching's own KM tolerance (see
// pbsConfig.js's CROSS_SOURCE_MAX_KM_DIFF), kept as its own named
// constant since this is a conceptually different match (VD-to-event,
// not PBS-to-TDX).
export const VD_MATCH_MAX_KM_DIFF = 3;

/**
 * The slowest nearby VD reading for a given road/direction/KM, or null
 * if none is within VD_MATCH_MAX_KM_DIFF — same "slowest wins" principle
 * as extractSlowestSpeedKph, for the same reason (never let one fast
 * detector mask a genuinely slow neighbor).
 */
export function findNearbySpeedKph(records, { road, direction, km }) {
  if (km === null || km === undefined || !Number.isFinite(km)) return null;

  let slowest = null;
  for (const record of records) {
    if (record.road !== road) continue;
    if (direction && record.direction && record.direction !== direction) continue;
    if (Math.abs(record.km - km) > VD_MATCH_MAX_KM_DIFF) continue;
    if (slowest === null || record.speedKph < slowest) slowest = record.speedKph;
  }
  return slowest;
}
