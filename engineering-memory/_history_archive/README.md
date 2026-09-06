<!-- title: 歷史封存說明 -->

# _history_archive/ — 歷史封存（唯讀）

本目錄下 9 個檔案（`00_INDEX.md` 與 `PROJECT_HANDOFF_01of08.md` 至
`PROJECT_HANDOFF_08of08.md`）是本輪（2026-09-06，路況-006）從
`meeting-room-export/_history/` 原樣複製而來，複製來源為當時該目錄下的實際內容，其最後一次由 commit 產生／修改為
`e351a4b61f12da0df04886b5d1434d2ca7638744`（2026-08-23，
"chore(meeting-room): regenerate export for the PBS-only release"）——本輪複製時
`meeting-room-export/_history/` 自該 commit後未再變動過，故複製結果與該 commit
留下的內容一致。逐檔已用 diff 與 sha256 比對來源與本目錄下對應檔案，確認內容
完全一致。

**原始出處**：這批檔案原本是 `scripts/export-meeting-room.mjs` 依 repo 根目錄
`PROJECT_HANDOFF.md` 的「## N. 標題」章節格式自動切分產生（見該腳本 Step 3a
的 history-chunking 邏輯）。根目錄 `PROJECT_HANDOFF.md` 目前仍存在於 repo 中，
是這批內容的原文所在；本目錄只是該次自動切分結果的一份複本，不是另一份原文。

**保存原因**：`scripts/export-meeting-room.mjs` 執行時會刪除並重建整個
`meeting-room-export/` 目錄（`rmSync(EXPORT_DIR, {recursive:true})` 後重新產生），
`meeting-room-export/_history/` 下這 9 個檔案會隨之被刪除並重新產生。目前該腳本
查無任何自動觸發點，但只要有人手動執行 `npm run export:meeting-room` 或
`npm run finalize:release`，這批切分結果就會消失。為避免 V1.7～V1.8.7.7 這段
完整歷史敘述遺失，本輪另存一份於此。

**性質**：本目錄為歷史封存，唯讀性質，不隨後續版本更新。查閱現況請看
`engineering-memory/00_CURRENT_STATE.md`，不要用本目錄下的內容判斷現況。
