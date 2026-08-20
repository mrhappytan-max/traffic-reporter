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
