<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V1.9.3（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | 2f820216b57e3acd7c257d040034301027fc5a90 |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty (5 changed source file(s)) |
| Production | DEPLOYED |
| Production Verification | Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why) |
| Current Phase | Production maintenance / LINE Push observation（無施工中項目）｜PBS-ONLY + 重大事故限定 LINE Push + 三道獨立播報閘門 + PBS 國道事故 CCTV enrichment，全部已封版 SEALED。雲端同步治理 V2 生效：Claude 對 Drive 唯讀、GitHub 為唯一正式寫入來源，GitHub Actions 自動鏡像至 Drive（實測 PASS）。TDX 額度用盡，TDX／機動路肩程式碼完整保留 |
| Current Task | none（無進行中工作）。Latest completed PRODUCT release = KV_WRITE_OPTIMIZATION_V1_9_3_PHASE_2，status = SEALED。CURRENT_PRODUCT_VERSION = V1.9.3。本輪：health:snapshot:v1 改 WRITE_ON_CHANGE（含排除 scheduledThisRun/sleeping/broadcast 區塊，本輪自己的決定性 fixture 找到的必要排除）、PBS 固定抓取改每 30 分鐘僅 07:00-22:00 Asia/Taipei（Cron 本身不變）、Pipeline Trace 新增 NO_RELEVANT_CHANGE 跳過整批寫入。決定性 fixture（跑滿一天 144 次真實 Cron tick）實測 QUIET/NORMAL/HIGH EVENT DAY writes/day = 5/21/27，遠低於施工令目標。NEW FAILURES = 0（1339 項，35 項既有失敗不變）。詳見 SYSTEM_STATE.json 的 taskSeal 與 07_KNOWN_ISSUES.md。雲端治理維持 V2：Claude 對 Google Drive 唯讀，GitHub 是唯一正式寫入來源。 |
| Latest Completed Version | V1.9.3 |
| Known Blocker | 無 blocker。兩個外部額度限制（TDX API、LINE OA 每月主動 Push）皆非本專案缺陷：TRAFFIC_SOURCE_MODE=PBS_ONLY 且 LINE_PUSH_POLICY=MAJOR_ACCIDENT_ONLY，CCTV 已恢復且仍為 0 次 TDX 呼叫。還原程序見 07_KNOWN_ISSUES.md |
| Real-world Confirmation | REAL_WORLD_CONFIRMATION_PENDING |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | 無待辦。下一個真實 Asia/Taipei 帳務日重置後，可蒐集 ≥3 筆 Production [kv-write-budget] log 樣本核實 V1.9.3 實際效果（比對 healthSnapshot/pbsFetch/pipelineTraceBatch 分類數字）。PBS Prototype feature branch 仍在 GitHub 但尚未 merge main；merge、Windows → Cloudflare 實際傳輸，皆需真人另行明確授權，不自行開始。若要開工，建議處理約 33 項過期斷言（見 07_KNOWN_ISSUES.md，既有技術債，與本輪無關）。 |
| Export Generated At | 2026-08-26T16:49:51.577Z |
| Export artifact commit | uncommitted-at-generation-time (resolved by git history, never self-referenced) |

## 版本規則（開工前必讀，2026-08-25 起永久生效）

**開工前先寫下 `CURRENT_VERSION` 與 `TARGET_VERSION`**，並確認 TARGET 是 CURRENT 的合法下一版。

- 任何**進 Production 且改變 runtime 行為**的變更，必須在**同一個 commit 內** bump
  `src/version.js` 的 `APP_VERSION`——那是本專案唯一的版本權威，`GET /version` 就是讀它。
- **任務名稱 ≠ 版本號。** `CCTV_METADATA_RECOVERY`、`TDX_QUOTA_PROTECTION` 這類是工程標籤。
- **正式產品只有一條連續版本線**，不得建立平行版本線。
- `package.json` 的 `0.1.0` 是 npm 套件版本，**與產品版本線無關**，不要混用。
- 純文件／治理／工具／測試整理不 bump 版本，但仍須有 commit。

為什麼要寫成規則：`src/version.js` 曾從 2026-08-21 起停在 V1.8.6.9 整整三週，
期間 V1.8.7.0～V1.8.7.14 全部上線，`GET /version` 卻一直回報舊版本——
因為當時有三個地方各自以為自己知道版本。詳見 `07_KNOWN_ISSUES.md` 的版本線校正紀錄。

### 版本編號格式（2026-08-25 起：三段式）

`LAST_FOUR_PART_VERSION = V1.8.7.14` 是四段式版本線的**最後一版**——
`FOUR_PART_VERSIONING = RETIRED`。`src/version.js` 目前仍是 `V1.8.7.14`，
**不提前改動**；只有下一次真正 Production runtime release 才會把它
bump 到 `V1.9.0`，同一個 commit 內完成。

`THREE_PART_VERSIONING = ACTIVE`，`NEXT_RELEASE_VERSION = V1.9.0`：

- Bug fix → patch：`V1.9.0 → V1.9.1 → V1.9.2 …`
- 明顯新功能／架構階段 → minor：`V1.9.x → V1.10.0`
- 大型不相容版本 → major：`→ V2.0.0`
- 純文件／治理／Engineering Memory／測試整理 → 不升 Product Version

## PBS 本機邊緣篩選 Prototype（2026-08-26，LOCAL_ONLY，不是本輪 Product Version 事件）

真人已在自己的 Windows 機器（`C:\Users\mrhap\traffic-reporter\pbs-relay`）完成一個
**本機（Windows）** PBS 邊緣篩選 Prototype（`localMonitor.js`/`localPrototype.js`/
`localState.js`），對官方 PBS raw feed 做服務區＋事故關鍵字篩選與
NEW/UPDATED/CLEARED/UNCHANGED 判斷，輸出 `SHOULD_PUSH` 信號。**這段程式碼已由真人
（經另一個 Windows 本機 agent）commit/push 進 GitHub 的 feature branch**
（`LOCAL_PROTOTYPE_CODE_GITHUB_STATUS = COMMITTED_TO_FEATURE_BRANCH`，
`LOCAL_PROTOTYPE_GITHUB_BRANCH = feature/pbs-local-edge-filter-prototype`，
commit `c34b52c045cd05eb4be01b91debe5ba002c73cb6`，**尚未 merge 進 main**），
Windows → Cloudflare 的實際傳輸尚未建立（`WINDOWS_TO_CLOUDFLARE_PUSH =
NOT_STARTED`）。**不影響本專案任何 Production runtime**——`PRODUCT_VERSION_BUMP =
NO`，版本仍照 Production 自己的節奏推進（與此 Prototype 無關），目前為 `V1.9.3`。
完整架構、獨立驗證後的真實測試結果、已知限制與路線圖 →
`07_KNOWN_ISSUES.md`；機器可讀狀態 → `SYSTEM_STATE.json` 的
`pbsLocalEdgeFilterPrototype`。**下一個 Agent 不要假設這個 feature branch 已經
merge 進 main，不要自行 merge，也不要自行開始 Windows → Cloudflare 的正式傳輸。**

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
