<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | {{CURRENT_VERSION}}（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | {{SOURCE_MAIN_HEAD}} |
| Source main HEAD resolved from | {{SOURCE_MAIN_HEAD_ORIGIN}} |
| Source working tree | {{SOURCE_WORKING_TREE}} |
| Production | {{PRODUCTION_STATUS}} |
| Production Verification | {{PRODUCTION_VERIFICATION}} |
| Current Phase | {{CURRENT_PHASE}} |
| Current Task | {{CURRENT_TASK}} |
| Latest Completed Version | {{LATEST_COMPLETED_VERSION}} |
| Known Blocker | {{KNOWN_BLOCKER}} |
| Real-world Confirmation | {{REAL_WORLD_CONFIRMATION}} |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | {{NEXT_ACTION}} |
| Export Generated At | {{EXPORT_GENERATED_AT}} |
| Export artifact commit | {{EXPORT_ARTIFACT_COMMIT}} |

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

## PBS Windows Local Edge Debug Push Integration（V1.9.6，2026-08-27，ACTIVE／Debug-only）

真人的 Windows 機器（`C:\Users\mrhap\traffic-reporter\pbs-relay`）現在**真的在跑**一個
常駐的 PBS 本機邊緣篩選＋Debug Push 整合：`localMonitor.js` 每 3 分鐘抓一次官方 PBS
feed，經本機服務區篩選（**現已改為直接 import 並重用 Production 自己的
`src/pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant` 與 `src/pbs/roadName.js#normalizePbsRoad`**，
不再是舊版那個會誤收鶯歌/楊梅的寬鬆矩形）與事件生命週期比較（NEW/UPDATED/CLEARED/
UNCHANGED/MISSING_PENDING_CLEAR），只有 `SHOULD_PUSH=YES` 的事件才呼叫 V1.9.5 建立的
Debug-only 接收端 `POST /internal/pbs-debug-push`。**程式碼已 push 進 GitHub feature
branch**（`feature/pbs-local-edge-filter-prototype`，最新 commit
`95ecdc4718f836ff36c974e829b549f262e6b936`，**尚未 merge 進 main**）——本 Cloud
Session 已獨立唯讀驗證：`git fetch`＋`git merge-base --is-ancestor`（確認未合併）＋
`git worktree` 乾淨簽出跑 `node --test`，**118 項全數通過，0 失敗**，與真人回報數字
完全一致（先前輪次的 `cache.js` 缺口，此 commit 已補上）。

**現狀旗標**：`WINDOWS_LOCAL_EDGE_FILTER = ACTIVE`、`WINDOWS_REAL_DEBUG_PUSH = ACTIVE`
（真人已設定 `PBS_DEBUG_PUSH_ENABLED=true`）、`CLOUDFLARE_DEBUG_RECEIVER = ACTIVE`
（V1.9.5）、`WINDOWS_TO_CLOUDFLARE_DEBUG_CHANNEL = VERIFIED`、
`WINDOWS_TO_PRODUCTION_BUSINESS_PIPELINE = NOT_STARTED`（不進 LINE／CCTV／Shared
Feed／正式 KV）、`LINE_INTEGRATION = NOT_STARTED`、`PBS_30_MIN_POLLING = PRESERVED`
（Cloudflare 既有 PBS 輪詢完全不受影響，仍是目前的正式路徑）、
`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PENDING_BEFORE_PRODUCTION`（目前只有
per-isolate 記憶體內判斷，**正式接上 LINE 前必須解決**）。**不影響本專案任何 Product
Version 的 runtime 行為改變本身不是這個 Prototype 造成的**——`src/version.js` 這次的
bump 是治理封版（把已完成的 Windows 端架構正式寫入 Engineering Memory），並非新的
Cloudflare runtime 變更；Cloudflare Worker 端的實際程式碼仍是 V1.9.5 的
`/internal/pbs-debug-push`。完整架構圖、服務區/CLEARED 治理修正、Secret 治理教訓、
路線圖 → `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`；機器可讀狀態 →
`SYSTEM_STATE.json` 的 `pbsLocalEdgeFilterPrototype`。**下一個 Agent：不要自行 merge
這個 feature branch、不要自行開始 LINE/CCTV/Business KV 整合、不要修改 Windows
Secret 或 Task Scheduler、不要碰本機 Prototype runtime、不要自行開始 V1.9.7。**

## 我能改什麼／不能改什麼（一句話版）

- **能改**：`traffic-reporter` repo 內，自己 Authority Boundary 內的程式、測試、文件、feature branch。
- **不能改**：雙鐵 / rail-traffic-consumer / rail-line-gateway 任何檔案、Cloudflare Dashboard、任何 repo 以外資產（除非有明確、針對該任務的額外授權）。
- **唯讀查證邊界**：跨部門資產（不論唯讀或寫入）一律先問真人——見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。

## 何時要找真人（最短版）

需要互動式登入/OAuth、需要 Credential、需要修改雙鐵 repo、需要破壞性 Production 操作（force push / 大量刪除 KV·R2 / rollback）、涉及跨部門 Contract Breaking Change、或證據顯示需要真人做產品決策時——才停下來問。一般程式錯誤/測試失敗/單一 repo 內查修，自行處理。

## 這份檔案之外，還想知道更多才讀

架構細節 → `03_ARCHITECTURE.md`　設計理由 → `04_PRODUCT_DECISIONS.md`　版本線 → `06_VERSION_HISTORY.md`　已知問題 → `07_KNOWN_ISSUES.md`　治理規則全文 → `01_FOUR_DEPARTMENT_GOVERNANCE.md`　接班摘要 → `02_PROJECT_HANDOFF.md`　完整工程歷史 → Repo `PROJECT_HANDOFF.md`（雲端分段見 `_history/`）
