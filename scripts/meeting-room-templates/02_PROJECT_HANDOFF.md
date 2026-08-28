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
| Source main HEAD | {{SOURCE_MAIN_HEAD}} |
| Snapshot generated at | {{EXPORT_GENERATED_AT}} |
| Source working tree | {{SOURCE_WORKING_TREE}} |
| Current version | {{CURRENT_VERSION}} |
| Current phase | {{CURRENT_PHASE}} |

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
| Latest completed | {{LATEST_COMPLETED_VERSION}} |
| package.json version | {{PACKAGE_VERSION}} |
| Production status | {{PRODUCTION_STATUS}} |
| Production verification | {{PRODUCTION_VERIFICATION}} |

版本線（哪些版本仍具架構意義）→ `06_VERSION_HISTORY.md`。

## Current known issues

- **Known blocker**：{{KNOWN_BLOCKER}}
- **Real-world confirmation**：{{REAL_WORLD_CONFIRMATION}}
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

## Windows PBS Production Ingress（V1.9.8，2026-08-28，main／ACTIVE／Production）

**本輪把下面 V1.9.5-V1.9.7 建立的 Debug-only channel 正式升級為 Production 主線**：

```
PBS 警廣官方來源
    ↓
Windows 本機每 3 分鐘抓取 / 服務區篩選 / 生命週期比較（不變，見下方 V1.9.6/V1.9.7 段落）
    ↓
POST /internal/pbs-debug-push（src/pbs/debugPush.js，就地升級，非另建 endpoint）
    ↓
驗證身份 → 驗證格式 → 持久冪等（V1.9.7 不變）
    ↓
非duplicate？ ── 是CLEARED ──→ 只ACK/log，不進下一步（比照輪詢路徑 clearedEvents 從不進 broadcast）
    │
    是NEW/UPDATED
    ↓
buildRawPbsRecordFromPush()：Windows payload → raw-PBS-shaped record
    ↓
pbs/normalize.js#normalizePbsEvent()（既有、未修改）
    ↓
traffic/broadcastPipeline.js#runLineBroadcast()（既有、未修改 ——
    與 Cron 輪詢路徑呼叫的「同一個函式」：事故/服務區/位置品質/
    資格/去重/CCTV/LINE Push Policy/notified-state 全部同一套判斷）
    ↓
traffic/sharedFeed.js#runSharedFeedPersist()（既有、未修改）
    ↓
LINE（若通過資格）／Shared Feed（無論是否推播成功都記錄完成品）
```

**同時**：Cloudflare 自身既有 PBS 30 分鐘輪詢**正式退休**——
`src/pbs/pbsConfig.js#PBS_30_MIN_POLLING_ENABLED = false`，`traffic/scheduled.js`
不再實際呼叫 PBS fetch；`pbsSchedule.js`／`pbs/pipeline.js`／`pbs/lifecycle.js`
程式碼一行未刪，翻回旗標即可 rollback。同一個 Cron tick 的 TDX／health
snapshot／Shared Feed／Pipeline Trace 完全不受影響。

**現狀旗標（取代下方 V1.9.6/V1.9.7 記錄的舊旗標）**：
`WINDOWS_PBS_PRODUCTION_INGRESS = ACTIVE`、`PRODUCTION_BUSINESS_INTEGRATION =
ACTIVE`、`LINE_INTEGRATION = ACTIVE`、`CCTV_INTEGRATION = ACTIVE`（重用
runLineBroadcast 自動套用）、`PBS_30_MIN_POLLING = RETIRED`、
`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PARTIAL`（V1.9.7 設計不變）。

LINE Push Policy（`MAJOR_ACCIDENT_ONLY`）完全未變動——只是事件來源多了 Windows 這
一條路，最終播報與否仍完全由 Cloudflare 既有規則決定，Windows 從未擁有這個決定權。

新增測試：`test/pbsDebugPush.test.js` 施工令十五項最低清單、
`test/pbsPollingRetirementV198.test.js`（退休驗證 4 項）。全量迴歸 1424/1391/33，
與變更前基線（1404/1371/33）失敗清單逐項相同，NEW FAILURES = 0。

完整設計理由（KV 成本剖面修正、已知副作用如 `pbs:lifecycle-state`/`/health` pbs
區塊凍結）→ `07_KNOWN_ISSUES.md`；機器可讀狀態 → `SYSTEM_STATE.json` 的
`pbsLocalEdgeFilterPrototype`／`taskSeal`。（V1.9.8 當時的「不要自行開始 V1.9.9」
已過期——V1.9.9 Phase 1/Phase 2 見下方新段落；現行禁令見該段落結尾。）

## V1.9.9 Phase 1（Windows 服務區收斂）＋ Phase 2（AI-ready 準備，2026-08-28）

**Phase 1**（fix commit `7acb82a`，完成於另一個 session，本 Cloud Session 未
參與）：Windows PBS Local Edge Filter 服務區收斂為新竹市／新竹縣（竹南／頭份／
苗栗市及其他苗栗縣區域排除）。純 `pbs-relay/`（Windows 端）變更，**這一輪同時
把 `pbs-relay/` 整包直接 commit 進 main**——不再是未合併的 feature branch（下方
V1.9.6/V1.9.7 段落記錄的 `MERGED_TO_MAIN = NO` 已過期，見該段自己的標記）。

**Phase 2**（本輪）— AI-ready Business Pipeline Simplification：為 Phase 3
Workers AI 全量判讀做準備，本階段刻意不接 AI、不啟用新 LINE 判讀政策，只整理
decision path。新模組 `src/pbs/aiCandidate.js`：從 `src/pbs/debugPush.js` 既有
（完全未修改）的正規化事件建立最小 AI candidate 物件，與既有 `runLineBroadcast()`
呼叫**並行、完全獨立**——只保留 service area 與冪等/重複防護兩個 gate，不套用
`MAJOR_ACCIDENT_ONLY`／V1.5 type whitelist／location quality hard-reject（那些
函式本身完全未修改，對真實 LINE 決策仍完整生效，直到 Phase 3 才會被取代）。
candidate 純粹 log 觀察用（`PBS_AI_DECISION_MODE = PREPARED_NOT_ACTIVE`），從未
觸及 LINE／CCTV／Shared Feed，從未呼叫任何 AI 模型。另預留 AI decision cache
key 設計（`computeAiDecisionCacheKeyHash`，重用既有穩定 fingerprint）僅
schema/helper，本輪無任何 KV 讀寫。

新增測試：`test/pbsAiCandidate.test.js`（13 項單元測試）＋
`test/pbsDebugPush.test.js` 施工令十五項最低清單。全量迴歸 1452/1419/33，與
變更前基線（1424/1391/33）失敗清單逐項相同，NEW FAILURES = 0。

完整設計理由 → `07_KNOWN_ISSUES.md`／`03_ARCHITECTURE.md`；機器可讀狀態 →
`SYSTEM_STATE.json` 的 `taskSeal`。（Phase 2 當時「不得自行開始 Phase 3」已由
下方 Phase 3B 段落取代——見該段落結尾現行禁令。）

## V1.9.9 Phase 3B — Workers AI Driver Impact Decision Integration（本輪，2026-08-28）

Phase 2 預留的 AI candidate／cache key 設計正式接上真實 Workers AI 呼叫。固定
model `@cf/zai-org/glm-4.7-flash`，透過 `env.AI.run(...)`（binding 名稱 `AI`，
`wrangler.jsonc` 已新增 `"ai":{"binding":"AI"}`）。新模組：`src/pbs/aiConfig.js`
（kill switch `PBS_AI_DECISION_ENABLED`，預設 `false`）、
`src/pbs/aiDecisionCache.js`（重用 Phase 2 cache key 設計，48h TTL，fail-open
KV 讀寫）、`src/pbs/aiDecisionEngine.js`（固定繁中 prompt，只判斷駕駛通行影響、
不依事件類型名稱決定；`validateAiDecisionResponse()` 嚴格 schema 檢查，任何
不合格輸出即 `AI_DECISION_INVALID`，絕不到達 LINE）、
`src/traffic/aiApprovedPbsBroadcast.js`（`runAiApprovedPbsBroadcast()`，重用
既有 subscriptions/notified/incidentSuppression/messageFormat/CCTV/
pushMessage，明確不呼叫 `getBroadcastEligibility`／`getLinePushPolicyDecision`／
`resolveLocationQuality`——這三個正是本輪要退休的內容判讀硬規則）。

`src/pbs/debugPush.js` 的分支點：AI 開啟時與 legacy `runLineBroadcast()` 路徑
**互斥**，同一事件絕不同時執行兩者，避免雙重判官造成 LINE 重複推播。Exact
transport duplicate 與 AI cache hit 皆是 0 次 AI 呼叫。AI 失敗（429/5xx/
network/invalid response/binding missing）一律 0 LINE、trace 記錄，絕不
fallback 回舊硬規則；未加入 retry（無可重用 helper，且施工令要求第一版簡單）。
CLEARED 事件不呼叫 AI、不產生相關 LINE 推播。

新增 5 個測試檔共 57 項測試（`aiConfig`4／`aiDecisionCache`9／
`aiDecisionEngine`18／`aiApprovedPbsBroadcast`9／`pbsAiDecisionScenarios`17，
含施工令 A-P 十六個 mocked-AI-adapter 情境），全部第一次執行即 PASS。完整
迴歸 1509/1476/33，NEW FAILURES=0。APP_VERSION 維持 `V1.9.9`（本輪不升版本
號）。

**現狀旗標**：`V1.9.9_PHASE_3B = CODE_READY`、
`AI_BINDING = PENDING_GPT_WORK`、`AI_DECISION = DISABLED`、
`LINE_AI_DECISION = NOT_ACTIVE`。Production AI Binding 建立/驗證是 GPT Work
的工作範圍，本輪未嘗試開啟 Cloudflare Dashboard、未驗證 Neurons Dashboard。
完整設計理由 → `07_KNOWN_ISSUES.md`／`03_ARCHITECTURE.md`；機器可讀狀態 →
`SYSTEM_STATE.json` 的 `taskSeal`。（Phase 3B 當時的現行禁令已由下方 Phase
3D Hotfix 段落取代——見該段落結尾。）

## V1.9.9 Phase 3D Hotfix — Cloudflare 字串布林解析（本輪，2026-08-28）

GPT Work 在 Dashboard 把 `PBS_AI_DECISION_ENABLED` 設為 `"true"` 後，正式
環境 AI 決策仍未啟用。根因：Cloudflare Dashboard／CLI Variables 一律以
**字串**注入 Worker，從不是真正的 boolean；`src/pbs/aiConfig.js#
resolvePbsAiDecisionEnabled()` 原本嚴格檢查 `typeof === 'boolean'`，字串
`"true"` 永遠不符合，因此每次請求都悄悄落回安全預設值 `false`——不是
Dashboard 操作錯誤，是 resolver 本身的 bug。GPT Work 已先行 rollback
（`PBS_AI_DECISION_ENABLED = FALSE`），本輪只修這一點。

修正：`resolvePbsAiDecisionEnabled()` 現在同時接受真正 boolean
`true`/`false`，以及 Cloudflare runtime 的字串形式 `"true"`/`"false"`
（不分大小寫、去除前後空白）；除此之外的任何值（`undefined`、`null`、
空字串、其他常見「真值」拼法如 `"1"`/`"yes"`/`"on"`、或任何非字串非
boolean 型別）一律 fail-safe 回 `PBS_AI_DECISION_ENABLED_DEFAULT =
false`——刻意不做寬鬆 truthy 判斷。`wrangler.jsonc` 檢查後確認未宣告任何
`PBS_AI_DECISION_ENABLED` 值，Production 預設安全性不受影響。

新增 8 項測試：`test/aiConfig.test.js` 擴充為完整 true/false/字串/大小寫/
空白/未知值矩陣（新增 6 項，1 項既有測試斷言依新預期行為反轉）；
`test/pbsAiDecisionScenarios.test.js` 新增 2 項 integration-level 測試，
透過真實 `handlePbsDebugPush()` 端對端證明字串 `"true"` 確實會讓 mocked
AI adapter 被呼叫、字串 `"false"` 確實維持 0 次 AI 呼叫。完整迴歸
1517/1484/33，NEW FAILURES=0。

本輪**未觸碰**：AI prompt、model ID、AI candidate schema、AI cache、
cache TTL、`runAiApprovedPbsBroadcast`、LINE policy、
`MAJOR_ACCIDENT_ONLY` legacy path、service area、lifecycle、
idempotency、CCTV、Shared Feed、hourly reminder、TDX、Windows
monitor——單點 config parsing hotfix。APP_VERSION 維持 `V1.9.9`。

**現狀旗標**：`AI_BINDING = ACTIVE`（GPT Work 已確認）、
`AI_DECISION = DISABLED_PENDING_GPT_WORK_RETRY`——修正已部署，但 Dashboard
端 `PBS_AI_DECISION_ENABLED` 目前仍是 GPT Work rollback 後的 `FALSE`，
尚未重新設回 `"true"` 重試。是否／何時重試由 GPT Work 決定，不在本輪
範圍。完整設計理由 → `07_KNOWN_ISSUES.md`／`03_ARCHITECTURE.md`；機器
可讀狀態 → `SYSTEM_STATE.json` 的 `taskSeal`。**下一個 Agent：不得自行
開啟 Production AI；不得開始 Phase 4；不得升 V1.9.10。**

## PBS Windows Local Edge Debug Push Integration（V1.9.6＋V1.9.7，2026-08-28，歷史記錄——已由上方 V1.9.8／V1.9.9 取代為 Production 主線）

真人在 Windows 本機（`C:\Users\mrhap\traffic-reporter\pbs-relay`）已把上一輪的邊緣篩選
Prototype 接成一條**真的在跑、真的會呼叫 Cloudflare** 的 Debug-only 管線（與下面既有
的 Production VPC Relay 完全分開，互不影響）：

```
PBS 警廣官方來源
    ↓
Windows 本機每 3 分鐘抓取（localMonitor.js，Task Scheduler 常駐）
    ↓
Local Edge Filter（localPrototype.js）
    ── 服務區篩選：直接 import Production 自己的
       src/pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant、
       src/pbs/roadName.js#normalizePbsRoad（見下方「服務區治理修正」）
    ── 事件生命週期比較（localState.js，主鍵 PBS UID）
    ↓
NEW / UPDATED / CLEARED / UNCHANGED / MISSING_PENDING_CLEAR
    ↓
SHOULD_PUSH 判斷（localDebugPush.js，只有 NEW/UPDATED/CLEARED 才可能送）
    ↓
若 SHOULD_PUSH=NO → 完全停在 Windows，不呼叫 Cloudflare
若 SHOULD_PUSH=YES ↓
    ↓
Windows Debug Push Client（debugPushClient.js，5000ms timeout／最多2次嘗試，
    只對 timeout/network/5xx 重試，同一個 requestId）
    ↓
POST /internal/pbs-debug-push（Authorization header 帶 PBS_DEBUG_PUSH_SECRET）
    ↓
Cloudflare Debug-only Receiver（見 03_ARCHITECTURE.md／07_KNOWN_ISSUES.md）
    ↓
驗證身份 → 驗證格式 → 冪等判斷（L1記憶體 + V1.9.7新增的L2 TRAFFIC_KV持久層，
    見下方「V1.9.7」） → Workers Logs → ACK
（明確不進：LINE／CCTV／R2／Shared Feed／正式 Business KV／正式 Broadcast Pipeline）
```

**最新程式事實，V1.9.6/V1.9.7 當時的歷史快照**（`LOCAL_PROTOTYPE_MERGED_TO_MAIN = NO` 已於 V1.9.9 Phase 1 過期——`pbs-relay/` 現已直接 commit 進 main，見本檔案最上方「V1.9.9 Phase 1」段落，此處數字不重寫，僅標記過期）：`LOCAL_PROTOTYPE_BRANCH = feature/pbs-local-edge-filter-prototype`，
`LOCAL_PROTOTYPE_HEAD = 95ecdc4718f836ff36c974e829b549f262e6b936`。本 Cloud Session 對這個新 commit 做了獨立
唯讀驗證——`git fetch`＋`git rev-parse` 確認 SHA 完全相符、`git merge-base
--is-ancestor` 確認尚未合併進 main、`git worktree add --detach` 乾淨簽出跑
`node --test tests/*.test.js`：**118 項測試、118 pass、0 fail**，與真人回報的數字
完全一致（前一輪回報的 `cache.js` 缺口，這個 commit 已經補上，`pbsHandler.test.js`／
`server.test.js` 不再因此整檔失敗）。

**V1.9.6 首筆真實事件驗收成功**：台68西向5K，Windows Debug Push 08:48:30，Cloudflare
既有30分鐘輪詢09:00:39才自己看到——Windows早發現約12.1分鐘，證明整條channel運作正常。

**V1.9.7（本輪，2026-08-28）— 關閉持久冪等風險**：V1.9.6封版時標記的
`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PENDING_BEFORE_PRODUCTION`（僅per-isolate
記憶體冪等）本輪正式解決。`src/pbs/debugPush.js` 新增 TRAFFIC_KV 下獨立 debug-only
前綴（`debug:pbs-push-idempotency:v1:*`，48h TTL）作為持久L2層，key由
`source:eventId:lifecycle:fingerprint` 的SHA-256雜湊決定性產生（不用requestId）；
既有記憶體Map保留為L1快取但非唯一真相，L1 miss一律再查L2才能accept。**這是真正的
Cloudflare runtime變更**（V1.9.6只是治理封版，未動Cloudflare程式碼）。
`KV_ONLY_ATOMICITY = NOT_SUFFICIENT`（KV無compare-and-swap），但此endpoint零
business side effect，依施工令「不要過度設計」指示不引入Durable Object；
`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY` 因此誠實標記為 **`PARTIAL`**。KV成本實測
（`test/pbsDebugPush.test.js`）：10/30/100筆相異事件/日各花10/30/100次KV
get+put，duplicate零額外寫入，加上既有基線約128/148/218 writes/day，遠低於1,000
上限。

**現狀旗標**：`WINDOWS_LOCAL_EDGE_FILTER = ACTIVE`、`WINDOWS_REAL_DEBUG_PUSH = ACTIVE`、
`CLOUDFLARE_DEBUG_RECEIVER = ACTIVE`、`WINDOWS_TO_CLOUDFLARE_DEBUG_CHANNEL = VERIFIED`、
`WINDOWS_TO_PRODUCTION_BUSINESS_PIPELINE = NOT_STARTED`、`LINE_INTEGRATION =
NOT_STARTED`、`CCTV_INTEGRATION = NOT_STARTED`、`PBS_CLOUDFLARE_POLLING_RETIREMENT =
NOT_STARTED`、`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PARTIAL`。

服務區誤收修正、CLEARED 二輪確認治理、Windows 常駐/Secret 治理教訓（含一次真實
503 事故與根因）、race condition 分析、KV 成本量化、Emergency kill switch、六階段
路線圖（Phase 1-6 已於 V1.9.8 全數完成，見上方） → 完整記錄於
`07_KNOWN_ISSUES.md`；機器可讀欄位於 `SYSTEM_STATE.json` 的
`pbsLocalEdgeFilterPrototype`。**（歷史記錄——此處「不要 merge feature
branch／不要退休輪詢／不要開始 V1.9.8」等禁令已被上方 V1.9.8 段落取代，
現行禁令請見上方 V1.9.8 段落結尾。）**

## Next action

{{NEXT_ACTION}}

## Full history location

| 內容 | 位置 |
|---|---|
| 完整工程歷史（未縮減，Source of Truth） | Repo `PROJECT_HANDOFF.md` |
| 雲端分段歷史（非 canonical，按需閱讀） | `_history/`（見該資料夾內 `_history/00_INDEX.md`） |
| 設計決策全文 | `04_PRODUCT_DECISIONS.md` |
| 逐 commit 歷史 | `git log` |
