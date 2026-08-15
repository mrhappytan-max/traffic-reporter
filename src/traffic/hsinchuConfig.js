// Centralized rules for deciding whether a nationwide Freeway/Highway
// event is relevant to Hsinchu City/County.
//
// IMPORTANT — confidence level: the KM ranges below are best-effort
// estimates based on general knowledge of where the relevant
// interchanges/sections sit (e.g. 新竹系統交流道 on 國道1號 is roughly
// 89K), NOT verified against official 公路局/國道局 里程樁 data — this
// session could not reach tdx.transportdata.tw's docs or any mapping
// service to confirm exact boundaries (see TDX_SOURCE_AUDIT.md).
//
// Calibrate these numbers using real StartKM/EndKM values from
// GET /debug/status — cross-check events whose Description mentions 新竹
// against what range they fall in, and adjust minKM/maxKM here.
// Everything is centralized in this one file on purpose so recalibration
// never means hunting through hard-coded numbers elsewhere.

// Only used as a secondary corroborating signal (when KM can't be parsed
// at all), and generous on purpose — Hsinchu City + County bounding box,
// padded outward slightly rather than tightly cropped.
export const HSINCHU_BOUNDING_BOX = {
  minLat: 24.45,
  maxLat: 24.85,
  minLon: 120.85,
  maxLon: 121.3,
};

// A KM value within this many kilometers of a range edge may be pulled in
// (or pushed out) by a "新竹" mention in the description — see
// hsinchuFilter.js. Keeps the KM ranges from having to be pixel-perfect.
export const KM_BOUNDARY_BUFFER_KM = 3;

// Freeway (國道) — TDX's real Road value has been observed as the
// Chinese-numeral form ("國道一號"), so that's the canonical key; digit
// forms are kept as aliases in case a different endpoint uses them.
export const FREEWAY_RULES = {
  國道一號: {
    aliases: ['國道1號', '國1', '中山高速公路', '中山高'],
    // 楊梅 ~78K -> 新竹系統(~89K) -> 新竹(~94K) -> 頭份(~102K)
    minKM: 80,
    maxKM: 105,
  },
  國道三號: {
    aliases: ['國道3號', '國3', '福爾摩沙高速公路', '二高'],
    // 關西 ~75K -> 竹林/新竹系統(~89K) -> 寶山/三灣 一帶
    minKM: 75,
    maxKM: 105,
  },
};

// Highway (省道/快速公路). wholeRouteInScope=true means: skip KM checks
// entirely and always treat the road as Hsinchu-relevant — used only for
// 台68, whose entire length runs within Hsinchu City/County (新竹市 <->
// 竹東 <-> 五峰), per TDX_SOURCE_AUDIT.md.
export const HIGHWAY_RULES = {
  台1線: {
    aliases: ['台1', '台1號'],
    minKM: 75, // 湖口 一帶
    maxKM: 100, // 新竹市區 一帶
  },
  台3線: {
    aliases: ['台3', '台3號'],
    minKM: 70, // 關西 一帶
    maxKM: 115, // 北埔/峨眉 一帶
  },
  台15線: {
    aliases: ['台15', '台15號'],
    minKM: 35, // 新豐 一帶
    maxKM: 70, // 香山 一帶
  },
  台61線: {
    aliases: ['台61', '台61號', '西濱快速公路', '西濱公路'],
    minKM: 35, // 新豐 一帶
    maxKM: 75, // 香山/新竹市 一帶
  },
  台68線: {
    aliases: ['台68', '台68號', '竹東快速公路', '新竹快速公路'],
    wholeRouteInScope: true,
  },
};
