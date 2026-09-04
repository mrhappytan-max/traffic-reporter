<!-- title: 路況播報員 Architecture -->

# 03. Architecture（以目前程式碼為準）

本檔案以 `src/` 實際模組結構整理，非憑記憶重寫。模組清單於 export 產生時由腳本重新掃描 `src/` 目錄核對（見本檔末尾「模組清單（自動掃描）」），若與下方敘述不符，以自動掃描結果與程式碼本身為準,並視為文件 Drift。

## V2.4.10 — TDX 國道公里數第二正向地理證據（本輪，2026-09-04）

MINOR。PBS_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、AI_POLICY_MODIFIED=NO、LINE_POLICY_MODIFIED=NO。GEO_RESOLVER_MODIFIED=YES（additive only——Tier1/Tier3既有決策邏輯逐位元組不變，只新增一個 Tier4）。

**新模組**：`src/tdx/hsinchuFreewayKmRanges.js`——TDX ONLY 靜態驗證表＋純函式 `resolveVerifiedHsinchuFreewayKm({road, displayKM})`。資料衍生方法（施工令§五要求政府開放資料，禁止Google摘要/論壇/AI記憶當權威）：交叉比對本repo已bundled的兩份官方資料集——`data/road-location/generated/freeway.js`（國道百公尺里程樁，data.gov.tw 95016，交通部高速公路局，0.1km解析度座標）與`data/hsinchu-boundary/generated/hsinchuBoundary.js`（縣市界線，data.gov.tw 7442，內政部國土測繪中心，V2.4.5已bundled）——用既有匯出的`isPointInRings()`（同一套ray-casting演算法）逐0.1km里程樁點檢驗。結果：國1原始連續區間75.2-107.3K，國3原始74.6-109.4K（邊界銳利無雜訊，已用±1.5km窗口核對）。§六要求保守邊界，兩端各縮0.5km：最終國1=75.7-106.8K、國3=75.1-108.9K，正確排除已知橫跨新竹市/苗栗縣交界的香山交流道（109K，原始範圍內但安全邊界剛好外）。`scripts/verifyHsinchuFreewayKmRanges.mjs`提供可重跑的獨立驗證，資料集更新時應重跑核對。

**接入 GEO Resolver**：`hsinchuGeoResolver.js`新增`resolveByVerifiedFreewayKmRange()`（新Tier4，施工令§二自己的LEVEL 3），插入順序：Tier1（座標）→既有Tier3（明確地名文字）→新Tier4（國道公里範圍）→UNKNOWN。只在`event.source==='freeway'`時查（省道/PBS皆不查）；只能回傳CONFIRMED_HSINCHU或不決定（null→UNKNOWN），永不主動回傳OUTSIDE_HSINCHU（施工令§十一：範圍外=無證據≠負面證據，避免誤判）。**座標優先順序的實作方式**：`resolveTdxHsinchuGeography()`裡`coordinateResult`一有結果就立即return，新Tier4只在`coordinateResult`為null（事件完全沒有座標）時才會被呼叫——這代表「座標與KM範圍衝突」這個情境在架構上根本不可能發生，不需要額外的GEO_EVIDENCE_CONFLICT仲裁邏輯（施工令自己也只說「可以記錄」，非強制）。

**Road Policy/AI/LINE完全獨立（施工令§十三/十四驗證）**：101K+300施工事件（`type=construction`，`blockedLanes`缺失）GEO現在CONFIRMED，但`roadManagementPolicyGate.js`（V2.4.5，本輪未改一行）仍正確回傳`eligible=false, reason='construction-unknown-blocked-lanes'`——GEO修好不代表施工事件會通知，這是正確行為。100K+000天候事件（`type=other`，非道路管理事件類型）GEO CONFIRMED且Road Policy放行，正常進Queue，是否實際notify=true完全交給既有AI決策，本輪未動`aiDecisionEngine.js`任何一行。

**查修頁（施工令§十七）**：`evidence.type`加到`hsinchuGeoResolver.js`各正面/文字tier（座標='OFFICIAL_COORDINATE_POLYGON'、文字='EXPLICIT_PLACE_NAME'、新tier='FREEWAY_KM_VERIFIED_RANGE'）；`tdxQueueIngress.js`直接把`geo.evidence.type`標記到`candidate.event.geoEvidenceType`（掛在event物件上，跟著Queue訊息淺拷貝自然帶過去，不需改共用`buildPbsAiQueueMessage()`簽章，PBS不受影響）；`aiCandidate.js`/`buildTdxPseudoCandidate()`/`aiObservatoryIndex.js`都新增此欄位讀取（mirror既有displayKM pattern，純觀測不影響決策）；`aiObservatoryView.js`GEO區塊新增「地理判定來源」列（✅官方座標行政區／✅明確地名／✅國道公里範圍／❌無足夠證據），KM range放行時額外顯示證據明細。

**測試**：新增`test/v2410TdxFreewayKmHsinchuDeterministicGeoFallback.test.js`（18項，施工令§十九CASE1-16全覆蓋，含PBS零import結構鎖、AI/LINE檔案零import結構鎖、純函式零I/O驗證）。既有`test/v247TdxGeoInputMissingFix.test.js`CASE7、`test/v248TdxKmFallbackProductionRuntimeDiagnosis.test.js`CASE3/4a/4b/5/最後一項共6處斷言因這輪刻意的、預期中的行為改變（先前正確地卡在UNKNOWN的KM現在正確地CONFIRMED了）而更新，皆加註「SUPERSEDED BY V2.4.10」完整說明保留歷史脈絡，非回歸。全量迴歸1814/1782/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.9→V2.4.10。

## V2.4.9 — TDX KM Fallback Production Runtime Diagnosis（本輪，2026-09-04，P0 實機異常查修）

PATCH。GEO_RESOLVER_MODIFIED=NO、PBS_MODIFIED=NO、AI_MODIFIED=NO、LINE_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO。修的是 `src/tdx/tdxQueueIngress.js#buildTdxPseudoCandidate()` 一個函式，新增一個欄位。

**觸發**：Production 查修頁兩筆真實 TDX｜高公局事件（國1北向「101K+300 施工事件-施工維護」、國1南向「100K+000 天候事件-天候不佳」）displayKM/longitude/latitude 全顯示 —，GEO=UNKNOWN/Gate A 排除，儘管 V2.4.7 已加入 description 文字 KM 後援。

**逐層 runtime trace（直接執行程式碼驗證，非假設）**：`hsinchuFilter.js#extractKmTokenFromText()`／`parseKM()` 正確回傳 token/數值；`tdx/normalize.js#normalizeRoadEvent()` 正確把 `displayKM` 寫進回傳的 canonical event（101.3／100）；`tdx/hsinchuGeoResolver.js#resolveTdxHsinchuGeography()` 讀的是這個真正的 event 物件（`tdxQueueIngress.js` 呼叫點直接傳 `candidate.event`，非任何 pseudo-candidate），正確收到 KM 進 Tier-2 觀測層、正確維持 UNKNOWN（無座標/地名證據——這是既有安全設計，非本輪發現的 bug）。**真正的 bug**：`tdxQueueIngress.js#buildTdxPseudoCandidate()`——V2.4.6 建立、專供 Gate A 排除事件寫入查修頁記錄用的本地 candidate builder，早於 V2.4.7 才加上的 `displayKM` 欄位，從未同步更新這個獨立建構的物件，導致 `aiObservatoryIndex.js#buildAiObservatoryRecord()`（讀 `candidate.displayKM`）對所有 Gate A 排除的 TDX 事件永遠寫入 `displayKM: null`。通過 Gate A、進 AI 的 TDX 事件走真正的 `aiCandidate.js#buildAiCandidate()`（V2.4.5 起就有 `displayKM`），完全未受影響——已用測試（CASE 4c）驗證。

**修法**：`buildTdxPseudoCandidate()` 新增一行 `displayKM: event && typeof event.displayKM === 'number' ? event.displayKM : null`，與旁邊既有 `longitude`/`latitude` 欄位同一慣例。不動 Gate A 排除決策、`resolveTdxHsinchuGeography()`、`roadManagementPolicyGate.js`、Queue、AI、LINE、PBS。

**測試**：`test/v248TdxKmFallbackProductionRuntimeDiagnosis.test.js`（8項，覆蓋施工令§五CASE 1-5＋Gate A drop KV write best-effort 迴歸鎖）。全量迴歸1796/1764/32，NEW_FAILURES=0。`APP_VERSION` V2.4.8→V2.4.9。**通則**：一個欄位在「本體物件」正確存在，不保證它在每一個由不同呼叫點各自獨立建構的「影子物件」（這裡是 debug/observability 專用的本地 pseudo-candidate）裡也存在——新欄位上線時必須反查所有獨立建構同類形狀物件的既有程式碼位置。

## V2.4.8 — LINE 路況文字編輯與統一排版（本輪，2026-09-04）

MINOR。PBS_DECISION_POLICY_MODIFIED=NO、TDX_DECISION_POLICY_MODIFIED=NO、GEO_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、CCTV_LOGIC_MODIFIED=NO。修的是 `pbs/aiDecisionEngine.js`（schema/驗證）＋`traffic/messageFormat.js`（呈現）＋`traffic/aiApprovedPbsBroadcast.js`／`pbs/debugPush.js`（貫穿）＋`pbs/aiObservatoryIndex.js`／`View.js`（查修頁），不是任何決策邏輯本身。

**架構**：既有單次 Workers AI 呼叫（`resolveAiDecision()`）JSON schema 新增 `cleanSummary`——AI 文字編輯產物，明確與 `reason`（決策解釋，仍舊從不顯示給司機，見 `messageFormat.js` 自己的 THREE-LAYER ARCHITECTURE 註解，本輪未變）區分開來。`validateAiDecisionResponse()` 把 cleanSummary 獨立驗證：非字串/空/超過 `CLEAN_SUMMARY_MAX_CHARS=100`（`aiDecisionEngine.js` 匯出常數）一律 `null`，絕不影響既有四欄位（notify/impact/reason/confidence）的驗證結果或整筆決策的 ok/invalid。新增 `cleanSummaryContradictsFacts(cleanSummary, candidate)`——純函式，兩個保守正則（車道數字「封閉N車道」形狀 vs canonical `blockedLanes`；北向/南向/東向/西向/雙向詞彙 vs canonical `direction`），矛盾時 `resolveAiDecision()` 直接把 cleanSummary null 掉，決策本身不受影響。`persistAiDecisionCache`/`readAiDecisionCache`（`aiDecisionCache.js`）未改動——`decision` 物件整包 JSON 序列化，`cleanSummary` 自動一起被快取/讀回。

**呈現層**：`messageFormat.js#formatEventMessage(event, {cleanSummary})` 新增區塊式排版分支（headline / road+KM+車道數 / cleanSummary+`ACTION_CUE_LINES`(重用既有 TYPE_IMPACT_LINES 後半句) / 通報+地圖+更新時間，區塊間 `\n\n` 分隔）；`cleanSummary` 為 falsy 時走完全未改動的舊版單行排版（`.filter(Boolean).join('\n')`）——這是本輪唯一的「新增路徑，舊路徑逐位元組不變」設計，零回歸風險（除來源標示外，見下）。`aiApprovedPbsBroadcast.js#runAiApprovedPbsBroadcast()` 新增 `cleanSummary` 參數，直接轉呼叫 formatter；`debugPush.js#runAiDecisionPath()` 把 `decision.cleanSummary` 傳進去，並把 `cleanSummary`／`finalRenderedMessage`（`firstProduct.text`，即 `completedProduct.text`，從未重算）一起放進回傳物件，讓 `writeObservatoryRecord()` 的 `...outcomeFields` 展開自動吃到。

**來源標示（唯一影響 fallback 路徑本身的變更）**：`messageFormat.js` 新增 `buildReporterLine(event)`，取代 `buildSourceDetailLine()`。`TDX_SOURCE_REPORTER_PREFIX = {freeway:'【TDX】高公局', highway:'【TDX】公路局'}`——純粹依 `event.source` 決定，`tdx/normalize.js` 從未設定 `sourceDetail`，這是 TDX 事件史上第一次出現通報行。PBS 側 `REPORTER_UNIT_ALIAS_PATTERNS`（陣列，最具體 pattern 優先：高速公路局/高公局→高公局；公路局→公路局；熱心聽眾→熱心聽眾；警察/警方→警方）+ `aliasReporterUnit()`（`sourceDetail` 為空或字面等於「警廣」時回傳空字串，避免「【警廣】警廣」的冗餘顯示；不認得的文字走既有 `SOURCE_DETAIL_MAX_CHARS=40` 截斷邏輯顯示原文）。PBS 現在永遠顯示「通報：【警廣】...」（含空單位時的裸前綴），此前空 sourceDetail 時整行省略——這是唯一連動修改既有測試斷言的變更點。

**查修頁**：`aiObservatoryIndex.js#buildAiObservatoryRecord()` 新增 `cleanSummary`/`finalRenderedMessage`（皆預設 `null`，additive）；`aiObservatoryView.js` 新增 `renderAiTextEditSection()`，顯示於 SOURCE 區塊之後、GEO/ROAD_POLICY 區塊之前，PBS/TDX 卡片皆適用。

**測試**：`test/v248AiLineMessageEditorAndUnifiedPresentation.test.js`（18項，CASE 1-14）。全量迴歸1788/1756/32，NEW_FAILURES=0。`APP_VERSION` V2.4.7→V2.4.8。

## V2.4.7 — TDX 地理資料缺失查修：description 文字 KM 後援（本輪，2026-09-03）

PATCH，PBS_MODIFIED=NO、GEO_RESOLVER_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、AI_POLICY_MODIFIED=NO。修的是 `tdx/normalize.js`＋`src/traffic/hsinchuFilter.js`，不是 `tdx/hsinchuGeoResolver.js`／`roadManagementPolicyGate.js` 本身的判定邏輯——那兩個模組完全未觸碰。

**起因**：真實事件 `A15040100H-01-20260903103244766100023`（TDX｜高公局，國道三號 北向 79K+000 其他異常告警-散落物）在 V2.4.6 剛上線的查修頁上 GEO=UNKNOWN，`areaNm`/`displayKM`/`longitude`/`latitude` 全空，即使 description 明確含「79K+000」。

**§一唯讀 code-path 稽核**：`normalizeRoadEvent()` 的結構化 KM 擷取（`Location.FreeExpressHighway.StartKM`/`EndKM`/`*LocationMile`）無條件執行，沒有分支會遺失已存在的資料——確認不是 normalize 的 bug，是這筆事件原始 payload 本身沒有任何結構化地理欄位（本 sandbox 無法連線 TDX API 取得該筆事件的真實 raw JSON 做 100% 驗證）。真正缺口：TDX normalize 路徑從未有過 description 文字 KM 後援（PBS 早就有）。

**副發現（範圍外，已妥善繞過）**：`tdx/extract.js#firstDefined(raw, paths, undefined)` 因 JS default-parameter 語法（顯式傳 `undefined` 仍觸發該參數自己的預設值 `''`），一個真正缺席的 `startKM` 實際上永遠是 `''` 而非字面 `undefined`——對既有每個讀者都無害（都已把 `''` 當缺席），但代表新後援邏輯的觸發條件必須用 `!startKM`（falsy），不能用 `=== undefined`。未在源頭修正 `firstDefined`。

**修法**：`src/traffic/hsinchuFilter.js#extractKmTokenFromText()`（新函式，重用 `parseKM()` 既有 TDX KM token 格式）。`normalizeRoadEvent()` 只在 `!startKM && !endKM` 時對 `description` 呼叫——結構化欄位永遠優先，不被覆蓋。解析出的 token 以與結構化欄位相同的原始字串格式（"79K+000"）存回 `startKM`/`endKM`，`composeLocation`/`parseKM`/`hsinchuGeoResolver.js` Tier-2 皆自動吃到，零新型別分支。新增 `displayKM`（數字，PBS 既有欄位同形狀）。

**安全性（非常重要，CASE 7/7b 鎖住）**：解析出的 KM 唯一讀者是 `hsinchuGeoResolver.js` Tier-2 KM-heuristic 觀測層——本輪維持永遠 observability-only、永不單獨決定 CONFIRMED/OUTSIDE。上述真實事件即使 KM 成功解析，地理判定仍正確維持 UNKNOWN（0 Queue/0 AI/0 LINE）；只有可觀測性改善。

**測試**：`test/v247TdxGeoInputMissingFix.test.js`（12 項，CASE 1-7＋CASE 7b＋`extractKmTokenFromText`單元測試）。全量迴歸 1770/1738/32，NEW_FAILURES=0。`APP_VERSION` V2.4.6→V2.4.7。

## V2.4.6 — 查修頁 TDX 顯示與最終決策原因摘要（本輪，2026-09-03）

UI/observability-only（PBS runtime／TDX 決策邏輯／AI prompt／LINE 規則全部未觸碰）。本輪改的是 `src/pbs/aiObservatoryView.js`（`GET /admin/pbs-ai-observatory-view`）＋`src/pbs/aiObservatoryIndex.js`，以及 `src/tdx/tdxQueueIngress.js` 新增一次額外的 best-effort 觀測寫入——**不是**舊版 `src/traffic/pipelineTraceView.js`（`GET /admin/pipeline-trace-view`），後者 `buildTraceEntry()` 只有 3 個呼叫點且皆 PBS 觸發，在 V2.4.0 `LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT` 架構下純 TDX 事件本就幾乎不會出現在那頁，非本輪範圍。

**Gate A 觀測缺口（本輪修的核心問題）**：`tdx/tdxQueueIngress.js#enqueueTdxRoadEvents()` 的兩個 Gate A（V2.4.5 地理判定 `hsinchuGeoResolver.js`、道路管理政策 `roadManagementPolicyGate.js`）皆在 `PBS_AI_QUEUE.send()` 之前執行——排除的事件此前只留下一行 `console.log`，Observatory KV **完全零紀錄**（`aiObservatoryIndex.js` 的 `AI_OUTCOME` 枚舉先前沒有任何值代表「Gate A 排除」，因為這類事件從未走到 `debugPush.js#processQueuedPbsEvent()`，該函式才是既有 Observatory 寫入的唯一入口）。本輪新增：
- `AI_OUTCOME` 六個新值：`GEO_EXCLUDED_OUTSIDE_HSINCHU`／`GEO_EXCLUDED_UNKNOWN`／`ROAD_POLICY_EXCLUDED_SHOULDER_OPEN`／`_SHOULDER_CLOSE`／`_INSUFFICIENT_LANES`／`_UNKNOWN_LANES`。
- `tdxQueueIngress.js` 內的 `recordTdxGateDrop()`：在兩個 Gate A 排除點「判定之後」呼叫，重用 `aiObservatoryIndex.js` 既有的 `buildAiObservatoryRecord`/`recordAiObservatoryEntry`（同一個 KV prefix `debug:pbs-ai-observatory-index:v1`，未新增第二個 index），直接把 `resolveTdxHsinchuGeography()`／`resolveTdxRoadManagementEligibility()` 已算出的結果轉成上述新 outcome 值——排除決策本身完全不受影響（`toEnqueue`/`geoPassed` 的過濾邏輯無任何改動），寫入是 best-effort try/catch，KV 失敗不影響任何計數器或送出結果。

**顯示層 bug（本輪也修的另一半問題）**：`aiObservatoryView.js#renderRow()` 的收合列此前硬編碼 `<span class="col-source">PBS</span>`，從未讀 `record.source`——即使一個 TDX 事件真的通過 Gate A、被正確寫入 `source:'freeway'/'highway'`，畫面上也一律顯示成 PBS。改為 `sourceLabel(record.source)`（`SOURCE_LABELS = {pbs:'PBS', freeway:'TDX｜高公局', highway:'TDX｜公路局'}`），三種來源徽章永不合併顯示。

**最終決策原因摘要（施工令核心驗收項）**：`aiObservatoryIndex.js` 新增 `deriveFinalDecisionReason(record)`——UI 唯一可用的原因組成函式，只讀 record 既有欄位（`outcome`/`eventType`/`blockedLanes`/`suppressedForPhase`/`lineSent`），從不重新判斷／猜測。`buildAiObservatoryRecord()` 同時新增 `suppressedForPhase`（`debugPush.js#runAiDecisionPath` 早就算出、早就回傳，但因為這個 builder 的具名參數解構清單先前沒宣告這個名字，物件展開時被靜默丟棄——純粹補上）與 `blockedLanes`（`aiCandidate.js` 自 V2.4.5 起就有，此前也未存進 record）兩個既有欄位。`aiObservatoryView.js` 用這個函式在每張收合卡片新增一行 `✅已發送／⏭未發送／⏱AI處理失敗／⏳處理中 + 原因`（PBS/TDX 皆有），並新增 TDX 專屬的第二種展開流程條 SOURCE→GEO→ROAD_POLICY→QUEUE→AI→LINE（與 PBS 原本 ①-④ 流程條是完全獨立的程式碼路徑，PBS 卡片零改動）。

**未觸碰**：PBS runtime（`pbs/pipeline.js`／`pbs/lifecycle.js`／`hsinchuFilter.js`）、TDX 地理/道路管理判定邏輯本身（只是「讀」它們已算好的結果）、AI prompt/model/schema/cache、LINE 通知規則/subscriptions/incidentSuppression、`wrangler.jsonc` 任何開關（`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED` 維持 `"true"`）。TRACE_API 端點不變（仍 `GET /admin/pbs-ai-observatory-view`，仍唯讀、0 AI 呼叫、0 額外 KV 寫入於開啟/篩選/重新整理路徑）。見 `test/v246TracePageTdxAndDecisionReasonSummary.test.js`（20 項，含施工令 8 個 CASE）與 `07_KNOWN_ISSUES.md` 完整記錄。

## 補登（2026-08-30）— Windows PBS Geographic Filter Repair（人類回報，本 Cloud Session 未獨立驗證，程式碼本輪未變更）

人類回報 Windows PBS 本機篩選（`pbs-relay/`）已將 `isAccident()` 事故語意
閘門移除，改用 point-in-polygon（data.gov.tw dataset 7442 新竹市/縣界線）
取代原矩形邊界，讓 Windows 恢復為純地理層（`WINDOWS_ROLE =
HSINCHU_PBS_FILTER_AND_RELAY`，V2.1.0 命名的角色邊界不變，只是回報「執行上
更貼近該角色定義」）——若屬實，新竹市/縣所有事件類型（不只事故）皆會進入
候選，語意判斷完全交給 AI 層。**本 Session 獨立查證**：目前 `main`／本分支
`pbs-relay/src/localPrototype.js` 第 56／108 行仍保留並使用 `isAccident()`
作為候選閘門，`pbs-relay/` 全部 git 歷史（含 `feature/pbs-local-edge-
filter-prototype`）未找到對應此修正的 commit。本節僅記錄「人類回報了什
麼」，**不代表** point-in-polygon 實作、dataset 7442 引用或回報的
11→29／124 測試數字已被本 Session 驗證為真——狀態標記
`HUMAN_REPORTED_NOT_INDEPENDENTLY_VERIFIED`，完整記錄見
`07_KNOWN_ISSUES.md` 對應段落。本輪（DOCUMENTATION ONLY 施工令）明確禁止
修改 `pbs-relay/` 程式碼，故上方模組清單／架構圖若與此回報不一致，以自動
掃描結果與程式碼本身為準。

## V2.4.5 — TDX_HSINCHU_GEO_RESOLVER ＋ TDX_ROAD_MANAGEMENT_POLICY_GATE（本輪，2026-09-02）

TDX ONLY——**Windows PBS／`pbs-relay/`／PBS 本機篩選／PBS 地理判斷／PBS AI
候選／PBS LINE 路徑／PBS lifecycle 完全未觸碰**（見上方 2026-08-30 補登，
PBS 自己是否使用 dataset 7442 仍是獨立、未驗證的另一件事，與本輪 TDX 專用
resolver 無關）。核心驗收句：「TDX 必須先證明事件位於新竹縣或新竹市，才
有資格進 AI；無法證明就是不進 AI。」

**背景**：V2.4.4 自己的唯讀 audit 發現 TDX 既有服務區判斷（`traffic/
hsinchuFilter.js` 的 ingestion 過濾、`traffic/serviceArea.js` 的候選建立
閘門）皆建立在 `hsinchuConfig.js` 自承「best-effort、未對照官方里程樁驗
證」的 KM 表之上，且 `serviceArea.js` 舊 TDX 分支在完全沒有座標時會
fail-open（"service-area-deferred-to-ingestion"）。真實 Production 洩漏一
筆事件：台61線 39K+600，實際位於桃園市觀音區，被舊 KM 表誤判為新竹（見
`07_KNOWN_ISSUES.md` V2.4.4 條目、`test/tdxHsinchuGeoResolver.test.js`
CASE 3 的永久回歸鎖定測試）。

**新 TDX 端對端流程**：

```
TDX API → normalizeRoadEvent()（保留完整座標證據：positions[]／
          longitude／latitude，來源 tdx/normalize.js＋
          traffic/hsinchuFilter.js#extractPositions 重用，V2.4.5 新增）
        → tdx/hsinchuGeoResolver.js#resolveTdxHsinchuGeography()
          （Gate A 第一步——三態 CONFIRMED_HSINCHU／OUTSIDE_HSINCHU／
          UNKNOWN，絕不是 boolean；證據優先序：①座標對照官方行政區界線
          （內政部國土測繪中心，data.gov.tw dataset 7442——**補正
          （V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX_CONTINUE，
          2026-09-02）**：正式改為人類直接自 data.gov.tw 下載並上傳的官方
          shapefile（`COUNTY_MOI_1090820`，ISO 19115 metadata 記載
          creation/revision=2020-08-20，CRS=EPSG:3824），不再是第三方
          npm 鏡像；原 taiwan-atlas 2021.9.20 鏡像保留為歷史比對用途於
          `data/hsinchu-boundary/raw/historical-taiwan-atlas-2021/`，
          兩者幾何差異已比對確認無實質差異（0.04% 邊界像素級誤差，見
          07_KNOWN_ISSUES.md 完整比對記錄）。本環境仍無法直連
          data.gov.tw，決策記錄見 07_KNOWN_ISSUES.md）②KM 表僅作觀察用
          途，絕不再單獨核發 CONFIRMED/OUTSIDE ③明確行政區文字，含
          「往ＸＸ方向」與事件本身所在地的區分）
        → tdx/roadManagementPolicyGate.js#resolveTdxRoadManagementEligibility()
          （Gate A 第二步，僅在地理閘門通過後才執行——機動路肩開放／關閉
          永不進 AI；一般施工需 blockedLanes>=2 才有資格進 AI，資料不足
          一律 UNKNOWN_BLOCKED_LANES 不進 AI；真正重大事故／完全封閉／
          坍方／落石等透過 escape valve 不受此規則誤殺）
        → tdx/tdxQueueIngress.js#enqueueTdxRoadEvents()（依上兩步過濾後
          才 Queue.send()，新增 droppedOutsideHsinchu／
          droppedUnknownHsinchu／droppedRoadManagement 三個純觀察計數）
        → PBS_AI_QUEUE（沿用 V2.3.0，同一條 Queue／同一個 AI 引擎）
        → aiCandidate.js#buildAiCandidate()（新增 blockedLanes 結構化欄
          位帶入 AI prompt——PBS 事件恆為 null，純新增欄位，不改變 PBS
          自己的決策）
        → 既有 Production Notify Pipeline（Gate B——`traffic/
          serviceArea.js#resolveServiceAreaEligibility` 的 TDX 分支已改
          為委派同一個 resolveTdxHsinchuGeography()，故
          `pbs/aiCandidate.js` Gate 2、`traffic/aiApprovedPbsBroadcast.js`
          既有 V2.4.4 Gate 3 皆自動使用同一個 canonical 地理結果，未新增
          任何程式碼、未讓真正 LINE 推播前重跑第二套判斷）
        → LINE
```

**服務範圍精確化**：本輪起「新竹」服務範圍明確等於新竹市＋新竹縣兩個縣
市（`data/hsinchu-boundary/generated/hsinchuBoundary.js`），不再是舊
「新竹生活圈」概念——桃園／苗栗／頭份／竹南／三灣一律不在範圍內。

**CRS**：TDX PositionLat/PositionLon 視為 WGS84；官方界線資料標示 TWD97
經緯度（EPSG:3824）；台灣地區兩者差距僅公分級，本輪採用此既有工程判斷
（`data/road-location/raw/README.md` 早有相同先例，非本輪新猜測），未做
座標轉換。完整 CRS／資料集決策記錄見 `07_KNOWN_ISSUES.md`。

**保留、未撤除**：`resolveHsinchuOnlyProductionEligibility()`（V2.4.4 的
denylist 硬閘門）本輪保留作為第二層 safety net，新 resolver 成為主要
positive-eligibility 權威；`aiDecisionEngine.js` SYSTEM_PROMPT 既有的
機動路肩開放／關閉／一般施工語意提示（第四類原則）保留作為第二層
safety net，程式碼閘門（`roadManagementPolicyGate.js`）為第一層。舊
`HSINCHU_BOUNDING_BOX`／KM 表保留為輔助觀察／快速排除工具，不再擁有最終
放行權威。

**目前部署狀態（`wrangler.jsonc`，取代上方 V2.4.0 表格中已過時的
「皆預設 false」敘述）**：`TDX_ROADEVENT_FETCH_ENABLED="true"`、
`TDX_ROADEVENT_QUEUE_INGRESS_ENABLED="true"`、
`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED="true"`——**V2_4_5_SEAL_DEPLOY_
AND_REAL_WORLD_VERIFY（2026-09-02）已在人類明確授權下重新開啟**，TDX 真
實 LINE 通知正式上線（PHASE_E_TDX_NOTIFY_LIVE）。本 sandbox 無 Production
網路存取，實機觀察委由人類執行；發現異常第一動作固定改回 `"false"`。完
整觀察協定與 rollback 記錄見 `07_KNOWN_ISSUES.md`。

完整逐版本文字記錄／CASE 測試對照 → `06_VERSION_HISTORY.md`／
`07_KNOWN_ISSUES.md`；專用測試 →
`test/tdxHsinchuGeoResolver.test.js`／`test/tdxRoadManagementPolicyGate.test.js`。

## V2.4.0 — TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE（本輪，2026-09-01，Phase B）

TDX 國道/省道 RoadEvent 重新加入 PBS 既有的同一條 Queue／同一個 AI 決策
引擎（非重造第二套決策系統），跨來源（PBS＋TDX）同一實體事故的協調交給
新的 Recent Incident Memory。**這是 Phase B**——AI 真的跑、Memory 真的
讀寫，但 TDX 來源事件目前不會真正推播 LINE（見下方「Phase B 閘門」）。

### 端對端資料流（本輪新增部分以 `←NEW` 標示）

```
TDX Freeway RoadEvent ──┐                PBS Windows Push
TDX Highway RoadEvent ──┤                       │
      │（scheduled.js's own fetch, unchanged）   │（既有 /internal/pbs-debug-push）
      ↓ normalizeRoadEvent(raw, source)          ↓ buildRawPbsRecordFromPush→normalizePbsEvent
      ↓ dedupe.js#classifyEvents（NEW/UPDATED/duplicate）
      ↓ tdxQueueIngress.js#enqueueTdxRoadEvents() ←NEW（duplicate 不進 Queue）
      └────────────────┬───────────────────────────┘
                        ↓
          唯一一個 Cloudflare Queue（PBS_AI_QUEUE，沿用 V2.3.0）
                        ↓
        processQueuedPbsEvent() — 依 source 分派 normalize，
        絕不互相套用對方原始 shape ←NEW（source dispatch）
                        ↓
              serviceArea 閘門（唯一保留的 EXECUTION-type 硬規則）
                        ↓
        incidentMemory.js#readIncidentMemory()+selectMemoryCandidates()
        ←NEW（road+direction→1000m/1.5km→8h→最多5筆，排除自己）
                        ↓
        aiDecisionEngine.js#resolveAiDecision()
        （唯一一個 AI 引擎；有 memory context 時 prompt 多帶
        recentIncidents，schema 多要求 sameIncident/materialChange）
                        ↓
              notify:true?
              ├─ 否 → persistSighting(false)，記錄但不推播
              └─ 是 → runAiApprovedPbsBroadcast(suppressLineNotify=
                       source==='freeway'||'highway' ←NEW Phase B 閘門)
                       ├─ PBS 來源 → CCTV 準備（V2.3.3 R2 讀回驗證，
                       │  未觸碰）→ 真正 LINE push → Shared Feed
                       └─ TDX 來源 → 全流程執行到「準備推播」但
                          suppressLineNotify=true 時在真正送出前
                          return，0 次真實 LINE API 呼叫
                        ↓
              persistSighting(pushSucceeded>0) ←NEW
              （<=1 KV get + <=1 KV put/事件，WRITE_ON_CHANGE）
```

### Phase B 閘門（接手最重要的一件事）

`suppressLineNotify = source === 'freeway' || source === 'highway'`
**硬寫死**在 `src/pbs/debugPush.js#runAiDecisionPath` 唯一呼叫
`runAiApprovedPbsBroadcast()` 的那一行，不是任何 `wrangler.jsonc` 變數。
要進 **Phase C**（TDX 真正推播 LINE）需要未來一次明確的程式碼變更（移除
這個硬寫死的 `true`），絕非改設定值就能達成——這是本輪能給的最強保證：
config 層面不可能意外進入 Phase C。

### 三個新粒度開關（`wrangler.jsonc`，canonical，皆預設 `"false"`）

| 開關 | 作用 | 目前值 |
|---|---|---|
| `TDX_ROADEVENT_FETCH_ENABLED` | 疊加於 `TRAFFIC_SOURCE_MODE` 之上，獨立允許 `scheduled.js` 抓 TDX RoadEvent | `"false"` |
| `TDX_ROADEVENT_QUEUE_INGRESS_ENABLED` | 新／更新 TDX 事件是否送進 `PBS_AI_QUEUE` | `"false"` |
| `TDX_CCTV_METADATA_REFRESH_ENABLED` | CCTV metadata refresh probe 是否允許真實 TDX 呼叫 | `"false"` |

三者由 `src/traffic/sourceMode.js#isTdxTokenAccessPermitted(env)`（`=
isTdxRuntimeEnabled(env) || isTdxRoadEventFetchEnabled(env) ||
isTdxCctvMetadataRefreshEnabled(env)`）合併成單一「TDX token 是否可以
發出」的粗粒度閘門（`tdx/auth.js`），實際「這次呼叫該不該真的發生」
仍由各呼叫點自己用細粒度 resolver 判斷。

### 結構性退休：LEGACY_TDX_LINE_PIPELINE

`src/traffic/scheduled.js` 的 `broadcastEvents` 變數不再是
`mergeForBroadcast(summary.allEvents, pbsSummary.canonicalEvents,
pbsSummary.uniquePbsEvents)`，改為只有
`[...pbsSummary.canonicalEvents, ...pbsSummary.uniquePbsEvents]`——TDX
自己抓到的事件（`summary.allEvents`）**結構性地**永遠不會出現在這個
變數裡。即使單獨打開 `TDX_ROADEVENT_FETCH_ENABLED`（Phase A：只抓不進
Queue），TDX 事件也無法回到舊 V1.5 硬規則（`broadcastRules.js` 白名單／
`MAJOR_ACCIDENT_ONLY`／locationQuality 語意 hard-reject）LINE 路徑——
`LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT`。PBS 自己的
canonical／unique 事件（既有、目前預設休眠的 legacy 輪詢 fallback）不受
影響，仍走原本路徑。

### 未觸碰

CCTV 整條 metadata-cache→選鏡→compose→R2-put→R2-read-back-verify→LINE
管線（V2.3.3 原封不動）；`incidentSuppression.js`（保留為短期重複推播
安全網，疊加在 AI 自己的 8h Memory 判斷之下，非取代）；Observatory UI
（僅新增 7 個 trace 欄位，主頁面未重做）；VD／CMS／其他 Traffic
API（未復原）；CCTV metadata refresh Cron（維持 MANUAL/ON-DEMAND）；
Google Maps。`CCTV_RUNTIME_TDX_CALLS=0`。

完整逐版本文字記錄 → `06_VERSION_HISTORY.md`／`07_KNOWN_ISSUES.md`；17
個 CASE 測試全文 → `test/tdxUnifiedAiPipeline.test.js`。

## V2.3.0 — PBS AI Queue Reliability：Cloudflare Queues 取代 ctx.waitUntil（2026-08-30，壓縮摘要）

**真實 Production 事故**：`EVENT_ID=11508290166-0` 成功啟動 Workers AI 呼叫，但呼叫在 `ctx.waitUntil()` 自身背景執行時間預算到期前未回傳，平台強制取消整個 task，AI 決策永久遺失、冪等紀錄卡死 PROCESSING。`REAL_INCIDENT_ROOT_CAUSE=WAITUNTIL_BACKGROUND_WINDOW_EXCEEDED`（與V2.1.0修的Windows短HTTP timeout是不同的另一種限制）。

**架構變更**：`ctx.waitUntil()`全面退休做為AI背景執行載體，改用唯一一個Cloudflare Queue（`pbs-ai-processing-queue`／binding`PBS_AI_QUEUE`，`wrangler.jsonc`為唯一正典來源）：HTTP ingress只驗證/冪等accept(PROCESSING)/Observatory早期寫入(PROCESSING_STARTED)/`Queue.send()`，send成功才ACK；獨立Queue Consumer（同一Worker新增`queue(batch,env,ctx)` export，非第二個Worker）承接AI candidate→AI決策→LINE/Shared Feed→Observatory最終寫入(COMPLETED)，與原始HTTP request/ctx完全無關。`Queue.send()`失敗絕不假報accepted:true(回真實503)。

**重試邊界（關鍵設計）**：`AI_CALL_FAILED`（呼叫未可靠完成）可Queue重試，`MAX_QUEUE_RETRIES=3`；既有`AI_DECISION_INVALID`（答案格式無效）fail-closed完全不放寬、絕不重試。新終態`AI_OUTCOME.PROCESSING_FAILED`（重試耗盡後Consumer寫入，同時標記冪等COMPLETED）。`QUEUE_DELIVERY_MODEL=AT_LEAST_ONCE`，業務`BUSINESS_OUTCOME_MODEL=EFFECTIVELY_ONCE`：每次遞送先查冪等記錄，已COMPLETED的重複遞送直接ack略過，重用既有transport idempotency/AI decision cache/notified-state。

**開發期間測試驅動發現並修正的Observatory KV key-identity bug**：Queue Consumer是獨立invocation，自己的`now`與HTTP ingress原始接受時間不同，直接沿用會讓最終寫入建立第二筆KV紀錄而非覆寫早期PROCESSING_STARTED——修正為從queue message的`acceptedFirstAcceptedAt`重建`observatoryNow`專供兩次Observatory寫入key使用，真實`now`仍用於業務決策與`completedAt`。`RAW_PBS_TEXT_POLICY=IMMUTABLE_END_TO_END_UNTIL_AI`不變（event逐字淺拷貝，從未截斷改寫）。

**成本**：KV `puts=4N+2`（與V2.2.0同公式，僅拆到兩次invocation）、`gets=6N`（+1/事件）。Queue：成功2次operation，重試耗盡最差5次；50/100/200 events/day最差250/500/1000次，遠低於10,000/日免費額度。

**未觸碰**：Windows PBS filter、AI Prompt/model、service area、LINE formatter、TDX、CCTV、Shared Feed、Observatory整體UI（僅新增PROCESSING_FAILED詞彙）。`BROWSER_ACTION_REQUIRED=YES`：真實Queue資源需Dashboard/`wrangler queues create`建立，sandbox無法驗證。

詳見`src/pbs/debugPush.js`module comment、`test/pbsAiQueueReliability.test.js`、`07_KNOWN_ISSUES.md`完整記錄。

## V2.2.0 — AI Decision Observatory 四層事件生命週期查修頁（2026-08-29）

把 `/admin/pbs-ai-observatory-view` 從單一 AI-outcome 列表升級為
**四層事件生命週期檢視**，直接對應 V2.1.0 剛正式命名的四層架構角色：

```
① PBS/Windows → ② Cloudflare → ③ AI → ④ LINE
```

每層在事件卡展開後獨立顯示成功／未執行／失敗／未知四種狀態，頂部另有一條
流程狀態條（flow strip）讓人一眼看出「卡在哪一層」，不需先讀完整段 log。

**① PBS/Windows** — `EVENT_ID`／`lifecycle`／解析後的 road/direction/
areaNm/displayKM/eventType（清楚標示「解析結果」）／longitude/latitude／
Windows 送件時間，以及**獨立呈現、完整未截斷**的 PBS 原始通報全文
（`rawComment`／`rawSourceDetail`——見下方「原始文字完整性」）。

**② Cloudflare** — 收件狀態的人類可讀文案（✅已收件已交由背景流程處理完成／
⏳已收件已交由背景流程處理尚未完成／⚠️收件後處理未完成），加上
transport idempotency status（`PROCESSING`／`COMPLETED`）、attemptCount、
以及（若有）AI 完成時間——這些都是**即時讀取**既有 V2.1.0 transport
idempotency KV 記錄取得，Observatory index 本身從未複製這份狀態。

**③ AI** — AI candidate created／AI call started（由既有 outcome 詞彙
derive，非新存布林值）、Model、Cache HIT/MISS、notify/impact/confidence/
reason（仍即時讀取既有 `aiDecisionCache`，從未複製或重新生成）。

**④ LINE** — LINE attempted／LINE sent，未執行時附上明確原因文字（例如
「AI notify=false」「服務區域外，未進入 AI 判讀」），不再只是一個布林值。

### 原始文字完整性（RAW_PBS_TEXT_VISIBLE = YES）

`src/pbs/aiObservatoryIndex.js` 的 `commentSummary`（原本截斷至 120 字）
正式退休，改為 `rawComment`／`rawSourceDetail`——PBS 原始自由文字欄位，
**完整未截斷儲存**，與 road/direction/areaNm/displayKM 等既有解析欄位
**獨立標示、絕不合併覆蓋**。查修頁「原始通報」區塊與「解析結果」欄位分開
呈現，符合本專案的 `RAW_PBS_TEXT_POLICY = IMMUTABLE_END_TO_END_UNTIL_AI`
原則（V2.1.0 正式命名）。

### 失敗事件可見性（FAILURE_EVENT_VISIBILITY，本輪真正補上的缺口）

V2.1.0 的 `ctx.waitUntil` 背景處理若中途 crash 或從未跑完，原本
Observatory index **完全不會留下任何紀錄**（原本只在處理「最尾端」寫入
一次）。本輪 `src/pbs/debugPush.js` 的 `processAcceptedEvent` 現在在
business processing「一開始」就先寫入一筆 `AI_OUTCOME.PROCESSING_
STARTED` 紀錄（直接取自 Windows 原始 payload 欄位，寫在任何可能 throw
的程式碼之前），既有的「最終」寫入之後**原地覆寫同一把 KV key**
（`idempotencyKeyHash` + `taipeiDate` + 接受當下的 `now` 三者相同，見
`aiObservatoryIndex.js` 自身的 header comment）。停滯／crash 的事件
因此仍有一張卡可查（凍結在 `PROCESSING_STARTED`），不再完全消失。

### KV 成本（實測，非估算）

```
KV_BASELINE_FORMULA（V2.1.0，含 Observatory 但無本輪早期寫入）＝ puts = 3N + 2
KV_NEW_FORMULA（本輪）                                        ＝ puts = 4N + 2
EXTRA_KV_WRITES_PER_ACCEPTED_EVENT = 1（Observatory 早期寫入）
```

50/100/200 accepted events/day 分別為 202/402/802 puts/day，遠低於
Cloudflare Workers KV Free Plan 每日 1,000 次寫入額度。見
`test/pbsAiObservatoryFourLayer.test.js` 的 KV cost formula 測試（實際
程式路徑重新量化，非估感覺）。

### 零副作用（不變）

開啟／重新整理／搜尋／篩選本頁仍是 **0 次 Workers AI 呼叫、0 次 KV
寫入**——本輪只新增「每列一次 transport-idempotency-status 讀取」，讀取
本身從未受此限制，只有寫入才要求為 0。

### 本輪未觸碰

Windows PBS filter／relay transport、V2.1.0 的 `ctx.waitUntil` 架構、
AI Prompt／model／semantic policy、service area、LINE policy／
formatter、Shared Feed、CCTV、TDX、driverSummary、hourly reminder，
以及「同一事故一小時內」AI 語意上下文功能（**刻意未實作**——若既有架構
尚未真正做到，本輪不得偷偷加入）。

詳見 `src/pbs/aiObservatoryIndex.js`／`aiObservatoryView.js`／
`debugPush.js` 的完整 module comment、`07_KNOWN_ISSUES.md`／
`PRODUCT_DECISIONS.md` 的完整記錄。

## V2.1.0 — 四層架構角色邊界 ＋ Transport Ack Decoupled From Business Processing（2026-08-29）

**正式四層架構角色邊界**（本輪寫入，往後每一輪的職責歸屬皆以此為準）：

| 層 | 角色常數 | 職責 | 明確不負責 |
|---|---|---|---|
| Windows PBS | `WINDOWS_ROLE = HSINCHU_PBS_FILTER_AND_RELAY` | 從 PBS 全量資料篩出新竹縣市事件，完整保留原始事件資料傳給 Cloudflare | 重大程度判斷、是否值得播報、一小時語意重複判斷、AI 內容判斷、LINE 播報資格 |
| Cloudflare | `CLOUDFLARE_ROLE = INGRESS_STATE_CONTEXT_AND_AI_ORCHESTRATION` | 收件中心：接收 Windows 完整資料、保存必要技術狀態、建立 AI 輸入、交給 AI 判讀 | 要求 Windows 等待 AI 完整判斷才算收件成功 |
| AI | `AI_ROLE = SEMANTIC_DECISION_AUTHORITY` | 內容判斷唯一權威：是否重大影響營業車司機、是否為同事件重複、是否需要再次通知 | 不得把這些語意決策重新硬寫回 Windows |
| LINE | `LINE_ROLE = DELIVERY_ONLY` | 只執行 AI 的最後通知結果（notify=true → 送、notify=false → 不送） | 不得由舊 legacy semantic rules 重新覆蓋 AI 決定 |

`RAW_PBS_TEXT_POLICY = IMMUTABLE_END_TO_END_UNTIL_AI`：PBS → Windows →
Cloudflare → AI 之間，原始自由文字欄位（`comment`／`srcdetail`）不得被
改寫、摘要、截斷或刪減；`normalizedRoad`／`resolvedArea`／`displayKM`／
`locationQuality` 等一律是**額外**欄位，不得覆蓋 raw 原文。本輪唯讀
再次驗證（`buildRawPbsRecordFromPush`／`normalizePbsEvent`／
`buildAiCandidate`／`buildAiUserPrompt` 一行未改）：以真實事件
`EVENT_ID=11508280025-5`、`comment="東向近竹科匝道有A3交通事故"` 執行
真正函式鏈路，確認逐字元完整送達 AI prompt。

**修正：Transport Ack 與 Business Processing 生命週期分離**——真實
Production 事故：Windows 5 秒 HTTP timeout 在 Cloudflare 仍 `await`
Workers AI 呼叫時觸發，因為那段工作從未交給 `ctx.waitUntil()`，
Workers runtime 在 client 斷線時直接取消了整個 handler，AI 判斷／LINE／
Observatory 全部沒有完成，且冪等記錄（於 business processing「開始
之前」就已寫入）讓後續 retry 永久被當成 duplicate 擋下。

```
Windows 送出事件
    ↓
Cloudflare：auth → 驗證 → 冪等 accept（寫入 status=PROCESSING）
    ↓
HTTP 回應立刻回傳「已收件」——不等 AI （V2.1.0 起，經 ctx.waitUntil）
    ↓                                    ↓
Windows 收到回應，不需等待               背景：AI candidate → AI 決策
                                          → LINE/Shared Feed → Observatory
                                          → 完成後改寫 status=COMPLETED
```

`ctx.waitUntil()` 保證背景工作在 HTTP 回應送出後、甚至 client 斷線後仍
會跑完——這正是 Windows 短 timeout 不再能中止 AI business processing
的機制保證，而非時間數字調整。冪等記錄新增 `status: PROCESSING |
COMPLETED` 兩階段標記，搭配 `PROCESSING_STALE_MS`（60 秒）讓極少數
「原本那次嘗試根本沒被排程到」的情況能夠復原重跑，而非永久卡死；一般
情況（原嘗試仍在背景真實執行中）的 retry 仍正確被視為重複，不重跑
AI。刻意不用 Cloudflare Queue／Durable Object——`ctx.waitUntil` 已是
現有 Worker lifecycle 原語，足以解決本次已確認的失效模式。

詳見 `src/pbs/debugPush.js` 的完整 module comment、
`test/pbsDebugPushBackgroundProcessing.test.js`、
`07_KNOWN_ISSUES.md`／`PRODUCT_DECISIONS.md` 的完整記錄。

## V2.0.0 接手地圖 — Windows PBS + Cloudflare Workers AI（2026-08-28）

**里程碑背景**：V1.9.5～V1.9.9 Phase 3D 逐輪建立的 Windows PBS 本機邊緣過濾 + Cloudflare
Workers AI 判讀，是一次完整的架構世代更換——不是同一套判斷邏輯的新版本，是兩個不同的
判官：

```
舊世代（對 Windows PBS 路徑已退休，程式碼保留供 rollback）：
  Cloudflare 30 分鐘 PBS 輪詢 → MAJOR_ACCIDENT_ONLY／V1.5 type whitelist／
  location-quality hard-reject → LINE

新世代（V2.0.0 canonical）：
  PBS 官方來源 → Windows PBS Relay（新竹市/縣本機邊緣過濾，lifecycle
  NEW/UPDATED/MISSING_PENDING_CLEAR/CLEARED）→ Cloudflare production ingress
  → 持久 transport 冪等 → AI candidate → AI decision cache → Cloudflare
  Workers AI（駕駛通行影響判讀，非事件類型判讀）→ 驗證通過的 notify:true
  → 既有 LINE 執行基礎設施（原封不動重用）→ LINE
```

以下 26 題是新工程師／新會議室最常問的問題，逐一給出**答案＋可查證的程式碼/文件位置**，
不要求先讀完全部歷史才能上手：

**1. PBS 從哪裡來？** 交通部 PBS（省道即時交通事件）官方 feed，見下方「PBS Windows
Local Edge Debug Push Integration」段落。

**2. Windows 在哪台／哪個專案處理？** 真人的 Windows 機器，專案路徑
`C:\Users\mrhap\traffic-reporter\pbs-relay`（GitHub repo 內同名目錄 `pbs-relay/`，
V1.9.9 Phase 1 起已直接 commit 進 main，不再是未合併的 feature branch）。

**3. Windows 每次做什麼？** `pbs-relay/src/localMonitor.js` 每 3 分鐘抓一次官方 PBS
feed；`pbs-relay/src/localPrototype.js` 做新竹服務區篩選 + lifecycle 比較；
`SHOULD_PUSH=YES` 的事件才呼叫 `POST /internal/pbs-debug-push`。

**4. 哪些縣市會進入？** 只有新竹市、新竹縣。竹南、頭份、苗栗市與其他苗栗縣區域一律
排除（V1.9.9 Phase 1 修正，見下方「V1.9.9 Phase 1」段落）。重用
`src/pbs/hsinchuFilter.js`／`src/pbs/roadName.js`／`src/traffic/hsinchuFilter.js`／
`src/traffic/hsinchuConfig.js` 的既有 canonical resolver，Windows 端未另建第二套
service-area 邏輯。跨縣市道路只納入新竹段；座標 bounding box 不得單獨授予服務區資格。

**5. lifecycle 怎麼判斷？** `NEW`/`UPDATED`/`MISSING_PENDING_CLEAR`/`CLEARED` 四態，
規則詳見下方「PBS Windows Local Edge Debug Push Integration」一節的「CLEARED 防誤判治理」段落。

**6. Cloudflare 收哪個 endpoint？** `POST /internal/pbs-debug-push`（`src/pbs/debugPush.js`
的 `handlePbsDebugPush`）。名稱雖仍保留 V1.9.5 當時的 debug-push 歷史命名，**V1.9.8
起已是正式 Production ingress／business path**，不得因名稱誤認為仍是 debug-only。

**7. Authentication 怎麼做？** `PBS_DEBUG_PUSH_SECRET`，Bearer authentication。Secret
本身不寫入 Engineering Memory，只記名稱/用途/設定位置（Cloudflare Worker Secret，
`wrangler secret put PBS_DEBUG_PUSH_SECRET`，Dashboard 端由 GPT Work 管理）。

**8. duplicate 在哪一層擋？** 持久 transport 冪等層（V1.9.7），`TRAFFIC_KV` 下
`debug:pbs-push-idempotency:v1:*`，48h TTL，key = `SHA-256(source:eventId:lifecycle:
fingerprint)`。完全相同的 transport duplicate 在 AI candidate 建立之前就停止，0 次
AI 呼叫。見下方「PBS Windows Local Edge Debug Push Integration」一節的「Cloudflare 端持久冪等」段落。

**9. AI candidate 在哪裡建立？** `src/pbs/aiCandidate.js#buildAiCandidate()`，在冪等層
之後、AI decision 之前，見下方「V1.9.9 Phase 1（Windows 服務區收斂）＋ Phase 2」段落。

**10. AI cache 在哪裡？** `src/pbs/aiDecisionCache.js`，`TRAFFIC_KV` 下
`debug:pbs-ai-decision-cache:v1:*`，48h TTL，key = `SHA-256(eventId:fingerprint)`。見
下方「V2.0.0 完整決策順序」流程圖與「V1.9.9 Phase 3B」段落。

**11. AI model 是哪一個？** `@cf/qwen/qwen3-30b-a3b-fp8`（V2.4.15起，原`@cf/zai-org/glm-4.7-flash`因reasoning延遲換模型），固定，見下方「Cloudflare Workers AI 帳號設定」。

**12. AI Binding 名稱是什麼？** `AI`（`wrangler.jsonc` 的 `"ai":{"binding":"AI"}`）。

**13. Cloudflare Dashboard 哪裡設定？** Workers & Pages → `traffic-reporter` →
Settings/Bindings → Workers AI → Variable name = `AI`。完整操作位置見
`02_PROJECT_HANDOFF.md`「Cloudflare Dashboard 設定手冊」。

**14. AI 開關 Variable 是什麼？** `PBS_AI_DECISION_ENABLED`。**V2.0.2 起**
canonical 來源是 `wrangler.jsonc` 的 `vars`（GitHub main），**不再是**
Cloudflare Dashboard 手動設定——Dashboard-only 設定會在下一次 deploy
時被 `wrangler.jsonc` 覆寫／移除（V2.0.2 的 Config Drift Hotfix 修正的
正是這個問題，見下方「V2.0.2」段落）。

**15. true 為什麼是字串？** Cloudflare 一律以字串注入 Worker Variable，
從不是真正的 boolean——V1.9.9 Phase 3D 曾因此讓字串 `"true"` 被
resolver 誤判為 false（已修正，resolver 現在同時接受 boolean 與字串
形式），程式修正細節見 `07_KNOWN_ISSUES.md` 的 Phase 3D Hotfix 記錄。

**16. 如何 rollback？** **V2.0.2 起**：修改 `wrangler.jsonc` 的
`PBS_AI_DECISION_ENABLED` 為 `"false"` 並 push 到 main（觸發 Workers
Builds 自動部署）——這是唯一撐得過下一次 deploy 的方式；單純在
Dashboard 上改值只是暫時的，下次 deploy 會被 `wrangler.jsonc` 的值蓋掉。
AI Binding 不用刪除。完整 Runbook 見 `02_PROJECT_HANDOFF.md`
「Rollback Runbook」。

**17. AI notify=true 後去哪裡？** `src/traffic/aiApprovedPbsBroadcast.js#
runAiApprovedPbsBroadcast()` → 既有 LINE 執行基礎設施 → `runSharedFeedPersist()`。見
下方「V2.0.0 完整決策順序」流程圖。

**18. 哪些舊 hard rules 已退出 Windows AI path？** `MAJOR_ACCIDENT_ONLY`、V1.5 type
whitelist（`getBroadcastEligibility`）、`resolveLocationQuality` 的 hard-reject 用法。
函式本身**未刪除**，TDX／其他 legacy 來源仍完整使用。見下方「V2.0.0 完整決策順序」流程圖末的「不得誤讀」段落。

**19. 哪些安全 gate 仍保留？** service area（AI candidate 建立前）、LINE 執行時段
（`broadcastHours.js`）、LINE 去重（notified-state）、quota/transport 安全、CCTV 安全、
Shared Feed 執行安全、系統錯誤處理。見下方「V2.0.0 完整決策順序」流程圖與「AI failure policy」段落。

**20. LINE 如何避免重複？** 沿用既有 `traffic/notified.js` 的 per-target notified-state
去重機制，與 TDX/其他來源共用同一套邏輯，AI 開啟時與 legacy `runLineBroadcast()`
路徑互斥（同一事件絕不同時執行兩者）。

**21. CCTV / Shared Feed 在哪一層？** `runAiApprovedPbsBroadcast()` 內重用既有
`cctv/dynamicCollage.js`（事故類型限定）；Shared Feed 由呼叫方 `debugPush.js` 在
`runAiApprovedPbsBroadcast()` 之後呼叫既有 `runSharedFeedPersist()`。

**22. AI failure 怎麼處理？** 429/5xx/network/binding missing/invalid JSON/invalid
schema 一律 0 LINE、trace 記錄，絕不 fallback 回舊 hard rules。見下方「V2.0.0 完整決策順序」流程圖。

**23. AI 免費額度是多少？** Cloudflare Free plan：10,000 neurons/day，00:00 UTC（台灣
時間 08:00）重置。見下方「Cloudflare Workers AI 帳號設定」。

**24. 如何看 AI Usage？** Cloudflare Dashboard 的 Workers AI Analytics（GPT Work
負責查看，Claude 不需要進 Dashboard）；repo 端只有可觀察的 trace log（`AI_CALL_STARTED`
等），不做複雜 quota 引擎。

**25. 如何排查「Windows 有事件但 LINE 沒收到」？** 見 `02_PROJECT_HANDOFF.md`
「Troubleshooting Runbook：Windows 有事件但 LINE 沒收到」十步驟診斷順序（免費/最快/
高機率優先，非一開始就 Full Audit）；亦可直接開 `GET /admin/pbs-ai-observatory-view`
（V2.0.1 新增，見下方）逐筆查看 PBS 原文→AI 判斷→AI 理由→最終結果，不需要先讀
Workers Logs。

**26. 哪些功能仍未完成？** `FIRST_REAL_AI_EVENT = WAITING`（真實 Production PBS 事件
走完 Workers AI 判讀到 LINE 推播的完整驗證尚未觀察到）；`HOURLY_MAJOR_INCIDENT_REMINDER
= NOT_STARTED`（方向性設計，未實作，未來可重用 AI cached verdict，但不在 V2.0.0
範圍）；`AI_DRIVER_SUMMARY = FUTURE_CANDIDATE`（V2.0.1 記錄的產品候選方向：把行政
地名/里名/公里數轉成交流道/匝道/橋梁/隧道/常用地標等司機可立即理解的位置描述，
未實作、未修改 Prompt、未新增 schema）。見 `07_KNOWN_ISSUES.md` 與
`SYSTEM_STATE.json` 的 `taskSeal`。

## V2.0.1 — AI Decision Observatory（本輪，2026-08-29）

新 Admin 頁 `GET /admin/pbs-ai-observatory-view`（`src/pbs/aiObservatoryView.js`），
READ ONLY OBSERVABILITY——開啟／重新整理／搜尋一律 0 次 Workers AI 呼叫。資料來源：

```
src/pbs/debugPush.js（每個真正被接受、非重複的事件完成處理後）
    ↓
buildAiObservatoryRecord()（純函式，PBS 原始欄位＋最終 outcome enum，
    刻意不含 notify/impact/reason/confidence）
    ↓
recordAiObservatoryEntry()（debug:pbs-ai-observatory-index:v1:*，48h TTL，
    +1 KV write／事件，+0 額外讀取）

GET /admin/pbs-ai-observatory-view
    ↓
listAiObservatoryEntries()（KV list+get，同 broadcastProvenance.js 慣例）
    ↓
每筆記錄若 outcome 為 AI_NOTIFY_TRUE/FALSE
    → 即時 readAiDecisionCache()（既有 aiDecisionCache.js，重新計算
      computeAiDecisionCacheKeyHash({eventId,fingerprint})，非新雜湊）
    → notify/impact/reason/confidence 直接讀既有記錄，絕不重新生成
    → cache 記錄若已過期／不存在 → 顯示 UNKNOWN / NOT RECORDED
```

盤點既有資料後的結論（不重複儲存，最小新增）：`aiDecisionCache.js` 只能回答
「已知 eventId+fingerprint 的判讀是什麼」，無法列舉「有哪些事件」；
`debug:pbs-push-idempotency:v1:*` 沒有 PBS 欄位；`AI_CALL_FAILED`／
`AI_DECISION_INVALID`／`SERVICE_AREA_EXCLUDED`／legacy-path 完全無持久記錄——因此
無法做到 0 額外 KV 寫入，thin index 是能同時回答全部 outcome 的最小方案。重複事件
維持 0 額外寫入（transport idempotency 已攔截前一步）。

詳見 `07_KNOWN_ISSUES.md`／`02_PROJECT_HANDOFF.md` 的完整記錄。

## V2.0.2 — Config Drift Hotfix：PBS_AI_DECISION_ENABLED canonical deployment（本輪，2026-08-29）

**根因**：`PBS_AI_DECISION_ENABLED` 從 V1.9.9 Phase 3D 到 V2.0.1 只存在
於 Cloudflare Dashboard 手動設定，從未進入 `wrangler.jsonc`。Workers
Builds 每次部署都把 `wrangler.jsonc` 視為權威來源（與 `TRAFFIC_SOURCE_MODE`
既有機制完全相同——見該 var 自己在 `wrangler.jsonc` 裡的既有註解），
因此 Dashboard-only 的值撐不過下一次 GitHub main → deploy，AI 決策悄悄
退回程式碼預設值 `false`。

```
GPT Work 在 Dashboard 手動設定 PBS_AI_DECISION_ENABLED="true"
    ↓（暫時生效）
下一次 GitHub main push → Workers Builds → wrangler deploy
    ↓
wrangler.jsonc 未宣告此 var → Dashboard-only 值被覆寫／移除
    ↓
resolvePbsAiDecisionEnabled(env) 讀不到值 → fail-safe 回 false
    ↓
AI 決策悄悄停用，沒有人真的改過這個開關
```

**修正**：`wrangler.jsonc` 的 `vars` 正式宣告
`"PBS_AI_DECISION_ENABLED": "true"`（字串形式，resolver 語意本身未改）。
`PBS_AI_DECISION_ENABLED_SOURCE = WRANGLER_CANONICAL_VAR`，
`DASHBOARD_ONLY_AI_SWITCH = RETIRED`，`KEEP_VARS = NOT_USED`。新增
regression guard `scripts/check-deployment-policy.mjs#
checkPbsAiDecisionEnabledVar()`，與既有 `checkRequiredBindings()` 同一
模式，防止未來再次靜默漂移。

**不要誤讀**：17:49 台68事件發生時 AI switch 已被 deployment 移除，
該筆是 legacy 路徑（非 Workers AI）判讀的結果，不算真實 AI 判讀事件。
`FIRST_REAL_AI_EVENT` 仍為 `WAITING`。

詳見 `07_KNOWN_ISSUES.md`／`02_PROJECT_HANDOFF.md` 的完整記錄。

## 主要資料流（Pipeline）

```
TDX（國道/省道 RoadEvent，仍由 Cron 輪詢）+ PBS（V1.9.8起：由 Windows Push 注入，
    見下方「Windows PBS Production Ingress」——下方每一段 Normalization/
    Classification/Eligibility/... 對 PBS 事件仍是同一套函式，只是不再由
    Cloudflare 自己的 30 分鐘輪詢觸發，而是由 debugPush.js 直接呼叫）
        ↓
Normalization  (tdx/normalize.js, pbs/normalize.js)
        ↓
Classification  (tdx/classify.js, pbs/classify.js,
                  dynamicShoulderClassification.js, anomalyClassification.js)
        ↓
Eligibility  (broadcastRules.js — type/keyword 判斷)
        ↓
Effective Window  (effectiveWindow.js — 60 分鐘相關性視窗)
        ↓
Dedupe / Suppression  (dedupe.js — fingerprint 比對；
                        congestionCluster.js — 壅塞群聚；
                        incidentSuppression.js — 事故層級壓抑)
        ↓
Road / Direction / KM / Segment Resolution
    (roadIdentity.js, roadSectionLabel.js, kmLocationResolver.js,
     directionEquivalence.js)
        ↓
CCTV Selection  (tdx/hsinchuCctvProbe.js — 四象限/單鏡頭候選選擇；
                  cctv/dynamicCollage.js — 每事件 CCTV 資格判斷與預算)
        ↓
Image Preparation  (cctv/collage.js — 四象限拼貼＋JPEG decode 驗證；
                     dynamicCollage.js 單鏡頭路徑 — 原始 frame 直接發布)
        ↓
R2  (cctv/publishedImage.js — 短生命週期公開圖片 URL，15 分鐘 TTL)
        ↓
Message Formatting  (messageFormat.js)
        ↓
LINE  (line/pushMessage.js, line/webhook.js)
        ↓
Completed Product  (broadcastPipeline.js 的 completedProducts)
        ↓
Shared Traffic Feed  (traffic/sharedFeed.js — 持久化；
                       traffic/sharedFeedHandler.js — GET /internal/shared-feed 唯讀對外接口)
        ↓
Pipeline Trace  (traffic/pipelineTrace.js, pipelineTraceView.js — 24h 人工查修頁)
```

排程進入點：`traffic/scheduled.js`（Cron，每 10 分鐘）→ `traffic/pipeline.js`（TDX 側）／`pbs/pipeline.js`（PBS 側）→ `traffic/broadcastPipeline.js`（LINE 推播主迴圈 + Shared Feed 持久化觸發）。

## 重要已知架構事實

- **traffic-reporter = Traffic Producer**：TDX/PBS 擷取、分類、播報資格、去重/壓抑、KM/方向/道路解析、訊息格式化、CCTV 全部在這裡決定。Shared Feed 的 `completedProducts` 代表「已經判斷完成，可直接播報」。
- **Consumer 不得重新審核 Producer**：消費端（雙鐵/rail-traffic-consumer）只做透明傳輸（讀取、分頁、投遞），不重新分類、不重新判斷。
- **Shared Feed completed product contract**：`eventId`（`${source}:${rawId}`）、`fingerprint`（`dedupe.js#computeFingerprint`，排除 updatedAt，內容不變則不變）、`updatedAt`（只在 fingerprint 真的改變時才前進，防抖動）、`text`（與本 Worker 自己 LINE 推播內容逐字元相同）、`imageUrl`／`imageExpiresAt`（R2 URL 與其精確到期時間）。見 `src/traffic/sharedFeed.js` module comment 全文。
- **RoadID authoritative（V1.8.7.5）**：`tdx/hsinchuCctvProbe.js#isTargetRoad` — 記錄若帶有 RoadID，一律以 RoadID 為準；RoadName pattern 僅在記錄完全沒有 RoadID 欄位時才作為 fallback。修正真實資料中極少數 RoadID/RoadName 交叉污染的風險。
- **國1 / 國3 CCTV RoadID mapping**（`cctv/dynamicCollage.js#CCTV_SUPPORTED_ROADS`）：國道一號 `roadId:'000010'`（V1.7 確認）；國道三號 `roadId:'000030'`, `roadNamePattern:/國道3號|國道三號/`（V1.8.7.5，由 Production 真實 TRAFFIC_KV 唯讀查證確認，非猜測）。
- **Dynamic shoulder single-camera strategy**（V1.8.7.0）：動態路肩事件用 `selectSingleShoulderCandidate` 選單一代表性鏡頭（同方向、優先落在事件 KM 範圍內），直接發布原始 frame bytes 到 R2，**不經過 JPEG decode/encode**（效能考量）。
- **Accident quad collage strategy**（V1.7 起）：事故用 `selectFourQuadrantCandidates` 選南前/南後/北前/北後四象限鏡頭，`composeQuadrantCollage` 一律先 decode 驗證每張 frame 才拼貼，decode 失敗的象限退回佔位圖，不會把損毀影格流出。
- **CCTV budget / timeout diagnostics**：quad 路徑用整個 run 共享一個 deadline（`CCTV_PREPARE_BUDGET_MS`，預設 4000ms）；single 路徑（V1.8.7.1 起）每一事件各自獨立預算（`SINGLE_CCTV_PER_EVENT_BUDGET_MS`，V1.8.7.3 起為 6000ms）+ 整個 run 的上限（`MAX_SINGLE_CCTV_EVENTS_PER_RUN=5`），避免第一個事件拖慢/餓死後面的事件。
- **CCTV frame extraction（V1.8.7.7）**：`tdx/hsinchuCctvProbe.js#extractFirstJpegFrame` 以 `findJpegImageEnd`/`walkJpegMarkers` 正確依 JPEG marker segment 宣告長度走訪，避免真實攝影機 EXIF 內嵌縮圖造成主影格被誤判截斷（灰色破圖成因）。
- **Broadcast hours**：`traffic/broadcastHours.js`，Asia/Taipei 時區換算；TDX 側額外只在特定時窗內每兩個 tick 才真正呼叫（`tdxSchedule.js`）。
- **Event lifecycle**：新事件 → 分類/資格判斷 → 去重比對 → （若通過）推播 → 寫入 `notified.js` 已通知狀態 → 持續存在則沿用 fingerprint 不重推 → 事件結束/過期則自然淡出。
- **Dedupe / suppression**：`dedupe.js`（fingerprint 比對，避免同內容重推）、`incidentSuppression.js`（事故層級壓抑，避免同一起事故的 TDX/PBS 雙重來源都推播）、`congestionCluster.js`（壅塞群聚去重）。
- **R2 image lifecycle**：`cctv/publishedImage.js`，opaque 128-bit id、`customMetadata.expiresAt` 於每次讀取時檢查（不依賴 R2 lifecycle rule 本身作為有效性依據），TTL 900 秒（15 分鐘）。
- **LINE delivery path**：`line/pushMessage.js`（Push API，text-only 或 text+image 兩則訊息同一次呼叫）、`line/webhook.js`（處理使用者訂閱/取消訂閱等互動指令）、`line/verifySignature.js`（Webhook 簽章驗證）。

## Windows PBS Production Ingress（V1.9.8，2026-08-28，main／ACTIVE／Production）

**V1.9.8 起，這是 PBS 的正式 Production 主線，取代上面「主要資料流」圖中 PBS 那一半
（TDX 側完全不受影響，仍照原圖運作）**。`traffic/scheduled.js` 的 PBS 30 分鐘輪詢
已退休（`pbs/pbsConfig.js#PBS_30_MIN_POLLING_ENABLED = false`）——`pbs/pipeline.js`／
`pbs/lifecycle.js`／`traffic/pbsSchedule.js` 程式碼完整保留、一行未刪，翻回旗標即可
rollback，但目前**不再被 Cron 實際呼叫**。PBS 事件現在唯一的入口是 Windows Push：

```
PBS 警廣官方來源
    ↓
Windows 本機每 3 分鐘抓取 / Local Edge Filter / 生命週期比較（見下方，V1.9.6/V1.9.7 不變）
    ↓
SHOULD_PUSH=YES 的 NEW/UPDATED/CLEARED
    ↓
POST /internal/pbs-debug-push（src/pbs/debugPush.js，就地升級，非另建 endpoint）
    ↓
Authentication → Validation → 持久冪等（V1.9.7，見下方，不變）
    ↓
duplicate？ ── 是 → 停止，0 次以下任何處理
    │ 否
CLEARED？ ── 是 → 只 ACK/log，停止（比照 pbs/pipeline.js 的 clearedEvents 從不進 broadcastEvents）
    │ 否（NEW/UPDATED）
    ↓
buildRawPbsRecordFromPush()：Windows payload → raw-PBS-shaped record
    （happendate/happentime/modDttm 由 payload 自己的 generatedAt 精確反推
     Asia/Taipei 本地時間字串——UTC+8 固定無 DST，非近似值；roadtype 留空，
     因 Windows 本機過濾器已保證 comment 含事故關鍵字，comment-only 分類已足夠）
    ↓
pbs/normalize.js#normalizePbsEvent()（既有、未修改）
    ↓
traffic/broadcastPipeline.js#runLineBroadcast()（既有、未修改——
    與 Cron 輪詢路徑呼叫的「同一個函式」：service area／accident policy／
    location quality／dedupe／incident suppression／CCTV／
    LINE Push Policy／notified-state 全部同一套判斷，0 份重複邏輯）
    ↓
traffic/sharedFeed.js#runSharedFeedPersist()（既有、未修改，與 scheduled.js 呼叫時機相同）
    ↓
LINE（若通過資格判斷）／Shared Feed（無論是否推播成功都記錄完成品）
```

LINE Push Policy（`MAJOR_ACCIDENT_ONLY` 及每一條既有資格規則）**完全未變動**——
Windows 只多了一條事件來源，最終播報與否的決定權仍 100% 在 Cloudflare 這一側，
Windows 從未被賦予這個決定權。已知可接受的副作用：`pbs:lifecycle-state`（輪詢
路徑專用 KV key）不再被寫入；`GET /health` 的 `pbs` 區塊凍結在退休前最後一次真實
數值（Windows 已獨立追蹤 PBS 生命週期，不依賴這個 KV key）。

## V1.9.9 Phase 1（Windows 服務區收斂）＋ Phase 2（AI-ready 準備，2026-08-28）

**Phase 1**（fix commit `7acb82a`，完成於另一個 session，本 Cloud Session 未
參與）：`pbs-relay/src/localPrototype.js` 的服務區篩選收斂為僅新竹市／新竹縣
（竹南／頭份／苗栗市及其他苗栗縣區域排除），純 Windows 端變更，`src/` 下
Cloudflare runtime 一行未動。**這一輪同時把 `pbs-relay/` 整包直接 commit 進
main**——見下方模組清單／段落更新：`pbs-relay/` 不再是未合併的 feature branch。

**Phase 2**（本輪）：新模組 `src/pbs/aiCandidate.js`，與上方 V1.9.8 的
`runLineBroadcast()` 呼叫**並行、完全獨立**——為 Phase 3 Workers AI 全量判讀
做準備，本階段不接 AI、不改變任何真實 LINE 決策：

```
（上方 V1.9.8 流程圖的 normalizedEvent 之後，額外並行一條路徑）
normalizedEvent
    ↓
isWindowsPbsAiCandidateEligible()（重用 traffic/serviceArea.js，與
    runLineBroadcast 自己用的同一個 resolver——唯一的 gate）
    ↓ (true)
buildAiCandidate()（純函式：source/eventId/lifecycle/road/direction/areaNm/
    comment/longitude/latitude/generatedAt + displayKM/eventType/sourceDetail/
    locationQuality（resolveLocationQuality() 唯讀重用，只當 metadata，
    從未作為 gate）——刻意不含 notify/impact，那是 Phase 3 的工作）
    ↓
console.log('[pbs-debug-push][ai-candidate] ...')（唯一輸出：觀察用）
    ↓
（到此為止——candidate 從未觸及 LINE／CCTV／Shared Feed／任何 AI 模型）
```

`PBS_AI_DECISION_MODE = 'PREPARED_NOT_ACTIVE'`：candidate 真的被建構並 log，
但從未被使用於任何決策。`MAJOR_ACCIDENT_ONLY`／V1.5 whitelist／location
quality hard-reject 這三個既有函式**完全未修改**，對真實 LINE 決策仍是完整
生效的 legacy policy，直到 Phase 3 才會被取代。另預留（僅 schema/helper，
本輪無任何 KV 讀寫）AI decision cache key 設計：`computeAiDecisionCacheKeyHash
({eventId, fingerprint})`，重用 Windows 既有穩定 fingerprint。詳見
`07_KNOWN_ISSUES.md` 的完整記錄。

## V1.9.9 Phase 3B — Workers AI Driver Impact Decision Integration（本輪，2026-08-28）

Phase 2 的 candidate／cache key 設計正式接上真實 Workers AI 呼叫，並新增一條
與 legacy `runLineBroadcast()` **互斥**的分支：

```
（承接上方 Phase 2 圖：buildAiCandidate() 之後）
candidate
    ↓
resolvePbsAiDecisionEnabled(env)（kill switch，預設 false）
    ├─ false → 完全未修改的 legacy
    │   runLineBroadcast() + runSharedFeedPersist()（V1.9.8 行為原封不動）
    │
    └─ true → runAiDecisionPath()：
        computeAiDecisionCacheKeyHash({eventId, fingerprint})
            ↓
        readAiDecisionCache()（TRAFFIC_KV，48h TTL，獨立 prefix）
            ├─ hit（AI_CACHE_HIT）→ 直接用快取 decision，0 次 AI 呼叫
            └─ miss（AI_CACHE_MISS）
                ↓
                callWorkersAi()：env.AI.run('@cf/zai-org/glm-4.7-flash', ...)
                    ├─ 失敗（429/5xx/network/binding missing）
                    │   → AI_CALL_FAILED，0 LINE，絕不 fallback 回舊硬規則
                    └─ 成功 → rawText
                        ↓
                    validateAiDecisionResponse()（純函式，嚴格 schema）
                        ├─ 不合格 → AI_DECISION_INVALID，0 LINE，絕不快取
                        └─ 合格 → persistAiDecisionCache() → decision
            ↓
        decision.notify
            ├─ false（AI_NOTIFY_FALSE）→ 只記 audit trace，0 LINE/CCTV/Shared Feed
            └─ true（AI_NOTIFY_TRUE）
                ↓
            runAiApprovedPbsBroadcast()（新 scoped 函式，traffic/
                aiApprovedPbsBroadcast.js）——重用 subscriptions/notified/
                incidentSuppression（事故限定）/messageFormat/CCTV（事故限定）/
                pushMessage；只保留 broadcastHours 執行安全閘門；明確不呼叫
                getBroadcastEligibility／getLinePushPolicyDecision／
                resolveLocationQuality（AI verdict 是 Windows PBS 語意權威）
                ↓
            runSharedFeedPersist()（與 legacy 路徑相同的既有函式）
```

**互斥設計**：AI 開啟時，legacy `runLineBroadcast()` 整段跳過，兩條路徑對
同一事件絕不同時執行——避免舊硬規則與 AI 同時核准同一事件造成 LINE 重複
推播。Exact transport duplicate（既有 idempotency 命中）與 AI cache hit 皆是
0 次 AI 呼叫。CLEARED 事件不進入這條分支（沿用既有 CLEARED 只 ACK/log 的
行為，不呼叫 AI）。

**Kill switch**：`src/pbs/aiConfig.js#resolvePbsAiDecisionEnabled(env)`，
`PBS_AI_DECISION_ENABLED` 預設 `false`。`wrangler.jsonc` 新增
`"ai":{"binding":"AI"}` 宣告，但該宣告本身不會啟用 AI 決策——真正的閘門是
上面這個 code-level kill switch，等 GPT Work 完成 Dashboard 端 AI Binding
建立/驗證後，才由另一個明確指令開啟。

**V1.9.9 Phase 3D Hotfix（2026-08-28）**：`resolvePbsAiDecisionEnabled()`
原本只接受真正的 boolean，但 Cloudflare Dashboard/CLI Variables 一律以
**字串**注入 Worker——GPT Work 設定 `PBS_AI_DECISION_ENABLED="true"` 後
因此永遠判定為 false，AI 決策始終未啟用。修正後同時接受 boolean 與
Cloudflare 字串形式 `'true'`/`'false'`（不分大小寫、trim），其餘一切值
（含 `'1'`/`'yes'`/`'on'`等常見「真值」拼法）仍 fail-safe 回預設值
`false`。詳見 `07_KNOWN_ISSUES.md` 的完整記錄。

**V2.0.0 里程碑現狀（2026-08-28，人類/GPT Work 回報，本 Session 未獨立驗證）**：
GPT Work 回報 `PBS_AI_DECISION_ENABLED = "true"`、`AI_BINDING = ACTIVE`、
`AI_DECISION = ACTIVE`、`LINE_AI_DECISION = ACTIVE`，Cloudflare Active Production
Version 為 `a8e9454c-ab3f-4555-ab7e-0d8c39ecf73c`（Active Traffic 100%），Production
Health = PASS、Worker Errors = 0、AI 429 = 0、AI invalid response = 0。**本 Session
無法從 sandbox 連線 Cloudflare Dashboard 或 Production 網域獨立驗證這些數字**，
按人類回報記錄，不冒充為本 Session 自行證實。`FIRST_REAL_AI_EVENT = WAITING`——
真實 Production PBS 事件走完 Windows → Cloudflare → Workers AI → LINE 完整路徑的
觀察證據尚未取得，這是誠實記錄的下一個 observational milestone，非 V2.0.0 封版
blocker。

詳見 `07_KNOWN_ISSUES.md` 的完整記錄。

## V2.0.0 完整決策順序（PBS 官方來源 → LINE，端對端流程圖）

```
PBS 官方來源
    ↓
Windows Hsinchu Local Edge Filter（新竹市/縣，見下方「服務區治理修正」）
    ↓
Lifecycle（NEW/UPDATED/MISSING_PENDING_CLEAR/CLEARED，見下方「CLEARED 防誤判治理」）
    ↓
Cloudflare Auth（PBS_DEBUG_PUSH_SECRET Bearer）
    ↓
Payload Validation
    ↓
Persistent Transport Idempotency（TRAFFIC_KV，48h，見下方「Cloudflare 端持久冪等」）
    ↓（首次接受的 NEW/UPDATED 才繼續；exact duplicate 到此為止，0 次 AI 呼叫）
AI Candidate（src/pbs/aiCandidate.js#buildAiCandidate()，僅單事件必要欄位）
    ↓
AI Decision Cache（debug:pbs-ai-decision-cache:v1:*，48h TTL）
    ├─ CACHE HIT → 直接重用已驗證的 AI decision，0 次 AI 呼叫 ──────┐
    └─ CACHE MISS                                                  │
        ↓                                                          │
    Cloudflare Workers AI（env.AI.run，@cf/zai-org/glm-4.7-flash） │
        ↓                                                          │
    Validate AI Decision（嚴格 schema，不合格 = AI_DECISION_INVALID │
        → 0 LINE，不快取，不 fallback 舊 hard rules，見下方        │
        「AI failure policy」）                                    │
        ↓                                                          │
    Persist Decision（驗證通過才寫入 cache）←────────────────────────┘
        ↓
    notify=false → 只記 audit trace（eventId/model/impact/reason/confidence/
        cache 命中與否）→ STOP（0 LINE/CCTV/Shared Feed）
    notify=true
        ↓
    AI-approved PBS Broadcast（runAiApprovedPbsBroadcast()）
        ↓
    LINE 執行安全（broadcastHours、notified-state 去重）
        ↓
    optional CCTV enrichment（事故類型限定，失敗絕不擋文字推播）
        ↓
    Shared Feed（runSharedFeedPersist()，與 legacy 路徑相同）
        ↓
    LINE
```

**不得誤讀**：`MAJOR_ACCIDENT_ONLY`／`getBroadcastEligibility`／
`resolveLocationQuality` 三個舊硬規則函式**都不在**這條 Windows AI 路徑上——它們
只存在於 kill switch 關閉時走的 legacy `runLineBroadcast()` 分支，以及 TDX／其他
來源仍在使用的既有路徑。不得以為它們仍在 Windows AI semantic decision 之前把關。

## Cloudflare Workers AI 帳號設定（Model／額度／Context Window）

- **Worker**：`traffic-reporter`；**Binding type**：Workers AI；**Variable name**：`AI`。
- **Model**：`@cf/zai-org/glm-4.7-flash`，固定，透過 `env.AI.run(...)` 呼叫，不依賴
  Anthropic API／OpenAI API／AI Gateway／任何外部付費 API。
- **Context window**：131,072 tokens。
- **計價（Cloudflare Free plan 額度計算基礎）**：Input 5,500 neurons/1M tokens；
  Output 36,400 neurons/1M tokens。
- **免費額度**：10,000 neurons/day，重置時間 00:00 UTC（台灣時間 08:00）。超過額度：
  request 失敗／HTTP 429／帳號受限，**不會自動轉為付費**。
- **估算**（非 Production 實測值）：100 candidate events/day ≈ 457–914 neurons/day
  ≈ 免費額度的 4.57%–9.14%。
- **AI Kill switch**：`PBS_AI_DECISION_ENABLED`（Cloudflare Dashboard/CLI Variable，
  Production 啟用值為字串 `"true"`——見下方「V1.9.9 Phase 3D Hotfix」段落，Cloudflare
  一律以字串注入 Variable，不是真正的 boolean，`resolvePbsAiDecisionEnabled()` 已
  修正為同時接受兩種形式）。
- **Dashboard 操作位置與 Rollback Runbook** → `02_PROJECT_HANDOFF.md`。

## PBS Windows Local Edge Debug Push Integration（V1.9.6/V1.9.7 建立的基礎，Windows 端不變，深度壓縮）

Windows 本機那一半（服務區篩選／CLEARED 治理／持久冪等）——**V1.9.8 完全未修改
這部分**，只把 Cloudflare 端接收後行為升級為正式 Business Pipeline。Windows 端
程式碼在 `pbs-relay/`（自 V1.9.9 Phase 1 起在 main，非 feature branch）；Cloudflare
端在 `src/pbs/debugPush.js`／`debugPushAuth.js`。

```
PBS 官方來源 → Windows 每3分鐘抓取(localMonitor.js) → Local Edge Filter
  (localPrototype.js，重用 Production 自己的 hsinchuFilter.js/roadName.js)
  → 生命週期比較(localState.js) → NEW/UPDATED/CLEARED/UNCHANGED/MISSING_PENDING_CLEAR
  → SHOULD_PUSH判斷 → [NO:停在Windows / YES:Debug Push Client]
  → POST /internal/pbs-debug-push → debugPush.js(V1.9.8起正式Ingress)
```

**三項已修正的真實 bug**（本 Session 皆已讀程式碼確認邏輯存在）：(1) 服務區——舊寬鬆矩形誤收國3 55.8K鶯歌／國1 68.1K楊梅，改直接 import Production 自己的服務區規則；(2) CLEARED——單輪缺席即判 CLEARED 會誤判，改為明確解除文字立即 CLEARED、單純消失需連續兩輪確認（`MISSING_PENDING_CLEAR`→`CONFIRMED_CLEARED`）；(3) 持久冪等（V1.9.7）——L1 記憶體 Map 非唯一真相，新增 L2 `TRAFFIC_KV`（`debug:pbs-push-idempotency:v1:*`，48h TTL，SHA-256 stable key），`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY=PARTIAL`（`KV_ONLY_ATOMICITY=NOT_SUFFICIENT`，理論極窄race window，KV outage fail OPEN）。

完整記錄（Secret 治理事故、六階段路線圖、Task Scheduler 細節、Emergency kill switch）→ `07_KNOWN_ISSUES.md`／`SYSTEM_STATE.json.pbsLocalEdgeFilterPrototype`。緊急停用：Windows 環境變數 `PBS_DEBUG_PUSH_ENABLED=false`+重啟本機排程；暫時恢復 Cloudflare 自身 PBS 輪詢：`PBS_30_MIN_POLLING_ENABLED=true` 並重新部署。

## V2.4.11 — 散落物安全風險分級 ＋ LINE Push 額度保護（本輪，2026-09-04）

新純函式模組 `src/traffic/debrisRiskPolicy.js#resolveDebrisSafetyRisk(event)`（零 KV／I/O，同步，自成一套關鍵字表，不 import GEO/道路政策/PBS classify 任何既有模組）。判定優先序（第一個命中者勝）：①`HIGH_RISK`——車道位置（內側/中間/外側/快/慢車道/車道中央/路中央/行車道）或大型危險物（整條輪胎/大片輪胎皮/大型金屬/鐵件/木板/棧板/家具/貨物/大型紙箱等）或多件數量（多塊/多個/散落多處/大量）或明確交通影響文字（影響通行/車輛閃避/占用車道/危險）或結構化`blockedLanes>=1`，任一命中即成立，且**優先於**路肩/已清除等訊號檢查（故「路肩大型物體部分侵入外側車道」仍正確判HIGH_RISK）；②`LOW_RISK`——僅在①未命中時才看：路肩／路外安全島／已清除／小型碎屑；③`AI_REVIEW`——散落物相關但證據不足（例：「95K+200路面發現散落物狀況」），交既有AI綜合研判。

整合點：`aiCandidate.js#buildAiCandidate()`一次算出`candidate.debrisRisk`（沿用displayKM/blockedLanes/geoEvidenceType的"永遠存在、缺席為null"慣例）；`debugPush.js#runAiDecisionPath()`（PBS/TDX唯一共用入口）在`!candidate`判斷之後新增`LOW_RISK`短路，回傳新`AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK`，0額外AI呼叫、0額外KV寫入（沿用同一筆既有Observatory write）；`aiDecisionEngine.js`把`debrisRisk`當作結構化事實傳給AI（從不越俎代庖決定notify），SYSTEM_PROMPT補充HIGH/LOW信心散落物判準，明確禁止AI替原文沒提到的散落物事實杜撰車道/占用/危險描述。`HIGH_RISK`／`AI_REVIEW`皆完整交由既有AI二次確認，從未直接發LINE。查修頁新增DEBRIS RISK唯讀展開區塊（🔴/🟡/🟢+evidence+reasons+最終決策原因），PBS/TDX共用同一顯示邏輯。未觸碰：GEO Resolver、道路管理政策、Queue、Incident Memory、CCTV、AI model、LINE token/quota系統。完整記錄見 `07_KNOWN_ISSUES_02.md`。

**V2.4.12 修正（PATCH，2026-09-04）**：debrisRiskPolicy.js 新增 CLEARED_TERMINAL 判斷（HIGH_RISK 檢查前的唯一例外）——已清除訊號（原文或結構化 lifecycle===CLEARED）且無持續性訊號（仍有/部分等）時，優先於歷史 HIGH_RISK 證據判 LOW_RISK；伴隨持續性訊號時不套用。resolveDebrisSafetyRisk() 新增第二參數 lifecycle，舊呼叫不受影響。詳見 07_KNOWN_ISSUES_02.md。

**V2.4.13 修正（PATCH，2026-09-04，UI ONLY）**：aiObservatoryView.js 新增 export 函式 deriveCompactNoSendReason(record, decision)，收合卡片新增紅字不通報/處理失敗原因區塊，優先用既有AI decision cache reason（0額外KV讀取），否則套GEO/道路政策/散落物人話化樣板。deriveFinalDecisionReason() 補AI_NOTIFY_TRUE重複通知分支。AI/GEO/道路政策/Queue/CCTV/LINE token系統全數未動。詳見 07_KNOWN_ISSUES_02.md。

**V2.4.14 修正（PATCH，2026-09-04，純CSS）**：不通報原因區塊重新分色——標題亮黃#facc15字重800，本文近白#f2f3f5字重700，外框深紅不變；deriveCompactNoSendReason()逐字不變。詳見 07_KNOWN_ISSUES_02.md。

## 模組清單（自動掃描）

- **src/./**: index.js, version.js
- **src/cctv/**: bitmapFont.js, collage.js, dynamicCollage.js, freewayCctvMetadataCache.js, jpegCodecWorker.js, publishedImage.js
- **src/cctv/generated/**: cjkGlyphRaster.js
- **src/generated/**: buildMetadata.js
- **src/line/**: broadcastIntent.js, pushMessage.js, replyMessage.js, verifySignature.js, webhook.js
- **src/pbs/**: aiCandidate.js, aiConfig.js, aiDecisionCache.js, aiDecisionEngine.js, aiObservatoryIndex.js, aiObservatoryView.js, classify.js, client.js, crossSourceDedup.js, debugPbs.js, debugPush.js, debugPushAuth.js, hsinchuFilter.js, lifecycle.js, normalize.js, pbsConfig.js, pipeline.js, roadName.js, vpcProbe.js
- **src/security/**: adminAuth.js
- **src/tdx/**: auth.js, cctvProbe.js, classify.js, client.js, debug.js, extract.js, fetchAll.js, hsinchuCctvProbe.js, hsinchuGeoResolver.js, normalize.js, roadManagementPolicyGate.js, sources.js, tdxQueueIngress.js, usageLedger.js, vdSpeed.js
- **src/traffic/**: aiApprovedPbsBroadcast.js, anomalyClassification.js, broadcastHours.js, broadcastPipeline.js, broadcastPolicy.js, broadcastProvenance.js, broadcastRules.js, congestionCluster.js, congestionSeverity.js, congestionValidation.js, debrisRiskPolicy.js, debugStatus.js, dedupe.js, deploymentStatus.js, deploymentStatusView.js, directionEquivalence.js, dynamicShoulderClassification.js, effectiveWindow.js, health.js, healthSnapshot.js, hsinchuConfig.js, hsinchuFilter.js, incidentMemory.js, incidentSuppression.js, kmLocationResolver.js, locationQuality.js, messageFormat.js, notified.js, parseChineseDate.js, pbsSchedule.js, pipeline.js, pipelineTrace.js, pipelineTraceView.js, roadIdentity.js, roadSectionLabel.js, scheduled.js, serviceArea.js, sharedFeed.js, sharedFeedHandler.js, sourceMode.js, subscriptions.js, tdxEventCache.js, tdxSchedule.js
- **src/util/**: contentEqual.js
