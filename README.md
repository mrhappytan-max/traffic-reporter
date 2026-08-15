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
