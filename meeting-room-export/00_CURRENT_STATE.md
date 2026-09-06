<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

> ⚠️ **本份文件已停止更新，內容過期，不得作為現況判斷依據**
>
> 本檔案最後產生於 V2.4.4（2026-09-02，commit f0b3ad1），其後 V2.4.5 至
> V2.4.15 共 11 個版本的內容完全未反映於此。特別是本檔案表格與
> `07_KNOWN_ISSUES.md` 中「TDX 額度用盡／PBS-ONLY 生效中」的記載，已確認為
> **過期錯誤資訊**——TDX 額度限制是 2026 年 8 月的事，9/1 重置後已不存在。
> 現況請一律改讀 `engineering-memory/00_CURRENT_STATE.md`。詳見
> `engineering-memory/00_CURRENT_STATE.md` 與
> `engineering-memory/07_KNOWN_ISSUES_02.md` 中對本次發現的記錄。

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V2.4.4（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | 99669c7c3361418837ca95956b68441707e31cdc |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty (19 changed source file(s)) |
| Production | DEPLOYED |
| Production Verification | Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why) |
| Current Phase | Production maintenance｜PBS-ONLY + 重大事故限定 LINE Push（維持不變）＋ TDX Freeway/Highway RoadEvent 已重新接入統一 Queue/AI/Memory pipeline，但 V2.4.4 緊急品質修復（服務區域洩漏＋一般道路管理誤發＋TDX 訊息遺失）已將 TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED 重設回 false（FETCH/QUEUE 仍 true），進入 PHASE_D_TDX_NOTIFY_OBSERVATION，待觀察後再由人類＋Claude Browser 決定重新開啟。雲端同步治理 V2 生效：Claude 對 Drive 唯讀、GitHub 為唯一寫入來源，GitHub Actions 自動鏡像至 Drive |
| Current Task | none。Latest completed task = V2_4_4_TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX，status = SEALED（前序歷程見 SYSTEM_STATE.json／06_VERSION_HISTORY.md）。CURRENT_RUNTIME_PHASE=PHASE_D_TDX_NOTIFY_OBSERVATION：TDX_ROADEVENT_FETCH_ENABLED/QUEUE_INGRESS_ENABLED 為 "true"，TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED 為 "false"（本輪刻意關閉，非缺陷），CCTV_METADATA_REFRESH 仍 "false"。雲端治理：Claude 對 Drive 唯讀，GitHub 為唯一寫入來源。V2.4.4：新增 resolveHsinchuOnlyProductionEligibility() 地名 denylist hard gate（新竹市／新竹縣以外一律擋下，含頭份／竹南／三灣）、AI prompt 第四類「一般道路管理狀態」語意錨點（例行施工/機動路肩開放關閉預設不通知）、TDX 訊息事實行（buildSourceFactLine 由 PBS-only 放寬為 PBS+TDX，60 字上限不變）。觀察中：確認真實 TDX 事件只剩新竹縣市 candidate、一般施工/路肩不再誤發、TDX facts 可完整組成 LINE 預覽後，再由人類＋Claude Browser 決定重新開啟 Production Notify |
| Latest Completed Version | V2.4.4 |
| Known Blocker | 無 blocker。TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED 目前為 false 是 V2.4.4 刻意的安全政策，非缺陷——FETCH/QUEUE 仍為 true。第一筆真實 TDX LINE 通知（Notify 重新開啟後）尚待現場證據——REAL_WORLD_CONFIRMATION_PENDING。AI 呼叫已有 45 秒 fail-fast timeout（V2.4.3），CLEARED 會取消舊事件 stale retry。EVENT_ID 11509010029-5 該筆歷史事件確切失敗階段仍無法獨立查證，未臆測。詳見 07_KNOWN_ISSUES.md |
| Real-world Confirmation | REAL_WORLD_CONFIRMATION_PENDING |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | 待辦：觀察真實 Production（FETCH=true／QUEUE=true／NOTIFY=false）確認只剩新竹縣市 candidate、一般施工不再誤判、TDX facts 可完整組成 LINE 預覽後，才由人類＋Claude Browser 決定改回 true——不得自行改回。一個月後依 ineligibleByReason 數據決定是否收緊主動播報政策 |
| Export Generated At | 2026-09-02T03:38:40.958Z |
| Export artifact commit | uncommitted-at-generation-time (resolved by git history, never self-referenced) |

## V1.9.9 Phase 1 封版（2026-08-28，另一個 session 完成，本 Cloud Session 未參與，port 進本模板僅為維持 template↔engineering-memory 一致）

- `V1.9.9_PHASE_1 = WINDOWS_SERVICE_AREA_HSINCHU_ONLY`
- `AI_INTEGRATION = NOT_STARTED`
- `LINE_POLICY = UNCHANGED`
- Windows PBS Local Edge Filter 僅納入新竹市、新竹縣；竹南、頭份、苗栗市及其他苗栗縣區域一律排除。
- 跨縣市道路依實際新竹路段納入；舊 broad bounding box 不再能單獨讓苗栗事件通過。
- `NEW`／`UPDATED`／`MISSING_PENDING_CLEAR`／`CLEARED` lifecycle 行為未修改。
- fix commit `7acb82a`，純 `pbs-relay/`（Windows 端）變更，未觸碰任何 `src/` Cloudflare runtime。

## V1.9.9 Phase 2 封版（2026-08-28）— AI-ready Business Pipeline Simplification

- `V1.9.9_PHASE_2 = AI_READY_PIPELINE_PREPARATION`
- `AI_INTEGRATION = NOT_STARTED`、`AI_MODEL = NOT_SELECTED_IN_RUNTIME`、`LINE_AI_DECISION = NOT_ACTIVE`
- `PBS_AI_DECISION_MODE = PREPARED_NOT_ACTIVE`
- 新模組 `src/pbs/aiCandidate.js`：從 Windows 已正規化事件建立最小 AI candidate 物件，僅保留服務區與冪等/重複防護兩個 gate，不套用
  `MAJOR_ACCIDENT_ONLY`／V1.5 type whitelist／location quality hard-reject（那些函式本身完全未修改，對真實 LINE 決策仍完整生效）。
- candidate 純粹 log 觀察用，從未觸及 LINE／CCTV／Shared Feed，從未呼叫任何 AI 模型。
- 新增 AI decision cache key 設計（`computeAiDecisionCacheKeyHash`，eventId+既有穩定fingerprint）僅schema/helper，本輪無任何KV讀寫。
- 詳見 `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`。

## V1.9.9 Phase 3B 封版（2026-08-28）— Workers AI Driver Impact Decision Integration

- `V1.9.9_PHASE_3B = CODE_READY`（實作＋測試完成，正式環境 AI 決策仍關閉）
- `WORKERS_AI_MODEL = @cf/zai-org/glm-4.7-flash`（固定，透過 `env.AI.run(...)`，binding 名稱 `AI`）
- `AI_BINDING = PENDING_GPT_WORK`（`wrangler.jsonc` 已宣告 `ai` binding，但 Dashboard 端建立/驗證是 GPT Work 的工作）
- `AI_DECISION = DISABLED`（kill switch `PBS_AI_DECISION_ENABLED` 預設 `false`）
- `LINE_AI_DECISION = NOT_ACTIVE`
- 新模組：`src/pbs/aiConfig.js`（kill switch）、`src/pbs/aiDecisionCache.js`（48h TTL KV cache，重用 Phase 2 的 cache key 設計）、
  `src/pbs/aiDecisionEngine.js`（固定 prompt／strict schema 驗證／`resolveAiDecision()` orchestrator）、
  `src/traffic/aiApprovedPbsBroadcast.js`（scoped LINE 執行路徑，重用既有 subscriptions/notified/incidentSuppression/messageFormat/CCTV/pushMessage，
  明確不呼叫 `getBroadcastEligibility`／`getLinePushPolicyDecision`／`resolveLocationQuality`）。
- `src/pbs/debugPush.js`：AI 開啟時與 legacy `runLineBroadcast()` 路徑**互斥**（同一事件絕不同時執行兩者），避免雙重判官造成 LINE 重複推播。
- AI 失敗（429/5xx/network/invalid response/binding missing）一律 0 LINE、trace 記錄，絕不 fallback 回舊硬規則。未加入 retry（無可重用 helper，且施工令要求第一版簡單）。
- 新增 57 項測試（5 個新測試檔），全部第一次執行即 PASS；完整 regression 1509/1476/33，NEW FAILURES=0。
- APP_VERSION 維持 `V1.9.9`（本輪不升版本號）。
- 詳見 `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`。

## V1.9.9 Phase 3D Hotfix 封版（2026-08-28）— Cloudflare 字串布林解析

- `V1.9.9_PHASE_3D_HOTFIX = CLOUDFLARE_STRING_BOOLEAN_PARSING_FIX`
- 根因：Cloudflare Dashboard/CLI Variables 一律以**字串**注入 Worker，從不是真正的 boolean。GPT Work 設定
  `PBS_AI_DECISION_ENABLED = "true"` 後，`resolvePbsAiDecisionEnabled()` 原本嚴格檢查 `typeof === 'boolean'`，
  字串永遠不符合，每次請求都悄悄落回安全預設值 `false`——不是 Dashboard 操作錯誤，是 resolver 本身的 bug。
- 修正：`src/pbs/aiConfig.js#resolvePbsAiDecisionEnabled()` 現在同時接受真正 boolean 與 Cloudflare 字串形式
  `'true'`／`'false'`（不分大小寫、trim 前後空白）；`undefined`/`null`/空字串/其他真值拼法（`'1'`/`'yes'`/`'on'`）
  一律 fail-safe 回 `false`，刻意不做寬鬆 truthy 判斷。
- `AI_BINDING = ACTIVE`（GPT Work 已確認）、`AI_DECISION = DISABLED_PENDING_GPT_WORK_RETRY`（rollback 仍在效，
  尚未以修正後邏輯重試）。
- 單點 config parsing hotfix：AI prompt/model/schema/cache/`runAiApprovedPbsBroadcast`/LINE policy/service area/
  lifecycle/idempotency/CCTV/Shared Feed/hourly reminder/TDX/Windows monitor 全部未觸碰。
- 新增 8 項測試（`aiConfig.test.js` 6 項＋`pbsAiDecisionScenarios.test.js` 2 項 integration-level），全部通過；
  完整 regression 1517/1484/33，NEW FAILURES=0。
- APP_VERSION 維持 `V1.9.9`（本輪不升版本號）。
- 詳見 `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`。

## V2.0.0 MILESTONE 封版（2026-08-28）— Windows PBS + Cloudflare Workers AI Production Architecture

**這是重大架構里程碑封版，不是新功能開發。** `APP_VERSION` 從 `V1.9.9` 升為
`V2.0.0`：V1.9.5～V1.9.9 Phase 3D 逐輪建立的 Windows PBS 本機邊緣過濾 +
Cloudflare Workers AI 判讀，是一次完整的架構世代更換（舊：Cloudflare PBS
polling → content hard rules → LINE；新：PBS official source → Windows Local
Edge → Hsinchu-only filter → lifecycle → Cloudflare production ingress →
persistent duplicate protection → AI decision cache → Cloudflare Workers AI →
AI driver-impact decision → 既有 LINE 執行基礎設施），依版本規則屬架構世代
更換等級的不相容變更，以 major 版本號標記這個新的 canonical milestone。**不
改寫 V1.x 歷史。**

- `ARCHITECTURE = WINDOWS_PBS_LOCAL_EDGE → CLOUDFLARE_INGRESS → WORKERS_AI →
  AI_DRIVER_IMPACT → LINE`
- `WINDOWS_SERVICE_AREA = HSINCHU_CITY_AND_COUNTY_ONLY`
- `CLOUDFLARE_PBS_30_MIN_POLLING = RETIRED`（程式碼保留可 rollback）
- `WORKERS_AI = ACTIVE`、`WORKERS_AI_MODEL = @cf/zai-org/glm-4.7-flash`、
  `AI_BINDING = AI`、`AI_KILL_SWITCH = PBS_AI_DECISION_ENABLED`
- `AI_DECISION = ACTIVE`、`LINE_AI_DECISION = ACTIVE`（**GPT Work 回報，本
  Session 未獨立驗證**——sandbox 網路政策封鎖 Production 網域與 Cloudflare
  Dashboard）
- `FIRST_REAL_AI_EVENT = WAITING`——真實 Production PBS 事件走完 Workers AI
  判讀到 LINE 推播的完整驗證尚未觀察到，這是下一個 observational milestone，
  **不是 V2.0.0 封版 blocker**
- `HOURLY_REMINDER = NOT_STARTED`（方向性設計，本輪未偷做）
- 完整 26 題接手地圖（PBS 從哪來、Windows 在哪、如何 rollback、如何排查「Windows
  有事件但 LINE 沒收到」等）→ `03_ARCHITECTURE.md` 開頭「V2.0.0 接手地圖」；
  Dashboard 設定手冊／Rollback Runbook／Troubleshooting Runbook／Commit
  Lineage → `02_PROJECT_HANDOFF.md`「V2.0.0 MILESTONE」段落；產品決策理由 →
  `PRODUCT_DECISIONS.md`。
- 本輪只是文件/版本治理封版，未修改任何 runtime 決策邏輯本身。全量迴歸
  1517/1484/33，NEW FAILURES=0（僅跑一次，與既有 baseline 對照）。
- 詳見 `03_ARCHITECTURE.md`／`02_PROJECT_HANDOFF.md`／`PRODUCT_DECISIONS.md`。

## V2.0.1 封版（2026-08-29）— AI Decision Observatory

PATCH，Production observability/diagnostic UI 修正，**不改 AI semantic
authority**。新 Admin 頁 `GET /admin/pbs-ai-observatory-view`
（`src/pbs/aiObservatoryView.js`）回答「PBS 原文 → AI 判斷 → AI 理由 →
最終結果」。

- `AI_DECISION_OBSERVATORY = ACTIVE`
- `DIAGNOSTIC_PAGE_AI_RECALL = FORBIDDEN`（開啟／重新整理／搜尋本頁一律
  0 次 Workers AI 呼叫，測試證明）
- `DIAGNOSTIC_PAGE_ADDITIONAL_AI_CALLS = 0`
- 新 thin index `src/pbs/aiObservatoryIndex.js`
  （`debug:pbs-ai-observatory-index:v1:*`，48h TTL）——盤點既有資料後
  確認無法零額外寫入（AI decision cache 內容定址無法列舉、idempotency KV
  無 PBS 欄位、AI 失敗/服務區域外/legacy path 目前完全無持久記錄），改為
  每個真正被接受（非重複）事件寫入 1 筆最小 KV（僅 PBS 原始欄位＋
  outcome enum，`notify`/`impact`/`reason`/`confidence` 本身不重複儲存，
  頁面讀取時直接讀既有 AI decision cache，`reason` 保證是當時真正的 AI
  輸出，絕不重新生成）；重複事件仍是 0 額外寫入。
- 查修頁語義全面改為 V2.x vocabulary（AI：建議通報／AI：不需主動通報／
  AI：判讀失敗，安全不通報／服務區域外／AI 未判讀），絕不使用舊版
  `不符合播報資格` 字樣。
- `APP_VERSION` 從 `V2.0.0` 升為 `V2.0.1`（同一大版本內的 patch）。
- 新增 22 項測試，全量迴歸 1539/1506/33，NEW FAILURES=0（僅跑一次）。
- `FIRST_REAL_AI_EVENT = WAITING`（不變）；
  `AI_DRIVER_SUMMARY = FUTURE_CANDIDATE`（僅記錄產品候選方向，未實作、
  未修改 Prompt、未新增 schema）。
- 詳見 `03_ARCHITECTURE.md`／`02_PROJECT_HANDOFF.md`／`07_KNOWN_ISSUES.md`。

## V2.0.2 封版（2026-08-29）— Config Drift Hotfix

PATCH，Production configuration correctness fix，**不改 AI semantic
behavior**。

**CONFIG_DRIFT_INCIDENT**：`PBS_AI_DECISION_ENABLED` 從 V1.9.9 Phase 3D
到 V2.0.1 只存在於 Cloudflare Dashboard 手動設定，每次 GitHub main →
Workers Builds → wrangler deploy 都把 `wrangler.jsonc` 視為權威來源，
悄悄移除／覆寫 Dashboard-only 的值（與 `TRAFFIC_SOURCE_MODE` 既有機制
相同）。GPT Work 手動設定的 `"true"` 因此被後續一次部署移除，AI 決策
悄悄退回程式碼預設值 `false`。17:49 台68事件發生時 AI switch 已被移除，
**該筆不算真實 AI 判讀事件**（legacy 路徑決定，非 Workers AI）。

- `PBS_AI_DECISION_ENABLED_SOURCE = WRANGLER_CANONICAL_VAR`
- `DASHBOARD_ONLY_AI_SWITCH = RETIRED`
- `KEEP_VARS = NOT_USED`（會讓 Dashboard-only 設定繼續漂移，與本輪
  「repo config authoritative」目標相反）
- 修正：`wrangler.jsonc` 的 `vars` 正式宣告
  `"PBS_AI_DECISION_ENABLED": "true"`（字串形式）
- 新增 regression guard：`scripts/check-deployment-policy.mjs` 的
  `checkPbsAiDecisionEnabledVar()`，`npm run check:deployment-policy`
  會在未來有人刪掉這個 var 時立即失敗
- `APP_VERSION` 從 `V2.0.1` 升為 `V2.0.2`
- 新增 10 項測試，全量迴歸 1549/1516/33，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：AI Prompt、AI model、`aiDecisionEngine.js`、
  `aiConfig.js` resolver 語意、Windows PBS filter、service area、
  lifecycle、message formatter、driverSummary、LINE policy、
  Shared Feed、CCTV、hourly reminder；未新增任何 Secret
- `FIRST_REAL_AI_EVENT = WAITING`（不變）
- 另記已知問題（本輪不修）：
  `PBS_PRECISE_COMMENT_LOCATION_NOT_USED_BY_LINE_FORMATTER`——LINE 訊息
  格式化目前不會把 PBS comment 原文中的精確交流道／匝道文字（例如
  「近竹科匝道」）帶出來顯示
- 詳見 `03_ARCHITECTURE.md`／`02_PROJECT_HANDOFF.md`／`07_KNOWN_ISSUES.md`。
  **下一個 Agent：不得開始 formatter 修正；不得實作 driverSummary；
  不得開始 hourly reminder。**

## V2.1.0 封版（2026-08-29）— Transport Ack Decoupled From Business Processing

MINOR，正式資料流／責任邊界調整，非單純 timeout patch。

**INCIDENT**：2 筆真實 NEW 事件成功走完 service area + `AI_CALL_STARTED`，
但 Windows 自身 5 秒 HTTP timeout 觸發時 Cloudflare 仍在 `await` Workers
AI，因為那段工作從未交給 `ctx.waitUntil()`，client 斷線導致 handler 被
runtime 直接取消——AI 判斷／LINE／Observatory 全部沒完成，且冪等記錄
（於 business processing 開始「之前」就已寫入）讓後續 retry 永久被當
duplicate 擋下。

- `src/index.js` 的 `fetch` handler 現在接收並轉傳 `ctx`；genuinely
  accepted 的 NEW/UPDATED 事件之 business processing 交給
  `ctx.waitUntil()`，HTTP 回應不再等 AI 完成
- KV 冪等記錄新增兩階段標記：`status: PROCESSING`（接受當下）→
  `COMPLETED`（處理完成後）；`PROCESSING_STALE_MS = 60` 秒讓極少數
  「原嘗試根本沒被排程」的情況能復原重跑，一般情況（原嘗試仍在背景
  真實執行）的 retry 仍正確視為重複
- 刻意不用 Cloudflare Queue／Durable Object——`ctx.waitUntil` 已足夠
  解決本次已確認的失效模式
- 正式寫入四層架構角色邊界：`WINDOWS_ROLE=HSINCHU_PBS_FILTER_AND_RELAY`、
  `CLOUDFLARE_ROLE=INGRESS_STATE_CONTEXT_AND_AI_ORCHESTRATION`、
  `AI_ROLE=SEMANTIC_DECISION_AUTHORITY`、`LINE_ROLE=DELIVERY_ONLY`、
  `RAW_PBS_TEXT_POLICY=IMMUTABLE_END_TO_END_UNTIL_AI`
- 再次驗證（非重新實作）：PBS 原始 `comment`／`sourceDetail` 逐字元
  完整送達 AI prompt（`buildRawPbsRecordFromPush`／`normalizePbsEvent`／
  `buildAiCandidate`／`buildAiUserPrompt` 一行未改）；唯讀盤點
  `pbs-relay/` 分類邏輯，確認不存在「同一事故一小時內」語意抑制規則
- `APP_VERSION` 從 `V2.0.2` 升為 `V2.1.0`
- 新增 9 項測試，全量迴歸 1681/1647/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：AI Prompt、AI model、resolver 語意、Windows PBS
  filter、service area、lifecycle 分類、message formatter、
  driverSummary、hourly reminder、CCTV、TDX、查修頁 UI（第二階段，
  刻意不做）
- 詳見 `03_ARCHITECTURE.md`／`PRODUCT_DECISIONS.md`／`07_KNOWN_ISSUES.md`。
  **下一個 Agent：不得直接開始查修頁改版（第二階段）。**

## V2.2.0 封版（2026-08-29）— AI Decision Observatory 四層事件生命週期

MINOR，backward-compatible observability/UI 擴充，不改 AI semantic
authority、Windows PBS filter、LINE policy、V2.1.0 的 ctx.waitUntil 架構。

- `/admin/pbs-ai-observatory-view` 升級為明確四層檢視：①PBS/Windows
  ②Cloudflare ③AI ④LINE，各層獨立顯示成功／未執行／失敗／未知
- `RAW_PBS_TEXT_VISIBLE = YES`：`commentSummary`（原截斷 120 字）退休為
  `rawComment`／`rawSourceDetail`，完整未截斷，與解析欄位獨立標示
- `FAILURE_EVENT_VISIBILITY`：`processAcceptedEvent` 現在於處理一開始
  即寫入 `PROCESSING_STARTED` 記錄（取自 Windows 原始 payload，寫在任何
  可能 throw 之前），最終寫入之後原地覆寫同一把 KV key——停滯/crash 事件
  不再完全消失
- `EXTRA_KV_WRITES_PER_ACCEPTED_EVENT = 1`（實測）：`puts = 4N + 2`，
  50/100/200 events/day 分別 202/402/802 puts/day，遠低於 Free Plan
  1,000/day 額度
- Cloudflare 層狀態即時讀取既有 V2.1.0 transport idempotency 記錄
  （零新增 KV prefix，非重複儲存）
- 開啟／重新整理／搜尋／篩選本頁仍 0 次 Workers AI 呼叫、0 次 KV 寫入
- `APP_VERSION` 從 `V2.1.0` 升為 `V2.2.0`
- 新增 16 項測試，全量迴歸 1697/1663/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：Windows PBS filter/relay transport、V2.1.0
  ctx.waitUntil 架構、AI Prompt/model/semantic policy、service area、
  LINE policy/formatter、Shared Feed、CCTV、TDX、driverSummary、hourly
  reminder、「同一事故一小時內」AI 語意上下文（刻意未實作）
- 詳見 `03_ARCHITECTURE.md`／`PRODUCT_DECISIONS.md`／`07_KNOWN_ISSUES.md`。
  **下一個 Agent：不得接著開始「AI 一小時歷史上下文」、driverSummary、
  formatter 修正或其他功能。**

## V2.4.0 封版（2026-09-01）— TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE

MINOR（架構階段）：TDX 國道/省道 RoadEvent 重新加入同一條 Queue／同一個 AI
決策引擎，透過新的 Recent Incident Memory 跨來源協調，**Phase B（尚未真正
推播 LINE）**——不是 Phase C。

- 固定架構：TDX Freeway＋TDX Highway＋PBS Windows → 統一事件格式 →
  serviceArea 閘門 → Recent Incident Memory（Cloudflare KV，8h TTL）→
  唯一一個 Queue（沿用 `PBS_AI_QUEUE`）→ 唯一一個 AI 引擎 → AI 輸出
  `sameIncident`／`materialChange`／`notify` → LINE → CCTV → R2 讀回驗證
  （V2.3.3 原封不動）
- 來源角色：TDX Freeway＝國道主要權威、TDX Highway＝省道主要權威、
  PBS＝全道路即時＋TDX備援；`WAIT_FOR_TDX_BEFORE_NOTIFY=NO`，
  `PBS_FREEWAY_DROP=NO`，`PBS_HIGHWAY_DROP=NO`——誰先到、誰有效就先進 AI
- 只復原 Freeway＋Highway RoadEvent 抓取，明確**不**復原 VD／CMS／其他
  Traffic API／CCTV metadata Cron；`CCTV_RUNTIME_TDX_CALLS` 維持 0，CCTV
  metadata refresh 維持 MANUAL/ON-DEMAND
- `wrangler.jsonc` 新增三個最小粒度開關（canonical，非 Dashboard-only），
  預設全部 `"false"`：`TDX_ROADEVENT_FETCH_ENABLED`、
  `TDX_ROADEVENT_QUEUE_INGRESS_ENABLED`、
  `TDX_CCTV_METADATA_REFRESH_ENABLED`——疊加在 `TRAFFIC_SOURCE_MODE` 之上，
  絕非取代（見 `sourceMode.js#isTdxTokenAccessPermitted`）
- **`LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT`**：
  `scheduled.js` 的 `broadcastEvents` 不再包含 `summary.allEvents`（TDX
  自己抓到的事件），即使單獨打開 `TDX_ROADEVENT_FETCH_ENABLED` 也無法讓
  TDX 事件回到舊 V1.5 硬規則 LINE 路徑
- 新模組 `src/traffic/incidentMemory.js`（KV key
  `traffic:incident-memory:v1`，8h TTL，`MEMORY_KV_GETS_PER_EVENT<=1`／
  `MEMORY_KV_PUTS_PER_EVENT<=1`，`WRITE_ON_CHANGE=YES`，road+direction →
  1000m/1.5km 內 → 最近 8h → 最多 5 筆候選的三層 prefilter，並排除事件
  自己剛寫入的紀錄，避免 AI decision cache key 誤判為「有新 context」）、
  `src/tdx/tdxQueueIngress.js`（TDX 新／更新事件送進同一個 `PBS_AI_QUEUE`，
  沿用 `dedupe.js`／`debugPush.js` 既有 fingerprint／idempotency／訊息
  建構，絕非第二套 Queue 或第二套訊息格式）
- AI schema 新增 `sameIncident`／`materialChange`（僅在有 memory context
  時要求），AI decision cache key 併入 `memoryContextFingerprint`，未提供
  時與 V2.4.0 前完全相同的 hash（向下相容）
- Phase B 閘門硬寫死在單一呼叫點（`debugPush.js`：
  `suppressLineNotify = source === 'freeway' || source === 'highway'`），
  非任何 `wrangler.jsonc` 變數控制——要進 Phase C（TDX 真正推播 LINE）
  需要未來一次明確的程式碼變更，絕非改設定值就能達成
- `incidentSuppression.js` **不大拆**：保留作為短期重複推播安全網，疊加在
  AI 自己的 8h Memory 再判斷之下，非取代
- 全量迴歸 1746/1712/34，NEW FAILURES=0（僅跑一次，diff 對照既有 34 筆已知
  flaky baseline，完全相同）；新增 `test/tdxUnifiedAiPipeline.test.js`
  （order 自訂 17 個 CASE 全過），另 8 個既有測試檔改寫以反映
  TDX-legacy-retirement 的刻意行為變更
- `APP_VERSION` 從 `V2.3.3` 升為 `V2.4.0`
- **本輪未啟用任何真實 TDX 抓取**：三個新開關全部預設 `"false"`，本輪只
  建好機制，實際打開（Phase A：FETCH_ONLY）需要另一次明確的人類指示
- 詳見 `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`／
  `test/tdxUnifiedAiPipeline.test.js` 的完整記錄。**下一個 Agent：不得
  自行開啟任何 TDX_ROADEVENT_* 開關、不得自行進 Phase C（移除
  `suppressLineNotify` 的硬寫死 true）、不得復原 VD/CMS 等其他 TDX
  功能。**

## V2.3.3 封版（2026-08-31）— CCTV_R2_READBACK_VERIFY_BEFORE_LINE

PATCH，可靠性加強，不改架構、不改 15 分鐘 TTL、不改 LINE Push 模型、不改 CCTV 選鏡策略。

- 上一輪唯讀查核（`CCTV_IMAGE_READY_BEFORE_LINE_PUSH_AUDIT`）逐函式追蹤真實
  AI-approved 廣播路徑，確認 await 鏈本身已安全（R2 put 完整 await → public
  URL 只在 put 成功後建構 → LINE push 一律最晚），但無法用應用層時序缺陷
  解釋一筆真實回報的破圖事故（LINE 端遠端抓取行為不在本 repo 可視範圍）
- 決策：停止對 LINE 端行為的無止盡追查，改為新增本 codebase 真正能自己
  保證的一件事——CCTV 圖片成功寫入 R2 後，Cloudflare 自己再讀一次確認
  圖片真的可讀，通過才把 imageUrl 交給 LINE
- 新函式 `publishedImage.js#verifyPublishedImageReadable(bucket, id)`：
  純內部 R2 GET（絕非對本 Worker 自己 public endpoint 發 HTTP），確認
  物件存在、Content-Type 確實為 `image/jpeg`、bytes 非空；任一失敗或
  GET 本身拋出例外，一律視為讀回失敗
- 接上 `dynamicCollage.js` 兩個既有 R2 發布點——`prepareCctvImageWork`
  （quad／事故）與 `prepareSingleCctvImageWork`（single／動態路肩）——
  兩者共用同一個 `publishCollageImage()`、也共用同一套下游 LINE image
  message 組裝，同步保護，不留半修缺口
- 新失敗代號 `r2-readback-failed`，與既有所有 CCTV 失敗原因採完全相同
  的 fail-closed 處理：文字照常送、圖片跳過、不重試、不重新 publish
- `TDX_CALL_CHANGE = 0`（新讀回只是一次 `bucket.get()`，非 `fetch()`）
- `APP_VERSION` 從 `V2.3.2` 升為 `V2.3.3`
- 新增/擴充 8 項測試（`test/dynamicCollage.test.js` CASE 1-5/7-8 六項、
  `test/dynamicShoulder.test.js` 19b 一項），另有 9 個既有測試檔的
  `r2Bucket()` mock 補上 `httpMetadata` 傳遞（與真實 R2 行為一致，既有
  成功案例行為不變），全量迴歸 1729/1695/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：15 分鐘 published-image TTL、previewImageUrl／
  originalContentUrl 架構、CCTV 選鏡策略、四象限版面、圖片尺寸／JPEG
  quality、LINE Push 單一 payload 模型、AI Prompt／Model、Cloudflare
  Queue、Windows PBS、TDX、Google Maps；既有 await 順序本身未重排，
  只在「R2 put 成功」與「imageUrl 回傳」之間多插入一個新的 await 步驟
- 詳見 `07_KNOWN_ISSUES.md`／`dynamicCollage.js`／`publishedImage.js` 的完整記錄

## V2.3.2 封版（2026-08-30）— CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR（診斷工具修復）

PATCH，診斷工具修復，非 CCTV 產品功能，不改 PBS/Windows/Queue/AI/LINE/Observatory 主流程。

- 真實事件 `EVENT_ID=11508310005-5`（LINE 送達的 CCTV 圖片破圖）：唯一能直接
  驗證「剛 publish 完的 `/cctv/image/:id` 是否立即 200+JPEG」的工具
  `GET /admin/cctv-hsinchu-publish-test` 本身無法使用——依賴只有
  `/admin/cctv-hsinchu-probe` 才能重建的 `CANDIDATES_KEY`，該 probe 會
  發起真實 TDX 呼叫，在 `TRAFFIC_SOURCE_MODE=PBS_ONLY` 下不可為診斷消耗
- 修正：改從同一份 `cctv:freeway-metadata:v1` 攝影機清單快取（真實事故
  動態播報路徑早已 cache-only 讀取、從不碰 TDX）取得候選——新函式
  `composeCollageFromFreewayMetadata()` 串接 `readFreewayCctvMetadataCache()`
  （cache-only，空 KV 退回官方 NFB 內建清單 1943 筆真實記錄，實測固定
  測試點涵蓋 4 象限中 3 個）→ `selectFourQuadrantCandidates()`（既有
  fixed-target admin probe 同一函式同一預設值，未新增鏡頭排序政策）→
  `composeCollageFromCandidates()`（本專案所有 collage 路徑共用核心）
- `TDX_CALLS_PER_TEST = 0`，測試直接驗證（無 fetch 觸及
  tdx.transportdata.tw），非僅推論 import graph
- 新增 `step` 欄位區分失敗成因：`METADATA_CACHE_MISSING`／
  `NO_CCTV_CANDIDATES`／`SNAPSHOT_FETCH_FAILED`／`COMPOSE_FAILED`（兩者
  以 `composeCollageFromCandidates()` 新增純累加欄位
  `anyFrameFetchSucceeded` 區分，沿用 V1.9.0 同一函式已建立的
  「on every outcome」慣例，對既有呼叫端零行為變化）／`R2_PUBLISH_FAILED`
- 成功回應補齊 `status`/`published`/`contentType`/`bytes`/`createdAt`/
  `expiresAt`/`imageUrl`（`createdAt` 自 V1.8.4 起就有算但從未回傳）
- `APP_VERSION` 從 `V2.3.1` 升為 `V2.3.2`
- 新增/改寫 22 項測試（`test/cctvImagePublish.test.js`），全量迴歸
  1722/1688/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：PBS、Windows filter、Cloudflare Queue、AI 決策路徑、
  正式 LINE 廣播、CCTV 鏡頭排序政策、真實事故 CCTV 選鏡/計時/預算邏輯
  本身、Shared Feed、TDX 本身運作、Google Maps、Observatory 主流程；
  `/admin/cctv-hsinchu-collage`（CANDIDATES_KEY）未受影響
- 詳見 `07_KNOWN_ISSUES.md`／`hsinchuCctvProbe.js` 的完整記錄

## V2.3.1 封版（2026-08-30）— DIRECT_COORDINATE_MAP_FALLBACK（LINE 地圖座標直連 Hotfix）

PATCH，formatter 行為修正，不改架構、不改 AI/Windows/Queue/LINE 政策。

- 真實事件 `EVENT_ID=11508260158-0`（竹60線縣道，新竹縣尖石鄉坍方封路）：
  PBS/Windows/Cloudflare 全程有效座標、AI 正常完成、LINE 已發送，但
  **完全沒有地圖連結**
- 根因：`messageFormat.js#buildRoadLines()` 的兩層地圖連結解析
  （`resolveKmLocation`／`resolveCoordinateLocation`）都要求 `road`
  先辨識成國道/省道格式才會使用座標；縣道/鄉道（如竹60）從未被本專案
  僅有的國道(95016)/省道(7040)公里標資料集涵蓋，座標路徑因此在真正
  使用座標前就被 road 判斷擋下
- 修正：新增最後手段 `kmLocationResolver.js#buildDirectCoordinateMapUrl()`
  ——重用既有 `buildMapUrl()`，直接以事件自身座標產生地圖連結，**不**
  辨識道路、**不**查資料集、**不**猜測任何 road/sectionLabel/
  locationLabel，只在既有兩層都失敗時才觸發，只影響「📍 地圖」那一行
- 新增 `isValidRawCoordinate` 座標合法性把關：拒絕
  null/undefined/NaN/Infinity/非數字型別/超出緯經度範圍/精確 (0,0)
- `roadName.js`／`canonicalFreewayRoad`／`canonicalProvincialRoad`／
  官方國道/省道資料集本身**完全未觸碰**；縣道/鄉道公里標資料工程
  仍是刻意未開始的更大範圍問題
- `APP_VERSION` 從 `V2.3.0` 升為 `V2.3.1`
- 新增 13 項測試（`test/pbsCoordinateDirectMapFallback.test.js`，含真實
  事件端對端 fixture，road 全程維持真實值「新竹縣-尖石鄉」，未硬編碼
  「竹60」），既有 KM/座標解析測試檔重跑不變、全數通過，全量迴歸
  1718/1684/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：AI Prompt/model、Windows PBS filter、Queue、LINE
  廣播政策、Observatory 架構、TDX、CCTV
- 詳見 `07_KNOWN_ISSUES.md`／`kmLocationResolver.js`（`buildDirectCoordinateMapUrl`
  自身 header comment）的完整記錄

## V2.3.0 封版（2026-08-30）— PBS AI Queue Reliability，Cloudflare Queues 取代 ctx.waitUntil

MINOR，正式改變 AI business processing 的執行架構與可靠性模型，非
timeout patch。真實 Production 事故（與 V2.1.0 不同一種失敗模式）：
`EVENT_ID=11508290166-0` 成功啟動 Workers AI 呼叫，但呼叫本身在
`ctx.waitUntil()` 自己的背景執行時間預算到期前未回傳，平台強制取消整個
task，AI 決策永久遺失，冪等記錄卡死 `PROCESSING`。
`REAL_INCIDENT_ROOT_CAUSE = WAITUNTIL_BACKGROUND_WINDOW_EXCEEDED`。

- `ctx.waitUntil()` 全面退休做為 AI 背景執行載體
  （`WAITUNTIL_AI_PROCESSING = RETIRED`），改用唯一一個 Cloudflare Queue
  （`pbs-ai-processing-queue`／binding `PBS_AI_QUEUE`，`wrangler.jsonc`
  唯一正典設定，`AI_BACKGROUND_EXECUTION = CLOUDFLARE_QUEUE`）
- HTTP ingress 只驗證／寫冪等 PROCESSING／寫 Observatory
  `PROCESSING_STARTED`／`Queue.send()`，只有 send 成功才 ACK
  `accepted:true`——send 失敗回真實 503，絕不假報已接收
- 獨立 Queue Consumer（`src/index.js` 新增 `queue()` export）承接全部
  AI／LINE／Observatory-final 工作，重用（非重造）既有 AI candidate／
  decision engine／cache／LINE 廣播／Observatory writer
- `AI_CALL_FAILED`（呼叫本身未可靠完成）現在可 Queue 重試，
  `MAX_QUEUE_RETRIES = 3`；既有 `AI_DECISION_INVALID` fail-closed
  政策**維持不變**，絕不重試
- 新增唯一最小終態 `AI_OUTCOME.PROCESSING_FAILED`（重試耗盡後由
  Consumer 自己寫入，標記冪等 `COMPLETED`，永不卡死 PROCESSING）
- `QUEUE_DELIVERY_MODEL = AT_LEAST_ONCE`，
  `BUSINESS_OUTCOME_MODEL = EFFECTIVELY_ONCE`：已 `COMPLETED` 的重複
  遞送直接 ack 略過，0 額外 AI 呼叫／LINE 推播
- 開發期間發現並修正一個 Observatory KV key 重複 bug：改從 queue
  message 的 `acceptedFirstAcceptedAt` 重建 `observatoryNow` 供兩次
  Observatory 寫入共用同一把 key
- `RAW_PBS_TEXT_POLICY = IMMUTABLE_END_TO_END_UNTIL_AI` 不變
- KV 成本實測：`puts = 4N + 2`（與 V2.2.0 相同，0 額外寫入），
  `gets = 6N`（+1／事件，Consumer 冪等 re-check）
- Queue 成本工程估算：成功 2 operations／事件，重試耗盡最差
  5 operations／事件，50/100/200 events/day 最差情況 250/500/1000，
  遠低於官方文件 10,000/日免費額度
- `APP_VERSION` 從 `V2.2.0` 升為 `V2.3.0`
- 新增 `test/pbsAiQueueReliability.test.js`（含真實事故
  `EVENT_ID=11508290166-0` 迴歸 fixture，可控制 Promise 模擬延遲，非
  真實 sleep），改寫 5 項過時 `ctx.waitUntil` 測試，全量迴歸
  1705/1671/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：Windows PBS filter、Windows 自身 HTTP timeout、PBS
  原始文字、AI Prompt/model/semantic policy、service area、LINE
  policy/formatter、Shared Feed、CCTV、TDX、driverSummary、hourly
  reminder、Observatory 頁面整體 UI
- `BROWSER_ACTION_REQUIRED = YES`：真實 Cloudflare Queue 資源
  （`pbs-ai-processing-queue`）需在 Dashboard／`wrangler queues create`
  建立，本 sandbox 無法驗證或建立，**不得假設已存在**
- 詳見 `03_ARCHITECTURE.md`／`PRODUCT_DECISIONS.md`／`07_KNOWN_ISSUES.md`。
  **下一個 Agent：先確認 Cloudflare Queue 資源已建立並驗證，不得直接
  開始「AI 一小時歷史上下文」、driverSummary、formatter 修正、查修頁
  UI 改版或其他功能。**

## 補登（2026-08-30）— Windows PBS Geographic Filter Repair（人類回報，未獨立驗證）＋ V2.3.0 Production 驗收回報

**性質：DOCUMENTATION ONLY，本輪未修改任何 Windows／Cloudflare／Queue／AI 程式碼。**

- `WINDOWS_PBS_GEOGRAPHIC_FILTER_REPAIR`：人類回報 Windows 舊邏輯先套用
  `isAccident()` 事故語意閘門才進新竹地理判斷，導致非事故型新竹事件（落石／
  坍方／封路／施工／積水）可能在 Windows 端被直接丟棄；回報修正為移除該語意
  閘門，改用 point-in-polygon（data.gov.tw dataset 7442）取代原矩形邊界，新竹
  市/縣所有事件類型皆納入候選，語意判斷完全交給 AI；回報 `11→29`（找回 18
  筆）、`124 tests passed/0 failed`。**本 Session 獨立查證**：目前
  `pbs-relay/src/localPrototype.js` 仍保留 `isAccident()` 且仍在候選路徑上，
  `pbs-relay/` 全部 git 歷史（含 prototype 分支）未見對應 commit，故上述具體
  數字**未經本 Session 驗證**——記錄為 `HUMAN_REPORTED_NOT_INDEPENDENTLY_
  VERIFIED`，詳見 `07_KNOWN_ISSUES.md` 對應段落。
- `V2.3.0_PRODUCTION_VALIDATION`：人類回報「V2.3.0 已由 Production 真實事件
  驗收完成」，與本 Session 上一輪誠實回報的 `BROWSER_ACTION_REQUIRED = YES`
  （Cloudflare Queue 資源狀態 UNKNOWN）並存但未附可核對證據，本欄位維持
  `BROWSER_ACTION_REQUIRED = YES` 不變，待證據後再更新——**不得**僅因人類
  陳述就將先前誠實記錄的「未驗證」逕自改記為「已驗證」。
- 責任邊界（人類回報版本，供對照）：Windows=Geography Only，
  Cloudflare=Ingress/Transport/Orchestration，Queue=Reliable Background
  Processing，AI=Semantic Decision Authority，LINE=Delivery Only——與
  V2.1.0 正式命名的四層架構角色邊界一致，未新增或修改角色定義本身。
- 下一個 Agent：若要實際落地 Windows Geographic Filter 修正，須先在
  `pbs-relay/` 產生對應 commit 並可獨立驗證測試結果，才能把上方標記從
  `HUMAN_REPORTED_NOT_INDEPENDENTLY_VERIFIED` 升級為已驗證版本。

## 版本規則（開工前必讀，2026-08-25 起永久生效）

**開工前先寫下 `CURRENT_VERSION` 與 `TARGET_VERSION`**，並確認 TARGET 是 CURRENT 的合法下一版。

- 任何**進 Production 且改變 runtime 行為**的變更，必須在**同一個 commit 內** bump
  `src/version.js` 的 `APP_VERSION`——那是本專案唯一的版本權威，`GET /version` 就是讀它。
- **任務名稱 ≠ 版本號。** `CCTV_METADATA_RECOVERY`、`TDX_QUOTA_PROTECTION` 這類是工程標籤。
- **正式產品只有一條連續版本線**，不得建立平行版本線。
- `package.json` 的 `0.1.0` 是 npm 套件版本，**與產品版本線無關**，不要混用。
- 純文件／治理／工具／測試整理不 bump 版本，但仍須有 commit。

為什麼要寫成規則：`src/version.js` 曾從 2026-08-21 起停在 V1.8.6.9 整整三週，
期間 V1.8.7.0～V1.8.7.14 全部上線，`GET /version` 卻一直回報舊版本——
因為當時有三個地方各自以為自己知道版本。詳見 `07_KNOWN_ISSUES.md` 的版本線校正紀錄。

### 版本編號格式（2026-08-25 起：三段式）

`LAST_FOUR_PART_VERSION = V1.8.7.14` 是四段式版本線的**最後一版**——
`FOUR_PART_VERSIONING = RETIRED`。`src/version.js` 目前仍是 `V1.8.7.14`，
**不提前改動**；只有下一次真正 Production runtime release 才會把它
bump 到 `V1.9.0`，同一個 commit 內完成。

`THREE_PART_VERSIONING = ACTIVE`，`NEXT_RELEASE_VERSION = V1.9.0`：

- Bug fix → patch：`V1.9.0 → V1.9.1 → V1.9.2 …`
- 明顯新功能／架構階段 → minor：`V1.9.x → V1.10.0`
- 大型不相容版本 → major：`→ V2.0.0`
- 純文件／治理／Engineering Memory／測試整理 → 不升 Product Version

## Windows PBS Production Ingress ＋ Cloudflare PBS 輪詢退休（V1.9.8，2026-08-28，ACTIVE／Production）

真人的 Windows 機器（`C:\Users\mrhap\traffic-reporter\pbs-relay`）持續跑常駐的 PBS
本機邊緣篩選：`localMonitor.js` 每 3 分鐘抓一次官方 PBS feed，經本機服務區篩選（重用
Production 自己的 `src/pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant` 與
`src/pbs/roadName.js#normalizePbsRoad`）與事件生命週期比較
（NEW/UPDATED/CLEARED/UNCHANGED/MISSING_PENDING_CLEAR），`SHOULD_PUSH=YES` 的事件
呼叫 `POST /internal/pbs-debug-push`。**V1.9.6 首筆真實事件驗收成功**（台68 西向5K：
Windows早於 Cloudflare 舊 30 分鐘輪詢約 12.1 分鐘偵測到）；**V1.9.7** 加入 TRAFFIC_KV
下持久 L2 冪等層（`debug:pbs-push-idempotency:v1:*`，48h TTL，
`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PARTIAL`，維持不變）。

**V1.9.8（本輪，2026-08-28）— 新的正式 Production 主線**：PBS 官方來源 → Windows 本機
抓取／篩選／生命週期 → Debug Push → 持久冪等 → **正式 Business Pipeline** → 正式播報
資格判斷 → LINE。`src/pbs/debugPush.js` 就地升級為正式 Windows PBS Production
Ingress（改動最小方案，非另建第二 endpoint）：首次有效 NEW/UPDATED 事件正規化後，
交給 `src/traffic/broadcastPipeline.js` 既有未修改的 `runLineBroadcast()`——與 Cron
輪詢路徑呼叫的**同一個函式**——再呼叫 `src/traffic/sharedFeed.js` 既有
`runSharedFeedPersist()`。CLEARED 只 ACK/log，比照既有 `pbs/pipeline.js` 的
`clearedEvents` 從不進 broadcast 的行為。LINE Push Policy（`MAJOR_ACCIDENT_ONLY`）
完全未變動。同時，Cloudflare 自身 PBS 30 分鐘輪詢**正式退休**：
`src/pbs/pbsConfig.js#PBS_30_MIN_POLLING_ENABLED = false`，`pbsSchedule.js`／
`pbs/pipeline.js`／`pbs/lifecycle.js` 程式碼完整保留未刪除，翻回 `true` 即可
rollback。

**現狀旗標**：`WINDOWS_LOCAL_EDGE_FILTER = ACTIVE`、`WINDOWS_PBS_PRODUCTION_INGRESS
= ACTIVE`、`PERSISTENT_IDEMPOTENCY = ACTIVE(PARTIAL)`、
`PRODUCTION_BUSINESS_INTEGRATION = ACTIVE`、`LINE_INTEGRATION = ACTIVE`、
`PBS_30_MIN_POLLING = RETIRED`。完整架構圖、服務區/CLEARED 治理修正、Secret 治理
教訓、KV 成本量化、race condition 分析 → `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`；
機器可讀狀態 → `SYSTEM_STATE.json` 的 `pbsLocalEdgeFilterPrototype`／`taskSeal`。
**下一個 Agent：不要自行開始 V1.9.9、不要擴大 LINE policy、不要處理台61/台15全線
封閉產品政策、不要新增 Durable Object、不要進行無關架構重構、不要修改 Windows
Secret 或 Task Scheduler、不要碰本機 Prototype runtime。**

## 我能改什麼／不能改什麼（一句話版）

- **能改**：`traffic-reporter` repo 內，自己 Authority Boundary 內的程式、測試、文件、feature branch。
- **不能改**：雙鐵 / rail-traffic-consumer / rail-line-gateway 任何檔案、Cloudflare Dashboard、任何 repo 以外資產（除非有明確、針對該任務的額外授權）。
- **唯讀查證邊界**：跨部門資產（不論唯讀或寫入）一律先問真人——見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。

## 何時要找真人（最短版）

需要互動式登入/OAuth、需要 Credential、需要修改雙鐵 repo、需要破壞性 Production 操作（force push / 大量刪除 KV·R2 / rollback）、涉及跨部門 Contract Breaking Change、或證據顯示需要真人做產品決策時——才停下來問。一般程式錯誤/測試失敗/單一 repo 內查修，自行處理。

## 這份檔案之外，還想知道更多才讀

架構細節 → `03_ARCHITECTURE.md`　設計理由 → `04_PRODUCT_DECISIONS.md`　版本線 → `06_VERSION_HISTORY.md`　已知問題 → `07_KNOWN_ISSUES.md`　治理規則全文 → `01_FOUR_DEPARTMENT_GOVERNANCE.md`　接班摘要 → `02_PROJECT_HANDOFF.md`　完整工程歷史 → Repo `PROJECT_HANDOFF.md`（雲端分段見 `_history/`）
