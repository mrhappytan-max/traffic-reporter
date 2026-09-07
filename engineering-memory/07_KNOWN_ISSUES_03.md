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
