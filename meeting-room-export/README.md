<!-- title: meeting-room-export 停用說明 -->

# meeting-room-export/ — 已停更，產生腳本已停用

本目錄自 V2.4.4（2026-09-02，commit `f0b3ad1`）之後未再重新產生，內容停在 11 個版本前，
`00_CURRENT_STATE.md` 與 `07_KNOWN_ISSUES.md` 開頭已加註停更警告（路況-005）。

**產生腳本已停用（路況-016，2026-09-07）**：`scripts/export-meeting-room.mjs` 執行時預設會
立即拋出錯誤並中止，不再執行 `rmSync`／重建本目錄，避免沖掉上述警告。`npm run
export:meeting-room`／`npm run sync:meeting-room` 執行前會先印出停用說明。`npm run
finalize:release` 的其他步驟（`check:deployment-policy`、Windows local-fs fallback）不受影響，
仍會正常執行；其呼叫 export 的那一步會回報失敗（`meeting-room-export: FAIL`），這是預期行為。
若確有必要強制重新產生本目錄，設定環境變數 `ALLOW_STALE_EXPORT=1` 即可解除。

**現行工程記憶正本為 `engineering-memory/`**，請至 `engineering-memory/00_CURRENT_STATE.md`
查閱現況，不要用本目錄下任何檔案判斷現況。

`_history/` 下的 9 個歷史檔案（V1.7～V1.8.7.7 完整歷史原文）已於路況-006 原樣封存至
`engineering-memory/_history_archive/`，來源本身保留未刪。
