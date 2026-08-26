<!-- title: 版本線 -->

# 06. Version History（重要版本線，非完整 git log）

只收錄目前仍具架構意義的版本節點。commit hash 以下方列出的實際 git 證據為準（`git log --oneline`，短 SHA），非人工回憶。完整逐 commit 歷史請直接查 `git log`，不在本文件重複。

| 版本 | commit（短 SHA） | 主題 |
|---|---|---|
| V1.8.6.5 | `76a4113`→`07253f9` | KM Location Resolver（公里數 → 司機看得懂的位置 + 地圖），含官方道路位置資料整合 |
| V1.8.6.6 | `d0012e1`, `0e8349f` | Production forensic audit：非碰撞異常事件不應被誤判為事故 |
| Pipeline Trace | `3858e0a` | V1.8.6.7：24h Pipeline Trace + 人工查修頁（本專案最重要的可觀測性基礎設施） |
| V1.8.6.8 | `462e217` | Driver-Relevant Event Broadcast Time Policy |
| V1.8.6.9 | `9af8d21` | Mobile-first Deployment Guard |
| V1.8.6.9a | `5724524`, `2ae6730` | Pipeline Trace Mobile UX — Taiwan time、封閉詞彙篩選、深色模式 |
| V1.8.7.0 | `54cb6c3` | Dynamic Shoulder Broadcast + Single-CCTV Strategy（動態路肩單鏡頭策略首次引入） |
| V1.8.7.1 | `a835493` | Multi-event Single CCTV Budget / Fairness Fix（每事件獨立預算，避免先到事件餓死後到事件） |
| V1.8.7.2 | `6c109a6` | Dynamic Shoulder Message Simplification |
| V1.8.7.3 | `fa8bf22`（原始）／`62cb229`（整合進 main 後版本） | CCTV Prepare-Timeout Fix + Pipeline Trace Filter Fix（分頁 bug 修復） |
| V1.8.7.4 | `7a8ec53` | 國3 CCTV Support Audit — 唯讀稽核，**未啟用**（當時無法從 dev sandbox 確認真實 RoadID/RoadName） |
| V1.8.7.5 | `be57f88` | Enable Freeway 3 CCTV Support — 用外部唯讀查證取得的真實 Production RoadID `'000030'`/RoadName `'國道3號'` 正式啟用國3 CCTV |
| V1.8.7.6 | `40b1409` | Pipeline Trace Filter Production Investigation — 三層reproduction 皆確認 server 端無缺陷，結論為 client-side 議題 |
| V1.8.7.7 | `a3d6609`（修復）／`8e10a7a`（封版紀錄） | CCTV Gray Broken Image Fix — `extractFirstJpegFrame` JPEG marker-aware 解析修復，見 `07_KNOWN_ISSUES.md`／`02_PROJECT_HANDOFF.md` §35 完整寫法 |
| V1.8.7.8 | `f5a339a` | **TDX Quota Protection — PBS-ONLY MODE（2026-08-23，生效中）** — TDX 額度用盡，以 `TRAFFIC_SOURCE_MODE=PBS_ONLY` 單一旗標關閉 Cron 路徑上所有 TDX 呼叫（RoadEvent／OAuth token／CCTV），PBS 完全不受影響。**未刪除任何 TDX 程式碼**，還原＝改回 `ALL` 並 push。見 `07_KNOWN_ISSUES.md` 的還原程序 |
| V1.8.7.9 | `21c1a42` | Accident-Only Proactive LINE Push ＋ CCTV 影像恢復 — 主動推播收斂為重大事故限定（`LINE_PUSH_POLICY=MAJOR_ACCIDENT_ONLY`），動態路肩主動推播關閉 |
| V1.8.7.10 | `fecb818` | PBS_ONLY 下不得要求 TDX 對應 — 停用中的 TDX 不得否決 PBS 國道事故（`TDX_CORROBORATION_REQUIRED=false`） |
| V1.8.7.11 | `fc43549` | Service Area Gate — 播報邊界地理閘門（八堵事件），PBS fail-closed、TDX 僅採正面證據 |
| V1.8.7.12 | `990237c` | Location Quality Gate ＋ 播報追溯斷點修復（台68 事件）— 位置精確度閘門，且已推播事件必定可在 Pipeline Trace 查到 |
| V1.8.7.13 | `678f0bb` | PBS 國道事故 CCTV Enrichment — CCTV 資格改依「道路＋KM 可信度」，不再要求 `source==='freeway'`（國3 96K+700 事件） |
| V1.8.7.14 | `951f547` | **CCTV 官方名冊恢復＋永久保存修正（國1 93K 事件）** — 移除名冊 7 天 `expirationTtl`、拒絕以空名冊覆寫、打包官方 NFB 名冊 1943 筆為地板。四段式版本線的**最後一版** |
| **V1.9.0** | `3af5c8b` | **三段式版本治理生效後第一個正式版本** — CCTV 事故（quad）prepare-timeout 可觀測性修復（國3 96K+700 事件，2026-08-26）。真人事故：09:20 事件進 Shared Feed、無圖，且完全沒有 CCTV completion log；同一事件 09:30（下一個 Cron tick）重跑即成功四格全中。確認的 Root Cause：quad 路徑完全沒有 stage 追蹤（動態路肩單鏡頭路徑早就有），因此任何一次真實的外部延遲（frame fetch／JPEG compose／R2 publish——三者皆已證實共用同一個 4000ms budget）在 timeoutStage 上一律顯示 `null`，等於什麼都沒記錄。修復：quad 路徑比照單鏡頭路徑加上 stageTracker，在成功／失敗／timeout 任何結果都留下 metadataElapsedMs／cameraSelectionElapsedMs／frameFetchElapsedMs／collageElapsedMs／successfulFrameCount／failedFrameCount／r2PublishElapsedMs／timeoutStage。**未新增任何 retry、未新增第二輪 fetch、未調整 4000ms 數字、未加 single-camera fallback**——RETRY_REQUIRED = NO。7 項新測試（`test/cctvQuadPrepareForensics.test.js`）以決定性方式證實：FRAME_FETCH_MODE=PARALLEL、單一慢/卡住的鏡頭會拖住整批 compose、compose 與 R2 publish 都算進同一個 budget、timeout 不會中止背景中的既有工作。09:20 當下具體是哪一段外部 I/O 慢，因為當時沒有 stage 級別紀錄，**已誠實列為無法從現有證據回溯**——這正是本次修復要根除的缺口，若再發生將完整可查。詳見 `07_KNOWN_ISSUES.md` 的完整修正紀錄 |
| **V1.9.1** | `917b8ab` | **Pipeline Trace 查修頁篩選失效修正＋預設 60 筆（2026-08-26）** — 真人回報：`/admin/pipeline-trace-view` 篩選（來源／關鍵字／道路／rawId／狀態／筆數）點了「篩選」畫面不動。確認的 Root Cause（以真實瀏覽器重現，非猜測）：`applyAdminSecurityHeaders` 的 CSP 帶 `form-action 'none'`，任何有強制 CSP 的瀏覽器（含真人回報所用的 iOS Safari）都會**完全拒絕**這個頁面（乃至任何 admin 頁面）的 `<form>` 送出——伺服器端的篩選邏輯（表單參數、`listPipelineTrace` 的 predicate、分頁）在前一輪（V1.8.7.6）就已被完整查證過是對的；那一輪自己的 headless 瀏覽器重現「不在本 repo 的自動化測試套件內」，顯然從未真正對著這個 Worker 自己的安全標頭送出過請求。本輪用真的 Chromium 對著真的回應（含真的標頭）重現：點下「篩選」按鈕，畫面完全不導頁，瀏覽器主控台明確寫著「Refused to send form data ... because it violates ... form-action 'none'」；只改這一個指令為 `form-action 'self'`（其餘 CSP 完全不動），同一個點擊就能正確導頁到篩選後的網址。**採方案 A**：修好既有篩選功能，UI 保留，未移除任何篩選欄位。同時 `DEFAULT_LIST_LIMIT` 30→60（`MAX_LIST_LIMIT`／`MAX_ENTRIES_SCANNED` 掃描安全上限不變）。詳見 `07_KNOWN_ISSUES.md` 的完整修正紀錄 |
| **V1.9.2** | `f45cd5e` | **Cloudflare KV Write Optimization ＋ TDX Usage Summary 正式退休（2026-08-26）** — 真實 Cloudflare 帳號告警：Writes 749/1,000（`traffic-reporter-kv` = 733，佔帳號總寫入量 97.9%）。四項變更：(1) `traffic:shared-feed`／`line:incident-suppression-state` 改為 WRITE_ON_CHANGE（新共用原語 `src/util/contentEqual.js`），內容真的不變才跳過寫入——施工中自己的測試抓到一個真實 aliasing bug（`resolveIncidentNotifications` 就地修改比對用的舊物件，導致比較永遠「相等」），已用 `structuredClone` 在呼叫前先拍快照修正；(2) Pipeline Trace 改為每輪一把 `debug:pipeline-trace-batch:v2:*` 批次金鑰，取代舊制一筆事件一把 key——舊制 `debug:pipeline-trace:v1:*` 完全不刪除不遷移、靠 24h TTL 自然過期，`listPipelineTrace` 已能正確合併新舊兩種схема，兩個既有 admin 讀取 handler 未改一行程式碼；(3) **TDX Usage Summary 正式退休**（人類決策，非優化）：`tdx:usage:summary:v1` 與底層 `tdx:usage:entry:v1:*` 帳本皆確認除了餵已退休的儀表板外無其他讀者，改為 0 writes/day，`/health` 的用量卡片改為指向 TDX 官方後台的靜態提示，TDX 本身（API client／OAuth／RoadEvent／CCTV metadata／source mode／9-1 額度恢復路徑）完全未動；(4) 新增 `[kv-write-budget]` Cron console.log（僅 Workers Logs，未新增 KV key）。新增 38 項測試（`test/kvWriteOptimization.test.js`）。詳見 `07_KNOWN_ISSUES.md` 的完整修正紀錄 |

## 版本線校正紀錄（PRODUCTION_VERSION_LINEAGE_RECONCILIATION，2026-08-25）

V1.8.7.8～V1.8.7.14 這七列是**補記**，不是新發布。七次變更早在補記之前就已 merge 進 `main`
並由 Cloudflare Workers Builds 自動部署；當時只寫了任務名稱、沒有配正式版本號。
本次校正只建立「版本號 ↔ 既有 commit ↔ 既有部署」的對照，
**沒有 rebase、沒有 amend、沒有 force push、沒有改動任何歷史 commit，也沒有假裝任何歷史版本重新部署。**

同時發現一個比漏編號更嚴重的問題：**唯一權威來源 `src/version.js` 從 2026-08-21 的
V1.8.6.9 之後就沒再更新過**——也就是說整個 V1.8.7.x 系列（不只是 V1.8.7.7 之後）
`GET /version` 都在回報 V1.8.6.9。漂移的成因是有三個地方各自以為自己知道版本：

| 來源 | 當時的值 | 現在 |
|---|---|---|
| `src/version.js` → `GET /version`／`/admin/deployment-status` | `V1.8.6.9` | **唯一權威**，已校正為 `V1.8.7.14` |
| Engineering Memory export（掃 commit message 找 `V\d+\.\d+\.\d+`） | `V1.8.7.7` | 改讀 `src/version.js`，掃描結果降級為 drift 警告 |
| `ENGINEERING_STATUS.md` 人工標記 | 各自為政 | 僅供交叉檢查，不具權威 |

**從 commit message 掃出來的版本號，是沒有人負責的版本號**——有人剛好打了就會動，沒人打就停住。
`test/versionLineage.test.js` 七項測試鎖住的是這條規則的**形狀**（單一來源、其他一律衍生），
刻意不鎖當下的數字，否則只會多出第四個要同步的地方。

**永久規則**：任何進 Production 且改變 runtime 行為的變更，必須在同一個 commit 內 bump
`src/version.js` 的 `APP_VERSION`。任務名稱（`CCTV_METADATA_RECOVERY`、
`PBS_ACCIDENT_CCTV_ENRICHMENT_FIX` …）是工程標籤，**永遠不能取代版本號**。
純文件／治理／Drive sync 工具／測試整理不 bump 版本，但仍須有 commit。

## 版本編號格式切換｜三段式版本治理（2026-08-25 起生效）

四段式 `V1.8.7.x` 版本線於 **V1.8.7.14 正式停止（`LAST_FOUR_PART_VERSION`）**，
`FOUR_PART_VERSIONING = RETIRED`。自此起 `THREE_PART_VERSIONING = ACTIVE`，
下一個正式版本號是 **`V1.9.0`（`NEXT_RELEASE_VERSION`）**。

**`src/version.js` 目前仍是 `V1.8.7.14`，本次切換沒有提前 bump。**
只有下一次真正改變 Production runtime 行為的 release，才會在**同一個
commit 內**把 `APP_VERSION` 換成 `V1.9.0`——治理決議本身不觸發版本號變動、
不觸發 deploy。

三段式規則：

| 變更類型 | 動哪一段 | 例 |
|---|---|---|
| Bug fix | patch | `V1.9.0 → V1.9.1 → V1.9.2` |
| 明顯新功能／架構階段 | minor | `V1.9.x → V1.10.0` |
| 大型不相容版本 | major | `→ V2.0.0` |
| 純文件／治理／Engineering Memory／測試整理 | 不升版本 | 仍須有 commit |

V1.8.7.8～V1.8.7.14 這既有七列**不重寫**，四段式版本線就此封存於歷史。

## 版本線之外的重要里程碑

- **V57 系列**：Shared Traffic Feed 首次建立（`completedProducts` 持久化機制），V57.1（Shared-Feed-only CCTV top-up）、V57.3（分頁修復）陸續強化。詳見 `02_PROJECT_HANDOFF.md` §30。
- **四部門聯合治理**（2026-08-22）：非程式版本，但是本專案第一次正式治理框架定案，見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。
- **Meeting Room Export / Engineering Memory v1**（本輪）：本 export 系統本身的建立版本。

## 目前 main 最新狀態

Export 產生時的即時 git 狀態見 `SYSTEM_STATE.json`；此表格為人工整理的「重要節點」，不會每次 export 自動改寫——只在真的有新的架構意義版本產生時才手動追加一列。
