<!-- title: 已知問題（第二卷） -->

# 07. Known Issues — VOLUME 02（CURRENT）

## 卷別承接說明（ENGINEERING_MEMORY_KNOWN_ISSUES_VOLUME_02_CREATE，2026-09-04）

- **前一卷**：`07_KNOWN_ISSUES.md`（正式封存為 **KNOWN ISSUES VOLUME 01**）。
- **第二卷啟用原因**：Volume 01 已逼近本專案 Engineering Memory 單檔 81920-byte 容量上限（本輪建立時為 81898/81920 bytes，僅剩 22 bytes 餘裕），為避免下一輪開發時因文件容量不足而遺失舊 Bug／技術債／已知風險／根因／修復教訓／後續追蹤事項，立即建立本卷承接。
- **本卷不是取代前卷**：Volume 01 完整保留、未刪除任何一行既有記錄（禁止刪除舊 Bug／已修問題／Root Cause／技術債／歷史教訓，禁止為省空間大量改寫舊內容）——本卷只是接續，從本卷建立時刻起，新的 Known Issues 紀錄一律寫入本卷。
- **查歷史問題時的規則**：任何一輪要排查、引用、或核對「這個問題以前是否發生過／怎麼修的／為什麼這樣設計」，都必須**同時視 Volume 01（`07_KNOWN_ISSUES.md`）與 Volume 02（本檔）為同一份完整資料**——只讀其中一卷不足以代表完整的 Known Issues 歷史。時間順序上 Volume 01 先發生、Volume 02 接續，Volume 01 記錄截至 V2.4.10 封版（2026-09-04）為止的全部歷史。
- **索引關係**（Volume 01 因餘裕不足未寫入本行，改由此處與其他 Engineering Memory 索引文件記錄，見 `00_CURRENT_STATE.md`／`SYSTEM_STATE.json` 的 `canonicalMirrorSource`）：
  ```
  07_KNOWN_ISSUES.md     → KNOWN_ISSUES_VOLUME = 01（歷史正式封存，完整保留，唯讀延伸）
  07_KNOWN_ISSUES_02.md  → KNOWN_ISSUES_VOLUME = 02（CURRENT，新記錄寫入這裡）
  ```
- **容量規則延續**：本卷同樣受 81920-byte 單檔上限規範，從小檔案開始。未來若本卷也接近上限，依同一原則建立 `07_KNOWN_ISSUES_03.md` 依序延續，禁止提前刪除任一舊卷。
- **同步治理**：本卷已加入 `scripts/drive-sync-manifest.json`，是正式的 GitHub → Engineering Memory sync → Google Drive 鏡射對象，與其餘 canonical 檔案同一條唯一路徑，Claude 對 Drive 依然唯讀（見 Volume 01「治理變更紀錄｜DRIVE_SYNC_GOVERNANCE_V2」章節，規則不變、範圍擴大）。

## 治理變更紀錄｜ENGINEERING_MEMORY_KNOWN_ISSUES_VOLUME_02_CREATE（2026-09-04）

**這輪沒改任何 Production runtime 或程式碼邏輯，改的是「Known Issues 這份工程記憶本身要怎麼繼續長大」。**

**背景**：`07_KNOWN_ISSUES.md`（Volume 01）在 V2.4.10 封版後量測為 81898/81920 bytes，僅剩 22 bytes 餘裕——已無法安全容納下一輪任何新增記錄（即使是最簡短的一行摘要，也極易一次就突破上限），若不處理，下一輪封版時將被迫在「硬塞導致超出上限」與「因空間不足而被迫刪減/略過本應記錄的教訓」兩者之間二選一，兩者皆違反本專案「歷史 Bug 與工程教訓不因文件滿了而刪除」的既定原則。

**修法**：比照本專案既有的「單檔容量守則」精神（80KB/81920-byte per-file size guard），但這次用**新增卷冊**而非**壓縮既有內容**來解套——因為 Volume 01 本身已經歷過多輪「深度壓縮」，繼續壓縮會開始犧牲既有教訓的可讀性與完整性，不是本專案想要的權衡。新建 `07_KNOWN_ISSUES_02.md` 作為 Volume 02／CURRENT，Volume 01 完整凍結保留、標記為正式封存的歷史卷冊，兩者共同構成完整的 Known Issues 記錄。`scripts/drive-sync-manifest.json` 的 `files` 陣列新增本卷路徑，canonical 同步文件數由 10 份增為 11 份（GitHub Actions 既有 `on.push.paths: engineering-memory/**` 已涵蓋新檔案，工作流程本身不需修改）。`SYSTEM_STATE.json` 的 `cloudSyncGovernance.canonicalMirrorSource` 欄位同步更新為 11 份並註記兩卷分工；`00_CURRENT_STATE.md`（Level 1 快速接班文件，本身容量充裕）新增一行 Known Issues 卷冊索引，供新 Agent 進場時第一時間知道要查哪一卷。

**未觸碰**：Worker runtime、TDX、PBS、GEO、AI、LINE、KV、Queue、CCTV、任何 `wrangler.jsonc` Production flags。不需要、也未執行任何 Cloudflare Production 部署。

**測試**：本輪屬純文件／治理變更，未新增/修改任何 `src/` 程式碼，故未新增 targeted test；仍執行一次全量迴歸（`node --test test/*.test.js`）作為既有紀律的延續，並以既有 `git stash -u` 基準比對確認 NEW_FAILURES=0（純文件變更本就不應影響任何測試結果，此為驗證性再確認，非必要條件）。

**通則**：一份持續累積、刻意不刪除歷史的工程記憶文件，遲早會撞到任何單一儲存媒介的容量上限——正確的因應方式是「加開新卷、舊卷唯讀延伸」，而不是「壓縮到失真」或「刪減換空間」。這與版本管理系統本身「舊 commit 不因倉庫變大而被刪除」是同一個原則的不同層次體現。

## 已知阻塞｜GITHUB_TO_DRIVE_SYNC 對「新增檔案」失敗——需要人類/Workspace 管理員動作（2026-09-04，**進行中，尚未解決**）

**狀態：`GOOGLE_DRIVE_SYNC_BLOCKED_FOR_NEW_FILES`。** 誠實回報，不得報成 PASS（見 Volume 01「治理變更紀錄｜DRIVE_SYNC_GOVERNANCE_V2」的永久誠實回報規則）。

**症狀**：建立本卷（`07_KNOWN_ISSUES_02.md`）後，GitHub Actions「Sync Engineering Memory to Google Drive」連續兩次執行（commit `da50511`、修正後的 commit `2102a25`）皆失敗，錯誤訊息一致：

```
Drive API 403: Service Accounts do not have storage quota.
Leverage shared drives, or use OAuth delegation instead.
```

**第一輪根因排查（commit `2102a25`）**：讀取 job log 確認既有 10 份檔案的 find／update 呼叫全數成功（`skipped`／`updated`），只有對全新檔案的 `createRemoteFile()` 呼叫失敗——比對 Google 官方文件，`files.create`／`files.update`／`files.list` 對「共用雲端硬碟（Shared Drive）」都必須帶 `supportsAllDrives=true`（list 另需 `includeItemsFromAllDrives=true`），否則 Drive 會把操作當成對呼叫者自己（Service Account）的個人儲存空間執行，而 Service Account 個人儲存配額恆為 0。已在 `scripts/syncEngineeringMemory.mjs` 補上這兩個參數（commit `2102a25`），並新增迴歸鎖定測試。

**修正後仍然失敗，第二輪判讀**：加上 `supportsAllDrives=true` 後**同一錯誤原封不動重現**（見 GitHub Actions run 對應 commit `2102a25` 的 job log）。這代表原本的根因判斷不完整——`supportsAllDrives=true` 只在目的資料夾**真的是**一個 Shared Drive（Google Workspace 共用雲端硬碟）時才有效；Google 錯誤訊息本身明講兩條路：「Leverage shared drives」或「use OAuth delegation」，兩者都指向同一個更根本的事實：**目的資料夾很可能不是真正的 Shared Drive，而是一般（個人）Google Drive 底下、被以一般「共用」權限分享給這個 Service Account 的資料夾**。在這種設定下，Service Account 對既有檔案有編輯權限（因此 find／update／skip 全部正常），但建立一個全新檔案需要有人「擁有」它並負擔儲存配額，Service Account 本身無法擁有任何內容（無論該資料夾是否分享給它），除非：(a) 目的地本身升級/搬遷成真正的 Shared Drive，或 (b) 對這個 Service Account 設定網域級委派（domain-wide delegation），讓它可以「代表」某個真人使用者的身分建立檔案並由該真人負擔配額。這兩者都是 **Google Cloud / Google Workspace 管理主控台層級的設定**，本 repo 的程式碼或 GitHub Actions 設定都無法從程式面單方面解決。

**已驗證、非猜測的部分**：既有 10 份 canonical 檔案的同步（skip／update）完全不受影響、持續正常運作；本次阻塞**只影響「建立全新檔案」這個動作**，也就是說往後每一次新增第 12、13…份 Engineering Memory 檔案（例如未來的 `07_KNOWN_ISSUES_03.md`）都會遇到同一個阻塞，除非先由人類解決。

**已排除的可能性**：`scripts/drive-sync-manifest.json`／GitHub Actions workflow 路徑觸發規則／`syncEngineeringMemory.mjs` 的 API 參數正確性（已修正並確認參數確實有帶上，仍然 403，證明問題不在缺參數本身）。

**尚未嘗試、需要人類决定的選項（按建議順序）**：
1. **最小改動**：人類手動在該 Google Drive 資料夾內建立一個名為 `07_KNOWN_ISSUES_02.md` 的空白/佔位檔案（用真人帳號，非 Service Account）——之後本卷內容會被 `updateRemoteFile()`（既有正常運作的路徑）覆寫上去，往後每一輪同步都走 update 路徑，不再需要 create。這與現有 10 份檔案最初極可能就是這樣建立的高度吻合。
2. 將目的資料夾正式升級／搬遷為 Google Workspace 共用雲端硬碟（Shared Drive），並確認 Service Account 在該 Shared Drive 上至少有「內容管理者」權限。
3. 為這個 Service Account 設定網域級委派（Domain-Wide Delegation），改為代表某個真人身分呼叫 Drive API。

**本 session 的處理方式**：GitHub 側寫入（`GITHUB_ENGINEERING_MEMORY`）已完成且與 Volume 01 同一套治理原則一致；`GITHUB_TO_DRIVE_SYNC` 對本卷誠實標記 `BLOCKED_PENDING_HUMAN_ACTION`（不是暫時性的 PENDING，是需要人類到 Google Cloud/Workspace 主控台動作才能解除的阻塞），不偽造成功、不用任何非正式管道手動上傳搬運。`scripts/syncEngineeringMemory.mjs` 的 `supportsAllDrives=true` 修正**予以保留**——這是 Google 官方文件記載的正確作法，即使這次不是完整解方，也是必要的前置修正（若日後目的地真的搬到 Shared Drive，這個修正屆時就會生效）。

**通則**：一個 API 呼叫失敗訊息裡如果明確列出兩條建議修法（本例「shared drives」或「OAuth delegation」），代表根因落在**帳號/資源層級的權限設計**，不是「少了一個 query 參數」這種程式碼層級的小修；先按官方建議修一次、驗證是否解決，若仍然失敗，必須誠實升級判讀，而不是重複套用同一個假設。
