<!-- title: 已知問題（第三卷） -->

# 07. Known Issues — VOLUME 03（CURRENT）

## 卷別承接說明（ENGINEERING_MEMORY_KNOWN_ISSUES_VOLUME_03_CREATE，2026-09-07，路況-025）

- **前一卷**：`07_KNOWN_ISSUES_02.md`（正式封存為 **KNOWN ISSUES VOLUME 02**）。
- **第三卷啟用原因**：Volume 02 於路況-023 完成後為 79,489/81,920 bytes，本輪加註封存指引後為 79,617/81,920 bytes，餘裕已不足以安全容納下一輪任何新增記錄，依既有慣例（Volume 01 於 81,898/81,920、僅剩 22 bytes 時建立 Volume 02 承接）立即建立本卷。
- **本卷不取代前兩卷**：Volume 01、Volume 02 完整保留、未刪除任何一行既有記錄（禁止刪除舊 Bug／已修問題／Root Cause／技術債／歷史教訓，禁止為省空間大量改寫舊內容）——本卷只是接續，從本卷建立時刻起，新的 Known Issues 紀錄一律寫入本卷。
- **查歷史問題時的規則**：任何一輪要排查、引用、或核對「這個問題以前是否發生過／怎麼修的／為什麼這樣設計」，都必須**同時視 Volume 01（`07_KNOWN_ISSUES.md`）、Volume 02（`07_KNOWN_ISSUES_02.md`）與 Volume 03（本檔）為同一份完整資料**——只讀其中一、兩卷不足以代表完整的 Known Issues 歷史。時間順序為 Volume 01 → Volume 02 → Volume 03 依序接續；Volume 01 記錄截至 V2.4.10 封版（2026-09-04）為止的歷史，Volume 02 記錄 2026-09-04～2026-09-07（路況-023）之間的歷史。
- **索引關係**：
  ```
  07_KNOWN_ISSUES.md     → KNOWN_ISSUES_VOLUME = 01（歷史正式封存，完整保留，唯讀延伸）
  07_KNOWN_ISSUES_02.md  → KNOWN_ISSUES_VOLUME = 02（歷史正式封存，完整保留，唯讀延伸）
  07_KNOWN_ISSUES_03.md  → KNOWN_ISSUES_VOLUME = 03（CURRENT，新記錄寫入這裡）
  ```
- **容量規則延續**：本卷同樣受 81920-byte 單檔上限規範。未來若本卷也接近上限，依同一原則建立 `07_KNOWN_ISSUES_04.md` 依序延續，禁止提前刪除任一舊卷。
- **同步治理註記（與 Volume 02 開頭敘述不同，以現況為準；不回頭改寫 Volume 02 既有文字）**：Google Drive 鏡像已於路況-007 決議退休（`.github/workflows/sync-engineering-memory.yml` 已停用 push 觸發），GitHub 上的 `engineering-memory/` 為唯一正本。本卷**不需**加入 `scripts/drive-sync-manifest.json`，不涉及任何 Drive 同步。

## 處置紀錄｜traffic-reporter-v1865 worktree 已清理（2026-09-07）

**來源聲明**：本節事實由路況-024 唯讀查證與真人本機實測取得，非本 session 獨立驗證，如實轉載。

**1. 對象**：`C:\Users\mrhap\traffic-reporter-v1865`，LastWriteTime 2026-08-20 16:28，自該日起未再變動。163 個檔案、約 17MB。

**2. 性質**：為主倉庫的 git worktree，指向分支 `feature/v1.8.6.5-km-location-resolver`（HEAD `18c40c7`），`git worktree list` 標示為 prunable、未 locked。其 `.git` 為檔案而非目錄，內容指向 `C:/Users/mrhap/traffic-reporter/.git/worktrees/traffic-reporter-v1865`。

**3. 內容查證結果**：與 origin/main 比對，7 個檔案內容相同、154 個不同、2 個 origin/main 現行樹上沒有。154 個「不同」中 80 個僅為 CRLF/LF 換行差異，74 個為真正內容差異——差異方向為 origin/main 較新，v1865 停留在 2026-08-20 的舊版本，**並無 v1865 獨有的新內容**。

**4. 那 2 個現行樹上沒有的檔案**（`test/healthCctvSourceBreakdown.test.js`、`test/healthQuotaDashboard.test.js`）曾存在於 origin/main 歷史，最後出現於 commit `f45cd5e`（V1.9.2 — KV write optimization + TDX Usage Summary retirement）後被移除，內容仍可由 git 歷史取出，未因刪除 v1865 而消失。

**5. 安全性查證**：v1865 內無 log 檔、無執行期資料檔、無憑證或 token 類檔案（以 token／secret／credential／.pem／.key／.env 等關鍵字搜尋全資料夾，零命中）。其 `pbs-relay` 僅有 `auth.js`／`pbsHandler.js`／`server.js` 及對應 3 個測試，與本機現有版本僅換行差異。

**6. 與現行服務無關聯**：先前查證（路況-009／路況-022）已確認正在執行的 node 程序（PID 3968）路徑指向 `C:\Users\mrhap\traffic-reporter`，三個 `TrafficReporter-*` 排程工作的執行內容亦皆未提及 v1865。**誠實揭露**：路況-024 執行環境（Linux VM）無法查詢 Windows 程序與排程工作，該兩項在該輪標記為「查不到」；上述結論係引用先前輪次的查證結果，非路況-024 本身所驗證。

**7. 處置**：真人於 2026-09-07 執行 `git worktree remove --force C:\Users\mrhap\traffic-reporter-v1865`。採用此指令而非直接刪除資料夾的理由：直接刪除會在主倉庫 `.git/worktrees/` 留下失效的 worktree 登記，需另行 `git worktree prune` 清除；`worktree remove` 則一併完成。

**8. 結果驗證（真人實測）**：`git worktree list` 事後僅剩 `C:/Users/mrhap/traffic-reporter b76aaee [preserve/windows-runtime-20260906]` 一筆；`Invoke-RestMethod http://127.0.0.1:3000/health` 回應 `ok=True`，服務未受影響。

**9. 註記**：`feature/v1.8.6.5-km-location-resolver` 分支本身與其 commit 歷史未被刪除，仍存在於 git 物件庫中。

**未解決事項**：路況-023 記錄的其餘三項（本機工作目錄與 origin/main 落差如何處置、`health-watchdog.ps1` 尚未進版控、兩個編碼錯誤的 CSV 如何處理）皆與本次 v1865 清理無關，仍為未定案待辦，本輪未處理，詳見 `07_KNOWN_ISSUES_02.md`「重大風險｜本機工作目錄同時為版控倉庫與 Production 執行位置」章節。

## 處置紀錄｜pbs-relay Windows 執行版本併入 main（2026-09-07）

**1. 背景**：真人本機 `C:\Users\mrhap\traffic-reporter` 工作目錄檢出 `preserve/windows-runtime-20260906`，其內容即 Production 實際執行的 pbs-relay 程式。路況-028 唯讀比對確認：`origin/main` 的 pbs-relay 檔案集合完全被 preserve 涵蓋，main 無 preserve 缺少的內容；preserve 版本較新，包含 2026-08-30 人類回報但當時查無對應 commit 的地理篩選修正。

**2. 決策**：以 preserve 版本為準，完整併入 main。方案由路況-029 規劃（選項 A：本 session clone 內逐檔套用後開 PR，真人審閱後 merge），執行由路況-030 完成，真人於 2026-09-07 在 GitHub 網頁確認並 merge PR #2（merge commit `f2a5c63`）。

**3. 併入範圍（6 個檔案）**：修改——`pbs-relay/src/localMonitor.js`、`pbs-relay/src/localPrototype.js`、`pbs-relay/tests/localPrototype.test.js`、`pbs-relay/README.md`；新增——`pbs-relay/src/hsinchuBoundary.js`（1,994 bytes）、`pbs-relay/data/hsinchu-city-county-boundary.geojson`（755,908 bytes）。統計：6 files changed, 154 insertions(+), 35 deletions(-)。**明確排除**：`pbs-relay/scripts/scripts/compare-fetch.mjs`（巢狀重複檔，與 `pbs-relay/scripts/compare-fetch.mjs` 雜湊完全相同，真人已於 2026-09-07 在本機刪除該複本，故不併入）。

**4. 實質變更內容**：`localPrototype.js` 的 Windows 本機邊緣篩選不再以 `isAccident()` 文字比對作為候選事件的前置閘門——落石、坍方、封路、施工、積水等事件現與事故同等對待；有 PBS 座標時，服務區判斷改用真正的 point-in-polygon 比對官方新竹市／縣行政區邊界（`hsinchuBoundary.js` ＋新增的邊界 geojson），取代原本的矩形邊界框；無座標時仍沿用既有的道路／KM／地名規則。`localMonitor.js` 的變更為對應的 import 與變數改名（`filterRelevantAccidents`→`filterRelevantPbsEvents`），無行為變更。

**5. 執行方式與安全性**：全程未碰觸真人本機工作目錄，未在其上執行任何 git 操作。真人本機保持檢出 preserve 分支不變，未切換分支——避免重演 2026-09-07 上午 `git switch main` 導致執行中檔案自磁碟移除的事故（見 Volume 02 重大風險記錄）。`origin/preserve/windows-runtime-20260906` 完整保留未動，執行前後 SHA 皆為 `b76aaee565ed98b67e3870551b92b8469f9c5bb0`，仍為完整備份。PR #2，來源分支 `merge/pbs-relay-from-preserve-20260907`，commit `10356671f7907c49dc188f264493452704959289`，由真人於 GitHub 網頁確認後 merge。

**6. 對 Production 的影響**：pbs-relay 為 Windows 端 Node.js 程式，`src/` 從未 import 或打包其任何內容（`wrangler.jsonc` 進入點為 `src/index.js`），故本次合併雖會觸發一次 Cloudflare 重新部署，但 Worker 打包內容與行為完全不變。真人本機執行中的服務（LocalMonitor、Relay）全程未受影響。

**7. 仍未解決事項**：真人本機 main 分支落後 origin/main 223 個 commit 的問題**未因本次合併解決**，獨立存在。本機工作目錄仍檢出 preserve 分支而非 main，Volume 02 記錄的核心風險「不得在此目錄切換分支」**依然完全成立，未被本次合併解除**。`pbs-relay/scripts/health-watchdog.ps1` 仍未進版控。兩個編碼錯誤的 CSV、`pbs-relay-old/` 目錄、`.pbs-token-test` 備份方式，皆維持既有待辦狀態不變。

**8. WINDOWS_PBS_GEOGRAPHIC_FILTER_REPAIR 狀態更新**：對應 `07_KNOWN_ISSUES.md`（Volume 01）「補登紀錄｜WINDOWS_PBS_GEOGRAPHIC_FILTER_REPAIR（2026-08-30，人類回報，本 Cloud Session 未獨立驗證）」一則（該卷原文不改寫，本節為獨立的狀態更新記錄）。**狀態可升級至**：程式碼與設計方向已確認存在於 main（commit `1035667`，經 PR #2 併入），與人類回報的修正描述吻合——已移除 `isAccident()` 閘門、已改用 point-in-polygon 取代矩形邊界，現有明確可追溯的 commit 承載此變更。**不得標記為完全驗證**，以下兩項仍未核對：(a) 人類回報的「data.gov.tw dataset 7442」與 `hsinchuBoundary.js` 中繼資料所載「NCDR WMS627/AdministrativeRegion/MapServer/1（縣市界2024）」是否為同一份資料集，未查證；(b) 人類回報的驗收數字 `BEFORE_KEEP_COUNT=11 → AFTER_KEEP_COUNT=29`、`TESTS=124 passed/0 failed`，無任何 commit 或 repo 內容承載這些數字，合併本身無法使其升級為已驗證；除非未來取得原始執行記錄或在 main 上重新執行測試，否則應永久維持「人類回報、未逐字核對」狀態。

## 盤點紀錄｜本機工作目錄完整狀態與無備份檔案清單（2026-09-07）

**來源聲明**：本節事實由路況-026（Cowork 本機工程部執行之唯讀盤點）取得，非本 session 獨立驗證，如實轉載。

**1. 最重要結論**：服務執行所需的 pbs-relay 程式模組（`localMonitor.js`／`server.js`／`auth.js`／`pbsHandler.js`／`hsinchuBoundary.js` 等）在 `preserve/windows-runtime-20260906` 分支上皆有備份，本地與 origin 遠端 SHA 一致（`b76aaee565ed98b67e3870551b92b8469f9c5bb0`），遠端備份完好。盤點範圍內**未發現任何「服務必需的程式檔案」是完全無 git 備份的**。目前工作目錄狀態雖混亂，但不脆弱。

**2. 關鍵風險：`.pbs-token-test` 服務必需但永遠無 git 備份**。位置 `C:\Users\mrhap\traffic-reporter\.pbs-token-test`，64 bytes，LastWriteTime 2026-08-16 14:54:39。用途：Relay 排程工作啟動時讀取此檔內容設為環境變數 `RELAY_TOKEN`，再啟動 `server.js`。**此檔缺失，Relay 服務將無法啟動。** 狀態：未進版控，且**不應**進版控（憑證性質，納入 git 為不當作法）——其「無 git 備份」是刻意且正確的設計，非缺陷。**必須記住的事**：機器重灌、更換硬碟、或工作目錄重建時，此檔必須單獨保存與還原，git 還原無法涵蓋它。本輪未對此檔做任何處置（亦未記錄其內容），其備份方式待真人決定。

**3. 目前所在分支**：`preserve/windows-runtime-20260906`（HEAD `b76aaee`），**非 main**。磁碟工作目錄檢出的是此分支內容。

**4. 本地分支與 origin 落差**：`main` 落後 origin/main 223 個 commit、領先 3 個（該 3 個經 cherry 比對已以不同 SHA 存在於 origin/main，非獨有內容）。`preserve/windows-runtime-20260906` 與 origin 完全一致。其餘 feature 分支多數一致，`feature/v1.8.6.5-km-location-resolver` 落後 2、`feature/pbs-local-edge-filter-prototype` 落後 1。本地共 12 個分支。

**5. `git status --short` 全貌**：164 個檔案標示 modified（先前查證確認多為 CRLF/LF 換行差異）；4 項未追蹤：`.pbs-token-test`、`data/`、`pbs-relay-old/`、`pbs-relay/scripts/health-watchdog.ps1`。

**6. 新發現：`pbs-relay-old/` 目錄從未進入任何 commit**。17 個檔案、約 100K（`package.json`／`package-lock.json`／`README.md`／`render.yaml`／`scripts/compare-fetch.mjs`／`src/` 6 個模組／`tests/` 6 個）。以 `git log --all` 查證，此路徑從未出現在任何分支的任何一次 commit 中，屬完全無 git 備份的內容。用途、與現行 `pbs-relay/` 的內容差異、是否仍有價值——**均未查證，待後續評估**。本輪未做任何處置。

**7. 其他無 git 備份的檔案（性質為執行期產物或今日新建，非程式模組）**：`pbs-relay/scripts/health-watchdog.ps1`（399 bytes，今日新建，待上傳）；`pbs-relay/data/local-monitor.lock`、`pbs-relay/data/relevant-state.json`（執行期狀態，`.gitignore` 排除）；`pbs-relay/logs/2026-09-01.jsonl` 至 `2026-09-07.jsonl` 共 7 個（執行期日誌，`.gitignore` 排除）；`data/road-location/archive/省道里程坐標(里程牌標誌).csv` 與 `data/road-location/raw/provincial/provincial.csv` 的磁碟亂碼編碼版本（origin/main 有同名的正常 UTF-8 版本，但磁碟這份位元組序列在任何分支皆查無）。

**8. 存在於 preserve 分支但不存在於 origin/main 的檔案**：`pbs-relay/src/hsinchuBoundary.js`、`pbs-relay/data/hsinchu-city-county-boundary.geojson`、`pbs-relay/scripts/scripts/compare-fetch.mjs`（巢狀路徑，來源不明，未查證）。

**9. 關鍵檔案三方比對結果（磁碟／本機 HEAD 即 preserve 分支／origin/main）**：`wrangler.jsonc` 三者皆存在，磁碟 vs HEAD 差異 13 行（磁碟多出 `r2_buckets` 區塊，binding 名為 `traffic_reporter_cctv_images`）、磁碟 vs origin/main 差異 238 行（origin/main 有 vars、ai、queues binding，磁碟版本皆無）。`pbs-relay/src/localMonitor.js` 三者皆存在，磁碟 vs HEAD 僅換行差異，磁碟 vs origin/main 有 18 行真實差異（origin/main 較新），磁碟檔案 mtime 2026-09-07 06:19（即今日復原動作的時間）。`pbs-relay/src/server.js` 三者內容一致（僅換行差異）。`pbs-relay/src/hsinchuBoundary.js` 磁碟與 HEAD 存在（僅換行差異），**origin/main 不存在此檔**。

**10. 風險紅線（依 git 機制事實推論）**：任何會改變磁碟 `pbs-relay/src/` 檔案集合的 git 操作皆有風險，包括切換至不含 `localMonitor.js`／`hsinchuBoundary.js` 的分支（例如 main）、或任何 `git clean`。2026-09-07 已實際發生一次（詳見 `07_KNOWN_ISSUES_02.md` 重大風險記錄）。

**11. 誠實揭露**：路況-026 執行環境為 Linux VM，無法存取 Windows 程序與排程工作，因此「正在執行的服務實際載入哪些檔案」該項**完全查不到**，該輪標記為 PARTIAL。上述關於服務依賴的判斷係基於磁碟檔案清單與先前輪次的查證，非該輪直接驗證。

**12. 另一項誠實揭露**：路況-026 回報中將 `traffic-reporter-v1865` 資料夾變為空、`.git/worktrees/` 消失列為「緊急發現、來源不明」。實際原因為真人於同日稍早（約 14:5x）依路況-024 查證結果執行 `git worktree remove --force`，屬計畫內處置（詳見上方 v1865 清理記錄）。該輪執行者不知情故列為異常，記錄於此以澄清，非真實異常事件。

**通則**：一個系統的「備份完整性」不能只看程式碼有沒有進版控。憑證、環境設定、執行期狀態這類刻意排除在版控外的檔案，往往才是重建時真正缺的東西——它們不在 git 裡是正確的，但這代表必須有另一套記得它們存在的機制。
