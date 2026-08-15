// The 5 confirmed TDX sources for V1.1, and the glue to fetch + normalize
// each one independently (so one source failing never breaks the others).

import { fetchTdxJson } from './client.js';
import { extractArray } from './extract.js';
import { normalizeRoadEvent, normalizeCmsEvent, normalizeBusAlert } from './normalize.js';

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
  },
  {
    id: 'highway',
    label: '省道即時道路事件',
    url: `${BASE}/v1/Traffic/RoadEvent/LiveEvent/Highway?$format=JSON`,
    extractKeys: ['RoadEvents', 'Events', 'LiveEvents'],
    normalize: (raw) => normalizeRoadEvent(raw, 'highway'),
  },
  {
    id: 'cms',
    label: '新竹市 CMS 即時看板',
    url: `${BASE}/v2/Road/Traffic/Live/CMS/City/Hsinchu?$format=JSON`,
    extractKeys: ['CMSs', 'CMSLives', 'Data'],
    normalize: normalizeCmsEvent,
    filter: isRoadConditionCms,
  },
  {
    id: 'bus-hsinchu',
    label: '新竹市公車營運通阻',
    url: `${BASE}/v2/Bus/Alert/City/Hsinchu?$format=JSON`,
    extractKeys: ['Alerts', 'BusAlerts'],
    normalize: (raw) => normalizeBusAlert(raw, 'bus-hsinchu'),
    filter: (item) => !isNormalOperationBusAlert(item),
  },
  {
    id: 'bus-hsinchu-county',
    label: '新竹縣公車營運通阻',
    url: `${BASE}/v2/Bus/Alert/City/HsinchuCounty?$format=JSON`,
    extractKeys: ['Alerts', 'BusAlerts'],
    normalize: (raw) => normalizeBusAlert(raw, 'bus-hsinchu-county'),
    filter: (item) => !isNormalOperationBusAlert(item),
  },
];

/**
 * Fetch + normalize a single source. Throws (TdxApiError) on transport/HTTP
 * failure so the caller can report it per-source; never throws for a
 * malformed individual record — those are just skipped.
 */
export async function fetchSource(source, accessToken) {
  const json = await fetchTdxJson(source.url, accessToken, { source: source.id });
  const rawItems = extractArray(json, source.extractKeys);

  const normalized = rawItems
    .map((item) => {
      if (!item || typeof item !== 'object') return null; // skip malformed records
      try {
        return source.normalize(item);
      } catch {
        return null; // one bad record shouldn't drop the whole source
      }
    })
    .filter(Boolean)
    .filter((item) => (source.filter ? source.filter(item) : true));

  return { rawItems, normalized };
}
