// Maps raw TDX records onto the unified event schema:
//
// {
//   source, type, title, description, road, direction, location,
//   startTime, endTime, updatedAt, rawId,
// }
//
// Field names below are best-effort guesses at the real TDX schema (this
// session could not reach the live Swagger to verify them — see
// TDX_SOURCE_AUDIT.md). Every mapper tries several plausible field names
// and falls back gracefully rather than throwing, and /debug/tdx exposes
// raw samples so the mapping can be corrected once verified against real
// responses.

import { firstDefined, get } from './extract.js';
import { classifyByKeyword, classifyAlertText } from './classify.js';

const EVENT_TYPE_TEXT_MAP = {
  事故: 'accident',
  交通事故: 'accident',
  車禍: 'accident',
  施工: 'construction',
  道路施工: 'construction',
  封閉: 'closure',
  道路封閉: 'closure',
  管制: 'control',
  交通管制: 'control',
  壅塞: 'congestion',
  車多: 'congestion',
};

function mapRoadEventType(raw, description) {
  const rawType = firstDefined(raw, ['EventType', 'EventSubType', 'Category'], '');
  if (rawType) {
    const key = String(rawType).trim();
    if (EVENT_TYPE_TEXT_MAP[key]) return EVENT_TYPE_TEXT_MAP[key];
    const byKeyword = classifyByKeyword(key);
    if (byKeyword !== 'other') return byKeyword;
  }
  return classifyByKeyword(description);
}

/** Freeway / Highway live road events (v1 Traffic/RoadEvent/LiveEvent/*). */
export function normalizeRoadEvent(raw, source) {
  const description = firstDefined(
    raw,
    ['Description', 'EventDescription', 'Remark', 'EventName'],
    ''
  );

  const startKM = firstDefined(
    raw,
    ['Location.StartLocationMile', 'StartLocationMile', 'Location.StartMile', 'StartMile'],
    undefined
  );
  const endKM = firstDefined(
    raw,
    ['Location.EndLocationMile', 'EndLocationMile', 'Location.EndMile', 'EndMile'],
    undefined
  );
  const blockedLanes = firstDefined(
    raw,
    ['ImpactLane.BlockedLanesNum', 'BlockedLanesNum', 'ImpactLane.Description', 'ImpactLaneDescription'],
    undefined
  );

  return {
    source,
    type: mapRoadEventType(raw, description),
    title: firstDefined(
      raw,
      ['EventName', 'EventType', 'Description'],
      source === 'freeway' ? '國道路況事件' : '省道路況事件'
    ),
    description,
    road: String(firstDefined(raw, ['RoadName', 'RoadID'], '')),
    direction: String(firstDefined(raw, ['Direction', 'RoadDirection'], '')),
    location: String(
      firstDefined(raw, ['LocationDescription', 'Location.Description', 'LocationMile'], '')
    ),
    startTime: firstDefined(raw, ['EventStartTime', 'StartTime', 'OccurTime'], null) || null,
    endTime: firstDefined(raw, ['EventEndTime', 'EndTime'], null) || null,
    updatedAt: firstDefined(raw, ['UpdateTime', 'DataCollectTime', 'SrcUpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['EventID', 'ID', 'id'], '')),
    ...(startKM !== undefined ? { startKM } : {}),
    ...(endKM !== undefined ? { endKM } : {}),
    ...(blockedLanes !== undefined ? { blockedLanes } : {}),
  };
}

function extractCmsText(raw) {
  const candidatePaths = [
    'Message',
    'CMSText',
    'DisplayText',
    'Content',
    'Message.MessageRow1',
    'Message.MessageRow2',
    'Message.MessageRow3',
    'MessageRow1',
    'MessageRow2',
    'MessageRow3',
  ];

  const parts = [];
  for (const path of candidatePaths) {
    const value = get(raw, path);
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          parts.push(item.trim());
        } else if (item && typeof item === 'object') {
          for (const nested of Object.values(item)) {
            if (typeof nested === 'string' && nested.trim()) parts.push(nested.trim());
          }
        }
      }
    }
  }

  return [...new Set(parts)].join(' ');
}

/** City CMS signboards (v2 Road/Traffic/Live/CMS/City/{City}). */
export function normalizeCmsEvent(raw) {
  const text = extractCmsText(raw);
  return {
    source: 'cms',
    type: classifyByKeyword(text),
    title: text ? text.slice(0, 30) : 'CMS 看板訊息',
    description: text,
    road: String(firstDefined(raw, ['RoadName', 'RoadID'], '')),
    direction: String(firstDefined(raw, ['Direction', 'RoadDirection'], '')),
    location: String(firstDefined(raw, ['LocationMile', 'LocationDescription'], '')),
    startTime: null,
    endTime: null,
    updatedAt: firstDefined(raw, ['UpdateTime', 'DataCollectTime', 'SrcUpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['CMSID', 'ID', 'id'], '')),
  };
}

/** City / InterCity bus operational alerts (v2 Bus/Alert/City/{City}). */
export function normalizeBusAlert(raw, source) {
  const description = firstDefined(
    raw,
    ['Description', 'AlertText', 'Content', 'ODescription', 'Title'],
    ''
  );
  const title = firstDefined(
    raw,
    ['Title', 'RouteName', 'AlertTitle'],
    description ? description.slice(0, 30) : '公車動態公告'
  );

  return {
    source,
    type: description ? classifyAlertText(description) : 'alert',
    title,
    description,
    road: String(firstDefined(raw, ['RouteName', 'RouteID'], '')),
    direction: String(firstDefined(raw, ['Direction'], '')),
    location: String(firstDefined(raw, ['Location', 'AffectedSection'], '')),
    startTime: firstDefined(raw, ['EffectiveTime', 'StartTime', 'PublishTime'], null) || null,
    endTime: firstDefined(raw, ['ExpireTime', 'EndTime'], null) || null,
    updatedAt: firstDefined(raw, ['PublishTime', 'UpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['AlertID', 'ID', 'id', 'RouteID'], '')),
  };
}
