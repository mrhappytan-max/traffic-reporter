<!-- title: 版本線 -->

# 06. Version History（重要版本線，非完整 git log）

只收錄目前仍具架構意義的版本節點。commit hash 以下方列出的實際 git 證據為準（`git log --oneline`，短 SHA），非人工回憶。完整逐 commit 歷史請直接查 `git log`，不在本文件重複。

| 版本 | commit（短 SHA） | 主題 |
|---|---|---|
| V1.8.6.5 | `76a4113`→`07253f9` | KM Location Resolver（公里數 → 司機看得懂的位置 + 地圖），含官方道路位置資料整合 |
| V1.8.6.6 | `d0012e1`, `0e8349f` | Production forensic audit：非碰撞異常事件不應被誤判為事故 |
| Pipeline Trace | `3858e0a` | V1.8.6.7：24h Pipeline Trace + 人工查修頁（本專案最重要的可觀測性基礎設施） |
| V1.8.6.8 | `462e217` | Driver-Relevant Event Broadcast Time Policy |
| V1.8.6.9 | `9af8d21` | Mobile-first Deployment Guard |
| V1.8.6.9a | `5724524`, `2ae6730` | Pipeline Trace Mobile UX — Taiwan time、封閉詞彙篩選、深色模式 |
| V1.8.7.0 | `54cb6c3` | Dynamic Shoulder Broadcast + Single-CCTV Strategy（動態路肩單鏡頭策略首次引入） |
| V1.8.7.1 | `a835493` | Multi-event Single CCTV Budget / Fairness Fix（每事件獨立預算，避免先到事件餓死後到事件） |
| V1.8.7.2 | `6c109a6` | Dynamic Shoulder Message Simplification |
| V1.8.7.3 | `fa8bf22`（原始）／`62cb229`（整合進 main 後版本） | CCTV Prepare-Timeout Fix + Pipeline Trace Filter Fix（分頁 bug 修復） |
| V1.8.7.4 | `7a8ec53` | 國3 CCTV Support Audit — 唯讀稽核，**未啟用**（當時無法從 dev sandbox 確認真實 RoadID/RoadName） |
| V1.8.7.5 | `be57f88` | Enable Freeway 3 CCTV Support — 用外部唯讀查證取得的真實 Production RoadID `'000030'`/RoadName `'國道3號'` 正式啟用國3 CCTV |
| V1.8.7.6 | `40b1409` | Pipeline Trace Filter Production Investigation — 三層реproduction 皆確認 server 端無缺陷，結論為 client-side 議題 |
| V1.8.7.7 | `a3d6609`（修復）／`8e10a7a`（封版紀錄） | CCTV Gray Broken Image Fix — `extractFirstJpegFrame` JPEG marker-aware 解析修復，見 `07_KNOWN_ISSUES.md`／`02_PROJECT_HANDOFF.md` §35 完整寫法 |

## 版本線之外的重要里程碑

- **V57 系列**：Shared Traffic Feed 首次建立（`completedProducts` 持久化機制），V57.1（Shared-Feed-only CCTV top-up）、V57.3（分頁修復）陸續強化。詳見 `02_PROJECT_HANDOFF.md` §30。
- **四部門聯合治理**（2026-08-22）：非程式版本，但是本專案第一次正式治理框架定案，見 `01_FOUR_DEPARTMENT_GOVERNANCE.md`。
- **Meeting Room Export / Engineering Memory v1**（本輪）：本 export 系統本身的建立版本。

## 目前 main 最新狀態

Export 產生時的即時 git 狀態見 `SYSTEM_STATE.json`；此表格為人工整理的「重要節點」，不會每次 export 自動改寫——只在真的有新的架構意義版本產生時才手動追加一列。
