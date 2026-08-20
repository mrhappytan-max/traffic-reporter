# PRODUCT_DECISIONS.md — traffic-reporter (路況播報員)

Deliberate product/architecture decisions and the reasoning behind them — not a change log (see `PROJECT_HANDOFF.md` for round-by-round history) and not a current-state snapshot (see `ENGINEERING_STATUS.md`). Read this when a decision below looks "wrong" before changing it — it was very likely made on purpose, for a specific reason recorded here.

---

## V1.8.6.7 — 24h Pipeline Trace + 查修頁

### Why a second debug log instead of extending `broadcastProvenance.js`

`broadcastProvenance.js` was deliberately scoped, from V1.8.6.4 onward, to "only a genuinely-sent LINE message" — that scope is what makes it cheap (few writes/day) and safe to keep at 48h TTL. Widening it to cover every rejected/deduped/suppressed/gated event as well would have changed its write volume by an order of magnitude and made its 48h TTL a real storage question, all for a fundamentally different question ("what happened to this event" vs. "why did that sent message look like that"). Two purpose-built logs, each cheap for its own scope, beat one log doing two jobs at two different costs. Neither re-implements the other's classification/eligibility/KM-resolution logic — see `PROJECT_HANDOFF.md` §23's comparison table.

### Why 24h TTL, not 48h like provenance

Directly follows from the scope decision above: Pipeline Trace's write volume (every Hsinchu-filtered event this run, not just successful pushes) is meaningfully higher than provenance's. A shorter TTL keeps total stored volume bounded by `events/tick × ticks/day` regardless of retention length, without needing a separate storage-growth mitigation. 24 hours also matches the actual use case this feature was built for — "查修" a specific recent incident, not build a historical archive (that's what `RELEASE_SUMMARY_*.md`/git history are for).

### Why accumulate in memory and write once, not once per pipeline stage

The task's own instruction ("每一筆事件只寫一次 KV，不要每個 stage 各寫一次") matches this project's existing "儘量少量 KV 操作" discipline (see e.g. `dedupe.js`'s own module comment: "writes only happen when something actually needs to change"). A per-stage write would multiply KV operations by the number of stages an event passes through for no additional information — the SAME final record is producible from one write at the end, and a partial multi-write record would also leave a genuinely ambiguous state on a mid-run crash (which stages actually got recorded?). One record, one write, at the one point an event's lifecycle for this run is actually over.

### Why the trace page has zero client-side JavaScript

The existing Admin CSP (`security/adminAuth.js`'s `applyAdminSecurityHeaders`, `default-src 'none'`, no `script-src` exception) was already a deliberate V1.6.3-era decision — "this project ships no external JS/CSS on any admin page." Extending that CSP just for this one page would have been the first exception to a rule that's held for every other admin page so far, for a feature (expand/collapse, GET-query filters) that native HTML (`<details>/<summary>`, a plain `<form method="get">`) already provides without any script at all. Keeping the CSP unchanged also keeps the Worker's own complexity/resource footprint down, per the task's own explicit instruction ("不要做花俏 Dashboard framework... 維持 Worker 簡單、快速、低資源").

### Why upstream/normalized fields are captured at normalize time, not re-derived at trace-build time

Same principle already established for `event.provenance` (V1.8.6.4) and `event.nonCollisionAnomalyDetail` (V1.8.6.6): a raw field's value is captured ONCE, where it's already in scope during normalization, as a debug-only field on the event object — never re-parsed from a stored raw payload (which this project's privacy boundary forbids storing at all) and never re-derived by a second, potentially-drifting piece of logic. This is also what makes "0 additional upstream calls" true by construction rather than by discipline: there is no code path in `pipelineTrace.js` that could reach for a raw TDX/PBS field it wasn't already handed.

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

## V1.8.6.8 — Driver-Relevant Event Broadcast Time Policy

### Why eventActive and broadcastWindowActive are kept as two separate axes, not merged into one flag

They answer genuinely different questions: eventActive is a fact about the WORLD (is the official announcement's own window covering right now), broadcastWindowActive is a fact about THIS PRODUCT (is it currently within the hours this Worker chooses to interrupt a driver at all). Collapsing them into one boolean would make it impossible to ever again distinguish "this construction notice's own window hasn't started yet" from "it's 11pm and we just don't push routine notices right now" — which is precisely the diagnostic gap section 4 of this round's task was written to close. Keeping them separate, visible fields in Pipeline Trace costs nothing (both were already being computed, just not exposed) and directly serves the "an administrator should never need to read code to know why" goal.

### Why the 60-minute forecast leniency was deliberately left untouched

An early reading of this round's own task language ("eventActive = true AND broadcastWindowActive = true AND 原有 relevance 條件成立") could be taken to imply removing the pre-existing forecast pre-announcement (`isBroadcastRelevant`'s "starts within 60 minutes" allowance) for scheduled/announced events, since requiring `eventActive` as an ADDITIONAL AND-condition on top of `relevance` would make the forecast-only case (not yet started, but within 60 minutes) newly rejected. This was NOT implemented: there is an existing, deliberately-authored, currently-passing test (`broadcastPipeline.test.js`'s "forecast event crossing into the 60-minute window is pushed once...") explicitly asserting this behavior for a `type:'construction'` event, and the task's own required test list (section 8) never exercises the forecast boundary at all — every worked example and required test either checks well after an event has started or well after it has ended. Changing product behavior on an ambiguous reading, when the explicit constraints ("不要改壞既有架構", "不要猜") point the other way, is exactly the kind of unrequested behavior change this project's standing discipline forbids. `eventActive`/`eventTimeStatus` were built as new, additive DIAGNOSTIC fields; `isBroadcastRelevant`'s actual broadcast decision is unchanged.

### Why the cross-midnight fix is unconditional arithmetic, not keyed on a "翌日"/"次日" marker

A schedule whose end hour is numerically less than or equal to its start hour (e.g. 21 to 6) can only sensibly mean "the following calendar day" — there is no plausible reading where "21時至6時" means the end happened 15 hours before the start. Requiring the source text to also say "翌日"/"次日" before applying this correction would leave the bug in place for any real announcement that expresses the same fact without that exact marker (e.g. relying on 24-hour-style hour numbers, or phrasing this project has not seen yet) — "不要猜" cuts against assuming upstream will always use one specific marker word, not against making a determinate arithmetic correction. The marker, when present, is still recognized (for regex disambiguation and readability) — it's just not load-bearing for the rollover decision itself.

### Why the recurring-daily/multi-day-range parser resolves fresh on every call instead of representing a stored recurring schedule

`computeEffectiveWindow` (and everything under it) has always been a pure, stateless, called-fresh-every-Cron-tick function — there is no existing concept of a stored/cached schedule anywhere in this pipeline, and introducing one just for this feature would be a second, competing way of representing "when is this event relevant," exactly what section 7 of this round's task forbids. Resolving the ONE relevant concrete occurrence (active-now, or nearest-future, or most-recent-past) relative to `referenceDate` on every call keeps the exact same calling convention every other consumer of `computeEffectiveWindow` already relies on, at the cost of a few extra date comparisons per call — a cost that is already amortized by this whole layer being pure and cheap.

### Why the direction-equivalence table was extracted to its own module instead of pipelineTrace.js importing it from pbs/normalize.js directly

`pbs/normalize.js` already imports `buildUpstreamSnapshot` FROM `pipelineTrace.js` (V1.8.6.7) — a `pipelineTrace.js -> pbs/normalize.js` import would have created a circular dependency. Rather than duplicate the table (which this project's own standing rule explicitly forbids — "不要複製相同規則到多個 formatter/classifier"), it was moved to a small, dependency-free module (`directionEquivalence.js`) that both files import from, with `pbs/normalize.js` re-exporting the same name unchanged so no other importer (including its own internal use, and the existing `test/pbsNormalize.test.js`) needed to change at all.
