<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V1.9.9（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | 179c94272e8f59c6dd1072a385240c0b10c2d70b |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty (13 changed source file(s)) |
| Production | DEPLOYED（Phase 1由另一session實際部署驗證；本輪Phase 2為repo-side準備工作，依施工令指示Dashboard驗證由GPT Work接手，本Session未嘗試連線） |
| Production Verification | NOT_OBSERVED（本輪）— sandbox egress封鎖Production網域與Cloudflare Dashboard；施工令本身指示本輪不需要Dashboard驗證 |
| Current Phase | V1.9.9 PHASE 2 SEALED — AI-ready Business Pipeline Simplification |
| Current Task | none（無進行中工作）。Latest completed = AI_READY_PIPELINE_PREPARATION_V1_9_9_PHASE_2, status=SEALED. CURRENT_OFFICIAL_VERSION=V1.9.9. |
| Latest Completed Version | V1.9.9 |
| Known Blocker | none |
| Real-world Confirmation | N/A — 本輪為確定性測試驅動的repo-side準備工作，未等待/未人工製造真實PBS事件 |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | STOP；等待新的正式施工令。不得自行開始 Phase 3。不得接 Workers AI。不得修改 Workers AI Dashboard。不得開始 V1.9.10。 |
| Export Generated At | 2026-08-28T05:48:24.439Z |
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
- 詳見 `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`。**下一個 Agent：不得自行開始 Phase 3；不得接 Workers AI；不得修改 Workers AI Dashboard；不得開始 V1.9.10。**

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

## Engineering Memory 同步治理（2026-08-25 起）

- `traffic-reporter` GitHub `main` 是唯一 canonical source。
- Google Drive `路況播報員_工程記憶` 是 automated mirror。
- 正常寫入路徑只允許 GitHub main → GitHub Actions → Google Drive API。
- 同步採 missing → create、changed → update、unchanged → skip，不自動刪除 Drive 其他檔案。
- Claude / Agent 不得日常從 Drive 反向搬回 GitHub，也不得人工逐檔上傳 Drive。
- 認證採 GitHub OIDC + Google Workload Identity Federation 短效憑證；禁止建立長期 Service Account JSON key。
