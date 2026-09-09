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
