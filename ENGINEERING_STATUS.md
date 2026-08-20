# ENGINEERING_STATUS.md — traffic-reporter (路況播報員)

Current-state snapshot only — no long history here. For "why" and full round-by-round detail, see `PROJECT_HANDOFF.md` (§1–§21). For human-readable release notes, see `RELEASE_SUMMARY_V1.8.5.md`.

---

## Current Production version / main HEAD

```
main HEAD: ee0d159b65e703fec3d7fe16690228bea433d5fb
Version:   V1.8.6.5
```

Cloudflare auto-deploys on every push to `main` — no manual `wrangler deploy` needed under normal operation.

## System status

- Production live, operating normally.
- `GET /health` — zero TDX/PBS/LINE network calls, reads only `health:snapshot:v1` + `tdx:usage:summary:v1` from KV.
- TDX usage reconciliation ledger live and accumulating (`tdx:usage:summary:v1`).

## Latest completed work — V1.8.6.5: KM Location Resolver

Turns a raw event's KM value into a driver-readable official location (省道: 縣市/鄉鎮/村里; 國道: 前後交流道/服務區路段) plus a coordinate and a Google Maps link, sourced entirely from official government open data imported and compiled offline — **zero runtime network calls** (no TDX/PBS/Google API lookups) anywhere in the resolution path.

**Official dataset, imported and compiled:**

| Dataset | Raw rows | Compact points/facilities | Source |
|---|---|---|---|
| 省道里程坐標 (provincial) | 30,079 | **22,563** (10m left/right sign-pair dedup) | data.gov.tw 7040 |
| 國道百公尺里程樁 (freeway milestones) | — | **10,035** | data.gov.tw 95016 |
| 國道交流道／服務區 (freeway facilities) | — | **227** (207 IC + 20 SA) | data.gov.tw 166496 + 8161 |

**Required real acceptance resolutions (see `test/kmLocationResolver.test.js` tests 17/18):**

```
台13甲 9K+000
  -> resolved: true, dataset: provincial
  -> locationLabel: "苗栗縣造橋鄉造橋村"
  -> resolvedKm: 9.015 (matches the source's own documented note:
     "9K sign pair sits at 9K+015/9K+022")
  -> coordinate: 24.6285049, 120.8528022

國1 88K+000 南向
  -> resolved: true, dataset: freeway
  -> locationLabel: "湖口服務區－竹北交流道路段"
  -> segmentFrom: 湖口服務區, segmentTo: 竹北交流道
  -> coordinate: 24.84951279, 121.0179116
```

**Bundle size** (`wrangler deploy --dry-run`, with the real dataset above bundled in):

```
Total Upload: 7549.90 KiB / gzip 718.25 KiB
```

(Pre-real-data scaffold-only baseline was 850.57 KiB / gzip 227.39 KiB — see "Watch items" below.)

**Runtime cost:** 0 extra TDX/PBS/Google API calls anywhere in the resolver, formatter integration, or provenance integration — confirmed by test (`test/kmLocationMessageIntegration.test.js`, `test/broadcastProvenanceKmLocation.test.js`) and by construction (the resolver only ever reads the three bundled `data/road-location/generated/*.js` files).

**Full round sequence:** offline scaffold (importer + resolver + fail-closed design, no real data yet) → real official data landed (provincial.csv + freeway archive) → importer adapted to the real thb_7040 schema + freeway archive normalized (`scripts/prepareFreewayRawFromArchive.py`) → several pre-existing tests (`messageFormat.test.js`, `provincialRoadMessageClarity.test.js`) updated where tier 2 (official data) now legitimately outranks the old tier-3 hand-curated anchor table for roads/KMs the real dataset covers → bookkeeping correction (tolerance comment updated to reflect real measured spacing). All merged to `main`, all Production live.

## Current known issues

- 3 existing, unrelated test failures in the full suite (same before and after this cycle, not a regression):
  - 2× `pbs-relay/tests/*` (missing `pbs-relay/src/cache.js`)
  - 1× `healthQuotaDashboard.test.js` test 6 (wall-clock-dependent, not TDX/PBS/LINE related)
- Local traffic bytes (`payloadBytesEstimate`) are a **local estimate** — TDX's own official dashboard remains the final reference for actual billed transfer/points.

## Watch items

- **Bundle size** — provincial.js alone is ~4.9MB uncompressed (22,563 JSON points); Total Upload is now 7549.90 KiB / gzip 718.25 KiB, comfortably within Cloudflare Workers' published script-size limits today, but this is a real, non-trivial jump from the pre-data 850.57 KiB baseline. Re-measure (`npx wrangler deploy --dry-run`) whenever more official data is imported (e.g. additional freeway routes, the not-yet-parsed freeway.gov.tw cnid=1906 facility tables), and reconsider the KV-vs-bundle storage decision (originally deferred pending real measurement — see `PROJECT_HANDOFF.md` §21) if it keeps growing.
- Freeway facilities coverage is IC (dataset 166496) + SA (dataset 8161) only — freeway.gov.tw's own cnid=1906 HTML mileage tables were NOT parsed (archived, not yet processed; documented gap, not silently missing).
- 台26 and 南港聯絡道 milestone data exists in the archived source but was excluded from `raw/freeway/` this round (台26 is a provincial-road identity, out of `roadIdentity.js`'s freeway scope; 南港聯絡道 has no numeral form to canonicalize) — logged by `scripts/prepareFreewayRawFromArchive.py`, not silently dropped.
- ~150/30,079 provincial rows have a literal "?" in `village` (a confirmed source-side cp950→UTF-8 encoding artifact, not this project's bug) — the importer drops just that field and falls back to county+township, never guesses the real character.

## Next (safe actions)

- Let the road-location dataset stay as-is until new/updated official data is deliberately imported — no action needed for normal operation.
- If official data.gov.tw datasets 7040/95016/166496/8161 publish an update, re-run `npm run update:road-location-data` (see README.md's "Road location data maintenance" section) and re-verify the two acceptance resolutions above still make sense before merging.

## Do not

- Rerun the Admin CCTV metadata probe (`/admin/cctv-probe`, `/admin/cctv-hsinchu-probe`) just to test anything road-location-related — it makes a real, separately-budgeted TDX call and is unrelated to this feature.
- Fabricate or guess a location label anywhere in `kmLocationResolver.js`/`roadIdentity.js`/`scripts/updateRoadLocationData.mjs` — every label must trace back to an actual row in the imported official dataset; a road/KM the dataset doesn't cover must resolve `{resolved:false}`, never a best-guess.
- Manually `wrangler deploy` when `main`'s Cloudflare auto-deploy is healthy — a push to `main` already ships to Production.
