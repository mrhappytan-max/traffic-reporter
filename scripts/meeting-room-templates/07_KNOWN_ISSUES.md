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

## 封版紀錄｜TDX_QUOTA_PROTECTION_PBS_ONLY = SEALED（2026-08-23，壓縮摘要）

已由真人正式封版，下一個 Agent 不需接手。`TRAFFIC_SOURCE_MODE=PBS_ONLY` 閘門已 push main 並部署，10 項專用測試全數通過。真人 `/health` 實機確認為選擇性補充證據（沙盒無 Production 網路存取，`verify:production=PASS_NETWORK_VERIFICATION_BLOCKED`），不構成 blocker——若日後取得反面證據視為新事故，非本輪未完成。額度恢復時直接套用下方 RESTORE TDX 程序，不需新版本。

## KI｜LINE Push 額度保護 — 重大事故限定主動播報（2026-08-23，**生效中**，壓縮摘要）

**狀態**：`ACTIVE_TEMPORARY_PUSH_POLICY`（與 TDX 額度無關，第二個外部額度限制：LINE 官方帳號輕用量方案每月主動 Push 額度有限）。開關：`wrangler.jsonc` 的 `LINE_PUSH_POLICY`（目前 `MAJOR_ACCIDENT_ONLY`，改 `ALL_ELIGIBLE` 回舊行為，實作於 `src/traffic/broadcastPolicy.js`），疊在既有 V1.5 白名單之後、只會減少不會增加可播事件。判定條件：`通過V1.5白名單 AND type==='accident' AND 非機動路肩`（`type` 沿用既有 `pbs/classify.js` 分類器，非新發明）。**刻意不加「必須寫明車道受阻」關鍵字條件**——PBS 無 severity/impact 結構化欄位，唯一可行做法是自由文字關鍵字比對，已實作並經證據否決（讓既有 47 項測試失敗，等於把單純 accident 降級出「可播」範圍，且會靜默丟棄未寫明阻塞的真實重大車禍，錯在危險側）。誠實缺口：目前「所有通過白名單的 PBS 事故」都會播，比字面「不是所有 PBS 車禍都 Push」寬；補救非用猜的——`resolveRoadImpact()` 仍計算並記錄哪些事故確實寫明通行受阻（`policy-major-accident-blocked-lanes`/`policy-major-accident-impact-keyword`/`policy-accident-no-stated-impact`），未來依 `ineligibleByReason`/Pipeline Trace 實際數據決定是否收緊。

機動路肩：`DYNAMIC_SHOULDER_PUSH=OFF`（OPEN/STOPPED 皆不進主動 Push），parser/classifier/resolver/formatter/單鏡頭 CCTV 策略/測試全保留不刪，自己有獨立擋下規則（非靠「非accident」順便擋）。CCTV 重新開啟且仍 0 次 TDX 呼叫：`CCTV_IMAGE=ON_WITHOUT_TDX_REFRESH`——播報路徑攝影機 metadata 讀 KV 快取（`freewayCctvMetadataCache.js` 自身註解："cache-only — NEVER calls TDX"），影格來自 freeway.gov.tw 非 TDX，`dynamicCollage.js` 結構上不 import 任何 TDX 模組，0 TDX 呼叫是結構性保證非承諾；快取不足安全降級 TEXT-ONLY，CCTV 失敗永不擋事故/不 throw。

測試影響：部分既有測試用 construction/closure/other 當機制測試載具，改帶 `LINE_PUSH_POLICY:'ALL_ELIGIBLE'` 繼續測原機制；Production 政策行為另釘在 `test/pbsCctvMajorAccidentOnly.test.js`。本輪新增失敗 0。

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

## 修正紀錄｜PBS_ONLY 下不得要求 TDX 對應（2026-08-24，壓縮摘要）

**一句話**：TDX 是**停用**的資料來源，不能反過來拿「沒有 TDX 對應」去擋 PBS。真實案例：PBS 國道一號南向事故被判 `gated-freeway-no-tdx-match`。根因：`src/pbs/crossSourceDedup.js` 的 V57.2「TDX 唯一播報閘門」原設計「PBS 國道事件等 TDX 對應」，但這理由只在 TDX 有在跑時成立——`PBS_ONLY` 下 TDX 永遠不會出現，「等 TDX」變成「永久否決」。修正：新增 `requireTdxCorrelationForFreeway` 旗標（由 `isTdxRuntimeEnabled(env)` 導出，與關閉 TDX 同一開關），`PBS_ONLY` 下略過閘門，`ALL` 模式下 V57.2 原封不動；預設值 `true`（未來呼叫端忘記傳會退回保守既有行為）。**未放寬播報政策**——略過閘門只是讓國道 PBS 事件進候選清單，事故限定 push policy／時效視窗／去重／抑制全部照舊，機動路肩仍不播。CCTV 維持「附加資訊，非播報資格」，無圖仍 TEXT-ONLY 播報。給未來 Agent 的通則：任何「等待另一個來源佐證」的閘門，都必須先問那個來源是否還活著，否則來源一旦停用，閘門會從「延後」靜默變成「永久否決」——本專案已知只有此一處。

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

## 修正紀錄｜Windows → Cloudflare Debug-only Push Endpoint（V1.9.5）（2026-08-27，壓縮摘要）

**一句話**：新增 `POST /internal/pbs-debug-push`，本輪只證明一條鏈（Windows 發 payload → Cloudflare 驗身份／格式／冪等 → 寫 log → ACK），`WINDOWS_PUSH_ENABLED=NO`，未整合進正式 Pipeline。身份驗證用獨立 Secret `PBS_DEBUG_PUSH_SECRET`（雜湊常數時間比對，證實不回退到 `PBS_RELAY_TOKEN`／`ADMIN_PASSWORD`／任何 LINE/TDX secret，未設定=503、錯誤=401，secret 不外洩）。Payload 白名單校驗＋16 KiB 上限。**結構性 debug-only 邊界**：`debugPush.js` 完全不 import LINE/CCTV/Shared Feed/Pipeline Trace/`pbs/lifecycle.js`/`pbs/pipeline.js` 任一模組，也不觸碰 `env.TRAFFIC_KV`——不是旗標而是沒有 import path。冪等判斷本輪刻意**不**加 KV 寫入，改用 per-isolate 記憶體 fingerprint Map，誠實回報 `NOT_PERSISTENT`（V1.9.7 後補上持久層，見下）。33 項新測試，NEW FAILURES=0。部署後 Claude Browser 驗證、Windows 端接 client 皆待真人授權，本輪未把 secret 交給 Windows。

## 修正紀錄｜Pipeline Trace 讀取效能優化（V1.9.4）（2026-08-27，壓縮摘要）

**一句話**：真人在 Production 實測 `/admin/pipeline-trace`／`-view` TTFB ≈59.1s（其餘頁面 <1s）。Root cause：舊 `collectFlattenedTraceEntries` 不論有無篩選一律循序解碼到 `MAX_ENTRIES_SCANNED`(500) 筆才套 `limit`。修正為 `scanTraceEntriesProgressively`：無篩選提前停止（500筆/limit60 → 只 60 次 `kv.get()`）＋有篩選漸進式掃描（首輪 `boundedLimit+20`，之後 ×2，上限仍 500）＋同輪內固定 20 筆一批 `Promise.all` 並行。V1/V2 schema 並存策略不變，兩前綴 `kv.list()` 改並行。新增可觀測性欄位（讀既有已算出的數字，零新增 KV 寫入）。23 項新測試，NEW FAILURES=0。未觸碰寫入路徑／PBS 排程閘門／Health Snapshot／LINE／CCTV／TDX／Cron 頻率。

## 補登紀錄｜WINDOWS_PBS_GEOGRAPHIC_FILTER_REPAIR（2026-08-30，人類回報，本 Cloud Session 未獨立驗證）

**狀態：`HUMAN_REPORTED_NOT_INDEPENDENTLY_VERIFIED`。** 人類回報：Windows PBS 本機篩選舊邏輯先套用 `isAccident()` 事故關鍵字語意閘門，才進新竹縣市地理判斷，導致非事故型事件（落石／坍方／封路／施工／積水等）即使位於新竹縣市仍可能在 Windows 端被直接丟棄，從未進入 Cloudflare/AI。回報修正：移除 `isAccident()` 語意閘門，改用 point-in-polygon（data.gov.tw dataset 7442 縣市界線）取代原本的矩形邊界，新竹市/縣**所有**事件類型皆納入候選，語意判斷完全交給 AI；同批資料驗證回報 `BEFORE_KEEP_COUNT=11 → AFTER_KEEP_COUNT=29`（找回 18 筆），`TESTS=124 passed/0 failed`。**本 Cloud Session 的獨立查證**：目前 `main`／本分支的 `pbs-relay/src/localPrototype.js` 仍保留 `isAccident()` 並仍作為候選閘門使用（見該檔第 56/108 行），`pbs-relay/` 完整 git 歷史（含 `feature/pbs-local-edge-filter-prototype` 分支）中**未找到**對應此修正的 commit，故無法核對回報的 point-in-polygon 實作、dataset 7442 引用或 11→29/124 測試數字。與既有 `PBS Windows Local Edge Debug Push Integration`（V1.9.6）記錄採同一誠實原則：**本節只記錄「人類回報了什麼」，不代表本 Session 已驗證程式碼或測試結果為真**——待對應 commit 出現於本 repo（或人類提供可核對的 diff/測試輸出）後，下一輪應改記為已驗證版本，並同步更新 `pbs-relay/` 程式碼本身（本輪禁止修改）。

## 修正紀錄｜V2.3.3 — CCTV_R2_READBACK_VERIFY_BEFORE_LINE（2026-08-31）

**背景**：先前一輪唯讀查核（`CCTV_IMAGE_READY_BEFORE_LINE_PUSH_AUDIT`）逐函式追蹤真實 AI-approved 廣播路徑（`handlePbsAiQueueBatch → AI decision → runAiApprovedPbsBroadcast → prepareCctvImageForEvent → composeQuadrantCollage → publishCollageImage → R2 bucket.put → publicImageUrl → LINE pushMessage`），確認 await 鏈本身已經安全：R2 put 完整 await、public URL 只在 R2 put 成功後才建構、LINE push 一律晚於兩者。但該查核**無法**用應用層時序缺陷解釋一筆真實回報的破圖事故（LINE 端遠端抓取行為不在本 repo 可視範圍內）。

**決策**：停止對 LINE 端行為的無止盡追查，改為新增本 codebase 真正能自己保證的一件事——CCTV 圖片成功寫入 R2 後，Cloudflare 自己再讀一次確認圖片真的可讀，通過才把 imageUrl 交給 LINE。

**修正**：新增 `src/cctv/publishedImage.js#verifyPublishedImageReadable(bucket, id)`——純內部 R2 GET（絕非對本 Worker 自己 public endpoint 發 HTTP 請求），確認：(1) 物件存在、(2) Content-Type 確實為 `image/jpeg`、(3) bytes 非空；任一失敗或 GET 本身拋出例外，一律視為讀回失敗。接上 `src/cctv/dynamicCollage.js` 兩個既有 R2 發布點——`prepareCctvImageWork`（quad／事故路徑）與 `prepareSingleCctvImageWork`（single／動態路肩路徑），兩者共用同一個 `publishCollageImage()`、也共用同一套下游 LINE image message 組裝，因此同步保護，不留下半修的缺口。新失敗代號 `r2-readback-failed`，與既有所有 CCTV 失敗原因採**完全相同**的 fail-closed 處理：文字照常送、圖片跳過、不重試、不重新 publish、不影響事故文字本身。

**明確未觸碰**：15 分鐘 published-image TTL、previewImageUrl／originalContentUrl 架構、CCTV 選鏡策略、四象限版面、圖片尺寸／JPEG quality、LINE Push 單一 payload 模型、AI Prompt／Model、Cloudflare Queue、Windows PBS、TDX、Google Maps；既有 await 順序（R2 put → public URL → LINE push）本身未重排，只在「R2 put 成功」與「imageUrl 回傳」之間多插入一個新的 await 步驟。`TDX_CALL_CHANGE=0`（新讀回只是一次 `bucket.get()`，非 `fetch()`）。TTL 問題仍是獨立、本輪刻意不處理的可靠性議題。

**測試**：`test/dynamicCollage.test.js` 新增 CASE 1-5、7/8（共 6 項，quad 路徑：成功／get 回 null／bytes=0／content-type 錯誤／get 拋出例外／0 額外 TDX 呼叫），`test/dynamicShoulder.test.js` 新增 19b（single 路徑的 CASE 2 對應版本）。另有 9 個既有測試檔的 `r2Bucket()` mock 補上 `httpMetadata` 傳遞（與真實 R2 行為一致——`publishCollageImage` 一律傳 `httpMetadata:{contentType:'image/jpeg'}`，mock 先前未保存此欄位，補上後所有既有成功案例維持原本行為不變）。全量迴歸 1729/1695/34，與既有 34 項基準以 failure 名稱集合對照確認 NEW FAILURES=0，僅跑一次。`APP_VERSION` V2.3.2→V2.3.3（PATCH）。

## 修正紀錄｜V2.3.2 — CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR（診斷工具修復）（2026-08-30）

**真實事件**：`EVENT_ID=11508310005-5`，LINE 送達的 CCTV 圖片破圖。唯一能直接驗證「剛 publish 完的 `/cctv/image/:id` 是否真的立即 200+JPEG」的診斷工具——`GET /admin/cctv-hsinchu-publish-test`——本身無法使用：它依賴只有 `/admin/cctv-hsinchu-probe` 才能重新產生的 `CANDIDATES_KEY` 快取，而該 probe 會發起真實 TDX API 呼叫，在 `TRAFFIC_SOURCE_MODE=PBS_ONLY` 下不可為了診斷而消耗。

**修正**：publish-test 端點改為從**同一份** `cctv:freeway-metadata:v1` 攝影機清單快取（真實事故動態播報路徑早已 cache-only 讀取、從不碰 TDX）取得候選——新函式 `composeCollageFromFreewayMetadata()`（`hsinchuCctvProbe.js`）串接 `readFreewayCctvMetadataCache()`（cache-only，KV 無資料時退回官方 NFB 內建清單 1943 筆真實記錄，實測連空 KV 都能在固定測試點涵蓋 4 象限中的 3 個）→ `selectFourQuadrantCandidates()`（既有 fixed-target admin probe 已在用的同一個四象限選鏡函式，同一組預設值，未新增鏡頭排序政策）→ `composeCollageFromCandidates()`（本專案所有 collage 路徑共用的同一套抓取/合成核心，非另一條分歧邏輯）。`TDX_CALLS_PER_TEST=0` 為測試直接驗證（斷言無任何 fetch 呼叫觸及 `tdx.transportdata.tw`），非僅推論 import graph。

**失敗分類**：舊工具「CCTV candidate cache unavailable」單一訊息無法區分成因，新版回應新增 `step` 欄位：`METADATA_CACHE_MISSING`／`NO_CCTV_CANDIDATES`／`SNAPSHOT_FETCH_FAILED`（連 JPEG SOI/EOI 完整影格都沒抓到）／`COMPOSE_FAILED`（影格抓到但真實解碼器仍失敗，兩者以 `composeCollageFromCandidates()` 新增的**純累加**欄位 `anyFrameFetchSucceeded` 區分，沿用 V1.9.0 同一函式已建立的「on every outcome」慣例，對既有呼叫端零行為變化）／`R2_PUBLISH_FAILED`。成功回應補齊必要欄位：`status`/`published`/`contentType`/`bytes`/`createdAt`/`expiresAt`/`imageUrl`（`createdAt` 自 V1.8.4 起就有算但從未回傳，純累加修正）。

新增/改寫 22 項測試（`test/cctvImagePublish.test.js`，含 order CASE 1-7、空 KV 靠內建清單成功、SNAPSHOT_FETCH_FAILED 與 COMPOSE_FAILED 各以實測驗證過的 fixture 明確區分、CASE 7 驗證絕不觸發 PBS/AI/Queue/LINE），全量迴歸 1722/1688/34，NEW FAILURES=0。`APP_VERSION` 從 `V2.3.1` bump 為 `V2.3.2`（PATCH — 診斷工具修復，非 CCTV 產品功能）。本輪**未觸碰**：PBS、Windows filter、Cloudflare Queue、AI 決策路徑、正式 LINE 廣播、CCTV 鏡頭排序政策、真實事故 CCTV 選鏡/計時/預算邏輯本身、Shared Feed、TDX 本身運作、Google Maps、Observatory 主流程；`/admin/cctv-hsinchu-collage`（固定目標 probe/collage 配對，CANDIDATES_KEY）未受影響。詳見 `hsinchuCctvProbe.js` 自身 module comment 的完整記錄。

## 修正紀錄｜V2.3.1 — DIRECT_COORDINATE_MAP_FALLBACK（LINE 地圖座標直連 Hotfix）（2026-08-30）

**真實事件**：`EVENT_ID=11508260158-0`，竹60線（縣道）新竹縣尖石鄉坍方封路事件。PBS／Windows／Cloudflare 全程保留有效 x1/y1 座標，AI 正常完成，LINE 已發送，但**完全沒有 Google Maps 連結**。**根因**（同日先行完成的唯讀查核已確認）：`messageFormat.js#buildRoadLines()` 的兩層地圖連結解析（`resolveKmLocation` 道路+KM 路徑、`resolveCoordinateLocation` 座標路徑）都要求 `event.road` 先被 `canonicalFreewayRoad()`／`canonicalProvincialRoad()` 辨識成「國道X號」或「台X線」才會使用座標——竹60線這類縣道／鄉道從未被本專案僅有的官方國道（95016）／省道（7040）公里標資料集涵蓋，座標路徑因此在真正比對座標之前就被 road 判斷擋下，有效座標被完全捨棄。

**修正**：新增一層**最後手段**（僅在既有兩層都失敗後才觸發）：`kmLocationResolver.js` 新匯出 `buildDirectCoordinateMapUrl(latitude, longitude)`，直接重用既有 `buildMapUrl()` 產生 `📍 地圖 https://maps.google.com/?q=lat,lon`，**不辨識道路、不查資料集、不猜測 sectionLabel/locationLabel/鄉道名稱/公里位置**——只決定地圖那一行有沒有連結，不影響上方文字。座標合法性把關（`isValidRawCoordinate`）：拒絕 null/undefined/NaN/Infinity/非數字型別/超出緯經度合法範圍/精確 (0,0)「null island」。`roadName.js`／`canonicalFreewayRoad`／`canonicalProvincialRoad`／官方資料集本身皆**未觸碰**——縣道/鄉道公里標資料工程仍是刻意未開始的更大範圍問題。

新增 `test/pbsCoordinateDirectMapFallback.test.js`（13 項：拒絕輸入型態單元測試、CASE 1-6、含真實 `EVENT_ID=11508260158-0` 端對端 fixture，road 全程維持「新竹縣-尖石鄉」，未硬編碼「竹60」）；既有 KM/座標解析測試檔全數重跑不變、全部通過，證實零回歸。全量迴歸 1718/1684/34，NEW FAILURES=0。`APP_VERSION` V2.3.0→V2.3.1（PATCH）。本輪**未觸碰**：AI Prompt/model、Windows PBS filter、Queue、LINE 廣播政策、Observatory 架構、TDX、CCTV，亦未開始縣道／鄉道公里標資料工程。詳見 `kmLocationResolver.js` 的 `buildDirectCoordinateMapUrl` 自身 header comment。

## 修正紀錄｜V2.3.0 — PBS AI Queue Reliability，Cloudflare Queues 取代 ctx.waitUntil（2026-08-30）

**真實 Production 事故**（與 V2.1.0 修的是不同一種失敗模式）：`EVENT_ID=11508290166-0` 成功抵達 Cloudflare 並啟動 Workers AI 呼叫（16:49:03.112），但 AI 呼叫本身在 Cloudflare 自己的 `ctx.waitUntil()` 背景執行時間預算到期前未能回傳——與 Windows 自身的短 HTTP timeout（V2.1.0 已解決）完全無關的另一種限制。16:49:32.912 平台強制取消整個 task（"waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled"），AI 決策永久遺失，冪等紀錄卡死在 `PROCESSING`。`REAL_INCIDENT_ROOT_CAUSE = WAITUNTIL_BACKGROUND_WINDOW_EXCEEDED`。

**修正**：`ctx.waitUntil()` 全面**退休**做為 AI 背景執行載體（`WAITUNTIL_AI_PROCESSING='RETIRED'`），改用**唯一一個** Cloudflare Queue（`pbs-ai-processing-queue`，binding `PBS_AI_QUEUE`，`wrangler.jsonc` 為唯一正典設定來源）：HTTP ingress（`handlePbsDebugPush`）只驗證／寫冪等 PROCESSING／寫 Observatory `PROCESSING_STARTED`／`Queue.send()`，**只有 send 成功才 ACK** `accepted:true`（send 失敗回傳真實 503，絕不假報已接收）；獨立的 Queue Consumer（`src/index.js` 新增 `queue()` export → `handlePbsAiQueueBatch` → `processQueuedPbsEvent`）承接全部 AI／LINE／Observatory-final 工作，與原始 HTTP request／`ctx` 完全無關，且**重用**（非重造）既有 AI candidate／decision engine／cache／LINE 廣播／Observatory writer。

**重試邊界（本輪關鍵設計）**：`AI_CALL_FAILED`（呼叫本身未可靠完成——網路／5xx／容量／timeout）現在可 Queue 重試，`MAX_QUEUE_RETRIES=3`；**既有** `AI_DECISION_INVALID`（呼叫已完成但答案格式無效）fail-closed 政策**維持不變**——絕不重試，第一次嘗試即為終態，不放寬「重新問 AI」。新增唯一一個最小終態 `AI_OUTCOME.PROCESSING_FAILED`（重試耗盡後由 Consumer 自己寫入，標記冪等 `COMPLETED`，絕不讓事件永遠卡在 PROCESSING，也不依賴未設定的 Cloudflare DLQ 靜默解釋）。Queue 遞送為 `AT_LEAST_ONCE`（`QUEUE_DELIVERY_MODEL`），業務結果要求 `EFFECTIVELY_ONCE`（`BUSINESS_OUTCOME_MODEL`）：已 `COMPLETED` 的重複遞送直接 ack 略過，0 次額外 AI 呼叫／LINE 推播。

**開發期間發現並修正的一個 Observatory KV key 重複 bug**（非原始設計預期，測試驅動發現）：Queue Consumer 是獨立 invocation，自己的 `now` 與 HTTP ingress 原始接受時間不同，若直接沿用會讓最終寫入建立第二筆 KV 紀錄而非覆寫早期 `PROCESSING_STARTED` 紀錄。修正：從 queue message 自帶的 `acceptedFirstAcceptedAt` 重建 `observatoryNow`，專供兩次 Observatory 寫入的 KV key 使用，同時保留真實當下 `now` 給所有真正的業務決策（AI 呼叫、LINE 播報時段閘門）與 `markProcessingComplete` 的 `completedAt`。

`RAW_PBS_TEXT_POLICY=IMMUTABLE_END_TO_END_UNTIL_AI` 不變：queue message 的 `event` 為原始物件的逐字淺拷貝。**KV 成本**（實測）：`puts=4N+2`（與 V2.2.0 完全相同，0 額外寫入／事件），`gets=6N`（+1／事件，Consumer 自己的冪等 re-check）。**Queue 成本**（工程估算，sandbox 無即時 Cloudflare 帳單存取）：成功事件 2 次 operation（1 send + 1 consume-ack），重試耗盡的最差情況 5 次 operation（1 send + 4 次 consume attempt）；50/100/200 事件/日最差情況分別為 250/500/1000 次，遠低於官方文件 10,000/日免費額度。新增 `test/pbsAiQueueReliability.test.js`（含真實事故 `EVENT_ID=11508290166-0` 迴歸 fixture，用可控制 Promise 模擬 30+ 秒 AI 延遲，非真實 30 秒 sleep），改寫 `test/pbsDebugPushBackgroundProcessing.test.js` 5 項過時 `ctx.waitUntil` 前提測試。全套測試 1705 項／1671 pass／34 fail，失敗清單與既有基準線逐項相同（NEW_FAILURES=0）。`APP_VERSION`：V2.2.0 → V2.3.0（MINOR）。本輪未觸碰：Windows PBS filter、Windows 自身 HTTP timeout、PBS 原始文字、AI prompt/model/semantic policy、service area、LINE formatter、driverSummary、hourly reminder、TDX、CCTV、Shared Feed、LINE 廣播規則、Observatory 頁面整體 UI。`BROWSER_ACTION_REQUIRED`：真實 Cloudflare Queue 資源（`pbs-ai-processing-queue`）需要在 Cloudflare Dashboard／`wrangler queues create` 建立——本 sandbox 無即時 Cloudflare API/Dashboard 存取權限驗證或建立，不可假設已存在。**2026-08-30 補記**：另一份人類回報稱「V2.3.0 已由 Production 真實事件驗收完成」，但本 Session 未取得可核對證據（真實 Observatory 記錄／Queue 資源存在確認），故本欄位維持原狀，不逕自改記為已驗證——待證據提供後再更新。

## 修正紀錄｜V2.2.0 — AI Decision Observatory 四層事件生命週期（2026-08-29）

**產品目標**：把既有 AI Decision Observatory（`/admin/pbs-ai-observatory-view`）
升級成「單一事件四層生命週期查修頁」——① PBS/Windows ② Cloudflare ③ AI
④ LINE，每層各自顯示成功／未執行／失敗／未知四種狀態，一眼看出事件卡在
哪一層，不需翻 Cloudflare log。純 backward-compatible 觀測/UI 擴充，
**未改** AI semantic authority、Windows PBS filter、LINE policy、
V2.1.0 的 ctx.waitUntil 架構。

**RAW_PBS_TEXT_VISIBLE**：`src/pbs/aiObservatoryIndex.js` 的
`commentSummary`（原截斷至 120 字）退休，改為 `rawComment`／
`rawSourceDetail`——PBS 原始自由文字欄位，完整未截斷儲存，與既有解析欄位
（road/direction/areaNm/displayKM）獨立標示，絕不合併覆蓋。

**FAILURE_EVENT_VISIBILITY**（本輪真正要補的缺口）：一筆事件的
`ctx.waitUntil`（V2.1.0）背景處理若中途 crash 或從未跑完，原本 Observatory
index 完全不會留下任何紀錄（原本只在處理「最尾端」寫入一次）。本輪
`src/pbs/debugPush.js` 的 `processAcceptedEvent` 在 business processing
「一開始」就先寫入一筆 `AI_OUTCOME.PROCESSING_STARTED` 紀錄（直接取自
Windows 原始 payload 欄位，寫在任何可能 throw 的程式碼之前），既有的
「最終」寫入之後原地覆寫同一把 KV key（`idempotencyKeyHash` +
`taipeiDate` + 接受當下的 `now` 三者相同）。停滯／crash 的事件因此仍有
一張卡可查（凍結在 `PROCESSING_STARTED`），不再完全消失。

**KV 成本**（實測，非估算，見
`test/pbsAiObservatoryFourLayer.test.js` 的 KV cost formula 測試）：
`EXTRA_KV_WRITES_PER_ACCEPTED_EVENT = 1`。
`KV_NEW_FORMULA：puts = 4N + 2`（idempotency PROCESSING+COMPLETED、
observatory PROCESSING_STARTED+最終、+1 incident-suppression-state、
+1 shared-feed／整輪一次）——50/100/200 accepted events/day 分別為
202/402/802 puts/day，遠低於 Cloudflare Workers KV Free Plan 每日
1,000 次寫入額度。REUSE_EXISTING_DATA_FIRST 全程遵守：Cloudflare 層
PROCESSING/COMPLETED 狀態改為**即時讀取**既有 V2.1.0 transport
idempotency 記錄（`computeIdempotencyKeyHash`／`buildIdempotencyKvKey`
自 `debugPush.js` 匯出重用，非第二套 hash 實作）；AI 層 notify/impact/
reason/confidence 仍即時讀取既有 `aiDecisionCache` 記錄，未重複儲存。
**零新增 KV prefix**。

**零副作用不變**：開啟／重新整理／搜尋／篩選本頁仍是 0 次 Workers AI
呼叫、0 次 KV 寫入（僅讀取：既有的每列 aiDecisionCache 查詢 ＋新增的
每列 transport-idempotency-status 查詢——讀取本身不受本輪規則限制，
只有寫入才要求 0）。

`APP_VERSION` 從 `V2.1.0` 升為 `V2.2.0`（MINOR，backward-compatible
observability 擴充）。新增 16 項測試
（`test/pbsAiObservatoryFourLayer.test.js`，涵蓋 order 十二的全部
20 項最低要求），既有 `aiObservatoryIndex.test.js`／
`aiObservatoryView.test.js`／`pbsDebugPush.test.js` 的相關斷言同步更新
（截斷測試 → 完整性測試；KV 成本公式 3N+2 → 4N+2）。全部首次執行即
PASS；全量迴歸 1697/1663/34，與 V2.1.0 基準以 failure 名稱集合對照確認
NEW FAILURES=0，僅跑一次。

本輪**未觸碰**：Windows PBS filter／relay transport、V2.1.0 的
ctx.waitUntil 架構、AI Prompt／model／semantic policy、service area、
LINE policy／formatter、Shared Feed、CCTV、TDX、driverSummary、hourly
reminder，以及「同一事故一小時內」AI 語意上下文功能（本輪刻意未實作）。
詳見 `03_ARCHITECTURE.md`／`PRODUCT_DECISIONS.md` 的完整記錄。

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

## 修正紀錄｜V2.1.0 — Transport Ack Decoupled From Business Processing（2026-08-29，壓縮摘要）

**一句話**：真實 Production 事故——Windows 自身 5 秒 HTTP timeout 在 Cloudflare 仍 `await` 真正 Workers AI 呼叫時觸發，因為那段工作從未交給 `ctx.waitUntil()`，client 斷線時 handler 直接被取消，AI 判斷／LINE／Observatory 全部沒完成，冪等記錄卻已提前寫入，永久擋下 retry。修正兩部分：(1) `src/index.js` 的 `fetch` handler 轉傳 `ctx`，`debugPush.js` 把 business processing 交給 `ctx.waitUntil()`，HTTP 回應只代表「已持久接收」不再代表「AI 已判讀完成」；(2) KV 冪等記錄新增兩階段標記 `PROCESSING`/`COMPLETED`，`PROCESSING_STALE_MS=60秒` 容許復原重跑。同時正式寫入四層架構角色邊界：`WINDOWS_ROLE`/`CLOUDFLARE_ROLE`/`AI_ROLE`/`LINE_ROLE`/`RAW_PBS_TEXT_POLICY=IMMUTABLE_END_TO_END_UNTIL_AI`（詳見 `03_ARCHITECTURE.md`）。以真實事件 `EVENT_ID=11508280025-5` 再次驗證 PBS 原文逐字完整送進 AI prompt。9 項新測試，1681/1647/34，NEW FAILURES=0。`APP_VERSION` V2.0.2→V2.1.0（MINOR）。此輪的 `ctx.waitUntil()` 架構本身後來被 V2.3.0 的 Cloudflare Queue 取代（見上方 V2.3.0 條目）——歷史修正仍成立，僅承載機制已演進。

## 修正紀錄｜V2.0.2 Config Drift Hotfix — PBS_AI_DECISION_ENABLED canonical deployment（2026-08-29，壓縮摘要）

**一句話**：GPT Work 在 Dashboard 手動設定 `PBS_AI_DECISION_ENABLED="true"` 後被下一次 `wrangler deploy` 悄悄移除（Workers Builds 每次部署都把 `wrangler.jsonc` 視為權威來源，與 `TRAFFIC_SOURCE_MODE` 既有機制相同）——17:49 台68事件當時 AI switch 已被移除，該筆非真實 AI 判讀事件。修正：`wrangler.jsonc` 的 `vars` 正式宣告 `"PBS_AI_DECISION_ENABLED": "true"`（字串），`PBS_AI_DECISION_ENABLED_SOURCE=WRANGLER_CANONICAL_VAR`，`DASHBOARD_ONLY_AI_SWITCH=RETIRED`，未加 `keep_vars`。新增 `checkPbsAiDecisionEnabledVar()` regression guard。10 項新測試，1549/1516/33，NEW FAILURES=0。`APP_VERSION` V2.0.1→V2.0.2（PATCH）。

**另記已知問題（本輪不修，仍未解決）**：`PBS_PRECISE_COMMENT_LOCATION_NOT_USED_BY_LINE_FORMATTER`——LINE 訊息格式化仍不會把 PBS comment 原文中的精確交流道／匝道文字（例如「近竹科匝道」）帶出來顯示，即使來源 comment 已含此資訊。與 V2.3.1 的 `DIRECT_COORDINATE_MAP_FALLBACK`（見下方，同樣源自「comment 原文有資訊、結構化欄位沒有」這一類根因）相關但非同一問題——V2.3.1 只補了地圖連結，comment 內的精確地標文字本身仍未被 formatter 使用，此已知問題依然開放。

## 修正紀錄｜V2.0.1 — AI Decision Observatory（2026-08-29，壓縮摘要）

**一句話**：新 Admin 頁 `GET /admin/pbs-ai-observatory-view` 答「PBS 原文→AI 判斷
→理由→結果」，READ ONLY（開啟/整理/搜尋 0 次 AI 呼叫）。盤點後確認無法零額外
KV 寫入，新增最小 thin index `aiObservatoryIndex.js`（48h TTL），每接受事件 +1
write／+0 read，notify/impact/reason/confidence 刻意不重複儲存、頁面即時讀既有
`aiDecisionCache`（`reason` 保證非重新生成）。KV：`puts=2N+2`。查修頁語義全面改
V2.x vocabulary，絕不用舊版「不符合播報資格」。22 項新測試，1539/1506/33，NEW
FAILURES=0。「重複事件」篩選永遠回傳 0 筆非 bug——duplicate 在 transport
idempotency 層就被攔截，從未產生 observatory 記錄。

## 修正紀錄｜V2.0.0 MILESTONE — Windows PBS + Workers AI 架構封版（2026-08-28，壓縮摘要）

重大架構里程碑封版，非新功能開發，`APP_VERSION` V1.9.9→V2.0.0，本輪未改任何
runtime 決策邏輯。誠實保留兩項既有已知限制：(1) `FIRST_REAL_AI_EVENT=WAITING`
——真實事件走完 Windows→Cloudflare→Workers AI→LINE 完整路徑的觀察證據尚未取得
（下個 observational milestone，非 blocker；`AI_BINDING`/`AI_DECISION`=ACTIVE
為 GPT Work 回報，本 Session 未獨立驗證）；(2) `KV_ONLY_ATOMICITY=NOT_SUFFICIENT`
（V1.9.7 既有限制不變，`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY=PARTIAL`）。

## 修正紀錄｜V1.9.9 Phase 3D Hotfix — Cloudflare 字串布林解析（2026-08-28，壓縮摘要）

根因：Cloudflare Dashboard／CLI Variables 一律以字串注入 Worker，`src/pbs/
aiConfig.js#resolvePbsAiDecisionEnabled()` 原本嚴格檢查 `typeof ===
'boolean'`，字串 `"true"` 永遠不符合，導致 GPT Work 在 Dashboard 設定的
`"true"` 悄悄落回安全預設值 `false`。修正：resolver 同時接受真正
boolean 與 Cloudflare runtime 字串形式（`"true"`/`"false"`，不分大小寫
去除空白），其餘一律 fail-safe 回 `false`，不做寬鬆 truthy 判斷。新增
8 項測試（`test/aiConfig.test.js`、`test/pbsAiDecisionScenarios.test.js`），
全量迴歸 1517/1484/33，NEW FAILURES=0。單點 config parsing hotfix，
APP_VERSION 維持 `V1.9.9`。此問題與 V2.0.2 記載的「Dashboard-only 設定
被 Workers Builds 覆寫」是同一根本模式（wrangler.jsonc 權威 vs Dashboard
易失狀態）在不同層次的兩次重演，V2.0.2 已將 canonical source 移至
wrangler.jsonc 徹底解決；完整字串/布林矩陣測試細節見對應測試檔案本身。

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
