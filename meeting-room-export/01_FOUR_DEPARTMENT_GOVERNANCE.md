<!-- title: 四部門聯合治理核心 -->

# 01. 四部門聯合治理核心（Human-readable｜LEVEL 2）

本檔案彙整 2026-08-22 四部門聯合治理審議（雙鐵會議部／雙鐵工程部／路況播報員會議部／路況工程部）已達成、四方無異議通過的治理核心。這是**摘要**，不是逐字全文——完整審議過程與逐字報告不在本 export 範圍內（屬聊天紀錄，非 Source of Truth）。

## 最高精神

人可能忘記，機器不能跟著忘記。人可能下錯指令，機器必須協助發現。部門必須分工，但不能互相推責。工程歷史必須完整，但不能逼每個 Agent 每次全部重讀。能自動化的安全規則，不要只依賴人記住。目標不是最多程序，而是用最少的重複工作，讓任何新的工程師（人類或 AI）都能迅速接手，並且安全地把事情做完。

## 已達成共識的治理原則（四方無異議）

1. **Human 最高決策權** — 跨部門衝突、重大產品方向、重大權限授權，最終由真人裁決；Agent 不代替真人做這類決策。
2. **會議部 vs 工程部分工** — 會議部負責方向/產品決策/責任界線/驗收；工程部負責實作/測試/Git/Deployment/工程紀錄，在既定 Authority Boundary 內具高度自主。
3. **Credential ≠ Authority** — 帳號層級憑證技術上可能摸得到其他專案的資源，不代表治理上有權動用。判準是「資產是否屬於自己部門」，不是「唯讀或寫入」。
4. **Resource Ownership First** — 任何操作前先確認「這是不是我的資源」，而不是先確認「這是不是唯讀」。
5. **Read ≠ 自動授權** — 唯讀不等於安全；跨部門唯讀查證（不論唯讀或寫入）一律先問真人，沒有例外。部門邊界內的自我查證（自己的 git log／自己的 Worker／自己的 KV／自己的測試結果）才可自主。
6. **禁止跨 repo 寫入** — 本部門（路況工程部）永久禁止修改雙鐵/rail-traffic-consumer/rail-line-gateway 的程式、設定、Cloudflare Dashboard、LINE 頻道。
7. **Producer / Consumer 邊界** — traffic-reporter 是 Shared Traffic Feed 唯一內容權威（Producer）；任何消費端（Consumer）只負責透明傳輸，不得重新判斷/重新分類/重新篩選 Producer 已經完成的內容。
8. **LEVEL 1 / 2 / 3 分層** — LEVEL 1（一頁快速接班）／LEVEL 2（Agent-readable 結構化狀態＋人類可讀完整文件）／LEVEL 3（機器可強制的 Guard 規則、歷史追查）。新 Agent 不應預設先做 Full Audit。
9. **Evidence Packet** — 跨部門溝通交付固定欄位的最小事實封包，不傳整段聊天記錄。
10. **Main as Production Source** — GitHub `main` 是唯一正式 Production 來源；沒有 feature branch、沒有 integration branch、沒有 deploy hook 可以指向別處。
11. **Lineage Drift 風險** — 以 cherry-pick（而非 fast-forward）方式收編的分支，`git branch -r --no-merged main` 會誤判為未合併（此指令比對 commit SHA 祖先關係，不比對內容）——已知風險，判斷是否已收編應以「內容是否存在於 main」為準。
12. **Branch / Worktree Lifecycle** — ACTIVE → INTEGRATING → MERGED → RETIRED → ARCHIVED；已合併且 Production 驗收完成即可標記 RETIRED，但實際刪除仍需真人批准。
13. **Guard Governance** — 能由程式判斷的規則（branch/dirty tree/main-origin 一致性/Production Lineage Drift/Binding/Cron Drift/Test Manifest/跨專案 denylist），不要只靠 Agent 記得。
14. **封版半自動化** — 部署安全條件 = Hard Guard；文件同步 = 部署後自動/半自動附加，不設成部署前的硬性關卡（避免為了過關而寫敷衍文件）。
15. **AI 必須用證據挑戰錯誤的人類技術假設** — 不盲從；查到 Authority Boundary 邊界為止，越權前先問。
16. **Engineering Autonomy Inside Owned Authority** — 在自己部門 Authority Boundary 內，鼓勵高自主（自行查修/自行測試/自行 commit/自行部署），不需要每一步都回頭問，但邊界外一律先問。

## 雲端同步治理 V2｜GitHub 是唯一正式寫入來源（2026-08-25 生效）

**這一節取代先前的做法**：舊流程是「Claude 在每次封版時，直接用 Google Drive Connector
把 changed files 上傳到雲端」。該流程**已退休**，理由不是它不正確——它當時確實有效、
也確實完成了同步——而是它的**成本**：Agent 後台逐檔上傳佔用大量流量、速度慢、
拉長封版時間、增加執行成本。

### 17. Drive Write Authority｜Claude 對 Google Drive 唯讀

```
CLAUDE_DRIVE_READ  = ALLOWED
CLAUDE_DRIVE_WRITE = FORBIDDEN
```

**可以**：讀取雲端工程記憶、讀版本紀錄、讀交接文件、比對雲端與 GitHub 的版本、
確認同步結果、把 Drive 當成接班與核對的資料來源。

**不可以**（無論理由多充分，包含「只是補一下」「同步失敗我幫忙補」）：
直接上傳、建立 canonical 檔案、覆蓋、更新內容、封存舊檔、移動檔案、刪除／Trash、
用 Connector 執行 release delta sync。

### 18. 唯一正式雲端寫入路徑

```
Claude 修改產品 / Engineering Memory
   ↓
Git commit
   ↓
GitHub（branch / main）
   ↓
GitHub → Google Drive Sync
   ↓
Google Drive 工程記憶
```

- **GitHub** = CODE SOURCE OF TRUTH ＋ ENGINEERING MEMORY WRITE SOURCE。
- **Google Drive** = READABLE ENGINEERING MEMORY MIRROR，**不是** Claude 的直接寫入目標。
- 永久順序：**GitHub first, Drive second**。
  絕不允許出現「GitHub 還沒有、Drive 卻已經先有最新版」。

### 19. 三種狀態必須分開講，不得混為一談

| 狀態 | 意思 |
|---|---|
| `GITHUB_ENGINEERING_MEMORY` | 本次 Engineering Memory 是否已正式 commit 進 GitHub |
| `GITHUB_TO_DRIVE_SYNC` | GitHub 端同步程序是否已把它同步到 Google Drive |
| `CLAUDE_DRIVE_UPLOAD` | Claude 是否直接用 Connector 寫入（本規則生效後永遠是 NO） |

正常完成版：

```
GITHUB_ENGINEERING_MEMORY = SEALED
GITHUB_TO_DRIVE_SYNC      = PASS
CLAUDE_DRIVE_UPLOAD       = NO
```

**不要再使用**含糊的 `MEETING_ROOM_CLOUD_SYNC = PASS`——它沒有說「是誰同步的」。

### 20. 自動同步還沒好的時候，誠實標 PENDING

GitHub → Drive 自動同步若尚未完成或尚未正式驗證，
**不得**為了讓 Drive 看起來是最新版而改由 Claude 人工補上傳。正確狀態是：

```
GITHUB_SEAL               = PASS
GITHUB_ENGINEERING_MEMORY = SEALED
GITHUB_TO_DRIVE_SYNC      = PENDING
CLAUDE_DRIVE_UPLOAD       = NO
```

然後**停止**。把 `PENDING` 硬補成 `PASS` 是假報，比同步延遲嚴重得多——
延遲只是慢，假報會讓未來所有人相信一個不存在的狀態。

### 21. ONE TASK → ONE CLOSEOUT → ONE SEALED STATE

任何 Bug／功能／架構更動完成後，**不得直接開始下一件**。必須先走完：

修改完成 → targeted tests → 必要 regression → NEW FAILURES = 0 → commit → main
→ 必要 deploy → 更新 Engineering Memory → GitHub commit/push
→ 確認 GitHub → Drive Sync 狀態 → SEALED → Current Task = none → STOP

禁止「Task A 還沒封版就開 Task B，然後回頭又改 A」——那正是 main／Drive／
Agent 記憶三邊版本漂移的成因。

### 22. 封版後 Current State 的固定寫法

```
Current Task          = none
Latest Completed Task = 本次剛完成的 Task
Status                = SEALED
```

除非真的還有施工中項目，否則 `Current Task` 不得停留在舊任務——
下一個 Agent 看到舊的 taskSeal 會誤以為還在施工，然後重複修改。

### 23. 歷史紀錄不改寫

先前由 Claude Connector 完成的 `Google Drive Delta Sync = PASS`
**是真的完成了**，不刪除、不改寫成失敗。只補註它的身分：

```
LEGACY_CLAUDE_CONNECTOR_SYNC = RETIRED（本規則生效後不得再使用）
```

## 尚待真人最終裁決事項

- **Cross-Department Read Authority 的精確範圍定義** — 雙鐵工程部與路況工程部已就「LEVEL A 應排除跨部門資產查詢」達成一致立場，但正式最終定案文字仍待真人統一簽署。
- 是否/何時將 Cloudflare 憑證從帳號層級 OAuth 收斂為最小權限 API Token — 列為 Governance Risk / Future Hardening，非本輪施工範圍。

## 本文件的定位

本文件是**路況工程部這一側**對已達成共識治理原則的摘要記錄，供任何新 Agent（含 ChatGPT 路況播報員 Project）快速掌握規則邊界。若與真人最終簽署的正式治理定案文字有出入，以真人簽署版本為準——本文件下一次更新時應同步核對。
