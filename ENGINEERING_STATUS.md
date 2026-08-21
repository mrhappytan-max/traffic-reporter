# ENGINEERING_STATUS.md — traffic-reporter (路況播報員)

Current-state snapshot only — no long history here. For "why" and full round-by-round detail, see `PROJECT_HANDOFF.md` (§1–§25). For human-readable release notes, see `RELEASE_SUMMARY_V1.8.5.md`.

---

## 🚀 正式發布流程（唯一來源）— V1.8.6.9

**Production 唯一正式來源 = GitHub `main`.** This is the one and only
sanctioned deploy chain — no feature branch, no integration branch, and
no deploy hook may ever point anywhere else. See `PROJECT_HANDOFF.md`
§25 for the full V1.8.6.9 design writeup; `PRODUCT_DECISIONS.md` for why
each piece below is shaped the way it is.

```
feature branch
  → tests
  → fast-forward/merge into main
  → push main
  → Cloudflare Workers Builds auto-deploy
  → automated verification (npm run verify:production)
  → done
```

**Claude Browser (a human-in-the-loop session actually opening the
Cloudflare Dashboard) is an EXCEPTION path, not a step of normal
deployment.** It is only ever needed for something no repo-side script
can see or change: a Dashboard-only setting drifting (Production branch
pointer, the real Cron Trigger config, Secrets, a build hook
misconfiguration) or a genuine Cloudflare platform incident. Normal
deploys never require it.

**Automated verification, no Admin password required:**

```
npm run verify:production      # alias: npm run deploy:verify
npm run check:deployment-policy   # the static half of the above, standalone
```

`GET /version` (public, unauthenticated) is what makes password-free
verification possible: `{service, appVersion, deployedCommit,
deployedBranch, buildTime}`, nothing more sensitive. The Worker itself
learns `deployedCommit`/`deployedBranch`/`buildTime` at BUILD time (see
`scripts/generateBuildMetadata.mjs`, run automatically via package.json's
`predeploy` hook on every `npm run deploy`) — never by calling GitHub or
Cloudflare's API at runtime. `GET /admin/deployment-status` (Admin-Auth)
carries the full picture — routes/bindings/secrets-presence/drift
reasons/`dashboardOnlyChecks`; `GET /admin/deployment-status-view` is the
same thing as a mobile-readable HTML page.

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
main HEAD: 462e2178be92fbf9ea964e9bcc2b3ce2e4a1d9a2 (V1.8.6.8 — Driver-Relevant Event Broadcast Time Policy, fast-forwarded onto main)
```

Cloudflare auto-deploys on every push to `main` — no manual `wrangler deploy` needed under normal operation. (This document's own prior round is the reminder to periodically re-verify that's still actually true.)

## System status

- Production live, operating normally.
- `GET /health` — zero TDX/PBS/LINE network calls, reads only `health:snapshot:v1` + `tdx:usage:summary:v1` from KV.
- TDX usage reconciliation ledger live and accumulating (`tdx:usage:summary:v1`).

## 🔗 Shared Traffic Feed — Producer/Consumer Authority Boundary

**traffic-reporter is the Shared Traffic Feed's sole content authority.** TDX/PBS ingestion, classification, broadcast eligibility, time-window rules, dedupe/suppression, KM/direction/road resolution, message formatting, and CCTV are all decided HERE — a `completedProducts` entry in the feed means "already judged, ready to broadcast as-is." A consumer (e.g. 雙鐵進站小幫手/hsinchu-thsr-line-bot) is not expected, and must never need, to re-judge that content — its own job is reliable TRANSPORT: reading the feed, paging through it completely, and delivering what it finds.

**This session/repo never modifies a consumer.** `hsinchu-thsr-line-bot` and any other Shared Feed consumer — their code, their Cloudflare Dashboard, their LINE channel, their Production config — are out of scope for every round done from this repo, permanently, not just for one task. A consumer-side problem gets diagnosed and evidence handed across the repo boundary (a Pipeline-Trace-style writeup, a reproduction, a suggested fix) — it does not get fixed by this session reaching into that repo. See `PROJECT_HANDOFF.md` §30 for the full boundary writeup and the V57.3 pagination fix that motivated writing this down formally.

**Producer never builds consumer-specific logic.** The feed stays generic: no "is this what 雙鐵 wants" branching, no consumer-subscription awareness, no per-consumer type whitelist, no consumer-version detection. Every `completedProducts` entry goes out the same way to whoever reads the feed.

## Latest completed work — V1.8.7.4: 國3 CCTV Support Audit

**Status: on branch `fix/v1.8.7.4-freeway3-cctv-support`, branched from latest `main`. NOT merged, NOT deployed.** See `PROJECT_HANDOFF.md` §31 for the full audit writeup and `PRODUCT_DECISIONS.md` for the reasoning behind not adding 國3 this round.

Real Production evidence (國3 南向 102K+100～103K+070, dynamic shoulder, no CCTV image, previously diagnosed `unsupported-road`) motivated a full audit of whether real 國3 CCTV metadata already exists somewhere this codebase can reach, before assuming the PROGRAM (not the road) is what's missing — 國3 genuinely does have highway CCTV in the real world.

- **Audit finding: no real, Production-confirmed CCTV RoadID/RoadName for 國道三號 exists anywhere in this repository.** Checked and ruled out: (a) `cctv/freewayCctvMetadataCache.js`'s cache is populated only as a side effect of a real admin probe run — this dev sandbox has no TDX network egress and cannot read Production's real cache contents either; (b) `data/road-location/` has real, confirmed KM/facility data for 國3, but that's a completely different official dataset (interchange/milestone archives) from TDX's CCTV/Freeway feed and confirms nothing about a CCTV RoadID; (c) the only `RoadID:'000030'` string anywhere in this repo is a SYNTHETIC test fixture (`test/hsinchuCctvProbe.test.js`, explicitly commented "wrong road -> excluded"), never captured from a real TDX response.
- **A genuinely useful structural fact confirmed along the way**: `hsinchuCctvProbe.js`'s real admin probe fetches the FULL, unfiltered nationwide Freeway CCTV list (`CCTV_URL` has no `$filter`/`$top`) and caches every record it gets back — so a real Production run of that probe almost certainly already has 國3's real records sitting in Production's own KV today. A future round with either real Production KV read access or explicit authorization to run the real probe can close this gap in ONE registry line (`CCTV_SUPPORTED_ROADS`) — no other code change needed, since that registry was already built (V1.8.5) as a single-point-of-truth extensibility point.
- **Decision: 國3 was NOT added to `CCTV_SUPPORTED_ROADS` this round**, per this round's own "只有資料來源與測試證據足夠的道路才加入" instruction — adding it with a guessed RoadID/RoadName pattern (even a plausible one following 國1's naming convention) would repeat exactly the "guessed from the numbering probably matches" mistake this module's own standing documentation already warns against.
- **國3 102K+100 continues to correctly report `unsupported-road`, never `no-camera`** — confirmed as the accurate, honest status: this program doesn't yet support the road (a structurally different, more honest statement than "we searched nearby and found no camera," which `no-camera` would incorrectly imply).
- **國1 regression**: dynamic-shoulder single CCTV and accident quad CCTV both re-verified completely unaffected — this round only added a documentation/audit comment, no logic change to `resolveCctvEligibility` or any downstream CCTV code.

14 new tests in `test/freeway3CctvAudit.test.js` (國3 road-identity-resolves-but-CCTV-doesn't distinction, eligibility/reason regression, 0-frame-fetch-attempt confirmation, no-camera-vs-unsupported-road distinction, 國1 single/quad/Shared-Feed/Pipeline-Trace regression, 0-extra-upstream-calls structural + behavioral confirmation, and two "pin the audit evidence down" meta-tests confirming the synthetic fixture is provably synthetic and the metadata-cache mechanism is provably already-nationwide). Full suite: 1104 tests / 1101 pass (baseline `main` was 1090/1087 before this round's 14 additions — same 3 pre-existing unrelated failures, confirmed via a clean-tree comparison before touching any file this round).

## Latest completed work — V57.3: Shared Feed Pagination (integrated onto latest main)

**Status: on branch `integration/v57.3-shared-feed-pagination`, branched from main (V1.8.7.2), NOT merged, NOT deployed.** See `PROJECT_HANDOFF.md` §30 for the full design writeup.

A previously-completed Producer fix (`claude/v57.3-shared-feed-pagination`, commit `cda1e63`, built against an older `main`) cherry-picked cleanly onto latest `main` — **0 conflicts**, since it only ever touched `sharedFeed.js`/`sharedFeedHandler.js`/`test/sharedFeed.test.js`/`README.md`, none of which V1.8.7.0/.1/.2 touched.

- **The bug this fixes**: `GET /internal/shared-feed` only ever returned the newest `limit` (≤50) entries of the window and set `truncated:true` — anything beyond that was invisible to a consumer, which couldn't even record that it had skipped those events. Not theoretical: a deploy that changes message text or fingerprint shape re-broadcasts many events in one tick, and a real 60-event window silently dropped 10 with no trace.
- **The fix (additive, backward-compatible)**: `selectFeedWindow`/`handleSharedFeed` gained `offset` — `total` is always the FULL window count (never the page size), `truncated` now means "more entries exist past this page" (false on the last page), `clampOffset` bounds it to `0..MAX_STORED_EVENTS`, and the handler echoes `offset`/`limit` so a consumer can detect pagination support. A call that omits `offset` gets byte-for-byte the same response it always did; `schemaVersion` stays `1`.
- **0 upstream calls, still**: pagination reads only the existing `traffic:shared-feed` KV blob — no new TDX/PBS/CCTV/Google/LINE calls, verified directly.
- **V1.8.7.0/.1/.2 fully preserved**: dynamic-shoulder classification, CCTV single-strategy fairness (per-event budget + cap), and the 4-line short LINE message are all untouched and re-verified clean on top of this integration.

7 tests from the original commit (120-event/4-page no-gap-no-overlap walk, truncated semantics on/off the last page, past-the-end offset, `clampOffset` bounds, backward-compatible omitted-offset response, handler offset echo, 0-upstream-calls during paging) plus a 243-test targeted regression sweep across every directly-affected file — all pass, 0 conflicts, 0 regressions.

## Latest completed work — V1.8.7.2: Dynamic Shoulder Message Simplification

**Status: on branch `fix/v1.8.7.2-dynamic-shoulder-message-short`, branched from main (V1.8.7.1, merged), NOT merged, NOT deployed.** See `PROJECT_HANDOFF.md` §29 for the full design writeup.

Formatter-only change: shortens the dynamic-shoulder OPEN/STOPPED LINE message from 7 lines down to a fixed 4 — headline, road＋official section label, KM range, one state line. Removed for THIS event type only: the 📍 地圖/`maps.google.com` line, the safety-reminder sentences ("請依現場標誌及號誌行駛"/"請回主線車道"), and the 🕒 updated-time line. Product principle: a dynamic-shoulder push is a real-time status flip, not an incident narrative — the driver needs road/direction/section/KM/state, nothing else, and the accompanying single CCTV photo (unchanged, still attached) already shows current conditions.

```
🛣️ 機動開放路肩            ⛔ 路肩停止開放
國1 南向｜竹北交流道－新竹交流道路段     國1 南向｜竹北交流道－新竹交流道路段
91K+590～93K+320            91K+590～93K+320
路肩開放通行                路肩停止開放
```

- `messageFormat.js`'s `formatEventMessage` gained a dedicated early-return short-circuit for a dynamic-shoulder event, checked first and returning IMMEDIATELY — bypasses the map-line/updated-time construction every other event type still gets, without touching that shared code for anyone else.
- `buildRoadLines()` (road/section-label/KM-range resolution) is completely unchanged and still runs — the official interchange section label and the fail-closed "no facility resolved → bare road＋direction" fallback both still work exactly as before; only the SURROUNDING lines were removed.
- `kmLocationResolver.js`/`resolveKmRange` and Pipeline Trace's `rangeResolution` are UNCHANGED and still fully populated — this round only removed a display line from the LINE message, never the underlying resolution data, which other event types (accident/construction) still use for their own 📍 地圖 line.
- CCTV (`imageStrategy:'single'`, camera selection, per-event budget fairness, R2 publish, `imageExpiresAt`, Shared Feed image, CCTV top-up) is entirely untouched — verified directly.
- accident/construction/congestion/other formatters are byte-identical to before this round.

14 new tests in `test/dynamicShoulderMessageShort.test.js` (covering all 15 acceptance items). Targeted regression (251 tests across every directly-affected file) confirmed clean; full suite not re-run this round, per instruction (formatter-only change, confirmed impact scoped exactly as expected).

## Latest completed work — V1.8.7.1: Multi-event Single CCTV Budget / Fairness Fix

**Status: merged to main.** See `PROJECT_HANDOFF.md` §28 for the full design writeup.

Fixes a real Production bug found via Pipeline Trace on the very first busy tick after V1.8.7.0 shipped: 3 dynamic-shoulder events in one Cron tick, only the FIRST got a CCTV image — the other two both read `cctvSkippedByReason:'run-budget-exhausted'`, despite all three being fully classified, range-resolved, LINE-pushed, and CCTV-eligible.

- **Root cause**: `prepareCctvImageForEvent`'s `budgetMs` used to come EXCLUSIVELY from `broadcastPipeline.js`'s own `cctvRunDeadlineAt` — one absolute deadline, anchored once before the whole per-event loop, shared SEQUENTIALLY by every CCTV-eligible event that tick (quad AND single alike). Whichever event reached the CCTV block first got however long its own real processing took out of that one shared ~4s clock; every later event only ever got "whatever's left" — often at or below zero, even though a single frame fetch is individually cheap.
- **Fix — single-strategy events stop sharing ANY clock**: every eligible dynamic-shoulder event now gets its own fresh, independent `SINGLE_CCTV_PER_EVENT_BUDGET_MS` (1500ms) budget, anchored at THAT event's own turn — never inherited from an earlier event's elapsed time (`cctv/dynamicCollage.js#prepareSingleCctvImageForEvent`). Bounded by a hard `MAX_SINGLE_CCTV_EVENTS_PER_RUN` (5) per-run cap so an unbounded number of events still can't unboundedly delay a tick — worst case is now a fixed, known ceiling (5 × 1.5s = 7.5s), not the old shared 4s window, but genuinely FAIR across every event within it. Beyond the cap: `cctvSkippedByReason:'single-event-cap-reached'`, deliberately distinct from `'prepare-timeout'` (a single event's own budget genuinely expiring) — an administrator can always tell "we deliberately stopped after N" apart from "this one really ran out of time."
- **Quad (accident) stays on its own, completely separate clock**: `cctvRunDeadlineAt` is now LAZILY anchored to the moment the first accident this run actually reaches the CCTV block (was: anchored unconditionally before the loop) — so real wall-clock time spent on preceding dynamic-shoulder events (which are always ordered before accidents in the per-event loop) can never silently erode an accident's own nominal budget window either. Multiple accidents in one run still share this one (now lazily-anchored) deadline exactly as before — accident-vs-accident behavior is completely unchanged, and quad's own 4000ms budget number was never touched.
- **Same fix propagates to the Shared-Feed-only CCTV top-up pass for free**: `topUpSharedFeedCctvImages` shares the SAME per-run `cctvRunCache` object (and therefore the same single-event cap counter) as the main push loop — no separate code change was needed there; verified directly with a test.
- **Pipeline Trace gained 4 minimal diagnostic fields**: `cctvBudgetClass` (`'quad-shared'`/`'single-per-event'`), `processingDurationMs`, `singleSlotIndex`/`singleSlotLimit` — chosen over a raw `budgetAtStartMs`/`budgetRemainingMs` pair for being immediately legible ("this was slot 6 of a 5-slot cap" beats a bare millisecond number). No raw CCTV payload, same whitelist discipline as before.
- **No pipeline changes**: still 1 frame fetch, 0 decode/encode, 0 collage compose, cache-only metadata (0 extra TDX/PBS/metadata calls), single storage/delivery path (R2/LINE/Shared Feed) — this round only fixed HOW MUCH TIME each event gets, never what the single-camera pipeline itself does.

20 new tests in `test/singleCctvBudgetFairness.test.js` (covering all 24 acceptance items — several share one test), including the exact real 3-event Production regression fixture (84K+500～86K+200 / 87K+290～90K+900 / 91K+590～93K+320, all 國道一號 南向 OPEN, same tick — all three now get `imagePrepared:true`). Full suite: 1069 tests / 1066 pass, same 3 pre-existing unrelated failures as every prior round.

## Latest completed work — V1.8.7.0: Dynamic Shoulder Broadcast + Single-CCTV Strategy

**Status: merged to main.** See `PROJECT_HANDOFF.md` §27 for the full design writeup.

Puts TDX's 機動開放路肩 (dynamic shoulder open/close) mechanism onto the active broadcast path for the first time — real value for professional/taxi drivers (an extra lane of legal capacity, or its removal) — plus a second, cheaper CCTV strategy for it. Every existing pipeline stage (normalize → classify → eligibility → range enrichment → CCTV → formatter → LINE → Shared Feed → trace) was extended additively; none was replaced, no second/parallel broadcaster was built.

- **Classification, not a hardcoded `EventSubType=498`**: `dynamicShoulderClassification.js` scans EventType/EventSubType/Category/Description text evidence for OPEN (機動開放路肩/路肩開放) vs STOPPED (機動路肩停止開放/路肩停止開放/恢復禁止行駛路肩) phrasing — a bare numeric code carries no meaning on its own in this codebase, and TDX's live schema is unreachable from this sandbox to confirm one. Purely additive: attaches `event.dynamicShoulder = {state, evidence}`, never touches `event.type` (still classifies 'control' as before) — every other control-typed event is completely unaffected.
- **OPEN/STOPPED state model, wired into the EXISTING dedupe/notification fingerprints**: `dedupe.js#computeFingerprint` and `notified.js#computeNotificationFingerprint` both append `dynamicShoulderState` when (and only when) `event.dynamicShoulder` is present — OPEN↔STOPPED is now always a fingerprint change (real re-push), same state+content stays deduped, and every other event type's fingerprint shape is byte-for-byte unchanged. `effectiveWindow.js` also gained an `isLiveDynamicShoulder` check (mirroring the existing `isLiveNonCollisionAnomaly`) — without it, a dynamic-shoulder record (no schedule text, `type:'control'`) would fall into the "announced" bucket and never resolve an active window at all.
- **KM range → official interchange section name**: `kmLocationResolver.js` gained `resolveKmRange({road, direction, startKM, endKM})`, a thin reshaping wrapper over the existing (V1.8.6.5) `resolveKmLocation` — zero new facility-matching logic. Real fixture `91K+590～93K+320` on 國道一號 南向 resolves to `竹北交流道－新竹交流道路段` from the official generated dataset, direction-aware, fail-closed to bare KM when nothing resolves.
- **Dedicated LINE wording**: `messageFormat.js` gained an OPEN/STOPPED branch (checked before the generic `type` wording), reusing the same road/section/KM/map-link construction every other event type already uses. Keeps this round's two safety constraints: never implies unconditional permission (依現場標誌及號誌行駛), and STOPPED explicitly says 請回主線車道.
- **CCTV strategy split — `quad` vs `single`, one pipeline**: `dynamicCollage.js#resolveCctvEligibility` now returns `imageStrategy` (`'quad'` for accident, `'single'` for dynamic-shoulder — unchanged accident behavior/reason strings). `hsinchuCctvProbe.js` gained `selectSingleShoulderCandidate` (reuses the SAME eligible-camera-pool builder the 4-quadrant selector already used — never a second metadata filter): prefers a same-direction camera physically inside the event's own KM range, closest to the range midpoint; falls back to the existing ±2km/±4km nearest-camera rule; `null` (text-only) if nothing qualifies. `single` mode publishes the fetched frame's raw bytes directly to R2 — no 2x2 collage, no JPEG decode/re-encode at all — genuinely cheaper than `quad`, not just differently laid out.
- **Same downstream path, no second storage/delivery logic**: R2 publish (`publishCollageImage`, reused unchanged), the LINE text+image message shape, Shared Feed's `completedProducts`/`imageUrl`/`imageExpiresAt`, and Pipeline Trace are all the SAME code paths accident CCTV already used — only gated open to the new `isCctvCandidateEvent` check. Pipeline Trace gained `eventSemantic`/`shoulderState`/`dynamicShoulderEvidence` (derived straight from `event.dynamicShoulder`, no new classificationEvidence trail) and `imageStrategy`/`selectedCamera`/`rangeResolution` (pipeline-computed, threaded in like `imagePrepared` already was) — `selectedCamera` is a minimal `${cctvId}@${locationMile}` string, never the raw CCTV record.
- **No new hours policy, no over-classification**: reuses the existing single 08:00–22:00 Asia/Taipei broadcast-hours gate unchanged; an ordinary `EventType=4` control event with no shoulder-open/stop text never gets tagged (`event.dynamicShoulder` stays absent, exactly the pre-existing behavior).

22 new tests in `test/dynamicShoulder.test.js` (covering all 28 acceptance items from this round's own task spec — several items share one test). Full suite: 1049 tests / 1046 pass, same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `/health` month-baseline test).

## Latest completed work — V1.8.6.9a: Pipeline Trace Mobile UX / Taiwan Time / Dark Mode

**Status: on branch `feature/v1.8.6.9a-pipeline-trace-mobile-ux`, branched from main (V1.8.6.9), NOT merged, NOT deployed.** See `PROJECT_HANDOFF.md` §26 for the full design writeup.

Fixes three real-device UX problems reported against `/admin/pipeline-trace-view` (查修頁) — presentation-layer only, `pipelineTrace.js`'s KV/classification/anomaly logic is untouched:

- **Time-display bug**: the per-row summary column built its `HH:MM` via `new Date(...).toISOString().slice(11,16)` — raw UTC. A page full of ~noon-Taipei events (04:00 UTC) rendered as a wall of identical "04:00"/"04:10" rows, with no way for an administrator to tell they were 8 hours off. Fixed with a new `taipeiParts()`-based helper — one definition of "what time is it in Taipei" for the whole page. A fixed banner now states explicitly at the top of the page: "🕒 以下時間皆為 Asia/Taipei（台灣時間，UTC+8），不是 UTC。"
- **Free-text filters for closed-vocabulary fields**: `source`/`status` are now `<select>` dropdowns, built directly from `SOURCE_LABELS`/`STATUS_META` — the exact same objects already used to render each row's own badges — so the dropdown can never offer a value that doesn't match a row, and can never drift out of sync with what's displayed. `road`/`rawId` deliberately stay free-text `<input>` — they're genuinely open-ended values.
- **Pure-white background, uncomfortable at night**: page is now dark-themed (`#0f1115` background / `#1b1f26` cards, near-white but not pure-white primary text, muted gray secondary text), with `color-scheme: dark` + `<meta name="color-scheme" content="dark">`, plus explicit dark styling on every input/select/button and a visible (not too-faint) placeholder color, so native browser form-control chrome and this page's own CSS agree. Status colors kept distinct and accessible: ✅ green, ⚠️ amber, ❌ red, 📷 CCTV teal, 🗺️ map blue.

No UI framework introduced; still zero client-side JavaScript (`<details>/<summary>` for expand/collapse, a plain GET `<form>` for filters) — same Admin CSP (`default-src 'none'`, no script-src exception) as before, unchanged.

**Correction round (same branch, follow-up commit)** — closed two acceptance gaps found on real-device re-review:

- **List time is now a human-readable RELATIVE date**, not a bare `HH:MM`: `formatTaipeiListTime()` — 今天 HH:mm (same Taipei calendar day) / 昨天 HH:mm (previous Taipei calendar day) / M/D HH:mm (older), comparing Taipei CALENDAR days (not a raw 24h subtraction, which would mishandle a midnight-crossing pair of timestamps only minutes apart). `now` is an explicit, injectable parameter — no wall-clock-dependent test.
- **New `D. 事件時間軸（Asia/Taipei）` detail section**: 上游更新 (`upstream.upstreamUpdatedAt`) / 系統抓取 (`identity.timestamp`), both Taipei-formatted, plus an honest `LINE 播報` line. `pipelineTrace.js`'s schema has **no independent LINE-push timestamp field** (`delivery` only ever recorded `lineAttempted`/`lineSucceeded` as run counts) — no schema change was made to add one this round (see `PRODUCT_DECISIONS.md`). The UI never presents `identity.timestamp` as if it were the LINE push time: sent-with-no-stored-time shows "已播報（未保存獨立時間）"; never-sent shows "未播報（<existing status label>）"; the code also checks a few plausible future field names first, so a real schema addition would be picked up automatically. `UpdatedAt`/`imageExpiresAt` elsewhere on the detail page are now Taipei-formatted too (were raw ISO before). The JSON API (`/admin/pipeline-trace`) contract is unchanged — still raw UTC ISO, no formatting applied.

`test/pipelineTraceView.test.js`: 26 tests (7 original pre-existing + 6 from the first pass + 13 new for the correction round), plus `pipelineTrace.js`'s own JSON-endpoint/integration suites and `deploymentStatusView.test.js` re-run unchanged. Targeted regression only this round (no trace schema change).

## Latest completed work — V1.8.6.9: Mobile-first Deployment Guard

**Status: on branch `feature/v1.8.6.9-mobile-deployment-guard`, NOT merged, NOT deployed.** See `PROJECT_HANDOFF.md` §25 for the full design writeup.

- **New public endpoint**: `GET /version` — `{service, appVersion, deployedCommit, deployedBranch, buildTime}`, unauthenticated, minimal, `Cache-Control: no-store`. Exists so an automated verifier can confirm "Production SHA == main SHA" without an Admin password.
- **New Admin endpoints**: `GET /admin/deployment-status` (full JSON: drift detection, route/binding/secret presence, cron expectation, `dashboardOnlyChecks`) and `GET /admin/deployment-status-view` (same, as a mobile HTML page — 🔴 VERSION DRIFT banner or ✅ clean).
- **Build-time identity injection**: `scripts/generateBuildMetadata.mjs` runs automatically before every `npm run deploy` (`predeploy` npm lifecycle hook), writing `src/generated/buildMetadata.js` from local `git`/CI env vars — 0 runtime GitHub/Cloudflare API calls, ever.
- **`npm run verify:production`** (alias `npm run deploy:verify`) — the post-push verification script: local git state → static policy checks (`scripts/check-deployment-policy.mjs`) → `/version` reachability → commit/branch comparison → route smoke tests → summary. Gracefully reports `NETWORK_VERIFICATION_BLOCKED` (never a false FAIL) when this environment's own egress proxy denies the host — a real, concrete case hit and handled while building this (see PROJECT_HANDOFF.md §25 for the exact `x-deny-reason` header evidence).
- **`/health`** now shows a display-only "部署" card (commit/branch/drift) — deliberately does NOT affect the page's own severity tier/HTTP status (checked the existing severity contract first, per the task's own instruction, and found doing so would have required touching dozens of pre-existing tests for an orthogonal fact).
- **Docs**: this file, `PROJECT_HANDOFF.md`, `PRODUCT_DECISIONS.md`, and `README.md` now state ONE canonical deploy flow (`Production 唯一正式來源 = GitHub main`) — Claude Browser is explicitly an exception path (Dashboard-only drift/Secret/build-hook issues), never a normal deployment step.
- 59 new tests, full suite 1008 tests / 1005 pass, same 3 pre-existing unrelated failures as every prior round.

## Latest completed work — V1.8.6.8: Driver-Relevant Event Broadcast Time Policy

**Status: on branch `feature/v1.8.6.8-broadcast-time-policy`, branched from main (V1.8.6.7), NOT merged, NOT deployed.**

Fixes two real, structural bugs in how a "announced" (schedule-text) event's own active window gets computed — both silently made a correctly-parsed overnight/multi-day construction, closure, or event notice unbroadcastable at ANY hour, not just outside 08:00-22:00:

- **Cross-midnight arithmetic bug** — a schedule like "21時至6時" (9pm to 6am the next morning) had its end computed on the SAME calendar day as its start, putting `effectiveEnd` 15 hours BEFORE `effectiveStart` — the event read as "already ended" the instant it started. Fixed generally (any `end <= start` rolls to the next calendar day), not conditioned on a "翌日"/"次日" marker being present in the text.
- **No support for a multi-day date range with a nightly-recurring window** ("8月20日至8月25日每日21時至翌日6時") — this text simply never matched the existing parser at all, returning null (same "never broadcasts" outcome as the first bug, for a different reason). New capability added, resolved fresh against `now` on every call (no cached/stateful schedule).

Also fixes a Pipeline Trace false-positive: upstream "北上" vs normalized "北向" (same real-world direction, PBS's own vocabulary vs this project's canonical form) was wrongly flagged `DIRECTION_CHANGED` — fixed by reusing the project's single existing direction-equivalence table (now in `directionEquivalence.js`) on both sides of the comparison before flagging.

Pipeline Trace's `decision` block gained `eventActive`/`eventTimeStatus`/`eventWindow`/`broadcastWindowActive` — replacing one opaque "尚未到播報時間" for every non-broadcast reason with four fields that let an administrator see exactly why an event didn't broadcast (尚未開始 / 已結束 / 非播報時段 / event genuinely active) without reading code.

Deliberately unchanged: the pre-existing 60-minute forecast pre-announcement ("60分鐘路況預報"), the 08:00–22:00 broadcast-hours gate's own logic (`isWithinBroadcastHours`, unchanged since V1.6.1 — this round only made its per-run result visible per-event in the trace), genuine accident real-time broadcast, CCTV, KM Location Resolver, Shared Feed, and V57.2 PBS-freeway-gating.

Full suite: 965 tests, 962 pass, the same 3 pre-existing unrelated failures as every prior round. See `PROJECT_HANDOFF.md` §24 for the full design writeup and `PRODUCT_DECISIONS.md` for why the forecast feature and the 08:00–22:00 gate's logic were deliberately left untouched.

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
- If/when `feature/v1.8.6.8-broadcast-time-policy` (this round's cross-midnight/broadcast-time-policy work — see "Latest completed work" above) is reviewed and approved, merge it into `main` the same way every prior round's branch was: fast-forward if `main` hasn't moved, otherwise a real merge — then Cloudflare's existing auto-deploy-on-push-to-`main` picks it up with no manual `wrangler deploy`.

## Do not

- Rerun the Admin CCTV metadata probe (`/admin/cctv-probe`, `/admin/cctv-hsinchu-probe`) just to test anything road-location-related — it makes a real, separately-budgeted TDX call and is unrelated to this feature.
- Fabricate or guess a location label anywhere in `kmLocationResolver.js`/`roadIdentity.js`/`scripts/updateRoadLocationData.mjs` — every label must trace back to an actual row in the imported official dataset; a road/KM the dataset doesn't cover must resolve `{resolved:false}`, never a best-guess.
- Manually `wrangler deploy` when `main`'s Cloudflare auto-deploy is healthy — a push to `main` already ships to Production.

V1.8.6.5 map URL 改為 maps.google.com/?q=lat,lng，座標 5 位小數；仍為純 URL、0 Google API calls。
