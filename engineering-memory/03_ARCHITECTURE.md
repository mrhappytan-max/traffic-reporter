<!-- title: 路況播報員 Architecture -->

# 03. Architecture（以目前程式碼為準）

本檔案以 `src/` 實際模組結構整理，非憑記憶重寫。模組清單於 export 產生時由腳本重新掃描 `src/` 目錄核對（見本檔末尾「模組清單（自動掃描）」），若與下方敘述不符，以自動掃描結果與程式碼本身為準,並視為文件 Drift。

## 主要資料流（Pipeline）

```
TDX（國道/省道 RoadEvent）+ PBS（公路總局）
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

## 模組清單（自動掃描）

- **src/./**: index.js, version.js
- **src/cctv/**: bitmapFont.js, collage.js, dynamicCollage.js, freewayCctvMetadataCache.js, jpegCodecWorker.js, publishedImage.js
- **src/cctv/generated/**: cjkGlyphRaster.js
- **src/generated/**: buildMetadata.js
- **src/line/**: broadcastIntent.js, pushMessage.js, replyMessage.js, verifySignature.js, webhook.js
- **src/pbs/**: classify.js, client.js, crossSourceDedup.js, debugPbs.js, hsinchuFilter.js, lifecycle.js, normalize.js, pbsConfig.js, pipeline.js, roadName.js, vpcProbe.js
- **src/security/**: adminAuth.js
- **src/tdx/**: auth.js, cctvProbe.js, classify.js, client.js, debug.js, extract.js, fetchAll.js, hsinchuCctvProbe.js, normalize.js, sources.js, usageLedger.js, vdSpeed.js
- **src/traffic/**: anomalyClassification.js, broadcastHours.js, broadcastPipeline.js, broadcastPolicy.js, broadcastProvenance.js, broadcastRules.js, congestionCluster.js, congestionSeverity.js, congestionValidation.js, debugStatus.js, dedupe.js, deploymentStatus.js, deploymentStatusView.js, directionEquivalence.js, dynamicShoulderClassification.js, effectiveWindow.js, health.js, healthSnapshot.js, hsinchuConfig.js, hsinchuFilter.js, incidentSuppression.js, kmLocationResolver.js, locationQuality.js, messageFormat.js, notified.js, parseChineseDate.js, pipeline.js, pipelineTrace.js, pipelineTraceView.js, roadIdentity.js, roadSectionLabel.js, scheduled.js, serviceArea.js, sharedFeed.js, sharedFeedHandler.js, sourceMode.js, subscriptions.js, tdxEventCache.js, tdxSchedule.js
- **src/util/**: contentEqual.js
