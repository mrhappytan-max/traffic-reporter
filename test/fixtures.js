// Fixtures shaped after real TDX response fields confirmed via the
// deployed /debug/tdx and /debug/status endpoints (see the V1.1.1 and
// V1.2A schema-correction commits). Road names use the Chinese-numeral
// form ("國道一號") and StartKM/EndKM use the "NNK+NNN" string format,
// both confirmed from real production output.

export const realFreewayEvent = {
  EventID: 'FRW-2026-0815-001',
  EventTitle: '國道一號北向92K車輛事故',
  EventType: '事故',
  EventSubType: '一般事故',
  Description: '北向92K處發生車輛事故，外側車道封閉，請小心慢行',
  EffectiveTime: '2026-08-15T08:12:00+08:00',
  LastUpdateTime: '2026-08-15T08:20:00+08:00',
  Location: {
    FreeExpressHighway: {
      Road: '國道一號',
      Direction: '北向',
      StartKM: '92K+500',
      EndKM: '91K+800',
    },
  },
  Impact: {
    BlockedLanes: 1,
  },
};

// Same shape as the real report that triggered the double-K bug fix:
// 國道一號 北向 42K+000 - 39K+000 (Taoyuan-area KM, well outside the
// Hsinchu range and no 新竹 mention) — should be geo-filtered out.
export const freewayEventOutsideHsinchu = {
  EventID: 'FRW-2026-0815-777',
  EventTitle: '國道一號北向42K車多',
  EventType: '壅塞',
  Description: '北向42K至39K路段車多，請注意行車安全',
  EffectiveTime: '2026-08-15T08:00:00+08:00',
  LastUpdateTime: '2026-08-15T08:05:00+08:00',
  Location: {
    FreeExpressHighway: {
      Road: '國道一號',
      Direction: '北向',
      StartKM: '42K+000',
      EndKM: '39K+000',
    },
  },
};

// Not one of the priority Freeway roads at all.
export const freewayEventUnknownRoad = {
  EventID: 'FRW-2026-0815-555',
  EventTitle: '國道五號事故',
  EventType: '事故',
  Description: '國道五號雪山隧道發生事故',
  Location: {
    FreeExpressHighway: { Road: '國道五號', Direction: '南向', StartKM: '5K+000', EndKM: '6K+000' },
  },
};

export const realHighwayConstructionEvent = {
  EventID: 'HWY-2026-0815-014',
  EventTitle: '台68線東向5K道路施工',
  EventType: '施工',
  EventSubType: '道路維修工程',
  Description: '東向5K處進行路面維修工程，夜間施工',
  EffectiveTime: '2026-08-15T22:00:00+08:00',
  LastUpdateTime: '2026-08-15T21:30:00+08:00',
  Location: {
    FreeExpressHighway: {
      Road: '台68線',
      Direction: '東向',
      StartKM: '4K+500',
      EndKM: '6K+000',
    },
  },
  Impact: {
    BlockedLanes: 0,
  },
};

// 台1線 within the configured Hsinchu range (新竹市區 一帶).
export const highwayEventTai1InRange = {
  EventID: 'HWY-2026-0815-090',
  EventTitle: '台1線新竹市區施工',
  EventType: '施工',
  Description: '台1線新竹市區路段夜間施工',
  Location: {
    FreeExpressHighway: { Road: '台1線', Direction: '南向', StartKM: '90K+000', EndKM: '91K+000' },
  },
};

// KM is just outside the configured 台1線 range but within the boundary
// buffer, and the description mentions 新竹 — should be pulled in.
export const highwayEventTai1BorderlineWithMention = {
  EventID: 'HWY-2026-0815-102',
  EventTitle: '台1線事故',
  EventType: '事故',
  Description: '台1線新竹頭前溪橋路段發生事故',
  Location: {
    FreeExpressHighway: { Road: '台1線', Direction: '北向', StartKM: '102K+000', EndKM: '102K+500' },
  },
};

// 台1線 clearly outside the Hsinchu range (Taipei area) — should be
// dropped even though the road name matches.
export const highwayEventTai1FarOutsideRange = {
  EventID: 'HWY-2026-0815-010',
  EventTitle: '台1線事故',
  EventType: '事故',
  Description: '台1線板橋路段發生事故',
  Location: {
    FreeExpressHighway: { Road: '台1線', Direction: '南向', StartKM: '10K+000', EndKM: '11K+000' },
  },
};

// No KM at all, but Positions fall inside the Hsinchu bounding box.
export const highwayEventPositionOnly = {
  EventID: 'HWY-2026-0815-200',
  EventTitle: '台3線事故',
  EventType: '事故',
  Description: '台3線路段發生事故',
  Location: { FreeExpressHighway: { Road: '台3線', Direction: '南向' } },
  Positions: [{ PositionLon: 121.0, PositionLat: 24.7 }],
};

// No KM and no position at all — must fail closed (excluded).
export const highwayEventNoLocationSignal = {
  EventID: 'HWY-2026-0815-201',
  EventTitle: '台3線事故',
  EventType: '事故',
  Description: '台3線路段發生事故',
  Location: { FreeExpressHighway: { Road: '台3線', Direction: '南向' } },
};

// --- V1.8.6.4: 台3線 message-clarity regression fixtures ---
//
// Same raw TDX Highway/RoadEvent shape used throughout this file
// (Location.FreeExpressHighway.{Road,Direction,StartKM,EndKM}, EventType,
// Description) — these additionally carry `LocationDescription`, the
// field `tdx/normalize.js` already listed as a known real-response
// candidate (see that module's own comment/history) but which used to be
// silently shadowed by composeLocation() whenever StartKM/EndKM was also
// present. This is the exact production repro shape (structured KM +
// genuine human section text, both present) — reproducing the reported
// 台3線 issue without needing a live TDX call.

// 施工, 雙向, WITH a genuine human LocationDescription alongside real KM.
export const highwayTai3ConstructionWithLocationDescription = {
  EventID: 'HWY-2026-0819-301',
  EventTitle: '台3線雙向78K道路施工',
  EventType: '施工',
  Description: '台3線雙向路段進行路面施工，請注意車道管制',
  LocationDescription: '關西－橫山路段',
  EffectiveTime: '2026-08-19T08:00:00+08:00',
  LastUpdateTime: '2026-08-19T08:10:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' },
  },
};

// Same 台3線 施工 event, but the source did NOT supply any location
// description text this time — must fall back to bare road+direction and
// still show the real KM, never an invented section name.
export const highwayTai3ConstructionNoLocationDescription = {
  EventID: 'HWY-2026-0819-302',
  EventTitle: '台3線雙向78K道路施工',
  EventType: '施工',
  Description: '台3線雙向路段進行路面施工，請注意車道管制',
  EffectiveTime: '2026-08-19T08:00:00+08:00',
  LastUpdateTime: '2026-08-19T08:10:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '78K+500', EndKM: '79K+200' },
  },
};

// 事故 (accident) on 台3線, single-direction, with LocationDescription.
export const highwayTai3AccidentWithLocationDescription = {
  EventID: 'HWY-2026-0819-303',
  EventTitle: '台3線南向事故',
  EventType: '事故',
  Description: '南向發生車輛事故，外側車道受阻',
  LocationDescription: '關西鎮中山路附近',
  EffectiveTime: '2026-08-19T09:00:00+08:00',
  LastUpdateTime: '2026-08-19T09:05:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '南向', StartKM: '82K+300' },
  },
};

// 封閉 (closure) on 台3線, 雙向.
export const highwayTai3Closure = {
  EventID: 'HWY-2026-0819-304',
  EventTitle: '台3線雙向道路封閉',
  EventType: '封閉',
  Description: '因坍方雙向道路封閉，請改道',
  EffectiveTime: '2026-08-19T10:00:00+08:00',
  LastUpdateTime: '2026-08-19T10:05:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '85K+000', EndKM: '85K+500' },
  },
};

// 管制 (traffic control) on 台3線, 雙向.
export const highwayTai3Control = {
  EventID: 'HWY-2026-0819-305',
  EventTitle: '台3線雙向交通管制',
  EventType: '管制',
  Description: '因活動實施雙向交通管制',
  EffectiveTime: '2026-08-19T11:00:00+08:00',
  LastUpdateTime: '2026-08-19T11:05:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '雙向', StartKM: '70K+000', EndKM: '70K+500' },
  },
};

// A genuine anomaly ('other', keyword-eligible per broadcastRules.js's
// OTHER_ANOMALY_PATTERNS) — no structured EventType match, only free text.
export const highwayTai3Flooding = {
  EventID: 'HWY-2026-0819-306',
  EventTitle: '台3線路況',
  EventType: '其他',
  Description: '台3線路段因大雨積水，請小心慢行',
  EffectiveTime: '2026-08-19T12:00:00+08:00',
  LastUpdateTime: '2026-08-19T12:05:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '南向', StartKM: '60K+000' },
  },
};

export const highwayTai3RockslideRaw = {
  EventID: 'HWY-2026-0819-307',
  EventTitle: '台3線路況',
  EventType: '其他',
  Description: '台3線邊坡落石，請注意行車安全',
  EffectiveTime: '2026-08-19T13:00:00+08:00',
  LastUpdateTime: '2026-08-19T13:05:00+08:00',
  Location: {
    FreeExpressHighway: { Road: '台3線', Direction: '北向', StartKM: '55K+000' },
  },
};

// AlertID "0" is TDX's convention for "nothing to report".
export const busAlertNormalOperationById = {
  AlertID: '0',
  RouteID: '5路',
  RouteName: '5路',
  Title: '正常營運',
  Description: '',
  PublishTime: '2026-08-15T06:00:00+08:00',
};

// Some records use a non-zero AlertID but the text itself says 正常營運.
export const busAlertNormalOperationByText = {
  AlertID: 'A-9981',
  RouteID: '15路',
  RouteName: '15路',
  Title: '15路今日正常營運',
  Description: '15路今日正常營運，恕不另行公告',
  PublishTime: '2026-08-15T06:00:00+08:00',
};

export const busAlertRealDetour = {
  AlertID: 'A-9982',
  RouteID: '15路',
  RouteName: '15路',
  Title: '光復路交通管制繞道公告',
  Description: '因光復路活動交通管制，15路今日繞道行駛，不停靠光復路口各站',
  PublishTime: '2026-08-15T07:00:00+08:00',
};

// Generic safety-slogan CMS message — should be dropped (type "other").
export const cmsSafetySlogan = {
  CMSID: 'CMS-HC-014',
  RoadName: '中華路',
  Message: { MessageRow1: '喝酒不開車', MessageRow2: '開車不喝酒' },
};

// Real road-condition CMS message — should be kept.
export const cmsCongestionMessage = {
  CMSID: 'CMS-HC-021',
  RoadName: '公道五路',
  Message: { MessageRow1: '前方路口', MessageRow2: '車多壅塞' },
};
