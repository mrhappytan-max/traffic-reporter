<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

> **Known Issues 已分卷（2026-09-04起，2026-09-07 增至三卷，2026-09-08 增至四卷）**：`07_KNOWN_ISSUES.md`（Volume 01，歷史封存，完整保留不刪）＋`07_KNOWN_ISSUES_02.md`（Volume 02，歷史封存，完整保留不刪）＋`07_KNOWN_ISSUES_03.md`（Volume 03，歷史封存，完整保留不刪）＋`07_KNOWN_ISSUES_04.md`（Volume 04，CURRENT，新記錄從這裡寫）。查任何舊 Bug／技術債／根因／修復教訓，**四卷都要查**，只讀其中幾卷不算完整。詳見 Volume 04 開頭的卷別承接說明。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V2.8.2（唯一權威來源：`src/version.js` 的 `APP_VERSION`；2026-09-09 路況-068（依路況-067查證）：查修頁AI區塊（⑤AI）緊接`reason`之後固定顯示`sameIncident`/`materialChange`兩欄位（三態`true`/`false`/`—`），修正路況-067發現的缺口——這兩個欄位自V2.7.0起已寫入每筆記錄且已用於NOT_SENT判斷，但畫面從未渲染，真人須翻Cloudflare Dashboard KV原始資料才能確認二次推播是否合理。`buildDetailPlainText()`同步新增這兩行，PATCH bump（純顯示層新增，欄位計算/寫入邏輯零行變動），詳見07_KNOWN_ISSUES_04.md）。**SEALED（2026-09-09，路況-068，依AGENTS.md第6節一段式封版規則）**。前十版V2.8.1（路況-066）、V2.8.0（路況-064）、V2.7.0（路況-061）、V2.6.1（路況-056）、V2.6.0（路況-055）、V2.5.1（路況-053）、V2.5.0（路況-052）、V2.4.18（路況-049）、V2.4.17（路況-044）、V2.4.16（路況-040）皆為SEALED，詳見07_KNOWN_ISSUES_03.md／07_KNOWN_ISSUES_04.md |
| Source main HEAD | 470c87a（TRAFFIC_REPORTER_V2_4_15_QWEN_AI_MODEL_REPLACEMENT Runtime commit） |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty（本輪 TRAFFIC_REPORTER_V2_4_15_PRODUCTION_SEAL 治理封版 changeset，僅 Engineering Memory，與本份快照同一 commit 一起送出） |
| Production | DEPLOYED（依本輪封版令回報：Production `/version`=V2.4.15、model顯示為Qwen，2026-09-04 17:01:54 +08部署，第一批4筆AI呼叫皆成功） |
| Production Verification | 依本輪封版令回報：LIVE_RUNTIME_VERIFIED=YES、SMOKE_TEST=PASS。`PRODUCTION_COMMIT_VERIFICATION=VERIFIED`（2026-09-07，BUILD_METADATA_GENERATION_BUG已解決，見下方Known Blocker與07_KNOWN_ISSUES_02.md）：2026-09-07 12:07部署狀態，`/version`回報deployedCommit=784c79d6c56d71ddefe51cdb552a2353b02e52a5、branch=main、buildTime=2026-09-07T04:07:40.372Z；後續每次部署自動更新，`/version`即為即時查詢入口 |
| Current Phase | Production｜PBS-ONLY + 重大事故限定 LINE Push（維持不變）＋ TDX Freeway/Highway RoadEvent 走統一 Queue/AI/Memory pipeline，TDX 正式 LINE 通知維持開啟（PHASE_E_TDX_NOTIFY_LIVE，本輪未變動）。**V2.4.15已封版為SEALED_FOR_PRODUCTION_OBSERVATION**：PBS_AI_MODEL_ID=Qwen已上線，ROOT_CAUSE_FIX_CONFIRMED=YES（首批4筆0逾時），24H_VALIDATION=PENDING。本輪治理封版令本身不改任何Runtime。 |
| Current Task | none。Latest completed task = 路況-068（依路況-067查證，查修頁AI區塊固定顯示sameIncident/materialChange欄位，V2.8.2 Runtime變更：`aiObservatoryView.js`的`renderDetail()`與`buildDetailPlainText()`皆新增這兩個既有欄位的三態渲染，`renderField()`既有null→`—`fallback沿用、未新增顯示輔助函式）。CURRENT_RUNTIME_PHASE 仍 PHASE_E_TDX_NOTIFY_LIVE，本輪僅動`aiObservatoryView.js`一個檔案，未動`sameIncident`/`materialChange`本身的計算或判斷方式、V2.7.0推播攔截邏輯（`debugPush.js`）、任何KV讀寫。V2.8.1及更早版本封版規則對其本身仍有效（不得再改已封版記錄）；V2.8.2為新版本線延續，不受該封版令限制。待驗證：真實Production發生同一事故二次通報（V2.7.0攔截情境）時這兩欄位的實際顯示效果，詳見07_KNOWN_ISSUES_04.md。 |
| Latest Completed Version | V2.8.2 |
| Known Blocker | ~~GOOGLE_DRIVE_SYNC_BLOCKED_FOR_NEW_FILES~~ **已決議退休（2026-09-07）**——Drive鏡像workflow（`.github/workflows/sync-engineering-memory.yml`）已停用push觸發，GitHub上的engineering-memory/為唯一正本，不再列為blocker，詳見07_KNOWN_ISSUES_02.md ＋ ~~BUILD_METADATA_GENERATION_BUG~~ **已解決（2026-09-07，路況-018/019）**——Cloudflare Deploy command已由`npx wrangler deploy`改為`npm run deploy`，predeploy正確執行，`/version`現正確回報真實deployedCommit，詳見07_KNOWN_ISSUES_02.md ＋ ~~STALE_MEETING_ROOM_EXPORT~~ **已處置完成（2026-09-07）**——`meeting-room-export/`自V2.4.4停更11個版本，已加註警告＋AGENTS.md入口改指向本目錄＋`_history/`已搬遷保存至`_history_archive/`＋產生腳本`export-meeting-room.mjs`已加早退防護（預設拋錯，`ALLOW_STALE_EXPORT=1`可解除，刻意保留的逃生門）＋新增README說明，目錄與檔案皆未刪除，詳見07_KNOWN_ISSUES_02.md ＋ ~~PBS_RELAY_NO_OUTAGE_ALERTING~~ **已處置（2026-09-07）**——已建立HealthWatchdog排程（本機跳視窗警告，30分鐘輪詢health端點），正常路徑已驗證；`WATCHDOG_ALERT_PATH_UNVERIFIED`（異常路徑尚未實測跳窗）；限制：僅真人在電腦前/遠端連線時才看得到警告，長時間離機仍可能延遲察覺，詳見07_KNOWN_ISSUES_02.md ＋ **PBS_TOKEN_NO_GIT_BACKUP**（部分處置，2026-09-07）：`.pbs-token-test`已於本機建立副本（`_pbs_credentials_backup/`），但同機同碟，異地備份仍未完成，不得視為已解決，詳見07_KNOWN_ISSUES_03.md ＋ ~~PBS_RELAY_OLD_UNTRACKED~~ **已處置（2026-09-07）**：`pbs-relay-old/`已搬至`_old_backups/`，詳見07_KNOWN_ISSUES_03.md。另沿用 V2.4.5 封版的 REAL_WORLD_CONFIRMATION_PENDING（TDX正式LINE通知現場觀察） |
| Real-world Confirmation | **`24H_VALIDATION=PASS`／`FINAL_STATUS=SEALED_AND_VALIDATED`（2026-09-07，依唯讀Dashboard查證）**：2026-09-04 17:01～2026-09-07 10:00，165次AI呼叫，`AI_TIMEOUT_RATE=0.0%`（目標<5%）、P50=4,670ms／P95=8,556ms（目標<6s／<10s）、Queue Read/Write Ratio=1.00、PROCESSING_FAILED=0，四項皆達標。誠實揭露：驗收窗口曾受文件commit觸發之重新部署干擾（程式碼未變）；KV每日寫入下降僅第二天（9/6）明顯成立，第一天（9/5）仍在基準區間內。完整數據與統計方法揭露見07_KNOWN_ISSUES_02.md |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | ~~①滿24小時Production observation~~ **已完成（2026-09-07，見上方Real-world Confirmation）**。~~②BUILD_METADATA修法待定案~~ **已完成（2026-09-07，路況-018/019）**：Deploy command已改為`npm run deploy`，詳見07_KNOWN_ISSUES_02.md。現行待辦：③禁止直接修改已封版V2.4.15，新問題一律開V2.4.16；~~④下次重開機後驗證LocalMonitor／Relay電源設定修正是否讓兩者自動啟動~~ **已驗證有效（2026-09-07）**：重開機後Relay health=ok、Notify/HealthWatchdog LastTaskResult=0、LocalMonitor 2147946720為常駐模式預期狀態碼；8/31根因仍未查明，本次僅證明修正後設定於正常重開機情境運作正常，詳見07_KNOWN_ISSUES_02.md；⑤Build watch paths Exclude設定**已確認生效（2026-09-07）**：commit 296964b純engineering-memory/變更push後未觸發部署，Active deployment與Version History皆無變化，真人於Dashboard目視確認，詳見07_KNOWN_ISSUES_02.md；⑥本機工作目錄是否切換至main**仍未定案**（不得視為已解決或建議立即執行）：已知障礙（pbs-relay核心檔案、health-watchdog.ps1）皆已併入main解除，但切換仍會大幅改寫磁碟（新增209／取代199檔案），需充裕時間驗證後再行，詳見07_KNOWN_ISSUES_03.md；⑦**V2.4.16 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.4.16已SEALED狀態）**：(a)下一則國道非事故通報是否實際附上CCTV圖片——尚未取得；(b)出圖量實際增加幅度——尚未取得；(c)`run-budget-exhausted`發生率是否上升——尚未取得；(d)LINE每月200則額度實際消耗變化——尚未取得，真人將自LINE官方後台核實。發現問題一律開V2.4.17，不回頭改V2.4.16，詳見07_KNOWN_ISSUES_03.md；⑧**V2.4.17 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.4.17已SEALED狀態）**：下一則國道CCTV通報，若使用者延遲數小時才開啟LINE聊天視窗查看，圖片是否仍可正常顯示（24小時TTL的真實有效性驗證）——尚未取得。另有三項可觀測性缺口待辦（另案，本輪未處理）：(a)`r2ReadbackElapsedMs`未寫入Pipeline Trace、(b)主推播路徑無CCTV診斷console.log、(c)Workers Logs遮罩image id無法反查完整URL。發現問題一律開V2.4.18，不回頭改V2.4.17，詳見07_KNOWN_ISSUES_03.md；⑨**V2.4.18 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.4.18已SEALED狀態）**：下一則非accident類型（construction／closure／control／congestion／other）的國道通報，是否確實取得CCTV圖片——尚未取得，這是路況-038最初觸發事件（`type:'other'`故障車告警）同類事件本次修法後應能解決的問題，需上線後實際核對。發現問題一律開V2.4.19，不回頭改V2.4.18，詳見07_KNOWN_ISSUES_03.md；⑩**V2.5.0 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.5.0已SEALED狀態）**：真人自己的Telegram頻道是否確實收到與LINE同步的通知，含CCTV圖片情境（`sendPhoto`是否正確顯示圖片）——尚未取得。已知一項就緒層級（非發送層級）耦合：`LINE_CHANNEL_ACCESS_TOKEN`缺失或subscriptions/notified-state KV讀取失敗時電報也不會發送，現行Production此耦合為隱性，詳見07_KNOWN_ISSUES_03.md。發現問題一律開V2.5.1，不回頭改V2.5.0；⑪**V2.5.1 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.5.1已SEALED狀態）**：查修頁上新增的5個CCTV診斷欄位（imageUrl／imageExpiresAt／cctvSkippedByReason／imageStrategy／r2ReadbackElapsedMs），在真實Production事件（尤其成功組出CCTV圖片的情境）下的實際顯示效果——尚未取得。已知限制重申：這5個欄位與既有`imageUrlPresent`同存在同一筆Observatory index KV記錄，48小時TTL到期後一併消失，未解決（屬路況-046定義的「程度C」範圍，不在本輪授權內），詳見07_KNOWN_ISSUES_03.md。發現問題一律開下一個PATCH版本，不回頭改V2.5.1；⑫**V2.6.0 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.6.0已SEALED狀態）**：真實Production事件下，LINE與電報兩條獨立路徑各自的就緒/發送狀態、查修頁新增的Telegram小節與徽章顯示、修正後`lineSent`欄位的實際準確性——尚未取得。~~**規劃外發現，本輪未處理**：`aiObservatoryIndex.js`的`deriveFinalDecisionReason()`（收合卡片SENT/NOT_SENT判斷）目前只檢查`record.lineSent`，未檢查`record.telegramSent`~~ **已於路況-056（V2.6.1）修正**，詳見下方⑬。**KV操作次數提醒**：notified-state per-event操作由1get+1put變為最多2get+2put（電報已配置時），已依現有實測量級（約61-200次/日增量）評估合理，惟精確金額因費率記錄缺失無法給出，詳見07_KNOWN_ISSUES_03.md。發現問題一律開下一個版本，不回頭改V2.6.0；⑬**V2.6.1 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.6.1已SEALED狀態）**：真實Production事件下，收合卡片SENT摘要文字在「僅LINE成功」／「僅電報成功」／「兩者皆成功」三種組合下的實際顯示效果——尚未取得。發現問題一律開下一個版本，不回頭改V2.6.1；⑭**V2.7.0 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.7.0已SEALED狀態）**：下一則同一事故的無實質變化更新，是否確實被新閘門正確攔截——尚未取得；10分鐘collision window在AI核准路徑上實際觸發率下降的現場驗證——尚未取得；查修頁`memoryContextFingerprint` join修正後，真實Production事件（尤其`memoryCandidateCount>0`者）的AI決策理由/信心度是否確實正確顯示——尚未取得。發現問題一律開下一個版本，不回頭改V2.7.0；⑮**V2.8.0 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.8.0已SEALED狀態）**：07:00開始後第一則TDX/PBS事件是否確實被正確抓取與推播——尚未取得；22:30邊界是否正確生效（22:30仍推播、22:31起停止）——尚未取得；查修頁新增的「通知時段外」專屬理由文字，在真實Production因非播報時段而抑制的事件上是否確實正確顯示——尚未取得。發現問題一律開下一個版本，不回頭改V2.8.0；⑯**V2.8.1 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.8.1已SEALED狀態）**：查修頁新增的一鍵全選文字容器，在真實手機瀏覽器（iOS Safari長按選單／Android Chrome）點選後的實際全選/複製體驗——尚未取得；真人是否確認此功能確實達成「出錯時方便直接貼給會議室」的原始需求——尚未取得。發現問題一律開下一個版本，不回頭改V2.8.1；⑰**V2.8.2 待現場觀察事項（觀察記錄，非封版阻擋項——尚未觀察不影響V2.8.2已SEALED狀態）**：真實Production發生同一事故二次通報（V2.7.0攔截情境）時，查修頁AI區塊新增的`sameIncident`/`materialChange`兩欄位實際顯示效果，是否確實讓真人不再需要翻Cloudflare Dashboard KV原始資料——尚未取得。發現問題一律開下一個版本，不回頭改V2.8.2 |
| Export Generated At | 2026-09-04T17:30:00.000Z |
| Export artifact commit | uncommitted-at-generation-time (resolved by git history, never self-referenced) |

## 歷次封版與修正紀錄已移至工程記憶其他文件（2026-09-07 精簡）

本檔原有的逐版封版／修正紀錄（V1.9.9～V2.4.15，共 25 段）因與其他文件重複、且此檔案接近單檔容量上限，已於路況-037 移除。**移除的是重複的敘述，原始內容完整保留**，查閱方式：

- 逐版決策、根因、測試數字 → `07_KNOWN_ISSUES.md`（Volume 01）／`07_KNOWN_ISSUES_02.md`（Volume 02）／`07_KNOWN_ISSUES_03.md`（Volume 03）／`07_KNOWN_ISSUES_04.md`（Volume 04，CURRENT）
- 版本線與 commit 對照 → `06_VERSION_HISTORY.md`
- 接班敘事與設計脈絡 → `02_PROJECT_HANDOFF.md`
- 架構與成本細節 → `03_ARCHITECTURE.md`
- 精簡過程本身的查證與清單 → `07_KNOWN_ISSUES_03.md`「治理紀錄｜00_CURRENT_STATE.md 精簡」

仍具現行參考價值（非單純歷史記述）的架構事實保留於下方「現行 PBS 資料流架構」一節。

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

## 現行 PBS 資料流架構（自 V1.9.8 起 ACTIVE）

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

### 現行架構關鍵機制｜TDX 通知閘門（原載於 V2.4.0 封版紀錄，具現行參考價值，移至此處保留；原文照錄）

- **`LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT`**：
  `scheduled.js` 的 `broadcastEvents` 不再包含 `summary.allEvents`（TDX
  自己抓到的事件），即使單獨打開 `TDX_ROADEVENT_FETCH_ENABLED` 也無法讓
  TDX 事件回到舊 V1.5 硬規則 LINE 路徑
- Phase B 閘門硬寫死在單一呼叫點（`debugPush.js`：
  `suppressLineNotify = source === 'freeway' || source === 'highway'`），
  非任何 `wrangler.jsonc` 變數控制——要進 Phase C（TDX 真正推播 LINE）
  需要未來一次明確的程式碼變更，絕非改設定值就能達成

V2.4.0 封版紀錄的其餘內容（架構階段背景、Recent Incident Memory、AI schema 變更、測試數字等）已移除，完整原文見 `07_KNOWN_ISSUES.md`／`03_ARCHITECTURE.md`。

## 我能改什麼／不能改什麼（一句話版）

- **能改**：`traffic-reporter` repo 內，自己 Authority Boundary 內的程式、測試、文件、feature branch。
- **不能改**：雙鐵 / rail-traffic-consumer / rail-line-gateway 任何檔案、Cloudflare Dashboard、任何 repo 以外資產（除非有明確、針對該任務的額外授權）。
- **唯讀查證邊界**：跨部門資產（不論唯讀或寫入）一律先問真人——見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。

## 何時要找真人（最短版）

需要互動式登入/OAuth、需要 Credential、需要修改雙鐵 repo、需要破壞性 Production 操作（force push / 大量刪除 KV·R2 / rollback）、涉及跨部門 Contract Breaking Change、或證據顯示需要真人做產品決策時——才停下來問。一般程式錯誤/測試失敗/單一 repo 內查修，自行處理。

## 這份檔案之外，還想知道更多才讀

架構細節 → `03_ARCHITECTURE.md`　設計理由 → `04_PRODUCT_DECISIONS.md`　版本線 → `06_VERSION_HISTORY.md`　已知問題 → `07_KNOWN_ISSUES.md`　治理規則全文 → `01_FOUR_DEPARTMENT_GOVERNANCE.md`　接班摘要 → `02_PROJECT_HANDOFF.md`　完整工程歷史 → Repo `PROJECT_HANDOFF.md`（雲端分段見 `_history/`）
