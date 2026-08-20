# ENGINEERING_STATUS.md — traffic-reporter (路況播報員)

Current-state snapshot only — no long history here. For "why" and full round-by-round detail, see `PROJECT_HANDOFF.md` (§1–§21). For human-readable release notes, see `RELEASE_SUMMARY_V1.8.5.md`.

---

## ⚠️ Production branch split (discovered 2026-08-20) — read this before assuming "push to main = deployed"

**Production was NOT actually running `main`.** The Cloudflare Worker's real
deploy source was `claude/v57.2-tdx-gated-freeway-broadcast`
(`9c0de1dcfbc4410d7d0c0eda9bd9655cca15a41f`), a lineage branch created for
V57/V57.1/V57.2 (Shared Traffic Feed, its CCTV top-up, TDX-gated freeway
broadcast) that was never merged back into `main`. Meanwhile `main` kept
moving on V1.8.6.4/V1.8.6.5 (provenance log, KM Location Resolver, short
map URL) — 10 commits main never saw make it to Production, while
Production carried 3 commits `main` never saw. Common ancestor:
`ba74d48f2c98b41f1d5b2db8a60639001ecd1109`. This is the actual root cause
of the "main 已修好但 Production 看不到" symptom investigated in the prior
audit round — V1.8.6.5 was fully merged and documented as shipped, but was
never running where users actually were.

**Fix applied this round:** `integration/v57.2-v1.8.6.5-production`,
branched from latest `main` and merged (`--no-ff`, real 3-way merge, every
conflict resolved by tracing call paths — never `ours`/`theirs`) with the
V57.2 branch, carrying forward BOTH lineages' functionality in full, plus
the V1.8.6.6 non-collision-anomaly fix (`fix/v1.8.6.6-anomaly-classification-audit`,
cherry-picked — verified still genuinely needed post-merge, not assumed).
See this file's "Latest completed work" section below for what building
the two real-event regression fixtures found and fixed along the way.

**This round deliberately did NOT**: merge into `main`, deploy, or change
which branch Cloudflare's Worker actually watches — see "Next (safe
actions)" below for the proposed permanent fix (reunify Production back
onto `main`) and why it needs a human decision, not an autonomous one.

## Current Production version / main HEAD

```
main HEAD:         0fa32236631ae582e1f65a3870053e666d036d58 (V1.8.6.5)
Production HEAD:   9c0de1dcfbc4410d7d0c0eda9bd9655cca15a41f (claude/v57.2-tdx-gated-freeway-broadcast — NOT main; see above)
Integration branch: integration/v57.2-v1.8.6.5-production (this round's merged, tested result — NOT yet deployed, NOT yet merged to main)
```

Cloudflare auto-deploys on every push to whichever branch its Worker is
actually configured to watch — historically assumed to be `main`, but see
the branch-split warning above: that assumption silently stopped being
true once the V57 lineage branch was created. Verify the real deploy
source in the Cloudflare dashboard before relying on "push to main =
deployed" again.

## System status

- Production live, operating normally.
- `GET /health` — zero TDX/PBS/LINE network calls, reads only `health:snapshot:v1` + `tdx:usage:summary:v1` from KV.
- TDX usage reconciliation ledger live and accumulating (`tdx:usage:summary:v1`).

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

- **Production's deploy source and `main` have diverged** (see the branch-split warning at the top of this file) — this is the standing issue this round's integration branch addresses but does not itself resolve; resolving it requires a human decision to point Cloudflare's Worker at `integration/v57.2-v1.8.6.5-production` (or merge it into `main` and repoint there) — see "Next (safe actions)" below.
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
- **Proposed long-term fix for the branch split**: reunify Production's actual deploy source back onto `main` — either (a) merge `integration/v57.2-v1.8.6.5-production` into `main` and repoint Cloudflare's Worker at `main` (restores the documented "push to main = deployed" convention), or (b) repoint Cloudflare's Worker at the integration branch directly and retire the assumption that `main` is always the deploy source. Either way, this needs a human to actually change the Cloudflare Worker's configured branch and/or merge into `main` and deploy — explicitly out of scope for this round (see this file's branch-split section above for why: no merge into `main`, no deploy, no branch-pointer change was made this round). Whichever is chosen, the real preventive fix is procedural, not technical: treat "which branch does Cloudflare actually deploy from" as a fact to verify per round, not an assumption to carry forward — a stray lineage branch (like V57's) can silently become the real Production source again otherwise.

## Do not

- Rerun the Admin CCTV metadata probe (`/admin/cctv-probe`, `/admin/cctv-hsinchu-probe`) just to test anything road-location-related — it makes a real, separately-budgeted TDX call and is unrelated to this feature.
- Fabricate or guess a location label anywhere in `kmLocationResolver.js`/`roadIdentity.js`/`scripts/updateRoadLocationData.mjs` — every label must trace back to an actual row in the imported official dataset; a road/KM the dataset doesn't cover must resolve `{resolved:false}`, never a best-guess.
- Manually `wrangler deploy` when `main`'s Cloudflare auto-deploy is healthy — a push to `main` already ships to Production.

V1.8.6.5 map URL 改為 maps.google.com/?q=lat,lng，座標 5 位小數；仍為純 URL、0 Google API calls。
