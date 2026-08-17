// The 5 confirmed TDX sources for V1.1, and the glue to fetch + normalize
// each one independently (so one source failing never breaks the others).

import { fetchTdxJson } from './client.js';
import { extractArray } from './extract.js';
import { normalizeRoadEvent, normalizeCmsEvent, normalizeBusAlert } from './normalize.js';
import { isHsinchuRelevant } from '../traffic/hsinchuFilter.js';

const BASE = 'https://tdx.transportdata.tw/api/basic';

// A CMS signboard only becomes an event when its text actually matches a
// road-condition keyword (classify.js) — generic safety slogans etc. stay
// type "other" and are dropped. Verified against real data: rawCount=64,
// normalized=0 for Hsinchu on the day this was checked, which is expected.
function isRoadConditionCms(item) {
  return item.type !== 'other';
}

// Bus Alert: TDX represents "nothing wrong, business as usual" as either
// AlertID "0" or a Title/Description that says 正常營運. Neither should
// ever reach the rider/driver as an "event".
function isNormalOperationBusAlert(item) {
  if (item.rawId === '0') return true;
  return /正常營運/.test(`${item.title} ${item.description}`);
}

export const SOURCES = [
  {
    id: 'freeway',
    label: '國道即時道路事件',
    url: `${BASE}/v1/Traffic/RoadEvent/LiveEvent/Freeway?$format=JSON`,
    extractKeys: ['RoadEvents', 'Events', 'LiveEvents'],
    normalize: (raw) => normalizeRoadEvent(raw, 'freeway'),
    // Freeway/Highway data is nationwide — restrict to Hsinchu-relevant
    // events here so every consumer (Cron, /debug/tdx, /debug/status)
    // gets the same filtered view for free. See src/traffic/hsinchuFilter.js.
    filter: isHsinchuRelevant,
  },
  {
    id: 'highway',
    label: '省道即時道路事件',
    url: `${BASE}/v1/Traffic/RoadEvent/LiveEvent/Highway?$format=JSON`,
    extractKeys: ['RoadEvents', 'Events', 'LiveEvents'],
    normalize: (raw) => normalizeRoadEvent(raw, 'highway'),
    filter: isHsinchuRelevant,
  },
  {
    id: 'cms',
    label: '新竹市 CMS 即時看板',
    // Already Hsinchu-scoped by the City=Hsinchu query param — no
    // additional geo filter needed.
    url: `${BASE}/v2/Road/Traffic/Live/CMS/City/Hsinchu?$format=JSON`,
    extractKeys: ['CMSs', 'CMSLives', 'Data'],
    normalize: normalizeCmsEvent,
    filter: isRoadConditionCms,
  },
  {
    id: 'bus-hsinchu',
    label: '新竹市公車營運通阻',
    // Already Hsinchu-scoped by the City=Hsinchu query param.
    url: `${BASE}/v2/Bus/Alert/City/Hsinchu?$format=JSON`,
    extractKeys: ['Alerts', 'BusAlerts'],
    normalize: (raw) => normalizeBusAlert(raw, 'bus-hsinchu'),
    filter: (item) => !isNormalOperationBusAlert(item),
  },
  {
    id: 'bus-hsinchu-county',
    label: '新竹縣公車營運通阻',
    // Already Hsinchu-scoped by the City=HsinchuCounty query param.
    url: `${BASE}/v2/Bus/Alert/City/HsinchuCounty?$format=JSON`,
    extractKeys: ['Alerts', 'BusAlerts'],
    normalize: (raw) => normalizeBusAlert(raw, 'bus-hsinchu-county'),
    filter: (item) => !isNormalOperationBusAlert(item),
  },
];

// V1.6.1 — "資料來源與 TDX 用量瘦身": the production Cron (scheduled.js)
// now only ever fetches these two sources — CMS/Bus Alert (Hsinchu city
// and county) are retired from all SCHEDULED fetching, never proving
// broadcast-worthy in practice, and VD is separately no longer called for
// congestion validation at all (see congestionValidation.js's module
// comment / scheduled.js — V1.5 already excludes pure congestion from
// broadcast, so VD confirmation serves no production purpose anymore).
// CMS/Bus Alert definitions above are NOT deleted — GET /debug/tdx and
// GET /debug/status (on-demand, human-triggered, never scheduled) still
// fetch all 5 sources unchanged, for diagnostic purposes.
export const PRODUCTION_TDX_SOURCE_IDS = ['freeway', 'highway'];

/**
 * Fetch + normalize a single source. Throws (TdxApiError) on transport/HTTP
 * failure so the caller can report it per-source; never throws for a
 * malformed individual record — those are just skipped.
 *
 * A source's `filter(normalizedItem, rawItem)` — when present — decides
 * whether a record should be kept; it receives both the normalized event
 * and the original raw record (some filters, like the Hsinchu geo filter,
 * need raw fields that aren't part of the unified schema).
 *
 * Returns both `normalizedAll` (everything that parsed successfully,
 * before any source-specific filter) and `normalized` (after the filter)
 * so callers can report a normalizedCount vs. a post-filter count
 * separately — see /debug/status.
 */
export async function fetchSource(source, accessToken) {
  const json = await fetchTdxJson(source.url, accessToken, { source: source.id });
  const rawItems = extractArray(json, source.extractKeys);

  const normalizedAll = [];
  const normalized = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue; // skip malformed records
    let item;
    try {
      item = source.normalize(raw);
    } catch {
      continue; // one bad record shouldn't drop the whole source
    }
    normalizedAll.push(item);
    if (source.filter && !source.filter(item, raw)) continue;
    normalized.push(item);
  }

  return { rawItems, normalizedAll, normalized };
}
