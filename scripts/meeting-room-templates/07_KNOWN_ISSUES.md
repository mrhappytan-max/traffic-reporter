<!-- title: 已知問題 -->

# 07. Known Issues

## 已知、無關、既有的測試失敗基準線

**實測基準（2026-08-24 量測，非回憶）：`npm test` 共 1060 項，17 項失敗。**
這 17 項在乾淨 checkout 上同樣失敗（每輪以 `git stash` 對照驗證），與功能變更無關：

1. `pbs-relay/tests/*`（2 項）— 獨立子系統，非本 Worker 主程式。
2. CCTV / JPEG codec 相關（13 項）— 依賴 Workers-only 的 `.wasm` codec，在此沙盒環境無法載入：
   `broadcastCctvIntegration`、`cctvCollage`、`cctvImagePublish`、`cctvPrepareTimeoutStages`、
   `dynamicCollage`、`dynamicShoulder`、`dynamicShoulderMessageShort`、`freeway3CctvAudit`、
   `hsinchuCctvCollageEndpoint`、`pipelineTraceIntegration`、`productionIntegrationFixtures`、
   `singleCctvBudgetFairness`、`testJpegCodec`。
3. `test/healthQuotaDashboard.test.js`（2 項）— wall-clock 相依，會隨真實日期自然過期。

若出現這 17 項以外的新失敗，才視為真正回歸。

**另有一個會自行復原、不要誤判成缺陷的情況**：
`test/deploymentPolicyAndVerify.test.js` 第 12 項比對 `origin/main`（見
`scripts/verify-production-deploy.mjs:120`）。本機 main 已 commit 但**尚未 push** 時，
它必然失敗；push 完成後自動恢復通過。這是「還沒推送」的狀態產物，不是程式缺陷，
**不要為它修改任何程式**。

舊版本文件曾記載「1153 項中 3 項失敗」與「998 項中 18 項失敗」，
兩個數字都已過期，以本節實測數字為準。

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

### 給未來 Agent 的通則

**閘門的判準，必須和訊息真正會顯示的內容一致。**
用一個駕駛看不到的欄位去證明「位置夠精確」，等於為假精確背書。

**「查不到」和「沒發生」是兩件事。**
任何有上限的掃描，都必須把上限講出來；把沉默的截斷呈現成空結果，
會讓真人把讀取側的 bug 誤判成資料遺失，往完全錯誤的方向查下去。

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
