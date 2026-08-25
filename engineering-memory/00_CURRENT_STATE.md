<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V1.8.7.14（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | 951f547aef47ad14f1fa15488ecc04c7797bf554 |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty (1 changed source file(s)) |
| Production | DEPLOYED |
| Production Verification | Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why) |
| Current Phase | Production maintenance / LINE Push observation（無施工中項目）｜PBS-ONLY + 重大事故限定 LINE Push + 三道獨立播報閘門 + PBS 國道事故 CCTV enrichment，全部已封版 SEALED。雲端同步治理 V2 生效：Claude 對 Drive 唯讀、GitHub 為唯一正式寫入來源，GitHub Actions 自動鏡像至 Drive（實測 PASS）。TDX 額度用盡，TDX／機動路肩程式碼完整保留 |
| Current Task | none（無進行中工作）。Latest completed task = DRIVE_SYNC_GOVERNANCE_V2，status = SEALED（前序 PBS_ACCIDENT_CCTV_ENRICHMENT_FIX、PBS_ACCIDENT_TRACE_LOCATION_QUALITY_FIX、PBS_ONLY_SERVICE_AREA_GATE_FIX、PBS_CCTV_MAJOR_ACCIDENT_ONLY 亦為 SEALED）。雲端治理：Claude 對 Google Drive 唯讀，GitHub 是唯一正式寫入來源，封版時只寫 GitHub、不要自己搬檔案到 Drive；GitHub → Drive 自動同步已由真人建置並實測通過（GitHub Actions，engineering-memory/ 為 canonical mirror source），GITHUB_TO_DRIVE_SYNC = PASS；不得人工補上傳，也不要重建那套自動同步。詳見 SYSTEM_STATE.json 的 cloudSyncGovernance。觀察中（非工作項，不是待辦）：一個月後檢視實際 LINE 主動 Push 量與 insufficient-location-precision 計數 |
| Latest Completed Version | V1.8.7.14 |
| Known Blocker | 無 blocker。兩個外部額度限制（TDX API、LINE OA 每月主動 Push）皆非本專案缺陷：TRAFFIC_SOURCE_MODE=PBS_ONLY 且 LINE_PUSH_POLICY=MAJOR_ACCIDENT_ONLY，CCTV 已恢復且仍為 0 次 TDX 呼叫。還原程序見 07_KNOWN_ISSUES.md |
| Real-world Confirmation | REAL_WORLD_CONFIRMATION_PENDING |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | 無待辦。TDX 額度恢復 → 套用 07_KNOWN_ISSUES.md 的 RESTORE TDX；一個月後 → 依 ineligibleByReason 實際數據（含 insufficient-location-precision）決定是否收緊主動播報政策；若日後取得 2026-08-24 台68 那筆 PBS 原始記錄 → 回頭核對 07_KNOWN_ISSUES.md 記載的誠實限制（皆為既有程序，不需重新設計） |
| Export Generated At | 2026-08-25T13:27:42.951Z |
| Export artifact commit | uncommitted-at-generation-time (resolved by git history, never self-referenced) |

## 版本規則（開工前必讀，2026-08-25 起永久生效）

**開工前先寫下 `CURRENT_VERSION` 與 `TARGET_VERSION`**，並確認 TARGET 是 CURRENT 的合法下一版。

- 任何**進 Production 且改變 runtime 行為**的變更，必須在**同一個 commit 內** bump
  `src/version.js` 的 `APP_VERSION`——那是本專案唯一的版本權威，`GET /version` 就是讀它。
- **任務名稱 ≠ 版本號。** `CCTV_METADATA_RECOVERY`、`TDX_QUOTA_PROTECTION` 這類是工程標籤。
- **正式產品只有一條連續版本線 `V1.8.7.x`**，不得建立 V1／V2／V57.x 等平行版本線。
- `package.json` 的 `0.1.0` 是 npm 套件版本，**與產品版本線無關**，不要混用。
- 純文件／治理／工具／測試整理不 bump 版本，但仍須有 commit。

為什麼要寫成規則：`src/version.js` 曾從 2026-08-21 起停在 V1.8.6.9 整整三週，
期間 V1.8.7.0～V1.8.7.14 全部上線，`GET /version` 卻一直回報舊版本——
因為當時有三個地方各自以為自己知道版本。詳見 `07_KNOWN_ISSUES.md` 的版本線校正紀錄。

## 我能改什麼／不能改什麼（一句話版）

- **能改**：`traffic-reporter` repo 內，自己 Authority Boundary 內的程式、測試、文件、feature branch。
- **不能改**：雙鐵 / rail-traffic-consumer / rail-line-gateway 任何檔案、Cloudflare Dashboard、任何 repo 以外資產（除非有明確、針對該任務的額外授權）。
- **唯讀查證邊界**：跨部門資產（不論唯讀或寫入）一律先問真人——見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。

## 何時要找真人（最短版）

需要互動式登入/OAuth、需要 Credential、需要修改雙鐵 repo、需要破壞性 Production 操作（force push / 大量刪除 KV·R2 / rollback）、涉及跨部門 Contract Breaking Change、或證據顯示需要真人做產品決策時——才停下來問。一般程式錯誤/測試失敗/單一 repo 內查修，自行處理。

## 這份檔案之外，還想知道更多才讀

架構細節 → `03_ARCHITECTURE.md`　設計理由 → `04_PRODUCT_DECISIONS.md`　版本線 → `06_VERSION_HISTORY.md`　已知問題 → `07_KNOWN_ISSUES.md`　治理規則全文 → `01_FOUR_DEPARTMENT_GOVERNANCE.md`　接班摘要 → `02_PROJECT_HANDOFF.md`　完整工程歷史 → Repo `PROJECT_HANDOFF.md`（雲端分段見 `_history/`）

## Engineering Memory 同步治理（2026-08-25 起）

- `traffic-reporter` GitHub `main` 是唯一 canonical source。
- Google Drive `路況播報員_工程記憶` 是 automated mirror。
- 正常寫入路徑只允許 GitHub main → GitHub Actions → Google Drive API。
- 同步採 missing → create、changed → update、unchanged → skip，不自動刪除 Drive 其他檔案。
- Claude / Agent 不得日常從 Drive 反向搬回 GitHub，也不得人工逐檔上傳 Drive。
- 認證採 GitHub OIDC + Google Workload Identity Federation 短效憑證；禁止建立長期 Service Account JSON key。
