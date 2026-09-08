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

## 處置紀錄｜本機三項清理與備份完成（2026-09-07）

**來源聲明**：本節全部內容為真人於 2026-09-07 下午在本機 PowerShell 依序執行取得的結果，非本 session 獨立驗證，如實轉載。各步驟後皆以 `Invoke-RestMethod http://127.0.0.1:3000/health` 確認回應 `ok=True`，服務全程未中斷。

**1. `.pbs-token-test` 已備份**：建立目錄 `C:\Users\mrhap\_pbs_credentials_backup\`，複製一份 `.pbs-token-test`（64 bytes，LastWriteTime 2026-08-16 14:54:39）至該處，原檔未動。此舉解決路況-027 記錄的 `PBS_TOKEN_NO_GIT_BACKUP` 風險的一部分——該檔依設計不進版控（憑證性質，此設計正確），現於本機另有一份副本。**仍存在的限制**：備份與原檔位於同一台機器、同一顆硬碟，僅能防範工作目錄重建或誤刪，**無法防範硬碟故障或機器毀損**，若需完整防護需另行複製至外部媒體或其他機器，此為未完成事項。（本節未記錄該檔的內容、雜湊值或任何可還原的資訊。）

**2. `pbs-relay-old/` 已搬離工作目錄**：真人本機實測，該目錄 17 個檔案，全部 LastWriteTime 為 2026-08-16 13:41～14:25，之後未再變動；內容範圍小於現行 `pbs-relay/`，缺少 `localMonitor.js`、`localPrototype.js`、`hsinchuBoundary.js` 等後續才有的模組。以 `server.js` 比對，舊版 3,344 bytes（hash 0CD762BC…）與現行 3,520 bytes（hash 31BA2D2B…）不同，確認為較早期的版本快照，無任何現行版本所缺的內容。處置：建立 `C:\Users\mrhap\_old_backups\`，以 `Move-Item` 將整個 `pbs-relay-old/` 搬移至該處。採搬移而非刪除，理由：該目錄從未進入任何 git commit，刪除即永久遺失，雖研判無保留價值但該判斷屬推論而非事實，故保留實體。工作目錄現況：`traffic-reporter/` 底下不再有 `pbs-relay-old/`。此項解決路況-027 記錄的 `PBS_RELAY_OLD_UNTRACKED` 待辦。

**3. `health-watchdog.ps1` 已進版控**：該檔（399 bytes，2026-09-07 新建）已 commit 並 push 至 `preserve/windows-runtime-20260906` 分支（commit `18cb8e2c5152b616df54ae02c51bcc0dd82d2422`，1 file changed, 6 insertions(+)）。**推至 preserve 而非 main 的理由**：本機工作目錄目前檢出 preserve 分支，推至 main 需切換分支，而切換分支會改寫工作區、移除執行中的程式檔案（2026-09-07 上午已發生過一次，見 Volume 02 重大風險記錄）；preserve 分支的定位本即為「Windows 執行環境快照」，此腳本正是該環境的一部分，推至此分支符合其定位。**未完成事項**：該檔目前僅存在於 preserve 分支，尚未併入 main，是否比照路況-030 的方式另行併入，待定案。

**4. `preserve/windows-runtime-20260906` 分支 SHA 已變更**：舊 SHA `b76aaee565ed98b67e3870551b92b8469f9c5bb0` → 新 SHA `18cb8e2c5152b616df54ae02c51bcc0dd82d2422`（本輪新增 health-watchdog.ps1 一個檔案）。**警示**：先前多則工程記憶記錄（路況-001、路況-023、路況-026、路況-027、路況-029、路況-030、路況-031 等）皆記載該分支 SHA 為 `b76aaee`——該記載在其撰寫當下正確，不回頭改寫；未來核對此分支時應知悉 SHA 已於 2026-09-07 因本次 commit 而前進，**SHA 不符不代表分支遭到異常改動**。該分支既有內容（b76aaee 當時的全部檔案）完整保留，本次為純新增，未刪除或改寫任何既有檔案。

**5. 本輪未處理事項（維持既有待辦，非已解決）**：本機 main 分支落後 origin/main 223 個 commit；本機工作目錄仍檢出 preserve 分支而非 main，Volume 02「不得在此目錄切換分支」風險依然成立；`wrangler.jsonc` 本機未提交修改（缺 vars／ai／queues 區塊）；兩個編碼錯誤的 CSV 檔案；`.pbs-token-test` 的異地備份；`health-watchdog.ps1` 併入 main；HealthWatchdog 異常路徑未驗證；版本追溯等雙鐵方案。

## 處置紀錄｜health-watchdog.ps1 併入 main，切換分支障礙解除（2026-09-07）

**1. 處置**：`pbs-relay/scripts/health-watchdog.ps1`（399 bytes）已由 `preserve/windows-runtime-20260906`（`18cb8e2c5152b616df54ae02c51bcc0dd82d2422`）併入 main。PR #3，來源分支 `merge/health-watchdog-20260907`，commit `3e37e45b9489db923f9a61f4693442f6063c347b`，merge commit `b59a70d`，由真人於 GitHub 網頁確認後 merge。

**2. 併入理由**：該檔原本只存在於 preserve 分支，Windows 排程工作 `TrafficReporter-PBS-HealthWatchdog` 的指令直接指向其磁碟路徑。若本機工作目錄切換至 main，該檔會從磁碟消失，排程下次觸發將找不到腳本。併入後此障礙解除。

**3. preserve 分支 SHA 執行前後不變**（`18cb8e2c5152b616df54ae02c51bcc0dd82d2422`），未被改寫。

**4. 巢狀重複檔排除**：`pbs-relay/scripts/scripts/compare-fetch.mjs` 明確排除未併入。**須註記**：該檔目前仍存在於 preserve 分支的歷史中（路況-030 的併入只作用於 main 端，未回頭修改 preserve 分支），真人本機磁碟上的複本已於 2026-09-07 刪除。此為已知狀態，非待辦。

**5. 驗證狀態**：正常路徑已驗證（2026-09-07 09:47:47 手動觸發，`LastTaskResult=0`）；**異常路徑仍未驗證**（服務實際中斷時告警視窗是否確實跳出，尚未測試），不得寫成已驗證。

## 查證修正｜路況-033 推翻的兩項先前認知（2026-09-07）

**1. `wrangler.jsonc` 本機落差對 Production 無影響（更正）**：查證結論——Cloudflare Workers Builds 從 GitHub repo 拉取程式碼建置部署（Production branch = main），讀取的是 `origin/main` 上的 `wrangler.jsonc`，與真人本機工作目錄檢出哪個分支完全無關；本機那份從未 commit、從未被任何部署流程讀取。本機版本缺少 vars／ai／queues 區塊的原因已查明：這些區塊全部是 2026-08-25 之後才加入 `origin/main`（`5d1f9fe` V1.9.9 Phase 3B 加入 ai binding 與 `PBS_AI_DECISION_ENABLED`、`850f5fa` V2.3.0 加入 queues、`2d23329` V2.4.0 加入三個 TDX 開關等），preserve 分支的內容停在 2026-08-25 前後，從未包含這些後續變更。**明確判定：本機這份 `wrangler.jsonc` 不是被任何人手動改壞的，是檢出舊快照的自然結果，對 Production 零影響。** 先前記錄（Volume 02／03 相關段落）將其列為需處理的落差，依此查證應降級為非問題；**既有記錄原文不改寫**，此為新增的更正說明。

**2. 兩個 CSV 的「編碼錯誤」認知有誤（更正）**：`data/road-location/archive/省道里程坐標(里程牌標誌).csv` 在 `origin/main` 上本身即為 Big5／cp950 編碼，**並非 UTF-8**——`data/road-location/archive/README_RAW_CONTRACT.md` 明確記載該檔係逐位元組原樣保留原始政府檔案的 cp950 編碼，屬正確的存檔慣例，非錯誤。先前記錄（路況-023／025／027）記載「origin/main 為正常 UTF-8 版本、本機為亂碼版本」，**此描述不正確**，於本則記錄更正，既有記錄原文不改寫。程式引用查證：`archive/` 底下那份 CSV 沒有任何程式碼引用；`raw/provincial/provincial.csv` 僅在真人手動執行 `npm run update:road-location-data` 時被讀取，用以重新產生 `generated/provincial.js`，Production 依據的是已 commit 的 `generated/provincial.js`（bundle 進 Worker），與 raw CSV 無關。**明確判定：這兩個檔案對 Production 與本機服務皆無影響，不構成待辦事項。**

## 補充事實｜路況-033 其餘查證結果（2026-09-07）

**1.** 本機 main 落後 `origin/main` 的 commit 數已由 223 增至 **230**（因期間 `origin/main` 持續新增 commit，數字隨時間自然增加，非查證方法有誤）。其中觸及 `pbs-relay/` 的僅 2 個（`7acb82a`、`1035667`）。

**2. 關鍵事實**：本機 main 分支的指標前進（例如 `git fetch` 後更新 main 指標），**不會改變磁碟工作目錄內容**——工作區內容由目前檢出的分支決定，只有實際執行 `git switch`／`git checkout` 切換檢出才會改寫磁碟。

**3.** 若本機工作目錄改為檢出 main：磁碟會新增 209 個檔案、199 個既有檔案被取代。**pbs-relay 核心執行檔案（`localMonitor.js`、`server.js`、`auth.js`、`pbsHandler.js`、`hsinchuBoundary.js`、邊界 geojson）在忽略換行後與 preserve 內容一致**（已於路況-030 併入），Production 服務核心邏輯不會被移除或改變。加上本輪 `health-watchdog.ps1` 已併入，**切換分支的已知障礙均已解除**。

**4.** 若維持檢出 preserve：本機磁碟上非 pbs-relay 的檔案（`src/`、`test/`、`engineering-memory/`、`wrangler.jsonc` 等）將持續停留在 2026-08-25 前後的舊版本，未來 main 的新變更不會反映到本機。此不影響服務執行，但本機查閱這些檔案會看到舊內容。是否切換分支仍為未定案事項，見 `00_CURRENT_STATE.md` Next Action ⑥。

## 治理紀錄｜00_CURRENT_STATE.md 精簡（2026-09-07）

**1. 精簡原因**：`00_CURRENT_STATE.md` 精簡前為 79,217/81,920 bytes，餘裕僅 2,703 bytes，接近本專案單檔容量守則上限。真人定案不採分卷方式（分卷會破壞該檔「快速接班｜LEVEL 1｜一頁看完」的設計定位），改為移除其中重複的歷史敘述段落，只保留狀態欄位與常駐指引。

**2. 精簡依據**：路況-036 唯讀查證確認，該檔 25 段歷史敘述（24 個封版／修正紀錄段落＋1 個補登段落，合計 66,435 bytes，佔全檔 84%）之實質內容（決策、根因、數字、範疇界定）在 `07_KNOWN_ISSUES.md`／`02_PROJECT_HANDOFF.md`／`03_ARCHITECTURE.md` 三者之一或多者皆有相同或更詳盡記載，**僅存於此者 0 段**。全 repo 無任何檔案以行號或錨點引用此檔特定段落，`AGENTS.md` 僅以檔名整體引用，移除不影響任何現存引用。

**3. 移除的段落清單**（皆可於下列檔案查得對應內容——`07_KNOWN_ISSUES.md`／`02_PROJECT_HANDOFF.md`／`03_ARCHITECTURE.md`／`06_VERSION_HISTORY.md`，逐段已於路況-036 查證確認）：V2.4.15 正式封版、V2.4.15 QWEN FAST AI MODEL REPLACEMENT、V2.4.14 封版、V2.4.13 封版、V2.4.12 封版、V2.4.11 封版、V2.4.10 封版、V2.4.9 封版、V2.4.8 封版、V2.4.7 封版、V2.4.6 封版、V1.9.9 Phase 1 封版、V1.9.9 Phase 2 封版、V1.9.9 Phase 3B 封版、V1.9.9 Phase 3D Hotfix 封版、V2.0.0 MILESTONE 封版、V2.0.1 封版、V2.0.2 封版、V2.1.0 封版、V2.2.0 封版、V2.4.0 封版、V2.3.3 封版、V2.3.2 封版、V2.3.1 封版、V2.3.0 封版、補登（Windows PBS Geographic Filter Repair＋V2.3.0 驗收）。

**4. 明確聲明**：移除的是**重複的敘述**，非刪除任何獨有資訊。原始內容完整保留於上述其他工程記憶文件與 git 歷史中（`00_CURRENT_STATE.md` 本身的舊版本亦可由 git log 完整回溯）。

**5. bytes 數**：精簡前 79,217 bytes；精簡後實際數值見本輪 commit 對應之路況-037 回報。

**6. 保留段落的說明**：
   - 「Windows PBS Production Ingress ＋ Cloudflare PBS 輪詢退休（V1.9.8）」段落**完整保留**（標題調整為表達現行架構）——雖標題含歷史版本號，但內文描述目前仍生效的 Production 架構現狀旗標（`WINDOWS_LOCAL_EDGE_FILTER = ACTIVE`、`WINDOWS_PBS_PRODUCTION_INGRESS = ACTIVE` 等），移除將造成資訊缺口，路況-036 已將其歸類為 (d) 而非純歷史 (b)。
   - V2.4.0 段落中關於 TDX 通知閘門機制的說明（`LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT`；Phase 閘門硬寫死於 `debugPush.js` 單一呼叫點 `suppressLineNotify = source === 'freeway' || source === 'highway'`，非 `wrangler.jsonc` 變數控制，變更階段須明確程式碼變更）**原文照錄搬移**至「現行架構」段落，因其為現行程式碼架構事實，具現行參考價值，非單純歷史記述；V2.4.0 封版段落其餘內容照常移除。

**7. `BROWSER_ACTION_REQUIRED = YES` 旗標已確認失效並移除**：該旗標原記於 V2.3.0 封版段落（2026-08-30），內容為「真實 Cloudflare Queue 資源需在 Dashboard／`wrangler queues create` 建立，本 sandbox 無法驗證或建立，不得假設已存在」。路況-013 的 2026-09-07 24 小時驗收數據已證實 Queue 資源確實存在且正常運作（168 次真實訊息、`Queue Read/Write Ratio=1.00`），此旗標**已於 2026-09-07 確認過期失效**，隨該段落一併從 `00_CURRENT_STATE.md` 移除，不再保留、不加註誤導性的「待處理」語意。其原始記載仍完整保留於 `07_KNOWN_ISSUES.md`（V2.3.0 對應段落）與 `06_VERSION_HISTORY.md`，**未回頭改寫**這些檔案中的既有記載。

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

## 修正紀錄｜V2.4.16 CCTV 職責錯置修正——AI 判定通報即給圖（2026-09-07）

**觸發事件與根因**：真實 Production 事件 `A15040100H-01-20260907075536353100022`（TDX 高公局，國道一號北向 98K+300，「其他異常告警-故障車」）：AI 判定通報、LINE 已發送，但 CCTV=NO。路況-038 唯讀查證確認根因：`src/cctv/dynamicCollage.js#resolveCctvEligibility()` 以硬寫死關鍵字（`event.type === 'accident'`）再判斷一次「是不是事故」，屬職責錯置——依既有四層架構（Windows=Geography Only／Cloudflare=Ingress-Transport-Orchestration／AI=Semantic Decision Authority／LINE=Delivery Only），AI 是唯一的通報決策權威，CCTV 不應自行做語意判斷。

**修法內容與範圍**：移除 `resolveCctvEligibility()` 的 `event.type === 'accident'` 條件本身，`isDynamicShoulder` 分支（路由至 `single` 策略）逐字不動。移除後資格條件僅剩：`CCTV_TRUSTED_EVENT_SOURCES` 檢查、`resolveRoadKey()` 可辨識、道路在 `CCTV_SUPPORTED_ROADS`（國道一號、三號，未新增）內、`eventTargetKm()` 可解析公里數。`reason:'not-accident'` 隨同該檢查一併退休（全 repo 搜尋確認移除前無其他呼叫方比對此字面值）。機動路肩維持現狀：`tdx/tdxQueueIngress.js` 的 Gate A（`resolveTdxRoadManagementEligibility()`）在事件進 Queue 前即攔下，本輪未觸碰；此外 `dynamicShoulder` 標記只由 TDX 正規化路徑設定（PBS 正規化從未設定），雙重確保機動路肩事件不會意外走到新放寬的 quad 路徑。`APP_VERSION` 由 `V2.4.15` bump 為 `V2.4.16`（PATCH），未修改任何已封版 V2.4.15 的既有記錄。

**測試**：完整跑過全量測試找出受影響斷言，逐一核對後更新 4 個既有測試檔（`test/dynamicCollage.test.js`、`test/dynamicShoulder.test.js`、`test/pbsAccidentCctvEnrichment.test.js`、`test/nonCollisionAnomalyClassification.test.js`，共 5 處斷言，其中 1 處為路況-039 規劃時未預見的新發現）＋新增 2 則測試（涵蓋 construction／closure／control／congestion／other 五種非事故類型皆變為 CCTV eligible=true/quad；機動路肩事件仍正確路由 single 的 V2.4.16 regression lock，特別驗證即使其自身 type 為 'control' 亦不受新放寬邏輯影響）＋更新 `test/aiObservatoryView.test.js` 的 `APP_VERSION` 硬編碼斷言（版本 bump 的正常連帶更新）。全量迴歸 2009 項，1976 通過／33 失敗；以 `git stash -u` 取得變更前同一 commit 的基準（2007 項，1974 通過／33 失敗），逐一以測試名稱比對，`NEW_FAILURES=0`——兩次基準之間唯一的差異是本輪主動重新命名的同一個既存失敗測試（`non-accident and non-freeway events are never eligible` → 新名稱），非新增失敗。

**LINE 額度前提（真人明確指示須記入）**：LINE Push 每月 200 則額度為「文字一則、圖片一則」分開計算。本次放寬出圖範圍**確實會增加額度消耗**，真人將於 LINE 官方後台觀察實際用量後另行決議是否需要調整政策。本輪不因此設限或另加任何新的節流機制。

**未納入本輪的三項（明確記錄，非已解決）**：
1. 單張圖（single）路徑清理——真人確認該路徑已因 LINE Push 額度考量停用、目前無使用者，但本輪不清理、不移除，待本次修法上線觀察數日後另案處理。
2. 查修頁缺 `cctvSkippedByReason`——路況-038 查證確認新版 AI Observatory 頁面（`/admin/pbs-ai-observatory-view`）僅記錄二元 `imageUrlPresent`（YES/NO/UNKNOWN），不記錄細分原因；此為既有可觀測性缺口，會影響本次修法後若仍有事件沒圖時的後續追查效率（無法直接分辨 `no-camera`／`no-frames`／`prepare-timeout`／`run-budget-exhausted`／`r2-publish-failed` 等）。另案處理。
3. AI 決策欄位顯示 `UNKNOWN / NOT RECORDED` 但 LINE 已發送——路況-038 新發現，機制已查明（`loadAiDecisionDetail()` 依賴 `record.outcome` 恰為 `AI_NOTIFY_TRUE`/`AI_NOTIFY_FALSE` 且 AI 決策快取需命中，48h TTL），但本案例實際觸發哪個分支未能確認（需真實 Production KV 存取）。與本次 CCTV 修法程式路徑無關，另案處理。

**待驗證事項（明確記錄，不得寫成已確認）**：
- 出圖量實際增加幅度未知——路況-039 粗估每日 5-15 筆，非精確數字，需上線後以查修頁實際數據校正。
- `run-budget-exhausted`（`CCTV_PREPARE_BUDGET_MS=4000` 為整個 Cron tick 共享）發生率需上線後觀察。
- LINE 實際額度消耗需真人透過 LINE 官方後台核實。

**封版標記（路況-041，2026-09-07，依新版一段式封版規則）**：

**封版狀態：SEALED**——依 AGENTS.md 第6節新規則（一段式封版：施工完成即封版，不以現場驗證為前提），本記錄不再套用舊有「`SEALED_FOR_PRODUCTION_OBSERVATION` → 待驗證 → `SEALED_AND_VALIDATED`」兩段式流程。

封版依據：程式碼變更完成（`resolveCctvEligibility()` 移除職責錯置檢查）、全量迴歸 2009 項／1976 通過／33 失敗、`git stash -u` 對照基準 `NEW_FAILURES=0`、`APP_VERSION` 已 bump 至 `V2.4.16`、commit `1ac874211351a08eefb4488c817a23945c5a55c3` 已 push main 並驗證（origin/main HEAD 與本地一致）。

**待現場觀察事項（觀察記錄，非封版條件——不得因尚未觀察而視為未封版）**：
(a) 下一則國道非事故通報（施工／管制／故障車等）是否實際附上 CCTV 圖片——本次修法是否生效的關鍵證據，**尚未取得**。
(b) 出圖量實際增加幅度（路況-039 粗估每日 5-15 筆，非精確數字）——**尚未取得**。
(c) `run-budget-exhausted` 發生率是否上升——**尚未取得**。
(d) LINE 每月 200 則額度的實際消耗變化（真人將自 LINE 官方後台核實；已知文字與圖片分開計數，本次修法確實會增加消耗）——**尚未取得**。

封版後規則：發現問題一律開 `V2.4.17` 修正，不得回頭修改已封版的 `V2.4.16`。

**通則**：一個模組如果重新判斷另一個模組（此處為 AI）已經做過的決策，即使判斷方式再簡單（一組關鍵字），也是職責邊界的破口——正確的修法不是把關鍵字表加得更完整，而是承認這個判斷本來就不該由這個模組做。四層架構把「這件事該不該通報」的權威明確劃給 AI 一家，CCTV 的角色應該只回答「這張圖技術上做不做得出來」，不該再回答「這件事值不值得配圖」。

## 治理紀錄｜封版規則改為一段式（2026-09-07，路況-041）

**背景與原因**：舊制為兩段式封版——施工完成先標 `SEALED_FOR_PRODUCTION_OBSERVATION`，待日後取得現場驗證證據後再補標 `SEALED_AND_VALIDATED`。真人指出這個「補標」步驟在實際運作中經常於隔天被忘記回頭執行，導致版本長期懸在未封版狀態，衍生後續判斷（例如「這版到底能不能改」）的混淆與風險。

**新規則**：改為一段式——施工完成（程式碼變更＋測試通過＋版本 bump＋工程記憶更新＋push main）即於**同一輪**標記 SEALED，不以現場驗證為前提。現場證據改為獨立的「待現場觀察事項」清單，與封版狀態脫鉤記錄，觀察結果日後補記，但補記與否不影響已成立的封版狀態。發現問題一律開新版號修正、不回頭改已封版版本——此既有規則不變，與新的封版時機並用。完整規則見 `AGENTS.md` 第6節。

**取捨**：放棄「封版本身即代表已完成現場驗證」這項保證——SEALED 現在只代表「這輪施工按規則做完了」，不代表「已經在 Production 上驗證過行為正確」。換取的是流程不再因為「等驗證」而長期懸置：封版狀態與驗證進度分開追蹤，兩者各自誠實記錄，不再互相綁架對方的完成度。

**既有兩段式歷史記錄不回頭改寫**：V2.4.15 及更早版本沿用當時的 `SEALED_FOR_PRODUCTION_OBSERVATION`／`SEALED_AND_VALIDATED` 兩段式標記與記錄方式，保留為當時的做法原文，不因本次規則變更而回頭改寫或補標。本規則自路況-041 起適用於後續版本。

## 修正紀錄｜V2.4.17 CCTV 圖片有效期由15分鐘延長為24小時（2026-09-08）

**根因（重點，完整記錄）**：本次破圖（`EVENT_ID=11509080016-5`，2026-09-08 09:00，PBS，國道一號南向90.4K）與2026-08-31那次（`EVENT_ID=11508310005-5`）**是同一個原因**——`PUBLISHED_IMAGE_TTL_SECONDS=900`（15分鐘）。V2.3.3當時新增R2讀回驗證，但那從一開始就不是根因，只是排除了「R2寫入本身有問題」這個可能性，故問題在本次再現。

路況-042查得完整await鏈：圖片於09:00:28成功寫入R2、通過V2.3.3的讀回驗證、09:00:30交給LINE——應用層時序全程正常，無race condition，無圖片未就緒即送出URL的路徑（路況-042已逐行查證排除）。路況-043查得的完整時間軸：LINE手機端直到**10:09:11**才首次抓圖，即推播後**68分41秒**，已超過15分鐘TTL達53分鐘，`readPublishedImage()`依既有邏輯正確判定過期、best-effort刪除物件、回404，LINE因此顯示破圖。

**決定性對照組證據（路況-043查得）**：2026-09-06成功案例（`EVENT_ID=11509060138-0`）——手機端於推播後**+11分01秒**抓圖，得200（LINE收到後永久快取，故時至今日仍正常顯示）；但**同一張圖**若由桌機端於推播後**+20分鐘**抓取，則得404，且R2同分鐘記錄一筆DeleteObject。同一物件、同一TTL規則、不同使用者/裝置的抓取時間點、截然不同的結果——確定性地把「失敗與否」的變因鎖定在TTL時間窗與使用者實際開啟時間的落差，而非管線任何環節故障。

**明確更正既有認知（既有記錄原文不改寫，於此說明更正）**：V2.3.3當時的記錄原文（保留不動，見上方對應章節）將此類破圖症狀描述為「無法用應用層時序解釋……LINE端遠端抓取行為不在本codebase可視範圍」。路況-042／043／044現已確認：**根因自始至終都在本codebase自己的TTL設定裡**，完全在本codebase的可視範圍與控制範圍內，**並非LINE端的謎團**。這不是一個LINE端的問題，而是本repo自己把已發布圖片的存活時間設得比一個真實使用者實際打開聊天視窗所需的時間還短。

**修法內容**：僅改一個常數，`src/cctv/publishedImage.js#PUBLISHED_IMAGE_TTL_SECONDS`，900→86400（15分鐘→24小時）。過期判定邏輯、lazy delete機制、`readPublishedImage()`／`handlePublicCctvImage()`其餘行為逐字不動——只有數字變了。

**儲存成本評估依據（真人已審閱定案）**：R2獨立計費（非Workers KV/CPU），免費額度每月10GB儲存／100萬Class A／1000萬Class B操作，egress免費。評估當下bucket 261個物件共8.35MB（平均約33KB/張）。以每日約10張估算，24小時TTL下同時存活約10張（約330KB），遠低於免費額度。真人已定案：空間充足，設定24小時。

**已一併記錄的三項可觀測性缺口（待辦，本輪不處理）**：
(a) `r2ReadbackElapsedMs`——路況-042查得：`prepareCctvImageWork()`確實有計算此欄位，但`broadcastPipeline.js`從未把它複製到`traceForEvent`，且`pipelineTrace.js`自己的KV schema函式參數清單裡根本沒有這個欄位——R2讀回驗證本身耗時多久，目前完全無法從Pipeline Trace（不論查修頁畫面或KV原始JSON）觀測到。
(b) 主推播路徑（`runLineBroadcast`／`broadcastPipeline.js`的AI-approved LINE推播迴圈）沒有任何`console.log`輸出`stageTracker`／`cctvSkippedByReason`等CCTV診斷欄位——目前唯一相關的`console.log`屬於另一條完全不同路徑（`topUpSharedFeedCctvImages`／Shared Feed補圖），不會記錄真正的LINE推播事件。Cloudflare Worker Logs因此對CCTV各階段耗時沒有任何記錄可查。
(c) Cloudflare Workers Logs會將32位hex的image id視為疑似敏感字串而遮罩為REDACTED，導致即使查得log行也無法從中反查出完整的圖片URL供人工核對。

**R2清理機制的事實（已知行為，非缺陷，不列為待辦）**：過期物件採**lazy delete**——只有在被讀取時才判定是否過期並刪除，**沒有背景清理排程**。因此任何發布後未被再次讀取的物件會**永久殘留**於R2（現有8月份的殘留物件即屬此類）。TTL延長為24小時後，理論上會有更多這類殘留物件累積，但依上方儲存成本評估，即使如此仍遠低於免費額度，故此為已知、可接受的現有行為，本輪不新增背景清理排程或lifecycle規則，也不列為待辦事項。

**測試**：新增4則測試於`test/cctvImagePublish.test.js`（V2.4.17 (a)(b)(c)(d)）——(a)常數新值為86400、(b)沿用真實事件自己的+68分41秒延遲時間軸驗證仍可正常讀取（24小時內）、(c)發布滿24小時又1秒後應過期並觸發lazy delete、(d)`publishCollageImage()`回傳的`expiresAt`精確等於`createdAt`+24小時。既有測試**無一需要更新**——`test/cctvImagePublish.test.js`既有的TTL相關斷言（測試1的`expiresIn`、測試4的過期計算）原本就是動態引用`PUBLISHED_IMAGE_TTL_SECONDS`常數本身，而非寫死900，故不需任何修改即自動反映新值並持續通過。另因版本bump連帶更新`test/aiObservatoryView.test.js`的`APP_VERSION`硬編碼斷言（標準連帶更新）。全量迴歸2013項（2009+4新增），1980通過／33失敗；以`git stash -u`取得變更前同一commit基準（2009項，1976通過／33失敗），以測試名稱集合逐一比對（非僅計數），兩集合完全相同（`comm`結果為空），`NEW_FAILURES=0`。`APP_VERSION`由`V2.4.16`bump為`V2.4.17`。

**同步更新的說明性註解**：`src/cctv/dynamicCollage.js`、`src/traffic/broadcastPipeline.js`、`src/traffic/sharedFeed.js`三處提及「15分鐘」TTL的說明性註解已同步更新為24小時（僅更新TTL描述本身，不動其餘註解文字）。`src/version.js`裡V2.3.2／V2.3.3自己的已封版changelog記錄（描述當時確為15分鐘的歷史事實）刻意保留不動。另查得`src/cctv/publishedImage.js`模組頂端有一段描述舊版（KV時代、已停用）`Cache-Control: max-age=900`的歷史修正說明——該900是描述已作古的舊實作細節（非現行TTL），判斷不屬於本輪「說明性註解與實際值不符」範圍，未觸碰。另查得`src/pbs/pbsConfig.js#CROSS_SOURCE_MAX_TIME_DIFF_MS`與`src/traffic/health.js#STALE_CRITICAL_MS`兩處恰好也是15分鐘，但語意上與CCTV圖片TTL完全無關（分別為PBS/TDX跨來源時間差容許值、健康快照過時判定），純屬巧合同數值，已查出但未修改，並於此列出供會議室知悉。

**V2.4.17封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-08，路況-044）。封版依據：程式碼變更完成（僅一個常數900→86400）、全量迴歸2013項／1980通過／33失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.4.17`、commit已push main並驗證。**待現場觀察事項（觀察記錄，非封版條件）**：下一則國道CCTV通報，若使用者延遲數小時才開啟LINE聊天視窗查看，圖片是否仍可正常顯示（24小時TTL的真實有效性驗證）——尚未取得。發現問題一律開`V2.4.18`，不回頭改已封版的`V2.4.17`。

## 修正紀錄｜V2.4.18 移除aiApprovedPbsBroadcast.js外層事故類型閘門，使V2.4.16修法真正生效（2026-09-08）

**與V2.4.16的關係（核心記錄，須完整理解，不得描述為修正V2.4.16的錯誤）**：V2.4.16當時只修改了`cctv/dynamicCollage.js#resolveCctvEligibility()`一個函式本身，移除該函式內部的`event.type==='accident'`檢查——路況-047本輪重新逐行核對，確認這個修改本身完整、正確，不需要再改，一行都沒動。V2.4.16的授權範圍**從未包含**`src/traffic/aiApprovedPbsBroadcast.js`（真正處理真實廣播事件的路徑，依路況-045查證確立）。路況-047唯讀查證發現：`aiApprovedPbsBroadcast.js`第250行附近另有一道**獨立、早於V2.4.16就存在（V1.9.9 Phase 3B原始設計）**的`if (event.type==='accident')`閘門，包住整個CCTV呼叫，此閘門V2.4.16從未觸碰、也從未被授權觸碰。**這是兩個不同層次的問題**：「函式邏輯本身對不對」（V2.4.16，答案是對的）與「呼叫端有沒有真的把這個對的邏輯用上」（本次V2.4.18，答案原本是沒有，現在補上）。故本次修法**不是**修正V2.4.16的錯誤，而是移除一道V2.4.16授權範圍外、此前始終未被觸及的外層閘門，讓V2.4.16當初就已經正確完成的邏輯，第一次真正在真實廣播路徑上被使用到。

**原始觸發事件**：真實Production事件`EVENT_ID=A15040100H-01-20260907075536353100022`（TDX高公局，國道一號北向98K+300，「其他異常告警-故障車」，分類`type:'other'`）——這正是當初促成路況-038查證、路況-039規劃、路況-040執行V2.4.16的原始事件。路況-047查證確認：即使V2.4.16已上線封版，這類非accident事件在`aiApprovedPbsBroadcast.js`這條真實路徑上，因為這道外層閘門的存在，**依然完全拿不到CCTV圖片**。本次V2.4.18移除該閘門後，同類事件應能開始取得CCTV圖片（見下方待現場觀察事項，尚未實際驗證）。

**因此開始能取得CCTV圖片的事件類型**：construction（施工）、closure（封閉）、control（管制）、congestion（壅塞）、other（其他異常告警）——即`resolveCctvEligibility()`原本就允許、但因外層閘門存在而從未在真實路徑上生效的全部類型，正是路況-039當初規劃V2.4.16時就打算開放的範圍。

**機動路肩不受影響（明確記錄，路況-047重新驗證確認）**：機動路肩（single策略）事件由獨立的Gate A（`tdx/tdxQueueIngress.js`呼叫`roadManagementPolicyGate.js#resolveTdxRoadManagementEligibility()`）在事件進Queue、進AI、進`aiApprovedPbsBroadcast.js`**之前**就已無條件攔截（`event.dynamicShoulder.state`為`'OPEN'`或`'STOPPED'`者一律丟棄，0 Queue／0 AI）。此攔截機制完全獨立於本次移除的外層閘門，兩者互不相關——移除本次閘門對機動路肩事件的既有防護**沒有任何影響**。路況-047已就此重新追蹤`tdxQueueIngress.js`／`roadManagementPolicyGate.js`／`dynamicShoulderClassification.js`／`tdx/normalize.js`／`pbs/normalize.js`全部相關檔案，非沿用先前輪次假設。

**修法內容**：僅`src/traffic/aiApprovedPbsBroadcast.js`一個檔案——移除包住CCTV呼叫的`if (event.type==='accident')`閘門本身，try區塊內部邏輯（`prepareCctvImageForEvent()`呼叫、`cctv.ok`判斷、`messages`組裝、`completedProduct`賦值、catch錯誤處理）逐字未動（僅因移除外層包裹而重新縮排，非邏輯變更）。同一檔案第203行附近另一道`event.type==='accident'`閘門（incident suppression，真實事故重複通報抑制，完全不同子系統）**未觸碰**。`resolveCctvEligibility()`／`dynamicCollage.js`／Gate A相關三個檔案**未觸碰**。`APP_VERSION`由`V2.4.17`bump為`V2.4.18`（PATCH）。

**測試**：`test/aiApprovedPbsBroadcast.test.js`新增6則測試（V2.4.18 (a)-(d)）：非accident事件（control，另迴圈construction／closure／congestion／other）在道路支援＋公里數可解析下確實到達CCTV frame-fetch階段（以freeway.gov.tw fetch spy觀察，證明閘門已移除）；負控制組（不支援道路的非accident事件仍正確被`resolveCctvEligibility()`拒絕，未被更早的其他機制擋下）；Gate A regression lock（機動路肩事件仍被`resolveTdxRoadManagementEligibility()`拒絕，與本次修改無關）；accident事件行為對稱不變（同樣到達frame-fetch，與修法前一致）；incident suppression regression lock（第203行邏輯不受影響）。**誠實揭露一項既有測試基礎設施限制（非本輪造成，本輪不解決）**：受限於`dynamicCollage.js`的真實JPEG codec在`node --test`環境下「Node-incompatible dynamic import」（該檔案自身註解），加上`aiApprovedPbsBroadcast.js`呼叫`prepareCctvImageForEvent()`時從未對外暴露`codecOverride`參數，本輪新增測試只能驗證到「CCTV流程確實被觸發、frame-fetch確實被呼叫」，無法在此測試檔案內驗證真正的`cctv.ok:true`（實際成功組出圖片訊息）——此限制對修法前既有的9則測試（含accident類型）同樣成立，並非本輪新增缺陷，本輪不處理（需要額外的codec-override傳遞管線才能解決，超出本單「僅移除閘門」的授權範圍）。既有9則測試全數維持原樣通過，無一需要更新斷言（路況-047事前判斷成立）。另因版本bump連帶更新`test/aiObservatoryView.test.js`的`APP_VERSION`硬編碼斷言（標準連帶更新）。全量迴歸2019項（2013+6新增），1986通過／33失敗；以`git stash -u`取得變更前基準（2013項，1980通過／33失敗），以測試名稱集合逐一比對，兩集合完全相同，`NEW_FAILURES=0`。

**待現場觀察事項（明確記錄，不得寫成已確認）**：下一則非accident類型（construction／closure／control／congestion／other）的國道通報，是否確實取得CCTV圖片——**尚未取得**，需上線後以查修頁或KV原始資料實際核對（依路況-045查證，現行查修頁對此觀察能力有限，僅能查得`imageUrlPresent`二元值，詳見07_KNOWN_ISSUES_03.md路況-045/046相關記錄）。

**V2.4.18封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-08，路況-049）。封版依據：程式碼變更完成（僅移除一道外層閘門）、全量迴歸2019項／1986通過／33失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.4.18`、commit已push main並驗證。發現問題一律開`V2.4.19`，不回頭改已封版的`V2.4.18`。

## 治理紀錄｜派工單回報格式精簡試行（2026-09-08，路況-051）

**背景**：真人指出近期回報動輒數千字，實質內容（已驗證/推測區分、未觸碰項目清單、方案取捨理由）皆有必要、不應刪減，但呈現方式冗長——大量散文重複陳述本可用條列/表格呈現的資訊，結尾常見整段複述派工單不授權事項清單。

**內容**：新增`AGENTS.md`第7節（試行，2026-09-08起）——精簡的是呈現方式，非實質要求：已驗證/推測區分、未觸碰項目交代、多方案取捨理由，這些內容本身仍須完整保留。具體做法：多個並列項目優先用表格/條列取代逐項散文；不授權事項確認若派工單已列清單，改為單句「不授權事項逐項確認：全數未觸碰」，僅例外項目才需額外說明；已由先前輪次確立的背景事實可用「依路況-XXX既有查證」直接引用，不需重新完整轉述；不需要把派工單背景/授權範圍用自己的話重寫一遍。明確保留、不得因精簡而省略：任何已查得/查不到判定與依據、任何推測與事實的區分標記、任何超出授權範圍或意外發現（寧可稍長也要完整揭露）、commit SHA與push驗證等硬性欄位。

**試行狀態**：本規則為2026-09-08試行，非永久定案，會議室後續若認為精簡後回報難以核對或遺漏關鍵資訊，可隨時撤回或修改，不需要特別的理由門檻。

**對照範例**：**路況-050（Telegram推播雙軌接入規劃）明確指定為本次精簡格式生效前的「精簡前」對照範例，本輪未回頭改寫路況-050原始回報內容**，保留原樣供未來評估「精簡後的下一輪類似規劃單回報」時兩相比較，判斷精簡效果是否可接受。

## 修正紀錄｜V2.5.0 Telegram頻道推播——LINE之外的第二通知管道（2026-09-08）

**新增內容**（依路況-050規劃執行，方案B）：
- 新模組`src/telegram/pushMessage.js`：`pushTelegramMessage(env, chatId, text, imageUrl)`，有圖呼叫`sendPhoto`（`photo`+`caption`一次送出），無圖呼叫`sendMessage`；逾時`AbortSignal.timeout(8000)`；`TelegramPushError`絕不在錯誤訊息中帶token（含URL本身，因Telegram API的token在URL路徑中，不同於LINE的Authorization header）。
- `wrangler.jsonc`新增`vars.TELEGRAM_CHAT_ID = "-1004328365784"`（非機密——單獨持有chat_id無法做任何事，須搭配已是頻道管理員的Bot Token才有意義）。`TELEGRAM_BOT_TOKEN`為Cloudflare Secret，真人已直接於Dashboard設定，全程未經過任何Claude session。
- `aiApprovedPbsBroadcast.js`：於既有`targets`陣列建構處，`TELEGRAM_BOT_TOKEN`與`TELEGRAM_CHAT_ID`皆存在時，加入合成target`{kind:'telegram-channel', id:chatId}`，重用既有`targetNeedsNotification`/`applyNotifiedTargets`/`persistNotifiedState`去重機制（`notified.js`既有dedupe key本就是`${kind}:${id}`，零新增去重程式碼）。既有per-target迴圈依`kind`分派：`telegram-channel`呼叫`pushTelegramMessage()`，其餘不變呼叫`pushLineMessages()`；LINE分支本身逐字未動（`git diff`核對確認）。新增獨立的`result.telegramErrors`陣列（不與`lineErrors`混用），電報失敗只記錄、不拋出、不影響同迴圈內其他target。

**本階段範圍（明確記錄）**：僅單一私有頻道（真人自己），不涉及司機開放、訂閱者管理、雙向互動（webhook/回覆/簽章驗證）。

**一項誠實揭露的既有耦合（本輪未修正，因修正即牴觸「不得改寫既有LINE分支判斷」的授權限制）**：函式既有的LINE就緒閘門（`LINE_CHANNEL_ACCESS_TOKEN`缺失、或subscriptions/notified-state KV讀取失敗）會在push迴圈之前就`return result`，此時電報也不會發送——這是「就緒層級」的耦合，與「發送層級」（本輪已證明完全獨立，見下方測試）是兩回事。現行Production此耦合為隱性（LINE token/KV健康），但誠實記錄供未來參考。

**測試**：`test/telegramPushMessage.test.js`新增8則單元測試（sendPhoto/sendMessage分派、8秒逾時signal、缺token/缺chatId、非2xx、網路錯誤、token絕不外洩）。`test/aiApprovedPbsBroadcast.test.js`新增6則整合測試（V2.5.0 (a)-(f)）：雙管道各發一次；**兩則對稱的失敗隔離regression lock**（電報失敗不影響LINE成功／LINE失敗不影響電報成功，本次「互不影響」原則最關鍵的驗證）；無圖時電報改`sendMessage`；同事件重複呼叫電報不重發（去重regression lock）；未設定Telegram環境變數時電報完全不被觸發（0呼叫，既有LINE-only行為零改變）。既有9+6則LINE測試全數不動、全數通過。全量迴歸2033項（2019+8+6新增），2000通過／33失敗；`git stash -u`基準（2019項，1986通過／33失敗），測試名稱集合比對，`NEW_FAILURES=0`。

**APP_VERSION**：`V2.4.18`→`V2.5.0`（MINOR，真人已定案採「新增一整條通知子系統」判斷）。

**待現場觀察事項（明確記錄，不得寫成已確認）**：真人自己的頻道是否確實收到與LINE同步的通知，含CCTV圖片情境（`sendPhoto`是否正確顯示圖片）——**尚未取得**。

**V2.5.0封版標記（依AGENTS.md第6節一段式封版規則）**：**SEALED**（2026-09-08，路況-052）。封版依據：程式碼變更完成、全量迴歸2033項／2000通過／33失敗、`git stash -u`對照基準以測試名稱集合比對`NEW_FAILURES=0`、`APP_VERSION`已bump至`V2.5.0`、commit已push main並驗證。發現問題一律開`V2.5.1`，不回頭改已封版的`V2.5.0`。
