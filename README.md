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

## V57｜Shared Traffic Feed（read-only，供其他專案消費）

`traffic-reporter` 是路況資料的**唯一 Producer**。V57 新增一個唯讀端點，讓其他專案
（目前是「雙鐵進站小幫手」的 `rail-traffic-consumer`）能直接取用本專案**已完成的播報成品**，
而不需要自己去抓 TDX / PBS / CCTV。

```
GET /internal/shared-feed?windowMinutes=90&limit=50
Authorization: Bearer <TRAFFIC_FEED_SECRET>
```

傳輸方式為 **Cloudflare Service Binding（HTTP-style fetch）**，
消費端以 `env.TRAFFIC_FEED.fetch(...)` 呼叫；**不是 WorkerEntrypoint RPC**。
因此本 handler 只是一個普通的 `Request -> Response` 函式。

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
      "imageUrl": null,
      "imageExpiresAt": null,
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
  cache miss 就回空 feed，**絕不回頭抓 TDX / PBS / CCTV**。
- **GET only**：POST / PUT / DELETE / PATCH 一律回 405（附 `Allow: GET`）。消費端無法寫入。
- **欄位白名單**：只輸出上列欄位。raw TDX、raw PBS、CMS 原文、內部 bookkeeping、
  `line:notified-state`、`line:subscriptions`、任何 Secret 都不會外流。
- **本專案原本的 LINE 主動播報完全不依賴 Shared Feed**。快照寫入是 Cron 的最後一個獨立步驟，
  失敗時只 log，不影響當次抓取、去重或播報。

### 欄位語意（消費端契約）

| 欄位 | 語意 |
| --- | --- |
| `eventId` | `source:rawId`，與 `dedupe.js` 同一把 key，跨內容更新保持穩定 |
| `fingerprint` | `dedupe.js#computeFingerprint` 的 SHA-256 截斷值。**刻意排除 updatedAt**，時間戳變動不會改變它 |
| `updatedAt` | **不是 TDX 的 updatedAt**，而是「這個 fingerprint 首次成立的時間」。只在內容真的改變時前進，單調不倒退 |
| `createdAt` | 這個 `eventId` 首次進入 feed 的時間，內容更新時保持不變 |
| `text` | 已完成的 LINE 播報文字，與本專案送給自己訂閱者的內容一致。消費端不得重新組字 |
| `imageUrl` / `imageExpiresAt` | **v1 恆為 `null`** — 本專案目前沒有 CCTV / MJPEG / collage / R2 能力。欄位先預留，日後補上圖片時消費端不需改版 |

### Retention

事件從 TDX 消失後仍保留 180 分鐘，且 `updatedAt` 凍結不動，
讓消費端的固定視窗讀取有穩定視野、不會漏掉只出現一個 tick 的事件；
因為 `updatedAt` 凍結，這類事件也會自然退出消費端的推播資格窗口。

### 需要的設定

- Cloudflare Secret：`TRAFFIC_FEED_SECRET`（未設定時端點回 503，不會開放匿名存取）
- KV：沿用既有的 `TRAFFIC_KV`，只新增一把 key `traffic:shared-feed`（無 TTL，生命週期由 blob 內的 retention 規則管理）
