# ENGINEERING_STATUS.md — traffic-reporter (路況播報員)

Current-state snapshot only — no long history here. For "why" and full round-by-round detail, see `PROJECT_HANDOFF.md` (§1–§23). For human-readable release notes, see `RELEASE_SUMMARY_V1.8.5.md`.

---

## ✅ Production branch split — RESOLVED (was: discovered 2026-08-20)

**Historical issue, now fixed.** Production's actual Cloudflare deploy
source had diverged from `main` (`claude/v57.2-tdx-gated-freeway-broadcast`
vs `main`'s own V1.8.6.4/V1.8.6.5 work — see `PROJECT_HANDOFF.md` §22 for
the full root-cause writeup and merge methodology). Fixed by building
`integration/v57.2-v1.8.6.5-production` (a real `--no-ff` merge of both
lineages, every conflict resolved by tracing call paths, plus the
V1.8.6.6 non-collision-anomaly fix, cherry-picked after verifying it was
still genuinely needed) and fast-forwarding `main` onto it —
`main` now IS the reconciled branch; nothing was rebased, no merge commit
was needed for the fast-forward itself, and no content was lost from
either lineage.

**Standing preventive practice** (kept here, not deleted, since it's the
actual lesson): a stray long-lived lineage branch can silently become
Production's real deploy source again if it's never merged back — verify
which branch Cloudflare's Worker actually watches per round, don't just
assume `main`.

## Current Production version / main HEAD

```
main HEAD: 8cd97c3e61ac2eace7db66634a398450adb17e4b (V1.8.6.6 + V57/V57.1/V57.2 reconciled)
```

Cloudflare auto-deploys on every push to `main` — no manual `wrangler deploy` needed under normal operation. (This document's own prior round is the reminder to periodically re-verify that's still actually true.)

## System status

- Production live, operating normally.
- `GET /health` — zero TDX/PBS/LINE network calls, reads only `health:snapshot:v1` + `tdx:usage:summary:v1` from KV.
- TDX usage reconciliation ledger live and accumulating (`tdx:usage:summary:v1`).

## Latest completed work — V1.8.6.7: 24h Pipeline Trace + 人工查修頁

**Status: on branch `feature/v1.8.6.7-pipeline-trace-view`, NOT merged to main, NOT deployed.**

Answers "上游抓到什麼 → 系統分類成什麼 → eligibility/dedupe/suppression/gating 做了什麼 → KM/CCTV enrichment 結果 → 最後 LINE/Shared Feed 送了什麼" for ANY event that entered this run's pipeline this Cron run — not just ones that actually got pushed (see `PROJECT_HANDOFF.md` §23 for the full design and `PRODUCT_DECISIONS.md` for why this is a separate log from `/admin/broadcast-provenance`, not a replacement for it).

- **`GET /admin/pipeline-trace`** — JSON, Admin-Auth-gated, `?limit=`/`?source=`/`?road=`/`?rawId=`/`?status=` filters, `Cache-Control: no-store`, 0 upstream calls.
- **`GET /admin/pipeline-trace-view`** — the actual product feature this round: a server-rendered, mobile-readable HTML 查修頁 for a non-programmer administrator. No client-side JavaScript at all (the existing Admin CSP has no script-src exception, and none was added) — `<details>/<summary>` for expand/collapse, a plain GET `<form>` for filters. Shows ✅/⚠️/❌/📷/🚫/🗺️ status badges per event, and automatically flags upstream-vs-normalized diffs (`buildTraceAnomalies` — DIRECTION_CHANGED, TYPE_SEMANTIC_MISMATCH, KM_CHANGED, MAP_MISSING, IMAGE_EXPECTED_BUT_MISSING, LINE_FAILED, SHARED_FEED_IMAGE_LOST) so an administrator never has to eyeball every field by hand.
- **TTL: 24 hours** — every event that entered the pipeline this run gets a trace record, a much higher write volume than provenance's "successful pushes only" scope, so retention is deliberately shorter (24h vs provenance's 48h).
- **Write pattern**: partial trace data accumulates in memory as an event moves through the pipeline (eligibility → relevance → suppression → CCTV → LINE push → Shared Feed persist), finalized into ONE immutable record and written with exactly one KV `put` per event, at the very end of that event's lifecycle this run. Never a per-stage write.
- **0 additional TDX/PBS/CCTV/Google/LINE calls** — every field is copied from data the pipeline already computed this run; nothing here re-classifies, re-resolves KM, or re-queries CCTV.
- **Privacy**: no full raw TDX/PBS payload, no Secret/Authorization header, no LINE userId/groupId/subscriber target, no access token, no admin credential. Description text capped at 120 chars.
- A genuine, previously-untested gap found and closed while building this: reusing `resolveKmLocation()`/CCTV outcome/`incidentSuppression.js` results for the trace required hoisting a couple of already-existing pure computations slightly earlier in `broadcastPipeline.js`'s per-event loop (so the trace can see them even for a non-pushed event) — no behavior change to the real push path, confirmed by the full existing test suite passing unmodified.
- Full suite: 937 tests (889 + 48 new), 934 pass, 3 known pre-existing failures unchanged (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `healthQuotaDashboard.test.js`).

## Latest completed work — branch integration (main + V57.2 + V1.8.6.6), on `integration/v57.2-v1.8.6.5-production`

Full result of reconciling the branch split above. Not yet deployed —
tested and committed on its own branch pending a human decision to make it
Production's actual deploy source (see "Next (safe actions)" below).

- **Merge conflicts**: exactly 3 files (`README.md`, `src/index.js`,
  `src/traffic/broadcastPipeline.js`), every one purely additive on both
  sides (dueling doc sections, dueling imports, dueling module-header
  comments) — every function BODY in `broadcastPipeline.js` merged with
  zero conflict, because main's V1.8.6.4/5 additions (provenance
  recording, `kmLocationResolution`) and V57's additions
  (`completedProducts`, `topUpSharedFeedCctvImages`) landed in
  non-overlapping regions of the same functions. Every other touched file
  (`src/pbs/*`, `src/cctv/*`, several `test/*.js`) auto-merged with no
  conflict at all — the V57.2 branch never touched them after the common
  ancestor.
- **CCTV image → Shared Feed handoff**: traced the full chain (R2 publish
  result → `completedProduct.imageUrl` → `buildSharedFeedEvents` →
  `persistSharedFeed`) — structurally correct in the merged code (same
  object reference mutated in place, no clone, no premature persist). The
  real gap was in *test coverage*, not the pipeline: no existing test ran
  a genuinely-pushed (not suppressed) accident's completed product through
  `runSharedFeedPersist` to confirm the image survives the round trip.
  `test/productionIntegrationFixtures.test.js`'s Fixture A now does, and
  passes — the Shared Feed carries the exact same `imageUrl`/
  `imageExpiresAt` the LINE push carried.
- **V1.8.6.6 non-collision-anomaly fix**: verified genuinely still needed
  (not assumed) — without it, Fixture B's real "其他異常告警－行人誤闖"
  event misclassifies as `accident`. Cherry-picked from
  `fix/v1.8.6.6-anomaly-classification-audit` cleanly (0 conflicts).
- **New regression found and fixed while building Fixture B**:
  `effectiveWindow.js`'s LIVE_TYPES never included `'other'`, so a
  V1.8.6.6-reclassified pedestrian/animal-intrusion event (now `type:
  'other'`) needed a parseable Chinese date-range in its description to
  ever become broadcast-relevant — which a live "right now" hazard report
  never has. Fixed narrowly (an event carrying `nonCollisionAnomalyDetail`
  is now also treated as live), without touching the deliberately-tested
  "genuinely announced 'other' event needs a schedule" behavior (e.g. a
  flooding advisory) — `broadcastEligibility.test.js` test 5 still passes
  unmodified.
- **Full suite**: 889 tests, 886 pass; 3 known pre-existing failures
  unchanged (2× `pbs-relay/tests/*`, 1× wall-clock-dependent
  `healthQuotaDashboard.test.js`).

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
- If/when `feature/v1.8.6.7-pipeline-trace-view` (this round's Pipeline Trace work — see "Latest completed work" above) is reviewed and approved, merge it into `main` the same way the branch-split fix was: fast-forward if `main` hasn't moved, otherwise a real merge — then Cloudflare's existing auto-deploy-on-push-to-`main` picks it up with no manual `wrangler deploy`.

## Do not

- Rerun the Admin CCTV metadata probe (`/admin/cctv-probe`, `/admin/cctv-hsinchu-probe`) just to test anything road-location-related — it makes a real, separately-budgeted TDX call and is unrelated to this feature.
- Fabricate or guess a location label anywhere in `kmLocationResolver.js`/`roadIdentity.js`/`scripts/updateRoadLocationData.mjs` — every label must trace back to an actual row in the imported official dataset; a road/KM the dataset doesn't cover must resolve `{resolved:false}`, never a best-guess.
- Manually `wrangler deploy` when `main`'s Cloudflare auto-deploy is healthy — a push to `main` already ships to Production.

V1.8.6.5 map URL 改為 maps.google.com/?q=lat,lng，座標 5 位小數；仍為純 URL、0 Google API calls。
