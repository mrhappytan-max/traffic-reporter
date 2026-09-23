<!-- title: 已知問題（第四卷） -->

# 07. Known Issues — VOLUME 04（CURRENT）

## 卷別承接說明（ENGINEERING_MEMORY_KNOWN_ISSUES_VOLUME_04_CREATE，2026-09-08，路況-061）

- **前一卷**：`07_KNOWN_ISSUES_03.md`（正式封存為 **KNOWN ISSUES VOLUME 03**）。
- **第四卷啟用原因**：Volume 03 於路況-060/061規劃階段量測為77,022/81,920 bytes，本輪（路況-061）自身修正紀錄篇幅（真實觸發事件、根因、架構性後果、查修頁join漏洞修正範圍三檔案、測試相容性驗證結果）預估將使該卷超出81,920-byte單檔上限，依既有慣例（Volume 01於81,898/81,920、Volume 02於79,617/81,920時建立下一卷承接）立即建立本卷。
- **本卷不取代前三卷**：Volume 01、Volume 02、Volume 03完整保留、未刪除任何一行既有記錄（禁止刪除舊Bug／已修問題／Root Cause／技術債／歷史教訓，禁止為省空間大量改寫舊內容）——本卷只是接續，從本卷建立時刻起，新的Known Issues紀錄一律寫入本卷。
- **查歷史問題時的規則**：任何一輪要排查、引用、或核對「這個問題以前是否發生過／怎麼修的／為什麼這樣設計」，都必須**同時視Volume 01（`07_KNOWN_ISSUES.md`）、Volume 02（`07_KNOWN_ISSUES_02.md`）、Volume 03（`07_KNOWN_ISSUES_03.md`）與Volume 04（本檔）為同一份完整資料**——只讀其中幾卷不足以代表完整的Known Issues歷史。時間順序為Volume 01 → Volume 02 → Volume 03 → Volume 04依序接續；Volume 01記錄截至V2.4.10封版（2026-09-04）為止的歷史，Volume 02記錄2026-09-04～2026-09-07（路況-023）之間的歷史，Volume 03記錄2026-09-07（路況-025）～2026-09-08（路況-056）之間的歷史。
- **索引關係**：
  ```
  07_KNOWN_ISSUES.md     → KNOWN_ISSUES_VOLUME = 01（歷史正式封存，完整保留，唯讀延伸）
  07_KNOWN_ISSUES_02.md  → KNOWN_ISSUES_VOLUME = 02（歷史正式封存，完整保留，唯讀延伸）
  07_KNOWN_ISSUES_03.md  → KNOWN_ISSUES_VOLUME = 03（歷史正式封存，完整保留，唯讀延伸）
  07_KNOWN_ISSUES_04.md  → KNOWN_ISSUES_VOLUME = 04（CURRENT，新記錄寫入這裡）
  ```
- **容量規則延續**：本卷同樣受81920-byte單檔上限規範。未來若本卷也接近上限，依同一原則建立`07_KNOWN_ISSUES_05.md`依序延續，禁止提前刪除任一舊卷。
- **同步治理註記（沿用Volume 03既有現況，不回頭改寫Volume 01/02/03既有文字）**：Google Drive鏡像已於路況-007決議退休（`.github/workflows/sync-engineering-memory.yml`已停用push觸發），GitHub上的`engineering-memory/`為唯一正本。本卷**不需**加入`scripts/drive-sync-manifest.json`，不涉及任何Drive同步。

## 修正紀錄｜V2.7.0 讓AI的sameIncident/materialChange真正決定是否推播，並修正查修頁join漏洞（2026-09-08）

**真實觸發事件**：2026-09-08 19:10 TDX國3北向86.3K事故通報，19:31 PBS對同一地點發第二則（「小貨車側翻」），21分鐘內兩則推播。路況-058/059查證確認：19:31 AI呼叫時`memoryCandidateCount=1`，AI正確判定`sameIncident:true`／`materialChange:false`（同一事故、無實質變化），但系統仍照送。

**根因**：`debugPush.js`推播閘門只檢查`decision.notify`一個欄位，`sameIncident`/`materialChange`算出後只用於`incidentMemory.js`決定就地更新或開新事故族，從未影響是否推播。`incidentSuppression.js`的10分鐘collision window與本次無關——21分鐘已超出該窗口，該機制設計上僅防「近乎同時」的競態，非本次要處理的範圍（路況-058已查證）。

**非新規則，落實既有測試假設**：`test/tdxUnifiedAiPipeline.test.js`既有CASE 4/5/6（本輪未修改）的mock AI早已預期「同一事故無實質變化」情境應回傳`notify:false`——本次修正是讓真實系統行為與這份既有測試假設一致，非新增產品規則。

**修正內容**：`debugPush.js#runAiDecisionPath()`新增攔截區塊，緊接在既有`if (!decision.notify)`之後、`suppressLineNotify`計算之前：條件`decision.notify && decision.sameIncident===true && decision.materialChange===false`（嚴格`===`比較，確保首次事件`undefined`不誤觸發，已有專屬單元測試直接斷言）。觸發時呼叫`persistSighting(false)`（沿用既有機制），**不呼叫**`runAiApprovedPbsBroadcast()`，回傳物件形狀與既有「0推播的AI_NOTIFY_TRUE」記錄完全一致，讓`aiObservatoryIndex.js#deriveFinalDecisionReason()`既有的`sameIncident===true && materialChange===false`分支（原為10分鐘collision window情境設計，經查證其判斷邏輯本就只讀這兩個欄位、不讀`incidentSuppression.js`自己的`suppressed`旗標）零修改即可正確顯示「重複事件：...未重複發送」。`incidentSuppression.js`／`suppressLineNotify`邏輯**零行變動**。

**架構性後果（如實記錄，非錯誤）**：新閘門置於`incidentSuppression.js`的10分鐘collision window**之前**執行，兩者對「AI同時回報sameIncident:true+materialChange:false」的情境有實質重疊——上線後10分鐘collision window在AI核准路徑上會**較少實際觸發**，因為新閘門通常會先行攔截。10分鐘窗口本身完整保留，作為AI判斷本身可能不一致時的殘餘防線。已用既有CASE 7測試（`v2412ObservatoryNoSendReasonHighVisibilityUI.test.js`，3分鐘間隔）驗證：該測試現在確實改走新閘門路徑（`AI_NOTIFY_TRUE_SUPPRESSED_NO_CHANGE`）而非舊的collision window路徑，斷言逐字不變仍通過。

**查修頁join漏洞修正（路況-059發現，範圍為三個檔案，非原規劃單一檔案）**：`aiObservatoryView.js#loadAiDecisionDetail()`原本呼叫`computeAiDecisionCacheKeyHash({eventId, fingerprint})`（2參數），但寫入時（`aiDecisionEngine.js`）任何`memoryCandidateCount>0`事件皆用3參數雜湊（含`memoryContextFingerprint`）——查修頁的查詢因此保證miss，非本次事件獨有，是V2.4.0以來的系統性缺口。修正：`debugPush.js`在`memoryCandidates`算出後，額外呼叫既有`buildMemoryContextFingerprint()`存成新欄位，寫入Observatory記錄（`aiObservatoryIndex.js`新增`memoryContextFingerprint`欄位）；`aiObservatoryView.js`讀取此已存欄位、不重新計算（重新計算無法重現決策當下的即時記憶狀態）。已用端到端測試證明：兩則連續PBS事件、第二則真實AI理由（含confidence）確實正確顯示，非僅「不拋錯」。舊格式記錄（無此欄位）向下相容降級為既有UNKNOWN顯示。

**測試**：新增6則——`tdxPhaseCProductionNotify.test.js`3則（21分鐘間隔仍攔截、materialChange:true 21分鐘後正常推播、首次事件memoryCandidateCount=0直接斷言sameIncident/materialChange為undefined）；`v2412ObservatoryNoSendReasonHighVisibilityUI.test.js`1則（21分鐘情境查修頁文字正確）；`aiObservatoryView.test.js`2則（join修正端到端驗證＋向下相容regression lock）。**相容性驗證**：施工前後皆完整執行`test/tdxPhaseCProductionNotify.test.js`（含全部10則使用`alwaysNotifyTrueAi()`的既有測試）、`test/tdxUnifiedAiPipeline.test.js`（CASE4/5/6/7）、`test/v2412ObservatoryNoSendReasonHighVisibilityUI.test.js`（CASE7），三檔案既有測試**0則需要修改**，全數不動即通過。全量迴歸2068項（2062+6新增），2035通過／33失敗；`git stash -u`基準（2062項，2029通過／33失敗），測試名稱集合比對，`NEW_FAILURES=0`。

**規劃外發現，完整揭露**：`git stash -u`基準比對過程中，第一次全量迴歸捕獲到一筆額外失敗（`test/cctvPrepareTimeoutStages.test.js`的「D1: prepareCctvImageForEvent...returns frameFetchDurationMs/r2PublishDurationMs on success」），與本輪異動檔案完全無關（本輪未觸碰任何CCTV檔案）。查證：該測試單獨執行時通過；重新乾淨執行一次完整基準（stash狀態、零本輪變更）即穩定重現33/33，確認為與本輪無關的既有暫時性flake（時間量測相關斷言，非本輪引入），依既有「重跑一次確認flake」原則處理，未自行調整任何測試斷言。最終採用的before/after基準皆為33/33乾淨結果。

**APP_VERSION**：`V2.6.1`→`V2.7.0`（MINOR，直接改變AI核准事件是否推播的決策本身，非純觀測性變更）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：下一則同一事故的無實質變化更新，是否確實被正確攔截——尚未取得。10分鐘collision window實際觸發率下降的現場驗證——尚未取得。

**V2.7.0封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-08，路況-061）。封版依據：程式碼變更完成、全量迴歸2068項／2035通過／33失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.7.0`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.7.0`。

## 修正紀錄｜V2.8.0 播報/抓取時間窗調整為07:00~22:30，修正過期回覆文字（2026-09-08）

**背景**：路況-063（唯讀查證）確立現況：TDX抓取與LINE/電報推播共用`broadcastHours.js#isWithinBroadcastHours()`，皆為08:00~22:00且只比較小時、無法表達分鐘邊界；`pbsSchedule.js`的07:00-22:00窗屬已停用（V1.9.8起`resolvePbsPollingEnabled(env)`預設false）legacy機制，非真實PBS路徑；LINE Bot固定回覆文字「僅通知目前或未來60分鐘內會影響行車的路況」與真實系統行為不符（該60分鐘forecast邏輯僅存在於幾乎收不到流量的legacy `broadcastPipeline.js`路徑）；查修頁對「因非播報時段而抑制」缺乏專屬顯示理由，落入通用UNKNOWN。真人決定：TDX與LINE/電報採**相同**07:00~22:30邊界，沿用共用函式架構（不拆分）；窗外事件維持直接捨棄（不新增暫存補送）。

**修正內容**：
1. `broadcastHours.js#isWithinBroadcastHours()`改寫為分鐘數比較（比照`pbsSchedule.js`既有`WINDOW_START_MINUTES`/`WINDOW_END_MINUTES`寫法），邊界07:00~22:30。此為TDX抓取（`tdxSchedule.js`）與LINE/電報推播（`aiApprovedPbsBroadcast.js`）唯一共用入口，改一處即同步生效兩個真實呼叫點，兩呼叫點本身零修改。
2. `tdxSchedule.js`模組header comment修正過期的「PBS keeps running every tick, 24/7」敘述（V1.9.3/V1.9.8起已不成立）。
3. `line/webhook.js`的`REPLY_ENABLED`固定回覆文字：時間窗同步07:00～22:30；移除與真實行為不符的60分鐘forecast宣稱，改為如實描述（AI依語意判斷，非固定時間窗）。
4. `aiObservatoryIndex.js`：`buildAiObservatoryRecord()`新增`withinBroadcastHours`欄位（`aiApprovedPbsBroadcast.js`早已算出但被`debugPush.js`成功路徑回傳物件silently dropped，本輪補上傳遞）；`deriveFinalDecisionReason()`的`AI_NOTIFY_TRUE`分支新增`withinBroadcastHours===false`專屬判斷，回傳「通知時段外（07:00～22:30外）」——此文字沿用V2.4.6原始訂單自己列出但當時因無持久化訊號而未實作的既定用詞。嚴格`===false`比較，pre-V2.8.0記錄（欄位不存在，值為null）不受影響，仍走既有UNKNOWN預設值。

**明確不觸碰（依訂單不授權事項）**：`pbsSchedule.js`本身（已停用legacy機制，非本輪範圍）；窗外事件暫存/補送機制（真人定案維持直接捨棄）；TDX與LINE/電報邊界拆分為獨立函式（真人定案維持共用）；AI Prompt/model、`incidentSuppression.js`、`sameIncident`/`materialChange`推播閘門邏輯（V2.7.0剛完成，零行變動）。

**延遲後果（如實記錄）**：窗外事件延遲區間由「00:00-07:59」縮短為「00:00-06:59」（起算邊界08:00提早至07:00）；日終邊界22:00延後至22:30，播報窗整體變長。

**規劃外發現，完整揭露**：TDX的07:00-22:30窗現在是PBS舊有（已停用）07:00-22:00窗的SUPERSET（兩者現在同時07:00起算，TDX尾端多出30分鐘）。這使`test/tdxUsageReduction.test.js`原本第14個測試（透過兩次真實Cron tick + KV round-trip驗證night-sleep）失去了原本賴以強制寫入的巧合機制——原本21:40/22:00這兩個探測時間點，22:00剛好也是`pbsSchedule.js`自己的30分鐘排程整點，帶來真實內容差異，才能通過`persistHealthSnapshot()`的WRITE_ON_CHANGE比對（此機制本身未受本輪任何修改，見`healthSnapshot.js`自己的`stripVolatileTimeFields()`comment）。日終時段內，此巧合窗口在新邊界下已完全消失（TDX最早22:31才進入night-sleep，此時PBS早已停止30分鐘）。已將該測試改為直接呼叫`buildHealthSnapshot()`這個純函式驗證（與`scheduled.js`真實Cron路徑呼叫的函式完全相同，非重新實作）；該檔案另兩則既有測試（test 6/8）同步修正邊界數字或補充說明文字，零筆刪除，斷言邏輯本身不變。

**測試**：`broadcastRules.test.js`4→6則、`tdxSchedule.test.js`5→7則、`aiApprovedPbsBroadcast.test.js`+3則、`webhook.test.js`+1則（固定文字regression lock）、`aiObservatoryIndex.test.js`+5則（withinBroadcastHours傳遞＋新分支＋null不誤判＋SENT優先權regression lock）——共12則新測試。`broadcastPipeline.test.js`/`dynamicShoulder.test.js`/`tdxUsageReduction.test.js`既有測試邊界數字或探測方式更新，零筆刪除。全量迴歸2080項／2047通過／33失敗；`git stash -u`基準2068項／2035通過／33失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`。

**APP_VERSION**：`V2.7.0`→`V2.8.0`（MINOR，直接改變TDX抓取/LINE電報推播的真實決策時間窗，非純觀測性變更）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：07:00開始後第一則TDX/PBS事件是否確實被正確抓取與推播——尚未取得。22:30邊界是否正確生效（22:30仍推播、22:31起停止）——尚未取得。

**V2.8.0封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-08，路況-064）。封版依據：程式碼變更完成、全量迴歸2080項／2047通過／33失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.8.0`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.8.0`。

## 修正紀錄｜V2.8.1 查修頁展開卡片新增一鍵全選文字區塊（路況-066，取代路況-065）（2026-09-09）

**路況-065：工程部正確停下回報，非執行錯誤**。路況-065原授權「按鈕點擊即以`navigator.clipboard.writeText()`自動複製到剪貼簿」。工程部在動任何程式碼前先查證：查修頁整組Admin頁面（`aiObservatoryView.js`／`pipelineTraceView.js`／`deploymentStatusView.js`）刻意設計為零client-side JavaScript，這三個檔案的header comment各自重複明文記載此設計；CSP為`src/security/adminAuth.js#applyAdminSecurityHeaders()`統一套用於**全部**Admin頁面（含本頁）的`default-src 'none'`無script-src例外，其header comment明寫「this project ships no external JS/CSS on any admin page」。`navigator.clipboard.writeText()`需要執行JavaScript，若照單面字執行，唯一路徑是放寬CSP——但這需要修改`adminAuth.js`（全Admin頁面共用的安全模組），超出路況-065僅授權`aiObservatoryView.js`單一檔案、且限定「純顯示層變更」的範圍，也是一項安全政策變更而非顯示層變更。工程部依AGENTS.md第0節「一旦有任何地方與單子對不上，停下並回報」，在未動任何程式碼、未commit的狀態下回報此衝突，並提出A（放寬CSP，需追加授權）／B（純CSS全選，零JS零CSP變更）／C（維持現狀待裁示）三個選項。**真人裁示採方案B**，開立路況-066取代路況-065（路況-065本身未執行任何變更，不存在需要回滾的程式碼）。

**方案B修正內容**（僅`aiObservatoryView.js`一個檔案，零JavaScript、零CSP變更）：
1. 新增`detailSectionTitles(isTdx)`：把`renderDetail()`原本內聯計算的六個section標題（①SOURCE／②GEO或Cloudflare／③ROAD_POLICY或AI／④QUEUE或LINE...視來源而定）抽成共用函式，供HTML渲染與新的純文字渲染共用同一份標題字串，避免兩者未來各自修改而逐漸不同步。純字串抽取，字面值與原本完全相同，`renderDetail()`的HTML輸出byte-for-byte不變（既有測試全數不動即通過，證明零回歸）。
2. 新增`buildDetailPlainText(record, decision, idem, now)`：`renderDetail()`既有HTML欄位清單的純文字鏡像，section順序、標題、欄位標籤與原本HTML畫面完全比照。每個欄位值讀取`renderDetail()`本身已在用的同一批既有函式（`outcomeMeta`／`sourceLabel`／`formatTaipeiInstant`／`triStateLabel`／`lineNotAttemptedReason`／`imageExpiryLabel`／`deriveAiStageFlags`／`deriveFinalDecisionReason`）——零新計算、零新資料來源，僅格式從HTML row改為純文字`label：value`行。獨立於`renderDetail()`的HTML產生邏輯之外（而非重構`renderDetail()`成先產資料再各自渲染HTML／文字的共用結構），因訂單範圍限定純新增顯示層、避免改動`renderDetail()`既有HTML產生路徑帶來未被任何既有測試逐位元把關的意外輸出差異。
3. 新增`renderCopyAllTextBlock()`：每筆事件展開區塊最上方（flow strip之後、①SOURCE之前）新增`<pre class="copy-all-text" tabindex="0" role="textbox" aria-readonly="true">`容器，內容為該筆事件自己的`buildDetailPlainText()`輸出（經`escapeHtml`跳脫，非innerHTML）。每筆事件各自獨立一個容器——結構上即保證複製範圍不會跨筆事件，不需額外邏輯把關。
4. CSS新增`.copy-all-text { user-select: all; -webkit-user-select: all; ... }`：點擊／觸控該區塊即選取其全部文字內容，這是瀏覽器原生行為，不需任何JavaScript。`tabindex="0"`提供鍵盤可聚焦性（協助工具用途），聚焦外框純為視覺提示，並非選取觸發本身——使用者仍需自行按Ctrl+C或使用長按選單的「複製」完成最後一步，本輪只負責讓「全選」這一步自動化，如實揭露不是路況-065原本要求的「按鈕點擊即自動複製」。

**明確不觸碰（依訂單不授權事項）**：`src/security/adminAuth.js`或任何CSP設定（零行變動）；任何`<script>`標籤或inline事件處理器；AI決策邏輯、CCTV產圖邏輯、LINE或電報發送邏輯；任何欄位的計算方式或資料來源；任何KV讀寫；已封版之前所有版本（V2.8.0及更早）的任何記錄。

**測試**：`test/aiObservatoryView.test.js`新增4則——(1)容器存在性＋`tabindex="0"`＋CSS`user-select: all`存在＋零`<script>`／`onclick`／`navigator.clipboard`regression lock；(2)單筆事件容器內文字正確對應該筆事件欄位值，section順序與`renderDetail()`一致；(3)雙筆事件情境下，兩個容器互不污染（各自僅含自己事件的標記文字，無交叉洩漏）；(4)直接對`buildDetailPlainText()`的單元測試，驗證section標題／欄位標籤／原始文字區塊格式與順序。

**規劃外發現，完整揭露**：本沙盒環境`node --test`從repo根目錄執行的全量迴歸結果（1857/1841/16，此輪前）與工程記憶既有記載的Production歷史封版基準（如V2.8.0封版時的2080/2047/33）規模不同——差異來自本沙盒環境缺少部分原生依賴（CCTV拼圖/JPEG編解碼相關套件），導致16個測試檔案於載入或執行階段失敗（`pbs-relay/scripts/debug-push-test.mjs`、多個`cctv*`/`dynamicCollage`/`dynamicShoulder*`/`freeway3CctvAudit`/`hsinchuCctvCollageEndpoint`/`pipelineTraceIntegration`/`productionIntegrationFixtures`/`singleCctvBudgetFairness`/`tdxPhaseCProductionNotify`/`testJpegCodec`），與本輪異動（`aiObservatoryView.js`一個檔案）完全無關，本輪未修改上述任一檔案。已確認`git stash -u`前後兩次全量迴歸的失敗測試名稱集合逐字相同（16個檔案級失敗完全相同），僅是本沙盒既有環境限制，非本輪引入，如實揭露而非隱藏此數字差異。

**APP_VERSION**：`V2.8.0`→`V2.8.1`（PATCH，純顯示層新增，比照V2.5.1/V2.6.1先例——不改變任何既有欄位的計算、判斷或資料來源）。全量迴歸1861項／1845通過／16失敗；`git stash -u`基準1857項／1841通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`（4則新測試全數通過，既有16則失敗與基準逐字相同，0新增0消失）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：真實Production查修頁上，這個「點選即全選」容器在手機瀏覽器（尤其iOS Safari長按選單、Android Chrome）的實際使用體驗——尚未取得。真人回報此功能是否確實達成「出錯時方便直接貼給會議室」的原始需求——尚未取得。

**V2.8.1封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-09，路況-066）。封版依據：程式碼變更完成、全量迴歸1861項／1845通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.8.1`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.8.1`。路況-065本身未執行任何程式碼變更（純查證與停下回報），不構成需要封版或回滾的版本。

## 修正紀錄｜V2.8.2 查修頁AI區塊固定顯示sameIncident/materialChange欄位（路況-068，依路況-067查證）（2026-09-09）

**路況-067發現的缺口**：查修頁展開卡片的AI區塊（⑤AI）只顯示`notify`/`impact`/`confidence`/`reason`/`cleanSummary`，完全沒有渲染`sameIncident`/`materialChange`這兩個欄位——不是顯示UNKNOWN，是整段缺席。這兩個欄位自V2.7.0（路況-061）起已寫入每一筆Observatory記錄，`aiObservatoryIndex.js#deriveFinalDecisionReason()`也早已在讀取這兩個值判斷NOT_SENT分支（同一事故無實質變化的重複攔截），但AI區塊本身從未把它們列出來給人看。真實案例已證明此缺口的實際影響：路況-067需要真人在Cloudflare Dashboard直接翻KV原始資料，才能確認一次二次推播是否合理，查修頁本身給不出答案。

**修正內容（僅`aiObservatoryView.js`一個檔案，純顯示層新增）**：
1. `renderDetail()`的AI區塊，緊接`reason`欄位之後新增兩行：`sameIncident`／`materialChange`，三態顯示（`true`／`false`／`—`）。
2. 顯示邏輯：`record.sameIncident === undefined || record.sameIncident === null`（`materialChange`同理）時傳`null`給既有`renderField()`，沿用其既有的null/undefined→`—`fallback；否則傳`String(record.sameIncident)`（`true`/`false`小寫字面值）。未新增任何新的顯示輔助函式，也未修改`renderField()`本身。
3. `buildDetailPlainText()`（路況-066/V2.8.1新增的一鍵全選文字鏡像函式）同步新增這兩行，使用完全相同的判斷邏輯（各自在`renderDetail()`與`buildDetailPlainText()`內以區域變數`sameIncidentDisplay`/`materialChangeDisplay`計算一次），確保純文字複製版本與畫面顯示不會出現新的不同步缺口。
4. `record.sameIncident`／`record.materialChange`欄位本身的計算方式與寫入邏輯（V2.7.0的`debugPush.js#runAiDecisionPath()`重複事件攔截判斷）**零行變動**——本輪純粹是讓既有欄位對人可見，不影響任何推播決策。

**明確不觸碰（依訂單不授權事項）**：AI決策邏輯、`sameIncident`/`materialChange`的計算或判斷方式本身；V2.7.0的推播攔截邏輯（`debugPush.js`的重複事件攔截判斷）；任何KV讀寫；已封版之前所有版本（V2.8.1及更早）的任何記錄；真人本機工作目錄；Cloudflare或Google Drive操作。

**測試**：`test/aiObservatoryView.test.js`新增4則——(1)`sameIncident:true`/`materialChange:true`（路況-067真實案例情境）正確顯示兩行對應值；(2)`sameIncident:true`/`materialChange:false`（V2.7.0攔截情境）正確顯示；(3)首次事件（欄位undefined/null，`memoryCandidateCount=0`）正確顯示為`—`，不誤判為`false`；(4)`buildDetailPlainText()`純文字輸出同步包含這兩行且三態顯示與HTML畫面一致的直接單元測試。既有APP_VERSION版本鎖定測試同步更新至`V2.8.2`。

**APP_VERSION**：`V2.8.1`→`V2.8.2`（PATCH，純顯示層新增，比照V2.5.1/V2.6.1/V2.8.1先例）。全量迴歸1865項／1849通過／16失敗；`git stash -u`基準1861項／1845通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`（4則新測試全數通過，既有16則失敗與基準逐字相同，0新增0消失——同一組沙盒環境原生依賴限制既有失敗，與本輪異動檔案無關）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：真實Production查修頁上，這兩個新欄位在真正發生同一事故二次通報（V2.7.0攔截情境）時的實際顯示效果，是否確實讓真人不再需要翻KV原始資料——尚未取得。

**V2.8.2封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-09，路況-068）。封版依據：程式碼變更完成、全量迴歸1865項／1849通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.8.2`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.8.2`。

## 修正紀錄｜V2.9.0「一小時內同位置不重複推播」硬性規則（路況-070，執行路況-069規劃）（2026-09-10）

**產品方向轉向（明確記錄，非V2.7.0有誤）**：連續兩天真實案例——2026-09-09國3北向追撞、2026-09-10砂石車追撞——證明V2.7.0（路況-061）讓AI的`sameIncident`/`materialChange`成為唯一語意守門人的設計本身運作正確：AI兩次都正確判斷了實質變化，不是bug。真人在看過這兩次真實案例後認為，即使AI判斷合理，同位置頻繁重複通知仍讓司機觀感不佳，因此決定疊加一條**優先權高於AI判斷**的硬性規則：60分鐘內同位置預設不推播，不論AI的notify/sameIncident/materialChange為何，唯一例外是嚴重程度真的從LOW升級到HIGH。**V2.7.0既有的`suppressForNoChange`區塊本身零行變動**，本輪是疊加在其上的新規則，不是取代或否定V2.7.0。

**真人定案的完整規則**：①同路、同方向、公里數相差在1公里內視為同位置；②從該位置最近一次成功推播算起60分鐘內；③預設不推播，不論AI判斷為何；④例外：新事件impact為HIGH、且該位置先前記錄的最高impact為LOW時，例外放行並將此次視為新的「最近一次成功推播」，重新起算60分鐘窗口。

**新增獨立模組`src/pbs/positionCooldown.js`**（獨立KV key`line:position-cooldown-state`）——依路況-069三節建議，刻意不沿用/修改`incidentMemory.js`（其分組受AI自己的sameIncident判斷牽動，同位置但AI判斷sameIncident:false的事件會被漏掉）或`incidentSuppression.js`（僅accident類型適用，其既有常數/函式`INCIDENT_MAX_KM_DIFF`等本輪零行變動）。純KM比對（1公里，獨立常數`POSITION_COOLDOWN_MAX_KM_DIFF`，未比對座標）；{road,direction,km}描述沿用（唯讀取，非修改）`incidentMemory.js`既有匯出的`deriveEventLocationForMemory()`，使PBS（displayKM）與TDX（startKM/endKM中點）事件能透過同一份描述正確互相比對——已用跨來源測試驗證（`test/positionCooldown.test.js` scenario 8）。依路況-069四節查證，`aiDecisionEngine.js`的`impact`欄位僅HIGH/LOW二元值（無MEDIUM），故「升級」只有LOW->HIGH一種可能；`maxImpactNotified`一旦為HIGH永不降級（真人定案原文「若本次為HIGH則覆蓋，否則維持既有值不降級」）。

**插入位置**：`debugPush.js#runAiDecisionPath()`內，V2.7.0`suppressForNoChange`判斷之後、`suppressLineNotify`計算之前（依路況-069一節選項A）。攔截時return shape完全比照`suppressForNoChange`（`lineAttempted`/`lineSent`/`telegramAttempted`/`telegramSent`皆明確`false`，不呼叫`runAiApprovedPbsBroadcast()`——0 CCTV、0 LINE、0 Telegram、0 Shared Feed，`completedProducts`從未建立），新增`positionCooldownBlocked:true`欄位寫入Observatory記錄（`aiObservatoryIndex.js#buildAiObservatoryRecord()`新增對應參數）供未來查修頁擴充使用。位置冷卻記錄只在**真正成功推播**（`broadcastResult.pushSucceeded>0`）之後才更新，與`incidentMemory.js`自己的`notified`判斷同一慣例。

**查修頁顯示（依訂單本輪明確列為非必要）**：本輪未新增`deriveFinalDecisionReason()`專屬分支——`positionCooldownBlocked`欄位已寫入記錄但暫未在畫面上呈現專屬理由文字，留待後續派工單視需要處理。

**本輪自訂假設，完整揭露（訂單原文皆未指定，供會議室視現場觀察結果確認是否合適）**：
1. **記錄保留期限8小時**——`maxImpactNotified`的「不降級」規則需要記錄在60分鐘窗口過期後仍然存在才能比較，故不能讓記錄在60分鐘一到就整筆消失。沿用`incidentMemory.js`同一資料領域（road+direction+km）已在用的8小時TTL量級作為預設保留期限（`POSITION_COOLDOWN_RECORD_TTL_MS`）。
2. **60分鐘邊界採inclusive**——`elapsedMs<=60分鐘`仍視為在窗口內（60分00秒仍攔截，60分00秒01毫秒才視為過期），比照本專案`broadcastHours.js`（V2.8.0/路況-064，07:00~22:30，22:30仍推播、22:31起停止）既有的closed-interval慣例，是本專案唯一直接可比對的既有精確邊界先例。
3. **KM-only比對，未比對座標**——真人定案文字僅提到「公里數相差在1公里內」，未提及座標比對，依路況-069三節查證未定案座標比對，本輪採最簡單的KM-only設計，km為null時永不攔截（與既有兩個模組的「無法確認位置就不猜」哲學一致）。

**明確不觸碰（依訂單不授權事項）**：AI Prompt/model；V2.7.0既有的sameIncident/materialChange判斷機制與`suppressForNoChange`區塊（零行變動）；`incidentMemory.js`的`proximityMatch()`與`incidentSuppression.js`的既有函式/常數（零行變動）；CCTV、LINE、電報發送邏輯本身；已封版之前所有版本（V2.8.2及更早）的任何記錄。

**測試**：新增`test/positionCooldown.test.js`（23則）——Part 1純函式單元測試13則（KM比對邊界、視窗判斷、例外邏輯、maxImpactNotified不降級、TTL剪除、WRITE_ON_CHANGE、fail-open）；Part 2端到端pipeline測試10則（APP_VERSION版本鎖定＋依路況-069七節/路況-070四節情境清單9則：60分鐘內無升級擋下、LOW->HIGH例外放行並重新起算、超過60分鐘不受影響、不同位置不受影響、與V2.7.0交互驗證優先權更高、60分鐘邊界、首次事件不受影響、跨來源正確攔截、Shared Feed regression lock）。既有V2.7.0/V2.8.x相關測試檔案（`tdxUnifiedAiPipeline.test.js`／`tdxPhaseCProductionNotify.test.js`／`pbsAiDecisionScenarios.test.js`／`aiObservatoryView.test.js`／`aiObservatoryIndex.test.js`／`v2412ObservatoryNoSendReasonHighVisibilityUI.test.js`等）**零筆修改即全數通過**（施工前逐一確認）——本規則只在AI決策已通過suppressForNoChange檢查、且同位置60分鐘內已有真實成功推播記錄時才會產生行為差異，既有測試從未建構出這個精確條件組合；`aiObservatoryView.test.js`既有APP_VERSION版本鎖定測試同步更新至V2.9.0。

**規劃外發現，完整揭露**：施工前檢查發現`test/pbsDebugPush.test.js`／`test/pbsAiObservatoryFourLayer.test.js`各自有一組精確KV get/put次數斷言的既有測試（`KV cost quantification`/`KV cost formula`），原本擔心本輪新增的位置冷卻KV讀寫會打破這些斷言——查證後確認這兩組測試皆刻意使用**legacy（AI停用）路徑**（`PBS_AI_DECISION_ENABLED`未設定，預設false），完全不會呼叫`runAiDecisionPath()`，因此不受本輪影響，無需修改任何既有斷言。

**APP_VERSION**：`V2.8.2`→`V2.9.0`（MINOR，直接改變LINE/電報實際推播決策，比照V2.7.0/V2.6.0先例，非純顯示層變更）。全量迴歸1888項／1872通過／16失敗；`git stash -u`基準1865項／1849通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`（23則新測試全數通過，既有16則失敗與基準逐字相同，0新增0消失——此沙盒環境原生依賴限制導致的既有已知失敗，與本輪異動檔案無關）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：下一次60分鐘內同位置事件是否正確攔截——尚未取得；下一次LOW→HIGH升級是否正確例外放行——尚未取得；本輪自訂的8小時記錄保留期限與60分鐘inclusive邊界，是否符合真人實際期待——尚未取得現場驗證。

**V2.9.0封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-10，路況-070）。封版依據：程式碼變更完成、全量迴歸1888項／1872通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.9.0`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.9.0`。

## 修正紀錄｜V2.10.0 LINE主動事故推播正式退役（路況-074，執行路況-073規劃）（2026-09-17）

**決策依據**：真人確認Telegram已觀察數日、穩定、無額度問題，LINE主動事故推播正式退役。真人已定案：關開關、程式碼保留（可隨時復原），不刪除任何LINE相關程式碼、依賴、測試、Secret；現有訂閱LINE的計程車群組（含「小黃多元計程車分享群」）靜默停止，不主動通知。

**範圍界線（明確記錄，避免誤解）**：本輪**僅**退役主動事故推播（`aiApprovedPbsBroadcast.js#deliverToLineTargets()`這一條路徑）。LINE Bot既有互動回覆功能（`line/webhook.js`透過`line/replyMessage.js`的「啟動播報」/「關閉播報」/「播報狀態」指令）走完全不同的程式路徑，從未import`aiApprovedPbsBroadcast.js`，**完全不受影響**，已用`test/webhook.test.js`新增regression lock驗證。

**實作內容**：
1. 新增`isLineNotifyEnabled(env)`（`src/traffic/aiApprovedPbsBroadcast.js`）。polarity刻意比照同專案`src/traffic/sourceMode.js#isCctvImageEnabled()`既有寫法（未設定/非'FALSE'/'0'/'OFF'皆視為開啟）——而非TDX系列switch`resolveBooleanVar()`的「預設關閉」polarity。此為路況-073一節查證已識別並迴避的真實風險：若誤用「預設關閉」polarity，任何忘記在wrangler.jsonc明確宣告的環境（含本專案`test/aiApprovedPbsBroadcast.test.js`既有31則測試，皆未設定過此類環境變數）都會在真人尚未決定的情況下意外關閉LINE。
2. 開關置於`deliverToLineTargets()`函式**最開頭**，短路於`readSubscriptions()`/`readNotifiedState()`兩次KV讀取之前——`line:subscriptions`訂閱名單因此完全不被讀取也不被寫入，自然達成「靜默保留」，不需要額外處理。`deliverToTelegram()`函式**逐字未動**。
3. 同一輪在`wrangler.jsonc`的`vars`區塊新增`"LINE_NOTIFY_ENABLED": "FALSE"`，完成「新增開關」與「真正關閉」兩件事於同一輪。

**對V2.9.0一小時同位置規則的影響**：路況-073三節查證結論——`aiApprovedPbsBroadcast.js`的`pushSucceeded = line.succeeded + telegram.succeeded`是加總計算，LINE關閉後`line.succeeded`恆為0，`pushSucceeded`自動、正確地只反映Telegram，`debugPush.js`用來觸發position cooldown更新的`pushSucceeded > 0`判斷式**不需要任何調整**。已用`test/positionCooldown.test.js`新增的端到端測試直接驗證（LINE關閉、僅Telegram成功時，位置冷卻記錄仍正確建立、LOW→HIGH例外仍正確放行）。

**復原方式**：`LINE_CHANNEL_ACCESS_TOKEN`（Cloudflare Secret）與`line:subscriptions`訂閱名單皆保留不動——僅需將`LINE_NOTIFY_ENABLED`改回`"true"`（或整行移除，回落程式碼預設值）即可完整復原，零程式碼變更、零憑證重設、零訂閱名單重建。

**明確不觸碰（依訂單不授權事項）**：`deliverToTelegram()`（零行變動）；AI決策邏輯、CCTV產圖邏輯、V2.7.0/V2.9.0既有判斷邏輯本身；`line/webhook.js`/`line/replyMessage.js`；`line:subscriptions`名單本身（零寫入）；任何LINE相關程式碼、依賴、測試、Secret的刪除；已封版之前所有版本（V2.9.0及更早）的任何記錄。

**測試**：新增7則——`test/aiApprovedPbsBroadcast.test.js`4則（開關關閉時短路於KV讀取之前且Telegram完全不受影響、未設定時預設開啟的regression lock、明確'true'時維持開啟、大小寫/空白不敏感的關閉值皆正確生效）；`test/aiObservatoryView.test.js`1則（查修頁「⏭️ LINE 未發送」與「重大事故（經Telegram發送）」既有V2.6.1分支正確涵蓋，零新增顯示邏輯）；`test/positionCooldown.test.js`1則（V2.9.0交互驗證）；`test/webhook.test.js`1則（LINE Bot互動回覆功能不受影響regression lock）。既有`test/aiApprovedPbsBroadcast.test.js`原31則測試**零筆修改**即全數通過（已實際執行驗證，非僅推測）。

**規劃外發現，完整揭露**：`test/pbsAiConfigDriftHotfixV202.test.js`既有一則「no Secret name...was added to wrangler.jsonc vars this round」測試，對`wrangler.jsonc`的`vars`區塊做原始文字（含註解）掃描。本輪`wrangler.jsonc`新增註解草稿初版內文提及`LINE_CHANNEL_ACCESS_TOKEN`字面字串（僅為說明文字，非真的新增此變數宣告），觸發此既有測試的字面字串比對而短暫失敗；`test/positionCooldown.test.js`既有的APP_VERSION版本鎖定測試也在第一次全量迴歸時因忘記同步更新而短暫失敗。兩者皆已修正（前者改寫註解措辭避開字面字串比對，後者更新版本斷言值），修正後確認全數通過，兩則既有測試本身的斷言邏輯皆未被修改。

**測試總數跨輪銜接揭露（依AGENTS.md第6節路況-071新增規則）**：本輪`git stash -u`基準1888項／1872通過／16失敗，與上一輪（V2.9.0，路況-070；路況-071/072/073皆為純文件或純規劃，未執行測試）報告收尾的1888/1872/16完全銜接，無落差。

**APP_VERSION**：`V2.9.0`→`V2.10.0`（MINOR，直接改變LINE/電報實際推播決策，比照V2.6.0/V2.7.0/V2.9.0先例）。全量迴歸1895項／1879通過／16失敗；`git stash -u`基準1888項／1872通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`（7則新測試全數通過，既有16則失敗與基準逐字相同，0新增0消失——此沙盒環境原生依賴限制導致的既有已知失敗，與本輪異動檔案無關）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：LINE群組（含「小黃多元計程車分享群」）靜默停止後，是否確實無人反應異常或詢問——尚未取得；Telegram作為唯一主動推播管道，實際運作是否持續穩定——尚未取得。

**V2.10.0封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-17，路況-074）。封版依據：程式碼變更完成、全量迴歸1895項／1879通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.10.0`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.10.0`。

## 修正紀錄｜V2.10.1 查修頁補上「LINE已停用」專屬顯示理由（路況-075，執行路況-074已標記待辦）（2026-09-17）

**背景**：V2.10.0（路況-074）LINE主動事故推播正式退役後，查修頁借用既有V2.6.1的「未設定/未啟用」語意顯示——`lineSummaryBadge`顯示「⏭️ LINE 未發送」，`deriveFinalDecisionReason`顯示「經Telegram發送」——不會顯示錯誤，但無法區分「LINE整體已政策性停用」與「這次剛好沒送到（quota/API錯誤/無訂閱者）」。路況-074回報已明確記錄此為留待後續派工單處理的事項；本輪即為該後續派工單。

**修正內容**：
1. `traffic/aiApprovedPbsBroadcast.js#isLineNotifyEnabled()`改為`export`（判斷邏輯本身零行變動），供`debugPush.js`重用同一份判斷，避免第二份可能漂移的複本。
2. `debugPush.js#writeObservatoryRecord()`（本專案所有Observatory寫入的唯一choke point）新增`lineRetired: !isLineNotifyEnabled(env)`，套用於**每一筆**記錄（不限AI_NOTIFY_TRUE），因為收合卡片徽章與展開LINE段落對所有outcome都會渲染。
3. `aiObservatoryIndex.js#buildAiObservatoryRecord()`新增`lineRetired = false`參數（預設false）。
4. `aiObservatoryView.js#lineSummaryBadge()`新增分支：`lineSent`之後、`lineAttempted`失敗判斷之前插入`lineRetired`檢查，顯示「⏸️ LINE 已停用」，取代原本借用的「⏭️ LINE 未發送」。`lineSent`與`lineAttempted`失敗分支的既有判斷條件與文字**逐字不變**。
5. 展開的LINE段落新增一行「LINE 服務狀態：已停用（自 V2.10.0，路況-074）」（`lineRetired===true`時顯示），文字為凍結的歷史事實常數（`LINE_RETIRED_STATUS_LABEL`），不隨當下`APP_VERSION`浮動——記錄的是「哪一輪讓LINE停用」，不是「現在是第幾版」。
6. `buildDetailPlainText()`（路況-066的一鍵全選文字鏡像）同步新增相同一行，維持既有的「純文字版本與畫面顯示不得漂移」維護承諾。

**向下相容**：`lineRetired`欄位不存在的舊格式記錄（V2.10.1之前寫入、其48h TTL內被讀回）透過`buildAiObservatoryRecord()`的預設參數值自動degrade為`false`——這同時是正確的歷史事實（LINE在V2.10.0存在之前，從未真的被停用過），不是猜測。

**明確不觸碰（依訂單不授權事項）**：任何推播邏輯、AI決策邏輯、`isLineNotifyEnabled()`本身的判斷方式（僅改為`export`，邏輯零行變動）；已封版之前所有版本（V2.10.0及更早）的任何記錄。

**測試**：`test/aiObservatoryView.test.js`新增5則——(1)LINE啟用時（`lineRetired:false`）既有三態顯示邏輯不受影響regression lock；(2)停用時收合卡片正確顯示「⏸️ LINE 已停用」；(3)展開區塊正確顯示新增的「LINE 服務狀態」行；(4)舊格式記錄（`lineRetired`未定義）向下相容regression lock，不誤判為已停用；(5)`buildDetailPlainText()`同步鏡像。既有V2.10.0測試（其本身情境恰好就是`LINE_NOTIFY_ENABLED=FALSE`，正是本輪新增判斷會實際改變顯示文字的精確情境）斷言更新為新的、更精確的「⏸️ LINE 已停用」文字，測試標題同步更新反映這個預期內的顯示升級，而非既有斷言邏輯被隨意調整。

**測試總數跨輪銜接揭露（依AGENTS.md第6節路況-071新增規則）**：本輪`git stash -u`基準1895項／1879通過／16失敗，與上一輪（V2.10.0，路況-074）報告收尾的1895/1879/16完全銜接，無落差。

**APP_VERSION**：`V2.10.0`→`V2.10.1`（PATCH，純顯示層新增，比照V2.5.1/V2.6.1/V2.8.x先例）。全量迴歸1900項／1884通過／16失敗；`git stash -u`基準1895項／1879通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`（5則新測試全數通過，既有16則失敗與基準逐字相同，0新增0消失——此沙盒環境原生依賴限制導致的既有已知失敗，與本輪異動檔案無關）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：真實Production查修頁上，「⏸️ LINE 已停用」徽章與展開區塊的「LINE 服務狀態」行，是否確實讓真人不需再翻wrangler.jsonc或工程記憶就能理解為何沒有LINE記錄——尚未取得。

**V2.10.1封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-17，路況-075）。封版依據：程式碼變更完成、全量迴歸1900項／1884通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.10.1`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.10.1`。

## 修正紀錄｜V2.10.2（2026-09-23，路況-079）— 提交路況-078的LocalMonitor鎖檔修復進main

**背景（依路況-076/077/078既有查證，本輪不重查）**：2026-09-21晚間，LocalMonitor因非正常終止導致鎖檔（`local-monitor.lock`）卡死——舊有`acquireMonitorLock()`只以「PID是否存活」判斷鎖檔是否有效，watchdog每分鐘一次的自動重啟嘗試因此被誤判為「monitor仍在執行」而反覆失敗，且每次失敗前短暫開啟的視窗會搶走真人桌面焦點，造成打字內容被中斷清空。路況-078已由Cowork在真人本機工作目錄（`C:\Users\mrhap\traffic-reporter`）完成修復方案A（鎖檔新增心跳機制），惟該修改僅存在於本機工作目錄，尚未進入版本控制；本單負責將其正式提交進main。

**取得修改內容的方式（訂單二擇一授權，明確揭露）**：本session在雲端repo工程部執行，**無法**取得真人本機工作目錄路況-078實際寫回的位元組內容——`git log`／`grep`遍查本repo與工程記憶皆查無路況-076/077/078相關記錄，該內容從未同步進本repo。故採**第二種方式**：依路況-079訂單本身對修改內容的技術描述（函式名稱、常數值、邏輯位置）在repo內重新實作等價變更。訂單提及的「5則測試詳見路況-078回報」同樣因原文不可得而**無法逐字重現**——本輪5則測試為依訂單描述的行為自行設計，非路況-078原始測試的複製，此落差已完整揭露，不宣稱兩者位元組相同。

**修正內容（`pbs-relay/src/localRuntime.js`）**：
1. 新增`DEFAULT_HEARTBEAT_INTERVAL_MS`（180000ms，比照既有`PBS_LOCAL_INTERVAL_MS`預設3分鐘輪詢間隔）與`DEFAULT_LOCK_STALE_MULTIPLIER`（5）。
2. 新增`resolveStaleLockThresholdMs()`：回傳心跳過期閾值（預設180000×5=900000ms=15分鐘），支援`PBS_LOCAL_LOCK_HEARTBEAT_MS`／`PBS_LOCAL_LOCK_STALE_MULTIPLIER`環境變數覆寫。
3. 新增`touchMonitorLock(path, now, { pid })`：更新鎖檔`heartbeatAt`欄位，不影響`pid`／`startedAt`；鎖檔已被外部刪除（ENOENT）時不拋錯，改以目前pid重新建立新鎖檔（ENOENT防呆）。
4. `acquireMonitorLock()`新增`staleAfterMs`參數（預設取自`resolveStaleLockThresholdMs()`）；鎖檔內容新增`heartbeatAt`。既有EEXIST分支判斷從「PID存活即拒絕」改為「PID存活**且**心跳未逾期，才拒絕」；PID存活但心跳已逾期視為卡死殘留鎖檔，自動清除重取。舊格式鎖檔（無`heartbeatAt`）視為「心跳未逾期」以維持向下相容，既有測試逐字不變仍通過。
5. `release()`既有清除邏輯**逐行不變**（依訂單不授權事項）。

`pbs-relay/src/localMonitor.js`：import新增`touchMonitorLock`，watch迴圈內每輪`roundTime`計算後新增一行`await touchMonitorLock(lockPath, roundTime)`呼叫。

**測試**：`pbs-relay/tests/localRuntime.test.js`新增5則（本輪自行設計，見上方揭露）——(1)PID存活但心跳已逾15分鐘閾值→視為卡死，自動清除重取；(2)PID存活且心跳未逾期→仍正確拒絕（確保新機制不削弱既有防重複啟動保護）；(3)`touchMonitorLock()`更新`heartbeatAt`，`pid`/`startedAt`不變；(4)`touchMonitorLock()`面對ENOENT不拋錯，改為重建；(5)`resolveStaleLockThresholdMs()`預設值與覆寫參數皆正確。`pbs-relay`目錄獨立執行`npm test`：129項全數通過。

**APP_VERSION**：`V2.10.1`→`V2.10.2`（PATCH，修復性質，不改變對外行為契約）。

**測試總數跨輪銜接揭露（依AGENTS.md第6節路況-071新增規則）**：本輪`git stash -u`基準1900項／1884通過／16失敗，與上一輪（V2.10.1，路況-075）報告收尾的1900/1884/16完全銜接，無落差。全量迴歸1905項／1889通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`（5則新測試全數通過，既有16則失敗與基準逐字相同）。

**規劃外發現，完整揭露**：repo根目錄`node --test`預設遞迴掃描含`pbs-relay/tests/*.test.js`，故先前各輪回報的「全量迴歸」數字本就已包含pbs-relay測試，非本輪新納入，僅為本輪查證時重新確認並在此註明。

**明確不觸碰（依訂單不授權事項）**：真人本機工作目錄（本單僅操作GitHub repo，未對本機做任何git操作）；方案B（視窗/啟動方式，真人已定案不執行）；`release()`既有清除邏輯；已封版之前所有版本（V2.10.1及更早）的任何記錄；Cloudflare／Google Drive任何操作。

**明確記錄未解決事項**：LocalMonitor最初為何非正常終止（最上游根因）仍未查明，本單與路況-078皆未處理此根因，僅處理「非正常終止後鎖檔卡死、watchdog連帶失效」這一段下游後果。

**真人本機工作目錄與本次GitHub提交的一致性：不一致，本單不負責使兩者一致**。本單提交的是本session依訂單描述重新實作的等價版本；真人本機工作目錄若仍保留路況-078當時Cowork寫入的版本，兩份程式碼在位元組層級大機率不同（縱使行為等價）。依訂單本文，兩者如何對齊屬於另一個獨立問題，本單不處理、不代為決定，僅如實記錄現狀不同步，留待真人後續決定（例如本機`git pull`覆蓋本機版本，或反向以本機版本為準另開一版）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：下次LocalMonitor若再度非正常終止，心跳過期機制是否確實能讓watchdog在15分鐘內自動恢復（而非又拖到真人手動介入）——尚未取得。

**V2.10.2封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-23，路況-079）。封版依據：程式碼變更完成、全量迴歸1905項／1889通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.10.2`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.10.2`。

## 修正紀錄｜V2.10.3（2026-09-23，路況-082）— 以真人本機實測版本取代V2.10.2的鎖檔心跳機制，併入Relay檔案化日誌

**路況-081的查證與停下（本輪的前置決策依據）**：路況-081受命將真人本機`preserve/windows-runtime-20260906`分支（commit`d4c8a5e`，含路況-078鎖檔心跳機制的真人本機實測版＋路況-080的Relay檔案化日誌）併入main，執行前先查證發現：(1) 該分支與main分岔於**V1.8.3**（`git merge-base`=`7740778`），`wrangler.jsonc`因此嚴重過時——完全缺少`vars`/`ai`/`queues`三個區塊、R2 binding命名不同，若整份套用等同一次回退44個版本以上的Production關鍵設定；(2) `d4c8a5e`的鎖檔心跳機制（mtime-based，`utimes()`/`stat()`）與main現有V2.10.2（路況-079，JSON欄位based，`heartbeatAt`）為兩種不同技術方案，非表面風格差異。路況-081依訂單條款「若涉及既有設定衝突，停下回報，不擅自解決」與「若有實質差異，完整列出差異點，不得擅自決定以哪個為準」，在查證完成、**尚未做任何合併/commit/push**的狀態下停下，將完整比對結果（含差異表）回報會議室。

**會議室裁示（本輪依此執行，未自行更動）**：
1. `wrangler.jsonc`——**維持main現有版本，不套用`d4c8a5e`任何內容**。
2. 鎖檔心跳機制——**採用`d4c8a5e`真人本機實測版本，取代main現有V2.10.2的JSON欄位版本**。

**取捨理由（裁示明確記載，非工程部自行判斷）**：`d4c8a5e`已由真人於2026-09-23在本機實際運作驗證有效；V2.10.2版本是路況-079因無法取得路況-078真人本機原始內容，依訂單文字描述在雲端重新實作的等價版本，從未在真實環境跑過。

**修正內容**：
1. `wrangler.jsonc`：**零修改**，逐位元組維持main現狀。
2. `pbs-relay/src/localRuntime.js`：整份改採`d4c8a5e`版本——心跳訊號改存於鎖檔檔案本身的mtime，不再寫JSON欄位；`resolveStaleLockThresholdMs()`直接讀取既有`PBS_LOCAL_INTERVAL_MS`（輪詢間隔）×5倍，移除V2.10.2新增的專屬`PBS_LOCAL_LOCK_HEARTBEAT_MS`環境變數；`touchMonitorLock(path, now)`移除`{pid}`參數，ENOENT時靜默不處理（交由下一輪`acquireMonitorLock()`自然重建，不主動重建）；`acquireMonitorLock()`EEXIST分支改為「PID存活」與「`stat()`檢查mtime未逾期」兩個獨立判斷同時成立才拒絕；移除V2.10.2「`heartbeatAt`不存在視為未逾期」的舊格式特判（mtime機制天然一致，不需要）；`release()`的`unlink()`補上ENOENT容錯。
3. `pbs-relay/src/localMonitor.js`：`touchMonitorLock()`呼叫時機從「每輪開始前」改為「每輪try/catch結束後（成功或失敗皆呼叫）」。
4. `pbs-relay/src/server.js`／新增`pbs-relay/src/serverRuntime.js`（路況-080）：整份套用`d4c8a5e`版本，其base與main現有`server.js`逐位元組相同，無衝突。`createServer()`新增可選`logDirectory`參數（預設`null`＝零日誌行為不變，僅production bootstrap傳入真實路徑），`/health`健康檢查節流式記錄（狀態不變15分鐘一筆／狀態變化立即記錄），`uncaughtException`/`unhandledRejection`/`SIGTERM`/`SIGINT`皆先落地`pbs-relay/logs/relay/*.jsonl`再維持既有console輸出與exit行為。
5. `.gitignore`：新增`.pbs-token-test`／`data/`兩行，其base與main現況逐位元組相同，無衝突。**規劃外發現重申（路況-081已揭露）**：`data/`規則會連帶比對repo根目錄的`data/`（31個既有追蹤檔案不受影響，日後`git add -A`會略過此目錄下新檔案除非強制`-f`）——非阻擋項，僅供未來參考。

**測試**：`pbs-relay/tests/localRuntime.test.js`整份改採`d4c8a5e`版本（9則）——**移除**V2.10.2遺留的5則JSON欄位機制專屬測試（心跳逾期回收［JSON版本］、心跳未逾期仍拒絕、`touchMonitorLock`更新JSON欄位、ENOENT重建JSON鎖檔、`resolveStaleLockThresholdMs()`專屬env var覆寫），因其斷言的是已被取代的機制與已移除的`PBS_LOCAL_LOCK_HEARTBEAT_MS`環境變數；**新增**`d4c8a5e`自帶的5則mtime-based測試（存活+心跳逾期回收、存活+心跳未逾期仍拒絕、死亡PID即使心跳新鮮仍回收、`touchMonitorLock`刷新mtime且面對消失的鎖檔不拋錯、預設閾值＝輪詢間隔×5倍且可被`PBS_LOCAL_INTERVAL_MS`覆寫）；原有4則與心跳機制無關的測試（重複實例判斷、操作日誌欄位、日誌保留、debug push日誌）逐字保留。`pbs-relay/tests/server.test.js`新增2則（`logDirectory`未傳入行為不變、傳入時health_check記錄正確寫入）。新增`pbs-relay/tests/serverRuntime.test.js`（11則）。`pbs-relay`目錄獨立`npm test`：142項全數通過（129既有＋13新增）。

**APP_VERSION**：`V2.10.2`→`V2.10.3`（PATCH）。

**測試總數跨輪銜接揭露（依AGENTS.md第6節路況-071新增規則）**：本輪`git stash -u`基準1905項／1889通過／16失敗，與上一輪（V2.10.2，路況-079）報告收尾的1905/1889/16完全銜接，無落差；變化來源明確為+13則測試。全量迴歸1918項／1902通過／16失敗；測試名稱集合逐字比對確認`NEW_FAILURES=0`。**規劃外發現**：查證時基準其中一次run曾多顯示1則額外失敗（「4: missing/placeholder build metadata -> explicit drift, not silently "fine"」），經連續兩次獨立重跑基準確認此為既有的環境層級flaky test，與本輪異動檔案無關，不計入NEW_FAILURES。

**明確記錄：V2.10.2的既有封版記錄保留不動，未被回頭修改**——本輪是「V2.10.3以真人本機實測版本取代V2.10.2的鎖檔心跳機制」的新版本，比照既有慣例（V2.4.16與V2.4.18的關係：後版本取代前版本的某項判斷，前版本自己的封版記錄不重寫）。

**明確不觸碰（依訂單不授權事項）**：`wrangler.jsonc`一行未改；真人本機工作目錄（本單僅操作GitHub repo，未對`preserve`分支或本機做任何寫入）；已封版之前所有版本（V2.10.2及更早）的既有記錄本身；Cloudflare／Google Drive任何操作。

**真人本機同步提醒**：本輪完成後main與真人本機`preserve/windows-runtime-20260906`分支的`d4c8a5e`在「鎖檔心跳+Relay日誌」這一部分邏輯等價，但`wrangler.jsonc`維持main版本（比`d4c8a5e`新44個版本以上，含`vars`/`ai`/`queues`區塊與正確的R2 binding命名）。**不建議**真人直接把`preserve`分支合併進本機工作目錄使用中的檔案（會帶入過時的`wrangler.jsonc`）；較安全的做法留待另案處理，本單不代為執行或建議具體步驟。

**待現場觀察事項（明確記錄，不得寫成已確認）**：真人下次重啟LocalMonitor/Relay時（比照本次流程），確認新版本的mtime-based心跳機制在repo標準版本上運作正常——尚未取得。

**V2.10.3封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-23，路況-082）。封版依據：程式碼變更完成、全量迴歸1918項／1902通過／16失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.10.3`、commit已push main並驗證。發現問題一律開下一個版本，不回頭改已封版的`V2.10.3`。
