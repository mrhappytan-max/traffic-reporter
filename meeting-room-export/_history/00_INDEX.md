<!-- title: 完整工程歷史索引 -->

# _history — 完整工程歷史索引（非 canonical）

來源：Repo 內 `PROJECT_HANDOFF.md`（未刪減、未縮減，仍是唯一權威的完整工程歷史）。

這裡的分段檔只是為了讓雲端也能保存完整歷史。新 Agent **不預設讀取**這個資料夾——
日常接班讀 `02_PROJECT_HANDOFF.md` 即可，只有需要追某一輪的 Root Cause 時才進來查。

分段數：8　每段上限：51200 bytes

| 檔案 | 大小 (bytes) | 涵蓋章節 |
|---|---|---|
| `PROJECT_HANDOFF_01of08.md` | 36832 | (preamble)；1. What this project is；2. Architecture at a glance；2a. Production core — current facts (as of V1.8.5, `97756a8`)；3. Data flow, in commit order (why things are shaped the way they are)；4. The V1.5 broadcast eligibility rule (the thing most likely to need tuning)；5. Fail-safe guarantees (verified by tests, don't assume — check `test/` if in doubt)；6. Cloudflare bindings & secrets (names only — never write actual values into this repo)；7. KV keys (all under the single `TRAFFIC_KV` namespace)；8. Debug endpoints (all read-only, all safe to hit repeatedly)；9. The "v1-bootstrap" trap；10. Known issues / unverified things (as of `97756a8`, V1.8.5)；11. Rollback；12. Testing；13. What NOT to do without asking；14. V1.7 CCTV 四象限選鏡規則 (4-camera cross-direction search) |
| `PROJECT_HANDOFF_02of08.md` | 39179 | 15. V1.8 CCTV 四宮格事故播報 (2x2 collage compositing)；16. V1.8.3 — 四宮格顯示文字全面中文化 (collage display text fully localized to Traditional Chinese)；17. V1.8.5 — Dynamic per-accident CCTV + LINE「事故文字 + 1 張四宮格」 |
| `PROJECT_HANDOFF_03of08.md` | 33215 | 18. V1.8.6 — TDX 用量對帳健康頁 (usage reconciliation ledger)；19. V1.8.6.1 — `/health` UI 瘦身＋TDX 額度儀表板 (quota-first mobile dashboard) |
| `PROJECT_HANDOFF_04of08.md` | 40919 | 20. V1.8.6.4 — 省道 LINE message clarity + provenance audit + broadcast provenance log；21. V1.8.6.5 — KM Location Resolver (公里數 → 司機看得懂的位置 + 地圖)；22. Production branch split, discovery + repair — `integration/v57.2-v1.8.6.5-production` |
| `PROJECT_HANDOFF_05of08.md` | 44753 | 23. V1.8.6.7 — 24h Pipeline Trace + 人工查修頁；24. V1.8.6.8 — Driver-Relevant Event Broadcast Time Policy；25. V1.8.6.9 — Mobile-first Deployment Guard；26. V1.8.6.9a — Pipeline Trace Mobile UX / Taiwan Time / Dark Mode |
| `PROJECT_HANDOFF_06of08.md` | 49271 | 27. V1.8.7.0 — Dynamic Shoulder Broadcast + Single-CCTV Strategy；28. V1.8.7.1 — Multi-event Single CCTV Budget / Fairness Fix；29. V1.8.7.2 — Dynamic Shoulder Message Simplification；30. Shared Traffic Feed — Producer/Consumer Authority Boundary, and V57.3 Pagination Integration；31. V1.8.7.4 — 國3 CCTV Support Audit |
| `PROJECT_HANDOFF_07of08.md` | 45239 | 32. V1.8.7.5 — Enable Freeway 3 CCTV Support；33. V1.8.7.3 — CCTV Prepare-Timeout Fix + Pipeline Trace Filter Fix；34. V1.8.7.6 — Pipeline Trace Filter Production Investigation |
| `PROJECT_HANDOFF_08of08.md` | 39073 | 35. V1.8.7.7 — CCTV Gray Broken Image Fix (Dynamic-Shoulder Frame Truncation)；36. Meeting Room Engineering Memory v1；37. Google Drive Connector Direct Sync V1 — permanent Agent Rule；38. V1.1 — DELTA SYNC is the default; FULL VERIFY is exception-only |
