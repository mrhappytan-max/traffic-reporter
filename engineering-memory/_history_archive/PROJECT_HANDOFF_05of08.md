<!-- title: 完整工程歷史 5/8 -->

# PROJECT_HANDOFF（完整工程歷史）— 第 5 段／共 8 段

> 非 canonical。這是 Repo 內未經刪減的 `PROJECT_HANDOFF.md` 依章節切分後的第 5 段，
> 僅供追查歷史 Root Cause 時閱讀；日常接班請讀 `02_PROJECT_HANDOFF.md`。
> 完整且權威的版本永遠是 Repo 內的 `PROJECT_HANDOFF.md`。

---

## 23. V1.8.6.7 — 24h Pipeline Trace + 人工查修頁

**Status: on branch `feature/v1.8.6.7-pipeline-trace-view`, branched from the post-reunification `main` (§22). NOT merged, NOT deployed.**

### Purpose

Turns "為什麼這筆事件的播報結果長這樣" into something a non-programmer administrator can answer by looking at a web page, for ANY event that entered this run's pipeline — not just ones that actually reached LINE. Answers, per event: 上游抓到什麼 → normalize/classify 成什麼 → eligibility/dedupe/suppression/gating 做了什麼 → KM/CCTV enrichment 結果 → 最後 LINE/Shared Feed 送了什麼 — and automatically highlights where those disagree (see "Anomaly detection" below), instead of requiring someone to manually diff 20+ fields per event.

### Relationship to `broadcastProvenance.js` (V1.8.6.4) — both kept, different scope

| | `broadcastProvenance.js` | `pipelineTrace.js` (this round) |
|---|---|---|
| Scope | Only events ACTUALLY pushed to ≥1 LINE target | EVERY event that entered the pipeline this run, including rejected/deduped/suppressed/gated ones |
| Question answered | "為什麼那則已送出的 LINE 訊息長這樣" | "這筆事件到底發生了什麼事，不管有沒有送出" |
| TTL | 48h | 24h (deliberately shorter — see "Performance" below) |
| Write trigger | Only inside the `successfulTargets.length > 0` branch | Every event's lifecycle end, success or not |

Neither module re-implements the other's classification/eligibility/KM-resolution logic — `pipelineTrace.js` literally imports and reuses `broadcastProvenance.js`'s `describeClassificationEvidence`, never a second copy of that rule.

### Architecture — accumulate in memory, finalize once per event

Per the task's own instruction ("每一筆事件只寫一次 KV，不要每個 stage 各寫一次"): `broadcastPipeline.js`'s `runLineBroadcast` keeps a `Map<event, partialTraceInput>` (`traceInputByEvent`), mutated as the event moves through eligibility → clustering/relevance → incident suppression → CCTV → the LINE push loop → the Shared-Feed-only top-up pass. A `finalizeTrace()` closure builds the final, immutable `buildTraceEntry(...)` records from whatever partial input each event accumulated, called right before every one of `runLineBroadcast`'s 4 return points (fail-closed, dryRun, outside-broadcast-hours, and the normal end) — so an event whose lifecycle ends early (ineligible, not relevant) still gets a complete, honest record from whatever it actually went through, never a crash or a missing entry.

Two categories of event never reach `runLineBroadcast`'s `allEvents` at all, and get their own standalone trace entries built directly in `scheduled.js`, from arrays `dedupe.js`/`crossSourceDedup.js` already computed: a TDX-level duplicate (`summary.duplicateEvents`) and an unmatched 國道 PBS event (V57.2's own gate — `pbsSummary.freewayGatedEvents`).

`sharedFeedPersisted`/`sharedFeedWithImage` can only be known AFTER Shared Feed persistence runs (a separate, later step in `scheduled.js`) — these two fields are patched onto the already-built trace entries by reading the ACTUAL persisted feed back (one extra `readSharedFeed` `get`, never a `list`) and matching by `eventKey`/`eventId`, right before the final `persistPipelineTraceEntries` write. This is deliberate: it catches a genuine disagreement between "did `runSharedFeedPersist` report `committed:true`" and "does this SPECIFIC event's image actually appear in the persisted blob" — exactly the class of bug (§20-era Shared-Feed-image-loss) this trace exists to make visible.

### Schema

```
eventKey, status  (line-sent | eligible-no-target | suppressed | not-relevant |
                    ineligible | duplicate | gated | merged | line-failed)
identity:   timestamp, source, rawId, road
upstream:   EventType, EventSubType, Category, descriptionSummary (≤120 chars),
            rawDirection, rawStartKM, rawEndKM, upstreamUpdatedAt
normalized: type, direction, startKM, endKM, displayKM, location,
            classificationSource, classificationEvidence
decision:   eligibility, eligibilityReason, dedupeResult, suppressionResult, gatingResult
enrichment: kmLocationResolution (sanitized, no raw coordinate/mapUrl — same
            view broadcastProvenance.js already uses), cctvEligible,
            cctvSkippedByReason, imagePrepared, imageUrlPresent, imageExpiresAt
delivery:   lineAttempted, lineSucceeded, formattedOutput,
            sharedFeedPersisted, sharedFeedWithImage
```

`upstream` is captured ONCE, at normalize time (`tdx/normalize.js`/`pbs/normalize.js`), as a debug-only `event.pipelineTraceUpstream` field — same never-read-by-the-real-pipeline boundary already established by `event.provenance` (§20). `EventType`/`EventSubType`/`Category` reuse the SAME field names for both TDX and PBS (PBS's `roadtype` maps onto `EventType`; PBS has no analogue for the other two, so they stay `null`) so the schema never forks by source.

### 0 additional upstream calls

Every field is copied from data the SAME pipeline run already computed. Two specific reuses worth naming: `resolveKmLocation()` and `resolveCctvEligibility()`'s outcomes were previously only captured (for provenance) inside the `successfulTargets.length > 0` branch — this round hoists those exact same calls (same inputs, same event, same pure/0-I/O functions) slightly earlier in the per-event loop so a NON-pushed event's trace also gets them, without adding a second call site anywhere or changing what the successful-push branch itself computes. No new classification pass, no new KM resolution call beyond that hoist, no new CCTV query — verified by the full existing test suite passing unmodified (the 889 pre-existing tests) plus a dedicated "0 additional TDX/PBS/CCTV/LINE calls" test (scenario 26).

### Anomaly detection (`buildTraceAnomalies`) — display-only, pure

Given a trace record, returns `{severity, code, message}[]`, purely for the trace-view page and the JSON endpoint — never read by, or capable of influencing, the real pipeline. Checks implemented: `DIRECTION_CHANGED` (upstream vs normalized direction disagree), `TYPE_SEMANTIC_MISMATCH` (upstream subtype text reads like a non-collision hazard — reusing the same keyword categories `anomalyClassification.js` already encodes — while normalized `type` is still `accident`; this is exactly the class of bug V1.8.6.6 fixed, now with an early-warning display for a future recurrence), `KM_CHANGED`, `MAP_MISSING` (KM resolved but the formatted text has no `maps.google.com` link), `IMAGE_EXPECTED_BUT_MISSING` (CCTV prepared an image but the actual LINE push doesn't carry one), `LINE_FAILED`, `SHARED_FEED_IMAGE_LOST` (LINE has the image, the persisted Shared Feed doesn't).

### The 查修頁 (`GET /admin/pipeline-trace-view`)

Server-rendered HTML, zero client-side JavaScript — the existing Admin CSP (`security/adminAuth.js`'s `applyAdminSecurityHeaders`) is `default-src 'none'` with no `script-src` exception, and this page has no reason to ask for one: `<details>/<summary>` gives expand/collapse for the per-event 3-section (上游資料/系統處理/最終結果) breakdown, and filters are a plain GET `<form>` that reloads the page with new query params. Reuses `health.js`'s established mobile-first CSS conventions (card layout, pill badges, `-apple-system`/`PingFang TC` font stack) for visual consistency across the project's admin pages. Status/CCTV/map badges use the task's own fixed emoji vocabulary (✅⚠️❌📷🚫🗺️) so every page a human looks at uses the same small, learnable set throughout.

### Performance / KV impact

Trace volume is every Hsinchu-filtered event this run touched (typically low tens per tick), a meaningfully higher write rate than `broadcastProvenance.js`'s "successful pushes only" scope — this is WHY the TTL is 24h, not 48h: total stored volume is bounded by `events/tick × ticks/day`, self-limiting regardless of how long any single real-world event stays active, rather than by an unbounded growing history. The write path (`persistPipelineTraceEntries`) only ever calls `put`, one per event, never `list` — the Cron hot path never does a bounded/unbounded scan. The two read endpoints (`/admin/pipeline-trace`, `/admin/pipeline-trace-view`) both cap the KV `list` scan at `MAX_ENTRIES_SCANNED=500` and the response at `MAX_LIST_LIMIT=100`, same bounded-scan pattern as `broadcastProvenance.js`. `GET /health` was verified (structurally, via a source-grep test, not just behaviorally) to import nothing from `pipelineTrace.js` at all — it still only ever reads the pre-computed health snapshot.

### Privacy boundary

Never stores: the full raw TDX/PBS JSON payload, a Secret, an `Authorization` header, a LINE userId/groupId/subscriber target, an access token, or an admin credential. `descriptionSummary` is capped at 120 characters (vs. provenance's 80 — this log intentionally keeps a little more upstream text since its whole purpose is upstream-vs-normalized comparison, but still a hard cap, never the full text). Verified by a dedicated privacy test scanning a real persisted record's serialized JSON for every one of those terms.

### Tests

`test/pipelineTrace.test.js` (pure schema/anomaly-detection/KV read-write/admin-JSON-endpoint/privacy/TTL coverage, 29 tests), `test/pipelineTraceIntegration.test.js` (end-to-end through the real `runLineBroadcast`/`runScheduledTdxSync` — successful push, eligibility reject, dedupe duplicate, incident suppression, V57.2 freeway gating, no-subscriber, CCTV not-eligible/no-camera/success, LINE failure, Shared-Feed-with-image round trip, trace-write-failure isolation, 0-extra-calls, 13 tests), `test/pipelineTraceView.test.js` (the HTML page: Admin Auth, 405, mobile-readable rendering, anomaly banner display, GET-query filtering, empty state, 6 tests). Full suite: 937 tests (889 pre-existing + 48 new), 934 pass, the same 3 pre-existing unrelated failures as every prior round.

### What this round deliberately did not do

No merge into `main`. No deploy. No change to which branch Cloudflare's Worker actually watches. No real TDX/PBS/CCTV probe, no real LINE push — every test uses mock KV/R2/fetch, same conventions as the rest of this test suite.

## 24. V1.8.6.8 — Driver-Relevant Event Broadcast Time Policy

**Status: on branch `feature/v1.8.6.8-broadcast-time-policy`, branched from `main` (§23). NOT merged, NOT deployed.**

### Product principle

The Worker only actively broadcasts events that could really affect a driver's route/lane/road-passability DURING the product's own active hours, Asia/Taipei 08:00–22:00. Outside that window, ordinary construction/closure/event notices are not pushed — a genuine accident's own real-time-relevance logic is untouched (see below).

### Root cause / what was actually wrong

Two separate, pre-existing bugs, both in the "announced" (schedule-text-parsed) event branch of `effectiveWindow.js`:

1. **Cross-midnight arithmetic bug** — `parseChineseDate.js`'s `parseChineseDateRange` computed a schedule's end hour on the SAME calendar day as its start hour, unconditionally. For an overnight range like "21時至6時" (21:00 to 6:00 the next morning), this put `effectiveEnd` 15 hours BEFORE `effectiveStart` — so the moment the event started, `isBroadcastRelevant` immediately read it as already "ended" (`endMs <= nowMs`), even though the event was genuinely active. A real overnight closure would never broadcast at all, at any hour.
2. **No support for a multi-day date range with a nightly-recurring window** at all — text like "8月20日至8月25日每日21時至翌日6時" simply didn't match the existing single-occurrence regex (no `每日` handling), so `parseChineseDateRange` returned `null` for it — same fail-closed outcome as bug 1 (never broadcasts), for a different reason.

Neither bug is specific to any one event/road — both are structural gaps in the ONE authoritative date-text parser every non-live event type (construction/closure/control/other) already goes through via `effectiveWindow.js`'s "announced" branch.

A third, separate issue (not a broadcast-decision bug, but a Pipeline Trace display bug): `pipelineTrace.js`'s `directionChanged` anomaly check compared upstream and normalized direction text with plain string equality, so "北上" (upstream) vs "北向" (normalized) — the SAME real-world direction, two different words for it — was wrongly flagged as `DIRECTION_CHANGED`.

### Authoritative time-policy implementation — where, precisely

No second time system was created. Two existing modules were extended, one new shared classifier was factored out of an existing function:

- **`effectiveWindow.js`** — `parseChineseDate.js`'s cross-midnight arithmetic is now general (`occurrenceForAnchorDay`: whenever the same-day interpretation of `endHour` would put `end <= start`, roll `end` to the next calendar day — this applies whether or not the text explicitly says "翌日"/"次日", since it's pure date arithmetic, not a keyword-triggered special case), and a new `RECURRING_PATTERN` regex + `resolveRecurringOccurrence()` resolve a `每日`-tagged, optionally multi-day-ranged schedule to the ONE concrete occurrence relevant to `now` on every call (never a cached/stateful recurring schedule — `computeEffectiveWindow` is already called fresh every Cron tick, so this "resolve fresh each time" design needed zero changes to that calling convention).
- **`effectiveWindow.js`** also gained `classifyEventTimeStatus(window, now)` — the SAME comparison `isBroadcastRelevant` already made (started? ended?), just exposing the answer as `'no-data'|'not-started'|'active'|'ended'` instead of collapsing it to one boolean. `broadcastRules.js`'s `isBroadcastRelevant` was refactored to call this directly (its own 60-minute-forecast leniency layered on top, unchanged) — one authoritative classifier, two callers (the real gate, and Pipeline Trace's display), never two independent comparisons that could drift.
- **`broadcastHours.js`**'s `isWithinBroadcastHours` (08:00–22:00 Asia/Taipei) is completely unchanged — it was ALREADY the single authoritative product-broadcast-window gate, applied uniformly before any push, for every event type, since V1.6.1. This round did not touch its logic at all, only made its result (`result.withinBroadcastHours`, already computed once per run) visible per-event in Pipeline Trace as `broadcastWindowActive`.

### 08:00–22:00 — confirmed already correctly enforced, not re-implemented

Verified (not assumed) that `broadcastPipeline.js`'s existing `if (!result.withinBroadcastHours) { ...; return result; }` gate already runs strictly before ANY push attempt, for every event type including accidents — this was already true before this round. What this round adds is `eventActive`/`eventTimeStatus`/`broadcastWindowActive` as explicit, separately-visible Pipeline Trace fields (see below), not a new gate.

### Scheduled event / cross-midnight handling

`resolveRecurringOccurrence` (in `parseChineseDate.js`) evaluates, for `referenceDate`, whichever of "yesterday's" or "today's" daily occurrence (each independently checked against an optional `[rangeStart, rangeEnd]` calendar-date bound) actually contains `now`; if none does, the nearest FUTURE occurrence (for `isBroadcastRelevant`'s 60-minute-forecast leniency to still work correctly on an announced multi-day schedule); if none of those either, the range's own boundary occurrence (so a fully-past or fully-future range still resolves to an honest `effectiveEnd<=now` "ended" or `effectiveStart>now` "not started", never null/guessed). A completely date-less `每日` schedule (no month/day at all) resolves the same way, indefinitely recurring relative to whatever `now` currently is.

### Event types this rule applies to

Every type effectiveWindow.js already routes through its "announced" (non-live) branch — construction/closure/control/other — governed by whether the source's OWN description text carries a parseable Chinese date/time range, never by an event-name keyword list. 施工/車道封閉/道路封閉/單向封閉/改道/活動封路/遶境/廟會/路跑/遊行/大型活動 etc. are all already covered by this same mechanism as soon as their description matches `SINGLE_RANGE_PATTERN` or `RECURRING_PATTERN` — no per-event-name hardcoding was added or is needed. `accident`/`congestion` (and any event with `nonCollisionAnomalyDetail`, per V1.8.6.6/V1.8.6.7) stay on the LIVE branch, completely untouched by any of this round's changes.

### Direction semantic fix

`directionEquivalence.js` (new, tiny module) holds the single project-wide direction-equivalence table (北上=北向, 南下=南向, 東行=東向, 西行=西向, 南行=南向, 北行=北向— moved out of `pbs/normalize.js`, which still re-exports `normalizePbsDirection` unchanged for every existing importer, purely to avoid a circular import: `pbs/normalize.js` already imports `buildUpstreamSnapshot` FROM `pipelineTrace.js`, so `pipelineTrace.js` importing `normalizePbsDirection` back from `pbs/normalize.js` would have cycled). `pipelineTrace.js`'s `directionChanged` anomaly check now normalizes BOTH sides through this same table before comparing — a genuine change (e.g. 北向→南向) still flags `DIRECTION_CHANGED`; a same-direction synonym pair never does. The event's own `normalized.direction` value itself was never touched — only the TRACE'S comparison logic changed, per the task's own explicit instruction.

### Pipeline Trace improvements

`decision` now carries `eventActive` (boolean), `eventTimeStatus` ('no-data'|'not-started'|'active'|'ended'), `eventWindow` (the raw `{effectiveStart, effectiveEnd, timeSource}` `computeEffectiveWindow()` produced this run, shown verbatim), and `broadcastWindowActive` (boolean) — four fields where there used to be one opaque `relevant:false`. `status` gained three new values replacing the old single `not-relevant` catch-all: `not-started`, `event-ended`, `outside-broadcast-window` — `not-relevant` is kept only as a defensive fallback for a caller that doesn't supply `eventTimeStatus`. The trace-view page (`pipelineTraceView.js`) shows all four decision fields explicitly in the per-event detail (section B), with a Taipei-local-time-formatted `事件有效時間` range, so an administrator can see exactly why an event didn't broadcast without reading code.

### What was deliberately NOT changed

The pre-existing 60-minute forecast leniency (`isBroadcastRelevant`'s "starts within 60 minutes" allowance, `broadcastPipeline.test.js`'s own "forecast event crossing into the 60-minute window" test) applies identically to every event type, unchanged — a construction event announced to start within the next hour still gets its existing "60分鐘路況預報" pre-announcement, exactly as it did before this round. This round's `eventActive` is a NEW diagnostic/display dimension, not a tightened broadcast gate — no existing test's push/no-push outcome changed.

### Verified unbroken

Genuine accident real-time broadcast (structured `startTime`, LIVE branch, completely untouched — scenario 12), V57.2 PBS-freeway-gating (`crossSourceDedup.js`, not modified this round at all — scenario 13), CCTV, KM Location Resolver/Google Maps URL, Shared Feed, and the full pre-existing 937-test suite from V1.8.6.7 — all re-run and pass unmodified.

### Tests

`test/parseChineseDate.test.js` (+7: cross-midnight single, marker-optional rollover, multi-day recurring middle/last day, past/future range boundaries, date-less recurring), `test/effectiveWindow.test.js` (+6: `classifyEventTimeStatus`'s 4 states, confirming it's distinct from `isBroadcastRelevant`'s forecast leniency), `test/broadcastTimePolicy.test.js` (new, 15 tests — the task's own full scenario list, end-to-end through `runLineBroadcast`), `test/pipelineTraceView.test.js` (+1: the view page shows all three distinct new statuses, never one generic label). Full suite: 965 tests, 962 pass, the same 3 pre-existing unrelated failures as every prior round.

### What this round deliberately did not do

No merge into `main`. No deploy. No change to which branch Cloudflare's Worker actually watches. No real TDX/PBS/CCTV probe, no real LINE push. No change to the 60-minute forecast feature, to `isWithinBroadcastHours`'s own logic, or to any event's actual `normalized.direction`/`type` value.

## 25. V1.8.6.9 — Mobile-first Deployment Guard

**Status: on branch `feature/v1.8.6.9-mobile-deployment-guard`, branched from the post-V1.8.6.8 `main` (`462e217`). NOT merged, NOT deployed.**

### Purpose

Collapses "手機下指令 → Claude Code → merge main → push main → Cloudflare Auto Deploy → 自動驗 Production commit → 自動驗 health/routes → 回報完成" into an actually-automatable chain that does not require a human (or a Claude session) to open the Cloudflare Dashboard for a normal deploy — only for a genuine Dashboard-only exception (see below).

### The one hard rule

**GitHub `main` is the sole canonical Production source.** No feature branch, no integration branch, and no deploy hook may ever be treated as Production's real deploy source — this is the exact class of bug §22 already root-caused and fixed once (a stray lineage branch silently becoming Production's real deploy source). `scripts/check-deployment-policy.mjs`'s `no-legacy-branch-reference` and `canonical-deploy-flow-statement` checks are a standing regression guard against it recurring, not just documentation.

### Deployment identity — how a Worker instance can know its own commit/branch with 0 runtime network calls

The Worker CANNOT call GitHub or the Cloudflare API at runtime to learn what it's running (forbidden by the task, and would add a real external dependency to every deploy). The only place this information can come from is the build itself:

- `scripts/generateBuildMetadata.mjs` — runs automatically before every `npm run deploy` (wired via package.json's `predeploy` lifecycle hook, which npm invokes automatically — no Cloudflare Dashboard build-command change needed, since this project's `deploy` script IS the entry point Cloudflare Workers Builds is expected to invoke). Prefers a small list of plausible CI-provided env vars for commit/branch (`WORKERS_CI_COMMIT_SHA`/`CF_PAGES_COMMIT_SHA`/`GITHUB_SHA`/`CI_COMMIT_SHA` and their branch equivalents — none independently confirmed to exist in Cloudflare Workers Builds' own environment, since this repo has no way to inspect a real build), falling back to local `git` commands (guaranteed available, since any git-based CI necessarily checks out the real repository to build it). Every field records not just its value but its SOURCE (`commitSource`/`branchSource`/`expectedMainCommitSource`) — an honest `'unknown'`/`'assumed-same-as-deployed'` when neither an env var nor git resolved something, never a guess presented as fact.
- `src/generated/buildMetadata.js` — the generated output, a plain `export const BUILD_METADATA = {...}` object bundled straight into the Worker by wrangler. Checked into git as a PLACEHOLDER (`'not-yet-generated'` for every source field) purely so local dev/`node --test` always has something real to import — a real deploy always overwrites this file, in place, before wrangler ever bundles it.
- `src/version.js` — `APP_VERSION`/`SCHEMA_VERSION`, deliberately NOT build-time-injected: a human-controlled semantic marker (`'V1.8.6.9'`), bumped once per round like this project's own commit-message convention, separate from the git commit which changes every commit.

### The `expectedMainCommit` design — why the runtime comparison is honest, not tautological

At build time, `generateBuildMetadata.mjs` also resolves `git rev-parse origin/main` (independently from `git rev-parse HEAD`, which is what's actually being built) — if that ref is resolvable in the checkout, `expectedMainCommitSource` is tagged `'git:origin/main'` and the two values are genuinely comparable; if not (a truly shallow/detached checkout with no remote-tracking ref), it falls back to `expectedMainCommitSource: 'assumed-same-as-deployed'` and simply reuses `deployedCommit` — never fabricating a comparison it can't actually make. `src/traffic/deploymentStatus.js`'s `computeDriftReasons(m)` (pure, exported separately for direct unit testing) only ever flags a commit mismatch when `expectedMainCommitSource` starts with `'git:'` — an assumed value is, by construction, always equal to `deployedCommit` and can never fire this check.

### `GET /version` — public, unauthenticated, minimal

`{service, appVersion, deployedCommit, deployedBranch, buildTime}`, nothing else — no bindings, no secrets-presence, no routes, no drift reasons. Exists specifically so `scripts/verify-production-deploy.mjs` (or any automated caller) can confirm "Production SHA == main SHA" without an Admin password, which a Claude Code sandbox may not have (see §7 of the task, and the actual proxy-denial evidence below). `Cache-Control: no-store` set explicitly (not inherited from `applyAdminSecurityHeaders`, since this route is intentionally outside `ADMIN_PATHS`) so no intermediate cache can ever serve a stale version to an automated verifier.

### `GET /admin/deployment-status` / `GET /admin/deployment-status-view`

Admin-Basic-Auth-gated, same GET-only-with-explicit-405 treatment as `/admin/broadcast-provenance`/`/admin/pipeline-trace`. Full detail: `deployedCommit`/`deployedBranch`/`buildTime`/`appVersion`, `driftDetected`/`driftReasons[]`, `routes[]` (statically known from `src/index.js`'s own route table — 0 self-HTTP-probe), `bindings[]` (existence-only check against `env` — `TRAFFIC_KV`/`CCTV_IMAGES`/`PBS_RELAY_WINDOWS`, mirroring `wrangler.jsonc`'s declared set, never an external ping), `secrets[]` (presence-only booleans, never a value), `cron.expected` (mirrors `wrangler.jsonc`'s `triggers.crons`, explicitly labeled as "what the code expects", never a claim about reading the real Dashboard Trigger config), and `dashboardOnlyChecks[]` — an explicit, honest list of what this Worker structurally cannot verify about itself (the real Production branch pointer, the real Cron Trigger, real traffic split, whether a Secret's VALUE is correct, Cloudflare's own build/deploy logs). `-view` is the same data as a server-rendered, zero-client-JS mobile HTML page (same CSP-compatible convention as `health.js`/`pipelineTraceView.js`), showing a 🔴 VERSION DRIFT banner with Deployed/Expected/reasons when `driftDetected`, or a plain ✅ banner otherwise.

### `/health` integration — deliberately display-only

Section 9 of the task allowed (not required) folding deployment drift into `/health`'s severity tier. Checking the existing severity contract first (as the task itself instructed) found it tightly coupled to dozens of existing tests asserting an exact `'normal'`/🟢 tier for TDX-schedule-state scenarios (`skipped-by-schedule`, `sleeping`), using a bare `handleHealth(env)` call with no injectable "known-good deployment" override. Since this dev/test environment's checked-in placeholder metadata ALWAYS shows drift (by design — see test scenario 4), nudging `status` from drift would have flipped essentially every one of those pre-existing assertions, for a fact genuinely orthogonal to "is the TDX/PBS/LINE pipeline healthy right now." Chose the safer, still fully-compliant option: a new, clearly-separated "部署" card showing `appVersion`/`Commit`/`Branch`/`版本漂移`, computed at render time (0 extra I/O, same pattern already established by `applyStaleness`), that never touches `status`/`statusMeta`/the page's HTTP status code. Verified directly: a `'normal'` snapshot still renders 🟢/正常 and 200, a `'critical'` snapshot still returns 503, regardless of deployment drift state.

### `scripts/check-deployment-policy.mjs` — static, 0-network repo checks

Exported as a library (`checkDeploymentPolicy()`) specifically so `verify-production-deploy.mjs` reuses these EXACT checks as its own preflight step, never a second, potentially-drifting copy (per the task's own "複製相同規則到多個... 禁止"). Checks: `wrangler.jsonc`'s `crons` == `'*/10 * * * *'`; the three required bindings (`TRAFFIC_KV`/`CCTV_IMAGES`/`PBS_RELAY_WINDOWS`) declared; `ENGINEERING_STATUS.md`'s "## Current Production version" fenced block references no known-legacy Production branch and does state `main HEAD:` (deliberately scoped to just that one block — the rest of this project's docs legitimately mention retired branch names as historical record, see §22, and must never be scrubbed); the canonical deploy-flow marker string (`"Production 唯一正式來源"`) is present somewhere in the docs; the required npm scripts (`predeploy`/`deploy`/`check:deployment-policy`/`verify:production`/`deploy:verify`) exist in `package.json`.

### `scripts/verify-production-deploy.mjs` — the post-push verifier

`npm run verify:production` / `npm run deploy:verify` (both plain aliases — see package.json). Steps: (1) resolve local `main` HEAD via `git rev-parse origin/main` (fallback `main`); (2) run `checkDeploymentPolicy()`; (3) `GET /version` against `PUBLIC_BASE_URL` (read from `wrangler.jsonc`, never hardcoded) with an 8s timeout; (4) if reachable, compare `deployedCommit`/`deployedBranch` against the local `main` HEAD; (5) if reachable, smoke-test every `IMPORTANT_ROUTES` entry, treating `200`/`401` as "exists" and `404` as a real failure (same "未登入時 401 屬正常，但不能是 404" convention already established in this project's own manual verification rounds); (6) print `dashboardOnlyChecks` and a final `PASS`/`FAIL`/`PASS_NETWORK_VERIFICATION_BLOCKED` summary. This script does NOT merge or push anything — that decision stays explicitly with whoever/whatever is driving it (see the task's own "merge/push 仍由 Claude Code 明確執行").

**Real, concrete network-blocked evidence found while building this**: this environment's own egress proxy does not fail the connection outright for a not-allowlisted host — it returns a REAL HTTP response, status 403, header `x-deny-reason: host_not_allowed`, body `"Host not in allowlist: traffic-reporter.mr-happytan.workers.dev. ..."`. A naive check (`!res.ok` → fail) would have misread this as the Worker itself returning 403, a seemingly serious problem for a route that's supposed to be public. `isProxyDenialResponse()` detects this from the one unambiguous, documented signal (the `x-deny-reason` header, confirmed via this environment's own `$HTTPS_PROXY/__agentproxy/status` endpoint) rather than guessing from the status code alone; a thrown network error (a different sandbox's proxy might fail the connection outright instead) is caught separately by the same try/catch and also classified as blocked. Both paths converge on `PASS_NETWORK_VERIFICATION_BLOCKED`, never a hard `FAIL` — per the task's explicit "不要因網路被擋就把整個部署視為失敗".

### Privacy / cost

0 TDX/PBS/CCTV/LINE calls, 0 GitHub API calls, 0 Cloudflare API calls anywhere in this entire feature. `/version` never carries bindings/secrets/routes/drift-reasons. `/admin/deployment-status(-view)` never carries a Secret's VALUE, only presence booleans. No Admin credential is ever required by `verify-production-deploy.mjs` — that is the entire point of `/version` existing.

### Tests

`test/deploymentStatus.test.js` (22 — `computeDriftReasons` scenarios 1/2/2b/3, binding/secret presence, `/version`'s minimal shape and 0-leak guarantee, `/admin/deployment-status`'s Admin-Auth/405/full-detail, every `IMPORTANT_ROUTES` entry actually resolving through the real Worker), `test/deploymentStatusView.test.js` (5 — mobile-readable HTML, drift banner, missing-binding/secret display, 405), `test/deploymentPolicyAndVerify.test.js` (12 — static policy regression against this repo's real current state, legacy-branch detection against synthetic fixtures including a "historical mention must not false-positive" case, `generateBuildMetadata.mjs` run for real against this repo's own git state, `verify-production-deploy.mjs`'s PASS/FAIL/BLOCKED classification including the exact proxy-denial-header shape and a thrown-network-error shape), plus 4 new tests appended to `test/health.test.js` (deployment card display, drift never downgrading a `'normal'` snapshot, `'critical'` unaffected by drift, no Secret leak). 59 new tests total. Full suite: 1008 tests, 1005 pass, the same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `healthQuotaDashboard.test.js`).

### What this round deliberately did not do

No merge into `main`. No deploy. No Cloudflare Dashboard change of any kind. No real TDX/PBS/CCTV/LINE/GitHub/Cloudflare-API call anywhere, including inside the verify script (its network step is a plain unauthenticated `GET` to this Worker's own public routes, nothing more privileged).

## 26. V1.8.6.9a — Pipeline Trace Mobile UX / Taiwan Time / Dark Mode

**Status: on branch `feature/v1.8.6.9a-pipeline-trace-mobile-ux`, branched from the post-V1.8.6.9 `main` (`9af8d21`). NOT merged, NOT deployed.**

### Purpose

Three real-device findings against `/admin/pipeline-trace-view` (the §23 查修頁), reported from an actual phone, not a design review: raw-UTC times reading as a wall of identical "04:00"/"04:10" rows, closed-vocabulary filter fields presented as free-text inputs, and a pure-white background that's uncomfortable to read at night. Goal stated by the task itself, verbatim: 「管理者拿手機打開，10 秒內看懂：上游抓到什麼、系統怎麼判、最後有沒有播、問題在哪一層。」 This is a presentation-layer-only round — `src/traffic/pipelineTrace.js`'s KV read/write, classification, and anomaly-detection logic are untouched; only `src/traffic/pipelineTraceView.js` changed.

### Root cause of the time bug — and why it was only a PARTIAL bug

The page already had a correct Taipei-time helper (`formatTaipeiInstant`, from §24/V1.8.6.8) used for `事件有效時間` in the detail section. The per-row SUMMARY column, though, had its own separate, never-updated computation: `new Date(entry.identity.timestamp).toISOString().slice(11, 16)` — raw UTC, no offset applied. Since most real events happen mid-day Taipei time (UTC+8), their UTC hour is 8 less — an event at 12:00 Taipei (a normal daytime accident) is `04:00` UTC, and that's exactly the number that kept appearing. Fixed by factoring the existing UTC+8-shift arithmetic out of `formatTaipeiInstant` into a shared `taipeiParts()` helper, then adding `formatTaipeiHHMM()` (built on that same helper) for the summary column — one single definition of "what time is it in Taipei" now serves both the summary and the detail section, so this specific class of bug (one display spot silently left on the old/wrong path while another was already fixed) cannot recur here. A fixed banner was added at the top of the page stating explicitly: 「🕒 以下時間皆為 **Asia/Taipei（台灣時間，UTC+8）**，不是 UTC。」

### Filters — `<select>` reusing the existing label objects, not a new vocabulary

`source` and `status` are both genuinely closed sets — every value a row can ever show is a key of `SOURCE_LABELS` or `STATUS_META`, the same two objects already used to render each row's own badges. The fix builds each `<select>`'s `<option>` list directly from `Object.entries()` of those same objects (via a small shared `renderSelect()` helper), so: (a) the dropdown can never offer a value that wouldn't match any row, (b) it can never drift out of sync with what's actually displayed on a row, and (c) no second, hand-typed vocabulary was introduced anywhere (this project's own standing "不要複製相同規則到多個地方" principle). `road` and `rawId` deliberately stay free-text `<input>` — both are genuinely open-ended (a road name substring match, an upstream-assigned raw ID), and a dropdown would be actively wrong for either.

### Dark mode — belt-and-suspenders, no framework

`PAGE_STYLE`'s entire palette was rewritten around the task's own suggested hex bases (`#0f1115` page background, `#1b1f26` card background), with GitHub-Dark-inspired state colors chosen for solid, tested contrast against those darks rather than re-deriving contrast ratios by hand: green `#3fb950` (✅ normal), amber `#e3b341` (⚠️ warning/fallback), red `#f85149` (❌ fail/anomaly), teal `#2dd4bf` (📷 CCTV — a new `.badge-cctv` class, distinct from the generic `.badge`), blue `#58a6ff` (🗺️ map — a new `.badge-map` class). Primary text is near-white (`#e8e9ec`/`#f2f3f5`), never pure `#fff`, per the task's own "不要純白刺眼"; secondary text is muted gray (`#9aa1ac`). `:root { color-scheme: dark; }` plus `<meta name="color-scheme" content="dark">` nudge the BROWSER's own native form-control chrome (autofill, date pickers, scrollbars) toward dark by default — kept alongside, not instead of, explicit dark styling on every `input`/`select`/`button`/placeholder, since native control theming is inconsistent across engines and this page must render correctly on both iPhone Safari and Chrome. Placeholder color (`#6b7280`) was deliberately chosen visible-but-secondary, never so faint it disappears against the `#20242c` input background. `<details>` sections (expand/collapse) and their field rows share the exact same color tokens as the rest of the page — no separate light-mode leftover anywhere. No UI framework was introduced; the page remains plain server-rendered HTML + inline `<style>`, zero client-side JavaScript — same Admin CSP (`default-src 'none'`, no `script-src` exception) as before, unchanged and still enforced by `security/adminAuth.js`'s `applyAdminSecurityHeaders`.

### What this round deliberately did not do

No change to `pipelineTrace.js` (KV logic, `buildTraceEntry`, `buildTraceAnomalies`, `listPipelineTrace`, the JSON endpoint) — this round is presentation-only. No dark-mode toggle / `prefers-color-scheme` media query — the task asked for this page to BE dark, not to offer a choice, so the palette is unconditional. No change to any other admin page (`health.js`, `deploymentStatusView.js`) — out of scope, not requested. No merge into `main`. No deploy. No Cloudflare Dashboard change. No real TDX/PBS/CCTV/LINE call anywhere.

### Tests

`test/pipelineTraceView.test.js`: all 7 pre-existing tests pass unchanged against the rewritten file (none of them asserted an `<input>` shape for `source`/`status`, so the `<select>` conversion needed no test updates there). 6 new targeted tests added: a concrete UTC-vs-Taipei fixture (`2026-08-20T04:00:00.000Z` — 12:00 Taipei — asserting the row renders `12:00`, never `04:00`); the tz-banner text is present; `source`/`status` render as `<select>`, never `<input>`, while `road`/`rawId` remain `<input>`, and the `<option>` lists carry the exact same labels rendered on rows; a query-string value pre-selects the matching `<option>`; dark-mode CSS (`color-scheme: dark`, `#0f1115` background, no pure-white background rule, dark input/select styling, a visible placeholder color) is present; `.badge-cctv`/`.badge-map` render as distinct classes with their own teal/blue colors. `pipelineTrace.test.js` and `pipelineTraceIntegration.test.js` (JSON endpoint, KV logic, Cron integration) re-run unchanged, confirming this round touched presentation only. Full suite: 1014 tests, 1011 pass, the same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `/health` month-baseline test).

### Correction round (same branch, follow-up commit) — two acceptance gaps closed

A review of the first pass against the original acceptance criteria found two items genuinely unmet, both fixed on this same branch, no new version:

**1. List time needed to be a human-readable RELATIVE date, not a bare `HH:MM`.** `formatTaipeiHHMM()` was replaced with `formatTaipeiListTime(iso, now)`: 今天 HH:mm for the same Taipei calendar day as `now`, 昨天 HH:mm for the previous Taipei calendar day, `M/D HH:mm` for anything older. The day comparison is done on the Taipei-shifted y/m/d via `Date.UTC(...)`, deliberately NOT a raw millisecond/24h subtraction — a pair of timestamps only 20 real minutes apart but straddling Taipei midnight (23:50 yesterday vs 00:10 today) must say 昨天, while a pair nearly 24h apart but on the SAME Taipei calendar day (08:05 vs 23:55) must say 今天; a naive "elapsed hours" comparison gets both of these backwards. `now` is an explicit, injectable parameter on both `formatTaipeiListTime` and `handlePipelineTraceView` (a new, optional third argument defaulting to `new Date()`, never read by `index.js`'s route table) specifically so a test can pin "today" — this project's standing "no wall-clock-dependent test" rule, taken literally for a feature whose entire output depends on what day it currently is.

**2. A real "D. 事件時間軸" section was missing, and `upstream.upstreamUpdatedAt` was still shown as raw ISO.** Added `D. 事件時間軸（Asia/Taipei）` with 上游更新 (`upstream.upstreamUpdatedAt`) and 系統抓取 (`identity.timestamp`), both run through the existing `formatTaipeiInstant`. Also Taipei-formatted `UpdatedAt` (section A) and `imageExpiresAt` (section C), which were both still raw ISO strings in the first pass despite the round's own stated goal of converting every human-readable timestamp on this page.

**The LINE 播報 line — checked the schema before writing any UI text.** `pipelineTrace.js`'s `delivery` block (see that file's `buildTraceEntry`) has `lineAttempted`/`lineSucceeded` as per-run COUNTS only — there is no `lineSucceededAt`/`linePushAt`/`notifiedAt`, or any other timestamp field, anywhere in the trace schema. `identity.timestamp` is when this TRACE ENTRY was recorded (i.e. when this run's pipeline processed the event) — not necessarily the same instant a LINE push actually completed, and presenting it as if it were would be exactly the kind of fabricated precision this project's "不要猜" rule forbids. No schema change was made to add a real push timestamp this round (see `PRODUCT_DECISIONS.md` for why) — the UI instead reports honestly: `lineSucceeded > 0` with no stored timestamp → "已播報（未保存獨立時間）"; never sent → "未播報（<the existing status pill's own emoji+label>）", reusing `statusMeta()` rather than inventing new wording. `linePushTimestamp()` also checks a small list of plausible future field names (`linePushedAt`/`lineSucceededAt`/`notifiedAt`) first, so if the schema is ever genuinely extended with one, the UI picks it up automatically with no further UI change — verified directly with a test that seeds `delivery.linePushedAt` and confirms the timeline uses it instead of the fallback text.

**JSON API contract unchanged.** `/admin/pipeline-trace` still returns raw UTC ISO strings, untouched — the Taipei formatting is entirely inside `pipelineTraceView.js`'s HTML rendering, never the underlying trace record.

**Tests**: 13 new tests added to `test/pipelineTraceView.test.js` (now 26 total in that file) — `formatTaipeiListTime`'s 今天/昨天/M-D cases plus two explicit midnight-boundary tests (a 20-minutes-apart pair that crosses the boundary and must say 昨天; a ~16-hours-apart pair that does NOT cross it and must say 今天), the same relative labels actually rendered through the real page, the new D section showing 上游更新/系統抓取 in Taipei time, the three LINE-timeline branches (sent-no-timestamp / never-played / attempted-and-failed) plus the future-schema-field pickup case, `UpdatedAt`/`imageExpiresAt` no longer appearing as raw ISO anywhere in the rendered HTML, and the JSON API's raw-ISO contract confirmed unchanged. `pipelineTrace.test.js`, `pipelineTraceIntegration.test.js`, and `deploymentStatusView.test.js` re-run unchanged. Targeted regression only — no trace schema change was made, so a full-suite run was not required per this round's own instruction.

