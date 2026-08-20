# 路況播報員 traffic-reporter

Cloudflare Worker 專案骨架（bootstrap 版本）。

## 目前功能

`GET /` 回傳：

```json
{
  "service": "traffic-reporter",
  "status": "ok",
  "version": "v1-bootstrap"
}
```

## 開發

```bash
npm install
npm run dev
```

## 部署

```bash
npm run deploy
```

（等同 `npx wrangler deploy`）

## 專案狀態

這是最小可部署骨架，尚未串接：

- TDX
- KV / D1
- Cron
- LINE Bot
- 語音播報

後續架構規劃：

```
TDX → Cloudflare Cron (每 5 分鐘) → 整理／去重 → Cloudflare 共用快取 → 路況播報員讀取
```

## Road location data maintenance（KM Location Resolver，V1.8.6.5）

`src/traffic/kmLocationResolver.js` 把事件的 KM 轉成司機看得懂的地點（省道：縣市/鄉鎮/村里；國道：前後交流道／服務區）＋ Google Maps 連結，資料完全來自官方開放資料，**Worker 執行時 0 次網路呼叫**——所有資料在部署前就已編譯進 `data/road-location/generated/*.js`。

若官方資料集（data.gov.tw 7040 / 95016 / 166496 / 8161）有更新，更新流程：

1. 取得新的官方原始檔，放進 `data/road-location/raw/provincial/`（省道，需符合 `data/road-location/raw/README.md` 記載的真實欄位格式）或 `data/road-location/archive/`（國道，見 `scripts/prepareFreewayRawFromArchive.py`）。
2. 若是國道資料，先執行 `python3 scripts/prepareFreewayRawFromArchive.py`，把 archive 正規化進 `data/road-location/raw/freeway/{milestones,facilities}/`。
3. 執行：
   ```bash
   npm run update:road-location-data
   ```
   這會驗證欄位、正規化路名、去重、產生 `data/road-location/generated/{provincial,freeway,freewayFacilities}.js`。任何欄位缺漏或格式錯誤會直接失敗（non-zero exit），**不會**留下部分寫入或損毀的舊檔。
4. 重新量測 bundle 大小：`npx wrangler deploy --dry-run`（見 `ENGINEERING_STATUS.md`「Watch items」）。
5. 跑相關測試：`node --test test/roadIdentity.test.js test/kmLocationResolver.test.js test/kmLocationMessageIntegration.test.js test/broadcastProvenanceKmLocation.test.js test/updateRoadLocationData.test.js`。

詳細架構、resolver 優先序、fail-closed 設計、決策理由，見 `PROJECT_HANDOFF.md` §21 與 `PRODUCT_DECISIONS.md`。

## V57｜Shared Traffic Feed（read-only，供其他專案消費）

`traffic-reporter` 是路況資料的**唯一 Producer**。V57 新增一個唯讀端點，讓其他專案
（目前是「雙鐵進站小幫手」的 `rail-traffic-consumer`）直接取用本專案**已完成的播報成品**，
不需要自己去抓 TDX / PBS / freeway.gov.tw / CCTV，也不需要重新合成四宮格。

```
GET /internal/shared-feed?windowMinutes=90&limit=50
Authorization: Bearer <TRAFFIC_FEED_SECRET>
```

傳輸方式為 **Cloudflare Service Binding（HTTP-style fetch）**，
消費端以 `env.TRAFFIC_FEED.fetch(...)` 呼叫；**不是 WorkerEntrypoint RPC**。
因此本 handler 只是一個普通的 `Request -> Response` 函式。

此路由**刻意不在 `ADMIN_PATHS`**：它是機器對機器的呼叫，Admin Basic Auth 對這個
呼叫端是錯的憑證。它改用自己的 Bearer token；`TRAFFIC_FEED_SECRET` 未設定時回 503，
不會變成匿名開放。

回應（schemaVersion = 1）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-19T06:00:00.000Z",
  "snapshotUpdatedAt": "2026-08-19T05:55:00.000Z",
  "windowMinutes": 90,
  "total": 3,
  "truncated": false,
  "events": [
    {
      "eventId": "freeway:FRW-1",
      "fingerprint": "6f1a…",
      "text": "🚨 交通事故\n國道1號 北向\n…",
      "imageUrl": "https://traffic-reporter.mr-happytan.workers.dev/cctv/image/…",
      "imageExpiresAt": "2026-08-19T06:10:00.000Z",
      "createdAt": "2026-08-19T05:30:00.000Z",
      "updatedAt": "2026-08-19T05:55:00.000Z",
      "road": "國道1號",
      "type": "accident",
      "direction": "北向"
    }
  ]
}
```

### 硬性保證

- **讀取此端點不會觸發任何 upstream fetch**：資料一律來自 KV `traffic:shared-feed`，
  cache miss 就回空 feed，**絕不回頭抓 TDX / PBS / CCTV frame，也絕不合成 collage**。
- **CCTV 影像只被「記錄」，不會被「請求」**。`imageUrl` 只有在該次 Cron 的真實播報
  本來就合成並發布了一張圖時才會出現。Shared Feed 因此**增加 0 次 CCTV composition、
  0 次 freeway.gov.tw frame 抓取、0 次 CCTV metadata 讀取**。
- **GET only**：POST / PUT / DELETE / PATCH 一律回 405（附 `Allow: GET`）。消費端無法寫入。
- **欄位白名單**：只輸出上列欄位。raw TDX、raw PBS、CMS 原文、CCTV 攝影機 metadata、
  內部 bookkeeping、`line:notified-state`、`line:subscriptions`、TDX 用量帳、
  健康快照、任何 Secret 都不會外流。
- **本專案原本的 LINE 主動播報完全不依賴 Shared Feed**。快照寫入是 Cron 的最後一個
  獨立步驟，失敗時只 log，不影響當次抓取、去重、播報、健康快照或用量帳。

### 為什麼消費 `completedProducts` 而不是自己重新過濾

本專案的「值不值得播報」是多道獨立閘門的乘積：型別／關鍵字資格
（`broadcastRules.js`）、60 分鐘關聯窗口（`effectiveWindow.js`）、壅塞叢集
（`congestionCluster.js`）、事故層級抑制（`incidentSuppression.js`）。
在 feed 這邊重新推導這條鏈只會複製它、然後默默地與它漂移——而往寬鬆方向漂移，
就等於別的專案播出了本專案刻意決定不播的東西。
所以 feed 直接鏡射 broadcast pipeline 自己的結論（`result.completedProducts`）。

`completedProducts` 在「本專案自己的訂閱者都已收到通知」時**仍然會記錄**，
因為消費端有自己的受眾與自己的投遞狀態——「這裡的人都已經知道了」不等於
「別人永遠不准知道」。

`completedProducts` 在以下三種狀態為空（本專案自己也沒有產出任何東西）：
dryRun、fail-closed、以及 08:00–22:00 Asia/Taipei 播報時段之外。

### 欄位語意（消費端契約）

| 欄位 | 語意 |
| --- | --- |
| `eventId` | `source:rawId`，與 `dedupe.js` 同一把 key，跨內容更新穩定（壅塞叢集的 composite rawId 同樣穩定） |
| `fingerprint` | `dedupe.js#computeFingerprint` 的 SHA-256 截斷值。**刻意排除 updatedAt**，時間戳變動不會改變它 |
| `updatedAt` | **不是 TDX 的 updatedAt**，而是「這個 fingerprint 首次成立的時間」。只在內容真的改變時前進，單調不倒退 |
| `createdAt` | 這個 `eventId` 首次進入 feed 的時間，內容更新時保持不變 |
| `text` | 已完成的 LINE 播報文字，與本專案送給自己訂閱者的內容一致。消費端不得重新組字 |
| `imageUrl` | 該次播報實際發布的 R2 四宮格公開網址，或 `null` |
| `imageExpiresAt` | 直接取自該 R2 物件 `customMetadata.expiresAt`（**不是重算的近似值**）。發布影像存活 `PUBLISHED_IMAGE_TTL_SECONDS`（15 分鐘），消費端在交給 LINE 之前必須自行檢查 |

### Retention

事件不再具播報關聯性後（或整段非播報時段完全沒有產出），既有項目仍保留 180 分鐘、
`updatedAt` 凍結不動，讓消費端的固定視窗讀取有穩定視野、不會漏掉只出現一個 tick 的事件；
因為 `updatedAt` 凍結，這類事件也會自然退出消費端的推播資格窗口。

### 需要的設定

- Cloudflare Secret：`TRAFFIC_FEED_SECRET`（未設定時端點回 503）
- KV：沿用既有 `TRAFFIC_KV`，只新增一把 key `traffic:shared-feed`（無 TTL，生命週期由 blob 內的 retention 規則管理）
- 不需要新增任何 binding、不需要更動 `wrangler.jsonc`
