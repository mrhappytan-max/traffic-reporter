<!-- title: 已知問題 -->

# 07. Known Issues

## 已知、無關、既有的測試失敗基準線

**實測基準（2026-08-25 重新量測，非回憶）：`npm test` 共 1272 項，穩定 38 項失敗。**

> **重要更正（CCTV_METADATA_RECOVERY_V1，2026-08-25）——舊版本節寫錯了 Root Cause。**
> 舊記載說「13 項 CCTV/JPEG 失敗是因為依賴 Workers-only 的 `.wasm` codec，在此沙盒無法載入」。
> **這是錯的。** 真正原因是這個沙盒的 `node_modules` 不完整，`@jsquash/jpeg` 根本沒安裝
>（它是 `package.json` 的正式 `dependencies`，也在 `package-lock.json` 裡，正常 `npm ci` 一定會裝）。
> 執行 `npm install @jsquash/jpeg` 之後，那 12 個檔案全部可以正常載入並執行。
>
> 代價是：這 12 個檔案**整份沒有被執行過**，所以裡面約 36 項早就該更新的測試被長期誤判成
>「環境問題」而略過。它們不是回歸，是**過期斷言**——斷言的是後來被刻意改掉的行為：
> - `DYNAMIC_SHOULDER_PUSH=OFF` / `LINE_PUSH_POLICY=MAJOR_ACCIDENT_ONLY` 之後，
>   動態路肩不再推播，但測試仍斷言 `imagePrepared=true`、仍期待 1 次 push（實測 `0 !== 1`）。
> - `PBS_ACCIDENT_CCTV_ENRICHMENT_FIX` 之後 PBS 已是 CCTV 可信來源，但測試仍斷言
>   `not-freeway-source`、`cctvEligible:false`（實測 `true !== false`）。
>
> **教訓（比這些測試本身更重要）**：一個「合理但沒被驗證」的 Root Cause，會讓 36 項真實訊號
> 被靜音好幾輪。當時該做而沒做的一步只是 `npm install`。
> 這正是「不要為了交差把合理推測當 Root Cause」的實例，且這次是我們自己犯的。

目前 38 項的正確分類（每輪仍以同一輪 `git stash -u` 對照乾淨 checkout 驗證）：

1. `pbs-relay/tests/*`（2 項）— `pbs-relay/src/server.js` 匯入的 `pbs-relay/src/cache.js` 不存在於 repo。
   獨立子系統，非本 Worker 主程式。
2. **過期斷言（33 項）**— 見上方更正框。分布於 `singleCctvBudgetFairness`、`dynamicShoulder`、
   `dynamicShoulderMessageShort`、`dynamicCollage`、`broadcastCctvIntegration`、
   `cctvPrepareTimeoutStages`、`freeway3CctvAudit`、`pipelineTraceIntegration`、
   `productionIntegrationFixtures`、`hsinchuCctvCollageEndpoint`、`cctvImagePublish` 等檔。
   **這是本專案目前最大的一筆技術債，已列為 openFollowUp。**
3. `test/healthQuotaDashboard.test.js`（3 項）— wall-clock 相依，會隨真實日期自然過期。

若出現這 38 項以外的新失敗，才視為真正回歸。

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

舊版本文件曾記載「1153 項中 3 項失敗」「998 項中 18 項失敗」「1081 項中 18 項失敗」，
三個數字都已過期，以本節實測數字為準。

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

## 修正紀錄｜服務區域閘門（八堵事件）（2026-08-24）

**一句話**：`PBS_ONLY` 不等於「全台 PBS 都能播」。地域資格永遠要檢查。

### 現象（真實 Production 漏播案例）

LINE 實際收到一筆不該播的事件：
PBS、國道1號南向、八堵交流道－大華系統交流道約 3K、
座標約 `25.10288 / 121.71801`（基隆），type=accident。
該地點**不在服務區域內**，卻成功進入 LINE Push。

### Root cause

地域過濾**只存在於一個地方**：PBS 進料端
（`pbs/pipeline.js` 的 `normalized.filter(isPbsEventHsinchuRelevant)`）。

再往下，`broadcastPipeline.js` 只是在 JSDoc **寫著**
「every currently Hsinchu-relevant … event」，
**然後從來沒有真的檢查過**。

**寫在註解裡的假設不是閘門。** 任何以其他路徑抵達播報層的事件，
都會直接繼承一個它從未被授予的播報資格。

而且這個風險在 2026-08-24 當天**變大了**：
V57.2 的國道閘門在 PBS_ONLY 下被（正確地）略過，
但 V57.2 原本會順手擋掉所有「無 TDX 對應的國道 PBS 事件」——不論地理位置。
拿掉它的否決權，也一併拿掉了那張意外的安全網。

### 誠實的限制（不要誤讀成已完全查明）

**我無法用手上的資料重現進料端的漏洞。**
以 八堵 的座標／道路／KM／描述，用各種可能的原始記錄形狀
（有無座標、有無可解析 KM、lat/lng 對調）去跑
`isPbsEventHsinchuRelevant`，**每一種都正確擋下**。

所以本輪的修正**不是**修補一個已重現的洞，
而是補上**Producer 播報邊界上本來就該有、卻不存在的那道強制檢查**——
無論事件從哪條路徑抵達，都會被擋。

未來若取得該事件的**原始 PBS 記錄**，仍值得回頭確認進料端是否另有缺口。

### 修正方式

新增 `src/traffic/serviceArea.js`，在既有 eligibility 迴圈**最前面**檢查，
**所有 source mode 都適用**。

- **重用既有 canonical 判定**：`pbs/hsinchuFilter.js` 與 `traffic/hsinchuFilter.js`。
  **沒有**新的地理引擎、**沒有**新的 bounding box、
  服務範圍**既未擴大也未縮小**。
- 既有 canonical 範圍已涵蓋 新竹／竹北／竹南／頭份，並排除八堵——
  以真實座標實測確認：
  新竹市 24.804/120.965、竹北 24.839/121.013、
  竹南 24.686/120.876、頭份 24.688/120.908 **皆在範圍內**；
  八堵 25.103/121.718 **在範圍外**。

### PBS 與 TDX 為何處理方式不同（這是刻意的，不是疏漏）

| 來源 | 行為 | 理由 |
|---|---|---|
| PBS | **fail-closed**：無法定位就擋 | PBS 事件把地理資訊（座標／道路／描述）一路帶到播報層，本閘門能重跑**進料端用的同一個函式**，得到相同結論 |
| TDX | **只在能明確判定「在區域外」時才擋**，無法定位則交還進料端 | `tdx/normalize.js` 保留 road/KM 但**不保留 raw `Positions`**；進料端是「座標 **或** road+KM」二擇一放行。若在此 fail-closed，一旦 KM 缺失就會**靜默丟掉正常的 TDX 事件**——那是比本 bug 更嚴重、而且**只會在 TDX 恢復後才浮現**的問題 |

**這不是猜的**：fail-closed 版本讓 **35 項**既有測試失敗，
全部是「有道路但沒有 KM」的 TDX fixture。

兩層是互補的：
```
進料端      — fail-closed 准入，看得到全部證據
本閘門      — 攔截任何「已抵達播報層且可明確判定在區域外」的事件（八堵形狀）
```

### 兩道閘門永久獨立

```
TDX_CORROBORATION_REQUIRED        = false （PBS_ONLY，因為 TDX 已停用）
SERVICE_AREA_ELIGIBILITY_REQUIRED = true  （永遠，所有模式）
```

**「不再需要 TDX 佐證」永遠不可以變成「任何地方都能播」。**
本模組就是把這條分界**寫下來並強制執行**，而不是假設它成立。

### 可觀測性

- `eligibilityReason` 會出現 `outside-service-area`。
- Pipeline Trace 的 `decision` 新增 `serviceAreaEligible`（由同一個 reason 導出，不是第二次判斷），
  讓「被地理擋下」與「被事故限定政策擋下」「因無 TDX 對應被 gated」一眼可分。

### 給未來 Agent 的通則

**只在一個地方做過濾，等於沒有保證。**
如果某一層的正確性依賴「上游應該已經過濾過了」，
那就要嘛在本層**真的檢查**，要嘛讓上游**在事件上留下可驗證的標記**——
寫在註解裡的假設，遲早會被某條新路徑繞過，而且**不會報錯**。

## 修正紀錄｜播報追溯斷點 ＋ 位置精確度閘門（台68 事件）（2026-08-24）

### 現象（兩個真實 Production 症狀）

真人於 2026-08-24 約 14:20 收到主動 Push：

```
🚨 交通事故
台68 西向
（南寮竹東）-台68線
事故影響通行
請提前避開
🕒 13:48 更新
```

1. **位置不可行動**：第三行不是地點，是 PBS 對「整條台68」的官方路線名稱
   （本 repo 的 `src/pbs/roadName.js` 早就把這個字串當成真實 `areaNm` 範例寫在註解裡）。
   官方里程資料顯示南寮在 0.4K、竹東在 22.9K 一端——等於告訴駕駛「這條路上某處有事故」。
   LINE 主動 Push 每月只有 200 則，這一則等於浪費掉。
2. **查不到**：幾分鐘後在健康頁 / Pipeline Trace 找不到這筆事件。

### 反查結果（能證明的 / 不能證明的，分開寫）

**沙箱對外 egress 為 403，無法讀取 Production KV 或 admin 端點**，
所以「這一筆的原始 PBS 記錄」我拿不到。以下全部是從**訊息本身**與**repo 程式碼**推回來的，
每一項都可由任何人重跑 `test/pbsAccidentTraceLocationQuality.test.js` 第 1 項驗證：

| 項目 | 結論 | 依據 |
| --- | --- | --- |
| source | **PBS**（非 TDX、非 Consumer） | 訊息格式逐字命中 `messageFormat.js` 的 `formatEventMessage`；`（南寮竹東）-台68線` 是 PBS `areaNm` 形狀 |
| 原始 location | `areaNm = （南寮竹東）-台68線` | 第三行是 `event.location` fallback，而 PBS 的 `location` 只可能來自 `areaNm` |
| 原始 updatedAt | `modDttm = 2026-08-24 13:48:00` | 末行 `🕒 13:48更新` |
| 原始是否有 KM | **沒有可解析的 KM** | PBS 從來沒有結構化 KM；`comment` 若有「8.1公里 / 8K+300」形狀，`displayKM` 會讓訊息多出 KM 行 |
| 原始是否有座標 | **無法確定** | 現有程式碼**根本沒有任何顯示路徑會讀 `x1`/`y1`**，有沒有座標產生的訊息完全一樣 |
| service area | 通過（台68 全線在服務區內） | `hsinchuConfig.js` 的 `wholeRouteInScope` |
| eligibility / 政策 | 兩者都通過 | 它確實是 `accident`，也符合重大事故限定 |

**rawId 沒有取得**：PBS 的 `rawId` 是 `UID`，訊息裡不會出現，Production 也讀不到。
測試用的是同形狀 fixture，不是宣稱那一筆的真實 UID。

### Root cause（兩個，都不是猜的）

**A. 位置**：PBS 事件走到播報層時，唯一能產生精確位置的來源是
`comment` free text 解析出來的 `displayKM`。`x1`/`y1` 在 `pbs/normalize.js`
一直有被保留成 `latitude`/`longitude`，但**顯示側從來沒有任何一行讀過它**——
`resolveKmLocation()` 是從 KM 出發的，而 PBS 沒有 KM。
所以「有精確座標」和「完全沒有位置」產生的訊息**逐位元組相同**。
這屬於「已有精確資料但被我們丟掉」。

**B. 追溯**：trace **有寫入**（`broadcastPipeline.js` 對 `allEvents` 每一筆都建 entry，
四個 return 都會 `finalizeTrace()`）。斷點全部在**讀取側**：

1. `/health` 是 counts-only 快照（`healthSnapshot.js` 不存任何 per-event 身分），
   本來就不是查單一事件的地方——這是設計，不是 bug，但它讓「查不到」看起來像資料遺失。
2. Pipeline Trace 的 `road` 篩選是**嚴格相等**，而 trace 存的是正規化後的 `台68`，
   人看得到的每一個字面（LINE 訊息、PBS 欄位）都是 `台68線`。
   **照著螢幕上的字去搜，必定 0 筆**，和「從來沒被記錄」完全無法區分。
3. 同一次 Cron 的所有 entry 共用同一個 `now`，key 裡的 epochMs 一模一樣，
   唯一的區別是**隨機** `opaqueId` → 同一輪內順序隨機，
   預設只顯示最新 30 筆時，某一筆會**不定時地**被擠出第一頁。
4. 掃描上限 500 筆時，「沒掃到」與「不存在」回報成同一件事。

### 修正方式

**先修解析，再談封鎖**（施工令的 A/B 判斷）：

- 新增 `kmLocationResolver.js` 的 `resolveCoordinateLocation()`——
  既有 KM 查詢的**反向**版本，同一份官方 bundled 資料集、同樣 fail-closed、同樣 0 網路。
  找到本路線上最近的里程點（容差 0.5 公里，依實測 ~100m 點距訂定），再交給既有 KM 解析器產生標籤。
- `messageFormat.js` 在「完全沒有 KM」時才呼叫它。既有訊息一則都不會改變。
  該事件若真的有座標，現在會顯示 `台68 西向｜新竹市東區水源里` 並附地圖連結。

**再加閘門**：新增 `traffic/locationQuality.js`，位於服務區域與事故政策**之後**、
時間/dedupe/suppression **之前**。判定層級（全部沿用既有 resolver，沒有新地理引擎、沒有硬編 KM）：

1. 來源結構化 KM（區段超過 `MAX_ACTIONABLE_SEGMENT_KM = 15` 公里者不算——
   15 是官方交流道資料集中 國1/國3 相鄰設施最大間距，p50 只有 4 公里）
2. `displayKM`（PBS comment 內的官方公里標記）
3. 座標，且**既有 resolver 能可靠轉成可理解地點**
4. 訊息**真的會印出來**的地點文字內含：明確 KM／交流道匝道路口隧道／行政區＋更細地點

刻意**不**看 `description`：formatter 從不印它，
用看不到的文字放行，就是這個閘門要擋的假精確。

不足時：`eligible = false`，`reason = insufficient-location-precision`，
事件**仍然保留在 Pipeline Trace**，不會消失，也永遠不會 throw。

**追溯側**：`road` 篩選改用 pipeline 自己的正規化函式比對（台68／台68線／國1／國道1號 互通，
但兩條真的不同的路永遠不會互相命中）；新增關鍵字搜尋（道路／地點／訊息內容／rawId）；
key 加入批次序號讓同一輪順序穩定；掃描未涵蓋全部時**明講**，不再把「沒掃到」講成「不存在」。

### 三道閘門永久獨立

```
TDX_CORROBORATION_REQUIRED   -> false（PBS_ONLY）
SERVICE_AREA_REQUIRED        -> 永遠 true
LOCATION_QUALITY_REQUIRED    -> 永遠 true
```

它們回答三個不同的問題：「有沒有被佐證」「是不是我們的地盤」「駕駛能不能用」。
任何一個都不得被另一個取代或推論。八堵那一筆即使位置精確，仍然必須被服務區域擋下——
這一點有專門測試鎖住。

### 可觀測性

- 新 status：`outside-service-area`（🚫 不在服務區域）、`insufficient-location`（📍 位置不夠精確）。
  其餘仍走既有 `ineligible`，但 reason 一律逐字顯示，不再只有「不符合播報資格」。
- `decision.locationQuality` 記錄是哪一層放行、或**具體缺什麼**。
- Cron log 多印 `serviceAreaRequired=true locationQualityRequired=true`。

### 本輪交付結果（封版時實測，非回憶）

- 全套測試 **1060 項 / pass 1043 / fail 17**。
  與乾淨 checkout（`git stash -u` 對照）相比：
  **NEW FAILURES = 0，SILENTLY FIXED = 0**。
  那 17 項全部是本節開頭列出的既有失敗，**不屬於本輪 regression**。
- 新增 `test/pbsAccidentTraceLocationQuality.test.js`：**25 項，全數通過**。
- `npm run check:deployment-policy`：PASS。
- push `main` 已觸發 Cloudflare Workers Builds 正式部署；
  `npm run verify:production` 因沙箱 egress 403 回報
  `PASS_NETWORK_VERIFICATION_BLOCKED`——**不構成封版 blocker**
  （與 TDX_QUOTA 那一輪相同的既有裁示）。

### 給未來 Agent 的通則

**閘門的判準，必須和訊息真正會顯示的內容一致。**
用一個駕駛看不到的欄位去證明「位置夠精確」，等於為假精確背書。

**「查不到」和「沒發生」是兩件事。**
任何有上限的掃描，都必須把上限講出來；把沉默的截斷呈現成空結果，
會讓真人把讀取側的 bug 誤判成資料遺失，往完全錯誤的方向查下去。

## 修正紀錄｜PBS 國道事故取不到 CCTV（國3 96K+700 事件）（2026-08-25）

**一句話**：CCTV 的資格判斷還停在「必須是 TDX Freeway 來源」，
在 TDX 已關閉的世界裡，那等於「PBS 事故永遠沒有圖」。

### 現象（真實 Production 案例）

2026-08-25 早上，國3 南向、竹林交流道－寶山交流道路段、96K+700 發生事故。
Pipeline Trace 顯示每一關都是綠的：

```
DisplayKM            = 96.7
classification       = accident
服務區域              = 在服務區內
位置精確度            = 足夠
eligibility          = 符合
lineAttempted        = 1
lineSucceeded        = 1
sharedFeedPersisted  = 是
```

但：

```
cctvEligible         = 否
cctvSkippedByReason  = —      ← 空白
imagePrepared        = —
sharedFeedWithImage  = 否
```

駕駛收到正確的文字，沒有畫面；而後台**說不出為什麼**。

### Root cause（兩個，都先在 repo 實際程式上重現過才動手）

**A. CCTV eligibility 殘留 TDX Freeway source-only 閘門**

`src/cctv/dynamicCollage.js` 的 `resolveCctvEligibility()` 原本第二關就是：

```js
if (event.source !== 'freeway') return { eligible: false, reason: 'not-freeway-source' };
```

這條在 V1.8.5 寫下時是對的——當時 TDX **就是**國道來源。
但 `TRAFFIC_SOURCE_MODE=PBS_ONLY` 之後 TDX 關閉，這條就從
「限定最可信來源」默默變成「PBS 事故一律沒有圖」。
攝影機是同一批、道路是同一條、公里數是同一個，唯一的差別是「誰通報的」。

**B. CCTV target KM 沒有使用 PBS 已解析出來的 `displayKM`**

```js
function eventTargetKm(event) {   // 修正前
  const start = parseKM(event.startKM);
  const end = parseKM(event.endKM);
  if (start !== null && end !== null) return (start + end) / 2;
  return start ?? end;
}
```

PBS **從來沒有**結構化 KM（raw 只有 road/areaNm/direction/roadtype/comment/
日期/x1/y1），所以就算解除 A，下一關仍必然是 `no-reliable-km`。

實測（本輪動手前，以真實形狀重現）：

```
CCTV eligibility 現況                      → not-freeway-source
同一筆假裝 source='freeway'（隔離第二關）   → no-reliable-km
```

**C.（第三個，本輪才發現的）eligibility 階段的 reason 從來沒有寫進 trace**

`broadcastPipeline.js` 只在 prepare 階段寫 `cctvSkippedByReason`；
在 eligibility 階段被擋下時只寫了 `cctvEligible = false`，**reason 丟掉**。
這正是後台顯示「否 / —」的原因，也正是這條過期閘門能藏一整天的原因。

### 修正方式（最小、fail-closed）

1. **來源改成「可信來源白名單」，不再要求必須是 TDX Freeway**
   `CCTV_TRUSTED_EVENT_SOURCES = { 'freeway', 'highway', 'pbs' }`，
   reason 改為 `unsupported-source`。
   仍是白名單、不是開門：公車／CMS 記錄沒有 canonical 道路名、
   也沒有經過嚴格 parser 的公里數，不得只憑「type=accident」就去查攝影機。
   （`highway` 列入純粹是對稱；省道不在 CCTV registry，會正確停在
   `unsupported-road`，不會停在來源。）

2. **`eventTargetKm()` 新增最後一層：`displayKM`**
   順序：結構化 KM 區間中點 → 單一結構化 KM → `displayKM`。
   **這不是新 parser、也不是猜**：`displayKM` 的唯一寫入者是
   `pbs/normalize.js` 的 `extractDisplayKmMatch`，該 parser 刻意嚴格
   （必須有明確的 `96.7公里` / `96K+700` / `96K` 形狀，
   「2車事故、3人受傷」這種裸數字永遠不會被誤讀成公里）。
   而且同一個值已經先通過 `traffic/locationQuality.js`，
   等於「這筆事故的位置精確到可以播報」這件事已經被驗證過了。
   從 description 自由猜 KM、從路名臆測 KM，**仍然禁止**。

3. **eligibility 階段的 reason 一律寫進 trace**，並新增 `cctvTargetKm`
   （攝影機實際對準的公里數）。

**同步修正了一則會誤導未來 Agent 的註解**：`pbs/normalize.js` 原本白紙黑字寫著
「eventTargetKm() 只讀 startKM/endKM，永遠不讀 displayKM，所以 PBS 事故不可能
因為 comment 提到公里數就取得 CCTV 資格」。那句話在本輪之後就不成立了，
已改寫成「這條邊界在 2026-08-25 由真人指令變更，以及為什麼變更後仍然安全」。
**不要留下與程式相反的註解。**

### 新的永久原則

> **CCTV 資格取決於「道路可解析 + 公里數可靠」，
> 不取決於「事件由哪個來源通報」。**

目前 confirmed CCTV-supported roads 仍只有 **國道1號 / 國道3號**
（roadId 由真實 Production TRAFFIC_KV 查證過）。
本輪**沒有**新增任何未驗證的省道 RoadID——台68 事故即使有漂亮的公里數，
仍然是 text-only。

### 邊界（全部有測試鎖住，不是靠設定旗標）

- **TDX 全程 0 呼叫**：metadata 只讀既有 `TRAFFIC_KV` cache
  （`readFreewayCctvMetadataCache`），影格只來自 `*.freeway.gov.tw`，
  R2 用既有 `CCTV_IMAGES`。cache miss / 過期 / 損毀 → `metadata-cache-unavailable`
  → TEXT-ONLY，**禁止 fallback 去 TDX**。另有結構性測試斷言
  `dynamicCollage.js` 沒有 import `tdx/auth.js` 或 `tdx/client.js`。
- **CCTV 是 enrichment，不是 eligibility**：三道播報閘門在前，且未被碰過。
  八堵事故即使能解析出完美的攝影機，仍然被服務區域擋下（有測試）。
- **任何一步失敗都退回 TEXT-ONLY**：metadata / 無攝影機 / 影格失敗 /
  逾時 / R2 失敗，都不影響事故文字播報，也不算推播失敗。
- 機動路肩維持 OFF，且它自己的 KM 路徑**沒有**被 displayKM 影響
  （仍只吃結構化 KM，有測試）。

### 可觀測性（Pipeline Trace 現在能區分）

`not-accident` / `unsupported-source` / `unresolvable-road` /
`unsupported-road` / `no-reliable-km` / `metadata-cache-unavailable` /
`no-camera` / `no-frames` / `prepare-timeout` / `r2-publish-failed`
＋ `cctvTargetKm`。
過期的 `not-freeway-source` **已從程式中消失**，不會再拿它去擋合法的
PBS 國道事故。

### 給未來 Agent 的通則

**當一個資料來源被關掉，去搜尋所有「以來源為條件」的判斷式。**
它們不會報錯，只會安靜地把整條路徑變成永遠不成立。
本專案已知有兩個這種形狀：V57.2 的國道 TDX 對應閘門（2026-08-24 修）、
CCTV 的 freeway-source 閘門（本輪）。修這一輪時已一併搜過其餘來源判斷式。

**後台的「空白理由」是一個 bug，不是一個畫面。**
「做了決定但說不出是哪一個」會讓真人往完全錯誤的方向查。

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

## 修正紀錄｜CCTV 名冊 7 天過期死結（國1 93K 事件）（2026-08-25）

### 真實事件

2026-08-25 19:01，國道一號 93K 發生事故。LINE **文字正常推播、完全沒有圖片**。
Pipeline Trace 記錄的 `cctvSkippedByReason` 是 `metadata-cache-unavailable`。

### Root Cause（以 Repo 真實程式確認，不是推測）

不是選鏡頭錯、不是 frame 抓取失敗、不是 R2 問題。是**攝影機名冊那把 KV key 不存在了**。

死結的三個環節，缺一不可：

1. `src/cctv/freewayCctvMetadataCache.js` 寫入時帶了
   `expirationTtl = 7 * 24 * 60 * 60`（7 天）。
2. 這把 key **唯一的寫入者**是 `src/tdx/hsinchuCctvProbe.js` 的 Admin-Auth 管理探針。
3. 該探針在 `TRAFFIC_SOURCE_MODE=PBS_ONLY` 之下**無法執行**——`src/tdx/auth.js`
   在此模式會直接拒發 token。

於是：最後一次探針之後滿 7 天，KV 自己把名冊刪掉，而**沒有任何被允許的路徑能把它放回去**。
從那一刻起每一筆事故都靜默失去圖片，唯一的出路是把 TDX 重新打開——而 TDX 正因額度用盡而停用。

### 這個 TTL 是分類錯誤

- **影格（frame）** 是易變資料：每次都現抓 `*.freeway.gov.tw`，本來就從不快取。
- **名冊（inventory）** 是準靜態參考資料：公路局以 24 小時為週期發布，鏡頭增建或移設才會變。

對「沒有保證補回路徑」的參考資料設定計時過期，等於把「有點舊」變成「完全沒有」。

### 修正（三件事）

1. **不再設 `expirationTtl`。** 除非有人刻意覆寫，這把 key 永久存在。
2. **寫入只能是升級，不能是降級。** 空的或格式錯誤的 record set 會被拒絕
  （`refused-empty-record-set`），所以一次失敗或被截斷的更新，不會把好的名冊換成空的。
   這個模組**沒有任何路徑可以刪除名冊**。
3. **內建官方名冊做為地板。** `data/cctv/generated/freewayCctvInventory.js` 打包了
   交通部高速公路局（NFB）open data 靜態 CCTV 名冊：1943 筆，國1 510 筆、國3 728 筆。
   即使 KV 完全是空的，也一定拿得到可用的鏡頭清單。

第 3 點才是真正解開死結的地方：名冊不再依賴「TDX 有沒有開」或「KV 有沒有活著」。
**恢復是在 deploy 當下自動發生的，不需要對 Production KV 做任何寫入。**

### 驗證（真實資料，非 mock）

以**完全空的 KV** 重跑 19:01 那筆事件，四格全中：
`CCTV-N1-S-91.800-M`、`CCTV-N1-S-94.900-M`、`CCTV-N1-N-92.675-M`、`CCTV-N1-N-94.030-L-新竹公道五路`。
國3 96.7K 同樣四格全中。

### 成本與邊界

- Worker bundle：gzip 749.54 KiB → 826.49 KiB（**+77 KiB**，上限 3 MB，用掉約 27%）。
- **TDX 呼叫數：0。** 名冊在 build 時打包進 bundle，執行期只從記憶體讀。
- **沒有新增任何未驗證道路。** `CCTV_SUPPORTED_ROADS` 仍只有國道一號（`000010`）
  與國道三號（`000030`）。名冊裡有 1943 筆，但能被選到的仍只有這兩條路。

### 官方檔案裡有一筆不在 freeway.gov.tw 的紀錄（已確認安全）

1943 筆之中，`CCTV-T64-E-23.750-M`（快速公路64號）的 `VideoStreamURL` 指向
`cctv-ss02.thb.gov.tw`（公路局主機），不是 `freeway.gov.tw`。
這是官方原始資料本來就長這樣，不是解析錯誤，所以名冊**照原樣保留**，不擅自丟棄官方發布的紀錄。

它有兩道互相獨立的屏障，任一道都足以擋下：
1. 台64 不在 `CCTV_SUPPORTED_ROADS`，選鏡頭階段根本不會拿到它。
2. 即使直接餵給 `extractFirstJpegFrame`，`isTrustedImageUrl` 會在**發出任何網路請求之前**
   回 `untrusted-hostname`（fail-closed）。

`test/cctvMetadataRecovery.test.js` 第 3b 項就是在鎖這件事，並且斷言
「非 freeway 主機的紀錄數 === 1」——**這個數字一旦變動，必須重新檢查主機白名單**。

### /health 現在會提前說話

`/health` 新增「攝影機基礎資料」卡片，顯示來源（KV／內建名冊）、筆數與資料日期，
超過 30 天標示為「過舊」，完全取不到時顯示
**「攝影機基礎資料遺失，事故文字仍可播報，但 CCTV 圖片無法產生」**。
只記數字與日期，**永遠不含 stream URL 或 record 內容**。

這是這次事件真正的教訓：缺陷本身在 2026-08-18 前後就已經發生，
但**沒有任何人知道，直到 19:01 一場真實事故用最貴的方式告訴我們**。

### 名冊如何更新（未來）

```
# 用 repo 內已 commit 的官方原始檔重建（可完整重現，byte-for-byte）
npm run build:cctv-inventory

# 用新下載的官方檔更新
node scripts/build-cctv-inventory.mjs <新的 CCTV_v2.0_*.xml>
```

`scripts/build-cctv-inventory.mjs` 在寫檔前會自我驗證，任一項不過就中止、不寫出降級名冊：
筆數 > 0、國1 > 0、國3 > 0、國1 93K±3 > 0、每筆都有 `VideoStreamURL`、每筆 `LocationMile` 都能解析。
原始 XML 已 commit 在 `data/cctv/raw/`，沿用既有的 `data/road-location/{raw,generated}` 慣例。

### 不要誤讀

- **不要把 `expirationTtl` 加回去。** 那正是這次的缺陷本身。
- **不要因為「快取應該要會過期」就改回來**——影格才是快取，名冊是參考資料。
- **不要把空的 record set 當成合法寫入**；`refused-empty-record-set` 是刻意的。
- **不要為了取得名冊而重開 TDX。** 內建名冊的存在就是為了讓這件事永遠不必要。
- **不要新增未驗證道路的 CCTV RoadID**——名冊有 1943 筆不代表可以播 1943 條路。
- **不要手動編輯 `data/cctv/generated/freewayCctvInventory.js`**，它是產生物，
  要改就改來源檔再重新產生。

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

## 修正紀錄｜Quad CCTV Prepare-Timeout 可觀測性（V1.9.0，國3 96K+700 事件）（2026-08-26）

### 真實事件

2026-08-26 09:20，國3 南向 96K+700 事故。event 進入 Shared Feed，**withImage=0**，
CCTV prepare **完全沒有 completion log**（沒有 imagePrepared、沒有帶 stage 的
cctvSkippedByReason）。09:30（下一個 Cron tick），**同一事件**重新處理：
candidates=1、eligible=1、attempted=1、attached=1，quad image **成功**。

攝影機名冊、道路解析、CCTV 整體能力因此**不是**永久失效——問題是
「第一次為什麼失敗、失敗在哪裡完全看不出來」。

### Root Cause（以程式碼檢視＋7 項決定性測試確認，非推測）

`cctv/dynamicCollage.js` 的 quad（事故）路徑**完全沒有 stage 追蹤機制**。
動態路肩單鏡頭路徑（`prepareSingleCctvImageWork`）早就有：一個
`stageTracker` 物件在 metadata/candidate-selection/frame-fetch/r2-publish
四個邊界被更新，逾時時讀出 `timeoutStage`。quad 路徑從來沒有這個機制——
它的 `prepare-timeout` 結果從不帶 stage、不帶部分影格數、不帶任何部分計時。

因此：**09:20 沒有 completion log，不是漏記，是根本沒有東西在記錄。**
任何一次真實的外部延遲（frame fetch、JPEG compose、R2 publish——
三者已用決定性測試證實共用同一個 4000ms budget）在那個當下都是結構性不可見。

### 誠實揭露：沒有證實的部分

**09:20 當下具體是哪一段外部 I/O 慢，本輪無法從既有證據回推。**
那天的 Pipeline Trace 沒有 stage 級別資料——正是本輪要補的缺口。
不把「可能性」寫成「事實」；具體外部歸因誠實地標示為未知，
若再發生，本次修復之後就會有完整 stage 級別紀錄可查。

### 用決定性測試證實的機制（`test/cctvQuadPrepareForensics.test.js`，7 項 A-G）

- **FRAME_FETCH_MODE = PARALLEL**：`composeCollageFromCandidates` 是
  `Promise.all` 同時發起 4 支候選，實測 4 支 fetch 的起始時間差 <100ms
  （測試 D：4 支各延遲 1200ms，總耗時 ~1200ms 而非 ~4800ms）。
- **SLOW_CAMERA_CAN_BLOCK_ALL = YES**：單一支延遲或永遠不回的候選，
  會拖住整批 compose——`Promise.all` 等所有 4 支都 settle，每支各自的
  逾時（`AbortSignal.timeout`）都源自同一個剩餘 run budget，不是各自獨立
  的固定值（測試 B、C）。
- **4000MS_BUDGET_SCOPE**：frame-fetch、collage compose（序列解碼
  最多 4 張 JPEG）、R2 publish **三者共用同一個** 4000ms budget，
  不是分開計時的三個獨立階段（測試 E：人工拖慢 compose 單獨就能耗盡
  budget；測試 F：人工拖慢 R2 PUT 單獨也能耗盡 budget）。
- **TIMEOUT_ABORTS_UNDERLYING_WORK = NO**：outer race 逾時後，
  背景中的 `work`（`prepareCctvImageWork`）不會被中止，會自行跑完
  （受限於自己每個階段各自的 timeout），結果被安全丟棄——這是既有、
  刻意的設計，本輪只是用測試直接證實它，不是新發現的缺陷（測試 C）。

### 修正

`prepareCctvImageWork` 比照單鏡頭路徑加上 `stageTracker`，在四個邊界
（metadata／camera-selection／frame-fetch／r2-publish）記錄進度與耗時。
`composeCollageFromCandidates`（`hsinchuCctvProbe.js`）額外回報
`frameFetchElapsedMs`／`collageElapsedMs`／`successfulFrameCount`／
`failedFrameCount`（累加式欄位，既有回傳形狀不變）。`broadcastPipeline.js`
在三個既有呼叫點（LINE push 主迴圈、feed-only 回填、
`topUpSharedFeedCctvImages`）把 7 個新欄位接進 Pipeline Trace，
`pipelineTrace.js` 的 `buildTraceEntry` 白名單新增對應參數。

**全部欄位皆為純數字或短字串，測試 G 鎖定絕不含 stream URL、candidate
record 或 frame bytes**——沿用既有的 whitelist-only 紀律。

**禁止再出現「prepare-timeout 但 timeoutStage=null」**：quad 路徑現在
無論成功／失敗／逾時，都至少留下已完成階段的計時，逾時時額外帶
`timeoutStage`。

### RETRY_REQUIRED = NO

本輪**沒有**新增任何 retry、第二輪 fetch、fallback，**沒有**調整
4000ms 這個數字。純粹是可觀測性 + 既有 outer race 行為的直接證實，
不是行為變更。

### 防死亡螺旋（Phase 5，以程式碼證實）

- `MAX_FRAME_FETCH_PER_EVENT = 4`（`QUADRANTS.length`，固定常數，
  本輪未變動）。
- `MAX_RETRY_PER_EVENT = 0`：`prepareCctvImageForEvent` 每個事件每輪
  恰好呼叫一次，沒有迴圈、沒有第二次呼叫（本來就沒有，本輪也沒加）。
- Cron 不會因 CCTV 卡死：outer `withTimeout` race 保證呼叫端一定在
  `budgetMs` 內被釋放，不受背景工作影響（測試 B/C 再次證實）；
  `src/index.js` 的 `scheduled()` 用
  `ctx.waitUntil(runScheduledTdxSync(...))` 包住整輪，沒有任何東西把
  被丟棄的逾時 `work` 串接上去——一旦這輪本身的 promise settle，
  isolate 對那個被丟棄的 straggler 沒有進一步保活義務，而 straggler
  自己每個階段都有時間上限（KV get、每支 frame fetch 各自的
  `AbortSignal.timeout`、in-process JPEG codec、單次 R2 PUT），
  不可能無限跑下去。

### 未實作的優化（誠實記錄，非本輪範圍）

「3 支已成功、1 支還在等」的情境——讓已成功的 3 支不必等到第 4 支逾時
才組圖——是一個真實存在、但本輪**未實作**的可能優化。呼叫端的 outer
race 早已保證不影響 LINE 文字準時推播，這個優化只影響「能不能在還有
一點剩餘時間時多組出一張 3/4 的圖」，屬於錦上添花而非本輪已證實的
Root Cause 範圍，留待有實際 Production 證據支持時再處理，也留待有
真實資料能證實這值得做的時候。

### 不要誤讀

- **不要以為 09:20 具體慢在哪一段已被證實**——只有「沒有 stage 追蹤」
  這個結構性缺陷被證實。
- **不要把 `timeoutStage='frame-fetch'` 誤解為一定是頻寬慢**——它涵蓋
  frame fetch 與 compose 兩個子步驟（同一個 await 內，無法從外部進一步
  拆分），這個粒度限制已誠實揭露在程式註解與測試裡。
- **不要把這次修復理解成加了 retry 或加大了 timeout**——4000ms 完全
  未變動。
- **不要因為證實了「slow camera 拖住整批」就去把 `Promise.all` 改成
  `Promise.allSettled`**——`extractFirstJpegFrame` 本來就從不 throw，
  改了也不會改變任何行為，不是真正的修法。

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
