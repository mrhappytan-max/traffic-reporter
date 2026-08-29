<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V2.2.0（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | 0fb1946d2da141cb20e86b97463919368268ca38 |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty (6 changed source file(s)) |
| Production | DEPLOYED |
| Production Verification | Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why) |
| Current Phase | Production maintenance / LINE Push observation（無施工中項目）｜PBS-ONLY + 重大事故限定 LINE Push + 三道獨立播報閘門 + PBS 國道事故 CCTV enrichment，全部已封版 SEALED。雲端同步治理 V2 生效：Claude 對 Drive 唯讀、GitHub 為唯一正式寫入來源，GitHub Actions 自動鏡像至 Drive（實測 PASS）。TDX 額度用盡，TDX／機動路肩程式碼完整保留 |
| Current Task | none（無進行中工作）。Latest completed task = DRIVE_SYNC_GOVERNANCE_V2，status = SEALED（前序 PBS_ACCIDENT_CCTV_ENRICHMENT_FIX、PBS_ACCIDENT_TRACE_LOCATION_QUALITY_FIX、PBS_ONLY_SERVICE_AREA_GATE_FIX、PBS_CCTV_MAJOR_ACCIDENT_ONLY 亦為 SEALED）。雲端治理：Claude 對 Google Drive 唯讀，GitHub 是唯一正式寫入來源，封版時只寫 GitHub、不要自己搬檔案到 Drive；GitHub → Drive 自動同步已由真人建置並實測通過（GitHub Actions，engineering-memory/ 為 canonical mirror source），GITHUB_TO_DRIVE_SYNC = PASS；不得人工補上傳，也不要重建那套自動同步。詳見 SYSTEM_STATE.json 的 cloudSyncGovernance。觀察中（非工作項，不是待辦）：一個月後檢視實際 LINE 主動 Push 量與 insufficient-location-precision 計數 |
| Latest Completed Version | V2.2.0 |
| Known Blocker | 無 blocker。兩個外部額度限制（TDX API、LINE OA 每月主動 Push）皆非本專案缺陷：TRAFFIC_SOURCE_MODE=PBS_ONLY 且 LINE_PUSH_POLICY=MAJOR_ACCIDENT_ONLY，CCTV 已恢復且仍為 0 次 TDX 呼叫。還原程序見 07_KNOWN_ISSUES.md |
| Real-world Confirmation | REAL_WORLD_CONFIRMATION_PENDING |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | 無待辦。TDX 額度恢復 → 套用 07_KNOWN_ISSUES.md 的 RESTORE TDX；一個月後 → 依 ineligibleByReason 實際數據（含 insufficient-location-precision）決定是否收緊主動播報政策；若日後取得 2026-08-24 台68 那筆 PBS 原始記錄 → 回頭核對 07_KNOWN_ISSUES.md 記載的誠實限制（皆為既有程序，不需重新設計） |
| Export Generated At | 2026-08-29T03:39:54.097Z |
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
