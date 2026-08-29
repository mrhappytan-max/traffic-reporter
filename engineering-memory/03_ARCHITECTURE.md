<!-- title: 路況播報員 Architecture -->

# 03. Architecture（以目前程式碼為準）

本檔案以 `src/` 實際模組結構整理，非憑記憶重寫。模組清單於 export 產生時由腳本重新掃描 `src/` 目錄核對（見本檔末尾「模組清單（自動掃描）」），若與下方敘述不符，以自動掃描結果與程式碼本身為準,並視為文件 Drift。

## V2.1.0 — 四層架構角色邊界 ＋ Transport Ack Decoupled From Business Processing（本輪，2026-08-29）

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

**11. AI model 是哪一個？** `@cf/zai-org/glm-4.7-flash`，固定，見下方「Cloudflare Workers AI 帳號設定」。

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
- **src/pbs/**: aiCandidate.js, aiConfig.js, aiDecisionCache.js, aiDecisionEngine.js, aiObservatoryIndex.js, aiObservatoryView.js, classify.js, client.js, crossSourceDedup.js, debugPbs.js, debugPush.js, debugPushAuth.js, hsinchuFilter.js, lifecycle.js, normalize.js, pbsConfig.js, pipeline.js, roadName.js, vpcProbe.js
- **src/security/**: adminAuth.js
- **src/tdx/**: auth.js, cctvProbe.js, classify.js, client.js, debug.js, extract.js, fetchAll.js, hsinchuCctvProbe.js, normalize.js, sources.js, usageLedger.js, vdSpeed.js
- **src/traffic/**: aiApprovedPbsBroadcast.js, anomalyClassification.js, broadcastHours.js, broadcastPipeline.js, broadcastPolicy.js, broadcastProvenance.js, broadcastRules.js, congestionCluster.js, congestionSeverity.js, congestionValidation.js, debugStatus.js, dedupe.js, deploymentStatus.js, deploymentStatusView.js, directionEquivalence.js, dynamicShoulderClassification.js, effectiveWindow.js, health.js, healthSnapshot.js, hsinchuConfig.js, hsinchuFilter.js, incidentSuppression.js, kmLocationResolver.js, locationQuality.js, messageFormat.js, notified.js, parseChineseDate.js, pbsSchedule.js, pipeline.js, pipelineTrace.js, pipelineTraceView.js, roadIdentity.js, roadSectionLabel.js, scheduled.js, serviceArea.js, sharedFeed.js, sharedFeedHandler.js, sourceMode.js, subscriptions.js, tdxEventCache.js, tdxSchedule.js
- **src/util/**: contentEqual.js
