<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V1.9.4（唯一權威來源：`src/version.js` 的 `APP_VERSION`） |
| Source main HEAD | 49fa03f398ea94b8c1ac37511532c1fa3f6ce908 |
| Source main HEAD resolved from | origin/main |
| Source working tree | dirty (5 changed source file(s)) |
| Production | DEPLOYED |
| Production Verification | V1.9.4 fix verified via deterministic fixture (test/pipelineTraceReadPerformance.test.js) only — real Production TTFB NOT_OBSERVED (sandbox egress blocked, see 07_KNOWN_ISSUES.md) |
| Current Phase | Production maintenance — V1.9.4 SEALED（無施工中項目） |
| Current Task | none（無進行中工作）。Latest completed task = PIPELINE_TRACE_READ_OPTIMIZATION_V1_9_4，status = SEALED（前序 KV_WRITE_OPTIMIZATION_V1_9_3_PHASE_2、KV_WRITE_OPTIMIZATION_V1_9_2 亦為 SEALED）。CURRENT_OFFICIAL_VERSION = V1.9.4。本輪修復 /admin/pipeline-trace 與 /admin/pipeline-trace-view 的 59.1s TTFB（sequential N+1 KV read root cause），改為漸進式掃描＋有界並行讀取，實測 500 把 key／limit 60 只需 60 次 kv.get()（原本 500 次）。零新增 KV 寫入。詳見 SYSTEM_STATE.json 的 taskSeal 與 06_VERSION_HISTORY.md／07_KNOWN_ISSUES.md 的 V1.9.4 條目。Production 真實 TTFB 驗證因 sandbox 無法連線 Production 而為 NOT_OBSERVED（誠實記錄，非 PASS）。雲端同步治理維持 V2：Claude 對 Google Drive 唯讀，GitHub 是唯一正式寫入來源。 |
| Latest Completed Version | V1.9.4 |
| Known Blocker | 無程式碼層級 blocker。本 sandbox session 對 Production Worker 網域（含 Cloudflare Dashboard）的 outbound HTTPS 一律被環境自身的 egress proxy 阻擋，故本輪 Production 真實 TTFB 驗證為 NOT_OBSERVED，非本輪修復本身的問題——修復正確性已由決定性 fixture（test/pipelineTraceReadPerformance.test.js，真實 kv.get()呼叫次數/併發量測）獨立證實。 |
| Real-world Confirmation | REAL_WORLD_CONFIRMATION_PENDING |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | 無待辦。若下次有可連線 Production 的 session/人類，可補測 /admin/pipeline-trace 與 /admin/pipeline-trace-view 的真實 TTFB（no-filter／source 篩選／road 篩選三種），與本輪 fixture 量測的 kv.get() 次數對照。 |
| Export Generated At | 2026-08-27T02:59:21.275Z |
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
NO`，版本仍照 Production 自己的節奏推進（與此 Prototype 無關），目前為 `V1.9.4`。
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
