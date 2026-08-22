<!-- title: 跨專案邊界 -->

# 05. Cross-Project Boundary（路況 ↔ 雙鐵）

## 硬邊界（永久，非單一任務限定）

**這個 session/repo 永遠不修改消費端。** `hsinchu-thsr-line-bot`（雙鐵進站小幫手 / rail-traffic-consumer）及任何未來的 Shared Feed 消費端——它們的程式碼、Cloudflare Dashboard、LINE 頻道、Production 設定——對 `traffic-reporter` 這一側的任何工作都是 out of scope，永久有效，不是單一任務才適用。

消費端側若有問題，正確做法是：診斷 + 把證據交到 repo 邊界對面（Evidence Packet／Pipeline-Trace 式報告／可重現的最小案例／建議修法），**不是**由這個 session 動手伸進那個 repo 修。

## Producer / Consumer Authority

- **traffic-reporter 是 Shared Traffic Feed 唯一內容權威。** TDX/PBS 擷取、分類、播報資格、時間視窗規則、去重/壓抑、KM/方向/道路解析、訊息格式化、CCTV，全部在這裡決定。`completedProducts` 進入 feed 代表「已經判斷完成，可直接播報」。
- **消費端不需要、也不應該重新判斷這些內容。** 它的工作是可靠傳輸：讀 feed、完整分頁、把讀到的東西送出去。
- **Producer 永遠不建 consumer-specific 邏輯。** feed 保持通用：不做「這是不是雙鐵想要的」分支判斷、不做 consumer-subscription 感知、不做 per-consumer 白名單、不做 consumer 版本偵測。所有 `completedProducts` 對任何讀者都是同一份輸出。

## 傳輸介面（唯一對外接口）

`GET /internal/shared-feed`（`src/traffic/sharedFeedHandler.js`）——Service Binding 呼叫，Bearer Token 驗證（`TRAFFIC_FEED_SECRET`），非 Admin Basic Auth。唯讀，不觸發任何 TDX/PBS/CCTV 重新擷取或重新合成。KV storage outage 時誠實回 503（`feed_storage_unavailable`），consumer 應將任何非 200 視為「本輪跳過」，不得退回自行呼叫上游來源。

## 已知跨部門風險/教訓（供未來參考）

- **LINE 文字送出 ≠ Shared Feed 一定成功持久化。** `runSharedFeedPersist` 是 Cron run 最後一步，獨立 try/catch，失敗只 log，不回頭影響已完成的 LINE 推播——這是刻意的架構隔離（避免 Shared Feed 故障拖慢/擋住本 Worker 自己的播報），但也代表兩者結果可能不同步，需要各自查修時分開看待，不能假設「LINE 有播 = Shared Feed 一定有」。
- **V57.3 分頁修復案例**：曾發生消費端未完整分頁讀取 feed 導致漏收事件，這是消費端傳輸層的問題，不是 Producer 內容判斷錯誤——修復落在消費端側，Producer 側只需確保回應本身分頁語意正確。
- **Cross-Department Read Authority**：即使只是唯讀查看對方 Production 狀態（Cron/Version/Binding），也不因為「只是唯讀」而自動視為安全——判準是「資產是否屬於自己部門」，見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。

## 這份文件之外

完整 Shared Feed 欄位契約與設計理由 → `src/traffic/sharedFeed.js` module comment（原始碼本身即為 Source of Truth）；歷史事件 → `02_PROJECT_HANDOFF.md` §30。
