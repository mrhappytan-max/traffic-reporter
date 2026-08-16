// Maps raw TDX records onto the unified event schema:
//
// {
//   source, type, title, description, road, direction, location,
//   startTime, endTime, updatedAt, rawId,
// }
//
// Freeway/Highway field mapping below was corrected against a real TDX
// response verified via the deployed /debug/tdx endpoint (see commit
// history / TDX_SOURCE_AUDIT.md for the earlier, unverified guesses).
// CMS and Bus Alert mappings still carry defensive fallbacks since only
// the "ignore" rules for those two were confirmed against real data, not
// every field name.
//
// V1.4.1: when `type` comes out as 'congestion', also attach a
// `congestionSeverity` ('moderate'|'congested'|null) derived from the
// SAME source text that decided the type — see congestionSeverity.js for
// why this exists (車多 vs 壅塞 must not both read as "嚴重壅塞") and for
// the only path allowed to ever set 'severe'.

import { firstDefined, get } from './extract.js';
import { classifyByKeyword, classifyAlertText } from './classify.js';
import { classifyCongestionSeverity } from '../traffic/congestionSeverity.js';

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

// Checks EventType, then EventSubType, then Category independently (rather
// than stopping at whichever is present first) so a generic EventType
// doesn't shadow a more specific EventSubType.
function mapRoadEventType(raw, description) {
  const candidates = [get(raw, 'EventType'), get(raw, 'EventSubType'), get(raw, 'Category')].filter(
    (v) => v !== undefined && v !== null && v !== ''
  );

  for (const candidate of candidates) {
    const key = String(candidate).trim();
    if (EVENT_TYPE_TEXT_MAP[key]) return EVENT_TYPE_TEXT_MAP[key];
    const byKeyword = classifyByKeyword(key);
    if (byKeyword !== 'other') return byKeyword;
  }

  return classifyByKeyword(description);
}

// Same candidate fields mapRoadEventType() reads from, concatenated so
// classifyCongestionSeverity() sees whichever of them actually carried
// the 車多/壅塞-type keyword — deliberately NOT trying to track which
// single candidate "won" in mapRoadEventType above, since a plain
// substring search over all of them together is simpler and just as
// correct here (unlike type classification, severity has no "first
// specific match wins" ordering requirement).
function roadEventCongestionSeverityText(raw, description) {
  return [get(raw, 'EventType'), get(raw, 'EventSubType'), get(raw, 'Category'), description]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .join(' ');
}

function composeLocation({ road, direction, startKM, endKM }) {
  const parts = [];
  if (road) parts.push(String(road));
  if (direction) parts.push(String(direction));
  if (startKM !== undefined || endKM !== undefined) {
    // StartKM/EndKM come back from TDX already formatted with a "K" unit
    // (e.g. "42K+000") — do not append another "K" here.
    const km = [startKM, endKM].filter((v) => v !== undefined && v !== '').join(' - ');
    if (km) parts.push(km);
  }
  return parts.join(' ');
}

/** Freeway / Highway live road events (v1 Traffic/RoadEvent/LiveEvent/*). */
export function normalizeRoadEvent(raw, source) {
  const description = firstDefined(
    raw,
    ['Description', 'EventDescription', 'Remark', 'EventName'],
    ''
  );

  const road = firstDefined(
    raw,
    ['Location.FreeExpressHighway.Road', 'RoadName', 'RoadID'],
    ''
  );
  const direction = firstDefined(
    raw,
    ['Location.FreeExpressHighway.Direction', 'Direction', 'RoadDirection'],
    ''
  );
  const startKM = firstDefined(
    raw,
    ['Location.FreeExpressHighway.StartKM', 'Location.StartLocationMile', 'StartLocationMile'],
    undefined
  );
  const endKM = firstDefined(
    raw,
    ['Location.FreeExpressHighway.EndKM', 'Location.EndLocationMile', 'EndLocationMile'],
    undefined
  );
  const blockedLanes = firstDefined(
    raw,
    ['Impact.BlockedLanes', 'ImpactLane.BlockedLanesNum', 'BlockedLanesNum'],
    undefined
  );

  const composedLocation = composeLocation({ road, direction, startKM, endKM });
  const location =
    composedLocation ||
    String(firstDefined(raw, ['LocationDescription', 'Location.Description', 'LocationMile'], ''));

  const type = mapRoadEventType(raw, description);

  return {
    source,
    type,
    title: firstDefined(
      raw,
      ['EventTitle', 'EventName', 'EventType', 'Description'],
      source === 'freeway' ? '國道路況事件' : '省道路況事件'
    ),
    description,
    road: String(road),
    direction: String(direction),
    location,
    startTime: firstDefined(raw, ['EffectiveTime', 'EventStartTime', 'StartTime'], null) || null,
    endTime: firstDefined(raw, ['EventEndTime', 'EndTime'], null) || null,
    updatedAt: firstDefined(raw, ['LastUpdateTime', 'UpdateTime', 'SrcUpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['EventID', 'ID', 'id'], '')),
    ...(type === 'congestion'
      ? { congestionSeverity: classifyCongestionSeverity(roadEventCongestionSeverityText(raw, description)) }
      : {}),
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
  const type = classifyByKeyword(text);
  return {
    source: 'cms',
    type,
    title: text ? text.slice(0, 30) : 'CMS 看板訊息',
    description: text,
    road: String(firstDefined(raw, ['RoadName', 'RoadID'], '')),
    direction: String(firstDefined(raw, ['Direction', 'RoadDirection'], '')),
    location: String(firstDefined(raw, ['LocationMile', 'LocationDescription'], '')),
    startTime: null,
    endTime: null,
    updatedAt: firstDefined(raw, ['UpdateTime', 'DataCollectTime', 'SrcUpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['CMSID', 'ID', 'id'], '')),
    ...(type === 'congestion' ? { congestionSeverity: classifyCongestionSeverity(text) } : {}),
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

  const type = description ? classifyAlertText(description) : 'alert';

  return {
    source,
    type,
    title,
    description,
    road: String(firstDefined(raw, ['RouteName', 'RouteID'], '')),
    direction: String(firstDefined(raw, ['Direction'], '')),
    location: String(firstDefined(raw, ['Location', 'AffectedSection'], '')),
    startTime: firstDefined(raw, ['EffectiveTime', 'StartTime', 'PublishTime'], null) || null,
    endTime: firstDefined(raw, ['ExpireTime', 'EndTime'], null) || null,
    updatedAt: firstDefined(raw, ['PublishTime', 'UpdateTime'], null) || null,
    rawId: String(firstDefined(raw, ['AlertID', 'ID', 'id', 'RouteID'], '')),
    ...(type === 'congestion' ? { congestionSeverity: classifyCongestionSeverity(description) } : {}),
  };
}
