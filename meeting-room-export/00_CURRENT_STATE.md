<!-- title: 路況播報員 Current State -->

# 00. Current State（快速接班｜LEVEL 1）

新 Agent 進場先讀這一份，不要先讀其他檔案。若時間有限，只讀這一份也應該足以回答：我在哪、能改什麼、不能改什麼、現在做什麼。

| 欄位 | 值 |
|---|---|
| Project | traffic-reporter（路況播報員） |
| Department | 路況工程部 |
| Repo | mrhappytan-max/traffic-reporter |
| Current Version | V1.8.7.7 |
| Source main HEAD | b26b32335e4ef5934584b41c07fb6d2b4ecccee9 |
| Source main HEAD resolved from | origin/main |
| Source working tree | clean |
| Production | DEPLOYED |
| Production Verification | Last known: PASS_NETWORK_VERIFICATION_BLOCKED (see 07_KNOWN_ISSUES.md for why) |
| Current Phase | TDX QUOTA PROTECTION — PBS-ONLY MODE｜已封版 SEALED（TDX 額度用盡，非故障；TDX 程式碼完整保留） |
| Current Task | 無進行中工作。TDX_QUOTA_PROTECTION_PBS_ONLY = SEALED（程式、測試、部署、雲端工程記憶皆已完成收尾） |
| Latest Completed Version | V1.8.7.7 |
| Known Blocker | 無 blocker。TDX API 額度用盡屬外部條件（非本專案缺陷）：TRAFFIC_SOURCE_MODE=PBS_ONLY，Cron 路徑 TDX 呼叫為 0，PBS 正常。還原程序見 07_KNOWN_ISSUES.md |
| Real-world Confirmation | REAL_WORLD_CONFIRMATION_PENDING |
| Authority Role | traffic-reporter = Sole Content Authority (Producer)；雙鐵/rail-traffic-consumer 為 Transparent Relay（Consumer），只傳輸不重判 |
| Next Action | 無待辦。日後真人確認 TDX 額度恢復時，直接套用 07_KNOWN_ISSUES.md 既有的 RESTORE TDX 程序即可（不需重新設計，不需新版本） |
| Export Generated At | 2026-08-23T07:01:44.215Z |
| Export artifact commit | uncommitted-at-generation-time (resolved by git history, never self-referenced) |

## 我能改什麼／不能改什麼（一句話版）

- **能改**：`traffic-reporter` repo 內，自己 Authority Boundary 內的程式、測試、文件、feature branch。
- **不能改**：雙鐵 / rail-traffic-consumer / rail-line-gateway 任何檔案、Cloudflare Dashboard、任何 repo 以外資產（除非有明確、針對該任務的額外授權）。
- **唯讀查證邊界**：跨部門資產（不論唯讀或寫入）一律先問真人——見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。

## 何時要找真人（最短版）

需要互動式登入/OAuth、需要 Credential、需要修改雙鐵 repo、需要破壞性 Production 操作（force push / 大量刪除 KV·R2 / rollback）、涉及跨部門 Contract Breaking Change、或證據顯示需要真人做產品決策時——才停下來問。一般程式錯誤/測試失敗/單一 repo 內查修，自行處理。

## 這份檔案之外，還想知道更多才讀

架構細節 → `03_ARCHITECTURE.md`　設計理由 → `04_PRODUCT_DECISIONS.md`　版本線 → `06_VERSION_HISTORY.md`　已知問題 → `07_KNOWN_ISSUES.md`　治理規則全文 → `01_FOUR_DEPARTMENT_GOVERNANCE.md`　接班摘要 → `02_PROJECT_HANDOFF.md`　完整工程歷史 → Repo `PROJECT_HANDOFF.md`（雲端分段見 `_history/`）
