<!-- title: 路況播報員 Architecture -->

# 03. Architecture（以目前程式碼為準）

本檔案以 `src/` 實際模組結構整理，非憑記憶重寫。模組清單於 export 產生時由腳本重新掃描 `src/` 目錄核對（見本檔末尾「模組清單（自動掃描）」），若與下方敘述不符，以自動掃描結果與程式碼本身為準,並視為文件 Drift。

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
    ├─ false（正式環境目前狀態）→ 完全未修改的 legacy
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

詳見 `07_KNOWN_ISSUES.md` 的完整記錄。

## PBS Windows Local Edge Debug Push Integration（V1.9.6/V1.9.7 建立的基礎，Windows 端不變）

以下段落描述 Windows 本機那一半（服務區篩選／CLEARED 治理／持久冪等），**V1.9.8
完全未修改這部分**，只是把 Cloudflare 端接收後「只 ACK/log」的行為升級為上方的
正式 Business Pipeline。Windows 端程式碼在 `pbs-relay/`（`src/` 掃描結果——下方
模組清單——不會出現它）**自 V1.9.9 Phase 1 起已直接 commit 進 main**（見上方，
不再是未合併的 feature branch）；Cloudflare 端接收端在 `src/pbs/debugPush.js`／
`src/pbs/debugPushAuth.js`（V1.9.5，已在 `src/` 下，會出現在下方模組清單）。
以下段落記錄的「`feature/pbs-local-edge-filter-prototype` 分支、118/118 測試」
是 V1.9.6 當時的歷史事實（該分支後續已併入 main，見上方 Phase 1）；Windows 端的
**執行期狀態**（Task Scheduler 是否真的常駐、真實 PBS Push 觀察紀錄、Cloudflare
Secret 是否確實生效等）無法從這個 sandbox 獨立驗證，以下按真人回報記錄，不冒充
為本 Session 自行證實：

```
PBS 警廣官方來源
    ↓
Windows 本機每 3 分鐘抓取（localMonitor.js，Task Scheduler 常駐，見下方治理段落）
    ↓
Local Edge Filter（localPrototype.js）
    ↓
Production Service Area Rule（見下方「服務區治理修正」——**現重用**
    src/pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant、
    src/pbs/roadName.js#normalizePbsRoad，不再是舊版自己的寬鬆矩形）
    ↓
事件生命週期比較（localState.js，主鍵 PBS UID，見下方「CLEARED 治理修正」）
    ↓
NEW / UPDATED / CLEARED / UNCHANGED / MISSING_PENDING_CLEAR
    ↓
SHOULD_PUSH 判斷（localDebugPush.js；只有 NEW/UPDATED/CLEARED 三種 lifecycle
    才可能送出，UNCHANGED／MISSING_PENDING_CLEAR／baseline 一律不送）
    ↓
若 SHOULD_PUSH=NO
    → 完全停在 Windows，不呼叫 Cloudflare（0 次 request）
若 SHOULD_PUSH=YES
    ↓
Windows Debug Push Client（debugPushClient.js）
    ↓
POST /internal/pbs-debug-push
    ↓
Cloudflare src/pbs/debugPush.js（V1.9.5 建立，V1.9.8 起是正式 Production Ingress——
    見上方新版流程圖，Authentication/Validation/持久冪等之後接正式 Business Pipeline，
    不再只是 Workers Logs → ACK）
```

### 服務區治理修正（真實踩過的誤收 bug）

舊版 Prototype 自己的服務區輔助判斷用一個寬鬆矩形（`lat 24.45~24.95 / lng
120.80~121.35`）就可以單獨 INCLUDE 一筆事件，真實造成**國3 55.8K 鶯歌**、**國1
68.1K 楊梅**被誤收（兩者都在矩形內但完全不是新竹服務區）。現已修正：本機
`localPrototype.js` **直接 import 並重用 Production 自己的服務區/新竹篩選規則**
（`src/pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant`、
`src/pbs/roadName.js#normalizePbsRoad`——本 Cloud Session 讀取該 commit 的
`pbs-relay/src/localPrototype.js` 原始碼確認這兩個 import 確實存在，非僅依真人
描述），舊矩形不再能單獨 INCLUDE 任何事件。真人回報的驗證結果：鶯歌 55.8K =
EXCLUDE、楊梅 68.1K = EXCLUDE、竹北 91.9K = INCLUDE、台68 9K = INCLUDE。

### CLEARED 防誤判治理（二輪確認，本 Session 已讀程式碼確認邏輯存在）

舊版「這一輪 fetch 成功但看不到這個 UID 就立刻 CLEARED」的設計已證實會誤判。現行
規則（`pbs-relay/src/localPrototype.js`，本 Cloud Session 直接讀取該 commit 原始碼
確認）：**明確解除文字**（`已排除`／`排除`／`已解除`／`解除` 四種 pattern）→ 立即
CLEARED；**單純從 feed 消失**（absence-only）→ 需要**連續兩輪成功的 PBS fetch**
都看不到才確認：第一輪缺席記為 `MISSING_PENDING_CLEAR`（`missingCount=1`，
`CLEARED=0`，`SHOULD_PUSH=NO`），第二輪仍缺席才變成 `CONFIRMED_CLEARED`
（`missingCount>=2`，`CLEARED=1`，`SHOULD_PUSH=YES`）；若 fetch 本身失敗，
`missingCount` 不累加；若中途事件重新出現，pending clear 取消、`missingCount`
歸零。真人回報以真實案例（UID `11508260013-5`，國3 96.7K 寶山休息站）完成完整
fixture regression 驗證。

### Cloudflare 端持久冪等（V1.9.7，L1 記憶體 + L2 TRAFFIC_KV）

V1.9.5 的冪等只有 per-isolate 記憶體 Map，isolate 回收／Worker 重啟／redeploy 都可能
讓同一事件重新被 accept。V1.9.7（`src/pbs/debugPush.js`）新增持久 L2 層：

```
Windows Debug Push 抵達
    ↓
驗證 auth → 驗證 payload
    ↓
計算 stable idempotency key = SHA-256(source:eventId:lifecycle:fingerprint)
    ↓
L1 記憶體 Map 命中？
    ── 是 → duplicate=true（memoryHit，不查 KV）
    ── 否 ↓
L2 TRAFFIC_KV get（debug:pbs-push-idempotency:v1:<hash>，獨立 debug-only 前綴）
    ── 存在 → duplicate=true（persistentHit，不寫 KV）
    ── 不存在 → KV put（48h TTL）→ accepted=true
```

L1 僅是快速路徑（同 isolate 內短時間重試可跳過 KV 讀取），**非唯一真相**——L1 miss
一律再查 L2 才能決定是否 accept，故全新 isolate 的空 L1 仍能正確命中別的 isolate
寫入的 L2 紀錄。`KV_ONLY_ATOMICITY = NOT_SUFFICIENT`（KV 無 compare-and-swap，理論
極窄 race window仍存在），`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY = PARTIAL`（關閉了
主要風險，非 atomic exactly-once 保證——見 `07_KNOWN_ISSUES.md` 的完整分析，含為何
不引入 Durable Object）。KV outage 時 fail OPEN（事件仍 accepted）。duplicate 永遠
0 次額外 KV 寫入；僅真正首次的 idempotency key 花 1 次寫入，10/30/100 筆/日實測分別
+10/30/100 writes/day，`KV_WRITE_PRESSURE = LOW`。

### 已知限制、路線圖、Secret 治理教訓、Emergency kill switch

完整記錄於 `07_KNOWN_ISSUES.md`（機器可讀欄位 → `SYSTEM_STATE.json` 的
`pbsLocalEdgeFilterPrototype`）：Windows 常駐模式（Task Scheduler／watchdog／log
retention）、Cloudflare Secret binding 曾經歷的一次真實 503 事故與根因、六階段
路線圖（Phase 1 現行觀察、Phase 2 持久冪等設計【V1.9.7】、Phase 3-5 Business
Pipeline／LINE 正式啟用／Windows 成為主要來源、Phase 6 PBS 輪詢退休——**V1.9.8
一次性由正式施工令授權合併完成，非本 Session 自行提前推進**）、緊急停用方法
（Windows 端環境變數 `PBS_DEBUG_PUSH_ENABLED=false` + 重啟本機排程即可停止
Windows 推播；V1.9.8 起 Cloudflare 自身 PBS 輪詢已非 fallback，若需暫時恢復
PBS 資料流須改回 `PBS_30_MIN_POLLING_ENABLED=true` 並重新部署）。

## 模組清單（自動掃描）

- **src/./**: index.js, version.js
- **src/cctv/**: bitmapFont.js, collage.js, dynamicCollage.js, freewayCctvMetadataCache.js, jpegCodecWorker.js, publishedImage.js
- **src/cctv/generated/**: cjkGlyphRaster.js
- **src/generated/**: buildMetadata.js
- **src/line/**: broadcastIntent.js, pushMessage.js, replyMessage.js, verifySignature.js, webhook.js
- **src/pbs/**: aiCandidate.js, aiConfig.js, aiDecisionCache.js, aiDecisionEngine.js, classify.js, client.js, crossSourceDedup.js, debugPbs.js, debugPush.js, debugPushAuth.js, hsinchuFilter.js, lifecycle.js, normalize.js, pbsConfig.js, pipeline.js, roadName.js, vpcProbe.js
- **src/security/**: adminAuth.js
- **src/tdx/**: auth.js, cctvProbe.js, classify.js, client.js, debug.js, extract.js, fetchAll.js, hsinchuCctvProbe.js, normalize.js, sources.js, usageLedger.js, vdSpeed.js
- **src/traffic/**: aiApprovedPbsBroadcast.js, anomalyClassification.js, broadcastHours.js, broadcastPipeline.js, broadcastPolicy.js, broadcastProvenance.js, broadcastRules.js, congestionCluster.js, congestionSeverity.js, congestionValidation.js, debugStatus.js, dedupe.js, deploymentStatus.js, deploymentStatusView.js, directionEquivalence.js, dynamicShoulderClassification.js, effectiveWindow.js, health.js, healthSnapshot.js, hsinchuConfig.js, hsinchuFilter.js, incidentSuppression.js, kmLocationResolver.js, locationQuality.js, messageFormat.js, notified.js, parseChineseDate.js, pbsSchedule.js, pipeline.js, pipelineTrace.js, pipelineTraceView.js, roadIdentity.js, roadSectionLabel.js, scheduled.js, serviceArea.js, sharedFeed.js, sharedFeedHandler.js, sourceMode.js, subscriptions.js, tdxEventCache.js, tdxSchedule.js
- **src/util/**: contentEqual.js
