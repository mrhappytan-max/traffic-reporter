# PRODUCT_DECISIONS.md — traffic-reporter (路況播報員)

Deliberate product/architecture decisions and the reasoning behind them — not a change log (see `PROJECT_HANDOFF.md` for round-by-round history) and not a current-state snapshot (see `ENGINEERING_STATUS.md`). Read this when a decision below looks "wrong" before changing it — it was very likely made on purpose, for a specific reason recorded here.

---

## Branch integration (`integration/v57.2-v1.8.6.5-production`) — why full reconciliation, not "pick the newer branch"

### Why merge both lineages instead of just redeploying whichever branch is "more complete"

Neither branch was disposable: the V57.2 branch was carrying Production's actual live traffic (Shared Traffic Feed consumed by another project, its CCTV top-up, TDX-gated freeway broadcast — real, currently-relied-upon behavior), while `main` carried genuinely completed, reviewed work (V1.8.6.4 provenance, V1.8.6.5 KM Location Resolver) that had simply never reached users. Discarding either side to "just ship the other one" would either regress a live consumer-facing contract or throw away completed, already-reviewed work — both are real costs, not a close call. A real 3-way merge, with every conflict resolved by tracing actual call paths rather than `ours`/`theirs`, was the only option that loses nothing on either side.

### Why the V1.8.6.6 fix was verified empirically before being pulled in, not merged on assumption

The task explicitly asked whether the reclassification fix was still needed after the main+V57.2 merge, or whether integration alone might already handle it. Rather than guessing either way, the actual raw-record shape from the real incident was run through the merged classifier first — it still misclassified `EventSubType:'其他異常告警－行人誤闖'` as `accident`, confirming the fix was genuinely still required, not a leftover from a state the merge had already superseded. This is the same "不要猜" discipline applied to a merge decision, not just to data.

### Why the branch-split root cause is documented as a process gap, not just patched away

Merging the two lineages fixes THIS instance of the split, but the underlying cause — a lineage branch created for isolated work, never merged back, silently becoming Production's actual deploy source while `main` moved on independently — could recur with any future long-lived feature branch. Recording it here (and in `ENGINEERING_STATUS.md`'s branch-split section) as an explicit "verify which branch Cloudflare actually deploys from, don't assume `main`" is a deliberate decision to treat this as a standing verification step, not a one-time cleanup.

## V1.8.6.5 — KM Location Resolver

### Why an offline, imported official dataset — not a runtime Google/TDX lookup

A runtime geocoding call (Google Maps Geocoding API, or re-querying TDX for richer location data) would add: a paid API dependency, a new network round-trip on the Cron hot path (risking the same "CCTV took too long, whole tick delayed" class of bug V1.8.5 already fixed once), a new failure mode with no offline fallback, and a new external cost surface with no budget precedent (TDX's own usage is already metered and reconciled — see `PROJECT_HANDOFF.md` §18). An offline, pre-imported official dataset costs exactly one thing: Worker bundle size (see `ENGINEERING_STATUS.md`'s watch item) — a known, measurable, zero-runtime-risk, zero-recurring-cost trade, and it matches this project's existing "zero extra TDX/PBS calls" discipline instead of adding a new one for Google.

### Why WGS84 for the provincial dataset specifically

Dataset 7040 publishes coordinates in both WGS84 (`lon_wgs84`/`lat_wgs84`) and TWD97 TM2 (`twd97_x`/`twd97_y`). WGS84 is what Google Maps' own URL format expects (`?query=<lat>,<lng>`) — using it directly means zero coordinate reprojection code, zero chance of introducing a projection-conversion bug. The dataset's own QA notes (`data/road-location/archive/README_RAW_CONTRACT.md`) additionally flag that a small number of rows carry an inconsistent or wrong-zone TWD97 pair, while "the WGS84 columns are correct in every case" — so WGS84 is also the objectively more reliable column, independent of the format-matching argument.

### Why left/right sign-pair mileposts are deduplicated (10m bucketing)

Dataset 7040 publishes a LEFT and a RIGHT physical sign for most markers, ~1m apart, as two separate rows (`install_position` 左側/右側) — a real, correct feature of the source data, not noise, but redundant for this resolver's purpose (a driver doesn't care which side of the road the physical sign is bolted to; the resolver's own `PROVINCIAL_TOLERANCE_KM` is 0.6km, three orders of magnitude coarser than the ~1m gap). Deduplicating to one point per 10m bucket (preferring a single 中央 sign when one exists) roughly halves the generated dataset (30,079 → 22,563) with zero loss of resolvable precision, and does not touch the raw file itself — this is purely the importer's own "compact" step, its explicitly documented job.

### Why provincial location = county/township/village, never a guessed street address

Dataset 7040 provides `county`/`township`/`village` per point — real, verifiable administrative units — but no street/house-number field. Composing a plausible-looking street address from KM + road name alone would require guessing, which this project's standing "不要猜" rule forbids everywhere else (see e.g. `PROJECT_HANDOFF.md` §20's provenance-audit section on never fabricating a location). county+township+village is exactly as precise as the OFFICIAL data supports and not one bit more — a driver gets "苗栗縣造橋鄉造橋村", not an invented "造橋鄉中正路123號" that might be wrong by kilometers.

### Why freeway sections are described by bracketing interchange/service-area, not a raw KM range

A KM number alone means nothing to most drivers; a named interchange or service area is how Taiwanese freeway signage and radio traffic reports already describe location, and it's exactly what datasets 166496/8161 provide. Two real facility names bracketing the event's KM ("湖口服務區－竹北交流道路段") communicate "roughly here, between these two landmarks" without implying false precision the 100m-milestone dataset alone could give but a driver couldn't act on. This mirrors — and, once real data landed, supersedes with more accurate names — the pre-existing hand-curated 國1/國3-only anchor table in `roadSectionLabel.js` (§14-era), which was always acknowledged as a stopgap pending real official data.

### Why Google Maps gets a bare `?query=` URL, never the Maps API

`https://maps.google.com/?q=<lat>,<lng>` (short form since the V1.8.6.5 UI hotfix; originally `?api=1&query=`, functionally equivalent) requires no API key, no billing account, no request quota, and no new secret to manage — it's a public, stable, documented URL format that opens the exact coordinate in any client (app or browser) the recipient already has. Calling the actual Google Maps API (Geocoding, Places, Static Maps, or a URL-shortener API) would add a paid external dependency and a new runtime network call for something a plain URL already does for free, with zero added value for this project's use case (a LINE message needs a tappable link, not an embedded image or a resolved address string — the resolver already produces the address string itself, from official data).
