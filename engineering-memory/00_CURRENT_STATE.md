<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

> **Known Issues 已分卷（2026-09-04起）**：`07_KNOWN_ISSUES.md`（Volume 01，歷史封存，完整保留不刪）＋`07_KNOWN_ISSUES_02.md`（Volume 02，CURRENT，新記錄從這裡寫）。查任何舊 Bug／技術債／根因／修復教訓，**兩卷都要查**，只讀一卷不算完整。詳見 Volume 02 開頭的卷別承接說明。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V2.4.15（唯一權威來源：`src/version.js` 的 `APP_VERSION`；本輪封版令為治理/紀錄封版，不改版號、不改Runtime） |
| Source main HEAD | 470c87a（TRAFFIC_REPORTER_V2_4_15_QWEN_AI_MODEL_REPLACEMENT Runtime commit） |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty（本輪 TRAFFIC_REPORTER_V2_4_15_PRODUCTION_SEAL 治理封版 changeset，僅 Engineering Memory，與本份快照同一 commit 一起送出） |
| Production | DEPLOYED（依本輪封版令回報：Production `/version`=V2.4.15、model顯示為Qwen，2026-09-04 17:01:54 +08部署，第一批4筆AI呼叫皆成功） |
| Production Verification | 依本輪封版令回報：LIVE_RUNTIME_VERIFIED=YES、SMOKE_TEST=PASS。`PRODUCTION_COMMIT_VERIFICATION=UNVERIFIABLE`（live buildMetadata.deployedCommit="unknown"，無法直接證明470c87a即為live commit，見下方封版節） |
| Current Phase | Production｜PBS-ONLY + 重大事故限定 LINE Push（維持不變）＋ TDX Freeway/Highway RoadEvent 走統一 Queue/AI/Memory pipeline，TDX 正式 LINE 通知維持開啟（PHASE_E_TDX_NOTIFY_LIVE，本輪未變動）。**V2.4.15已封版為SEALED_FOR_PRODUCTION_OBSERVATION**：PBS_AI_MODEL_ID=Qwen已上線，ROOT_CAUSE_FIX_CONFIRMED=YES（首批4筆0逾時），24H_VALIDATION=PENDING。本輪治理封版令本身不改任何Runtime。 |
| Current Task | none。Latest completed task = TRAFFIC_REPORTER_V2_4_15_PRODUCTION_SEAL，status = **SEALED_FOR_PRODUCTION_OBSERVATION**。CURRENT_RUNTIME_PHASE 仍 PHASE_E_TDX_NOTIFY_LIVE（本輪未動任何 Runtime/wrangler.jsonc）。封版後規則：禁止再改V2.4.15 Runtime，新問題另開V2.4.16。 |
| Latest Completed Version | V2.4.15 |
| Known Blocker | **GOOGLE_DRIVE_SYNC_BLOCKED_FOR_NEW_FILES**（既知，見07_KNOWN_ISSUES_02.md，不阻擋封版）＋ 新增 **BUILD_METADATA_GENERATION_BUG**（`OPEN`，live buildMetadata.deployedCommit="unknown"/commitSource="not-yet-generated"，導致PRODUCTION_COMMIT_VERIFICATION=UNVERIFIABLE，列獨立後續治理項，不阻擋本輪封版）。另沿用 V2.4.5 封版的 REAL_WORLD_CONFIRMATION_PENDING（TDX正式LINE通知現場觀察） |
| Real-world Confirmation | V2.4.15 Qwen首批4筆Production AI樣本（依封版令回報）：SUCCESS=4/4、TIMEOUT=0、LATENCY_AVG=5,410ms、QUEUE_READ_WRITE_RATIO=1.00、KV_429/5XX=0、NEW_RUNTIME_ERRORS=0，ROOT_CAUSE_FIX_CONFIRMED=YES。**24H_VALIDATION=PENDING**——4筆樣本不等於完整24小時統計，待滿24h後與V2.4.14基準（timeout≈85%、Queue Ratio≈1.94）比對 |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | （最優先，沿用）人類於Drive手動建立`07_KNOWN_ISSUES_02.md`後重跑sync驗證。新增：①滿24小時後做唯讀Production observation，比對V2.4.14基準，PASS則追加`24H_VALIDATION=PASS`／`FINAL_STATUS=SEALED_AND_VALIDATED`（不升版號）；②調查BUILD_METADATA_GENERATION_BUG（deployedCommit為何顯示unknown），視為獨立議題，不得與V2.4.15 Runtime混改；③禁止直接修改已封版V2.4.15，新問題一律開V2.4.16 |
| Export Generated At | 2026-09-04T17:30:00.000Z |
| Export artifact commit | uncommitted-at-generation-time (resolved by git history, never self-referenced) |

## V2.4.15 正式封版（2026-09-04）— SEALED_FOR_PRODUCTION_OBSERVATION

**任務**：`TRAFFIC_REPORTER_V2_4_15_PRODUCTION_SEAL`（路況播報員｜V2.4.15 正式封版令）。GOVERNANCE/VERSION RECORD ONLY——本輪僅更新 Engineering Memory，不改任何 Runtime／`APP_VERSION`／model／prompt／timeout／Queue／KV／GEO／LINE。

**封版依據（依本輪封版令回報，本session無Production網路存取無法自行驗證，如實轉載）**：Production 2026-09-04 17:01:54 +08部署，`/version`=V2.4.15、model=`@cf/qwen/qwen3-30b-a3b-fp8`、`AI_CALL_TIMEOUT_MS`=45000。第一筆AI：duration=3,302ms、outcome=AI_DECISION_VALID、notify=false、impact=LOW、無Queue重試。首批共4筆：SUCCESS=4、TIMEOUT=0、INVALID=0，LATENCY_MIN/AVG/MAX=3,302/5,410/7,006ms，QUEUE_WRITE/READ/DELETE=4/4/4（Ratio=1.00），KV_429=0、KV_5XX=0、NEW_RUNTIME_ERRORS=0。`ROOT_CAUSE_FIX_CONFIRMED=YES`。**`24H_VALIDATION=PENDING`**——4筆樣本不構成完整24小時統計，禁止描述為已完成驗收。

**Production commit可追溯性（誠實記錄，不得推定）**：GitHub V2.4.15 Runtime commit=`470c87a480a3ad5a2930a9896829d1a809b306a2`；但live buildMetadata回報`deployedCommit="unknown"`／`commitSource="not-yet-generated"`，本輪無法直接證明該commit即為live commit。`COMMIT_MISMATCH=NO`（無證據顯示不符）、`COMMIT_VERIFIED=NO`、`PRODUCTION_COMMIT_VERIFICATION=UNVERIFIABLE`。列為獨立後續治理項`BUILD_METADATA_GENERATION_BUG=OPEN`，不阻擋本輪封版，也不得與V2.4.15 Runtime本身混為一談。

**封版後規則**：`APP_VERSION`維持V2.4.15不變，本輪治理封版commit本身`DOES_NOT_CHANGE_RUNTIME=YES`。封版後禁止再修改V2.4.15 Runtime；僅允許（A）滿24小時後唯讀Production observation，PASS則追加`24H_VALIDATION=PASS`／`FINAL_STATUS=SEALED_AND_VALIDATED`（不升版號），（B）若發現新Runtime問題另開V2.4.16，不得直接改已封版的V2.4.15。

**Drive Sync**：`07_KNOWN_ISSUES_02.md`建檔仍撞既知service-account 403，記錄`DRIVE_SYNC_VOLUME02=BLOCKED_KNOWN_403`，不重新調查、不阻擋封版，GitHub copy為canonical。

## V2.4.15（2026-09-04）— QWEN FAST AI MODEL REPLACEMENT（Runtime/Test/EngMemory SEALED；Production現場驗證由本封版令回報確認）

- `TRAFFIC_REPORTER_V2_4_15_QWEN_AI_MODEL_REPLACEMENT`，HIGH priority，ROOT CAUSE FIX / MINIMAL MODEL REPLACEMENT。
- **根因**：Production 48h 34次AI呼叫，29次（≈85%）撞45秒`AI_CALL_TIMEOUT_MS`。Direct 20次呼叫`@cf/zai-org/glm-4.7-flash`：AVG=43,833ms/P50=34,142ms/P95=81,800ms/MAX=104,677ms，>45s佔25%。確認`PIPELINE_OVERHEAD≈0ms`、`TRAFFIC_REPORTER_CALL_CHAIN_PROBLEM=NO`、`MODEL_LATENCY_PROBLEM=YES`——glm-4.7-flash是reasoning模型，對本專案簡短即時判斷產出過長completion（completion_tokens≈2,413，reasoning≈4,101字元）。Shadow benchmark `@cf/qwen/qwen3-30b-a3b-fp8`：AVG=3,897ms/P50=3,747ms/P95=5,701ms/MAX=6,222ms，0/20逾時，20/20 schema valid，同測資notify/impact判定與glm 100%一致。
- **修法（唯一Runtime修改）**：`src/pbs/aiDecisionEngine.js`的`PBS_AI_MODEL_ID`從`'@cf/zai-org/glm-4.7-flash'`改為`'@cf/qwen/qwen3-30b-a3b-fp8'`。確認整個runtime僅從此一常數讀取model名稱（`test/v2415QwenAiModelReplacement.test.js` CASE1驗證code區段僅一個model字面值）。`wrangler.jsonc`一處說明性註解同步更新（非實際config值）。
- **明確未動**：`AI_CALL_TIMEOUT_MS`維持45000ms；`SYSTEM_PROMPT`／`buildAiUserPrompt()`／`MEMORY_CONTEXT_PROMPT_SUFFIX`逐字不變；AI request無新增`max_tokens`/`temperature`/`top_p`/`seed`/`response_format`/`json_schema`/`stream`；`PBS_AI_QUEUE`（`max_batch_size=1`／`max_retries=3`）不變；KV（decision-cache/observatory-index/pipeline-trace/push-idempotency/event-cleared/TTL/key schema）不變；GEO Resolver／Road Policy／Debris Risk Policy／Incident Memory／dedupe／CCTV／LINE formatter／LINE quota／notification hours／Production flags全數不變。
- **測試**：新增`test/v2415QwenAiModelReplacement.test.js`（11項，施工令§十二 12項checklist覆蓋，10/11/12項由既有全量迴歸與既有測試檔驗證，不重複斷言）。同步更新`test/aiDecisionEngine.test.js`／`test/v242InformationFidelityAndPolicy.test.js`／`test/tdxUnifiedAiPipeline.test.js`（model字串斷言）與`test/pbsAiConfigDriftHotfixV202.test.js`（drift-protection測試5更名＋改期望值，測試6凍結歷史檢查逐字不變）。全量迴歸1880/1848/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.14→V2.4.15。
- **Production驗證限制**：本session無Production網路存取（全程確認），依施工令§十三自身明確指示，Production `/version`現場確認、§十四上線後即時 smoke test、§十五 24小時驗收全部報告為`REQUIRES_CLAUDE_BROWSER`／待後續觀察，不猜測、不捏造。main push後由既有治理（main push→Cloudflare Workers Builds自動部署）處理，本輪未做任何手動deploy。
- **Engineering Memory**：完整benchmark記錄與24小時驗收待辦寫入`07_KNOWN_ISSUES_02.md`（Volume 02，非已滿的Volume 01）。Google Drive Volume 02同步沿用既有已知403 blocker，不重新調查，不阻擋本輪Runtime部署。

## V2.4.14 封版（2026-09-04）— 查修頁不通報原因視覺強化 Hotfix

- `V2_4_13_1_OBSERVATORY_NO_SEND_REASON_VISUAL_CONTRAST_HOTFIX`，PATCH，純 CSS／呈現層 Hotfix。施工令自寫「V2.4.13.1」，本專案四段式版號已於 V1.8.7.14 退休，依前例（`V2_4_11_1_...`）改走三段式 V2.4.13→V2.4.14。
- **問題**：V2.4.12/V2.4.13 新增的「不通報原因」紅字區塊，標題與本文皆同一種紅（`#f85149`）疊在深紅背景上，Production 真實回報：手機深色模式對比不足、長句不易快速掃讀。
- **修法**：`src/pbs/aiObservatoryView.js` 的 `PAGE_STYLE` 三層重新分色（`deriveCompactNoSendReason()` 與其樣板字串逐字不變，純 CSS）——外框（背景 `#2b1414`／邊框 `#4a1f1f`）維持深紅警示感不變；標題（「❌ 不通報原因：」／「❌ 處理失敗原因：」）改亮黃 `#facc15`（本頁新增色，既有 warn 色 `#e3b341` 對比不足）、字重 800、19-20px；本文（真正原因）改近白 `#f2f3f5`（沿用既有 h1／`.col-road` 同一色，非新色）、字重 700、18-20px。標題與本文為兩個不同顏色規則，滿足施工令「禁止整段全黃」。
- **測試**：新增 `test/v24131ObservatoryNoSendReasonVisualContrastHotfix.test.js`（5項，施工令§七CASE1-5全覆蓋）。全量迴歸1869/1837/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.13→V2.4.14。
- **未觸碰**：AI SYSTEM_PROMPT/notify政策、散落物分級政策、GEO、道路政策、Queue、Incident Memory、dedupe、LINE formatter、CCTV、Production flags、原因選擇/截斷/缺失回報邏輯本身。完整記錄見 `07_KNOWN_ISSUES_02.md`。

## V2.4.13 封版（2026-09-04）— 查修頁「不通報原因」高可視化改版

- `V2_4_12_OBSERVATORY_NO_SEND_REASON_HIGH_VISIBILITY_UI`，PATCH，OBSERVABILITY/UI ONLY。施工令自寫 `APP_VERSION_BEFORE=V2.4.11→AFTER=V2.4.12`，但開工時 session 已因前輪封版而是 V2.4.12，依「版本號不重複用於兩個不同 diff」永久規則，本輪改為 V2.4.12→V2.4.13。
- **問題**：查修頁收合卡片只顯示極簡狀態徽章（例如「🤫 AI：不需主動通報 / LOW」），使用者必須點開展開頁才知道真正的不通報原因，手機現場查修不便，也難以分辨「系統處理失敗」與「AI 正常判定不通報」。
- **修法**：`src/pbs/aiObservatoryView.js` 新增（已 export 供直接測試）`deriveCompactNoSendReason(record, decision)`——優先序：AI_NOTIFY_FALSE 時優先用既有 AI decision cache 的真實 reason（該筆 cache 本來就已為每一列讀取，0 額外 KV 讀取）；否則依 outcome 套一組人話化樣板（重用既有 `blockedLanes`／`debrisRisk.reasons`／`suppressedForPhase`／`timedOut` 欄位）；系統失敗（AI 呼叫失敗/回應無效/背景重試耗盡）標籤為「❌ 處理失敗原因」，與正常判定不通報的「❌ 不通報原因」明確區分；原因超過 100 字決定性截斷加刪節號，完整原文仍留在展開頁；真的沒有任何原因時誠實顯示「系統未記錄詳細原因，請展開查看流程紀錄。」。新區塊直接嵌在 `<summary>` 內（收合即可見），鮮紅 `#f85149`（沿用既有 `.badge-line-fail` 危險色）、粗體、18-20px，可換行 2-3 行，永遠自成一行不與徽章重疊。
- **同步小修**：`src/pbs/aiObservatoryIndex.js#deriveFinalDecisionReason()` 新增唯一分支——`AI_NOTIFY_TRUE` 但從未 `lineSent` 時，若既有 `sameIncident===true && materialChange===false`，回報「重複事件：與近期已通知過的同一起事故相同，且無實質變化，未重複發送」，取代先前的 `UNKNOWN / NOT RECORDED`；既有每個分支原始字串逐位元組不變（既有鎖定測試全數原樣通過）。
- **測試**：新增 `test/v2412ObservatoryNoSendReasonHighVisibilityUI.test.js`（15項，施工令§十八CASE1-13全覆蓋）。全量迴歸1864/1832/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.12→V2.4.13。
- **未觸碰**：AI SYSTEM_PROMPT/notify政策、散落物分級政策、GEO、道路管理政策、Queue、Incident Memory（僅讀既有欄位）、dedupe、LINE formatter、CCTV、Production flags。完整記錄見 `07_KNOWN_ISSUES_02.md`。

## V2.4.12 封版（2026-09-04，PARTIAL_SEALED）— 散落物已清除優先序＋工程記憶同步修正令

- `V2_4_11_1_DEBRIS_CLEARED_PRECEDENCE_AND_MEMORY_SYNC_HOTFIX`，PATCH。任務名稱沿用四段式標籤（工程令自訂識別碼），實際產品版本仍走本專案三段式規則：V2.4.11→V2.4.12。
- **Part 一（程式碼，已完成）**：V2.4.11 上線的散落物分級器「HIGH_RISK 一律優先檢查」規則，對已清除事件判斷錯誤——「中間車道有輪胎皮，已清除，恢復正常通行」誤判 HIGH_RISK。`src/traffic/debrisRiskPolicy.js` 新增 CLEARED_TERMINAL 判斷（本模組唯一反轉優先序的例外，在 HIGH_RISK 檢查之前執行）：已清除訊號（原文 已清除/已排除/已恢復/已移除/已拖離/已無障礙，或結構化 `lifecycle==='CLEARED'`，沿用 `aiCandidate.js` 既有參數）且**沒有**伴隨持續性訊號（仍有/仍在/尚有/未清除/未完全/部分/持續/尚未）時，一律 LOW_RISK，無論原文是否也提到車道位置等歷史證據；伴隨持續性訊號時（例：「已清除部分，仍有散落物」）不套用，依剩餘證據正常判定。`resolveDebrisSafetyRisk()` 新增第二參數 `lifecycle`，舊呼叫方式不受影響。
- **測試**：新增 CASE A（LOW_RISK）／CASE B（不得LOW_RISK，含無其他證據變體→AI_REVIEW）／CASE C（結構化lifecycle，含2個變體）／CASE D（既有規則保持HIGH_RISK）／2項既有CASE迴歸確認。全量迴歸1849/1817/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.11→V2.4.12。
- **未觸碰**：GEO Resolver、Queue、Incident Memory、CCTV、KV讀寫形狀、LINE quota架構、Production flags。
- **Part 二（Google Drive 同步，未完成）**：施工令要求人類先在 Drive 手動建立 `07_KNOWN_ISSUES_02.md`（真人帳號），確保 Service Account 有更新權限，再重跑 sync。本 session 以唯讀 `search_files` 核對目標資料夾，確認**該檔案尚未存在**（資料夾內仍只有原本 10 份 canonical 檔案，皆為真人帳號所有）。人類尚未完成第一步，因此本輪**未**重新觸發 sync（重跑只會重現已知 403），也**未**將三檔標記 SYNCED。**FINAL 未標記 SEALED**——施工令自身要求三檔皆 SYNCED 才能 SEALED。完整記錄見 `07_KNOWN_ISSUES_02.md`。

## V2.4.11 封版（2026-09-04）— 散落物安全風險分級／LINE Push 額度保護

- `V2_4_11_DEBRIS_SAFETY_RISK_CLASSIFICATION_AND_PUSH_PROTECTION`，MINOR，GEO_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、QUEUE_MODIFIED=NO、AI_SECOND_CALL_ADDED=NO。
- **問題**：PBS/TDX 掉落物/散落物事件從真正危險的在途障礙物到毫無細節的模糊回報都有；不能「一律通知」也不能「一律不通知」。
- **新模組**：`src/traffic/debrisRiskPolicy.js#resolveDebrisSafetyRisk(event)`（純函式，零KV/I/O，自成一套關鍵字表）。優先序：①車道位置（內側/中間/外側/快/慢車道/車道中央/路中央/行車道）或大型危險物（整條輪胎/大片輪胎皮/大型金屬/鐵件/木板/棧板/家具/貨物/大型紙箱）或多件數量或明確交通影響文字（或結構化`blockedLanes>=1`）任一命中即`HIGH_RISK`，且優先於路肩/已清除訊號檢查（故「路肩大型物體部分侵入外側車道」仍正確判HIGH_RISK，「紙箱」單字不會單獨決定分級）；②否則路肩/路外/已清除/小型碎屑即`LOW_RISK`；③否則`AI_REVIEW`（例：「95K+200路面發現散落物狀況」，交既有AI綜合研判）。
- **整合**：`aiCandidate.js`新增`candidate.debrisRisk`欄位（沿用displayKM/blockedLanes/geoEvidenceType慣例）；`debugPush.js#runAiDecisionPath()`（PBS/TDX唯一共用入口）於`!candidate`判斷後新增`LOW_RISK`短路，回傳新`AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK`，0額外AI呼叫、0額外KV寫入；`aiDecisionEngine.js`把`debrisRisk`當結構化事實傳給AI，SYSTEM_PROMPT補充HIGH/LOW信心散落物判準，明確禁止AI替原文沒提到的散落物事實杜撰車道/占用/危險描述；`HIGH_RISK`／`AI_REVIEW`仍完整交由既有AI二次確認，從未直接發LINE。
- **查修頁**：`aiObservatoryIndex.js`新增`debrisRisk`觀測欄位；`aiObservatoryView.js`新增DEBRIS RISK唯讀展開區塊（🔴HIGH_RISK/🟡AI_REVIEW/🟢LOW_RISK＋evidence＋reasons＋最終決策原因），PBS/TDX共用同一顯示邏輯。
- **測試**：新增`test/v2411DebrisSafetyRiskClassificationAndPushProtection.test.js`（25項，施工令§十八CASE1-19全覆蓋＋PBS/TDX整合＋KV成本測試）。全量迴歸1839/1807/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.10→V2.4.11。
- **未觸碰**：TDX GEO Resolver、Freeway KM驗證範圍、PBS地理閘門、道路管理政策、Queue、Incident Memory、CCTV、AI model、LINE token/quota系統、wrangler.jsonc任何開關。完整記錄見 `07_KNOWN_ISSUES_02.md`。

## V2.4.10 封版（2026-09-04）— TDX 國道公里數第二正向地理證據

- `V2_4_10_TDX_FREEWAY_KM_HSINCHU_DETERMINISTIC_GEO_FALLBACK`，MINOR，PBS_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、AI_POLICY_MODIFIED=NO、LINE_POLICY_MODIFIED=NO。
- **核心目標**：TDX｜高公局事件常見形狀——有國道名稱＋方向＋KM，但無座標無areaNm——即使 V2.4.7 已能解析出 KM，仍因缺乏「正向新竹證據」永遠停在 UNKNOWN。本輪新增第二套決定性正向證據：已驗證國道路線＋已驗證公里範圍。
- **§一最高安全原則**：明確禁止恢復舊式「大範圍 KM 猜縣市」，必須是 OFFICIAL/VERIFIED KM RANGE + EXACT ROAD 才能 CONFIRMED，任何不確定一律 UNKNOWN。
- **資料來源與方法（§五，禁止用 Google 摘要/論壇/AI 記憶當權威）**：交叉比對本 repo 已有的兩份官方政府資料集——國道百公尺里程樁（data.gov.tw dataset 95016，交通部高速公路局，0.1km解析度）與直轄市縣市界線（data.gov.tw dataset 7442，內政部國土測繪中心）——用 `hsinchuGeoResolver.js` 既有的 `isPointInRings()` 同一演算法逐點檢驗，取得國1/國3實際經過新竹市/縣的公里範圍（各恰好一段連續區間，邊界銳利無雜訊）：國1原始 75.2K–107.3K、國3原始 74.6K–109.4K。
- **§六安全邊界**：兩端各內縮 0.5km 保守安全邊界（`VERIFIED_HSINCHU_FREEWAY_KM_SAFETY_MARGIN_KM=0.5`），最終國1=75.7K–106.8K、國3=75.1K–108.9K。此邊界正確地把已知橫跨新竹市/苗栗縣交界的香山交流道（109K）排除在外（原始範圍內但安全邊界外），驗證邊界設計確實保守。
- **新模組**：`src/tdx/hsinchuFreewayKmRanges.js`（靜態程式資料表＋純函式 `resolveVerifiedHsinchuFreewayKm({road, displayKM})`，零 KV/I/O/async，重用既有 `canonicalFreewayRoad()` 做道路 normalization）；`scripts/verifyHsinchuFreewayKmRanges.mjs`（可重跑的獨立驗證腳本，重新從兩份原始資料集衍生範圍並與程式內表格比對，供資料集更新時重新核對）。
- **接入 GEO Resolver（§二優先順序）**：`hsinchuGeoResolver.js` 新增 LEVEL 3／Tier 4，只在 Tier 1（座標）與既有 Tier 3（明確地名文字）皆無證據時才呼叫，只在 `event.source==='freeway'` 時檢查；只能回傳 CONFIRMED_HSINCHU 或不決定（null→UNKNOWN），永不回傳 OUTSIDE_HSINCHU（§十一：範圍外不代表 OUTSIDE，只是無證據）。座標優先順序透過「先呼叫 Tier1，有結果就直接 return」的既有結構保證——有座標時新 tier 根本不會被呼叫，衝突情境不可能發生。
- **§十三/十四驗證**：GEO CONFIRMED ≠ LINE 一定發——101K+300 施工事件 GEO 現在確認但 Road Policy 仍因 blockedLanes 未知而 fail-closed（V2.4.5 政策不變）；100K+000 天候事件 GEO 確認且非道路管理事件類型，正常進 Queue，是否通知仍完全由既有 AI 決定。
- **查修頁（§十七）**：`aiObservatoryIndex.js` 新增 `geoEvidenceType` 欄位（哪一層確認的，純觀測不影響決策）；`aiObservatoryView.js` GEO 區塊新增顯示「✅ 官方座標行政區／✅ 明確地名／✅ 國道公里範圍／❌ 無足夠證據」。
- **測試**：新增 `test/v2410TdxFreewayKmHsinchuDeterministicGeoFallback.test.js`（18項，含施工令§十九全部CASE1-16）。既有 `test/v247TdxGeoInputMissingFix.test.js`／`test/v248TdxKmFallbackProductionRuntimeDiagnosis.test.js` 各有數項斷言因這輪刻意的、預期中的行為改變（KM 現在真的能 CONFIRMED 了）而更新，非回歸，皆已加註「SUPERSEDED BY V2.4.10」說明。全量迴歸1814/1782/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.9→V2.4.10。
- **未觸碰**：PBS Windows/pbs-relay（結構測試鎖住：`hsinchuFreewayKmRanges.js` 絕不被任何 `pbs/*.js` import）、Road Policy 閘門本身、AI prompt/model、LINE 政策、Queue、CCTV、`wrangler.jsonc` 全部開關。

## V2.4.9 封版（2026-09-04）— TDX KM Fallback Production Runtime Diagnosis（P0 實機異常查修）

- `V2_4_8_TDX_KM_FALLBACK_PRODUCTION_RUNTIME_DIAGNOSIS`，PATCH，GEO_RESOLVER_MODIFIED=NO、PBS_MODIFIED=NO、AI_MODIFIED=NO、LINE_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO。
- **起因**：Production 查修頁兩筆 TDX｜高公局事件——國道一號 北向「101K+300 施工事件-施工維護」、南向「100K+000 天候事件-天候不佳」——displayKM/longitude/latitude 全顯示 —，GEO=UNKNOWN/Gate A 排除，儘管 V2.4.7 理論上已加入 description 文字 KM 後援。
- **逐層 runtime trace 結論（直接執行程式碼驗證，非猜測）**：(A) `extractKmTokenFromText()`/`parseKM()` 正確回傳 "101K+300"/101.3、"100K+000"/100——PARSER_BUG=NO。(B) `normalizeRoadEvent()` 正確把 displayKM 寫進回傳的 canonical event 物件——NORMALIZE_BUG=NO。(C) `resolveTdxHsinchuGeography()` 讀的是真正的 event 物件（非任何 candidate 副本），正確收到 KM 進 Tier-2 觀測層，且正確維持 UNKNOWN（無座標/地名證據，KM 本身不構成 CONFIRMED 證據——這是安全行為，非 bug）——GEO_RESOLVER 本身未受影響、未修改。(D) **真正的 bug**：`src/tdx/tdxQueueIngress.js#buildTdxPseudoCandidate()`——這是 Gate A 排除事件專用的查修頁記錄 candidate builder（V2.4.6 建立），早於 V2.4.7 才新增的 `displayKM` 欄位，V2.4.7 上線時沒有同步更新這個本地 builder，導致 `aiObservatoryIndex.js#buildAiObservatoryRecord()`（讀 `candidate.displayKM`）對所有 Gate A 排除的 TDX 事件永遠寫入 `displayKM: null`——OBSERVABILITY_MAPPING_BUG=YES。(E) 通過 Gate A、進 AI 的 TDX 事件本就使用真正的 `aiCandidate.js#buildAiCandidate()`（V2.4.5 起就有 displayKM），完全未受此 bug 影響——已用測試（CASE 4c）驗證。
- **修法**：`buildTdxPseudoCandidate()` 新增一行，把 `event.displayKM` 原樣帶入回傳物件，與旁邊既有的 `longitude`/`latitude` 欄位同一慣例（presence 才有意義、absence 就是沒有）。不觸碰 Gate A 排除決策本身、GEO resolver、Queue、AI、LINE、道路管理政策、PBS。
- **測試**：新增 `test/v248TdxKmFallbackProductionRuntimeDiagnosis.test.js`（8項，覆蓋施工令§五全部CASE 1-5＋Gate A drop KV write best-effort 迴歸鎖）。全量迴歸1796/1764/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.8→V2.4.9（PATCH）。
- **PRODUCTION_APP_VERSION 誠實揭露**：本 session 對 Production `*.workers.dev` 無直接網路存取（`curl` 對外一律 403，`npm run verify:production` 結構上必為 `PASS_NETWORK_VERIFICATION_BLOCKED`），無法自行讀取實際部署的 `GET /version`。本輪判斷完全基於程式碼本身的 runtime trace，不依賴 Production 是否已跑最新版——若人類回報 Production 目前跑的 commit 早於本輪修正（`f2d743d` 之前），該版本本就沒有這個修法，屬於部署時間差而非新的程式問題；push 後依既有唯一部署路徑（push main → Cloudflare Workers Builds 自動部署）生效。
- **通則**：一個欄位在「本體物件」（`normalizeRoadEvent()` 的回傳值）裡正確存在，不保證它在每一個由不同呼叫點各自建構的「影子物件」（這裡是 debug/observability 專用的本地 pseudo-candidate）裡也存在——當某個欄位是後來的版本才加上去的，必須反查所有既有的、獨立建構同類形狀物件的地方，而不能只信任「這個欄位在主要路徑上有」。

## V2.4.8 封版（2026-09-04）— LINE 路況文字編輯與統一排版

- `V2_4_8_AI_LINE_MESSAGE_EDITOR_AND_UNIFIED_PRESENTATION`，MINOR。核心目標：PBS 警廣與 TDX 高公局／公路局不論原始本文格式如何，最終送到 LINE 的訊息都統一整理成「短、準、乾淨、容易掃讀、來源清楚」。
- **AI 定位（施工令§一）**：AI 只負責文字編輯（修正錯字/標點/刪贅語/濃縮長文），絕不產生新事實（不改道路/方向/公里數/交流道/座標/封閉車道數/事件類型/時間/來源）。
- **一次 AI 呼叫（§二）**：沿用既有單次 Workers AI 呼叫，`aiDecisionEngine.js` 的 SYSTEM_PROMPT 新增 cleanSummary 編輯指示，JSON schema 同時輸出 notify/impact/reason/confidence/cleanSummary，未新增任何第二次呼叫。
- **canonical facts 不可被 AI 修改（§三）**：`validateAiDecisionResponse()` 把 cleanSummary 獨立驗證（缺失/非字串/超過 `CLEAN_SUMMARY_MAX_CHARS=100` 一律 null，不使 notify/impact/reason/confidence 這四個既有欄位的驗證失敗）。新增 `cleanSummaryContradictsFacts(cleanSummary, candidate)`——偵測 cleanSummary 文字裡是否出現與 canonical `blockedLanes`／`direction` 矛盾的車道數字或方向詞，矛盾時在 `resolveAiDecision()` 內直接 null 掉該 cleanSummary（notify 決策完全不受影響）。road/direction/KM/blockedLanes 永遠只由 `messageFormat.js` 從 event 既有結構化欄位讀取顯示，cleanSummary 從未、也不能提供這些值。
- **統一版型（§五/§十八）**：`messageFormat.js#formatEventMessage()` 新增 cleanSummary 存在時的區塊式排版（headline／road+KM+車道數／cleanSummary+行動提示／通報+地圖+更新時間，區塊間空行分隔），舊版單行排版完全不變並作為 fallback（cleanSummary 缺失/無效/矛盾/notify=false 未走 AI 核准路徑時皆走 fallback，零回歸風險——這也是為什麼全量迴歸 NEW_FAILURES=0 的原因：現有測試從未帶 cleanSummary，全部繼續吃到 byte-identical 舊排版）。
- **來源標示（§六-§十）**：新增 `buildReporterLine()`（取代舊的 PBS-only、空值時整行省略的 `buildSourceDetailLine()`）——TDX `source='freeway'/'highway'` 恆定顯示「通報：【TDX】高公局」／「通報：【TDX】公路局」（此前 TDX 從未有過通報行，因為 `tdx/normalize.js` 從未設定 `sourceDetail`）；PBS 恆定顯示「通報：【警廣】」+ deterministic 別名（`REPORTER_UNIT_ALIAS_PATTERNS`：高速公路局/高公局→高公局、公路局→公路局、熱心聽眾→熱心聽眾、警察/警方→警方，其餘顯示原文截斷，sourceDetail 為空或字面就是「警廣」本身時只顯示裸的「【警廣】」前綴，不猜單位）。【來源層級】與【原始通報單位】刻意分開兩個概念（§九）。
- **查修頁同步（§十七）**：`aiObservatoryIndex.js#buildAiObservatoryRecord()` 新增 `cleanSummary`／`finalRenderedMessage`（`aiApprovedPbsBroadcast.js` 產出的 `completedProduct.text`，原樣捕捉、絕不重算）；`aiObservatoryView.js` 新增「AI 文字編輯」展開區塊，依序顯示【原始本文】（既有 rawComment）→【AI 整理後】cleanSummary →【LINE 最終內容】finalRenderedMessage。
- **既有測試更新**：因通報行格式全面改變（TDX 從無到有、PBS 從「原文直顯」變成「固定前綴+別名」），更新了 `v242InformationFidelityAndPolicy.test.js`／`pbsAccidentTraceLocationQuality.test.js`／`messageFormat.test.js`／`dynamicShoulderMessageShort.test.js`／`pbsLineBroadcast.test.js` 共 7 處既有斷言，皆為施工令本身要求的、預期中的行為改變，非回歸。
- **測試**：新增 `test/v248AiLineMessageEditorAndUnifiedPresentation.test.js`（18項，含施工令§十九全部14個CASE）。全量迴歸1788/1756/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.7→V2.4.8。
- **未觸碰（§二十）**：PBS Windows 本機篩選、TDX Geographic Resolver、TDX 道路管理政策、notify eligibility 本身、Incident Memory、Queue、dedupe、`wrangler.jsonc` 全部四個 TDX/AI 開關（`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED` 維持 `"true"`）、行政區 polygon、CCTV 搜尋邏輯。

## V2.4.7 封版（2026-09-03）— TDX 地理資料缺失查修（description 文字 KM 後援）

- `V2_4_6_TDX_GEO_INPUT_MISSING_DIAGNOSIS_AND_FIX`，PATCH，PBS_MODIFIED=NO、GEO_RESOLVER_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、AI_POLICY_MODIFIED=NO。
- **起因**：真實 Production 事件 `EVENT_ID=A15040100H-01-20260903103244766100023`（TDX｜高公局，國道三號 北向 79K+000 其他異常告警-散落物）查修頁顯示 GEO=UNKNOWN，`areaNm`/`displayKM`/`longitude`/`latitude` 全空——即使原始描述明確寫著「79K+000」。
- **§一唯讀稽核結論**：`tdx/normalize.js#normalizeRoadEvent()` 的結構化欄位擷取（`Location.FreeExpressHighway.StartKM`/`EndKM` 等）本身**無 bug**——無條件擷取，若原始 payload 有該欄位一定會被保留。真正缺口是**結構性的**：TDX normalize 路徑從未有過像 `pbs/normalize.js` 那樣的 description 文字 KM 後援解析。NORMALIZE_BUG=NO，TEXT_KM_FALLBACK_ADDED=YES。
- **副發現（無害、已處理但未在源頭修正）**：`tdx/extract.js#firstDefined(raw, paths, undefined)` 因 JS default parameter 語法特性（明確傳入 `undefined` 仍會觸發該參數自己的預設值），實際上永遠回傳 `''` 而非字面 `undefined`——這對 `composeLocation()`/`parseKM()`/`roadManagementPolicyGate.js` 皆無害（三者皆已把 `''` 當缺席處理），但意味著新後援邏輯的觸發條件不能寫 `startKM === undefined`，必須用 `!startKM`（falsy）判斷。
- **修法**：`src/traffic/hsinchuFilter.js` 新增 `extractKmTokenFromText()`，重用 `parseKM()` 既有的 TDX KM token 格式（"79K+000"/"80K"），非第二套格式。`normalizeRoadEvent()` 只在結構化 `startKM`/`endKM` 皆缺席時才呼叫，對 `description` 搜尋——**結構化欄位永遠優先，絕不被 description 覆蓋**。解析出的 token 以與結構化欄位相同的原始字串格式存回 `startKM`/`endKM`，下游（`composeLocation`/`parseKM`/`hsinchuGeoResolver.js` Tier-2）完全不需改動。新增 `displayKM`（數字，與 PBS 既有欄位同形狀，純顯示用）。
- **安全驗證（施工令§四，CASE 7/7b 鎖住）**：解析出的 KM 僅被 `hsinchuGeoResolver.js` Tier-2 KM-heuristic 觀測層讀取，該層維持永遠非決定性（本輪未變動）——上述真實事件即使成功解析出 79K+000，地理判定仍正確維持 UNKNOWN（0 Queue/0 AI/0 LINE），只有可觀測性改善（查修頁現在能顯示「有KM在推測範圍內但無座標/地名證據」而非完全空白）。
- **測試**：新增 `test/v247TdxGeoInputMissingFix.test.js`（12項，含施工令§六全部CASE 1-7＋CASE 7b 安全驗證＋`extractKmTokenFromText`純函式單元測試）。全量迴歸1770/1738/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.6→V2.4.7。

## V2.4.6 封版（2026-09-03）— 查修頁 TDX 顯示與最終決策原因摘要

- `V2_4_6_TRACE_PAGE_TDX_AND_DECISION_REASON_SUMMARY`，UI/observability-only，PBS_RUNTIME_MODIFIED=NO、TDX_DECISION_LOGIC_MODIFIED=NO。
- §一唯讀調查結論：本專案有兩套「查修頁」——舊版 `src/traffic/pipelineTraceView.js`（`GET /admin/pipeline-trace-view`，V1.5 規則式，`buildTraceEntry()` 只有 3 個呼叫點，全是 PBS 觸發，純 TDX 事件在 V2.4.0 `LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT` 架構下幾乎不會出現）與新版 `src/pbs/aiObservatoryView.js`＋`aiObservatoryIndex.js`（`GET /admin/pbs-ai-observatory-view`，`source` 欄位自 V2.4.0 起已支援 `pbs`/`freeway`/`highway`）。TDX 幾乎不出現的原因是 (B)+(A) 的組合，非單一選項：(B，多數) TDX 在 `tdx/tdxQueueIngress.js` Gate A（地理／道路管理政策）被排除時，此前只有 `console.log`，KV 完全零紀錄；(A，少數) 真的通過 Gate A、到達 Queue/AI 的 TDX 事件雖然有正確寫入 `source`，但 `aiObservatoryView.js#renderRow()` 的收合列硬編碼字串 `"PBS"`，從未讀 `record.source`，因此畫面上仍顯示成 PBS。
- 修法（全部 additive-only，不重跑任何判斷）：
  1. `tdx/tdxQueueIngress.js#enqueueTdxRoadEvents()` 在 Gate A 排除點（地理/道路管理政策）之後，額外呼叫新的 `recordTdxGateDrop()`，重用 `aiObservatoryIndex.js` 既有的 `buildAiObservatoryRecord`/`recordAiObservatoryEntry`（同一個 KV prefix `debug:pbs-ai-observatory-index:v1`，不新增第二個 index），直接把 `resolveTdxHsinchuGeography()`/`resolveTdxRoadManagementEligibility()` 已經算出的結果轉成新的 6 個 `AI_OUTCOME` 值——排除決策本身完全不變，寫入是 best-effort（KV 失敗也不影響排除判斷）。
  2. `aiObservatoryIndex.js` 新增純函式 `deriveFinalDecisionReason(record)`——唯一權威的「為什麼發／不發」文字組成，只讀 record 既有欄位（outcome/eventType/blockedLanes/suppressedForPhase/lineSent），涵蓋施工令範例詞彙（壅塞／一般施工／機動路肩開放／機動路肩關閉／施工僅封N車道／非新竹縣市／地理位置無法確認／AI判定影響低／TDX通知開關關閉／AI處理失敗／背景重試失敗）。刻意區分「施工僅封1車道」與泛用的 `type=construction`，避免施工令點名的「只顯示 construction 不夠有用」問題。
  3. `buildAiObservatoryRecord()` 新增 `suppressedForPhase`（`debugPush.js#runAiDecisionPath` 早就算出但先前從未存進 record 的既有欄位——單純不再丟棄）與 `blockedLanes`（`aiCandidate.js` 早就有的欄位）。
  4. `aiObservatoryView.js#renderRow()` 改讀 `record.source` 顯示三種來源徽章：PBS／`TDX｜高公局`（freeway）／`TDX｜公路局`（highway），永不合併顯示。收合 `<summary>` 新增一行 `finalReasonLine()`（✅已發送／⏭未發送／⏱AI處理失敗／⏳處理中 + 原因），PBS 與 TDX 卡片皆有。展開內容新增 TDX 專屬第二種六段式流程條 SOURCE→GEO→ROAD_POLICY→QUEUE→AI→LINE（PBS 原本的 ①-④ 流程條完全不變，另一段程式碼路徑）。
- TRACE_API 不變（仍是 `GET /admin/pbs-ai-observatory-view`，仍是唯讀、開啟/篩選/重新整理 0 次 AI 呼叫、0 KV 寫入）。
- 測試：新增 `test/v246TracePageTdxAndDecisionReasonSummary.test.js`（20 項，含施工令 §十二 的 8 個 CASE 全部覆蓋＋`deriveFinalDecisionReason` 純函式單元測試）。完整 regression：1758 項（1738 既有＋20 新），失敗 32 項與變更前 baseline（同 commit `git stash -u` 取得）完全相同（CCTV/frame-latency 類既有失敗，與本輪無關），NEW_FAILURES=0。
- 未做且刻意未做：未修改 PBS runtime、未修改 TDX 決策/AI prompt/LINE 規則、未動 `wrangler.jsonc` 任何開關（`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED` 維持 `"true"`）。若施工過程中發現任何會影響 runtime 決策的問題會 STOP 回報——本輪未遇到需要 STOP 的情況。

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

## V2.4.0 封版（2026-09-01）— TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE

MINOR（架構階段）：TDX 國道/省道 RoadEvent 重新加入同一條 Queue／同一個 AI
決策引擎，透過新的 Recent Incident Memory 跨來源協調，**Phase B（尚未真正
推播 LINE）**——不是 Phase C。

- 固定架構：TDX Freeway＋TDX Highway＋PBS Windows → 統一事件格式 →
  serviceArea 閘門 → Recent Incident Memory（Cloudflare KV，8h TTL）→
  唯一一個 Queue（沿用 `PBS_AI_QUEUE`）→ 唯一一個 AI 引擎 → AI 輸出
  `sameIncident`／`materialChange`／`notify` → LINE → CCTV → R2 讀回驗證
  （V2.3.3 原封不動）
- 來源角色：TDX Freeway＝國道主要權威、TDX Highway＝省道主要權威、
  PBS＝全道路即時＋TDX備援；`WAIT_FOR_TDX_BEFORE_NOTIFY=NO`，
  `PBS_FREEWAY_DROP=NO`，`PBS_HIGHWAY_DROP=NO`——誰先到、誰有效就先進 AI
- 只復原 Freeway＋Highway RoadEvent 抓取，明確**不**復原 VD／CMS／其他
  Traffic API／CCTV metadata Cron；`CCTV_RUNTIME_TDX_CALLS` 維持 0，CCTV
  metadata refresh 維持 MANUAL/ON-DEMAND
- `wrangler.jsonc` 新增三個最小粒度開關（canonical，非 Dashboard-only），
  預設全部 `"false"`：`TDX_ROADEVENT_FETCH_ENABLED`、
  `TDX_ROADEVENT_QUEUE_INGRESS_ENABLED`、
  `TDX_CCTV_METADATA_REFRESH_ENABLED`——疊加在 `TRAFFIC_SOURCE_MODE` 之上，
  絕非取代（見 `sourceMode.js#isTdxTokenAccessPermitted`）
- **`LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT`**：
  `scheduled.js` 的 `broadcastEvents` 不再包含 `summary.allEvents`（TDX
  自己抓到的事件），即使單獨打開 `TDX_ROADEVENT_FETCH_ENABLED` 也無法讓
  TDX 事件回到舊 V1.5 硬規則 LINE 路徑
- 新模組 `src/traffic/incidentMemory.js`（KV key
  `traffic:incident-memory:v1`，8h TTL，`MEMORY_KV_GETS_PER_EVENT<=1`／
  `MEMORY_KV_PUTS_PER_EVENT<=1`，`WRITE_ON_CHANGE=YES`，road+direction →
  1000m/1.5km 內 → 最近 8h → 最多 5 筆候選的三層 prefilter，並排除事件
  自己剛寫入的紀錄，避免 AI decision cache key 誤判為「有新 context」）、
  `src/tdx/tdxQueueIngress.js`（TDX 新／更新事件送進同一個 `PBS_AI_QUEUE`，
  沿用 `dedupe.js`／`debugPush.js` 既有 fingerprint／idempotency／訊息
  建構，絕非第二套 Queue 或第二套訊息格式）
- AI schema 新增 `sameIncident`／`materialChange`（僅在有 memory context
  時要求），AI decision cache key 併入 `memoryContextFingerprint`，未提供
  時與 V2.4.0 前完全相同的 hash（向下相容）
- Phase B 閘門硬寫死在單一呼叫點（`debugPush.js`：
  `suppressLineNotify = source === 'freeway' || source === 'highway'`），
  非任何 `wrangler.jsonc` 變數控制——要進 Phase C（TDX 真正推播 LINE）
  需要未來一次明確的程式碼變更，絕非改設定值就能達成
- `incidentSuppression.js` **不大拆**：保留作為短期重複推播安全網，疊加在
  AI 自己的 8h Memory 再判斷之下，非取代
- 全量迴歸 1746/1712/34，NEW FAILURES=0（僅跑一次，diff 對照既有 34 筆已知
  flaky baseline，完全相同）；新增 `test/tdxUnifiedAiPipeline.test.js`
  （order 自訂 17 個 CASE 全過），另 8 個既有測試檔改寫以反映
  TDX-legacy-retirement 的刻意行為變更
- `APP_VERSION` 從 `V2.3.3` 升為 `V2.4.0`
- **本輪未啟用任何真實 TDX 抓取**：三個新開關全部預設 `"false"`，本輪只
  建好機制，實際打開（Phase A：FETCH_ONLY）需要另一次明確的人類指示
- 詳見 `03_ARCHITECTURE.md`／`07_KNOWN_ISSUES.md`／
  `test/tdxUnifiedAiPipeline.test.js` 的完整記錄。**下一個 Agent：不得
  自行開啟任何 TDX_ROADEVENT_* 開關、不得自行進 Phase C（移除
  `suppressLineNotify` 的硬寫死 true）、不得復原 VD/CMS 等其他 TDX
  功能。**

## V2.3.3 封版（2026-08-31）— CCTV_R2_READBACK_VERIFY_BEFORE_LINE

PATCH，可靠性加強，不改架構、不改 15 分鐘 TTL、不改 LINE Push 模型、不改 CCTV 選鏡策略。

- 上一輪唯讀查核（`CCTV_IMAGE_READY_BEFORE_LINE_PUSH_AUDIT`）逐函式追蹤真實
  AI-approved 廣播路徑，確認 await 鏈本身已安全（R2 put 完整 await → public
  URL 只在 put 成功後建構 → LINE push 一律最晚），但無法用應用層時序缺陷
  解釋一筆真實回報的破圖事故（LINE 端遠端抓取行為不在本 repo 可視範圍）
- 決策：停止對 LINE 端行為的無止盡追查，改為新增本 codebase 真正能自己
  保證的一件事——CCTV 圖片成功寫入 R2 後，Cloudflare 自己再讀一次確認
  圖片真的可讀，通過才把 imageUrl 交給 LINE
- 新函式 `publishedImage.js#verifyPublishedImageReadable(bucket, id)`：
  純內部 R2 GET（絕非對本 Worker 自己 public endpoint 發 HTTP），確認
  物件存在、Content-Type 確實為 `image/jpeg`、bytes 非空；任一失敗或
  GET 本身拋出例外，一律視為讀回失敗
- 接上 `dynamicCollage.js` 兩個既有 R2 發布點——`prepareCctvImageWork`
  （quad／事故）與 `prepareSingleCctvImageWork`（single／動態路肩）——
  兩者共用同一個 `publishCollageImage()`、也共用同一套下游 LINE image
  message 組裝，同步保護，不留半修缺口
- 新失敗代號 `r2-readback-failed`，與既有所有 CCTV 失敗原因採完全相同
  的 fail-closed 處理：文字照常送、圖片跳過、不重試、不重新 publish
- `TDX_CALL_CHANGE = 0`（新讀回只是一次 `bucket.get()`，非 `fetch()`）
- `APP_VERSION` 從 `V2.3.2` 升為 `V2.3.3`
- 新增/擴充 8 項測試（`test/dynamicCollage.test.js` CASE 1-5/7-8 六項、
  `test/dynamicShoulder.test.js` 19b 一項），另有 9 個既有測試檔的
  `r2Bucket()` mock 補上 `httpMetadata` 傳遞（與真實 R2 行為一致，既有
  成功案例行為不變），全量迴歸 1729/1695/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：15 分鐘 published-image TTL、previewImageUrl／
  originalContentUrl 架構、CCTV 選鏡策略、四象限版面、圖片尺寸／JPEG
  quality、LINE Push 單一 payload 模型、AI Prompt／Model、Cloudflare
  Queue、Windows PBS、TDX、Google Maps；既有 await 順序本身未重排，
  只在「R2 put 成功」與「imageUrl 回傳」之間多插入一個新的 await 步驟
- 詳見 `07_KNOWN_ISSUES.md`／`dynamicCollage.js`／`publishedImage.js` 的完整記錄

## V2.3.2 封版（2026-08-30）— CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR（診斷工具修復）

PATCH，診斷工具修復，非 CCTV 產品功能，不改 PBS/Windows/Queue/AI/LINE/Observatory 主流程。

- 真實事件 `EVENT_ID=11508310005-5`（LINE 送達的 CCTV 圖片破圖）：唯一能直接
  驗證「剛 publish 完的 `/cctv/image/:id` 是否立即 200+JPEG」的工具
  `GET /admin/cctv-hsinchu-publish-test` 本身無法使用——依賴只有
  `/admin/cctv-hsinchu-probe` 才能重建的 `CANDIDATES_KEY`，該 probe 會
  發起真實 TDX 呼叫，在 `TRAFFIC_SOURCE_MODE=PBS_ONLY` 下不可為診斷消耗
- 修正：改從同一份 `cctv:freeway-metadata:v1` 攝影機清單快取（真實事故
  動態播報路徑早已 cache-only 讀取、從不碰 TDX）取得候選——新函式
  `composeCollageFromFreewayMetadata()` 串接 `readFreewayCctvMetadataCache()`
  （cache-only，空 KV 退回官方 NFB 內建清單 1943 筆真實記錄，實測固定
  測試點涵蓋 4 象限中 3 個）→ `selectFourQuadrantCandidates()`（既有
  fixed-target admin probe 同一函式同一預設值，未新增鏡頭排序政策）→
  `composeCollageFromCandidates()`（本專案所有 collage 路徑共用核心）
- `TDX_CALLS_PER_TEST = 0`，測試直接驗證（無 fetch 觸及
  tdx.transportdata.tw），非僅推論 import graph
- 新增 `step` 欄位區分失敗成因：`METADATA_CACHE_MISSING`／
  `NO_CCTV_CANDIDATES`／`SNAPSHOT_FETCH_FAILED`／`COMPOSE_FAILED`（兩者
  以 `composeCollageFromCandidates()` 新增純累加欄位
  `anyFrameFetchSucceeded` 區分，沿用 V1.9.0 同一函式已建立的
  「on every outcome」慣例，對既有呼叫端零行為變化）／`R2_PUBLISH_FAILED`
- 成功回應補齊 `status`/`published`/`contentType`/`bytes`/`createdAt`/
  `expiresAt`/`imageUrl`（`createdAt` 自 V1.8.4 起就有算但從未回傳）
- `APP_VERSION` 從 `V2.3.1` 升為 `V2.3.2`
- 新增/改寫 22 項測試（`test/cctvImagePublish.test.js`），全量迴歸
  1722/1688/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：PBS、Windows filter、Cloudflare Queue、AI 決策路徑、
  正式 LINE 廣播、CCTV 鏡頭排序政策、真實事故 CCTV 選鏡/計時/預算邏輯
  本身、Shared Feed、TDX 本身運作、Google Maps、Observatory 主流程；
  `/admin/cctv-hsinchu-collage`（CANDIDATES_KEY）未受影響
- 詳見 `07_KNOWN_ISSUES.md`／`hsinchuCctvProbe.js` 的完整記錄

## V2.3.1 封版（2026-08-30）— DIRECT_COORDINATE_MAP_FALLBACK（LINE 地圖座標直連 Hotfix）

PATCH，formatter 行為修正，不改架構、不改 AI/Windows/Queue/LINE 政策。

- 真實事件 `EVENT_ID=11508260158-0`（竹60線縣道，新竹縣尖石鄉坍方封路）：
  PBS/Windows/Cloudflare 全程有效座標、AI 正常完成、LINE 已發送，但
  **完全沒有地圖連結**
- 根因：`messageFormat.js#buildRoadLines()` 的兩層地圖連結解析
  （`resolveKmLocation`／`resolveCoordinateLocation`）都要求 `road`
  先辨識成國道/省道格式才會使用座標；縣道/鄉道（如竹60）從未被本專案
  僅有的國道(95016)/省道(7040)公里標資料集涵蓋，座標路徑因此在真正
  使用座標前就被 road 判斷擋下
- 修正：新增最後手段 `kmLocationResolver.js#buildDirectCoordinateMapUrl()`
  ——重用既有 `buildMapUrl()`，直接以事件自身座標產生地圖連結，**不**
  辨識道路、**不**查資料集、**不**猜測任何 road/sectionLabel/
  locationLabel，只在既有兩層都失敗時才觸發，只影響「📍 地圖」那一行
- 新增 `isValidRawCoordinate` 座標合法性把關：拒絕
  null/undefined/NaN/Infinity/非數字型別/超出緯經度範圍/精確 (0,0)
- `roadName.js`／`canonicalFreewayRoad`／`canonicalProvincialRoad`／
  官方國道/省道資料集本身**完全未觸碰**；縣道/鄉道公里標資料工程
  仍是刻意未開始的更大範圍問題
- `APP_VERSION` 從 `V2.3.0` 升為 `V2.3.1`
- 新增 13 項測試（`test/pbsCoordinateDirectMapFallback.test.js`，含真實
  事件端對端 fixture，road 全程維持真實值「新竹縣-尖石鄉」，未硬編碼
  「竹60」），既有 KM/座標解析測試檔重跑不變、全數通過，全量迴歸
  1718/1684/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：AI Prompt/model、Windows PBS filter、Queue、LINE
  廣播政策、Observatory 架構、TDX、CCTV
- 詳見 `07_KNOWN_ISSUES.md`／`kmLocationResolver.js`（`buildDirectCoordinateMapUrl`
  自身 header comment）的完整記錄

## V2.3.0 封版（2026-08-30）— PBS AI Queue Reliability，Cloudflare Queues 取代 ctx.waitUntil

MINOR，正式改變 AI business processing 的執行架構與可靠性模型，非
timeout patch。真實 Production 事故（與 V2.1.0 不同一種失敗模式）：
`EVENT_ID=11508290166-0` 成功啟動 Workers AI 呼叫，但呼叫本身在
`ctx.waitUntil()` 自己的背景執行時間預算到期前未回傳，平台強制取消整個
task，AI 決策永久遺失，冪等記錄卡死 `PROCESSING`。
`REAL_INCIDENT_ROOT_CAUSE = WAITUNTIL_BACKGROUND_WINDOW_EXCEEDED`。

- `ctx.waitUntil()` 全面退休做為 AI 背景執行載體
  （`WAITUNTIL_AI_PROCESSING = RETIRED`），改用唯一一個 Cloudflare Queue
  （`pbs-ai-processing-queue`／binding `PBS_AI_QUEUE`，`wrangler.jsonc`
  唯一正典設定，`AI_BACKGROUND_EXECUTION = CLOUDFLARE_QUEUE`）
- HTTP ingress 只驗證／寫冪等 PROCESSING／寫 Observatory
  `PROCESSING_STARTED`／`Queue.send()`，只有 send 成功才 ACK
  `accepted:true`——send 失敗回真實 503，絕不假報已接收
- 獨立 Queue Consumer（`src/index.js` 新增 `queue()` export）承接全部
  AI／LINE／Observatory-final 工作，重用（非重造）既有 AI candidate／
  decision engine／cache／LINE 廣播／Observatory writer
- `AI_CALL_FAILED`（呼叫本身未可靠完成）現在可 Queue 重試，
  `MAX_QUEUE_RETRIES = 3`；既有 `AI_DECISION_INVALID` fail-closed
  政策**維持不變**，絕不重試
- 新增唯一最小終態 `AI_OUTCOME.PROCESSING_FAILED`（重試耗盡後由
  Consumer 自己寫入，標記冪等 `COMPLETED`，永不卡死 PROCESSING）
- `QUEUE_DELIVERY_MODEL = AT_LEAST_ONCE`，
  `BUSINESS_OUTCOME_MODEL = EFFECTIVELY_ONCE`：已 `COMPLETED` 的重複
  遞送直接 ack 略過，0 額外 AI 呼叫／LINE 推播
- 開發期間發現並修正一個 Observatory KV key 重複 bug：改從 queue
  message 的 `acceptedFirstAcceptedAt` 重建 `observatoryNow` 供兩次
  Observatory 寫入共用同一把 key
- `RAW_PBS_TEXT_POLICY = IMMUTABLE_END_TO_END_UNTIL_AI` 不變
- KV 成本實測：`puts = 4N + 2`（與 V2.2.0 相同，0 額外寫入），
  `gets = 6N`（+1／事件，Consumer 冪等 re-check）
- Queue 成本工程估算：成功 2 operations／事件，重試耗盡最差
  5 operations／事件，50/100/200 events/day 最差情況 250/500/1000，
  遠低於官方文件 10,000/日免費額度
- `APP_VERSION` 從 `V2.2.0` 升為 `V2.3.0`
- 新增 `test/pbsAiQueueReliability.test.js`（含真實事故
  `EVENT_ID=11508290166-0` 迴歸 fixture，可控制 Promise 模擬延遲，非
  真實 sleep），改寫 5 項過時 `ctx.waitUntil` 測試，全量迴歸
  1705/1671/34，NEW FAILURES=0（僅跑一次）
- 本輪**未觸碰**：Windows PBS filter、Windows 自身 HTTP timeout、PBS
  原始文字、AI Prompt/model/semantic policy、service area、LINE
  policy/formatter、Shared Feed、CCTV、TDX、driverSummary、hourly
  reminder、Observatory 頁面整體 UI
- `BROWSER_ACTION_REQUIRED = YES`：真實 Cloudflare Queue 資源
  （`pbs-ai-processing-queue`）需在 Dashboard／`wrangler queues create`
  建立，本 sandbox 無法驗證或建立，**不得假設已存在**
- 詳見 `03_ARCHITECTURE.md`／`PRODUCT_DECISIONS.md`／`07_KNOWN_ISSUES.md`。
  **下一個 Agent：先確認 Cloudflare Queue 資源已建立並驗證，不得直接
  開始「AI 一小時歷史上下文」、driverSummary、formatter 修正、查修頁
  UI 改版或其他功能。**

## 補登（2026-08-30）— Windows PBS Geographic Filter Repair（人類回報，未獨立驗證）＋ V2.3.0 Production 驗收回報

**性質：DOCUMENTATION ONLY，本輪未修改任何 Windows／Cloudflare／Queue／AI 程式碼。**

- `WINDOWS_PBS_GEOGRAPHIC_FILTER_REPAIR`：人類回報 Windows 舊邏輯先套用
  `isAccident()` 事故語意閘門才進新竹地理判斷，導致非事故型新竹事件（落石／
  坍方／封路／施工／積水）可能在 Windows 端被直接丟棄；回報修正為移除該語意
  閘門，改用 point-in-polygon（data.gov.tw dataset 7442）取代原矩形邊界，新竹
  市/縣所有事件類型皆納入候選，語意判斷完全交給 AI；回報 `11→29`（找回 18
  筆）、`124 tests passed/0 failed`。**本 Session 獨立查證**：目前
  `pbs-relay/src/localPrototype.js` 仍保留 `isAccident()` 且仍在候選路徑上，
  `pbs-relay/` 全部 git 歷史（含 prototype 分支）未見對應 commit，故上述具體
  數字**未經本 Session 驗證**——記錄為 `HUMAN_REPORTED_NOT_INDEPENDENTLY_
  VERIFIED`，詳見 `07_KNOWN_ISSUES.md` 對應段落。
- `V2.3.0_PRODUCTION_VALIDATION`：人類回報「V2.3.0 已由 Production 真實事件
  驗收完成」，與本 Session 上一輪誠實回報的 `BROWSER_ACTION_REQUIRED = YES`
  （Cloudflare Queue 資源狀態 UNKNOWN）並存但未附可核對證據，本欄位維持
  `BROWSER_ACTION_REQUIRED = YES` 不變，待證據後再更新——**不得**僅因人類
  陳述就將先前誠實記錄的「未驗證」逕自改記為「已驗證」。
- 責任邊界（人類回報版本，供對照）：Windows=Geography Only，
  Cloudflare=Ingress/Transport/Orchestration，Queue=Reliable Background
  Processing，AI=Semantic Decision Authority，LINE=Delivery Only——與
  V2.1.0 正式命名的四層架構角色邊界一致，未新增或修改角色定義本身。
- 下一個 Agent：若要實際落地 Windows Geographic Filter 修正，須先在
  `pbs-relay/` 產生對應 commit 並可獨立驗證測試結果，才能把上方標記從
  `HUMAN_REPORTED_NOT_INDEPENDENTLY_VERIFIED` 升級為已驗證版本。

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
