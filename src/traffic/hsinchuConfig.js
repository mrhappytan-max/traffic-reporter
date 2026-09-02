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
//
// V2.4.4 — V2_4_4_TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX. Production
// repro (2026-09-01): 台61線 39K+600（實際為桃園市觀音區）被這份表格自己
// 判定為「在範圍內」，真實推播到 LINE——直接證明這裡的 minKM/maxKM 精確度
// 不足以單獨作為 Production 播報的地理依據。本輪一開始曾嘗試直接收窄這裡
// 的數字（含移除頭份/竹南/三灣覆蓋的範圍），但這些數字本來就只是本檔案
// 開頭就已經誠實揭露的「未經官方里程樁驗證的最佳猜測」——重新用另一組同樣
// 未經驗證的猜測數字取代，反而是這輪自己也警告過的「草率修補」，而且已經
// 實測會破壞既有測試對這些數字的既定假設（例如台61線 48K-49K 這個既有
// fixture）。因此本輪保留這份表格的數字不變，改為在
// traffic/serviceArea.js 新增 resolveHsinchuOnlyProductionEligibility()
// ——一個獨立、不依賴 KM 精確度的地名文字比對 hard gate，直接檢查事件自己
// 的原始文字（今天洩漏的事件文字本身就寫著「桃園市觀音區」），作為
// Production 播報前的真正防線，而不是繼續依賴這份表格的猜測數字本身。
// 頭份／竹南／三灣（苗栗縣，本輪由真人命令明確排除於服務範圍外）同樣是靠
// 那個新的地名 hard gate 排除，不是靠這裡改數字——見該函式自己的完整說明。
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
    // V2.4.4 — 39K+600 已證實為桃園市觀音區，非新竹（見本檔案上方 V2.4.4
    // comment）。這個數字本輪刻意不變（同樣理由：沒有把握重新畫界，不要
    // 用另一個猜測取代舊猜測）——真正擋下這類事件的是 serviceArea.js 的
    // 地名 denylist hard gate，不是這裡的 minKM/maxKM。
    minKM: 35, // 新豐 一帶
    maxKM: 75, // 香山/新竹市 一帶
  },
  台68線: {
    aliases: ['台68', '台68號', '竹東快速公路', '新竹快速公路'],
    wholeRouteInScope: true,
  },
};
