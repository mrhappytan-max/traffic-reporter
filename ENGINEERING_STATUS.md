# ENGINEERING_STATUS.md — traffic-reporter (路況播報員)

Current-state snapshot only — no long history here. For "why" and full round-by-round detail, see `PROJECT_HANDOFF.md` (§0 CURRENT PRODUCTION TRUTH first, then §1–§21). For the human-readable release notes, see `RELEASE_SUMMARY_V1.8.5.md` / `RELEASE_SUMMARY_V1.8.6.md`.

---

## Current Production version / main HEAD

```
main HEAD: ba74d48f2c98b41f1d5b2db8a60639001ecd1109
Version:   V1.8.6.3
```

Cloudflare auto-deploys on every push to `main` — no manual `wrangler deploy` needed under normal operation.

## System status

- Production live, operating normally.
- `GET /health` — zero TDX/PBS/LINE network calls, reads only `health:snapshot:v1` + `tdx:usage:summary:v1` from KV.
- TDX usage reconciliation ledger live and accumulating (`tdx:usage:summary:v1`), current monthly point budget **3**, no open baseline-calibration gap as of V1.8.6.3.

## Latest completed work

V1.8.6.3 — TDX usage reconciliation + quota dashboard + CCTV source accounting + Aug 18 official baseline calibration.

(Full round sequence this cycle: V1.8.6 usage ledger → V1.8.6.1 quota-dashboard UI → V1.8.6.2 CCTV source/context split → V1.8.6.3 August baseline calibrated through 2026-08-18. All four merged to `main`, all four Production live.)

## Current known issues

- 2 existing, unrelated `pbs-relay/tests/*` tests fail in the full suite (missing `pbs-relay/src/cache.js`) — predates this cycle's work, not a regression, not in scope unless someone asks about `pbs-relay/` specifically.
- Local traffic bytes (`payloadBytesEstimate`) are a **local estimate** — TDX's own official dashboard remains the final reference for actual billed transfer/points.

## Next (safe actions)

- Let the Local Usage Ledger keep accumulating normally — no action needed.
- Periodically compare Local Ledger daily numbers against TDX's official dashboard for ongoing calibration (informal, human-driven — no automation for this exists or is planned).
- No more August backfill/baseline edits unless TDX's own official figures for an already-recorded date are themselves corrected.

## Do not

- Rerun the Admin CCTV metadata probe (`/admin/cctv-probe`, `/admin/cctv-hsinchu-probe`) just to test the quota dashboard — it makes a real, separately-budgeted TDX call. Only rerun it if the broadcast-facing `cctv:freeway-metadata:v1` cache has actually expired (7-day TTL) and genuinely needs a refresh.
- Delete the original CCTV probe PRE-ARM guards (`admin:cctv-probe-used:v1` / `admin:cctv-hsinchu-probe-used:v1`) or the one-time-use protection around them.
- Manually `wrangler deploy` when `main`'s Cloudflare auto-deploy is healthy — a push to `main` already ships to Production.
- Restore CMS／新竹市公車／新竹縣公車 into the Production TDX fetch list by accident — they were deliberately retired in V1.6.1; the ledger still tracks them only as a retired-source anomaly signal, not as something to re-enable.
