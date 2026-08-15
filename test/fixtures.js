// Fixtures shaped after the real TDX response fields confirmed via the
// deployed /debug/tdx endpoint (see the V1.1 schema-correction commit).
// These are hand-built to match the confirmed field *names*, not captured
// verbatim from production — values are illustrative.

export const realFreewayEvent = {
  EventID: 'FRW-2026-0815-001',
  EventTitle: '國道1號南向122K車輛事故',
  EventType: '事故',
  EventSubType: '一般事故',
  Description: '南向122K處發生車輛事故，外側車道封閉，請小心慢行',
  EffectiveTime: '2026-08-15T08:12:00+08:00',
  LastUpdateTime: '2026-08-15T08:20:00+08:00',
  Location: {
    FreeExpressHighway: {
      Road: '國道1號',
      Direction: '南向',
      StartKM: 121.8,
      EndKM: 122.3,
    },
  },
  Impact: {
    BlockedLanes: 1,
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
      StartKM: 4.5,
      EndKM: 6.0,
    },
  },
  Impact: {
    BlockedLanes: 0,
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
