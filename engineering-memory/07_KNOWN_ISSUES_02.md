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

**V2.4.11.1 施工令追蹤（2026-09-04）**：`V2_4_11_1_DEBRIS_CLEARED_PRECEDENCE_AND_MEMORY_SYNC_HOTFIX` 施工令第二部分明確指示「由人類在既有 Google Drive 資料夾先建立 `07_KNOWN_ISSUES_02.md`（真人帳號），確保 Service Account 對該檔案有更新權限，然後重新執行 sync」——與本節上方選項 1 完全一致。本 session 於本輪執行前，以唯讀方式（`search_files`，`parentId` 限定在目標資料夾）核對該資料夾目前實際內容：**`07_KNOWN_ISSUES_02.md` 尚未存在**，資料夾內仍只有原本 10 份 canonical 檔案（`00`～`07_KNOWN_ISSUES.md`／`PRODUCTION_MANIFEST.json`／`SYSTEM_STATE.json`，皆為 `mr.happytan@gmail.com` 真人帳號所有），另有數個 `_archive_*` 資料夾與一個 `CONNECTOR_TEST.txt`。**人類尚未完成第一步**，因此本輪未重新觸發 sync（重跑只會重現同一個已知 403，無新資訊），也未將本卷／`PRODUCTION_MANIFEST.json`／`SYSTEM_STATE.json` 標記為 `SYNCED`——這三者對 Google Drive 的同步狀態誠實維持 `BLOCKED_PENDING_HUMAN_ACTION`，`FINAL` 不因此標記為 `SEALED`（施工令自己的要求：三者皆 `SYNCED` 才能 `SEALED`）。**下一步**：人類完成 Drive 端建檔後，任一未來 session 只需重新觸發（或等下一次 push 自然觸發）`Sync Engineering Memory to Google Drive` workflow 即可驗證是否解除，不需要新的程式修改。

## 修正紀錄｜V2.4.11 散落物安全風險分級／LINE Push 額度保護（2026-09-04）

**任務**：`V2_4_11_DEBRIS_SAFETY_RISK_CLASSIFICATION_AND_PUSH_PROTECTION`（路況工程部｜V2.4.11 散落物安全風險分級／LINE Push 額度保護施工令）。MINOR。GEO_MODIFIED=NO、ROAD_POLICY_MODIFIED=NO、QUEUE_MODIFIED=NO、INCIDENT_MEMORY_MODIFIED=NO、CCTV_MODIFIED=NO、PRODUCTION_FLAGS_MODIFIED=NO、AI_SECOND_CALL_ADDED=NO。

**問題背景**：PBS/TDX 皆可能收到 掉落物／散落物／異物／輪胎皮／貨物掉落／不明物體 事件，形狀從真正危險的在途障礙物（例如國道中間車道有輪胎皮，可能導致閃避/碰撞/爆胎/失控）到毫無細節的模糊回報（例如「95K+200路面發現散落物狀況」，只有道路/方向/公里數/散落物四個字，完全沒有物體種類/大小/數量/車道位置/交通影響）都有。施工令明確禁止兩種極端做法：「所有散落物一律 LINE Push」（會淹沒真正重要的通知並浪費有限的 LINE Push 額度）與「所有散落物一律不通知」（會漏掉真正危險的在途障礙物）。每一則 LINE Push 都應該值得一位正在行駛中的駕駛分心查看。

**設計原則（施工令§一）**：散落物是否值得通知，取決於「位置（是否在正常行駛車道內）」「物體種類/大小/重量」「數量」「是否已影響通行」「是否可能導致駕駛閃避/碰撞/爆胎/失控」的組合判斷，而不是單純的 `eventType === debris`。

**新模組**：`src/traffic/debrisRiskPolicy.js#resolveDebrisSafetyRisk(event)`——純函式、同步、零 I/O（無 network/KV/D1/R2/Durable Object），自成一套本地關鍵字表，刻意不 import `pbs/classify.js` 的 `OBSTRUCTION_PATTERNS` 或 `traffic/anomalyClassification.js` 的規則（沿用本專案既有「每個模組各自保有可獨立閱讀的關鍵字表」慣例，例如 `aiCandidate.js` 自己的 `OTHER_TOP_LEVEL_PLACES`）。

**分級邏輯（優先序，第一個命中者勝，施工令§二/三/五/六/七/八/十六/十七）**：
1. **`HIGH_RISK`**——以下任一命中即成立，且**必定優先於**路肩/已清除等訊號檢查（這正是正確處理「路肩大型物體部分侵入外側車道」仍須判 HIGH_RISK 的關鍵設計）：
   - 車道位置：內側/中間/外側/快/慢車道、車道中央、路中央、行車道（刻意不含泛用詞「路面」，故裸的「路面發現散落物狀況」不會被誤判為車道位置命中）
   - 大型/堅硬/高危險物體：整條輪胎、大片輪胎皮、大型金屬、鐵件、木板、棧板、梯子、家具、貨物、大型紙箱或箱體、石塊、工具、車體零件、大型塑膠件（必須有原始文字支持，本模組從不自行判斷「AI 覺得它很大」）
   - 多件/大範圍數量：多塊、多個、散落多處、大量、整批貨物、多件
   - 明確交通影響文字：影響通行、車輛閃避、占用或佔用車道、封閉車道、阻礙交通、危險、緊急排除中
   - **加分訊號（施工令§十二建議的加強）**：結構化 `blockedLanes>=1`（TDX 自己的結構化欄位）視為等同於明確交通影響——比自由文字更可靠的訊號
   - `HIGH_RISK` 仍完整交由既有 AI 二次確認，**從未直接繞過 AI 送 LINE**（施工令§三明確禁止）
2. **`LOW_RISK`**——僅在①未命中任何條件時才檢查：僅路肩（且無車道侵入、無大型危險物證據——這兩項因為①已檢查過而保證成立）、路外/安全島/邊坡/非行車區域、已清除/已排除/已恢復/已移除/已拖離/已無障礙（施工令§十七：已解除的散落物無需新 LINE）、明確小型碎屑且明確不影響車道
3. **`AI_REVIEW`**——散落物相關但①②皆未命中（施工令§五真實範例：「95K+200路面發現散落物狀況」），交既有 AI 決策使用原始文字＋既有結構化事實綜合研判，本模組**從不**在此直接猜測 notify

**AI Prompt 補充（施工令§九，`src/pbs/aiDecisionEngine.js` SYSTEM_PROMPT）**：既有 V2.4.2「二、預防性駕駛安全風險」段落補充散落物專屬判準——高信心 notify=true 候選（明確車道內/大型堅硬物/數量多/明確交通影響）與低信心、傾向 notify=false 候選（僅路肩路外/已清除/模糊描述無具體證據）。**明確禁止 AI 替原文沒有明確提到的散落物事實杜撰描述**（例如原文只寫「發現散落物狀況」，AI 不可以自行加上「大型掉落物」「占用車道」「車輛緊急閃避」等原文沒有的字眼）；資訊不足時應傾向 notify=false，而不是套用「散落物本身就是危險的」這種一般性推論。

**整合點**：
- `src/pbs/aiCandidate.js#buildAiCandidate()` 一次計算 `candidate.debrisRisk`，沿用 `displayKM`/`blockedLanes`/`geoEvidenceType` 的「永遠存在、缺席時為 null／`isDebrisEvent:false`」慣例。
- `src/pbs/debugPush.js#runAiDecisionPath()`——經確認為 PBS 與 TDX **唯一共用的入口**（僅一個呼叫點）——在既有 `if (!candidate)` 判斷之後新增 LOW_RISK 短路，回傳新 `AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK`，在任何 AI 呼叫**之前**排除，0 額外 AI 呼叫。既有的終局結果 vs 可重試結果判斷邏輯（只有 `AI_CALL_FAILED` 會重試）不需任何修改即可正確處理這個新結果（終局、寫入 Observatory、不重試）。
- `src/pbs/aiDecisionEngine.js#buildAiUserPrompt()` 把 `candidate.debrisRisk` 當作額外結構化事實傳給 AI（從不是第二次決策）。
- `src/pbs/aiObservatoryIndex.js`：新 `AI_OUTCOME.DEBRIS_EXCLUDED_LOW_RISK`；`buildAiObservatoryRecord()` 新增 `debrisRisk` 欄位（直接讀 `candidate.debrisRisk`，沿用 `geoEvidenceType` 同一種零額外 KV 寫入模式——同一筆既有的每事件 Observatory write 上多一個欄位，不是新的 write）；`deriveFinalDecisionReason()` 新增對應分支。
- `src/pbs/aiObservatoryView.js`：新增「散落物安全風險分級（DEBRIS RISK）」唯讀展開區塊（🔴HIGH_RISK/🟡AI_REVIEW/🟢LOW_RISK＋evidence＋reasons＋FINAL_NOTIFY_REASON），PBS 與 TDX 記錄共用同一段顯示邏輯，server-rendered 零 client-side JavaScript（沿用既有 Admin CSP `default-src 'none'` 紀律）。

**KV 成本**：`NEW_KV_READS/WRITES/LISTS/DELETES_PER_EVENT = 0`（施工令§十三明確要求）——沒有新 KV key、沒有風險快取、沒有 lookup table；`debrisRisk` 純粹是既有那一筆 Observatory write 上新增的欄位。

**安全邊界（施工令§十九，本輪明確未觸碰）**：TDX GEO Resolver、Freeway KM 驗證範圍、PBS 地理閘門、道路管理政策（`roadManagementPolicyGate.js`）、Queue 架構、Incident Memory、dedupe、CCTV、Production flags、AI model、LINE token/quota 系統。

**測試**：新增 `test/v2411DebrisSafetyRiskClassificationAndPushProtection.test.js`（25 項，涵蓋施工令§十八 CASE 1-19 全部要求——每個分級分支、路肩/數量優先序測試(§七/§十六驗證)、結構化 blockedLanes 加分訊號、PBS/TDX 透過同一函式的一致性、GEO/道路政策/LINE formatter 零干擾、0 KV 操作驗證、非散落物事件完全不受影響——外加端對端整合測試證明 LOW_RISK 短路真正跳過 AI 呼叫與 LINE 推播）。2 個既有測試檔（`test/aiDecisionEngine.test.js`、`test/v242InformationFidelityAndPolicy.test.js`）因 `buildAiRequest` user payload 新增 `debrisRisk` 欄位而更新 key 列表斷言（非回歸，附加欄位）。全量迴歸 1839/1807/32，`git stash -u` 同 commit 精確基準比對 NEW_FAILURES=0。`APP_VERSION` V2.4.10→V2.4.11（MINOR）。

**通則**：一個「是否該通知」的判斷，如果只靠事件類型標籤（`eventType === debris`）就決定，永遠會在「漏掉真正危險的」與「淹沒真正重要的」兩個方向之一犯錯；正確做法是先用可驗證的結構化事實（位置、物體種類、數量、明確影響描述）做決定性分類，把少數清楚有害與少數清楚無害的情況直接排除或直接交給 AI 二次確認，中間真正模糊、證據不足的情況才完整交給既有語意判斷模型，且明確要求模型在證據不足時保守（notify=false），而不是替換成另一種同樣武斷的「一律」規則。

## 修正紀錄｜V2.4.11.1 散落物已清除優先序修正（2026-09-04）

**任務**：`V2_4_11_1_DEBRIS_CLEARED_PRECEDENCE_AND_MEMORY_SYNC_HOTFIX` 第一部分。`APP_VERSION` V2.4.11→V2.4.12（PATCH）。

**真實 bug**：V2.4.11 上線的散落物分級器把「HIGH_RISK 一律優先檢查」訂為絕對規則，這在「路肩+車道侵入」「數量+路肩」等情境是正確的，但對「已清除」情境是錯的——「中間車道有輪胎皮，已清除，恢復正常通行」被誤判 HIGH_RISK，因為車道位置檢查搶先命中，已清除的事實從未被真正看見。已解除的危險不應該繼續消耗 AI/LINE 資源。

**修法**：`src/traffic/debrisRiskPolicy.js` 新增 CLEARED_TERMINAL 判斷，在 HIGH_RISK 檢查**之前**執行（本模組唯一一個「反過來」的例外）——已清除訊號（原文 已清除/已排除/已恢復/已移除/已拖離/已無障礙，或結構化 `lifecycle==='CLEARED'`，由 `aiCandidate.js` 既有的 `lifecycle` 參數傳入，不重新推導）且**沒有**伴隨「仍在持續」訊號（仍有/仍在/尚有/未清除/未完全/部分/持續/尚未）時，無論原文是否也提到車道位置/危險物/數量/交通影響，一律 LOW_RISK。若已清除訊號伴隨持續性訊號（例：「已清除部分，仍有散落物」），**不**套用此優先序，正常走 HIGH_RISK/LOW_RISK/AI_REVIEW 判斷（依剩餘證據）。`resolveDebrisSafetyRisk()` 新增第二參數 `lifecycle`（純字串，非 KV/env binding，函式仍完全同步零 I/O）；既有單參數呼叫方式不受影響（`lifecycle` 為 `undefined`，永不等於 `'CLEARED'`）。

**測試**：`test/v2411DebrisSafetyRiskClassificationAndPushProtection.test.js` 新增 CASE A（已清除+車道位置→LOW_RISK）／CASE B（已清除部分+仍有散落物→不得LOW_RISK，依證據判HIGH_RISK；另一變體：無其他證據→AI_REVIEW）／CASE C（結構化 lifecycle=CLEARED 觸發同一優先序，含伴隨持續性訊號、非CLEARED lifecycle 兩個變體）／CASE D（路肩大型物體部分侵入外側車道，無已清除訊號，維持既有規則 HIGH_RISK）／既有 V2.4.11 CASE 1／CASE 4 迴歸確認未受影響。全量迴歸 1849/1817/32，`git stash -u` 同 commit 精確基準比對 NEW_FAILURES=0。

**未觸碰**：GEO Resolver、Queue、Incident Memory、CCTV、KV 讀寫形狀、LINE quota 架構、Production flags——僅 `debrisRiskPolicy.js`／`aiCandidate.js` 兩個檔案改動，皆在散落物分級這一個模組範圍內。

**通則**：一個「優先序規則」如果只用單一維度（本例「HIGH 一律先查」）就套用到所有情境，遲早會遇到一個更根本的事實能推翻它（「已經解除的危險」不是「歷史上曾經很危險」）——正確做法不是放棄整個優先序，而是找出那個更根本的例外條件本身的判準（本例：解除訊號是否真的完整、沒有被同一句話裡的「仍有/部分」矛盾），只在那個窄範圍內反轉優先序，其餘情境維持原規則不變。

## 修正紀錄｜V2.4.13 查修頁「不通報原因」高可視化改版（2026-09-04）

**任務**：`V2_4_12_OBSERVATORY_NO_SEND_REASON_HIGH_VISIBILITY_UI`（路況工程部｜V2.4.12 查修頁「不通報原因」高可視化改版施工令）。`APP_VERSION` V2.4.12→V2.4.13（PATCH）。**OBSERVABILITY／UI ONLY**——本輪未修改任何 AI 判斷政策／TDX／PBS／GEO／ROAD_POLICY／Queue／LINE／Incident Memory／KV 架構／CCTV／Production flags。

**版本號說明**：施工令自己寫的是 `APP_VERSION_BEFORE=V2.4.11 / AFTER=V2.4.12`，但本 session 開工時實際已是 V2.4.12（同一 session 前一輪 `V2_4_11_1_DEBRIS_CLEARED_PRECEDENCE_AND_MEMORY_SYNC_HOTFIX` 已把 V2.4.11 升到 V2.4.12）。依本專案永久規則（版本號不得對兩個不同 diff 重複使用），本輪改為 V2.4.12→V2.4.13。

**問題**：查修頁收合卡片先前只顯示「🤫 AI：不需主動通報 / LOW」等極簡狀態徽章，使用者必須點開展開頁、找到 AI 區塊、讀 reason 欄位，才知道「為什麼沒發」——手機現場查修非常不便，也讓「系統處理失敗」與「AI 正常判定不通報」難以第一眼分辨。

**修法**：`src/pbs/aiObservatoryView.js` 新增 `deriveCompactNoSendReason(record, decision)`（純函式，已 export 供直接單元測試）——只從既有資料選一個最具體的原因字串，優先序：AI_NOTIFY_FALSE 時優先用**既有 AI decision cache 的真實 reason**（查修頁本來就已對每一列讀取這份 cache，本輪未增加任何 KV 讀取）；否則依 outcome 套用一組人話化樣板（道路政策/GEO/散落物 LOW_RISK 皆重用既有欄位如 `blockedLanes`／`debrisRisk.reasons`）；系統失敗（AI 呼叫失敗/回應無效/背景重試耗盡）標籤改為「❌ 處理失敗原因」，與正常判定不通報的「❌ 不通報原因」明確區分；找不到任何真實原因時誠實顯示「系統未記錄詳細原因，請展開查看流程紀錄。」，絕不捏造。原因文字超過 100 字時決定性截斷加刪節號，完整原文仍完整保留在展開頁。新區塊直接嵌在 `<summary>` 內（不需展開即可見），鮮紅 `#f85149`（沿用既有 `.badge-line-fail` 同一個危險色，非新色）、粗體、18-20px，可換行 2-3 行，`flex-basis:100%` 確保永遠自成一行、不與 LOW 徽章重疊。

**同步小修**：`src/pbs/aiObservatoryIndex.js#deriveFinalDecisionReason()` 新增唯一一個新分支——`AI_NOTIFY_TRUE` 但 `lineSent` 從未為真時，若既有 `sameIncident===true && materialChange===false`（Incident Memory 既有欄位），回報「重複事件：與近期已通知過的同一起事故相同，且無實質變化，未重複發送」，取代先前掉進 default 分支顯示的無意義 `UNKNOWN / NOT RECORDED`（真實存在的資料缺口，非新判斷）。此函式既有每一個分支的原始字串**逐位元組不變**（`test/v246TracePageTdxAndDecisionReasonSummary.test.js` 既有鎖定斷言全數原樣通過）。

**測試**：新增 `test/v2412ObservatoryNoSendReasonHighVisibilityUI.test.js`（15項，施工令§十八CASE1-13全覆蓋，含AI/GEO/道路政策/處理失敗/重複事件五大原因來源、截斷/未截斷、原因缺失、收合可見、展開頁資料完整保留、0額外KV寫入、AI/GEO/道路政策/LINE決策邏輯不變）。全量迴歸1864/1832/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。

**未觸碰**：AI SYSTEM_PROMPT、AI notify 政策、散落物分級政策、GEO、TDX KM範圍、PBS篩選、道路管理政策、Queue、Incident Memory（僅讀既有欄位）、dedupe、LINE formatter、CCTV、Production flags。

**通則**：一個「查修頁只顯示結果、不顯示原因」的可觀測性缺口，往往不需要新的判斷邏輯就能補齊——真正的原因資料通常早已被上游系統算出並持久化（本例：AI decision cache 的 reason 欄位、既有 outcome 分支各自代表的具體原因），缺的只是「把它搬到使用者第一眼能看到的地方」這一層 UI 呈現工作；把這種純呈現層修正跟「新增一次判斷」混為一談，容易導致不必要地擴大改動範圍到決策邏輯本身。

## 修正紀錄｜V2.4.14 查修頁不通報原因視覺強化 Hotfix（2026-09-04）

**任務**：`V2_4_13_1_OBSERVATORY_NO_SEND_REASON_VISUAL_CONTRAST_HOTFIX`（路況工程部｜V2.4.13.1 查修頁不通報原因視覺強化 Hotfix）。`APP_VERSION` V2.4.13→V2.4.14（PATCH，施工令自寫「V2.4.13.1」，本專案已於 V1.8.7.14 起退休四段式版號，依前例 `V2_4_11_1_...` 同一套處理方式改走三段式）。**純 CSS／呈現層 Hotfix**——本輪未修改任何 AI 判斷／TDX／PBS／GEO／道路政策／Queue／KV／LINE／散落物政策／Incident Memory／CCTV／Production flags。

**問題**：V2.4.12/V2.4.13 新增的「不通報原因」紅字區塊，標題與本文皆為同一種紅（`#f85149`／深紅背景 `#2b1414`），Production 真實回報：手機深色模式下對比不足、長句不易快速掃讀。

**修法**：`src/pbs/aiObservatoryView.js` 的 `PAGE_STYLE` 三層重新分色（僅 CSS，`deriveCompactNoSendReason()` 與其樣板字串逐字不變）——外框（背景 `#2b1414`／邊框 `#4a1f1f`）維持深紅不變，作為警示訊號；標題（「❌ 不通報原因：」／「❌ 處理失敗原因：」）改為亮黃 `#facc15`（本頁新增色，既有 warn 色 `#e3b341` 對比不足以達到本輪要的跳躍感）、字重 800、19-20px，作為快速定位錨點；本文（真正原因）改為近白 `#f2f3f5`（沿用本頁既有最亮文字色，h1／`.col-road` 同一色，非新色）、字重 700、18-20px，專為閱讀優化。明確遵守施工令§三「禁止整段全黃」——標題與本文是兩個不同顏色規則，絕非同一色套用全區塊。

**測試**：新增 `test/v24131ObservatoryNoSendReasonVisualContrastHotfix.test.js`（5項，施工令§七CASE1-5全覆蓋：一般不通報卡片配色、系統失敗卡片同一套視覺規則、手機寬度正常換行不破版、原因文字逐字不變、0額外AI/KV/決策變動）。全量迴歸1869/1837/32，`git stash -u`同commit精確基準比對NEW_FAILURES=0。

**未觸碰**：AI SYSTEM_PROMPT、AI notify政策、散落物分級政策、GEO、道路管理政策、Queue、Incident Memory、dedupe、LINE formatter、CCTV、Production flags、`deriveCompactNoSendReason()`本身的原因選擇/截斷/缺失回報邏輯。

**通則**：一個「視覺對比不足」的真實使用者回報，正確修法幾乎總是純粹的呈現層調整（顏色/字重/字級），不需要也不應該連動任何資料或判斷邏輯——把 CSS 微調範圍收得越窄，越能用最小的迴歸風險換到真正要的可讀性改善。

## 修正紀錄｜V2.4.15 QWEN FAST AI MODEL REPLACEMENT（2026-09-04）

**任務**：`TRAFFIC_REPORTER_V2_4_15_QWEN_AI_MODEL_REPLACEMENT`（路況播報員｜V2.4.15 正式施工令 QWEN FAST AI MODEL REPLACEMENT）。`APP_VERSION` V2.4.14→V2.4.15（PATCH，施工令自身明確要求三段式，不得使用 V2.4.14.1/V2.4.15.1）。HIGH priority，**ROOT CAUSE FIX／MINIMAL MODEL REPLACEMENT**——本輪僅換一個 model 常數，Prompt／Timeout／Queue／KV／GEO／道路政策／LINE 全數未動。

**Production 48h 真實樣本**：34 次 AI 呼叫，29 次（≈85%）撞到 45 秒 `AI_CALL_TIMEOUT_MS`。

**Direct 20-call GLM 基準測試**（`@cf/zai-org/glm-4.7-flash`）：AVG=43,833ms／P50=34,142ms／P95=81,800ms／MAX=104,677ms，>45s 佔 25%。

**根因確認**：`PIPELINE_OVERHEAD≈0ms`——`TRAFFIC_REPORTER_CALL_CHAIN_PROBLEM=NO`，`MODEL_LATENCY_PROBLEM=YES`。glm-4.7-flash 是 reasoning 模型，對本專案簡短即時交通判斷任務產出過長 completion（`completion_tokens≈2,413`，`reasoning≈4,101` 字元），這是本專案 Queue 重試放大與 KV write amplification 的上游根因，不是呼叫鏈本身的問題。

**Qwen shadow 基準測試**（`@cf/qwen/qwen3-30b-a3b-fp8`）：AVG=3,897ms／P50=3,747ms／P95=5,701ms／MAX=6,222ms，`TIMEOUT>45s=0/20`，`SCHEMA_VALID=20/20`，同一批測資 notify/impact 判定與 GLM 100% 一致。官方決策：`NEW_MODEL=@cf/qwen/qwen3-30b-a3b-fp8`。

**修法（本輪唯一 Runtime 修改）**：`src/pbs/aiDecisionEngine.js` 的 `PBS_AI_MODEL_ID` 從 `'@cf/zai-org/glm-4.7-flash'` 改為 `'@cf/qwen/qwen3-30b-a3b-fp8'`。確認整個 runtime 僅從此一常數讀取 model 名稱，沒有第二個 model 常數（`test/v2415QwenAiModelReplacement.test.js` CASE 1 掃描該模組程式碼區段，排除註解，確認僅一個相異 model 字面值）。`wrangler.jsonc` 一處 V1.9.9 Phase 3B AI binding 說明性註解同步更新（非實際 config／binding 值本身，binding 名稱 `AI` 不變）。

**明確未動（施工令§三-§八）**：`AI_CALL_TIMEOUT_MS` 維持 45000ms——45s 現在純粹是異常情況的安全上限，Qwen 真實 P95≈5.7s／MAX≈6.2s 正常情況下不應接近它；若未來 Qwen 真的撞到 45s，那本身就是需要調查的異常，不是延長等待的理由。`SYSTEM_PROMPT`／`buildAiUserPrompt()`／`MEMORY_CONTEXT_PROMPT_SUFFIX` 逐字不變——沒有新增壅塞 hard rule、沒有新增事件關鍵字閘門、沒有縮短 prompt、沒有改寫散落物/事故/施工/cleanSummary 規則；本輪目的不是重新設計 AI 政策，本專案「決定性安全/地理政策留在 code，一般路況語意判斷留給 AI」的分工不變。AI request 未新增 `max_tokens`／`temperature`／`top_p`／`seed`／`response_format`／`json_schema`／`stream`——純粹只換 model ID 一個變數，避免同時改兩個變數導致無法歸因任何改善。`PBS_AI_QUEUE` 架構不變：`max_batch_size=1`、`max_retries=3`、既有 retry/ack 邏輯，本輪未做任何額外 retry 優化（預期 Qwen 上線後 Queue 重試自然下降）。KV 不變：decision-cache／observatory-index／pipeline-trace／push-idempotency／event-cleared／TTL／KV key schema／timestamp key（KV write amplification 已確認是 AI-timeout→Queue-retry 的下游結果，先修上游 model，重試消失後 KV 寫入放大應會自然下降）。LINE／GEO／道路政策安全邊界不變：TDX GEO Resolver、Freeway KM Resolver、PBS 地理、道路管理政策、Debris Risk Policy、Incident Memory、dedupe、CCTV、LINE formatter、LINE quota、notification hours、Production flags。

**測試同步**：新增 `test/v2415QwenAiModelReplacement.test.js`（11項，覆蓋施工令§十二 12項 checklist 中第1-9項；第10-12項〔既有 AI Decision 測試 PASS／既有 drift 測試 PASS／全量迴歸 NEW_FAILURES=0〕由既有測試檔與本輪全量迴歸本身驗證，不重複斷言以避免同一事實有兩個可能衝突的來源）。更新 `test/aiDecisionEngine.test.js`／`test/v242InformationFidelityAndPolicy.test.js`／`test/tdxUnifiedAiPipeline.test.js` 的 model 字串斷言。`test/pbsAiConfigDriftHotfixV202.test.js` 的 drift-protection 測試 5（原本鎖定「model 未變仍是 glm-4.7-flash」）依施工令§九指示更名並改期望值為新的 Qwen model，其**目的**（防止未來未經授權的 model drift）保留不變；測試 6（凍結歷史檢查 `version.js` 是否仍記錄 V2.0.2 changelog）**完全未動**。全量迴歸 1880/1848/32，`git stash -u` 同 commit 精確基準比對 NEW_FAILURES=0。

**全repo歷史紀錄分類（施工令§九明確要求，禁止對歷史做全域取代）**：搜尋全 repo `glm-4.7-flash`，逐一分類——Category A（Runtime/現行斷言，本輪已更新）：`src/pbs/aiDecisionEngine.js` 的 `PBS_AI_MODEL_ID` 常數本身、上述 4 個測試檔、`wrangler.jsonc` 說明性註解。Category B（歷史 Engineering Memory／Version History／舊版本描述，本輪**未**改動，維持原文）：`00_CURRENT_STATE.md`／`02_PROJECT_HANDOFF.md`／`03_ARCHITECTURE.md`／`06_VERSION_HISTORY.md`／`07_KNOWN_ISSUES.md`（Volume 01，凍結）的既有歷史段落、`PRODUCTION_MANIFEST.json`／`SYSTEM_STATE.json` 的既有歷史欄位、`src/version.js` 的既有 changelog 段落（V1.9.9/V2.0.2/V2.4.2 等歷史記錄本身完全不動，僅新增一段 V2.4.15 changelog）。`00_CURRENT_STATE.md`／`03_ARCHITECTURE.md` 各有一處「現在的 model 是哪一個」的 FAQ／欄位性質文字（描述現況、非歷史敘事）本輪更新為 Qwen，其餘同檔案內歷史「封版」段落逐字保留。`meeting-room-export/`／`scripts/meeting-room-templates/` 為既知的獨立鏡像匯出樹（非本專案 canonical `engineering-memory/`），本輪不在範圍內，未觸碰。

**Production 部署與驗證**：main push 後由既有治理（main push→Cloudflare Workers Builds 自動部署）處理，本輪未做任何手動 deploy。本 session 沙盒環境全程無 Production 網路存取（本專案歷史上反覆確認的既知限制），依施工令§十三自身明確指示：Production `/version` 現場確認與 model 顯示確認、§十四上線後即時 smoke test（`AI_CALL_STARTED→AI決策→durationMs`，目標<10,000ms）、§十五 24小時驗收（`AI_TIMEOUT_RATE<5%`、`P50<6s`、`P95<10s`、Queue Read/Write Ratio 收斂向 1.0、`PROCESSING_FAILED` 明顯下降、KV WRITE/day 相應下降）**全部報告為 `PRODUCTION_LIVE_VERIFICATION=REQUIRES_CLAUDE_BROWSER`，不猜測、不捏造**，待具備 Claude Browser 能力的 session 或人類實際觀察後補齊。

**Google Drive 同步**：既知的 `GOOGLE_DRIVE_SYNC_BLOCKED_FOR_NEW_FILES`（service account storage quota 403）blocker 與本輪無關，依施工令§十一明確指示不重新調查、不阻擋本輪 Runtime 部署——GitHub canonical write（本次 commit）成功後即視為 Engineering Memory 已完成，Drive 同步仍誠實記錄為待人類手動於 Drive 建立本檔（`07_KNOWN_ISSUES_02.md`）後才能解除。

**通則**：一個「模型延遲太高」的根因問題，正確修法優先順序永遠是「先換掉造成延遲的那一個變數本身」，而不是「放寬容忍度掩蓋它」（延長 timeout）或「用更多 if/else 繞過需要語意判斷的情境」（把 AI 判斷改回 hard-coded 規則）——後兩者都只是把根因藏起來、換取短期指標好看，真正解決問題的動作永遠是找到並替換那個真正造成延遲的元件本身，並且一次只換一個變數，才能誠實歸因任何觀察到的改善。

## 封版紀錄｜V2.4.15 正式封版 SEALED_FOR_PRODUCTION_OBSERVATION（2026-09-04）

**任務**：`TRAFFIC_REPORTER_V2_4_15_PRODUCTION_SEAL`（路況播報員｜V2.4.15 正式封版令）。**GOVERNANCE／VERSION RECORD ONLY**——本輪不改任何 Runtime，`APP_VERSION` 維持 V2.4.15 不變。

**Production 上線確認（依本輪封版令回報；本 session 全程無 Production 網路存取，無法自行驗證，如實轉載，不得聲稱本 session 已確認）**：部署時間 2026-09-04 17:01:54 +08。Live `/version`=V2.4.15，model=`@cf/qwen/qwen3-30b-a3b-fp8`，`AI_CALL_TIMEOUT_MS`=45000。第一筆 Production AI：duration=3,302ms，outcome=AI_DECISION_VALID，notify=false，impact=LOW，無 Queue 重試。V2.4.15 首批共 4 筆：SUCCESS=4、TIMEOUT=0、INVALID=0，LATENCY_MIN/AVG/MAX=3,302/5,410/7,006ms，QUEUE_WRITE/READ/DELETE=4/4/4（`QUEUE_READ_WRITE_RATIO=1.00`），`KV_429=0`、`KV_5XX=0`、`NEW_RUNTIME_ERRORS=0`。`ROOT_CAUSE_FIX_CONFIRMED=YES`。

**24小時驗收現況**：`24H_STATISTICAL_VALIDATION=PENDING`——4 筆樣本不得描述為完整 24 小時統計，待累積滿 24 小時後與 V2.4.14 基準（Production timeout≈85%、Queue Read/Write Ratio≈1.94）正式比對，目標 `AI_TIMEOUT_RATE<5%`、`P50<6s`、`P95<10s`。

**新開 Known Issue｜BUILD_METADATA_GENERATION_BUG（OPEN）**：live buildMetadata 回報 `deployedCommit="unknown"`／`commitSource="not-yet-generated"`，本輪因此無法直接證明 GitHub V2.4.15 Runtime commit `470c87a480a3ad5a2930a9896829d1a809b306a2` 就是目前 Production 實際執行的 commit。誠實記錄：`COMMIT_MISMATCH=NO`（沒有證據顯示不符，只是無法正向證明）、`COMMIT_VERIFIED=NO`、`PRODUCTION_COMMIT_VERIFICATION=UNVERIFIABLE`。列為獨立後續治理項，不阻擋本輪封版，也不得與 V2.4.15 Runtime 本身的修正混為一談——下一輪若要處理，應是「讓部署流程正確寫入 buildMetadata.deployedCommit」這個獨立議題，不涉及 AI model/Prompt/Queue/KV/GEO/LINE。

**封版規則**：`APP_VERSION` 固定 V2.4.15，不因純治理封版或後續 24h 觀測結果而變動。封版後禁止再修改 V2.4.15 Runtime；24h 驗收 PASS 只追加 `24H_VALIDATION=PASS`／`FINAL_STATUS=SEALED_AND_VALIDATED` 兩個欄位，不升版號；若發現新 Runtime 問題，必須另開 V2.4.16，不得回頭修改已封版的 V2.4.15。

**Drive Sync**：`07_KNOWN_ISSUES_02.md`（本檔）建檔本輪再次確認仍撞既知 `GOOGLE_DRIVE_SYNC_BLOCKED_FOR_NEW_FILES` service-account 403，記錄 `DRIVE_SYNC_VOLUME02=BLOCKED_KNOWN_403`，不重新調查、不阻擋封版，GitHub copy 為 canonical。

**通則**：一個「Runtime 已完成、正在被即時觀察」的版本，治理上最重要的動作不是急著再改東西，而是把「哪些是已確認事實、哪些是仍待觀察的統計」清楚分開記錄——把 4 筆樣本包裝成「24 小時驗證通過」，或把「GitHub 有這個 commit」直接等同「Production 正在跑這個 commit」，都是同一種錯誤：用手邊有的、比較容易取得的證據，去冒充原本要求的、更嚴格的證據。誠實的封版紀錄允許「已完成」與「仍待確認」同時存在，不需要為了看起來完整而硬湊。

## 治理發現｜repo 內同時存在兩份工程記憶，meeting-room-export/ 已停更並持續提供過期資訊（2026-09-06）

**發現**：唯讀查證（路況-003／路況-004 兩輪）確立 repo 內同時存在兩份獨立維護的工程記憶文件樹：`engineering-memory/`（目前實際維護中，內容反映至 V2.4.15）與 `meeting-room-export/`（由 `scripts/export-meeting-room.mjs` 產生，自 commit f0b3ad1／V2.4.4／2026-09-02 之後未再重新產生，其後 17 個 commit、V2.4.5～V2.4.15 共 11 個版本完全未反映）。兩者對「TDX 額度用盡／PBS-ONLY 模式」的現況記載直接矛盾——`engineering-memory/07_KNOWN_ISSUES.md` 記為「已由 V2.4.0+ 逐步部分還原、額度限制已解除」，`meeting-room-export/07_KNOWN_ISSUES.md` 記為「生效中」。人類已確認：TDX 額度限制為 2026 年 8 月之事，9/1 重置後已不存在，`engineering-memory/` 記載為正確，`meeting-room-export/` 為過期錯誤資訊。

**本輪處置**：已在 `meeting-room-export/00_CURRENT_STATE.md` 與 `meeting-room-export/07_KNOWN_ISSUES.md` 檔案開頭加註明顯警告區塊，說明兩檔已停更、內容過期、不得作為現況判斷依據。已修改 `AGENTS.md`：新 Agent 起點文件由 `meeting-room-export/00_CURRENT_STATE.md`／`meeting-room-export/02_PROJECT_HANDOFF.md` 改為 `engineering-memory/00_CURRENT_STATE.md`／`engineering-memory/02_PROJECT_HANDOFF.md`，並註明 `meeting-room-export/` 已停更、僅供歷史查閱。本輪未搬移、複製、刪除任何歷史內容，未合併兩份文件，未修改任何程式碼或 workflow，`meeting-room-export/` 其餘檔案未動。

**已知殘留風險**：`scripts/export-meeting-room.mjs` 目前查無任何自動觸發點（無 GitHub Actions workflow、無 npm script 自動呼叫、無 git hook），但若未來有人手動執行 `npm run export:meeting-room` 或 `npm run finalize:release`，該腳本會刪除並重建整個 `meeting-room-export/` 目錄（`rmSync(EXPORT_DIR,{recursive:true})` 後重新產生），本輪加入的警告文字會被一併沖掉，需留意。

**未結待辦（待辦，非已完成）**：`meeting-room-export/_history/` 下 9 個檔案（`00_INDEX.md` ＋ 8 個 `PROJECT_HANDOFF_XXof08.md`）含根目錄 `PROJECT_HANDOFF.md` 切分出的 V1.7～V1.8.7.7 完整歷史原文，`engineering-memory/` 目前無對應內容。這批歷史原文需另案搬遷保存後，才可討論 `meeting-room-export/` 的最終停用；本輪不處理搬遷，也不處理停用。

**另兩則待辦（原文轉錄，不補根因／解法／猜測）**：
1. 版本追溯問題與雙鐵相同，待雙鐵方案定案後比照辦理。
2. 三個排程工作（LocalMonitor／Notify／Relay）中，Notify 與 Relay 對應哪支程式尚未確認。
