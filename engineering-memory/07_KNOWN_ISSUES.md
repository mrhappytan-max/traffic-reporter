<!-- title: 已知問題 -->

# 07. Known Issues

## 已知、無關、既有的測試失敗基準線

**最新實測基準（2026-09-03，V2.4.6 施工後 `git stash -u` 同 commit 重新量測，非回憶）：`npm test` 共 1758 項，穩定 32 項失敗（歷史演進：1339@V1.9.3→52@V2.4.5 geo-resolver 輪→32@V2.4.6，每輪失敗清單本身也隨技術債被個別修掉/測試檔改寫而變動，數字不可跨輪直接比較，只能同輪 stash 對照）。**

> **歷史演進摘要（V1.9.2/V1.9.3，深度壓縮）**：測試總數隨每輪新增測試持續成長
> （1272→1300→1339→……→現行 1758，見下方各版本壓縮摘要），35 項失敗基準本身
> 也隨技術債分類調整。**CCTV_METADATA_RECOVERY_V1（2026-08-25）教訓**：先前誤記
> 為 Workers-only `.wasm` 沙盒問題，實為 `@jsquash/jpeg` 未 `npm install`；裝好後
> 揭露約 36 項過期斷言（技術債，非回歸）。**教訓：合理但未經驗證的 Root Cause
> 會靜音真實訊號**——當時該做而沒做的一步只是 `npm install`。

目前 32 項的正確分類（每輪仍以同一輪 `git stash -u` 對照乾淨 checkout 驗證；`pbs-relay/tests/*` 已不在
`test/*.test.js` glob 範圍內，獨立子系統，不計入此數字）：

**過期斷言／timing-dependent 技術債（32 項，全部同一類）**— 分布於 `singleCctvBudgetFairness`、`dynamicShoulder`、
`dynamicShoulderMessageShort`、`dynamicCollage`、`broadcastCctvIntegration`、`cctvPrepareTimeoutStages`、
`freeway3CctvAudit`、`pipelineTraceIntegration`、`productionIntegrationFixtures`、`hsinchuCctvCollageEndpoint`、
`cctvImagePublish` 等檔——CCTV frame-latency／真實時間預算相依，非本輪任何一輪引入的回歸。
**這是本專案目前最大的一筆技術債，已列為 openFollowUp。**

若出現這 32 項以外的新失敗，才視為真正回歸。

**還有一項會時有時無的全套執行雜訊**（不是本專案缺陷、也不要為它改程式）：
`test/deploymentStatus.test.js` 的「missing/placeholder build metadata」在
**單獨執行時穩定通過 22/0**，只有在跑完整套件時偶爾出現，乾淨 checkout 也一樣。
本輪連續量測 4 次得到 38／38／38／39，多出來的那次就是它。
判斷回歸請以**同一輪 stash 對照**為準，不要只看單次總數。

**另有一個會自行復原、不要誤判成缺陷的情況**：
`test/deploymentPolicyAndVerify.test.js` 第 12 項比對 `origin/main`（見
`scripts/verify-production-deploy.mjs:120`）。本機 main 已 commit 但**尚未 push** 時，
它必然失敗；push 完成後自動恢復通過。這是「還沒推送」的狀態產物，不是程式缺陷，
**不要為它修改任何程式**。

## V1.8.7.7 — Real-world Confirmation Pending（長期未結案，深度壓縮）

**狀態：`AWAITING_REAL_WORLD_CONFIRMATION`（自2026-08-25起長期懸置，未再更新）。** CCTV 灰色破圖修復（`extractFirstJpegFrame` marker-aware 解析，commit `a3d6609`/`8e10a7a`）已完成/測試/deploy/封版，但尚未取得下一筆真實動態路肩事件 LINE 圖片正常顯示的現場證據（執行修復的 session 無 Production 網路存取）。任何未來 session 取得證據只需更新狀態欄位為 `REAL_WORLD_CONFIRMED`，不需開新修復版本，除非證據顯示修復本身有缺陷。

## KI｜TDX 額度用盡 — 暫時 PBS-ONLY MODE（2026-08-23，歷史記錄，已由 V2.4.0+ 逐步部分還原）

`ACTIVE_TEMPORARY_QUOTA_PROTECTION`（刻意暫停非故障）。開關 `wrangler.jsonc`
`TRAFFIC_SOURCE_MODE`；`tdx/auth.js`關閉時拒發TDX token(零呼叫是程式層保證)。
CCTV影格來自freeway.gov.tw非TDX，從未消耗額度。**現況（V2.4.5）**：
`TDX_ROADEVENT_FETCH_ENABLED`/`QUEUE_INGRESS_ENABLED`已重新設為"true"（見
V2.4.0/V2.4.5條目），額度限制已解除，此段落僅存歷史脈絡，還原程序見下方
「TDX 還原程序」。

## 封版紀錄｜TDX_QUOTA_PROTECTION_PBS_ONLY = SEALED（2026-08-23，壓縮摘要）

已由真人正式封版，下一個 Agent 不需接手。`TRAFFIC_SOURCE_MODE=PBS_ONLY` 閘門已 push main 並部署，10 項專用測試全數通過。真人 `/health` 實機確認為選擇性補充證據（沙盒無 Production 網路存取，`verify:production=PASS_NETWORK_VERIFICATION_BLOCKED`），不構成 blocker——若日後取得反面證據視為新事故，非本輪未完成。額度恢復時直接套用下方 RESTORE TDX 程序，不需新版本。

## KI｜LINE Push 額度保護 — 重大事故限定主動播報（2026-08-23，**生效中**，壓縮摘要）

**狀態**：`ACTIVE_TEMPORARY_PUSH_POLICY`（與 TDX 額度無關，第二個外部額度限制：LINE 官方帳號輕用量方案每月主動 Push 額度有限）。開關：`wrangler.jsonc` 的 `LINE_PUSH_POLICY`（目前 `MAJOR_ACCIDENT_ONLY`，改 `ALL_ELIGIBLE` 回舊行為，實作於 `src/traffic/broadcastPolicy.js`），疊在既有 V1.5 白名單之後、只會減少不會增加可播事件。判定條件：`通過V1.5白名單 AND type==='accident' AND 非機動路肩`（`type` 沿用既有 `pbs/classify.js` 分類器，非新發明）。**刻意不加「必須寫明車道受阻」關鍵字條件**——PBS 無 severity/impact 結構化欄位，唯一可行做法是自由文字關鍵字比對，已實作並經證據否決（讓既有 47 項測試失敗，等於把單純 accident 降級出「可播」範圍，且會靜默丟棄未寫明阻塞的真實重大車禍，錯在危險側）。誠實缺口：目前「所有通過白名單的 PBS 事故」都會播，比字面「不是所有 PBS 車禍都 Push」寬；補救非用猜的——`resolveRoadImpact()` 仍計算並記錄哪些事故確實寫明通行受阻（`policy-major-accident-blocked-lanes`/`policy-major-accident-impact-keyword`/`policy-accident-no-stated-impact`），未來依 `ineligibleByReason`/Pipeline Trace 實際數據決定是否收緊。

機動路肩：`DYNAMIC_SHOULDER_PUSH=OFF`（OPEN/STOPPED 皆不進主動 Push），parser/classifier/resolver/formatter/單鏡頭 CCTV 策略/測試全保留不刪，自己有獨立擋下規則（非靠「非accident」順便擋）。CCTV 重新開啟且仍 0 次 TDX 呼叫：`CCTV_IMAGE=ON_WITHOUT_TDX_REFRESH`——播報路徑攝影機 metadata 讀 KV 快取（`freewayCctvMetadataCache.js` 自身註解："cache-only — NEVER calls TDX"），影格來自 freeway.gov.tw 非 TDX，`dynamicCollage.js` 結構上不 import 任何 TDX 模組，0 TDX 呼叫是結構性保證非承諾；快取不足安全降級 TEXT-ONLY，CCTV 失敗永不擋事故/不 throw。

測試影響：部分既有測試用 construction/closure/other 當機制測試載具，改帶 `LINE_PUSH_POLICY:'ALL_ELIGIBLE'` 繼續測原機制；Production 政策行為另釘在 `test/pbsCctvMajorAccidentOnly.test.js`。本輪新增失敗 0。

## 觀察期｜LINE_PUSH_OBSERVATION = ACTIVE（2026-08-23 起）

```
LINE_PUSH_OBSERVATION = ACTIVE
START_DATE           = 2026-08-23
POLICY               = MAJOR_ACCIDENT_ONLY
MONTHLY_LINE_LIMIT   = 200
```

**這是觀察，不是施工。** 真人已下令停止施工，先看真實數據，不再新增過濾規則。要確認「只播通過既有資格的 accident」能否把主動 Push 控制在每月 200 則內。**計費月陷阱**：LINE 額度按自然月重設，觀察起點 8/23，8/23～9/22 不是一個計費月，判斷須按自然月切。**證據規則**：只有真人從 LINE 官方後台讀到的數字才算證據，本 repo 看不到 LINE 用量，不得用事件數/log 推估補數字。**決策門檻**（由真人判斷，Claude 不得自行提前施工）：明顯低於200維持現行策略；接近或超過200由真人另開新任務研究更嚴格的車道受阻限定策略。`broadcastPolicy.js` 已記錄每則事故是否寫明通行受阻，未來收緊要用這些真實比例論證，不是再猜一次。

## 修正紀錄｜PBS_ONLY 下不得要求 TDX 對應（2026-08-24，深度壓縮）

TDX 停用時不能拿「沒有 TDX 對應」去擋 PBS（真實案例：PBS 國1南向事故被判 `gated-freeway-no-tdx-match`——V57.2 閘門原設計「PBS 國道等 TDX 對應」，只在 TDX 有在跑時成立）。修正：新增 `requireTdxCorrelationForFreeway`（由 `isTdxRuntimeEnabled(env)` 導出），`PBS_ONLY` 略過閘門、`ALL` 模式不變；未放寬播報政策，只是讓事件進候選清單。**通則**：任何「等待另一來源佐證」的閘門都要先問那個來源是否還活著，否則會從「延後」變「永久否決」。

## 修正紀錄｜服務區域閘門（八堵事件）（2026-08-24，深度壓縮）

`PBS_ONLY` 不等於「全台 PBS 都能播」。真實漏播：PBS 國1南向八堵（基隆，type=accident）不在服務區域卻成功推播——地域過濾只存在於 PBS 進料端，`broadcastPipeline.js` 只在 JSDoc 假設已過濾，從未真正檢查。修正：新增 `src/traffic/serviceArea.js`，在 eligibility 迴圈最前面檢查（重用既有 `hsinchuFilter.js`）；PBS fail-closed，TDX 只在明確判定「區域外」時才擋（fail-closed 會丟掉正常 TDX 事件）。`SERVICE_AREA_ELIGIBILITY_REQUIRED=true` 與 `TDX_CORROBORATION_REQUIRED` 永久獨立。**永久教訓**：某一層的正確性若依賴「上游應該已過濾」，就要嘛本層真的檢查、要嘛上游留下可驗證標記——寫在註解裡的假設遲早被繞過且不會報錯。

## 修正紀錄｜播報追溯斷點 ＋ 位置精確度閘門（台68 事件）（2026-08-24，深度壓縮）

真實症狀：PBS Push 印出「（南寮竹東）-台68線」（整條路線官方名稱，非地點）——位置不可行動，且 Pipeline Trace 查不到該筆。根因：(A) 座標保留但顯示側從未讀取，PBS 無結構化 KM；(B) trace 有寫入但讀取側 `road` 篩選嚴格相等 vs 畫面顯示不一致，隨機排序可能被擠出第一頁。修正：新增 `kmLocationResolver.js#resolveCoordinateLocation`（KM 反向查詢）；新增 `traffic/locationQuality.js` 閘門（結構化KM＞displayKM＞座標＞訊息會印出的地點文字），不足時 `eligible=false`／`insufficient-location-precision`，仍留在 trace。三道閘門（TDX對應／服務區域／位置精確度）永久獨立，互不取代。新增 25 項測試，NEW FAILURES=0。**通則**：閘門判準必須與訊息真正顯示的內容一致；「查不到」與「沒發生」是兩件事。

## 修正紀錄｜PBS 國道事故取不到 CCTV（國3 96K+700 事件）（2026-08-25，深度壓縮）

真實症狀：國3南向96K+700事故，Pipeline Trace 每關皆綠燈但 `cctvEligible=否`、理由空白。根因三個：(A) `resolveCctvEligibility` 殘留 TDX-only 閘門；(B) `eventTargetKm()` 只讀結構化KM（PBS沒有）；(C) 被擋時 reason 從未寫進 trace。修正：來源改白名單 `{freeway,highway,pbs}`；`eventTargetKm()` 新增第三層 `displayKM`（已通過 locationQuality 驗證）；reason 一律寫進 trace。**永久原則**：CCTV 資格取決於「道路可解析+公里數可靠」，不取決於通報來源。三道播報閘門完全未動，任何步驟失敗一律退回 TEXT-ONLY。**通則**：資料來源被關閉時要搜尋所有「以來源為條件」的判斷式——它們不會報錯，只會安靜讓整條路徑永遠不成立。

## 治理變更紀錄｜DRIVE_SYNC_GOVERNANCE_V2（2026-08-25，深度壓縮）

**這輪沒改任何產品程式，改的是「版本資料怎麼進雲端」本身。**

**舊流程（已退休）**：Claude 直接用 Google Drive Connector 逐檔上傳+byte驗證，非因不正確
（每輪都確實同步過），而是成本——Agent逐檔上傳佔流量、拖長封版時間。

**新流程（唯一正式路徑）**：`Claude 修改 → Git commit → GitHub(main) → GitHub Actions →
Google Drive Sync`。`CLAUDE_DRIVE_READ=ALLOWED`／`CLAUDE_DRIVE_WRITE=FORBIDDEN`。GitHub =
CODE + ENGINEERING MEMORY WRITE SOURCE；Google Drive = READABLE MIRROR；永久順序 GitHub
first, Drive second。Claude 只負責寫進 GitHub，不負責搬檔案到 Drive。

**三個狀態必須分開講，不得混用**：`GITHUB_ENGINEERING_MEMORY`（是否已commit進GitHub）／
`GITHUB_TO_DRIVE_SYNC`（GitHub端是否已同步到Drive）／`CLAUDE_DRIVE_UPLOAD`（Claude是否直
接寫入Drive，生效後永遠NO）。舊的`MEETING_ROOM_CLOUD_SYNC=PASS`已棄用。

**誠實回報規則（永久）**：自動同步結果未知時，誠實標`GITHUB_SEAL=PASS`／
`GITHUB_TO_DRIVE_SYNC=PENDING`，不得為了讓 Drive 看起來最新而人工補上傳，也不得把
PENDING硬報成PASS——這是雙向規則，PASS已可證實後也不得留著過期的PENDING。

**本輪實測記錄**：下令時預期`GITHUB_TO_DRIVE_SYNC=PENDING`（自動同步當時被認為未建置），
實際發現真人已平行建好自動同步機制（`.github/workflows/sync-engineering-memory.yml` +
`scripts/syncEngineeringMemory.mjs` + `drive-sync-manifest.json`，GitHub OIDC + Google
Workload Identity Federation短效憑證，missing→create/changed→update/unchanged→skip，不
自動刪除其他Drive檔案）。推送後唯讀實測確認10份canonical檔案byte size與modifiedTime皆
相符，最終狀態更正為`GITHUB_TO_DRIVE_SYNC=PASS`（實測非假設）。先前所有Connector完成的
同步紀錄全部保留不改寫，只補標`LEGACY_CLAUDE_CONNECTOR_SYNC=RETIRED`。

**尚未解決的結構問題（刻意不自行決定）**：`engineering-memory/`（GitHub Actions→Drive
mirror）與`meeting-room-export/`（`export-meeting-room.mjs`產生，無自動消費者）是兩棵並
存的canonical樹，需真人裁決是否合併或退休其中一棵；本輪只確保兩邊內容一致。另注意
`00_CURRENT_STATE.md`結尾有一段真人手寫、非export產生器產出的段落，覆寫此檔前務必確認
該段仍在。

**同時生效的封版節奏規則**：`ONE TASK → ONE CLOSEOUT → ONE SEALED STATE`——tests→NEW
FAILURES=0→commit→main→必要deploy→Engineering Memory→GitHub push→確認同步狀態→
SEALED→Current Task=none→STOP，禁止A未封版就開B、之後回頭再改A（這正是三邊版本漂移的
成因）。本輪一併修掉`scripts/finalize-release.mjs`結尾一段會**主動指示**下個Agent違反新
規則（去做已禁止的Connector同步）的殘留文字，只改輸出訊息，未實作任何自動同步。

## 修正紀錄｜CCTV 名冊 7 天過期死結（國1 93K 事件）（2026-08-25，壓縮摘要）

真實事件：2026-08-25 19:01 國1 93K事故，LINE文字正常推播、完全無圖片，
`cctvSkippedByReason=metadata-cache-unavailable`。Root Cause（三環節缺一不可）：
(1) 攝影機名冊KV key寫入時帶 `expirationTtl=7天`；(2) 唯一寫入者是TDX側的Admin-Auth
管理探針；(3) 該探針在`TRAFFIC_SOURCE_MODE=PBS_ONLY`下無法執行（`tdx/auth.js`拒發
token）——探針最後一次執行滿7天後名冊被KV自動刪除，且沒有任何被允許的路徑能補回。
這是分類錯誤：影格(frame)是易變資料本來就不快取，名冊(inventory)是準靜態參考資料，
對「沒有保證補回路徑」的資料設定計時過期=把「有點舊」變成「完全沒有」。修正三件事：
(1) 不再設expirationTtl，key永久存在；(2) 寫入只能升級不能降級（空/格式錯誤的record
set一律拒絕`refused-empty-record-set`，沒有任何路徑能刪除名冊）；(3) **內建官方名冊
做為地板**——`data/cctv/generated/freewayCctvInventory.js`打包交通部NFB open data
靜態名冊1943筆（國1 510筆、國3 728筆），即使KV完全空也一定拿得到可用清單，恢復在
deploy當下自動發生、不需對Production KV做任何寫入。以完全空的KV重跑19:01事件驗證：
四格全中。成本：Worker bundle +77KiB（用掉約27%上限）；TDX呼叫數=0；未新增任何
未驗證道路（`CCTV_SUPPORTED_ROADS`仍僅國1/國3）。名冊中一筆非freeway.gov.tw主機的
紀錄（台64，`cctv-ss02.thb.gov.tw`）已確認安全：兩道獨立屏障（不在`CCTV_SUPPORTED_ROADS`
+ `isTrustedImageUrl`發request前fail-closed）。`/health`新增攝影機基礎資料卡片
（來源/筆數/日期，永不含stream URL）。名冊更新程序：`npm run build:cctv-inventory`
或`node scripts/build-cctv-inventory.mjs <新XML>`（寫檔前自我驗證，任一項不過即中止）。
不要誤讀：不要把expirationTtl加回去；不要為取得名冊重開TDX；不要新增未驗證道路；
不要手動編輯生成檔。

## 治理變更紀錄｜正式版本線校正（PRODUCTION_VERSION_LINEAGE_RECONCILIATION）（2026-08-25，深度壓縮）

**發現**：`src/version.js` 自 V1.8.6.9 後兩個月未更新，`GET /version` 講的是舊話；同時
export 掃描 commit message 另外冒出一個沒人負責的第二版本號（V1.8.7.7），與人工文件標記
三方各自為政。**修正**：`src/version.js` 確立為唯一權威來源，校正為 V1.8.7.14；
export script 改讀它，commit message 掃描降級為 drift 警告、讀不到權威來源時直接拋錯（不
退回猜測）；`06_VERSION_HISTORY.md` 補記缺漏七列；新增 `test/versionLineage.test.js`
鎖住規則形狀（單一來源、其他衍生），刻意不鎖當下數字。**補記非重新部署**——七次變更早
已 merge/部署，本次只建立版本號↔commit↔部署對照，無 rebase/amend/force push/偽造部署。
**永久規則**：Production runtime 變更須在同一 commit 內 bump `APP_VERSION`；任務名稱≠版
本號；純文件/治理不 bump 但仍需 commit；不得在 `src/version.js` 外宣告版本號、不得把
`package.json` 的 `0.1.0` 當產品版本。（版本線格式本身已由下方「三段式版本治理切換」
取代，此節保留純粹是這次事故的教訓記錄。）

## 治理變更紀錄｜三段式版本治理切換（THREE_PART_VERSIONING_TRANSITION）（2026-08-25）

### 正式決議

```
CURRENT_OFFICIAL_VERSION = V1.8.7.14
LAST_FOUR_PART_VERSION   = V1.8.7.14

FOUR_PART_VERSIONING  = RETIRED
THREE_PART_VERSIONING = ACTIVE

NEXT_RELEASE_VERSION = V1.9.0
```

`PRODUCTION_VERSION_LINEAGE_RECONCILIATION` 當時記錄的
`NEXT_RELEASE_VERSION = V1.8.7.15` 由本次決議**取代**為 `V1.9.0`。
V1.8.7.8～V1.8.7.14 既有七列版本記錄**不重寫**——四段式版本線在
V1.8.7.14 就此封存，不追加 V1.8.7.15。

### 永久規則（三段式）

- **Bug fix** → patch：`V1.9.0 → V1.9.1 → V1.9.2 …`
- **明顯新功能／架構階段** → minor：`V1.9.x → V1.10.0`
- **大型不相容版本** → major：`→ V2.0.0`
- **純文件／治理／Engineering Memory／測試整理** → 不升 Product Version，但仍須有 commit

### 這是治理紀錄，不是 release

本輪**只做版本治理紀錄修正**，不占 Product Version。`src/version.js` 的
`APP_VERSION` **維持 `V1.8.7.14`，沒有提前改成 `V1.9.0`**。
只有下一次真正改變 Production runtime 行為的 release，才會在**同一個
commit 內**把 `APP_VERSION` bump 到 `V1.9.0`，同時：
- 更新 `test/versionLineage.test.js` 第 1 項的版本前綴斷言（`'V1.8.7.'` → `'V1.9.'`）
- 在 `06_VERSION_HISTORY.md` 新增 V1.9.0 那一列

未修改任何 CCTV／PBS／TDX／LINE 或其他 Production runtime 程式，未 deploy 功能變更。

### 不要誤讀

- **不要把 `src/version.js` 提前改成 `V1.9.0`**——那要等下一次真正的 runtime release。
- **不要重寫 V1.8.7.8～V1.8.7.14 既有版本列**；四段式版本線原樣保留在歷史裡。
- **不要把這次治理決議當成一次 release**——沒有 commit 觸發功能性部署。

## 修正紀錄｜Quad CCTV Prepare-Timeout 可觀測性（V1.9.0，國3 96K+700 事件）（2026-08-26，壓縮摘要）

2026-08-26 09:20 國3南向96K+700事故：進 Shared Feed 但 withImage=0，CCTV prepare
**完全無 completion log**；09:30 同事件重跑即成功。Root Cause（程式碼確認＋7 項決定性
測試 `test/cctvQuadPrepareForensics.test.js` A-G）：quad（事故）路徑當時**完全沒有 stage
追蹤**（單鏡頭路徑早就有 `stageTracker`），所以任何一次真實外部延遲（frame-fetch／
compose／R2-publish——三者共用同一個 4000ms budget，已用測試證實）在當下都結構性不可見；
09:20 具體慢在哪一段**無法回推**，誠實標記為未知。修正：quad 路徑加上比照單鏡頭路徑的
`stageTracker`，任何結果（成功／失敗／逾時）都留下 metadataElapsedMs／
cameraSelectionElapsedMs／frameFetchElapsedMs／collageElapsedMs／successfulFrameCount／
failedFrameCount／r2PublishElapsedMs／timeoutStage，白名單接入 Pipeline Trace（純數字/短
字串，無 stream URL／frame bytes）。**RETRY_REQUIRED=NO**：未新增 retry／第二輪 fetch／
fallback，4000ms 未變動，純可觀測性修復。「3支已成功等第4支逾時才組圖」的優化本輪**未實作**
（誠實記錄，非本輪範圍）。防死亡螺旋：`MAX_FRAME_FETCH_PER_EVENT=4`／
`MAX_RETRY_PER_EVENT=0`，outer race 保證 Cron 不受背景 straggler 影響（測試 B/C 證實）。
不要誤讀成已查明 09:20 具體延遲來源、或已加大 timeout。

## 修正紀錄｜Pipeline Trace 查修頁篩選失效（V1.9.1，form-action CSP）（2026-08-26，壓縮摘要）

真人在真實手機（iOS Safari）操作 `/admin/pipeline-trace-view`：篩選後畫面完全
不跟著變。Root cause（真實 headless Chromium 對著真實部署重現，非猜測）：
`applyAdminSecurityHeaders` 的 CSP 帶 `form-action 'none'`，任何強制執行 CSP
的瀏覽器都會完全拒絕頁面上任何 `<form>` 送出——伺服器端每一層（表單標記/
query string/filter predicate/分頁）前一輪（V1.8.7.6）已查證全部正確，但那一
輪的 headless 瀏覽器重現不在本 repo 測試套件內，從未真正撞見這個指令擋下點擊
的那一刻。修正：`form-action 'none'` → `'self'`（同源表單仍可送出，CSP 其餘
指令未動），`DEFAULT_LIST_LIMIT` 30→60（`MAX_LIST_LIMIT`/`MAX_ENTRIES_SCANNED`
不變）。伺服器端篩選邏輯本身零改動——V1.8.7.6 已證實全部正確。**永久教訓**：
不要把 `form-action` 改回 `'none'`；不要放寬到 `'*'`；不要把 Playwright 加成
正式相依套件（CI 覆蓋改用不需瀏覽器的 CSP 標頭字串斷言）。

## 修正紀錄｜Cloudflare KV Write Optimization ＋ TDX Usage Summary 正式退休（V1.9.2）（2026-08-26，壓縮摘要）

真實 Cloudflare 帳號告警：Writes 749/1,000（`traffic-reporter-kv`=733，佔帳號總寫入量97.9%）。
四項變更：(1) `traffic:shared-feed`／`line:incident-suppression-state` 改為 WRITE_ON_CHANGE
（新共用原語 `src/util/contentEqual.js`），內容決策邏輯完全不動，只改「何時寫入」——施工中
自己的測試抓到一個真實 aliasing bug（`resolveIncidentNotifications` 就地修改比對用的舊物件，
導致比較永遠「相等」），已用 `structuredClone` 在呼叫前先拍快照修正；(2) Pipeline Trace 改為
每輪一把 `debug:pipeline-trace-batch:v2:*` 批次金鑰，取代舊制一筆事件一把 key——舊制
`debug:pipeline-trace:v1:*` 完全不刪除不遷移、靠 24h TTL 自然過期，`listPipelineTrace` 已能
正確合併新舊两種schema，兩個既有 admin 讀取 handler 未改一行程式碼（V1.9.4 後續再優化其讀取
效能，見該輪條目）；(3) **TDX Usage Summary 正式退休**（人類決策，非優化）：`tdx:usage:summary:v1`
與底層 `tdx:usage:entry:v1:*` 帳本皆確認除了餵已退休的儀表板外無其他讀者，改為 0 writes/day，
`/health` 的用量卡片改為指向 TDX 官方後台的靜態提示，TDX 本身（API client／OAuth／RoadEvent／
CCTV metadata／source mode／9-1 額度恢復路徑）完全未動；(4) 新增 `[kv-write-budget]` Cron
console.log（僅 Workers Logs，未新增 KV key）。量化估算：QUIET/MEDIUM/HIGH 每輪約
1-4／4-8／4-8 writes（原本約 11-21／19-20／29-30）。新增 38 項測試（`test/kvWriteOptimization.test.js`）。
NEW FAILURES=0（1300 項，35 項既有失敗不變）。不要誤讀成刪除了 TDX 程式碼或改變了資料決策邏輯。

## 修正紀錄｜KV Write Optimization Phase 2（V1.9.3）（2026-08-26）

延續 V1.9.2，關三個剩餘來源：(1) `health:snapshot:v1` 改 WRITE_ON_CHANGE，除既有
`*.lastFetchedAt` 外新排除 `scheduledThisRun`/`sleeping`/整個 `broadcast` 區塊（決定性
fixture 跑滿一天才抓到：漏排除會讓安靜日仍寫 63 次）；(2) PBS 固定抓取改每 30 分鐘、僅
07:00–22:00（`pbsSchedule.js`），施工前已核對既有生命週期規則皆為 wall-clock，無 STOP
理由；(3) Pipeline Trace 新增 `NO_RELEVANT_CHANGE`，無關事件時整批跳過寫入，TDX 重複／
PBS 閘門排除仍視為有意義。fixture 實測 QUIET/NORMAL/HIGH writes/day = 5／21／27，遠低於
目標。NEW FAILURES=0（1339 項）。完整記錄 → `SYSTEM_STATE.json.taskSeal`；版本列 →
`06_VERSION_HISTORY.md` V1.9.3。

## 修正紀錄｜Windows → Cloudflare Debug-only Push Endpoint（V1.9.5）（2026-08-27，壓縮摘要）

**一句話**：新增 `POST /internal/pbs-debug-push`，本輪只證明一條鏈（Windows 發 payload → Cloudflare 驗身份／格式／冪等 → 寫 log → ACK），`WINDOWS_PUSH_ENABLED=NO`，未整合進正式 Pipeline。身份驗證用獨立 Secret `PBS_DEBUG_PUSH_SECRET`（雜湊常數時間比對，證實不回退到 `PBS_RELAY_TOKEN`／`ADMIN_PASSWORD`／任何 LINE/TDX secret，未設定=503、錯誤=401，secret 不外洩）。Payload 白名單校驗＋16 KiB 上限。**結構性 debug-only 邊界**：`debugPush.js` 完全不 import LINE/CCTV/Shared Feed/Pipeline Trace/`pbs/lifecycle.js`/`pbs/pipeline.js` 任一模組，也不觸碰 `env.TRAFFIC_KV`——不是旗標而是沒有 import path。冪等判斷本輪刻意**不**加 KV 寫入，改用 per-isolate 記憶體 fingerprint Map，誠實回報 `NOT_PERSISTENT`（V1.9.7 後補上持久層，見下）。33 項新測試，NEW FAILURES=0。部署後 Claude Browser 驗證、Windows 端接 client 皆待真人授權，本輪未把 secret 交給 Windows。

## 修正紀錄｜Pipeline Trace 讀取效能優化（V1.9.4）（2026-08-27，壓縮摘要）

**一句話**：真人在 Production 實測 `/admin/pipeline-trace`／`-view` TTFB ≈59.1s（其餘頁面 <1s）。Root cause：舊 `collectFlattenedTraceEntries` 不論有無篩選一律循序解碼到 `MAX_ENTRIES_SCANNED`(500) 筆才套 `limit`。修正為 `scanTraceEntriesProgressively`：無篩選提前停止（500筆/limit60 → 只 60 次 `kv.get()`）＋有篩選漸進式掃描（首輪 `boundedLimit+20`，之後 ×2，上限仍 500）＋同輪內固定 20 筆一批 `Promise.all` 並行。V1/V2 schema 並存策略不變，兩前綴 `kv.list()` 改並行。新增可觀測性欄位（讀既有已算出的數字，零新增 KV 寫入）。23 項新測試，NEW FAILURES=0。未觸碰寫入路徑／PBS 排程閘門／Health Snapshot／LINE／CCTV／TDX／Cron 頻率。

## 補登紀錄｜WINDOWS_PBS_GEOGRAPHIC_FILTER_REPAIR（2026-08-30，人類回報，本 Cloud Session 未獨立驗證）

**狀態：`HUMAN_REPORTED_NOT_INDEPENDENTLY_VERIFIED`。** 人類回報：Windows PBS 本機篩選舊邏輯先套用 `isAccident()` 事故關鍵字語意閘門，才進新竹縣市地理判斷，導致非事故型事件（落石／坍方／封路／施工／積水等）即使位於新竹縣市仍可能在 Windows 端被直接丟棄，從未進入 Cloudflare/AI。回報修正：移除 `isAccident()` 語意閘門，改用 point-in-polygon（data.gov.tw dataset 7442 縣市界線）取代原本的矩形邊界，新竹市/縣**所有**事件類型皆納入候選，語意判斷完全交給 AI；同批資料驗證回報 `BEFORE_KEEP_COUNT=11 → AFTER_KEEP_COUNT=29`（找回 18 筆），`TESTS=124 passed/0 failed`。**本 Cloud Session 的獨立查證**：目前 `main`／本分支的 `pbs-relay/src/localPrototype.js` 仍保留 `isAccident()` 並仍作為候選閘門使用（見該檔第 56/108 行），`pbs-relay/` 完整 git 歷史（含 `feature/pbs-local-edge-filter-prototype` 分支）中**未找到**對應此修正的 commit，故無法核對回報的 point-in-polygon 實作、dataset 7442 引用或 11→29/124 測試數字。與既有 `PBS Windows Local Edge Debug Push Integration`（V1.9.6）記錄採同一誠實原則：**本節只記錄「人類回報了什麼」，不代表本 Session 已驗證程式碼或測試結果為真**——待對應 commit 出現於本 repo（或人類提供可核對的 diff/測試輸出）後，下一輪應改記為已驗證版本，並同步更新 `pbs-relay/` 程式碼本身（本輪禁止修改）。

## 修正紀錄｜V2.4.8 — LINE 路況文字編輯與統一排版（2026-09-04，壓縮摘要）

**任務** `V2_4_8_AI_LINE_MESSAGE_EDITOR_AND_UNIFIED_PRESENTATION`，MINOR，PBS_DECISION_POLICY_MODIFIED=NO、TDX_DECISION_POLICY_MODIFIED=NO、GEO_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、CCTV_LOGIC_MODIFIED=NO。

**目標**：PBS/TDX LINE 訊息長期各自一套排版、口吻不一致。本輪統一為單一「路況播報員」語氣，且不新增第二次 AI 呼叫——同一次既有 Workers AI 呼叫的回應新增 `cleanSummary` 欄位（`aiDecisionEngine.js`，`CLEAN_SUMMARY_MAX_CHARS=100`），與既有 notify/impact/reason/confidence 四欄位完全獨立驗證。

**核心原則（AI＝文字編輯，AI≠事實產生器）**：SYSTEM_PROMPT 明確禁止 `cleanSummary` 新增/杜撰任何道路/方向/公里數/車道數/傷亡；新函式 `cleanSummaryContradictsFacts()` 用車道數字與方向詞兩道保守 regex 反查 candidate 真實欄位，任一矛盾即整個丟棄（設回 null），絕不擋下 notify:true 的真實廣播——文字美容失敗不得成為通知單點故障。`messageFormat.js#formatEventMessage()` 新增 `cleanSummary` 參數，僅在有效時走新排版分支，無效/缺席時完全回退既有決定性格式化器（此路徑本輪逐位元組未變動）。

**來源標示（新，不受 cleanSummary 有無影響）**：TDX 事件首次顯示通報來源——`通報：【TDX】高公局`（國道）／`通報：【TDX】公路局`（省道），此前 `tdx/normalize.js` 從未設定過任何 `sourceDetail`。PBS 改為 `通報：【警廣】`＋既有別名表，即使原文為空也固定顯示前綴（原本可能整行省略）。查修頁 `aiObservatoryView.js` 新增區塊同步顯示「原文→AI 編輯後→最終 LINE 文字」三層。

**測試**：新增 `test/v248AiLineMessageEditorAndUnifiedPresentation.test.js`（18 項，CASE 1-14 含子案例）；既有 6 個測試檔因來源標示行為刻意變更而同步改寫斷言（非回歸）。全量迴歸 1788/1756/32，NEW_FAILURES=0。`APP_VERSION` V2.4.7→V2.4.8。**未觸碰**：PBS/TDX 決策政策、地理 resolver、道路管理政策、AI prompt 的核心四欄位判準、CCTV、任何 `wrangler.jsonc` 開關。**通則**：允許 AI 修飾呈現文字時，驗證層必須把「文字合不合理」與「決策要不要播」徹底切開——前者失敗只能降級成沒有文字美容，不能連帶否決後者。詳見 `03_ARCHITECTURE.md`／`00_CURRENT_STATE.md`。

## 修正紀錄｜V2.4.7 — TDX 地理資料缺失查修：description 文字 KM 後援（2026-09-03，壓縮摘要）

**任務** `V2_4_6_TDX_GEO_INPUT_MISSING_DIAGNOSIS_AND_FIX`，PATCH，PBS_MODIFIED=NO、GEO_RESOLVER_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、AI_POLICY_MODIFIED=NO。

**起因**：真實事件 `A15040100H-01-20260903103244766100023`（TDX｜高公局，國3北向79K+000其他異常告警-散落物）查修頁 `areaNm`/`displayKM`/座標全空，即使 description 明確含「79K+000」。

**§一稽核**：`normalizeRoadEvent()` 結構化 KM 擷取本身無 bug（無條件執行）——該筆事件原始 payload 確實缺少所有結構化地理欄位（本 sandbox 無法連線 TDX API 取得原始 raw JSON 做 100% 驗證）。真正缺口：TDX normalize 從未有 description 文字 KM 後援（PBS 早就有）。**副發現**（範圍外、已妥善繞過非重寫）：`tdx/extract.js#firstDefined(raw, paths, undefined)` 因 JS default-parameter 語法，缺席欄位實際上永遠是 `''` 而非字面 `undefined`——對既有每個讀者（`composeLocation`/`parseKM`/`roadManagementPolicyGate.js`）皆無害，但新後援邏輯的觸發條件必須用 `!startKM`（falsy），不能用 `=== undefined`。

**修法**：`hsinchuFilter.js` 新增 `extractKmTokenFromText()`（重用 `parseKM()` 既有 TDX KM token 格式，非第二套）。`normalizeRoadEvent()` 只在結構化 startKM/endKM 皆缺席時對 description 呼叫——結構化欄位永遠優先，絕不被覆蓋。token 以相同原始字串格式存回 startKM/endKM，`composeLocation`/`parseKM`/`hsinchuGeoResolver.js` Tier-2 皆自動吃到，零新型別分支。新增 `displayKM`（數字，PBS 既有欄位同形狀）。

**安全性（非常重要，CASE 7/7b 鎖住）**：新 KM 唯一讀者是 `hsinchuGeoResolver.js` Tier-2 KM-heuristic 觀測層，永遠 observability-only、不單獨決定 CONFIRMED/OUTSIDE——上述真實事件即使 KM 成功解析仍正確維持 UNKNOWN（0 Queue/0 AI/0 LINE），只有可觀測性改善。

**測試**：新增 `test/v247TdxGeoInputMissingFix.test.js`（12項）。全量迴歸1770/1738/32，NEW_FAILURES=0。`APP_VERSION` V2.4.6→V2.4.7。**通則**：一個「無條件擷取，沒有分支會丟資料」的 code path，其輸出仍可能因為上游 payload 本身就缺欄位而顯得「壞了」——查修前必須先用程式碼稽核排除「我方邏輯丟資料」，再判斷是否需要新增（而非誤以為要修復）一個原本就不存在的能力。詳見 `03_ARCHITECTURE.md`／`00_CURRENT_STATE.md`。

## 修正紀錄｜V2.4.6 — 查修頁 TDX 顯示與最終決策原因摘要（2026-09-03，壓縮摘要）

**任務** `V2_4_6_TRACE_PAGE_TDX_AND_DECISION_REASON_SUMMARY`，UI/observability-only，PBS_RUNTIME_MODIFIED=NO、TDX_DECISION_LOGIC_MODIFIED=NO。

**§一唯讀調查發現**：查修頁分兩套——舊版 `pipelineTraceView.js`（`buildTraceEntry()` 僅3呼叫點皆PBS觸發，純TDX事件本就幾乎不出現，非本輪目標）、新版 `aiObservatoryView.js`＋`aiObservatoryIndex.js`（`GET /admin/pbs-ai-observatory-view`，`source` 欄位自V2.4.0起已支援 pbs/freeway/highway，才是本輪目標）。TDX 幾乎不出現＝(B)+(A) 組合：(B多數) `tdxQueueIngress.js` Gate A（地理/道路管理政策）排除時此前只有 `console.log`，KV零紀錄；(A少數) 通過Gate A的TDX事件雖正確寫入`source`，但`renderRow()`收合列硬編碼字串`"PBS"`從未讀`record.source`，畫面仍誤標PBS。

**修法（全部 additive-only）**：(1) `tdxQueueIngress.js` 在兩個 Gate A 排除點後新增 `recordTdxGateDrop()`，重用既有 `buildAiObservatoryRecord`/`recordAiObservatoryEntry`（同KV prefix），把已算出的 geo/policy 結果轉成6個新 `AI_OUTCOME`（`GEO_EXCLUDED_OUTSIDE_HSINCHU`/`GEO_EXCLUDED_UNKNOWN`/`ROAD_POLICY_EXCLUDED_SHOULDER_OPEN`/`_SHOULDER_CLOSE`/`_INSUFFICIENT_LANES`/`_UNKNOWN_LANES`）——排除決策本身不變，寫入best-effort。(2) 新增純函式 `deriveFinalDecisionReason(record)`——唯一權威原因組成，只讀既有欄位，區分「施工僅封1車道」與泛用 `construction` 類型。(3) `buildAiObservatoryRecord()` 新增 `suppressedForPhase`（`debugPush.js` 早算出但先前被靜默丟棄）／`blockedLanes` 兩個既有欄位。(4) `renderRow()` 改讀 `record.source` 顯示 `PBS`/`TDX｜高公局`/`TDX｜公路局`；收合卡片新增原因摘要行；展開內容新增 TDX 專屬 SOURCE→GEO→ROAD_POLICY→QUEUE→AI→LINE 六段流程條（PBS 原①-④流程條不變）。

**測試**：新增 `test/v246TracePageTdxAndDecisionReasonSummary.test.js`（20項，含施工令§十二全部8個CASE）。全量迴歸1758/1726/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。`APP_VERSION` V2.4.5→V2.4.6。**未觸碰**：PBS runtime、TDX決策邏輯、AI prompt、LINE規則、`wrangler.jsonc`（`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED`維持`"true"`）。**通則**：一個系統若同時存在「資料已正確寫入但顯示層有bug」與「資料根本沒被寫入」兩種缺口，兩者外部症狀（畫面看不到）完全相同——必須讀程式碼分別驗證兩層，不能只驗證其中一層就下結論。詳見`03_ARCHITECTURE.md`／`00_CURRENT_STATE.md`／`SYSTEM_STATE.json`。

## 封版部署紀錄｜V2_4_5_SEAL_DEPLOY_AND_REAL_WORLD_VERIFY（2026-09-02 同日再稍晚，不升版，**生效中／觀察中**）

**狀態：`ACTIVE_REAL_WORLD_OBSERVATION`。** 人類明確授權，正式把
`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED` 從 `"false"` 改回 `"true"`（FETCH/
QUEUE/AI 皆已 `"true"`）——TDX 真實 LINE 通知重新上線，`CURRENT_RUNTIME_PHASE`
=`PHASE_E_TDX_NOTIFY_LIVE`。這是 V2.4.4 洩漏事件（台61線39.6K誤判新竹）後，
V2.4.5 官方界線 positive-authority resolver＋道路管理政策閘門＋官方 shapefile
補正三輪修復完成、人類主動決定不再長時間停留 observation-only 的正式重新啟用。

**開工前逐項確認（未新增任何程式碼，純讀程式碼/測試驗證既有 13 項功能）**：
①TDX座標保留②新竹縣市geo resolver③OUTSIDE_HSINCHU→DROP④UNKNOWN→DROP
⑤桃園觀音台61線39.6K→DROP⑥頭份→DROP⑦竹南→DROP⑧機動路肩開放→0AI⑨機動路肩
關閉→0AI⑩一般施工0-1車道→0AI⑪一般施工≥2車道→可進AI⑫blockedLanes已進AI
input⑬PBS完全未修改——全數確認存在，targeted tests 42/42 全過。

**部署**：本次是純 config-only commit（`wrangler.jsonc` 單一開關值），working
tree 於變更前已 clean、local HEAD 與 `origin/main` 一致（`31ae4ef`），推送後
依本專案既有唯一部署路徑（push main → Cloudflare Workers Builds 自動部署）
生效，未執行任何手動 `wrangler deploy`（維持既有唯一部署路徑，未新增第二條）。

**已知、誠實揭露的限制**：`npm run verify:production` 執行結果仍是
`PASS_NETWORK_VERIFICATION_BLOCKED`——本 sandbox 對 Production `*.workers.dev`
無任何直接網路存取（與本專案自始至終記錄的限制一致），因此本 session **無法
自行觀察真實 TDX 事件的 LINE 推播結果**，也無法直接確認 Cloudflare Dashboard
上的 Production branch/實際 deployedCommit。第六節「實機直接觀察」的執行者
是**人類**，非 Claude；本輪只完成「讓它有機會被觀察」的部署，觀察本身待人類
回報證據。

**Rollback 協定（永久規則，優先於任何查修動作）**：人類（或未來有 Production
存取的 session）發現任一異常——桃園/苗栗/頭份/竹南 LINE 推播、機動路肩開放/
關閉 LINE 推播、一般施工 0-1 車道 LINE 推播、真正新竹重大事件完全進不了 AI、
LINE 內容明顯錯誤——**第一動作固定是**把 `TDX_ROADEVENT_PRODUCTION_NOTIFY_
ENABLED` 改回 `"false"` 止血，**禁止**邊跑 Production 邊大改程式碼。止血後才
依序：保存事件證據（eventId/source/road/KM/coordinates/description）→找到
實際 pipeline stage→修正→targeted test→regression→commit→push→docs
sync→再部署→再開 Notify。**禁止**「先在 Production 修，文件明天再補」與
「今天改很多但沒有封版」——任何時刻都必須能回答「這一刻 Production 對應哪一
個 Git commit」。

**觀察重點對照表**（供人類/未來 session 核對）：新竹縣市事件應完整走
TDX→地理通過→政策通過→AI→LINE；桃園/苗栗事件必須 0 LINE；頭份/竹南必須
0 LINE；機動路肩開放/關閉必須 0 LINE；一般施工封鎖 0-1 車道必須 0 LINE；一般
施工封鎖 ≥2 車道才可能經 AI 後 LINE。

**未觸碰**：resolver/gate/policy 程式碼本身、PBS、其餘三個 wrangler.jsonc TDX
開關值（皆維持不變，只有 NOTIFY 一個值變動）。`APP_VERSION` 不變，仍 V2.4.5。

## 補正紀錄｜V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX_CONTINUE（2026-09-02 同日稍晚，不升版，壓縮摘要）

**背景**：V2.4.5 原輪用 taiwan-atlas npm 2021.9.20 鏡像作為 TDX 地理正面權威，非直連
data.gov.tw（此 sandbox 仍全面 EGRESS_BLOCKED，本輪重測仍相同）。人類先前先下 STOP（見
前一份 `V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX` 報告），之後**直接自 data.gov.tw
dataset 7442 下載官方 shapefile 並上傳**至本 session，本輪據此續工。

**誠實揭露**：上傳檔案 `COUNTY_MOI_1090820`（民國109年08月20日）的 ISO 19115 metadata
本身記載 creation/revision=**2020-08-20**——比原本 2021.9.20 的第三方鏡像**日期更早**，
與人類「已提供最新版」的敘述表面矛盾，本輪未略過此點直接宣稱完成，而是完整查證後才決定
採用（理由見下方）。

**驗證過程**：ZIP SHA-256=`0c6fca34a92b92ef3e9a41957e403cb89e814bb64942ca7c7e51c746f913d49d`；
`.shp/.shx/.dbf/.prj/.CPG`五檔齊全，另附官方 ISO metadata XML；`.prj`=
`GCS_TWD_1997`/`GRS_1980`，XML 內另明確記載 CRS=`EPSG:3824`（兩者互相印證，非單一來源
推論）；DBF `COUNTYNAME` 確認 22 縣市齊全，含新竹市(COUNTYID=O/10018)與新竹縣
(COUNTYID=J/10004)；用 Python `pyshp` 與 Node `shapefile`(mbostock) 兩套獨立套件交叉解
碼幾何，結果一致——新竹市4,027點/新竹縣15,069點，皆單一 ring，遠高於舊鏡像的246/965點
精度。

**幾何差異比對**（用 resolver 自己的 ray-casting 演算法，比對舊 taiwan-atlas 與新官方
shapefile）：10 個參考點（市政府/竹北/湖口/新豐 vs 桃園市政府/桃園觀音/苗栗市/頭份/竹南/
台北市政府）全部一致；新竹/桃園交界密集網格(~300m)僅1/4,131點不同(0.024%)；新竹/苗栗交
界僅1/5,751點不同(0.017%)；全區域網格僅19/47,089點不同(0.0403%)，且每個差異點都是緊貼
既有邊界線的單一網格（舊版簡化量化雜訊，非真正邊界變動）。另用真實苗栗縣 shapefile 頂點
（非隨手猜座標）驗證交界內外兩側正確判定。**結論：BOUNDARY_CHANGED=NO**——新竹市/縣屬縣
市層級行政區，自2014年直轄市改制後未再變動，此結果符合預期。

**為何仍採用**：儘管標稱日期較舊，此檔案(1)是人類直接官方下載，非第三方鏡像，溯源鏈更
強；(2)幾何比對證實無實質差異；(3)精度遠高於舊版（未簡化原始 SHP vs 已量化 TopoJSON）。
三點合計構成正當採用理由，非單純接受"較新"的表面說法。

**實作**：`scripts/updateHsinchuBoundaryData.mjs` 改讀 shapefile（新 devDependency
`shapefile`，mbostock 套件，BSD-3-Clause），舊 `topojson-client` 保留但目前無程式碼引
用。原始檔存至 `data/hsinchu-boundary/raw/nlsc-shp-2020/`，舊 taiwan-atlas 鏡像移至
`raw/historical-taiwan-atlas-2021/` 作歷史比對用途，非刪除。`hsinchuGeoResolver.js` 本
身**完全未重寫**，只換其讀取的資料檔；三態輸出/證據優先序/既有政策全部不變。新增 2 項
邊界測試（真實苗栗縣頂點驗證的交界內外側）。**部署政策不變**：NOTIFY 仍 `"false"`。

**BOUNDARY_AUTHORITY**=內政部國土測繪中心測繪資訊課｜**BOUNDARY_DATASET**=直轄市、縣市
界線(EPSG:3824)｜**BOUNDARY_DATASET_ID**=7442｜**BOUNDARY_SOURCE_VERSION**=
COUNTY_MOI_1090820（ISO metadata creation/revision=2020-08-20）｜**BOUNDARY_FETCH_DATE**
=2026-09-02（人類下載後上傳本 session）｜**BOUNDARY_SOURCE_CRS**=EPSG:3824(TWD97經緯
度)｜**RUNTIME_BOUNDARY_CRS**=同上，未轉換｜**BOUNDARY_TRANSFORMATION**=無數值轉換
（TDX座標視為WGS84，公分級差異，沿用既有工程判斷）。

**測試**：`test/tdxHsinchuGeoResolver.test.js`(21項，含2項新邊界測試)全過；CASE1-8全部
重跑通過（新竹市/竹北/湖口新豐→CONFIRMED；桃園觀音/頭份/竹南→OUTSIDE；台61線39.6K→
OUTSIDE/Queue0/AI0/LINE0；無證據→UNKNOWN）。全量迴歸 NEW_FAILURES=0（比對V2.4.5原輪同一
份`git stash -u`精確基準52項）。`APP_VERSION`不變，仍V2.4.5。

## 修正紀錄｜V2.4.5 — TDX_HSINCHU_GEO_RESOLVER ＋ TDX_ROAD_MANAGEMENT_POLICY_GATE（2026-09-02，壓縮摘要）

**背景**：V2.4.4 唯讀 audit 發現 TDX 服務區判斷全建立在 `hsinchuConfig.js` 自承
未驗證的 KM 表上，且座標缺席時 fail-open（"service-area-deferred-to-
ingestion"）。真實洩漏：台61線39.6K實為桃園觀音，被KM表誤判新竹。核心驗收：
「TDX 必須先證明位於新竹縣/市才進AI，無法證明就不進」；PBS 完全不在本輪範圍。

**FIX A（地理 resolver）**：新模組 `src/tdx/hsinchuGeoResolver.js#
resolveTdxHsinchuGeography()`——三態輸出 CONFIRMED_HSINCHU/OUTSIDE_HSINCHU/
UNKNOWN，絕非 boolean。證據優先序：①座標對官方行政區界線（唯一能核發
CONFIRMED 的權威）②KM表僅觀察用途，永不核發最終判定③明確行政區文字（含
「往ＸＸ方向」與事件所在地區分）。UNKNOWN 下游行為等同 OUTSIDE_HSINCHU
（0 Queue/0 AI/0 LINE），絕不預設為新竹。

**BOUNDARY_AUTHORITY**=內政部國土測繪中心｜**BOUNDARY_DATASET**=直轄市、縣市
界線（TWD97經緯度）｜**BOUNDARY_DATASET_ID**=7442｜**BOUNDARY_SOURCE_CRS**=
TWD97經緯度(EPSG:3824)｜**BOUNDARY_INCLUDED_AREAS**=新竹市,新竹縣｜
**BOUNDARY_FETCH_DATE**=2026-09-02T13:05:01Z｜**BOUNDARY_SOURCE_VERSION_OR_
METADATA_DATE**=taiwan-atlas npm 2021.9.20（`counties-10t.json`，MIT
license，逐位元組鏡像 dataset 7442，此 sandbox 無法直連 data.gov.tw，人類
裁決核准此鏡像來源——見下方決策記錄）｜**BOUNDARY_TRANSFORMATION**=無數值轉換
（TDX PositionLon/Lat 視為WGS84，與TWD97對台灣地區僅差公分級，沿用本專案
`data/road-location/`既有WGS84慣例，非本輪新猜測；決策記錄非邊界幾何本身的
猜測）。驗證：`topojson-client`真實解碼＋`@turf/boolean-point-in-polygon`
交叉驗證10個已知參考點（新竹市政府/竹北市/湖口/新豐/關西 vs 桃園市政府/
苗栗市/頭份/竹南/台北市政府等5鄰近縣市），全部正確；新豐鄉初始猜測座標偏差
邊界，改用`towns-10t.json`+`@turf/centroid`驗證真實鄉公所座標後修正。

**FIX B（道路管理政策閘門，補充令）**：新模組 `src/tdx/
roadManagementPolicyGate.js#resolveTdxRoadManagementEligibility()`，跑在地理
閘門之後——機動路肩開放/關閉永不進AI；一般施工需`blockedLanes>=2`才有資格進
AI，資料不足(缺失/無法解析/負數/非整數)一律`UNKNOWN_BLOCKED_LANES`不進AI，
禁止fail-open。Escape valve（重用`anomalyClassification.js#
detectNonCollisionAnomaly`+獨立事故/完全封閉關鍵字，非重造`classify.js`第二
套系統）防止「施工造成雙向完全封閉」被誤判為一般施工擋下。`blockedLanes`
新增進`aiCandidate.js#buildAiCandidate()`結構化AI輸入（PBS恆為null，純新增
欄位）。V2.4.4 denylist硬閘門與AI prompt第四類錨點均保留為第二層safety net。

**架構銜接**：`normalize.js`保留完整座標證據(positions[]/longitude/latitude，
重用`hsinchuFilter.js#extractPositions`)；`serviceArea.js`TDX分支改委派同一個
`resolveTdxHsinchuGeography()`，`aiCandidate.js`Gate2與
`aiApprovedPbsBroadcast.js`既有V2.4.4 Gate3自動使用同一canonical結果，Gate B
(LINE前複查)零新增程式碼；`crossSourceDedup.js#buildCanonicalEvent()`補上座標
傳遞(否則PBS+TDX合併事件會因缺座標退化為UNKNOWN誤擋)。

**部署政策**：`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED`維持"false"
(FETCH/QUEUE維持"true")，進入觀察期，待人類確認桃園/苗栗/頭份/竹南=0
candidate、真實新竹事件正常通過、UNKNOWN正確攔截後才另行決定開啟。

**測試**：`test/tdxHsinchuGeoResolver.test.js`(19項，CASE1-10+39.6K永久回歸鎖定)
／`test/tdxRoadManagementPolicyGate.test.js`(21項，CASE1-10)全過；既有~22個檔案
的TDX fixture補上座標證據(含發現`crossSourceDedup.js`座標傳遞缺口)；`git stash
-u`同commit精確基準52項失敗，全量迴歸NEW_FAILURES=0。**未觸碰**：Windows
PBS/pbs-relay/PBS本機篩選/PBS AI候選/PBS LINE路徑/Workers AI模型/AI prompt
路肩政策原文(僅結構輸入新增blockedLanes)/Incident Memory/CCTV/LINE
messageFormat/60字上限。`APP_VERSION`V2.4.4→V2.4.5（MINOR）。

## 修正紀錄｜V2.4.4 — TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX（2026-09-02，壓縮摘要）

**背景**：TDX重接AI後3問題——(A)台61線39K+600(實為桃園觀音)誤發LINE；(B)例行施工/機動路肩開關等一般道路管理事件誤發；(C)TDX訊息仍是通用模板，description/blockedLanes未進LINE。

**FIX A**：根因是`hsinchuConfig.js`台61線KM表本身把39.6K算範圍內(該檔自承未經驗證)，且`aiApprovedPbsBroadcast.js`從未複查服務區域。新增`serviceArea.js#resolveHsinchuOnlyProductionEligibility()`——denylist-only二次gate，事件文字正面提及新竹以外地名(含頭份/竹南/三灣=苗栗)即擋下，即使AI notify=true。刻意不重猜KM表(曾試收窄致~30項collateral failure後revert)。

**FIX B**：SYSTEM_PROMPT新增第四類錨點——例行施工/機動路肩開關/一般封閉維護預設notify=false，除非含事故/重大障礙/坍方落石/車道突發封閉/其他安全風險。純prompt文字，無code-level白名單。

**FIX C**：`TDX_INFORMATION_LOSS_FILE=messageFormat.js`／`_FUNCTION=buildSourceFactLine`(normalize.js早已保留description，是formatter自己PBS-only gate丟棄)——放寬source gate為PBS+TDX(60字上限不變)，非第二套formatter。

**部署政策**：`TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED`重設回"false"(FETCH/QUEUE仍"true")，待Production觀察後由人類＋Claude Browser另行決定重新開啟。

**未觸碰**：Queue架構、Incident Memory、collision window、CCTV/R2、PBS Windows polling、PBS服務區域resolver本身、LINE quota、TDX排程、V2.4.3機制。**測試**：CASE1-14全過，NEW_FAILURES=0。`APP_VERSION`V2.4.3→V2.4.4。

## 修正紀錄｜V2.4.3 — AI_TIMEOUT_AND_STALE_RETRY_RELIABILITY_FIX（2026-09-01，壓縮摘要）

**背景**：`EVENT_ID 11509010029-5` 3次AI attempt各約236秒後"3046逾時"，LINE未發送；attempt2執行中PBS另送CLEARED，舊NEW retry未停止仍呼叫AI。**根因**：`aiDecisionEngine.js#callWorkersAi` 原無app-level timeout——236秒/"3046"為PLATFORM側（Workers AI binding）行為，非repo設定，無即時文件可外部確認；該事件payload無異常跡象，`FAILED_EVENT_PAYLOAD_ABNORMAL=NOT_VERIFIABLE`，未裁剪資料。

**FIX 1**：新增 `AI_CALL_TIMEOUT_MS=45000`（order建議30-60秒中點，工程判斷），caller-side `Promise.race` fail-fast——真正取消未經確認，但`callWorkersAi`零side effect故安全；retry次數/delay不變。**FIX 2**：新增 `debug:pbs-event-cleared:v1` KV marker(48h TTL)，NEW/UPDATED attempt前檢查clearedAt晚於generatedAt即取消——新outcome `STALE_AFTER_CLEARED`，沿用既有idempotency COMPLETED狀態，不觸碰notified-state。**Observability**：新增`timedOut`欄位，查修頁區分「AI：逾時」與「事件已解除」。

**未觸碰**：LINE formatter、V2.4.2政策、TDX、Memory、CCTV、R2、NOTIFY開關；AI failure仍fail-closed。**測試**：CASE1-12全過，迴歸1802 tests NEW_FAILURES=0。`APP_VERSION` V2.4.2→V2.4.3（PATCH）。

## 修正紀錄｜V2.4.2 — PBS_AI_LINE_INFORMATION_FIDELITY_AND_POLICY_FIX（2026-09-01，壓縮摘要）

**背景**：坍方事件 AI `reason` 正確理解「道路阻斷、多車受困」，LINE 卻只剩「請留意路況」；明確事故判 `notify=false`；單純車多判 `notify=true` 洗版。**根因**：`messageFormat.js#formatEventMessage` 固定依 type 選字，從未讀 `event.description`／`sourceDetail`，儘管 AI 已完整看到兩者；與 `PBS_PRECISE_COMMENT_LOCATION_NOT_USED_BY_LINE_FORMATTER` 同根因。

**FIX A**：`messageFormat.js` 新增3條增量行——PBS comment摘要(`source==='pbs'`限定,60字上限)、「通報：XXX」、「⚠️封閉N車道」。**FIX B**：`aiDecisionEngine.js` SYSTEM_PROMPT重寫(schema不變)：改為「值不值得提前知道」——事故notify=true不需證壅塞/風險notify=true即使未壅塞/單純車多notify=false。**FIX C（`EVENT_ID 11509010029-5`）**：發現LINE未發送，本輪僅唯讀調查，未做reliability修正——見下方 V2.4.3 章節（同日稍晚，已修正機制面問題）。

**測試**：`test/v242InformationFidelityAndPolicy.test.js` CASE1-12全過。全量迴歸1790 tests NEW_FAILURES=0。`APP_VERSION` V2.4.1→V2.4.2（MINOR）。

## 修正紀錄｜V2.4.0 — TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE（2026-09-01，Phase B）

**背景**：先前一輪唯讀架構稽核（`TDX_FREEWAY_PROVINCIAL_TO_AI_MAIN_AUDIT`）確認 TDX 國道/省道 RoadEvent 可在不重造第二套決策系統的前提下重新加入既有的 Queue/AI 架構，前提是跨來源（PBS＋TDX）同一實體事故要能被 AI 自己判斷「是否同一起、是否有實質變化」，而非各來源獨立各判各的。

**修正**：新模組 `src/traffic/incidentMemory.js`（Recent Incident Memory，Cloudflare KV `traffic:incident-memory:v1`，8h TTL，`MEMORY_KV_GETS_PER_EVENT<=1`／`MEMORY_KV_PUTS_PER_EVENT<=1`、`WRITE_ON_CHANGE=YES`），road+direction → 1000m/1.5km 內 → 最近 8h → 最多 5 筆候選的三層 prefilter，並排除事件自己剛寫入的紀錄（`selectMemoryCandidates` 的 `excludeEventId`，避免事件把自己的 sighting 誤判為附近另一起事故，進而讓 AI decision cache 誤判為「有新 context」而多打一次 AI）。新模組 `src/tdx/tdxQueueIngress.js`：TDX 新／更新事件送進**同一個** `PBS_AI_QUEUE`，沿用 `dedupe.js`／`debugPush.js` 既有 fingerprint／idempotency／訊息建構，絕非第二套 Queue。`src/pbs/debugPush.js#processQueuedPbsEvent` 依 `source` 分派：`pbs` 維持原本 `normalizePbsEvent` 路徑，`freeway`／`highway` 直接使用已正規化的 RoadEvent，絕不互相套用對方的原始 shape。AI schema 新增 `sameIncident`／`materialChange`（僅在有 memory context 時要求），AI decision cache key 併入 `memoryContextFingerprint`（未提供時與本輪之前完全相同的 hash，向下相容）。

**Phase B 閘門**：`suppressLineNotify = source === 'freeway' || source === 'highway'` **硬寫死**在 `debugPush.js` 單一呼叫點，非任何 `wrangler.jsonc` 變數——AI 真的跑、Memory 真的讀寫，但 TDX 來源的事件本輪還不會真正推播 LINE；要進 Phase C 需要未來一次明確的程式碼變更（移除這個硬寫死的 `true`），絕非改設定值就能達成。**`LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT`**：`scheduled.js` 的 `broadcastEvents` 不再包含 `summary.allEvents`——即使單獨打開 `TDX_ROADEVENT_FETCH_ENABLED`，TDX 事件也無法回到舊 V1.5 硬規則 LINE 路徑。三個新 `wrangler.jsonc` 開關（`TDX_ROADEVENT_FETCH_ENABLED`／`TDX_ROADEVENT_QUEUE_INGRESS_ENABLED`／`TDX_CCTV_METADATA_REFRESH_ENABLED`）預設全部 `"false"`，疊加在 `TRAFFIC_SOURCE_MODE` 之上非取代。`incidentSuppression.js` 不大拆，保留為短期重複推播安全網。

**明確未觸碰**：CCTV 整條 metadata-cache→選鏡→compose→R2-put→R2-read-back-verify→LINE 管線（V2.3.3 原封不動）、VD／CMS／其他 Traffic API（未復原）、CCTV metadata refresh Cron（維持 MANUAL/ON-DEMAND）、Google Maps。`CCTV_RUNTIME_TDX_CALLS=0`。

**測試**：新增 `test/tdxUnifiedAiPipeline.test.js`（order 自訂 17 個 CASE 全過：跨來源同事故辨識、30分/70分/第三小時記憶延續、>8h 記憶排除、TDX 失敗不影響 PBS、CCTV 0 額外 TDX 呼叫、Memory 寫入成本 0/<=1、Observatory 開啟 0 AI/0 KV），另 8 個既有測試檔（`broadcastEligibility`／`pbsLineBroadcast`／`v572TdxGatedFreewayBroadcast`／`pbsOnlyCrossSourceDedup`／`incidentRepeatSuppression`／`tdxUsageReduction`／`pipelineTraceIntegration`／`aiObservatoryView`）改寫以反映 TDX-legacy-retirement 的刻意行為變更。全量迴歸 1746/1712/34，與既有 34 項基準以 failure 名稱集合對照確認 NEW FAILURES=0，僅跑一次。`npm run check:deployment-policy` PASS；`wrangler deploy --dry-run` 確認 bindings 乾淨、唯一一個 Queue、三個新開關均為 `"false"`。`APP_VERSION` V2.3.3→V2.4.0（MINOR）。**本輪未啟用任何真實 TDX 抓取**——只建好機制，實際打開（Phase A：FETCH_ONLY）需要另一次明確的人類指示；**不得自行進 Phase C**。

## 修正紀錄｜V2.3.3 — CCTV_R2_READBACK_VERIFY_BEFORE_LINE（2026-08-31，壓縮摘要）

**一句話**：上一輪唯讀查核確認 CCTV await 鏈本身安全但無法解釋一筆真實破圖事故，改為新增本 codebase 能自己保證的一件事——`publishedImage.js#verifyPublishedImageReadable()` 在 R2 put 成功後、imageUrl 回傳前，內部 R2 GET 確認物件存在／Content-Type 為 `image/jpeg`／bytes 非空，接上 quad 與 single 兩條 CCTV 發布路徑。新失敗代號 `r2-readback-failed`，fail-closed 處理與既有完全相同。`TDX_CALL_CHANGE=0`。8 項新/擴充測試，1729/1695/34，NEW FAILURES=0。`APP_VERSION` V2.3.2→V2.3.3（PATCH）。

## 修正紀錄｜V2.3.2 — CCTV_PRODUCTION_IMAGE_DIAGNOSTIC_REPAIR（診斷工具修復）（2026-08-30，壓縮摘要）

**一句話**：真實事件 `EVENT_ID=11508310005-5` 破圖，但唯一能驗證「剛 publish 完是否立即 200+JPEG」的診斷工具 `GET /admin/cctv-hsinchu-publish-test` 本身無法使用（依賴需要真實 TDX 呼叫才能重建的 `CANDIDATES_KEY`，PBS_ONLY 下不可為診斷消耗）。修正：改由**同一份** `cctv:freeway-metadata:v1` cache-only 攝影機清單取得候選（新函式 `composeCollageFromFreewayMetadata()`），`TDX_CALLS_PER_TEST=0`。回應新增 `step` 失敗分類欄位（`METADATA_CACHE_MISSING`／`NO_CCTV_CANDIDATES`／`SNAPSHOT_FETCH_FAILED`／`COMPOSE_FAILED`／`R2_PUBLISH_FAILED`）。22 項新/改寫測試，1722/1688/34，NEW FAILURES=0。`APP_VERSION` V2.3.1→V2.3.2（PATCH，診斷工具修復非產品功能）。詳見 `hsinchuCctvProbe.js` 自身 module comment。

## 修正紀錄｜V2.3.1 — DIRECT_COORDINATE_MAP_FALLBACK（LINE 地圖座標直連 Hotfix）（2026-08-30）

**真實事件**：`EVENT_ID=11508260158-0`，竹60線（縣道）新竹縣尖石鄉坍方封路事件。PBS／Windows／Cloudflare 全程保留有效 x1/y1 座標，AI 正常完成，LINE 已發送，但**完全沒有 Google Maps 連結**。**根因**（同日先行完成的唯讀查核已確認）：`messageFormat.js#buildRoadLines()` 的兩層地圖連結解析（`resolveKmLocation` 道路+KM 路徑、`resolveCoordinateLocation` 座標路徑）都要求 `event.road` 先被 `canonicalFreewayRoad()`／`canonicalProvincialRoad()` 辨識成「國道X號」或「台X線」才會使用座標——竹60線這類縣道／鄉道從未被本專案僅有的官方國道（95016）／省道（7040）公里標資料集涵蓋，座標路徑因此在真正比對座標之前就被 road 判斷擋下，有效座標被完全捨棄。

**修正**：新增一層**最後手段**（僅在既有兩層都失敗後才觸發）：`kmLocationResolver.js` 新匯出 `buildDirectCoordinateMapUrl(latitude, longitude)`，直接重用既有 `buildMapUrl()` 產生 `📍 地圖 https://maps.google.com/?q=lat,lon`，**不辨識道路、不查資料集、不猜測 sectionLabel/locationLabel/鄉道名稱/公里位置**——只決定地圖那一行有沒有連結，不影響上方文字。座標合法性把關（`isValidRawCoordinate`）：拒絕 null/undefined/NaN/Infinity/非數字型別/超出緯經度合法範圍/精確 (0,0)「null island」。`roadName.js`／`canonicalFreewayRoad`／`canonicalProvincialRoad`／官方資料集本身皆**未觸碰**——縣道/鄉道公里標資料工程仍是刻意未開始的更大範圍問題。

新增 `test/pbsCoordinateDirectMapFallback.test.js`（13 項：拒絕輸入型態單元測試、CASE 1-6、含真實 `EVENT_ID=11508260158-0` 端對端 fixture，road 全程維持「新竹縣-尖石鄉」，未硬編碼「竹60」）；既有 KM/座標解析測試檔全數重跑不變、全部通過，證實零回歸。全量迴歸 1718/1684/34，NEW FAILURES=0。`APP_VERSION` V2.3.0→V2.3.1（PATCH）。本輪**未觸碰**：AI Prompt/model、Windows PBS filter、Queue、LINE 廣播政策、Observatory 架構、TDX、CCTV，亦未開始縣道／鄉道公里標資料工程。詳見 `kmLocationResolver.js` 的 `buildDirectCoordinateMapUrl` 自身 header comment。

## 修正紀錄｜V2.3.0 — PBS AI Queue Reliability，Cloudflare Queues 取代 ctx.waitUntil（2026-08-30）

**真實Production事故**(與V2.1.0修的不同一種失敗模式)：`EVENT_ID=11508290166-0`成功抵達Cloudflare並啟動Workers AI呼叫(16:49:03.112)，但AI呼叫在`ctx.waitUntil()`背景執行時間預算到期前未能回傳——與Windows短HTTP timeout(V2.1.0已解決)無關的另一種限制。16:49:32.912平台強制取消整個task("waitUntil() tasks...cancelled")，AI決策永久遺失，冪等紀錄卡死`PROCESSING`。`REAL_INCIDENT_ROOT_CAUSE=WAITUNTIL_BACKGROUND_WINDOW_EXCEEDED`。

**修正**：`ctx.waitUntil()`全面退休做為AI背景執行載體(`WAITUNTIL_AI_PROCESSING='RETIRED'`)，改用唯一一個Cloudflare Queue(`pbs-ai-processing-queue`，binding`PBS_AI_QUEUE`，`wrangler.jsonc`為唯一正典設定來源)：HTTP ingress只驗證/寫冪等PROCESSING/寫Observatory`PROCESSING_STARTED`/`Queue.send()`，只有send成功才ACK`accepted:true`(失敗回傳真實503，絕不假報已接收)；獨立Queue Consumer(`src/index.js`新增`queue()`export→`handlePbsAiQueueBatch`→`processQueuedPbsEvent`)承接全部AI/LINE/Observatory-final工作，與原始HTTP request/`ctx`無關，重用(非重造)既有AI candidate/decision engine/cache/LINE廣播/Observatory writer。

**重試邊界（關鍵設計）**：`AI_CALL_FAILED`(呼叫未可靠完成——網路/5xx/容量/timeout)現在可Queue重試，`MAX_QUEUE_RETRIES=3`；既有`AI_DECISION_INVALID`(答案格式無效)fail-closed政策不變——絕不重試。新增終態`AI_OUTCOME.PROCESSING_FAILED`(重試耗盡後Consumer寫入，標記冪等COMPLETED，不讓事件卡在PROCESSING)。Queue遞送`AT_LEAST_ONCE`，業務結果要求`EFFECTIVELY_ONCE`：已COMPLETED的重複遞送直接ack略過，0額外AI呼叫/LINE推播。

**開發期間發現並修正的Observatory KV key重複bug**(測試驅動發現)：Queue Consumer是獨立invocation，自己的`now`與HTTP ingress原始接受時間不同，直接沿用會讓最終寫入建立第二筆KV紀錄而非覆寫早期`PROCESSING_STARTED`。修正：從queue message的`acceptedFirstAcceptedAt`重建`observatoryNow`專供兩次Observatory寫入key使用，真實`now`仍用於業務決策(AI呼叫/LINE時段閘門)與`markProcessingComplete`的`completedAt`。

`RAW_PBS_TEXT_POLICY=IMMUTABLE_END_TO_END_UNTIL_AI`不變。**KV成本**(實測)：`puts=4N+2`(與V2.2.0同)，`gets=6N`(+1/事件)。**Queue成本**(估算)：成功2次operation，重試耗盡最差5次；50/100/200事件/日最差250/500/1000次，遠低於10,000/日免費額度。新增`test/pbsAiQueueReliability.test.js`(含真實事故迴歸fixture)，改寫`pbsDebugPushBackgroundProcessing.test.js`5項過時測試。1705項/1671 pass/34 fail，NEW_FAILURES=0。`APP_VERSION`V2.2.0→V2.3.0。未觸碰：Windows PBS filter/HTTP timeout、PBS原始文字、AI prompt/model、service area、LINE formatter、driverSummary、TDX、CCTV、Shared Feed。`BROWSER_ACTION_REQUIRED`：真實Cloudflare Queue資源需Dashboard/`wrangler queues create`建立，sandbox無法驗證。**2026-08-30補記**：人類回報稱已由Production驗收，本Session未取得可核對證據，維持原狀待補。

## 修正紀錄｜V2.2.0 — AI Decision Observatory 四層事件生命週期（2026-08-29，深度壓縮）

把既有 AI Decision Observatory 升級成「單一事件四層生命週期查修頁」——①PBS/Windows
②Cloudflare③AI④LINE，每層顯示成功/未執行/失敗/未知，一眼看出事件卡在哪層。純
backward-compatible擴充，未改AI語意/Windows PBS filter/LINE policy/V2.1.0架構。
**RAW_PBS_TEXT_VISIBLE**：原截斷120字的`commentSummary`退休，改`rawComment`/
`rawSourceDetail`完整未截斷儲存。**FAILURE_EVENT_VISIBILITY**（本輪真正缺口）：
`ctx.waitUntil`背景處理中途crash原本Observatory完全無紀錄，本輪`processAcceptedEvent`
一開始就寫入`PROCESSING_STARTED`，停滯/crash事件仍有卡可查。**KV成本**（實測）：
`puts=4N+2`，200 events/day為802 puts/day，遠低於Free Plan每日1,000額度上限；
REUSE_EXISTING_DATA_FIRST全程遵守，零新增KV prefix。零副作用不變：開啟/搜尋本頁
0次AI呼叫/0次KV寫入。`APP_VERSION`V2.1.0→V2.2.0。新增16項測試全過，全量迴歸
1697/1663/34，NEW_FAILURES=0。未觸碰：Windows PBS/ctx.waitUntil架構/AI Prompt/
service area/LINE policy/Shared Feed/CCTV/TDX。詳見`03_ARCHITECTURE.md`。

## 修正紀錄｜V1.9.9 Phase 1 — Windows Service Area Hsinchu Only（2026-08-28，完成於另一個 session，本 Cloud Session 未參與，port 進本模板僅為維持一致）

`V1.9.9_PHASE_1 = WINDOWS_SERVICE_AREA_HSINCHU_ONLY`。Windows PBS Local Edge
Filter原先以竹南／頭份文字直接納入，且國1／國3公里上限與座標bounding box過寬，
可能把苗栗事件送入正式Business Pipeline。本輪只修改`pbs-relay/src/
localPrototype.js`（Windows端，本輪首次隨main一起commit，不再是未合併的feature
branch），重用既有`src/pbs/hsinchuFilter.js`與`src/pbs/roadName.js`：新竹市、
新竹縣、竹北、湖口、新豐、關西納入；竹南、頭份、苗栗市與其他苗栗縣區域排除；
同一道路只納入新竹段；座標不得再單獨授予服務區資格。lifecycle完全未改。
`AI_INTEGRATION=NOT_STARTED`；`LINE_POLICY=UNCHANGED`。Targeted 12/12、root
invariants 73/73、Windows PBS full suite 121/121 PASS，NEW FAILURES=0。Fix
commit `7acb82a`；Cloudflare Worker Version ID `defc1da4-6328-47ce-82c6-
81082519bc2`，Windows `TrafficReporter-PBS-LocalMonitor`已重啟為Running
（人類回報，本Session未獨立驗證）。

## 修正紀錄｜V2.1.0 — Transport Ack Decoupled From Business Processing（2026-08-29，壓縮摘要）

**一句話**：真實 Production 事故——Windows 自身 5 秒 HTTP timeout 在 Cloudflare 仍 `await` 真正 Workers AI 呼叫時觸發，因為那段工作從未交給 `ctx.waitUntil()`，client 斷線時 handler 直接被取消，AI 判斷／LINE／Observatory 全部沒完成，冪等記錄卻已提前寫入，永久擋下 retry。修正兩部分：(1) `src/index.js` 的 `fetch` handler 轉傳 `ctx`，`debugPush.js` 把 business processing 交給 `ctx.waitUntil()`，HTTP 回應只代表「已持久接收」不再代表「AI 已判讀完成」；(2) KV 冪等記錄新增兩階段標記 `PROCESSING`/`COMPLETED`，`PROCESSING_STALE_MS=60秒` 容許復原重跑。同時正式寫入四層架構角色邊界：`WINDOWS_ROLE`/`CLOUDFLARE_ROLE`/`AI_ROLE`/`LINE_ROLE`/`RAW_PBS_TEXT_POLICY=IMMUTABLE_END_TO_END_UNTIL_AI`（詳見 `03_ARCHITECTURE.md`）。以真實事件 `EVENT_ID=11508280025-5` 再次驗證 PBS 原文逐字完整送進 AI prompt。9 項新測試，1681/1647/34，NEW FAILURES=0。`APP_VERSION` V2.0.2→V2.1.0（MINOR）。此輪的 `ctx.waitUntil()` 架構本身後來被 V2.3.0 的 Cloudflare Queue 取代（見上方 V2.3.0 條目）——歷史修正仍成立，僅承載機制已演進。

## 修正紀錄｜V2.0.2 Config Drift Hotfix — PBS_AI_DECISION_ENABLED canonical deployment（2026-08-29，壓縮摘要）

**一句話**：GPT Work 在 Dashboard 手動設定 `PBS_AI_DECISION_ENABLED="true"` 後被下一次 `wrangler deploy` 悄悄移除（Workers Builds 每次部署都把 `wrangler.jsonc` 視為權威來源，與 `TRAFFIC_SOURCE_MODE` 既有機制相同）——17:49 台68事件當時 AI switch 已被移除，該筆非真實 AI 判讀事件。修正：`wrangler.jsonc` 的 `vars` 正式宣告 `"PBS_AI_DECISION_ENABLED": "true"`（字串），`PBS_AI_DECISION_ENABLED_SOURCE=WRANGLER_CANONICAL_VAR`，`DASHBOARD_ONLY_AI_SWITCH=RETIRED`，未加 `keep_vars`。新增 `checkPbsAiDecisionEnabledVar()` regression guard。10 項新測試，1549/1516/33，NEW FAILURES=0。`APP_VERSION` V2.0.1→V2.0.2（PATCH）。

**另記已知問題**：`PBS_PRECISE_COMMENT_LOCATION_NOT_USED_BY_LINE_FORMATTER`。**RESOLVED_V2_4_2**——見「V2.4.2」章節。

## 修正紀錄｜V2.0.1 — AI Decision Observatory（2026-08-29，壓縮摘要）

**一句話**：新 Admin 頁 `GET /admin/pbs-ai-observatory-view` 答「PBS 原文→AI 判斷
→理由→結果」，READ ONLY（開啟/整理/搜尋 0 次 AI 呼叫）。盤點後確認無法零額外
KV 寫入，新增最小 thin index `aiObservatoryIndex.js`（48h TTL），每接受事件 +1
write／+0 read，notify/impact/reason/confidence 刻意不重複儲存、頁面即時讀既有
`aiDecisionCache`（`reason` 保證非重新生成）。KV：`puts=2N+2`。查修頁語義全面改
V2.x vocabulary，絕不用舊版「不符合播報資格」。22 項新測試，1539/1506/33，NEW
FAILURES=0。「重複事件」篩選永遠回傳 0 筆非 bug——duplicate 在 transport
idempotency 層就被攔截，從未產生 observatory 記錄。

## 修正紀錄｜V2.0.0 MILESTONE — Windows PBS + Workers AI 架構封版（2026-08-28，壓縮摘要）

重大架構里程碑封版，非新功能開發，`APP_VERSION` V1.9.9→V2.0.0，本輪未改任何
runtime 決策邏輯。誠實保留兩項既有已知限制：(1) `FIRST_REAL_AI_EVENT=WAITING`
——真實事件走完 Windows→Cloudflare→Workers AI→LINE 完整路徑的觀察證據尚未取得
（下個 observational milestone，非 blocker；`AI_BINDING`/`AI_DECISION`=ACTIVE
為 GPT Work 回報，本 Session 未獨立驗證）；(2) `KV_ONLY_ATOMICITY=NOT_SUFFICIENT`
（V1.9.7 既有限制不變，`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY=PARTIAL`）。

## 修正紀錄｜V1.9.9 Phase 3D Hotfix — Cloudflare 字串布林解析（2026-08-28，壓縮摘要）

根因：Cloudflare Dashboard／CLI Variables 一律以字串注入 Worker，`src/pbs/
aiConfig.js#resolvePbsAiDecisionEnabled()` 原本嚴格檢查 `typeof ===
'boolean'`，字串 `"true"` 永遠不符合，導致 GPT Work 在 Dashboard 設定的
`"true"` 悄悄落回安全預設值 `false`。修正：resolver 同時接受真正
boolean 與 Cloudflare runtime 字串形式（`"true"`/`"false"`，不分大小寫
去除空白），其餘一律 fail-safe 回 `false`，不做寬鬆 truthy 判斷。新增
8 項測試（`test/aiConfig.test.js`、`test/pbsAiDecisionScenarios.test.js`），
全量迴歸 1517/1484/33，NEW FAILURES=0。單點 config parsing hotfix，
APP_VERSION 維持 `V1.9.9`。此問題與 V2.0.2 記載的「Dashboard-only 設定
被 Workers Builds 覆寫」是同一根本模式（wrangler.jsonc 權威 vs Dashboard
易失狀態）在不同層次的兩次重演，V2.0.2 已將 canonical source 移至
wrangler.jsonc 徹底解決；完整字串/布林矩陣測試細節見對應測試檔案本身。

## 修正紀錄｜V1.9.9 Phase 3B — Workers AI Driver Impact Decision Integration（2026-08-28，深度壓縮）

首次接上真實Workers AI（model `@cf/zai-org/glm-4.7-flash`）判斷駕駛通行影響。新模組：`aiConfig.js`（kill switch `PBS_AI_DECISION_ENABLED`）、`aiDecisionCache.js`（48h TTL）、`aiDecisionEngine.js`（嚴格schema校驗）、`aiApprovedPbsBroadcast.js`（AI開啟時與legacy `runLineBroadcast()`互斥，避免雙重判官）。AI失敗（429/5xx/invalid/binding missing）一律0 LINE、絕不fallback舊硬規則。57項新測試全過，1509/1476/33，NEW FAILURES=0。**此輪記錄的Production狀態已被V2.0.0/V2.0.1/V2.0.2取代——特別是V2.0.2修正了kill switch Dashboard-only設定被deploy覆寫的根因問題，最新狀態見SYSTEM_STATE.json。**

## 修正紀錄｜V1.9.9 Phase 2 — AI-ready Business Pipeline Simplification（2026-08-28，深度壓縮）

為Phase 3 Workers AI判讀鋪路。找到三個當時擋下候選PBS事件的既有硬規則（`broadcastPolicy.js` MAJOR_ACCIDENT_ONLY／`broadcastRules.js` V1.5 whitelist／`locationQuality.js` hard-reject），新增`src/pbs/aiCandidate.js`（純函式）：`buildAiCandidate()`建最小candidate物件、`isWindowsPbsAiCandidateEligible()`只重用service area既有resolver為唯一gate。`debugPush.js`並行呼叫、純log觀察（`PBS_AI_DECISION_MODE='PREPARED_NOT_ACTIVE'`），從未影響真實LINE決策。預留`computeAiDecisionCacheKeyHash`/cache key schema供Phase 3B採用。新增28項測試，1452/1419/33基線，NEW FAILURES=0。

## 修正紀錄｜Windows PBS Push → Production Business Pipeline ＋ PBS 輪詢退休（V1.9.8）（2026-08-28，壓縮摘要）

V1.9.7關閉了持久冪等風險後，本輪把六階段路線圖Phase 3-6合併完成：`src/pbs/
debugPush.js`就地升級為正式Production Ingress（Option A，非另建endpoint）。
新函式`buildRawPbsRecordFromPush()`把Windows payload組成raw-PBS-shaped record
（`happendate`/`happentime`/`modDttm`由`generatedAt`精確反推Asia/Taipei本地
時間字串，UTC+8固定無DST，非近似值；`roadtype`留空，因Windows本機過濾器已保證
comment含事故關鍵字），交給既有未修改的`normalizePbsEvent()`→`runLineBroadcast()`
（與Cron輪詢路徑同一函式，同一套service area/policy/location quality/dedupe/
CCTV/notified-state判斷）→`runSharedFeedPersist()`。CLEARED只ACK/log，刻意不進
`runLineBroadcast`（比照`pbs/pipeline.js`既有clearedEvents行為）。LINE Push
Policy（`MAJOR_ACCIDENT_ONLY`）完全未變動。同時Cloudflare自身PBS 30分鐘輪詢
正式退休：`pbsConfig.js`新增`PBS_30_MIN_POLLING_ENABLED=false`（env可覆寫，
Production不設此var，僅供既有PBS/CCTV測試套件沿用），`pbsSchedule.js`/
`pbs/pipeline.js`/`pbs/lifecycle.js`程式碼一行未刪，翻回旗標即可rollback。
已知可接受副作用：`pbs:lifecycle-state`不再寫入、`/health`的pbs區塊凍結在
退休前最後數值。KV成本剖面誠實修正：N筆事件→`gets=5N`/`puts=N+2`。新增
`test/pbsDebugPush.test.js`施工令十五項最低清單 + `test/pbsPollingRetirementV198.
test.js`（4項），1424/1391/33基線，NEW FAILURES=0。

## 修正紀錄｜Persistent PBS Debug Push Idempotency（V1.9.7）（2026-08-28，壓縮摘要）

真實觸發：V1.9.6首筆事件驗收（台68西向5K，Windows早Cloudflare舊輪詢約12.1分鐘）
證明channel正常，但V1.9.5的冪等只有per-isolate記憶體（`NOT_PERSISTENT`），isolate
換掉/重啟/redeploy可能讓同一事件重新被accept。修正：`src/pbs/debugPush.js`新增
TRAFFIC_KV下獨立debug-only前綴`debug:pbs-push-idempotency:v1:*`（`IDEMPOTENCY_KV_
PREFIX`，絕不觸碰任何business key）作為L2持久層，key=SHA-256(source:eventId:
lifecycle:fingerprint)決定性產生（不用requestId，因同事件重試requestId本就不同），
48h TTL。L1既有記憶體Map保留為快取但非唯一真相，L1 miss一律查L2才能accept。實測
KV成本：10/30/100筆相異事件/日各花10/30/100次get+put（1 accept=恰好1次寫），
duplicate（含5次重試）僅1次put+6次get，加既有~118 writes/day基線→約128/148/218
writes/day，遠低於1,000上限，`KV_WRITE_PRESSURE=LOW`。誠實回報`KV_ONLY_ATOMICITY=
NOT_SUFFICIENT`（KV無compare-and-swap，理論極窄race window仍存在）——依施工令
「不要過度設計」指示不引入Durable Object：本輪要關閉的風險（isolate換掉/重啟/
redeploy造成**事後**重複accept）已被持久KV層完全解決，與**同時**發生的race是不同
問題；此endpoint零business side effect（LINE/CCTV/Shared Feed/正式KV皆0），race
最壞後果僅冗餘debug log。故`PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY`誠實標記
**`PARTIAL`**（非ACTIVE非NOT_SOLVED）——**V1.9.8已將此endpoint接上真正的business
side effect（LINE/Shared Feed），沿用此PARTIAL設計未變動，Durable Object評估仍未
進行，若未來race實際造成問題才需重新評估**。KV outage時fail OPEN（事件仍
accepted）。既有Debug API JSON schema完全不變。新增52項測試（原33項）涵蓋施工令
20項清單，NEW FAILURES=0（1404/1371/33基線）。

## 封版紀錄｜PBS Windows Local Edge Debug Push Integration（V1.9.6）（2026-08-27，深度壓縮）

治理封版令：Windows 本機常駐邊緣篩選＋Debug Push 整合（接上 V1.9.5 的 Cloudflare
Debug-only 接收端）。架構：PBS→Windows 3分鐘抓取→Local Edge Filter（重用
Production `hsinchuFilter.js`/`roadName.js`）→生命週期比較→SHOULD_PUSH→
`POST /internal/pbs-debug-push`→Debug-only Receiver（不進 LINE/CCTV/R2/Shared
Feed/正式 Business KV）。兩個真實 bug 已修：服務區舊寬鬆矩形誤收國3
55.8K鶯歌／國1 68.1K楊梅（改 import Production resolver）；CLEARED 單輪缺席
誤判（改連續2輪缺席或明確解除文字才 CLEARED）。**Secret 治理教訓（永久規則）**：
Secret 在 Dashboard 存在 ≠ 已進入 Active Production Version——曾因新 Secret
只在新 Worker Version、Active Deployment 仍是舊版而持續 503，真人 promote 後
恢復；未來新增/修改任何 Secret 後必須確認其 Version 是否為 Active Deployment。
現行 PBS 輪詢完全保留，退休時機在路線圖 Phase 6（未到）。冪等狀態後續由
V1.9.7 更新為 PARTIAL，見該條目。完整細節（Mock 驗證證據、路線圖分期、
Windows Task Scheduler 設定）已隨版本推進而失去時效性，如需考古見 git 歷史
本檔案舊版本。

## TDX 還原程序（RESTORE TDX）

**前提**：真人確認 TDX 額度確實已恢復。

1. `wrangler.jsonc` 把 `TRAFFIC_SOURCE_MODE` 改成 `"ALL"`（或整個刪掉該 var——缺席即等同 ALL）。
2. push 到 `main`，Workers Builds 自動重新部署。
3. 下一個分鐘 00/20/40 的 tick 就會自動恢復 TDX 國道／省道抓取與 CCTV 補圖。`tdxSchedule.js` 全程未被本次修改碰過，排程邏輯原封不動。
4. 驗證：`GET /health` 應顯示 `sourceMode.trafficSourceMode = ALL`，且下一個 20 分鐘整點 tick 的 log 顯示 `tdxScheduleState=scheduled`。

**不需要重寫任何 TDX 功能。沒有第二個開關。** 完整說明寫在 `src/traffic/sourceMode.js` 的 module comment（單一權威來源）。

## 已知架構限制（非 bug，設計上已知的邊界）

- **Pipeline Trace 頁面禁止任何 client-side JavaScript**（既有嚴格 Admin CSP，`default-src 'none'`，無 `script-src` 例外）。V1.8.7.6 已確認的「表單重新送出無效」症狀，最終結論是特定瀏覽器的 client-side 行為，本專案程式碼層面無法修復，只能靠直接 URL 導航（已驗證 100% 正常）繞過。
- **Cloudflare Dashboard-only 設定永遠無法從程式驗證**：Production branch 指向、Cron Trigger 實際排程、Secret 是否為正確值（僅能驗證存在性，無法驗證正確性）、Build/Deployment 歷史——這些只能靠人工開 Dashboard 或 Claude Browser 唯讀查證確認，`npm run verify:production`/`check:deployment-policy` 結構上就是查不到。
- **本 session 類型的沙盒環境對 Production 完全無網路存取**（本輪與先前多輪皆已確認：對 Production Worker 網域與一般網站的 outbound HTTPS 一律被環境自身的 egress proxy 回 403）。任何需要即時 Production 證據（KV 內容、Cron log、真實 LINE 訊息渲染結果）的任務，在這類 session 中只能誠實標記「無法證明」，不能用程式邏輯推測補齊。

## 已知的機器判讀陷阱（供未來 Guard 開發參考）

- `git branch -r --no-merged main` 對以 cherry-pick 方式收編的分支會誤判為未合併（比對 commit SHA 祖先關係，不比對內容）——V1.8.7.3 分支即為實例。
- `ENGINEERING_STATUS.md` 的「main HEAD」欄位歷史上曾經長時間未同步更新（曾停留在 V1.8.6.8 時代的 SHA，直到 V1.8.7.7 封版時才發現並更正）——此欄位理想上應由 script 自動產生，而不是每輪手動記，這正是本 export 系統 `SYSTEM_STATE.json` 存在的原因之一。
