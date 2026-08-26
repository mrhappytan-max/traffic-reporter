<!-- title: 路況播報員 Concise Handoff -->

# 02. Project Handoff（Meeting Room Concise Handoff｜LEVEL 2）

這一份是**精簡接班版**，不是完整工程史。它只保留「一個新 Agent 真的接手所需」的內容，刻意控制在雲端同步工具可以穩定處理的大小。

> **完整 Level 2 / Level 3 工程歷史在哪裡**
> Repo 內 `PROJECT_HANDOFF.md`（約 320KB，逐輪 root cause / 決策脈絡 / 事故調查全文）永遠是完整且唯一的工程歷史 Source of Truth，**未被刪除、未被縮減**。
> 雲端側依章節語意切分後放在 `_history/`（非 canonical，新 Agent 不預設讀取，只有追歷史 Root Cause 時才讀）。
> 本檔與該全文若有出入，一律以 Repo 內 `PROJECT_HANDOFF.md` 與程式碼本身為準。

## Project purpose

一個 Cloudflare Worker，從兩個互相獨立的官方來源（TDX、PBS）擷取路況，正規化／去重／合併後，對已啟用的 LINE 訂閱者推播「可能讓職業駕駛（計程車／租賃）現在就必須改道」的事件。**一般壅塞刻意排除**——目標族群已經有 Google Maps／1968。符合條件的國道一號事故，LINE 訊息會在同一次推播中附帶 CCTV 影像。

## Current baseline

| 欄位 | 值 |
|---|---|
| Source main HEAD | 2f820216b57e3acd7c257d040034301027fc5a90 |
| Snapshot generated at | 2026-08-26T16:49:51.577Z |
| Source working tree | dirty (5 changed source file(s)) |
| Current version | V1.9.3 |
| Current phase | Production maintenance / LINE Push observation（無施工中項目）｜PBS-ONLY + 重大事故限定 LINE Push + 三道獨立播報閘門 + PBS 國道事故 CCTV enrichment，全部已封版 SEALED。雲端同步治理 V2 生效：Claude 對 Drive 唯讀、GitHub 為唯一正式寫入來源，GitHub Actions 自動鏡像至 Drive（實測 PASS）。TDX 額度用盡，TDX／機動路肩程式碼完整保留 |

`Source main HEAD` 是這份快照所描述的正式 main commit（取自 `origin/main`），**不是**包含本檔案自己的那個 commit——兩者刻意分開，避免 Git 自我參照循環。詳見 `SYSTEM_STATE.json` 的 `sourceMainHead` / `exportArtifactCommit`。

## Current architecture summary

```
TDX（國道/省道 RoadEvent）+ PBS（公路總局，經 Windows Relay + VPC Service）
      ↓ normalize / classify
      ↓ 新竹地理過濾
      ↓ KV dedupe（traffic:dedupe-state / traffic:baseline）
      ↓ crossSourceDedup.mergeForBroadcast()（PBS + TDX → canonical）
      ↓ broadcastRules.getBroadcastEligibility()（V1.5 白名單閘門）
      ↓ effectiveWindow / incidentSuppression / congestionCluster
      ↓ 道路·方向·公里數解析（roadIdentity, kmLocationResolver, roadSectionLabel）
      ↓ CCTV 選鏡頭與影像準備（hsinchuCctvProbe, dynamicCollage, collage）→ R2
      ↓ messageFormat → LINE push
      ↓ completedProducts → Shared Traffic Feed（sharedFeed）
      ↓ Pipeline Trace（24h 人工查修頁）
```

進入點：`traffic/scheduled.js`（Cron，每 10 分鐘）→ `traffic/pipeline.js`（TDX）／`pbs/pipeline.js`（PBS）→ `traffic/broadcastPipeline.js`（LINE 推播主迴圈 + Shared Feed 持久化）。

完整模組清單與逐層設計理由 → `03_ARCHITECTURE.md`；設計決策的「為什麼」→ `04_PRODUCT_DECISIONS.md`。

## Production components

- **Worker**：`traffic-reporter`，entry `src/index.js`，公開網域 `https://traffic-reporter.mr-happytan.workers.dev`。
- **Cron**：`*/10 * * * *`（UTC）。PBS 每個 tick 都跑；TDX 另外在 handler 內收斂成每 2 個 tick（分 00/20/40）且僅 08:00–21:59:59 Asia/Taipei。
- **KV**：`TRAFFIC_KV`（單一 namespace，承載全部狀態）。
- **R2**：`CCTV_IMAGES`（已發布的 CCTV 影像，15 分鐘 TTL 由程式強制檢查，不依賴 R2 lifecycle）。
- **VPC Service**：`PBS_RELAY_WINDOWS`（經 Cloudflare Tunnel 連到 Windows PBS Relay；從 Cloudflare 直接 fetch PBS 是已確認不通的，不要重查）。
- **Secrets（僅名稱，永不寫值）**：`TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`PBS_RELAY_TOKEN`、`ADMIN_PASSWORD`、`TRAFFIC_FEED_SECRET`。

完整 binding / route / dashboard-only 清單 → `PRODUCTION_MANIFEST.json`。

## Authority

- **traffic-reporter = Shared Traffic Feed 唯一內容權威（Producer）。** 擷取、分類、播報資格、時間視窗、去重／壓抑、KM／方向／道路解析、訊息格式化、CCTV，全部在這裡決定。`completedProducts` 進入 feed 即代表「已判斷完成，可直接播報」。
- **消費端（雙鐵／rail-traffic-consumer／rail-line-gateway）只做透明傳輸**，不得重新判斷、重新分類、重新篩選。
- **永久禁止**修改上述消費端 repo、其 Cloudflare Dashboard、其 LINE 頻道。消費端有問題 → 交證據，不動手。
- **能自主**：本 repo 內 Authority Boundary 內的程式／測試／文件／feature branch。
- **要先問真人**：互動式登入／OAuth、Credential、跨部門資產（唯讀也算）、破壞性 Production 操作、跨部門 Contract Breaking Change。

治理全文 → `01_FOUR_DEPARTMENT_GOVERNANCE.md`；邊界細節 → `05_CROSS_PROJECT_BOUNDARY.md`。

## 雲端同步：Google Drive 可讀、禁止直接寫（2026-08-25 起）

**這一條會直接影響你怎麼封版，先讀完再動手。**

```
CLAUDE_DRIVE_READ  = ALLOWED     可讀、可搜尋、可核對版本
CLAUDE_DRIVE_WRITE = FORBIDDEN   不可上傳／更新／封存／移動／刪除
```

- **GitHub 是版本資料的唯一正式寫入入口**（程式、Engineering Memory、SYSTEM_STATE、
  治理規則、版本紀錄，全部先進 GitHub）。
- **Google Drive 是可讀的工程記憶 mirror**，由 `GitHub → Google Drive Sync` 寫入，
  不是 Claude 的直接寫入目標。永久順序：**GitHub first, Drive second**。
- 你要做的只有一件事：**把該同步的內容正確寫進 GitHub**。搬檔案到 Drive 不是你的工作。

封版時請分開回報這三個狀態，不要再用含糊的「雲端同步 = PASS」：

```
GITHUB_ENGINEERING_MEMORY   本次記憶是否已 commit 進 GitHub
GITHUB_TO_DRIVE_SYNC        GitHub 端是否已同步到 Drive
CLAUDE_DRIVE_UPLOAD         永遠是 NO
```

**若 GitHub → Drive 自動同步尚未完成**：誠實標 `GITHUB_TO_DRIVE_SYNC = PENDING` 並停止。
**不得**為了讓 Drive 看起來是最新版而自行用 Connector 補上傳，也不得把 PENDING 報成 PASS。
機器可讀狀態見 `SYSTEM_STATE.json` 的 `cloudSyncGovernance`。

## Current version

| 欄位 | 值 |
|---|---|
| Latest completed | V1.9.3 |
| package.json version | 0.1.0 |
| Production status | DEPLOYED |
| Production verification | Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why) |

版本線（哪些版本仍具架構意義）→ `06_VERSION_HISTORY.md`。

## Current known issues

- **Known blocker**：無 blocker。兩個外部額度限制（TDX API、LINE OA 每月主動 Push）皆非本專案缺陷：TRAFFIC_SOURCE_MODE=PBS_ONLY 且 LINE_PUSH_POLICY=MAJOR_ACCIDENT_ONLY，CCTV 已恢復且仍為 0 次 TDX 呼叫。還原程序見 07_KNOWN_ISSUES.md
- **Real-world confirmation**：REAL_WORLD_CONFIRMATION_PENDING
- **既有測試失敗基準線**：`npm test` 共 1272 項，其中穩定 38 項為已知失敗（2 項 `pbs-relay/tests/*` 缺 `pbs-relay/src/cache.js`；**33 項過期斷言**——動態路肩推播關閉、PBS 成為 CCTV 可信來源之後未同步更新的測試，是目前最大的一筆技術債，待獨立施工令；3 項 wall-clock 相依的 `healthQuotaDashboard`，會隨日期自然增加）。**注意：舊版文件宣稱那 13 項是「Workers-only `.wasm` codec 在沙盒無法載入」，這是錯的 Root Cause——真正原因是沙盒 `node_modules` 不完整、`@jsquash/jpeg` 沒安裝；裝了之後那些檔案全部可以執行，並揭露上述 33 項過期斷言。**出現這 18 項以外的新失敗才算真正回歸，且**判斷回歸一律以同一輪 `git stash -u` 對照為準**；逐項清單、`deploymentPolicyAndVerify` 第 12 項的「尚未 push 必失敗」現象，以及 `deploymentStatus` 那項只在全套執行時偶發的雜訊，都見 `07_KNOWN_ISSUES.md`。
- **Dashboard-only 事實永遠無法從程式驗證**：Production branch 指向、真實 Cron 排程、Secret 值是否正確、Build 歷史——只能由真人開 Dashboard 確認。
- **沙盒無 Production 網路**：這類 session 對 Production 網域的 outbound HTTPS 一律被 egress proxy 擋（403）。需要即時 Production 證據的任務只能誠實標記「無法證明」，不得用推測補齊。

完整清單與成因 → `07_KNOWN_ISSUES.md`。

## Deployment / verification path

- **部署方式**：push 到 `main` → Cloudflare Workers Builds 自動部署。沒有其他 branch／hook 會觸發正式部署。
- **本地零網路檢查**：`npm run check:deployment-policy`
- **線上驗證**：`npm run verify:production`（打 `GET /version`，回傳 deployedCommit／deployedBranch／buildTime／appVersion）
- **build metadata**：`scripts/generateBuildMetadata.mjs`，由 `package.json` 的 predeploy hook 產生，部署當下的 commit 就地寫入 bundle。

## Debug entry points

全部需要 Admin Basic Auth（使用者名稱固定 `admin`，密碼來自 `ADMIN_PASSWORD` Secret）；`ADMIN_PASSWORD` 缺失時一律 503 fail-closed，永不變成公開。

| 端點 | 用途 |
|---|---|
| `GET /debug/status` | 主力診斷：完整 pipeline 預覽、eligibility 統計、PBS 狀態。「為什麼這則有／沒有播」先看這裡 |
| `GET /debug/tdx` | 各 TDX source 的原始擷取結果 |
| `GET /debug/pbs` | PBS 專用：relay 狀態、lifecycle 計數、跨來源樣本 |
| `GET /debug/pbs-vpc-probe` | 最底層：直接打 Relay 的 /health 與 /pbs。PBS 看起來壞掉時先用這個 |
| `GET /admin/pipeline-trace-view` | 24h 逐事件查修頁（無 client-side JS，深色介面） |
| `GET /admin/broadcast-provenance` | 「剛才那則為什麼長這樣」——只記錄真的推播出去的事件 |
| `GET /admin/deployment-status-view` | 部署漂移與 binding／secret 存在性 |
| `GET /version` | **唯一公開**、無需認證的版本端點（5 個欄位白名單） |

`GET /cctv/image/:id` 是另一個刻意公開的路由（LINE 伺服器要能抓圖），安全性靠 128-bit 不可猜 id + 程式強制的 15 分鐘到期檢查。

## PBS Local Edge Filter Prototype（2026-08-26，feature branch／未 merge，非本輪 Product Version 事件）

真人在 Windows 本機（`C:\Users\mrhap\traffic-reporter\pbs-relay`）完成了一個**與上面
Production VPC Relay 完全分開**的邊緣篩選 Prototype，程式碼已由真人（經另一個
Windows 本機 agent）commit/push 進 GitHub：

```
既有 Relay（Production，未變動）：
PBS 官方 -> upstreamClient.js -> pbsHandler.js -> 3分鐘 memory cache
        -> GET /pbs/<token> -> Cloudflare（只搬運 raw，不解析不篩選）

新 Prototype（Windows 本機，尚未接上 Cloudflare）：
PBS 官方 -> localMonitor.js -> localPrototype.js
        （服務區篩選 -> 事故關鍵字篩選 -> 有效/解除判斷）
        -> localState.js（上一輪 vs 本輪比對，主鍵 PBS UID，
           fingerprint 排除 modDttm）
        -> NEW / UPDATED / CLEARED / UNCHANGED
        -> SHOULD_PUSH（目前只是判斷信號，尚未實際傳輸）
```

**狀態**：`PBS_LOCAL_EDGE_FILTER_PROTOTYPE = COMMITTED_TO_FEATURE_BRANCH`。
`LOCAL_PROTOTYPE_CODE_GITHUB_STATUS = COMMITTED_TO_FEATURE_BRANCH`
（`feature/pbs-local-edge-filter-prototype`，commit
`c34b52c045cd05eb4be01b91debe5ba002c73cb6`，**尚未 merge 進 main**）。
`WINDOWS_TO_CLOUDFLARE_PUSH = NOT_STARTED`。`PRODUCTION_INTEGRATION =
NOT_STARTED`。`PRODUCT_VERSION_BUMP = NO`（此 Prototype 本身不是 Release；Production
版本照自己節奏推進，與此無關，目前為 V1.9.3）。

真人回報 pbs-relay 68/68 通過；本 Cloud Session 另對同一 commit 做了一次獨立
唯讀驗證（`git worktree` 乾淨簽出）：Prototype 自己新增的兩個測試檔（共 12 項）
全數通過，但既有的 `pbsHandler.test.js`／`server.test.js` 在乾淨簽出下整檔載入
失敗——與本專案已知、與此 Prototype 無關的既有 `cache.js` 缺口一致（詳見
`07_KNOWN_ISSUES.md`）。真實兩次本機執行（22:42:09 / 22:42:28
Asia/Taipei）證明 local state persistence／same-event dedup／no-change
detection 三者皆正常。已知限制（`CLEAR_ON_SINGLE_ABSENCE = PROTOTYPE_ONLY`，
正式 Production 前需重新決策）、六階段路線圖（PHASE A 觀察期 → … →
PHASE F 需真人另行授權的 Production 評估）、長期目標架構，完整記錄於
`07_KNOWN_ISSUES.md`；機器可讀欄位於 `SYSTEM_STATE.json` 的
`pbsLocalEdgeFilterPrototype`。**下一個 Agent／新工程師讀到這裡：這個 feature
branch 已在 GitHub 但尚未 merge 進 main，不要自行 merge、不要重新拆 PBS Relay
或重新研究 upstreamClient/cache/handler，也不要誤把這個 Prototype 當成
Production 已完成的功能。**

## Next action

無待辦。下一個真實 Asia/Taipei 帳務日重置後，可蒐集 ≥3 筆 Production [kv-write-budget] log 樣本核實 V1.9.3 實際效果（比對 healthSnapshot/pbsFetch/pipelineTraceBatch 分類數字）。PBS Prototype feature branch 仍在 GitHub 但尚未 merge main；merge、Windows → Cloudflare 實際傳輸，皆需真人另行明確授權，不自行開始。若要開工，建議處理約 33 項過期斷言（見 07_KNOWN_ISSUES.md，既有技術債，與本輪無關）。

## Full history location

| 內容 | 位置 |
|---|---|
| 完整工程歷史（未縮減，Source of Truth） | Repo `PROJECT_HANDOFF.md` |
| 雲端分段歷史（非 canonical，按需閱讀） | `_history/`（見該資料夾內 `_history/00_INDEX.md`） |
| 設計決策全文 | `04_PRODUCT_DECISIONS.md` |
| 逐 commit 歷史 | `git log` |
