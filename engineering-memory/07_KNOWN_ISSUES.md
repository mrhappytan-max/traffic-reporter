<!-- title: 已知問題 -->

# 07. Known Issues

## 已知、無關、既有的測試失敗基準線

**實測基準（2026-08-26，V1.9.3 施工後重新量測，非回憶）：`npm test` 共 1339 項，穩定 35 項失敗。**

> **V1.9.2 更新**：舊基準第 3 類（`test/healthQuotaDashboard.test.js`，3 項，測的正是
> 隨 TDX Usage Summary 退休而移除的 UI）已整份刪除，非回歸；同輪新增
> `test/kvWriteOptimization.test.js`（38 項），故 1272 → 1300。**V1.9.3**：新增 17 項
> （`pbsSchedule.test.js`／`pipelineTraceNoRelevantChange.test.js`／
> `kvWriteQuantificationV193.test.js`／既有檔案內個別新增），1300 → 1339，35 項失敗數不變。

> **CCTV_METADATA_RECOVERY_V1（2026-08-25）根因更正摘要**：先前誤記為「Workers-only
> `.wasm` codec 沙盒無法載入」，**實為** `@jsquash/jpeg`（`package.json` 正式依賴）未
> 安裝於此沙盒 `node_modules`；`npm install` 後 12 個 CCTV/JPEG 測試檔案全部可執行，
> 揭露約 36 項因此長期被跳過、實為**過期斷言**（斷言後來已刻意改掉的行為，如
> `DYNAMIC_SHOULDER_PUSH=OFF` 後仍期待推播）的既有技術債，非本輪回歸。教訓：合理但未
> 經驗證的 Root Cause 會靜音真實訊號——當時該做而沒做的一步只是 `npm install`。

目前 35 項的正確分類（每輪仍以同一輪 `git stash -u` 對照乾淨 checkout 驗證）：

1. `pbs-relay/tests/*`（2 項）— `pbs-relay/src/server.js` 匯入的 `pbs-relay/src/cache.js` 不存在於 repo。
   獨立子系統，非本 Worker 主程式。
2. **過期斷言（33 項）**— 見上方更正框。分布於 `singleCctvBudgetFairness`、`dynamicShoulder`、
   `dynamicShoulderMessageShort`、`dynamicCollage`、`broadcastCctvIntegration`、
   `cctvPrepareTimeoutStages`、`freeway3CctvAudit`、`pipelineTraceIntegration`、
   `productionIntegrationFixtures`、`hsinchuCctvCollageEndpoint`、`cctvImagePublish` 等檔。
   **這是本專案目前最大的一筆技術債，已列為 openFollowUp。**

若出現這 35 項以外的新失敗，才視為真正回歸。

**還有一項會時有時無的全套執行雜訊**（不是本專案缺陷、也不要為它改程式）：
`test/deploymentStatus.test.js` 的「missing/placeholder build metadata」在
**單獨執行時穩定通過 22/0**，只有在跑完整套件時偶爾出現，乾淨 checkout 也一樣。
本輪連續量測 4 次得到 38／38／38／39，多出來的那次就是它。
判斷回歸請以**同一輪 stash 對照**為準，不要只看單次總數。

**另有一個會自行復原、不要誤判成缺陷的情況**：
`test/deploymentPolicyAndVerify.test.js` 第 12 項比對 `origin/main`（見
`scripts/verify-production-deploy.mjs:120`）。本機 main 已 commit 但**尚未 push** 時，
它必然失敗；push 完成後自動恢復通過。這是「還沒推送」的狀態產物，不是程式缺陷，
**不要為它修改任何程式**。

## V1.8.7.7 — Real-world Confirmation Pending（目前最重要的未結案項目）

**狀態：`AWAITING_REAL_WORLD_CONFIRMATION`。** CCTV 灰色破圖修復（`extractFirstJpegFrame` marker-aware 解析）已完成、已測試（12 項新測試 pass，含修復前失敗/修復後通過的雙向驗證）、已 merge main（`a3d6609`）、已 deploy（push 觸發 Cloudflare auto-deploy）、已封版（`8e10a7a`）。**尚未**取得下一筆真實動態路肩事件的 LINE 圖片正常顯示的現場證據——執行本輪修復的 session 本身無 Production 網路存取權限，無法自行驗證。

**任何未來 session 若取得證據**（正面或負面），只需要更新 `ENGINEERING_STATUS.md` 與 `PROJECT_HANDOFF.md` §35 的狀態欄位為 `REAL_WORLD_CONFIRMED`（附上證據來源），**不需要**開新的修復版本，除非證據顯示修復本身有缺陷（此時視為新事故，重新走 root cause 流程，不要假設是「修得不夠完整」而直接補丁）。

## KI｜TDX 額度用盡 — 暫時 PBS-ONLY MODE（2026-08-23，**生效中**）

- **狀態**：`ACTIVE_TEMPORARY_QUOTA_PROTECTION`。這是**刻意的暫停，不是故障，也沒有刪除任何 TDX 功能**。
- **起因**：TDX API 額度已用盡。若持續呼叫，只會不斷產生失敗請求，無法取得資料。
- **現在的資料來源**：警廣 PBS 單一來源 → 既有分類／格式化／Shared Traffic Feed → 下游 Consumer。PBS 行為完全未變更。
- **開關**：`wrangler.jsonc` 的 `TRAFFIC_SOURCE_MODE`。目前值 `PBS_ONLY`。
  實作在 `src/traffic/sourceMode.js`（純函式，可單元測試）。
- **實際被關掉的三個點**：
  1. `scheduled.js` — 新狀態 `tdxScheduleState='disabled-quota'`，走既有的 skipped-tick 路徑（`buildSkippedTdxSummary`）。刻意用獨立狀態值，避免被誤讀成 TDX 故障或一般跳過的奇數分鐘 tick。
  2. `tdx/auth.js` — 關閉時**拒發 TDX token**。所有 TDX 呼叫都需要 token，所以「零 TDX 呼叫」是程式層保證，不是靠每個呼叫端記得檢查旗標。丟 `TdxAuthError`，呼叫端本來就當成「這輪沒有 token」處理。
  3. ~~`cctv/dynamicCollage.js`~~ — **2026-08-23 已解除**，見下方「CCTV 重新開啟」。CCTV 從來就不消耗 TDX 額度，關掉它一點額度都沒省下。
- **重要事實（未來判讀用）**：CCTV **影格**來自 `*.freeway.gov.tw`，**不是 TDX**；播報路徑的攝影機 metadata 讀的是 KV 快取，也不呼叫 TDX。**所以 CCTV 補圖原本就已經是 0 次 TDX 呼叫**。
- **降級行為**：PBS 事件沒有 CCTV 時，仍正常產出完整文字產品；Cron 不會失敗，Shared Feed 不會失敗。沒有任何 CCTV 問題可以擋住 PBS 播報。
- **可觀測性**：`/health` 有 `sourceMode` 區塊；每輪 log 一行 `[cron][source-mode] trafficSourceMode=… tdxRuntimeEnabled=… cctvImageEnabled=… tdxCctvMetadataRefreshEnabled=… pbsEnabled=… linePushPolicy=… dynamicShoulderPush=…`。
- **旗標語意**：只有精確值 `PBS_ONLY` 會關閉 TDX；缺漏或無法辨識的值一律解析為 `ALL`（正常全來源），所以少設一個 var 永遠不會把 production 餓死。無法辨識的非空值會大聲 log 警告——因為相反的失敗（打錯字導致繼續燒額度）才是會花錢的那個。
- **已知限制**：`/debug/tdx`、`/admin/cctv-*` 這些**人工** admin 端點仍然存在。它們現在會因為拿不到 token 而失敗（不會燒額度），但這是副作用而非設計目標；本輪只保證「Cron／scheduled pipeline 的 TDX 呼叫為 0」。
- **還原條件與方式**：見下方「TDX 還原程序」。

## 封版紀錄｜TDX_QUOTA_PROTECTION_PBS_ONLY = SEALED（2026-08-23）

本任務已由真人正式封版。**下一個 Agent 不需要接手、不需要補做、不需要重新部署。**

**已完成**

- 工程修改完成：`TRAFFIC_SOURCE_MODE=PBS_ONLY` 閘門，10 項專用回歸測試全數通過。
- 已 push `main` 並觸發 Cloudflare Workers Builds 正式部署。
- 全套測試 1060 項 / 17 項已知失敗，與乾淨 checkout 相同，非回歸。
- Google Drive 工程記憶已完成 Delta Sync（canonical 10/10，missing 0，duplicate 0）。

**驗證邊界（重要，不要誤讀成待辦）**

- 執行本輪的沙盒 session 對 Production 網域的 outbound HTTPS 被環境 egress proxy 回 403，因此 `npm run verify:production` 結果為 `PASS_NETWORK_VERIFICATION_BLOCKED`。
- **未執行**真人 `/health` 實機確認（亦即「線上 `trafficSourceMode` 確實為 `PBS_ONLY`」這件事，在本 repo 內沒有一手證據）。
- 真人已明確裁示：**此項不構成 blocker，也不影響封版**。
- 未來若有需要，可另行查證（開 `/health` 看 `sourceMode` 區塊即可），但那是選擇性的補充證據，不是未完成的工作。

**這一段之所以寫得這麼細**：是為了讓未來的 Agent 能分辨「沒有證據」與「有反面證據」。目前狀態是前者。若日後真的取得反面證據（`/health` 顯示 `trafficSourceMode` 不是 `PBS_ONLY`），那是**新事故**，要重新走 root cause 流程，不要當成本輪沒做完。

**額度恢復時**：不需要新版本、不需要重新設計，直接套用下方既有的 RESTORE TDX 程序。

## KI｜LINE Push 額度保護 — 重大事故限定主動播報（2026-08-23，**生效中**）

- **狀態**：`ACTIVE_TEMPORARY_PUSH_POLICY`。與 TDX 額度無關，是**第二個**外部額度限制：LINE 官方帳號輕用量方案每月主動 Push 額度有限。
- **目的**：用一個月觀察「重大事故限定」後，主動 Push 是否落在方案額度內。
- **開關**：`wrangler.jsonc` 的 `LINE_PUSH_POLICY`，目前值 `MAJOR_ACCIDENT_ONLY`。改成 `ALL_ELIGIBLE` 即回到先前行為。實作在 `src/traffic/broadcastPolicy.js`（純函式，可單元測試）。
- **閘門位置**：`broadcastPipeline.js` 既有的那一個 eligibility 迴圈，**疊在** `broadcastRules.js` 的 V1.5 白名單之後，而且**只會減少、永遠不會增加**可播事件。V1.5 白名單本身一個字都沒有改。

### 實際採用的「重大事故」判定條件（可驗證版）

```
可播  ⇔  通過既有 V1.5 白名單  AND  type === 'accident'  AND  不是機動路肩事件
```

`type === 'accident'` 不是本輪新發明的判斷，而是既有分類器（`pbs/classify.js` 的 `ACCIDENT_PATTERNS` + 非碰撞異常 override）早就在用的決定。

**為什麼沒有再加一層「必須寫明車道受阻」的關鍵字條件**——這是本輪最重要的一個決定，理由必須留下：

1. 施工令同時要求「會明顯影響道路通行的重大事故」與「不要為了符合文字要求硬猜 severity；若現有 PBS 資料不足以可靠判定，必須使用現有最可信的事故 eligibility 規則」。
2. 本專案**沒有任何 severity 欄位**；PBS 記錄也**沒有任何結構化的 impact 欄位**（`pbs/normalize.js` 只給 road/direction/roadtype/comment）。唯一結構化訊號 `blockedLanes` 是 TDX 專屬，PBS-only 期間永遠不存在。
3. 因此唯一可行的做法只剩「對自由文字做關鍵字比對」。**該版本已實作並經證據否決**：判定「拖吊／回堵 = 重大」而「國道一號南下100公里處發生事故 = 不重大」正是施工令禁止的臆測，而且錯在危險的一側（文字沒寫阻塞的重大車禍會被靜默丟棄）。
4. 結構上也證實了同一件事：該版本讓既有 **47 項**測試失敗，因為它們都以「一筆單純 accident」作為本專案的標準可播事件——等於把 accident 從「這個產品存在的理由」降級掉。

**誠實的缺口**：因此目前「所有通過白名單的 PBS 事故」都會播，比施工令字面的「不是所有 PBS 車禍都 Push」寬。**補救方式不是用猜的**：`resolveRoadImpact()` 仍然會計算並記錄哪些事故確實寫明通行受阻，播出與擋下兩側都記（`policy-major-accident-blocked-lanes` / `policy-major-accident-impact-keyword` / `policy-accident-no-stated-impact`）。一個月後可直接從 `ineligibleByReason` 與 Pipeline Trace 讀出真實比例，再決定要不要收緊成 impact-only——那時是**依數據**改一行，不是再猜一次。

### 機動路肩：停止主動播報，但功能完整保留

- `DYNAMIC_SHOULDER_PUSH = OFF`。OPEN 與 STOPPED 都不進入主動 Push。
- **沒有刪除任何東西**：parser、classifier、resolver、formatter、單鏡頭 CCTV 策略、歷史測試全部原封不動。辨識能力保留，只是暫時不產出主動播報產品。
- 機動路肩有**自己的一條擋下規則**（不是靠「它不是 accident」順便擋掉），這樣未來即使 accident 規則放寬，路肩仍然是關的。

### CCTV 重新開啟（且仍保證 0 次 TDX 呼叫）

- `CCTV_IMAGE = ON_WITHOUT_TDX_REFRESH`。
- **為什麼可以開**：上一輪把 CCTV 綁在 TDX 閘門上，是基於「CCTV 會燒 TDX 額度」的假設，**該假設不成立**。播報路徑的攝影機 metadata 讀 KV 快取（`freewayCctvMetadataCache.js` 自己的註解就寫著 "Read-only, cache-only — NEVER calls TDX"），影格來自 `*.freeway.gov.tw`（公路局，不是 TDX），而 `cctv/dynamicCollage.js` **既沒有 import `tdx/auth.js` 也沒有 import `tdx/client.js`**——0 次 TDX 呼叫是**結構性保證**，不是承諾。
- 所以關掉 CCTV 一點額度都沒省下，卻讓每一則事故都失去圖片。
- **不得為了補圖重新打 TDX**：不可呼叫 TDX API、不可取 token、不可重新下載 TDX CCTV metadata。這條由兩個 CCTV 碰不到的地方守住：`isTdxRuntimeEnabled()` 與 `tdx/auth.js` 在 PBS_ONLY 下直接拒發 token。
- **快取不足時安全降級 TEXT-ONLY**：CCTV 失敗永遠不擋事故、不 throw、不讓 Cron 失敗、不讓 Shared Feed 失敗。CCTV 是加值，不是事故播報的必要條件。

### 對測試的影響（未來讀 test diff 時必看）

有些既有測試是用 construction／closure／other 事件當「載具」去測時間視窗、群聚、抑制、provenance 等**機制**，本身不是在測播報政策。這些測試改為在 env 帶 `LINE_PUSH_POLICY: 'ALL_ELIGIBLE'`，繼續測它們原本要測的機制。**Production 政策行為另外釘在 `test/pbsCctvMajorAccidentOnly.test.js`。** 與乾淨 baseline 比較，本輪新增失敗為 **0**。

## 觀察期｜LINE_PUSH_OBSERVATION = ACTIVE（2026-08-23 起）

```
LINE_PUSH_OBSERVATION = ACTIVE
START_DATE           = 2026-08-23
POLICY               = MAJOR_ACCIDENT_ONLY
MONTHLY_LINE_LIMIT   = 200
```

**這是觀察，不是施工。** 真人已下令停止施工，先看真實數據。目前**不再新增**車道受阻關鍵字、封路 severity、重大程度分類器或任何額外 Push 過濾規則。

- **要確認什麼**：目前「只播通過既有播報資格的 accident」是否能把主動 Push 控制在每月 200 則內。
- **計費月陷阱（最容易誤判的一點）**：LINE 額度按**自然月**重設。觀察起點是 8/23，所以 **8/23～9/22 不是一個計費月**，那段期間的總數不能當成單月用量看。要判斷必須按自然月切（8/23–8/31 只是一個殘月）。
- **證據規則**：只有真人從 LINE 官方後台實際讀到的數字才算 observation evidence。本 repo 看不到 LINE 用量，**不得**用事件數、log 或任何推估去補一個數字上來——沒拿到就是沒拿到。
- **本輪沒有、也不需要建計費系統**：施工令明確排除。
- **決策門檻（由真人判斷，Claude 不得自行提前施工）**：
  - 明顯低於 200 → 維持現行策略。
  - 接近或超過 200 → 由**真人**另開新任務，研究更嚴格的 `ROAD_IMPACT_ACCIDENT`／車道受阻・封閉限定策略。
- **未來要收緊時的依據**：`broadcastPolicy.js` 已經在記錄每一則播出的事故究竟有沒有寫明通行受阻（`policy-major-accident-blocked-lanes` / `policy-major-accident-impact-keyword` / `policy-accident-no-stated-impact`），可從 `ineligibleByReason` 與 Pipeline Trace 讀出。**收緊要用這些真實比例去論證，不是再猜一次。**

## 修正紀錄｜PBS_ONLY 下不得要求 TDX 對應（2026-08-24）

**一句話**：TDX 是**停用**的資料來源，不能反過來拿「沒有 TDX 對應」去擋 PBS。

### 現象（真實 Production 案例，非假設）

Pipeline Trace 出現：來源 PBS、國道一號南向、分類事故
（`normalizedType=accident`、`pbsCategory=accident`），
卻被判為不符播報資格，`gatingResult = 'gated-freeway-no-tdx-match'`，
UI 顯示「國道閘門（無 TDX 對應）」。

### Root cause

`src/pbs/crossSourceDedup.js` 的 **V57.2「TDX 唯一播報閘門」**。
原始設計：PBS 國道事件若當輪沒有 TDX 對應，就不當作獨立播報候選，
**等更權威的 TDX 報告來決定**。這個理由**只有在 TDX 有在跑時才成立**。

`TRAFFIC_SOURCE_MODE=PBS_ONLY` 下 TDX 已關閉，**永遠不會有 TDX 事件出現**，
於是「等 TDX」實質變成「永遠不播」——一個**已停用的資料來源否決了唯一還在運作的來源**。
閘門問錯了問題：它問「有沒有發生對應」，該問的是「對應**有沒有可能**發生」。

### 修正方式（bypass，不是刪除）

```
crossSourceDedup(pbsEvents, tdxEvents, { requireTdxCorrelationForFreeway })

requireTdxCorrelationForFreeway = true   （ALL mode）      → V57.2 原封不動
requireTdxCorrelationForFreeway = false  （PBS_ONLY mode） → 略過閘門
```

- 旗標由 `src/pbs/pipeline.js` 以 `isTdxRuntimeEnabled(env)` 導出——
  **與關閉 TDX 的是同一個開關**，兩者不可能各說各話。
- `crossSourceDedup` 維持純函式（只讀旗標，不讀 env），可獨立單元測試。
- **預設值為 `true`**：未來若有呼叫端忘記傳，會退回較保守的既有行為，
  絕不會靜默放寬播報範圍。
- `TRAFFIC_SOURCE_MODE` 改回 `ALL`，V57.2 立即完整恢復，不需要再改任何一行。

### 沒有放寬播報政策

略過閘門**只是讓 國道 PBS 事件能進入候選清單**。
之後的 eligibility、事故限定 push policy、時效視窗、去重、抑制**全部照舊生效**。
因此機動路肩與所有非 accident 類型**仍然不播**（已由測試釘住）。

### CCTV 的地位（再次確認）

CCTV 是**附加資訊，不是播報資格**。
符合資格的 PBS 事故：有圖 → 文字＋圖片；無圖／metadata 不足／影格失敗 → **TEXT-ONLY 照常播報**。
**禁止**因為沒有 CCTV 而拒絕事故播報。CCTV 仍為 0 次 TDX 呼叫。

### 可觀測性

- PBS summary 新增 `tdxCorrelationRequired`、`eligibilitySource`（`PBS` / `PBS+TDX`）。
- Cron log 的 source-mode 行新增 `tdxCorrelationRequired=`。
- 這樣 `freewayGatedCount = 0` 讀起來是「**依設計略過**」，而不是「剛好沒有東西被擋」。
- PBS_ONLY 下不會再產生 `gated-freeway-no-tdx-match` 的 trace 項目，
  「國道閘門（無 TDX 對應）」自然不再出現（該 UI label 本身未刪除，ALL mode 仍會用到）。

### 給未來 Agent 的通則

**任何「等待另一個來源佐證」的閘門，都必須先問那個來源是否還活著。**
否則資料來源一旦停用，這類閘門就會從「延後」變成「永久否決」，而且**不會報錯**——
它會安靜地讓事件消失。本專案已知只有 V57.2 這一處，修正時一併搜尋過。

## 修正紀錄｜服務區域閘門（八堵事件）（2026-08-24，壓縮摘要）

**一句話**：`PBS_ONLY` 不等於「全台 PBS 都能播」。地域資格永遠要檢查。真實漏播
案例：PBS 國道1號南向八堵交流道（基隆，25.10288/121.71801，type=accident）
不在服務區域內卻成功推播。Root cause：地域過濾只存在於 PBS 進料端
（`pbs/pipeline.js` 的 `isPbsEventHsinchuRelevant` filter），`broadcastPipeline.js`
只在 JSDoc 寫著假設「every currently Hsinchu-relevant … event」，從未真正檢查
——寫在註解裡的假設不是閘門。無法用手上資料重現進料端本身的漏洞（各種原始記錄
形狀跑 `isPbsEventHsinchuRelevant` 皆正確擋下），本輪修正的是「Producer 播報
邊界上本來就該有、卻不存在的強制檢查」，非修補已重現的洞。修正：新增
`src/traffic/serviceArea.js`，在既有 eligibility 迴圈最前面檢查，所有 source
mode 都適用，重用既有 canonical 判定（`hsinchuFilter.js`），無新地理引擎、
服務範圍未變。PBS 對此 fail-closed（無法定位就擋，因為地理資訊已一路帶到播報
層，能重跑進料端同一函式）；TDX 只在能明確判定「在區域外」時才擋（因
`tdx/normalize.js` 不保留原始 `Positions`，fail-closed 會靜默丟掉正常 TDX
事件——實測讓 35 項既有測試失敗，故不採此法）。`SERVICE_AREA_ELIGIBILITY_
REQUIRED = true` 永遠適用於所有模式，與 `TDX_CORROBORATION_REQUIRED` 永久
獨立。可觀測性：`eligibilityReason` 新增 `outside-service-area`，Pipeline
Trace 新增 `serviceAreaEligible`。**永久教訓**：只在一個地方做過濾等於沒有
保證——某一層的正確性若依賴「上游應該已經過濾過了」，就要嘛在本層真的檢查，
要嘛讓上游在事件上留下可驗證的標記；寫在註解裡的假設遲早會被某條新路徑繞過，
而且不會報錯。

## 修正紀錄｜播報追溯斷點 ＋ 位置精確度閘門（台68 事件）（2026-08-24，壓縮摘要）

真實症狀：PBS 主動 Push 印出「（南寮竹東）-台68線」（PBS 對整條路線的官方名稱，非地點，
南寮0.4K～竹東22.9K）——位置不可行動；且事後在 Pipeline Trace 查不到該筆。Root Cause
兩個：(A) `x1`/`y1` 座標在 `pbs/normalize.js` 有保留但**顯示側從未讀取**，`resolveKmLocation()`
只從 KM 出發、PBS 沒有結構化 KM，故「有精確座標」與「完全沒有位置」訊息逐位元組相同；
(B) trace 確實有寫入，斷點全在讀取側——`road` 篩選嚴格相等但畫面顯示的是「台68線」、
trace 存的是正規化後的「台68」；同輪 entry 靠隨機 opaqueId 排序，可能被擠出第一頁；
掃描上限與「不存在」回報成同一件事。修正：新增 `kmLocationResolver.js#resolveCoordinateLocation`
（KM 查詢的反向版本，同一份官方資料集，容差0.5公里）在完全沒有 KM 時才呼叫；新增
`traffic/locationQuality.js` 閘門（服務區域與事故政策之後、時間/dedupe/suppression之前），
判定層級：結構化KM＞displayKM＞座標(可靠轉換)＞訊息會印出的地點文字，刻意不看
`description`（畫面不會印的欄位不能拿來證明「夠精確」）；不足時 `eligible=false`，
`reason=insufficient-location-precision`，仍保留在 Pipeline Trace。三道閘門永久獨立：
`TDX_CORROBORATION_REQUIRED`／`SERVICE_AREA_REQUIRED`／`LOCATION_QUALITY_REQUIRED`——
任何一個都不得被另一個取代或推論（八堵那筆即使位置精確仍須被服務區域擋下）。
追溯側同時修正：`road` 篩選改用正規化函式比對、新增關鍵字搜尋、key 加批次序號穩定排序、
掃描未涵蓋全部時明講。新增 `test/pbsAccidentTraceLocationQuality.test.js`（25項全通過）。
NEW FAILURES=0（1060項，17項既有失敗不變）。通則：閘門判準必須與訊息真正顯示的內容一致；
「查不到」與「沒發生」是兩件事，任何有上限的掃描都必須把上限講出來。

## 修正紀錄｜PBS 國道事故取不到 CCTV（國3 96K+700 事件）（2026-08-25，壓縮摘要）

真實症狀：國3南向96K+700事故，Pipeline Trace每一關皆綠燈（服務區域/位置精確度/eligibility/
LINE推播全部PASS）但`cctvEligible=否`、`cctvSkippedByReason`空白——駕駛收到正確文字卻無圖，
後台說不出原因。Root Cause三個：(A) `dynamicCollage.js#resolveCctvEligibility` 殘留
`event.source!=='freeway'`的TDX-only閘門，PBS_ONLY模式下等於「PBS事故永遠沒有圖」；
(B) `eventTargetKm()` 只讀結構化KM（PBS從來沒有），即使解除A仍會停在`no-reliable-km`；
(C) eligibility階段被擋下時reason從未寫進trace，只留`cctvEligible=false`——這正是「空白理由」
能藏一整天的原因。修正（最小、fail-closed）：(1) 來源改為可信來源白名單
`CCTV_TRUSTED_EVENT_SOURCES={freeway,highway,pbs}`，reason改`unsupported-source`，仍是白名單
不是開門；(2) `eventTargetKm()`新增第三層`displayKM`（PBS comment內經`pbs/normalize.js`嚴格
parser解析出的公里數，且已先通過`locationQuality.js`驗證精確度，不是新猜測）；(3) eligibility
reason一律寫進trace，新增`cctvTargetKm`。永久原則：**CCTV資格取決於「道路可解析+公里數可靠」，
不取決於通報來源**。CCTV-supported roads仍僅國1/國3（RoadID已由Production驗證），未新增任何
未驗證省道。邊界（皆有測試鎖住）：TDX全程0呼叫（有結構性測試斷言不import tdx/auth.js）；
CCTV是enrichment非eligibility，三道播報閘門完全未動（八堵事故仍被服務區域擋下）；任何步驟
失敗一律退回TEXT-ONLY。通則：資料來源被關閉時，要搜尋所有「以來源為條件」的判斷式——它們
不會報錯，只會安靜讓整條路徑永遠不成立；後台「空白理由」是bug不是畫面。

## 治理變更紀錄｜DRIVE_SYNC_GOVERNANCE_V2（2026-08-25）

**這一輪沒有改任何產品程式。** 它改的是「版本資料怎麼進到雲端」這件事本身。

### 舊流程（已退休）

每次封版時，Claude 直接用 Google Drive Connector 把 changed files
逐檔上傳、逐檔 byte 驗證、把舊檔移進 `_archive_<sha>`。

### 為什麼退休

**不是因為它不正確**——它確實有效，也確實每次都完成了同步，
之前每一輪記錄的 `Google Drive Delta Sync = PASS` 都是真的。

退休的理由是**成本**：Agent 後台逐檔上傳佔用大量流量、速度慢、
佔用執行時間、拉長每一次封版、增加 Agent 成本。
一份 39KB 的 07_KNOWN_ISSUES.md 要整份重打並上傳一次，
這件事本身比它承載的資訊量貴得多。

### 新流程（唯一正式路徑）

```
Claude 修改產品 / Engineering Memory
   ↓
Git commit
   ↓
GitHub（branch / main）
   ↓
GitHub → Google Drive Sync
   ↓
Google Drive 工程記憶
```

```
CLAUDE_DRIVE_READ  = ALLOWED
CLAUDE_DRIVE_WRITE = FORBIDDEN
```

- **GitHub** = CODE SOURCE OF TRUTH ＋ ENGINEERING MEMORY WRITE SOURCE
- **Google Drive** = READABLE ENGINEERING MEMORY MIRROR
- 永久順序：**GitHub first, Drive second**

Claude 只負責「把該同步的內容正確寫進 GitHub」，不負責搬檔案到 Drive。

### 三個狀態必須分開講

```
GITHUB_ENGINEERING_MEMORY   本次記憶是否已 commit 進 GitHub
GITHUB_TO_DRIVE_SYNC        GitHub 端是否已同步到 Drive
CLAUDE_DRIVE_UPLOAD         Claude 是否直接寫入（生效後永遠 NO）
```

舊的 `MEETING_ROOM_CLOUD_SYNC = PASS` 已棄用——它沒說「是誰同步的」。

### 自動同步還沒好時怎麼標

**不得**為了讓 Drive 看起來是最新版而人工補上傳。誠實標：

```
GITHUB_SEAL               = PASS
GITHUB_ENGINEERING_MEMORY = SEALED
GITHUB_TO_DRIVE_SYNC      = PENDING
CLAUDE_DRIVE_UPLOAD       = NO
```

然後停止。**把 PENDING 硬補成 PASS 是假報**——
同步延遲只是慢，假報會讓未來所有人相信一個不存在的狀態。

### 本輪就是這條規則的第一次實踐（而且結果和預期不同）

下這道治理令時，GitHub → Drive 自動同步被認為尚未建置，
所以預期的結果是 `GITHUB_TO_DRIVE_SYNC = PENDING`。

**實際情況不是這樣。** 推送時發現 `origin/main` 已經前進了三個 commit——
真人在同一時間、平行地把自動同步做好了：

```
.github/workflows/sync-engineering-memory.yml   push 到 main 且動到 engineering-memory/** 就觸發
scripts/syncEngineeringMemory.mjs               同步腳本
scripts/drive-sync-manifest.json                要同步的 10 個 canonical 檔案
test/syncEngineeringMemory.test.js              測試
```

認證用 GitHub OIDC + Google Workload Identity Federation 短效憑證，
不建立長期 Service Account JSON key。同步語意是
missing → create、changed → update、unchanged → skip，**不自動刪除** Drive 上其他檔案。

處理方式：**merge，不 rebase、不 force push**。兩邊在實質上完全一致——
真人做的是機制，本輪寫的是規則。

**推送後以唯讀方式實測確認**（不是假設）：
Drive 上 10 份 canonical 檔案的 modifiedTime 全部是 2026-08-25T07:44，
且每一份的 byte size 與本機 `engineering-memory/` 逐一相符。
所以本輪最終狀態是：

```
GITHUB_SEAL               = PASS
GITHUB_ENGINEERING_MEMORY = SEALED
GITHUB_TO_DRIVE_SYNC      = PASS   ← 實測，非假設
CLAUDE_DRIVE_UPLOAD       = NO     ← 本輪 0 次 Drive 寫入呼叫
```

本節初稿曾寫 `PENDING`（當時屬實），在實測到 PASS 之後才更正。
**這條規則是雙向的**：不得把 PENDING 報成 PASS，
也不得在 PASS 已可證實之後still 留著一個過期的 PENDING。

### 一個尚未解決的結構問題（本輪刻意不自行決定）

現在有**兩棵樹**放著同一份 canonical 內容：

| 目錄 | 誰在維護 | 誰在讀 |
|---|---|---|
| `engineering-memory/` | 目前靠手動同步 | GitHub Actions → Drive mirror（`drive-sync-manifest.json`） |
| `meeting-room-export/` | `scripts/export-meeting-room.mjs` 產生 | 無自動消費者 |

本輪把新治理內容同時寫進兩邊，讓它們一致。
但「靠人記得同步兩棵樹」正是這套治理要消滅的漂移風險。

需要真人裁決：**把 export 產生器直接指向 `engineering-memory/`，或退休其中一棵樹。**
本輪不自行決定，因為那是結構調整，而且真人此刻正在這個區域施工。

另外注意：`engineering-memory/00_CURRENT_STATE.md` 結尾有一段
**不是 export 產生器產出的**「Engineering Memory 同步治理」段落（真人手寫）。
本輪更新該檔時是先從 `origin/main` 讀出那一段、原文保留後才覆寫其餘內容。
**未來任何人要覆寫這個檔案之前，請先確認那一段還在。**

### 歷史紀錄怎麼處理

先前所有由 Claude Connector 完成的同步紀錄**全部保留、不改寫成失敗**，
只補上身分標記：

```
LEGACY_CLAUDE_CONNECTOR_SYNC = RETIRED
```

它們當時真的完成了；只是那個機制以後不再使用。

### 同時生效的封版節奏規則

```
ONE TASK → ONE CLOSEOUT → ONE SEALED STATE
```

任何 Bug／功能／架構更動完成後不得直接開始下一件，必須先走完
tests → NEW FAILURES = 0 → commit → main → 必要 deploy →
Engineering Memory → GitHub push → 確認同步狀態 → SEALED →
Current Task = none → STOP。

禁止「A 還沒封版就開 B，然後回頭又改 A」——那正是
main／Drive／Agent 記憶三邊版本漂移的成因。

### 本輪一併修掉的一個「會叫下一個 Agent 違規」的地方

`scripts/finalize-release.mjs` 原本在結尾印：

```
GOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED
(The Claude Agent session must now perform the real Connector sync itself...)
```

那段文字會**主動指示**下一個 Agent 去做現在已被禁止的事。
已改成印出新的治理狀態與「只寫 GitHub」的指示。
（只改輸出文字，沒有實作任何自動同步。）

**通則**：改規則的時候，要把「會叫人違反新規則的舊指示」一起找出來改掉；
留著一句與規則相反的提示，等於沒改。

## 修正紀錄｜CCTV 名冊 7 天過期死結（國1 93K 事件）（2026-08-25，壓縮摘要）

真實事件：2026-08-25 19:01 國1 93K事故，LINE文字正常推播、完全無圖片，
`cctvSkippedByReason=metadata-cache-unavailable`。Root Cause（三環節缺一不可）：
(1) 攝影機名冊KV key寫入時帶 `expirationTtl=7天`；(2) 唯一寫入者是TDX側的Admin-Auth
管理探針；(3) 該探針在`TRAFFIC_SOURCE_MODE=PBS_ONLY`下無法執行（`tdx/auth.js`拒發
token）——探針最後一次執行滿7天後名冊被KV自動刪除，且沒有任何被允許的路徑能補回。
這是分類錯誤：影格(frame)是易變資料本來就不快取，名冊(inventory)是準靜態參考資料，
對「沒有保證補回路徑」的資料設定計時過期=把「有點舊」變成「完全沒有」。修正三件事：
(1) 不再設expirationTtl，key永久存在；(2) 寫入只能升級不能降級（空/格式錯誤的record
set一律拒絕`refused-empty-record-set`，沒有任何路徑能刪除名冊）；(3) **內建官方名冊
做為地板**——`data/cctv/generated/freewayCctvInventory.js`打包交通部NFB open data
靜態名冊1943筆（國1 510筆、國3 728筆），即使KV完全空也一定拿得到可用清單，恢復在
deploy當下自動發生、不需對Production KV做任何寫入。以完全空的KV重跑19:01事件驗證：
四格全中。成本：Worker bundle +77KiB（用掉約27%上限）；TDX呼叫數=0；未新增任何
未驗證道路（`CCTV_SUPPORTED_ROADS`仍僅國1/國3）。名冊中一筆非freeway.gov.tw主機的
紀錄（台64，`cctv-ss02.thb.gov.tw`）已確認安全：兩道獨立屏障（不在`CCTV_SUPPORTED_ROADS`
+ `isTrustedImageUrl`發request前fail-closed）。`/health`新增攝影機基礎資料卡片
（來源/筆數/日期，永不含stream URL）。名冊更新程序：`npm run build:cctv-inventory`
或`node scripts/build-cctv-inventory.mjs <新XML>`（寫檔前自我驗證，任一項不過即中止）。
不要誤讀：不要把expirationTtl加回去；不要為取得名冊重開TDX；不要新增未驗證道路；
不要手動編輯生成檔。

## 治理變更紀錄｜正式版本線校正（PRODUCTION_VERSION_LINEAGE_RECONCILIATION）（2026-08-25）

### 發現了什麼

表層問題是「V1.8.7.7 之後有 7 次 Production 更新沒配版本號」。
查下去發現底下還有一層更嚴重的：

**唯一權威來源 `src/version.js` 自 2026-08-21 的 V1.8.6.9 之後從未被更新過。**

也就是說，整個 V1.8.7.0～V1.8.7.14 期間，`GET /version` 一直回報 **V1.8.6.9**。
它對「部署了哪個 commit」講的是實話，對「部署了哪個版本」講的是兩個月前的舊話。

### Root Cause

不是一次疏忽，是**三個地方各自以為自己知道版本**：

| 來源 | 當時的值 | 餵給誰 |
|---|---|---|
| `src/version.js` 的 `APP_VERSION` | `V1.8.6.9` | `GET /version`、`/admin/deployment-status` |
| export 掃 commit message 找最新 `V\d+\.\d+\.\d+` | `V1.8.7.7` | Engineering Memory（SYSTEM_STATE、00、02…） |
| `ENGINEERING_STATUS.md` 人工標記 | 各自為政 | 人看的文件 |

**從 commit message 掃出來的版本號，是沒有人負責的版本號**——
有人剛好在標題打了就會動，沒人打就默默停住。這正是它停在 V1.8.7.7 的原因。

### 修正

1. **`src/version.js` 確立為 ONE CANONICAL VERSION SOURCE**，`APP_VERSION` 校正為 `V1.8.7.14`。
2. **`scripts/export-meeting-room.mjs` 改讀 `src/version.js`**；commit message 掃描降級為
   drift 警告；讀不到權威來源時**直接拋錯**，而不是退回猜測——退回猜測正是釀成三週漂移的那一步。
3. **`06_VERSION_HISTORY.md` 補記 V1.8.7.8～V1.8.7.14**（七列，全部對應既有 commit）。
4. **新增 `test/versionLineage.test.js`（7 項）**，鎖住規則的**形狀**：
   單一來源、其他一律衍生、掃描結果不得再被賦值回版本欄位。
   刻意**不鎖當下的數字**——否則只是多出第四個要同步的地方，等於重造同一個問題。

### 補記，不是重新部署

V1.8.7.8～V1.8.7.14 七次變更**在補記之前就已經 merge 進 main 並自動部署**。
本次只建立「版本號 ↔ 既有 commit ↔ 既有部署」的對照：
**沒有 rebase、沒有 amend、沒有 force push、沒有改 commit timestamp、沒有偽造部署，
也沒有把任何未上線的東西寫成已上線。**

### 永久規則（Release Gate）

- 任何**進 Production 且改變 runtime 行為**的變更，必須在**同一個 commit 內** bump
  `src/version.js` 的 `APP_VERSION`。
- **任務名稱 ≠ 版本號。** `CCTV_METADATA_RECOVERY`、`PBS_ACCIDENT_CCTV_ENRICHMENT_FIX`、
  `TDX_QUOTA_PROTECTION` 都是工程標籤，不能取代版本號。
- **正式產品永遠只有一條連續版本線 `V1.8.7.x`**，不得出現 V1／V2／V57.x／CCTV V1 等平行版本線。
- 開工前先寫 `CURRENT_VERSION` 與 `TARGET_VERSION`，並確認 TARGET 是 CURRENT 的合法下一版。
- 純文件／治理／Drive sync 工具／測試整理**不 bump 版本**，但仍須有 commit。

### 不要誤讀

- **不要在 `src/version.js` 以外的地方宣告產品版本號**——其他地方一律 import 或衍生。
- **不要讓 export 回頭從 commit message 取版本**；`versionLineage` 第 6 項就是在擋這件事。
- **不要把 `package.json` 的 `0.1.0` 當成產品版本**——那是 npm 套件版本，與版本線無關。
- **不要把補記當成新部署**。

## 治理變更紀錄｜三段式版本治理切換（THREE_PART_VERSIONING_TRANSITION）（2026-08-25）

### 正式決議

```
CURRENT_OFFICIAL_VERSION = V1.8.7.14
LAST_FOUR_PART_VERSION   = V1.8.7.14

FOUR_PART_VERSIONING  = RETIRED
THREE_PART_VERSIONING = ACTIVE

NEXT_RELEASE_VERSION = V1.9.0
```

`PRODUCTION_VERSION_LINEAGE_RECONCILIATION` 當時記錄的
`NEXT_RELEASE_VERSION = V1.8.7.15` 由本次決議**取代**為 `V1.9.0`。
V1.8.7.8～V1.8.7.14 既有七列版本記錄**不重寫**——四段式版本線在
V1.8.7.14 就此封存，不追加 V1.8.7.15。

### 永久規則（三段式）

- **Bug fix** → patch：`V1.9.0 → V1.9.1 → V1.9.2 …`
- **明顯新功能／架構階段** → minor：`V1.9.x → V1.10.0`
- **大型不相容版本** → major：`→ V2.0.0`
- **純文件／治理／Engineering Memory／測試整理** → 不升 Product Version，但仍須有 commit

### 這是治理紀錄，不是 release

本輪**只做版本治理紀錄修正**，不占 Product Version。`src/version.js` 的
`APP_VERSION` **維持 `V1.8.7.14`，沒有提前改成 `V1.9.0`**。
只有下一次真正改變 Production runtime 行為的 release，才會在**同一個
commit 內**把 `APP_VERSION` bump 到 `V1.9.0`，同時：
- 更新 `test/versionLineage.test.js` 第 1 項的版本前綴斷言（`'V1.8.7.'` → `'V1.9.'`）
- 在 `06_VERSION_HISTORY.md` 新增 V1.9.0 那一列

未修改任何 CCTV／PBS／TDX／LINE 或其他 Production runtime 程式，未 deploy 功能變更。

### 不要誤讀

- **不要把 `src/version.js` 提前改成 `V1.9.0`**——那要等下一次真正的 runtime release。
- **不要重寫 V1.8.7.8～V1.8.7.14 既有版本列**；四段式版本線原樣保留在歷史裡。
- **不要把這次治理決議當成一次 release**——沒有 commit 觸發功能性部署。

## 修正紀錄｜Quad CCTV Prepare-Timeout 可觀測性（V1.9.0，國3 96K+700 事件）（2026-08-26，壓縮摘要）

2026-08-26 09:20 國3南向96K+700事故：進 Shared Feed 但 withImage=0，CCTV prepare
**完全無 completion log**；09:30 同事件重跑即成功。Root Cause（程式碼確認＋7 項決定性
測試 `test/cctvQuadPrepareForensics.test.js` A-G）：quad（事故）路徑當時**完全沒有 stage
追蹤**（單鏡頭路徑早就有 `stageTracker`），所以任何一次真實外部延遲（frame-fetch／
compose／R2-publish——三者共用同一個 4000ms budget，已用測試證實）在當下都結構性不可見；
09:20 具體慢在哪一段**無法回推**，誠實標記為未知。修正：quad 路徑加上比照單鏡頭路徑的
`stageTracker`，任何結果（成功／失敗／逾時）都留下 metadataElapsedMs／
cameraSelectionElapsedMs／frameFetchElapsedMs／collageElapsedMs／successfulFrameCount／
failedFrameCount／r2PublishElapsedMs／timeoutStage，白名單接入 Pipeline Trace（純數字/短
字串，無 stream URL／frame bytes）。**RETRY_REQUIRED=NO**：未新增 retry／第二輪 fetch／
fallback，4000ms 未變動，純可觀測性修復。「3支已成功等第4支逾時才組圖」的優化本輪**未實作**
（誠實記錄，非本輪範圍）。防死亡螺旋：`MAX_FRAME_FETCH_PER_EVENT=4`／
`MAX_RETRY_PER_EVENT=0`，outer race 保證 Cron 不受背景 straggler 影響（測試 B/C 證實）。
不要誤讀成已查明 09:20 具體延遲來源、或已加大 timeout。

## 修正紀錄｜Pipeline Trace 查修頁篩選失效（V1.9.1，form-action CSP）（2026-08-26，壓縮摘要）

真人在真實手機（iOS Safari）操作 `/admin/pipeline-trace-view`：篩選後畫面完全
不跟著變。Root cause（真實 headless Chromium 對著真實部署重現，非猜測）：
`applyAdminSecurityHeaders` 的 CSP 帶 `form-action 'none'`，任何強制執行 CSP
的瀏覽器都會完全拒絕頁面上任何 `<form>` 送出——伺服器端每一層（表單標記/
query string/filter predicate/分頁）前一輪（V1.8.7.6）已查證全部正確，但那一
輪的 headless 瀏覽器重現不在本 repo 測試套件內，從未真正撞見這個指令擋下點擊
的那一刻。修正：`form-action 'none'` → `'self'`（同源表單仍可送出，CSP 其餘
指令未動），`DEFAULT_LIST_LIMIT` 30→60（`MAX_LIST_LIMIT`/`MAX_ENTRIES_SCANNED`
不變）。伺服器端篩選邏輯本身零改動——V1.8.7.6 已證實全部正確。**永久教訓**：
不要把 `form-action` 改回 `'none'`；不要放寬到 `'*'`；不要把 Playwright 加成
正式相依套件（CI 覆蓋改用不需瀏覽器的 CSP 標頭字串斷言）。

## 修正紀錄｜Cloudflare KV Write Optimization ＋ TDX Usage Summary 正式退休（V1.9.2）（2026-08-26，壓縮摘要）

真實 Cloudflare 帳號告警：Writes 749/1,000（`traffic-reporter-kv`=733，佔帳號總寫入量97.9%）。
四項變更：(1) `traffic:shared-feed`／`line:incident-suppression-state` 改為 WRITE_ON_CHANGE
（新共用原語 `src/util/contentEqual.js`），內容決策邏輯完全不動，只改「何時寫入」——施工中
自己的測試抓到一個真實 aliasing bug（`resolveIncidentNotifications` 就地修改比對用的舊物件，
導致比較永遠「相等」），已用 `structuredClone` 在呼叫前先拍快照修正；(2) Pipeline Trace 改為
每輪一把 `debug:pipeline-trace-batch:v2:*` 批次金鑰，取代舊制一筆事件一把 key——舊制
`debug:pipeline-trace:v1:*` 完全不刪除不遷移、靠 24h TTL 自然過期，`listPipelineTrace` 已能
正確合併新舊两種schema，兩個既有 admin 讀取 handler 未改一行程式碼（V1.9.4 後續再優化其讀取
效能，見該輪條目）；(3) **TDX Usage Summary 正式退休**（人類決策，非優化）：`tdx:usage:summary:v1`
與底層 `tdx:usage:entry:v1:*` 帳本皆確認除了餵已退休的儀表板外無其他讀者，改為 0 writes/day，
`/health` 的用量卡片改為指向 TDX 官方後台的靜態提示，TDX 本身（API client／OAuth／RoadEvent／
CCTV metadata／source mode／9-1 額度恢復路徑）完全未動；(4) 新增 `[kv-write-budget]` Cron
console.log（僅 Workers Logs，未新增 KV key）。量化估算：QUIET/MEDIUM/HIGH 每輪約
1-4／4-8／4-8 writes（原本約 11-21／19-20／29-30）。新增 38 項測試（`test/kvWriteOptimization.test.js`）。
NEW FAILURES=0（1300 項，35 項既有失敗不變）。不要誤讀成刪除了 TDX 程式碼或改變了資料決策邏輯。

## 修正紀錄｜KV Write Optimization Phase 2（V1.9.3）（2026-08-26）

延續 V1.9.2，關三個剩餘來源：(1) `health:snapshot:v1` 改 WRITE_ON_CHANGE，除既有
`*.lastFetchedAt` 外新排除 `scheduledThisRun`/`sleeping`/整個 `broadcast` 區塊（決定性
fixture 跑滿一天才抓到：漏排除會讓安靜日仍寫 63 次）；(2) PBS 固定抓取改每 30 分鐘、僅
07:00–22:00（`pbsSchedule.js`），施工前已核對既有生命週期規則皆為 wall-clock，無 STOP
理由；(3) Pipeline Trace 新增 `NO_RELEVANT_CHANGE`，無關事件時整批跳過寫入，TDX 重複／
PBS 閘門排除仍視為有意義。fixture 實測 QUIET/NORMAL/HIGH writes/day = 5／21／27，遠低於
目標。NEW FAILURES=0（1339 項）。完整記錄 → `SYSTEM_STATE.json.taskSeal`；版本列 →
`06_VERSION_HISTORY.md` V1.9.3。

## 修正紀錄｜Windows → Cloudflare Debug-only Push Endpoint（V1.9.5）（2026-08-27）

新增 `POST /internal/pbs-debug-push`（`src/pbs/debugPush.js`＋`src/pbs/debugPushAuth.js`）。本輪只證明一條鏈：Windows PBS Local Monitor 發出最小事件 payload → Cloudflare 驗證身份 → 驗證資料格式 → 做冪等判斷 → 寫 Workers Logs → 回 ACK。**`WINDOWS_PUSH_ENABLED = NO`**——本輪未讓 Windows 真的發送任何真實事件，也**未**整合進正式 Pipeline／Production PBS 接管，只建立接收端。

**身份驗證**：獨立 Secret `PBS_DEBUG_PUSH_SECRET`，`Authorization: Bearer <secret>`（沿用 `traffic/sharedFeedHandler.js` 既有的 `TRAFFIC_FEED_SECRET` header 慣例，而非發明第三種），以雜湊後常數時間比對驗證（與 `security/adminAuth.js` 的 `credentialMatches` 同技術，非單純 `!==`）。專門測試證實**不會**回退到 `PBS_RELAY_TOKEN`（既有、不相關的 Cloudflare→Windows PULL 憑證）、`ADMIN_PASSWORD`，或任何 LINE／TDX secret——即使呼叫端剛好用了其中一個當作 token 也一律 401。secret 未設定 = 503（fail closed，與 `TRAFFIC_FEED_SECRET` 同樣的「未設定是維運問題」區分）；token 缺失或錯誤 = 401。secret 本身確認不出現在 Workers Logs 或任何 response body（專門測試鎖定）。

**Payload Schema**：必填 `generatedAt`／`source`（僅接受 `'pbs'`）／`eventId`／`lifecycle`（僅接受 `NEW`／`UPDATED`／`CLEARED`）／`fingerprint`／`requestId`，皆需為非空字串；`generatedAt` 須為可解析時間。`event` 為選填物件，白名單只讀取 `road`／`areaNm`／`direction`／`comment`／`longitude`／`latitude`／`sourceDetail`（僅供 log 使用，不要求額外欄位、多餘欄位直接忽略不拒絕）。Body 大小上限 16 KiB——遠大於單一事件所需（幾個短字串加兩個數字），遠小於整包約 1000 筆 PBS raw feed 所需，故不可能誤收後者。

**Debug-only 邊界（結構性，非執行期旗標）**：`src/pbs/debugPush.js` 完全不 import `line/`、`cctv/`、`traffic/sharedFeed(Handler)?.js`、`traffic/incidentSuppression.js`、`traffic/notified.js`、`traffic/broadcastProvenance.js`、`traffic/pipelineTrace.js`，或 `pbs/lifecycle.js`／`pbs/pipeline.js` 任何一個模組，也完全不觸碰 `env.TRAFFIC_KV`（或任何其他 binding）——沒有 import path 通往 LINE／CCTV／Shared Feed／Pipeline Trace／任何正式 KV 寫入，不是靠可能被忘記關閉的旗標。

**冪等判斷**：Cloudflare Workers isolate 無法可靠跨 request 去重（同一個事件的兩次請求可能落在不同 isolate），本輪依施工令自身明確指示**不**為此新增任何 KV 寫入，改採 per-isolate 記憶體內 fingerprint Map（10 分鐘視窗、上限 500 筆防止無界成長）做 best-effort 判斷，誠實回報 `PBS_DEBUG_PUSH_IDEMPOTENCY_MODE = 'NOT_PERSISTENT'`——不假裝有跨 isolate／跨部署重啟的持久保證。

**測試**：新增 33 項（`test/pbsDebugPush.test.js`），涵蓋施工令 CASE A–R（正確 secret×NEW/UPDATED/CLEARED、無 secret、錯 secret、GET 方法、無效 JSON、`source≠pbs`、無效 lifecycle、缺 eventId、缺 fingerprint、過大 body、確認不呼叫 LINE/CCTV、確認不寫 Shared Feed/notified-state/Pipeline Trace、確認零 Production business KV 寫入）以及額外的 auth 防回退、secret 不外洩、冪等行為、index.js routing 整合測試。以 counting mock 直接確認 NEW／UPDATED／CLEARED 三種情境下 `fetch` 呼叫與 KV `get`／`put` 呼叫皆為 **0** 次。既有測試套件無 NEW FAILURES：1385 項／1352 pass／33 fail，與變更前基線（1352/1319/33）的失敗清單逐項比對完全相同。

**部署後的下一步（尚未開始，需真人另行授權）**：Claude Browser 對已部署的 endpoint 做唯讀／安全驗證；之後才由 GPT／Windows 端新增 Debug Push client。本輪**未**把 secret 發給 Windows，**未**啟用真實推送。

**本輪未觸碰**：LINE、CCTV、Shared Feed、正式 Pipeline、正式 KV business event state、既有 PBS 30 分鐘輪詢閘門（V1.9.3 不變）、TDX、Cron、Windows Prototype 與其 `feature/pbs-local-edge-filter-prototype` 分支（未 merge，未讀取，未修改）。

## 修正紀錄｜Pipeline Trace 讀取效能優化（V1.9.4）（2026-08-27）

V1.9.3 上線後真人回報全站 timeout（另立查修令調查，結論與程式碼無關、sandbox 無法連
Production，見該輪報告），隨後真人在 Production 實測：`/`≈0.8s／`/version`≈0.4s／
`/health`≈0.75s，但 `/admin/pipeline-trace`／`-view` TTFB 皆 ≈59.1s。Root Cause（讀程式碼
確認，非猜測）：`listPipelineTrace` 舊 `collectFlattenedTraceEntries` 一律循序解碼到
`MAX_ENTRIES_SCANNED`(500) 筆才套用 `limit`(預設60)，不論有無篩選——無篩選的「最新60筆」
頁面每次都要付 500 次循序 KV 往返。

修正：新函式 `scanTraceEntriesProgressively` 合併三刀：(1) 提前停止——無篩選時解碼滿
`boundedLimit` 即停（實測 500 把 key／limit 60 → 只 60 次 `kv.get()`，原本 500 次）；
(2) 漸進式掃描——有篩選時以「輪」為單位，第一輪目標=`boundedLimit+NO_FILTER_SCAN_BUFFER`
(20)，之後每輪 ×`PROGRESSIVE_SCAN_GROWTH_FACTOR`(2)，上限仍是 `MAX_ENTRIES_SCANNED`，絕不
一開始就固定掃 500；(3) 有界並行讀取——同輪內 `kv.get()` 改固定 `PARALLEL_GET_BATCH_SIZE`
(20) 筆一批 `Promise.all` 並行、批間循序，絕非整輪一次性 `Promise.all`（20 為實測挑選，
本專案原無既有 KV/Workers 併發上限，落在施工令建議 20–30 區間中段）。V1／V2 並存策略不變
（V1 仍不刪除不遷移、靠 24h TTL 過期），兩前綴 `kv.list()` 改為並行。新增可觀測性（讀既有
已算出的數字，**零新增 KV 寫入**）：API／HTML 皆新增 `kvListCalls`／`kvGetCalls`／
`v1KeysScanned`／`v2BatchKeysScanned`／`v1KeyCount`／`v2BatchKeyCount`／`entriesDecoded`／
`entriesMatched`／`readDurationMs`，連同原本存在但從未回傳的 `scannedKeyCount`／
`totalKeyCount`／`scanTruncated`。新增 23 項測試（`test/pipelineTraceReadPerformance.test.js`，
CASE A-I 決定性 fixture）。NEW FAILURES=0（1352 項／1319 pass／33 fail，失敗清單與變更前
基線逐項相同）。未觸碰：Pipeline Trace 寫入路徑、V1.9.3 PBS 排程閘門、Health Snapshot、
Windows Prototype、LINE、CCTV、TDX、Cron 頻率。Production 驗證：見
`SYSTEM_STATE.json.taskSealHistory` 的 V1.9.4 紀錄（sandbox 無法連 Production，誠實標記
`NOT_OBSERVED`）。

## 修正紀錄｜V1.9.9 Phase 1 — Windows Service Area Hsinchu Only（2026-08-28，完成於另一個 session，本 Cloud Session 未參與，port 進本模板僅為維持一致）

`V1.9.9_PHASE_1 = WINDOWS_SERVICE_AREA_HSINCHU_ONLY`。Windows PBS Local Edge
Filter原先以竹南／頭份文字直接納入，且國1／國3公里上限與座標bounding box過寬，
可能把苗栗事件送入正式Business Pipeline。本輪只修改`pbs-relay/src/
localPrototype.js`（Windows端，本輪首次隨main一起commit，不再是未合併的feature
branch），重用既有`src/pbs/hsinchuFilter.js`與`src/pbs/roadName.js`：新竹市、
新竹縣、竹北、湖口、新豐、關西納入；竹南、頭份、苗栗市與其他苗栗縣區域排除；
同一道路只納入新竹段；座標不得再單獨授予服務區資格。lifecycle完全未改。
`AI_INTEGRATION=NOT_STARTED`；`LINE_POLICY=UNCHANGED`。Targeted 12/12、root
invariants 73/73、Windows PBS full suite 121/121 PASS，NEW FAILURES=0。Fix
commit `7acb82a`；Cloudflare Worker Version ID `defc1da4-6328-47ce-82c6-
81082519bc2`，Windows `TrafficReporter-PBS-LocalMonitor`已重啟為Running
（人類回報，本Session未獨立驗證）。

## 修正紀錄｜V2.0.2 Config Drift Hotfix — PBS_AI_DECISION_ENABLED canonical deployment（2026-08-29）

**CONFIG_DRIFT_INCIDENT**：GPT Work 在 Cloudflare Dashboard 手動設定
`PBS_AI_DECISION_ENABLED="true"` 後，被後續一次 GitHub main → Workers
Builds → wrangler deploy 悄悄移除／覆寫——根因與 `TRAFFIC_SOURCE_MODE`
既有註解記載的機制完全相同：Workers Builds 每次部署都把 `wrangler.jsonc`
視為權威來源，Dashboard-only 的值撐不過下一次 deploy。`AI switch` 只存在
於 Dashboard、不在 repo canonical configuration，因此每次 repo
deployment 都可能把 AI 悄悄關掉，而沒有任何人真的改過這個開關。17:49
台68事件發生時 AI switch 已被 deployment 移除，**該筆不算真實 AI 判讀
事件**（由legacy路徑決定，非Workers AI）。

**修正**：`wrangler.jsonc` 的 `vars` 區塊正式宣告
`"PBS_AI_DECISION_ENABLED": "true"`（必須是字串，Cloudflare 一律以字串
注入 Variable，`resolvePbsAiDecisionEnabled()` 自 V1.9.9 Phase 3D 起已
支援此形式）。**正式決策**：`PBS_AI_DECISION_ENABLED_SOURCE =
WRANGLER_CANONICAL_VAR`，`DASHBOARD_ONLY_AI_SWITCH = RETIRED`——Dashboard
不再作為此 Variable 的長期權威來源。**未新增** `keep_vars`（會讓
Dashboard-only 設定繼續漂移，與本輪目標「repo config authoritative」
相反）。新增 regression guard：`scripts/check-deployment-policy.mjs` 的
`checkPbsAiDecisionEnabledVar()`（`npm run check:deployment-policy` 現在
會在有人未來不小心刪掉這個 var 時立即失敗，而非讓 Production AI 默默
退回 FALSE）。

本輪**未觸碰**：AI Prompt、AI model、`aiDecisionEngine.js`、
`aiConfig.js` resolver 語意、Windows PBS filter、service area、
lifecycle、message formatter、driverSummary、LINE policy、Shared Feed、
CCTV、hourly reminder。未新增任何 Secret 至 `wrangler.jsonc` vars（測試
直接斷言）。`APP_VERSION` 從 `V2.0.1` 升為 `V2.0.2`（PATCH，config
correctness fix，不改 AI semantic behavior）。新增 10 項測試
（`test/pbsAiConfigDriftHotfixV202.test.js`），全部首次執行即 PASS；
全量迴歸 1549/1516/33，NEW FAILURES=0（僅跑一次）。

**另記已知問題（本輪不修）**：
`PBS_PRECISE_COMMENT_LOCATION_NOT_USED_BY_LINE_FORMATTER` —— LINE
訊息格式化目前不會把 PBS comment 原文中的精確交流道／匝道文字（例如
「近竹科匝道」）帶出來顯示，即使來源 comment 已經包含這個資訊。與本輪
config drift 修正無關，刻意不在本輪處理，避免同時改動兩個不相關問題。

## 修正紀錄｜V2.0.1 — AI Decision Observatory（2026-08-29）

PATCH，Production observability/diagnostic UI 修正，不改 AI semantic authority。
新 Admin 頁 `GET /admin/pbs-ai-observatory-view`（`src/pbs/aiObservatoryView.js`）
回答「PBS 原文→AI 判斷→AI 理由→最終結果」，READ ONLY OBSERVABILITY：開啟／
重新整理／搜尋一律 0 次 Workers AI 呼叫（`test/aiObservatoryView.test.js` 直接量
測 mocked AI adapter 呼叫次數操作前後不變）。盤點既有資料後確認無法零額外
KV 寫入：`aiDecisionCache.js` content-addressed 無法列舉事件；idempotency KV
無 PBS 欄位；`AI_CALL_FAILED`／`AI_DECISION_INVALID`／`SERVICE_AREA_EXCLUDED`／
legacy-path 完全無持久記錄（僅 console.log）。新增最小 thin index
`src/pbs/aiObservatoryIndex.js`（`debug:pbs-ai-observatory-index:v1:*`，48h
TTL），每個真正被接受（非重複）事件 +1 KV write（+0 額外讀取），刻意不重複儲存
notify/impact/reason/confidence——頁面渲染時直接讀既有 `aiDecisionCache` 記錄，
`reason` 保證是當時真正的 AI 輸出，絕不重新生成（測試直接證明：mock 第二次呼叫
會回傳不同 reason，頁面仍顯示第一次的真實值，且 AI 總呼叫次數維持 1）。重複事件
維持 0 額外寫入，頁面「重複事件」篩選誠實說明架構限制而非顯示誤導性空結果。KV
成本：`puts = 2N + 2`（較 V1.9.8 的 `N + 2` 多 1 次/事件），`gets` 不變。查修頁
語義全面改為 V2.x vocabulary（AI：建議通報／AI：不需主動通報／AI：判讀失敗，
安全不通報／服務區域外／AI 未判讀），絕不使用舊版 `不符合播報資格`（那是
`pipelineTraceView.js` 的 TDX/legacy 硬規則語意）。`APP_VERSION` V2.0.0→V2.0.1。
新增 22 項測試，全量迴歸 1539/1506/33，NEW FAILURES=0（僅跑一次）。本輪未觸碰：
AI Prompt、model、notify/impact/confidence 語意、service area、lifecycle、
idempotency、LINE quota、CCTV、Shared Feed policy。`FIRST_REAL_AI_EVENT`
仍 `WAITING`；`AI_DRIVER_SUMMARY = FUTURE_CANDIDATE`（僅記錄產品候選方向，
未實作、未修改 Prompt、未新增 schema）。**不要誤讀**：「重複事件」篩選目前
永遠回傳 0 筆（非 bug）——重複到達的事件在 transport idempotency 層就被攔截，
從未產生新的 observatory 記錄；如需查重複到達次數請查 Workers Logs 的
`duplicate=true`。

## 修正紀錄｜V2.0.0 MILESTONE — Windows PBS + Workers AI 架構封版（2026-08-28）

重大架構里程碑封版，非新功能開發。APP_VERSION 從 `V1.9.9` bump 為 `V2.0.0`
（架構世代更換等級的不相容變更，見 `06_VERSION_HISTORY.md`／
`02_PROJECT_HANDOFF.md` 的完整記錄），本輪未修改任何 runtime 決策邏輯。誠實
保留兩項既有已知限制，未在本輪解決：

1. **`FIRST_REAL_AI_EVENT = WAITING`**——真實 Production PBS 事件走完 Windows →
   Cloudflare → Workers AI → LINE 完整路徑的觀察證據尚未取得。這是下一個
   observational milestone，不是 V2.0.0 封版 blocker，也不是程式缺陷；
   `AI_BINDING=ACTIVE`／`AI_DECISION=ACTIVE` 為 GPT Work 回報，本 Session 未
   獨立驗證（sandbox 網路政策封鎖 Production 網域與 Dashboard）。
2. **Persistent idempotency atomicity 限制**（V1.9.7 既有已知限制，未變動）：
   `KV_ONLY_ATOMICITY = NOT_SUFFICIENT`——KV 無 compare-and-swap，理論上仍存在
   極窄 race window，`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PARTIAL`（非
   atomic exactly-once 保證）。完整分析見下方「Persistent PBS Debug Push
   Idempotency（V1.9.7）」記錄，含為何不引入 Durable Object 的理由。

## 修正紀錄｜V1.9.9 Phase 3D Hotfix — Cloudflare 字串布林解析（2026-08-28）

GPT Work 在 Cloudflare Dashboard 把 `PBS_AI_DECISION_ENABLED` 設為 `"true"`
後，正式環境 AI 決策仍未啟用。根因：Cloudflare Dashboard／CLI Variables
一律以**字串**注入 Worker，從不是真正的 boolean；`src/pbs/aiConfig.js#
resolvePbsAiDecisionEnabled()` 原本嚴格檢查`typeof === 'boolean'`，字串
`"true"`永遠不符合，因此每次請求都悄悄落回安全預設值`false`——不是
Dashboard操作錯誤，是resolver本身的bug。GPT Work已先行rollback
（`PBS_AI_DECISION_ENABLED = FALSE`），本輪只修這一點。

**修正**：`resolvePbsAiDecisionEnabled()`現在同時接受真正的boolean
`true`/`false`，以及Cloudflare runtime的字串形式`"true"`/`"false"`
（不分大小寫、去除前後空白，如`" TRUE "`、`"True"`）；除此之外的任何值
（`undefined`、`null`、空字串、其他常見「真值」拼法如`"1"`/`"yes"`/
`"on"`、或任何非字串非boolean型別）一律fail-safe回`PBS_AI_DECISION_
ENABLED_DEFAULT = false`——刻意不做寬鬆truthy判斷。`wrangler.jsonc`
檢查後確認未宣告任何`PBS_AI_DECISION_ENABLED`值，Production預設安全性
不受影響。

**測試**：`test/aiConfig.test.js`擴充為完整true/false/字串/大小寫/空白/
未知值矩陣（新增6項，1項既有測試的斷言依新預期行為反轉）；
`test/pbsAiDecisionScenarios.test.js`新增2項integration-level測試，
透過真實`handlePbsDebugPush()`端對端驗證字串`"true"`確實會讓mocked AI
adapter被呼叫、字串`"false"`確實維持0次AI呼叫——不只測純函式。全量
迴歸1517/1484/33，NEW FAILURES=0（以failure名稱集合對照Phase 3B基準
確認，本輪唯一差異是先前session量到的一項環境敏感git/build-metadata
flaky測試這次未再出現）。

本輪**未觸碰**：AI prompt、model ID、AI candidate schema、AI cache、
cache TTL、`runAiApprovedPbsBroadcast`、LINE policy、
`MAJOR_ACCIDENT_ONLY` legacy path、service area、lifecycle、
idempotency、CCTV、Shared Feed、hourly reminder、TDX、Windows
monitor——單點config parsing hotfix。APP_VERSION維持`V1.9.9`。

**現狀**：`AI_BINDING = ACTIVE`（GPT Work已確認）、
`AI_DECISION = DISABLED_PENDING_GPT_WORK_RETRY`——修正已部署，但
Dashboard端`PBS_AI_DECISION_ENABLED`目前仍是GPT Work rollback後的
`FALSE`，尚未重新設回`"true"`重試。是否／何時重試由GPT Work決定，
不在本輪範圍。

## 修正紀錄｜V1.9.9 Phase 3B — Workers AI Driver Impact Decision Integration（2026-08-28，壓縮摘要）

Phase 2預留的AI candidate／cache key設計正式接上真實Workers AI呼叫。固定
model `@cf/zai-org/glm-4.7-flash`，透過`env.AI.run(...)`。新模組：
`src/pbs/aiConfig.js`（kill switch `PBS_AI_DECISION_ENABLED`，預設false，
理由：避免Claude push程式碼後、GPT Work尚未建立AI binding前就因部署本身
壞掉Production LINE推播）、`src/pbs/aiDecisionCache.js`（48h TTL，
fail-open）、`src/pbs/aiDecisionEngine.js`（固定繁中prompt只判斷駕駛通行
影響非事件類型，`validateAiDecisionResponse()`嚴格schema，不合格即
`AI_DECISION_INVALID`絕不到LINE）、`src/traffic/aiApprovedPbsBroadcast.js`
（`runAiApprovedPbsBroadcast()`，重用既有subscriptions/notified/
incidentSuppression/messageFormat/CCTV/pushMessage，明確不呼叫
`getBroadcastEligibility`/`getLinePushPolicyDecision`/`resolveLocationQuality`
這三個要退休的內容判讀硬規則）。`debugPush.js`關鍵架構決策：AI開啟時與
legacy `runLineBroadcast()`路徑互斥，同一事件絕不同時執行兩者，避免雙重
判官造成LINE重複推播。cache key重用`computeAiDecisionCacheKeyHash
({eventId,fingerprint})`（SHA-256），transport duplicate與cache hit皆0次
AI呼叫。AI失敗（429/5xx/invalid response/binding missing）一律0 LINE、
絕不fallback舊硬規則；未加retry（無可重用helper，施工令要求第一版簡單）。
新增5個測試檔共57項全部首次PASS，1509/1476/33，NEW FAILURES=0。當時
Production狀態AI_INTEGRATION=CODE_READY/AI_BINDING=PENDING_BROWSER_SETUP/
AI_DECISION=DISABLED，尚未寫ACTIVE。**此輪記錄的Production狀態已被
V2.0.0/V2.0.1/V2.0.2取代——最新狀態見SYSTEM_STATE.json的taskSeal與
下方對應版本記錄，特別是V2.0.2 Config Drift Hotfix修正了kill switch
Dashboard-only設定被deploy覆寫的根因問題。**

## 修正紀錄｜V1.9.9 Phase 2 — AI-ready Business Pipeline Simplification（2026-08-28，壓縮摘要）

為Phase 3 Workers AI全量判讀做準備。找到三個目前讓候選PBS事件在「內容判讀」
階段被reject的既有硬規則：`broadcastPolicy.js`的`MAJOR_ACCIDENT_ONLY`、
`broadcastRules.js`的V1.5 type/keyword whitelist（`getBroadcastEligibility`）、
`locationQuality.js`的location quality hard-reject，三者皆位於真正的LINE
決策函式`runLineBroadcast`內部。新增`src/pbs/aiCandidate.js`（純函式、零I/O）：
`buildAiCandidate()`從Windows正規化事件建立最小candidate物件（source/eventId/
lifecycle/road/direction/areaNm/comment/longitude/latitude/generatedAt +
displayKM/eventType/sourceDetail/locationQuality，刻意不含notify/impact），
`isWindowsPbsAiCandidateEligible()`只重用service area既有resolver作為唯一
gate（不套用上述三個硬規則）。`src/pbs/debugPush.js`額外呼叫這兩個函式，與既有
（完全未修改）`runLineBroadcast()`呼叫並行，純log觀察用（`PBS_AI_DECISION_MODE
= 'PREPARED_NOT_ACTIVE'`），從未影響真實LINE決策。另預留（僅schema/helper，
無任何KV讀寫）`computeAiDecisionCacheKeyHash({eventId,fingerprint})` =
SHA-256、`AI_DECISION_CACHE_KV_PREFIX = 'debug:pbs-ai-decision-cache:v1'`，
供Phase 3採用。新增28項測試（`test/pbsAiCandidate.test.js`13項 +
`test/pbsDebugPush.test.js`施工令十五項最低清單）。1452/1419/33基線，
NEW FAILURES=0。**V1.9.9 Phase 3B已將這裡預留的cache key設計正式接上真實
Workers AI呼叫，見下方Phase 3B記錄。**

## 修正紀錄｜Windows PBS Push → Production Business Pipeline ＋ PBS 輪詢退休（V1.9.8）（2026-08-28，壓縮摘要）

V1.9.7關閉了持久冪等風險後，本輪把六階段路線圖Phase 3-6合併完成：`src/pbs/
debugPush.js`就地升級為正式Production Ingress（Option A，非另建endpoint）。
新函式`buildRawPbsRecordFromPush()`把Windows payload組成raw-PBS-shaped record
（`happendate`/`happentime`/`modDttm`由`generatedAt`精確反推Asia/Taipei本地
時間字串，UTC+8固定無DST，非近似值；`roadtype`留空，因Windows本機過濾器已保證
comment含事故關鍵字），交給既有未修改的`normalizePbsEvent()`→`runLineBroadcast()`
（與Cron輪詢路徑同一函式，同一套service area/policy/location quality/dedupe/
CCTV/notified-state判斷）→`runSharedFeedPersist()`。CLEARED只ACK/log，刻意不進
`runLineBroadcast`（比照`pbs/pipeline.js`既有clearedEvents行為）。LINE Push
Policy（`MAJOR_ACCIDENT_ONLY`）完全未變動。同時Cloudflare自身PBS 30分鐘輪詢
正式退休：`pbsConfig.js`新增`PBS_30_MIN_POLLING_ENABLED=false`（env可覆寫，
Production不設此var，僅供既有PBS/CCTV測試套件沿用），`pbsSchedule.js`/
`pbs/pipeline.js`/`pbs/lifecycle.js`程式碼一行未刪，翻回旗標即可rollback。
已知可接受副作用：`pbs:lifecycle-state`不再寫入、`/health`的pbs區塊凍結在
退休前最後數值。KV成本剖面誠實修正：N筆事件→`gets=5N`/`puts=N+2`。新增
`test/pbsDebugPush.test.js`施工令十五項最低清單 + `test/pbsPollingRetirementV198.
test.js`（4項），1424/1391/33基線，NEW FAILURES=0。

## 修正紀錄｜Persistent PBS Debug Push Idempotency（V1.9.7）（2026-08-28，壓縮摘要）

真實觸發：V1.9.6首筆事件驗收（台68西向5K，Windows早Cloudflare舊輪詢約12.1分鐘）
證明channel正常，但V1.9.5的冪等只有per-isolate記憶體（`NOT_PERSISTENT`），isolate
換掉/重啟/redeploy可能讓同一事件重新被accept。修正：`src/pbs/debugPush.js`新增
TRAFFIC_KV下獨立debug-only前綴`debug:pbs-push-idempotency:v1:*`（`IDEMPOTENCY_KV_
PREFIX`，絕不觸碰任何business key）作為L2持久層，key=SHA-256(source:eventId:
lifecycle:fingerprint)決定性產生（不用requestId，因同事件重試requestId本就不同），
48h TTL。L1既有記憶體Map保留為快取但非唯一真相，L1 miss一律查L2才能accept。實測
KV成本：10/30/100筆相異事件/日各花10/30/100次get+put（1 accept=恰好1次寫），
duplicate（含5次重試）僅1次put+6次get，加既有~118 writes/day基線→約128/148/218
writes/day，遠低於1,000上限，`KV_WRITE_PRESSURE=LOW`。誠實回報`KV_ONLY_ATOMICITY=
NOT_SUFFICIENT`（KV無compare-and-swap，理論極窄race window仍存在）——依施工令
「不要過度設計」指示不引入Durable Object：本輪要關閉的風險（isolate換掉/重啟/
redeploy造成**事後**重複accept）已被持久KV層完全解決，與**同時**發生的race是不同
問題；此endpoint零business side effect（LINE/CCTV/Shared Feed/正式KV皆0），race
最壞後果僅冗餘debug log。故`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY`誠實標記
**`PARTIAL`**（非ACTIVE非NOT_SOLVED）——**V1.9.8已將此endpoint接上真正的business
side effect（LINE/Shared Feed），沿用此PARTIAL設計未變動，Durable Object評估仍未
進行，若未來race實際造成問題才需重新評估**。KV outage時fail OPEN（事件仍
accepted）。既有Debug API JSON schema完全不變。新增52項測試（原33項）涵蓋施工令
20項清單，NEW FAILURES=0（1404/1371/33基線）。

## 封版紀錄｜PBS Windows Local Edge Debug Push Integration（V1.9.6）（2026-08-27，壓縮摘要）

治理封版令：Windows本機完成常駐邊緣篩選＋Debug Push整合（接上V1.9.5的Cloudflare
Debug-only接收端），本輪只寫入Engineering Memory，不merge、不新增Cloudflare
runtime變更、不整合LINE/CCTV/Business KV、不退休既有PBS輪詢。**冪等狀態已由
V1.9.7更新為PARTIAL，見該條目，此處不再重複舊的NOT_PERSISTENT/PENDING_BEFORE_
PRODUCTION描述**。

**最新程式事實**（本Session獨立驗證）：`LOCAL_PROTOTYPE_BRANCH=
feature/pbs-local-edge-filter-prototype`、`LOCAL_PROTOTYPE_HEAD=
95ecdc4718f836ff36c974e829b549f262e6b936`、`MERGED_TO_MAIN=NO`（git merge-base
確認）。`git worktree`乾淨簽出+`node --test`：118項全通過、0失敗，與人類回報一致
（前一輪缺`cache.js`的落差已在此commit補上）。Windows端執行期狀態（Task
Scheduler是否真的常駐、Cloudflare Secret Dashboard狀態、Claude Browser mock
驗證畫面）本sandbox無法連線驗證，按人類回報記錄，明確標示非本Session證實。

**完整架構**：PBS來源→Windows每3分鐘抓取→Local Edge Filter（重用Production
`src/pbs/hsinchuFilter.js`／`src/pbs/roadName.js`）→事件生命週期比較→
NEW/UPDATED/CLEARED/UNCHANGED/MISSING_PENDING_CLEAR→SHOULD_PUSH判斷→
（NO停在Windows／YES經Debug Push Client）→`POST /internal/pbs-debug-push`→
Cloudflare Debug-only Receiver→驗證/best-effort duplicate/log/ACK。明確不進
LINE/CCTV/R2/Shared Feed/正式Business KV/正式Pipeline。完整圖見
`03_ARCHITECTURE.md`。

**兩個真實bug修正**（本Session已讀程式碼確認）：(1) 服務區——舊寬鬆矩形
（lat24.45~24.95/lng120.80~121.35）誤收國3 55.8K鶯歌／國1 68.1K楊梅，修正為直接
import Production的`isPbsEventHsinchuRelevant`／`normalizePbsRoad`；(2) CLEARED——
舊單輪缺席即CLEARED的誤判，修正為明確解除文字（已排除/排除/已解除/解除）立即
CLEARED，或連續2輪成功fetch缺席才`CONFIRMED_CLEARED`（`missingCount>=2`），fetch
失敗不累加、中途重現則歸零。人類回報以真實案例（UID 11508260013-5，國3 96.7K
寶山休息站）驗證。

**Windows常駐模式**（人類回報）：Task Scheduler `TrafficReporter-PBS-
LocalMonitor`，3分鐘間隔，watchdog/lock/state recovery/JSONL log（7天保留）。
`REBOOT_TEST=PENDING`但manual restart/watchdog/state recovery皆PASS。已知UX：
可能顯示Node console視窗，真人決定暫不修改，不算blocker。

**Secret治理教訓（永久規則，最重要）**：`PBS_DEBUG_PUSH_SECRET`曾只存在於新
Worker Version（9ddc58ea）而Active Deployment仍是舊版（47f54b17），導致持續503。
Root Cause：**Secret在Dashboard存在≠已進入服務流量的Active Production
Version**。真人promote後才恢復。未來新增/修改任何Cloudflare Secret後，必須確認
該Secret所在Version是否為目前Active Deployment。

**Debug Push Client**（本Session已讀程式碼確認）：`debugPushClient.js`，
5000ms timeout、最多2次總嘗試、只重試timeout/network/5xx（4xx不重試）、503立即
停止。requestId格式：`pbs:<id>:<lifecycle>:<fingerprint前16碼>`。

**SHOULD_PUSH串接**：僅NEW/UPDATED/CLEARED送出。`PBS_DEBUG_PUSH_ENABLED`預設
false，真人已設true。人類回報`NO_CHANGE_NO_PUSH=PASS`（無變化時對Cloudflare的
request數為0，本Session未重跑）。

**Mock驗證證據**（人類回報）：NEW/DUPLICATE/UPDATED/CLEARED四情境皆PASS，
Workers Logs交叉驗證四種LOG_FOUND皆YES，LINE/CCTV/R2/Shared
Feed/Business_KV_SIDE_EFFECT皆0，SECRET_LEAK=NO。

**現行PBS輪詢**：`PBS_30_MIN_POLLING=PRESERVED`，Cloudflare既有輪詢完全保留，
仍是正式路徑，退休時機在路線圖Phase 6，不得提前。

**路線圖**：Phase1（目前）Real Debug Observation → Phase2 Persistent
Idempotency Design（**V1.9.7已完成，見該條目**）→ Phase3 Debug Receiver→
Production Business Pipeline（仍LINE disabled）→ Phase4 LINE limited
activation → Phase5 Windows Edge成為主要觸發 → Phase6長期觀察後才評估PBS輪詢
退休。

**Emergency kill switch**：Windows User Environment設`PBS_DEBUG_PUSH_
ENABLED=false`+重啟`TrafficReporter-PBS-LocalMonitor`即可停止，不需動PBS
monitor/Secret/Cloudflare/既有輪詢。

不要誤讀：feature branch未merge main；Windows Debug Push僅止於Debug-only接收端，
未進正式Business Pipeline；Cloudflare既有PBS輪詢未被取代；不要修改Windows
Secret或Task Scheduler。

## TDX 還原程序（RESTORE TDX）

**前提**：真人確認 TDX 額度確實已恢復。

1. `wrangler.jsonc` 把 `TRAFFIC_SOURCE_MODE` 改成 `"ALL"`（或整個刪掉該 var——缺席即等同 ALL）。
2. push 到 `main`，Workers Builds 自動重新部署。
3. 下一個分鐘 00/20/40 的 tick 就會自動恢復 TDX 國道／省道抓取與 CCTV 補圖。`tdxSchedule.js` 全程未被本次修改碰過，排程邏輯原封不動。
4. 驗證：`GET /health` 應顯示 `sourceMode.trafficSourceMode = ALL`，且下一個 20 分鐘整點 tick 的 log 顯示 `tdxScheduleState=scheduled`。

**不需要重寫任何 TDX 功能。沒有第二個開關。** 完整說明寫在 `src/traffic/sourceMode.js` 的 module comment（單一權威來源）。

## 已知架構限制（非 bug，設計上已知的邊界）

- **Pipeline Trace 頁面禁止任何 client-side JavaScript**（既有嚴格 Admin CSP，`default-src 'none'`，無 `script-src` 例外）。V1.8.7.6 已確認的「表單重新送出無效」症狀，最終結論是特定瀏覽器的 client-side 行為，本專案程式碼層面無法修復，只能靠直接 URL 導航（已驗證 100% 正常）繞過。
- **Cloudflare Dashboard-only 設定永遠無法從程式驗證**：Production branch 指向、Cron Trigger 實際排程、Secret 是否為正確值（僅能驗證存在性，無法驗證正確性）、Build/Deployment 歷史——這些只能靠人工開 Dashboard 或 Claude Browser 唯讀查證確認，`npm run verify:production`/`check:deployment-policy` 結構上就是查不到。
- **本 session 類型的沙盒環境對 Production 完全無網路存取**（本輪與先前多輪皆已確認：對 Production Worker 網域與一般網站的 outbound HTTPS 一律被環境自身的 egress proxy 回 403）。任何需要即時 Production 證據（KV 內容、Cron log、真實 LINE 訊息渲染結果）的任務，在這類 session 中只能誠實標記「無法證明」，不能用程式邏輯推測補齊。

## 已知的機器判讀陷阱（供未來 Guard 開發參考）

- `git branch -r --no-merged main` 對以 cherry-pick 方式收編的分支會誤判為未合併（比對 commit SHA 祖先關係，不比對內容）——V1.8.7.3 分支即為實例。
- `ENGINEERING_STATUS.md` 的「main HEAD」欄位歷史上曾經長時間未同步更新（曾停留在 V1.8.6.8 時代的 SHA，直到 V1.8.7.7 封版時才發現並更正）——此欄位理想上應由 script 自動產生，而不是每輪手動記，這正是本 export 系統 `SYSTEM_STATE.json` 存在的原因之一。
