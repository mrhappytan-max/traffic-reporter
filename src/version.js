// THE ONE CANONICAL VERSION SOURCE for this project.
//
// Everything that states a product version must derive from APP_VERSION
// below — GET /version, /admin/deployment-status, PRODUCTION_MANIFEST.json,
// SYSTEM_STATE.json, 00_CURRENT_STATE.md and 06_VERSION_HISTORY.md
// included. Nothing may declare a version of its own.
//
// WHY THIS COMMENT EXISTS (PRODUCTION_VERSION_LINEAGE_RECONCILIATION,
// 2026-08-25)
// ---------------------------------------------------------------------
// This file was last bumped on 2026-08-21 at V1.8.6.9 and then never
// again — while V1.8.7.0 through V1.8.7.14 all shipped to Production.
// For three weeks GET /version told the truth about the deployed COMMIT
// and a two-month-old lie about the deployed VERSION.
//
// The drift was not one mistake. Three different things each believed
// they knew the version, and none of them was this file:
//   - GET /version read APP_VERSION here .................. V1.8.6.9
//   - the Engineering Memory export scraped commit messages
//     for the newest /V\d+\.\d+\.\d+/ it could find ....... V1.8.7.7
//   - ENGINEERING_STATUS.md carried its own hand-written label
// A version scraped from a commit message is a version nobody owns: it
// moves when someone happens to type one, and stalls when they don't.
// scripts/export-meeting-room.mjs now reads THIS constant and treats the
// commit-message scrape as a drift warning only.
//
// THE RULE, PERMANENT: any change that reaches Production and alters
// runtime behaviour bumps APP_VERSION in the same commit. Task names
// (CCTV_METADATA_RECOVERY, PBS_ACCIDENT_CCTV_ENRICHMENT_FIX, ...) are
// engineering labels and NEVER substitute for a version number. There is
// exactly one product version line — never a parallel V1/V2/V57.x series.
//
// Pure docs, governance, Drive-sync tooling and test tidying do NOT bump
// this; they still get a commit.
//
// SCHEME SWITCH (三段式版本治理, 2026-08-25): the four-part V1.8.7.x
// pattern above is RETIRED. V1.8.7.14 was the last four-part version.
// Three-part semantic versioning is now ACTIVE:
//   bug fix                        -> patch   (V1.9.0 -> V1.9.1 -> ...)
//   clear new feature / arch phase -> minor   (V1.9.x -> V1.10.0)
//   large incompatible change      -> major   (-> V2.0.0)
// Do NOT pre-bump this constant for a governance-only round; it moves
// only in the same commit as the runtime change it describes.
//
// V1.9.0 (2026-08-26) — root-cause fix, quad (accident) CCTV prepare-
// timeout observability. A real 國3 96K+700 accident at 09:20 pushed
// LINE text with no image and NO completion log of any kind; the same
// event succeeded fully 10 minutes later with no code change in
// between. Confirmed root cause: cctv/dynamicCollage.js's quad path
// carried no stage tracking at all — unlike the single (dynamic-
// shoulder) path, a quad 'prepare-timeout' never recorded which stage
// was in flight, so a genuine one-time slow external dependency
// (frame fetch, JPEG compose, or R2 publish — all three are proven to
// share the same time budget) was structurally invisible. Fixed by
// giving the quad path the same stageTracker mechanism the single path
// already had, plus per-stage elapsed timing and frame counts on every
// outcome — see test/cctvQuadPrepareForensics.test.js for the full
// forensic writeup and the deterministic reproductions (A-G) that
// prove FRAME_FETCH_MODE=PARALLEL, that a slow candidate can hold up
// compose for the whole quad, and that compose/R2-publish time is
// charged against the same budget as frame-fetch. No retry, no second
// fetch attempt, no budget-number change, no fallback — RETRY_REQUIRED
// = NO for this round; this is pure observability plus the outer
// budget's pre-existing behavior, unchanged.

// V1.9.1 (2026-08-26) — root-cause fix, /admin/pipeline-trace-view
// filter form. Real Production report: selecting a source/road/status
// and tapping 篩選 never changed the results, on a real phone. A prior
// round (V1.8.7.6) had already traced the entire server-side path (form
// markup, query string, listPipelineTrace's predicates, pagination) and
// found every layer correct — but its own headless-browser reproduction
// was never part of this repo's automated suite, and evidently never
// drove a real HTTP response carrying this Worker's own security
// headers. Reproduced directly THIS round: a real Chromium instance
// loading the actual response through applyAdminSecurityHeaders, then
// physically clicking the rendered submit button, never navigated — the
// browser's own console named the reason exactly: the CSP shipped
// `form-action 'none'`, which every CSP-enforcing browser (all current
// major engines, including the iOS Safari the report came from) uses to
// refuse ANY form submission on ANY admin HTML page. Confirmed the fix
// with the same real browser: changing only this one directive to
// `form-action 'self'` (same-origin forms still allowed; an external
// origin still is not) let the identical click navigate correctly to
// the filtered URL. See security/adminAuth.js's own comment on that
// line, and test/pipelineTraceView.test.js's V1.9.1 tests. Server-side
// filtering itself was never broken and needed no change. Also raises
// DEFAULT_LIST_LIMIT 30 -> 60 (real查修 need for a busier day) — the
// scan safety ceilings (MAX_LIST_LIMIT, MAX_ENTRIES_SCANNED) are
// unchanged.

// V1.9.2 (2026-08-26) — KV Write Optimization + TDX Usage Summary
// retirement. Real Cloudflare account alert: Cloudflare Workers KV's
// free-tier daily write budget (1,000/day) was at 749/1,000, with
// traffic-reporter-kv alone at 733 (97.9% of the account total). A
// read-only forensic pass (same day, prior round) traced every KV write
// reachable from the Cron path and found the cause.
//
// FOUR changes, all merged into this one version:
//   1. WRITE_ON_CHANGE for traffic:shared-feed and
//      line:incident-suppression-state — both were rewritten every
//      single Cron tick (144/day) even when their real content (never
//      just a generated timestamp) hadn't changed at all. Gated on a new
//      shared primitive, src/util/contentEqual.js (order-independent
//      deep equality) — see sharedFeed.js's runSharedFeedPersist and
//      incidentSuppression.js's persistIncidentSuppressionState for the
//      exact comparison each makes, and broadcastPipeline.js's own
//      comment for a real aliasing hazard this uncovered and fixed
//      (resolveIncidentNotifications mutates matched records in place,
//      so the "previous" snapshot must be taken BEFORE calling it, never
//      read back out afterward — see structuredClone there).
//   2. Pipeline Trace batch persistence — one KV `put` per Cron round
//      (occasionally a few, only if genuinely oversized) instead of one
//      per traced event. See pipelineTrace.js's persistPipelineTraceBatch
//      and TRACE_BATCH_KEY_PREFIX comment for the full v1/v2 schema
//      coexistence design: legacy `debug:pipeline-trace:v1:*` keys are
//      NEVER deleted or migrated (left to their own pre-existing 24h
//      TTL); listPipelineTrace now reads and merges BOTH schemas into one
//      correct newest-first timeline, so every existing filter/limit/
//      admin page needed zero changes.
//   3. TDX Usage Summary RETIRED — a real person now checks TDX's own
//      official back-office dashboard directly for quota/usage; this
//      Worker no longer maintains its own duplicate summary
//      (tdx:usage:summary:v1) or the raw per-call ledger that fed it
//      (tdx:usage:entry:v1:* — confirmed, by exhaustive dependency check,
//      to have no OTHER reader). Both are now 0 writes/day from every
//      live path (Cron, /debug/status, /debug/tdx, both admin CCTV
//      probes). GET /health's "TDX 用量" card is now a small static note
//      pointing at TDX's own dashboard — see health.js's
//      renderTdxUsageRetiredCard. usageLedger.js's own functions are
//      UNCHANGED and still directly unit-tested (they are simply no
//      longer called from any live path) — nothing about TDX runtime,
//      OAuth, RoadEvent/CCTV-metadata fetching, source-mode switching, or
//      the 9/1 TDX quota restore path was touched.
//   4. `[kv-write-budget]` — a new Cron console.log line (Workers Logs
//      only, creates NO new KV key) reporting attempted/performed/
//      skipped-as-unchanged writes across 8 named categories plus
//      traceEntryCount/traceBatchCount, every tick — see scheduled.js.
//
// Cron frequency is unchanged (every 10 minutes). See
// test/kvWriteOptimization.test.js for the full regression suite (WRITE_
// ON_CHANGE skip/write correctness, batch chunking/splitting, v1/v2 merge
// correctness, the retirement's own zero-KV-write proof, and the
// quiet/medium/high fixture counts) and 07_KNOWN_ISSUES.md for the
// quantified before/after write estimate.

// V1.9.3 (2026-08-26) — KV Write Optimization Phase 2. Same real
// Cloudflare account write-budget pressure V1.9.2 addressed; this round
// closes three further sources found in that round's own record.
//
// THREE changes, all merged into this one version:
//   1. health:snapshot:v1 is now WRITE_ON_CHANGE (healthSnapshot.js) —
//      real health content (ignoring generatedAt/tdx.pbs.lastFetchedAt/
//      line.lastLinePushAt AND tdx/pbs.scheduledThisRun+sleeping AND the
//      whole momentary `broadcast` block — none of those represent a real
//      health-state change, only "this tick ran" bookkeeping) must
//      actually differ from what's stored before a write happens. PBS's
//      own `pbs` block gets the exact same carry-forward-on-skip
//      treatment tdx already had, now that PBS itself is on a schedule
//      gate (see #2). Discovered via this round's OWN deterministic
//      fixture (test/kvWriteQuantificationV193.test.js) that
//      scheduledThisRun/sleeping/the broadcast block toggle every tick
//      independent of real health, which would have silently defeated
//      WRITE_ON_CHANGE if left in the comparison — fixed before this
//      shipped, not after.
//   2. PBS fetch schedule gate (pbsSchedule.js) — PBS is no longer
//      fetched every Cron tick, only at most every 30 minutes, and only
//      07:00:00–22:00:00 Asia/Taipei. Cron itself is UNCHANGED (still
//      every 10 minutes — see wrangler.jsonc); this only gates whether a
//      given tick performs the actual PBS HTTP fetch. Safety analysis
//      performed before writing this (see pbsSchedule.js's own comment):
//      every PBS lifecycle rule that could plausibly depend on fetch
//      cadence (PBS_STALE_THRESHOLD_MS=2h, PBS_ABSENCE_GRACE_PERIOD_MS=
//      24h, both in pbsConfig.js) is wall-clock-based, not tick-based,
//      and comfortably larger than both the 30-minute daytime gap and
//      the ~9-hour night gap this introduces; LINE push itself is
//      already restricted to 08:00–21:59:59, so the 07:00 PBS restart
//      gives a full hour of buffer before broadcasting resumes. A tick
//      that skips PBS builds a minimal placeholder summary
//      (buildSkippedPbsSummary in scheduled.js) so mergeForBroadcast/
//      health/Pipeline Trace all degrade the same safe way an already-
//      established PBS pipeline failure does — never misread as "0
//      active events found this run". `commitPbsLifecycleState`
//      (lifecycle.js) additionally now returns real per-UID
//      new/updated/newly-cleared transition counts (from the SAME
//      comparison it already made to decide whether to write), reused by
//      #3 below.
//   3. Pipeline Trace NO_RELEVANT_CHANGE (pipelineTrace.js's
//      hasPipelineTraceRelevantChange, wired into scheduled.js) — a round
//      with no new/updated/cleared TDX or PBS event, no TDX duplicate or
//      PBS freeway-gated dropout, and no LINE push attempt skips the
//      Pipeline Trace batch write entirely (persistPipelineTraceBatch is
//      simply not called), rather than re-writing the same still-active-
//      but-unchanged event's trace entry every single tick forever. TDX
//      duplicates and PBS freeway-gated dropouts are deliberately still
//      treated as "relevant" (preserving the existing V1.8.6.7 "why
//      didn't this broadcast" audit guarantee — see
//      test/pipelineTraceIntegration.test.js's pre-existing tests) — this
//      costs nothing in the actual deployed configuration this round
//      targets (TRAFFIC_SOURCE_MODE=PBS_ONLY means TDX makes zero calls
//      and PBS's freeway gate is bypassed entirely, so both are always 0
//      today). A LINE push ATTEMPT (success or failure, not just
//      failure) is also always relevant — this correctly covers a
//      cold-start push too, where dedupe.js classifies the very first
//      broadcast as a baseline-seed rather than "new" even though a real
//      LINE send happens.
//
// Cron frequency is unchanged (every 10 minutes — only what a tick
// actually DOES changed). See test/pbsSchedule.test.js,
// test/healthSnapshot.test.js's V1.9.3 additions,
// test/pipelineTraceNoRelevantChange.test.js, and
// test/kvWriteQuantificationV193.test.js (deterministic QUIET/NORMAL/HIGH
// EVENT DAY fixtures run through the real Cron path) for the full
// regression suite and measured write/day figures, and
// 07_KNOWN_ISSUES.md for the quantified V1.9.2-vs-V1.9.3 comparison.

// V1.9.4 (2026-08-27) — Pipeline Trace Read Optimization. Real Production
// measurement, reported right after V1.9.3 went live: GET
// /admin/pipeline-trace and /admin/pipeline-trace-view both TTFB'd at
// ≈59.1s (against ≈0.4-0.8s for /, /version, /health). Root cause,
// confirmed from the code itself, not guessed: listPipelineTrace's old
// collectFlattenedTraceEntries always decoded up to MAX_ENTRIES_SCANNED
// (500) keys SEQUENTIALLY — one `await kv.get()` at a time — BEFORE the
// page's own `limit` (default 60) was ever applied, regardless of whether
// any filter was even set. A plain "show me the latest 60" page paid for
// 500 sequential KV round-trips every single time.
//
// Fixed by ONE new function, scanTraceEntriesProgressively (replacing
// collectFlattenedTraceEntries), combining three "cuts" that are really
// the same mechanism seen from three angles:
//   1. EARLY STOP — a no-filter query (every entry matches) stops the
//      instant `boundedLimit` entries have been decoded — never anywhere
//      near 500. Measured (test/pipelineTraceReadPerformance.test.js CASE
//      C): 500 keys available, default limit 60 -> only 60 kv.get() calls
//      (was 500).
//   2. PROGRESSIVE SCAN — a filtered query reads in ROUNDS with a growing
//      cumulative decode target (round 1 = boundedLimit +
//      NO_FILTER_SCAN_BUFFER(20); each further round doubles via
//      PROGRESSIVE_SCAN_GROWTH_FACTOR(2), capped at MAX_ENTRIES_SCANNED) —
//      never starts by fixedly reading 500. CASE D/E/G cover a sparse
//      filter, a road filter, and a filter whose matches only exist in
//      the oldest segment (forcing several rounds, still bounded).
//   3. BOUNDED PARALLEL READS — kv.get() calls within a round now run in
//      fixed PARALLEL_GET_BATCH_SIZE(20) concurrent chunks via
//      Promise.all (one chunk completing before the next starts), never
//      fully sequential and never the whole scan in one giant
//      Promise.all. 20 was chosen empirically (this repo has no existing
//      KV/Workers concurrency ceiling to defer to) as a middle value in
//      the order's own suggested 20-30 range — see
//      test/pipelineTraceReadPerformance.test.js's own round-trip-count
//      comparison across 10/20/30/50.
//
// V1/V2 SCHEMA COEXISTENCE — UNCHANGED policy, improved mechanism: the
// legacy per-entry `debug:pipeline-trace:v1:*` keys are still never
// deleted or bulk-migrated (left to expire on their own pre-existing 24h
// TTL); the two prefixes' cheap kv.list() enumerations now run
// CONCURRENTLY (Promise.all) instead of sequentially, and an empty prefix
// (e.g. once V1 fully expires) already finishes on its first page via the
// existing `list_complete` check — no separate fast-path needed.
//
// OBSERVABILITY (new, read straight off numbers already computed, zero
// new KV writes) — GET /admin/pipeline-trace now also returns
// kvListCalls/kvGetCalls/v1KeysScanned/v2BatchKeysScanned/v1KeyCount/
// v2BatchKeyCount/entriesDecoded/entriesMatched/readDurationMs alongside
// the pre-existing scannedKeyCount/totalKeyCount/scanTruncated (which
// existed in the function's return value before this round but never
// reached the JSON response until now); /admin/pipeline-trace-view shows
// the same numbers in a small page-bottom diagnostics strip. No secrets/
// tokens/raw CCTV URLs in either.
//
// NOT touched by this round (explicit prohibition, verified): Pipeline
// Trace WRITE path (persistPipelineTraceBatch/recordPipelineTrace/
// hasPipelineTraceRelevantChange), V1.9.3's PBS 30-minute schedule gate,
// Health Snapshot WRITE_ON_CHANGE, the Windows Prototype, Windows ->
// Cloudflare Push, LINE, CCTV, TDX, Cron cadence. KV writes added by this
// round: 0 (test/pipelineTraceReadPerformance.test.js #23 asserts this
// directly against a counting mock).
//
// See test/pipelineTraceReadPerformance.test.js for the full CASE A-I
// deterministic fixture and 23-item regression suite, and
// 07_KNOWN_ISSUES.md for the quantified before/after read-cost figures.

export const APP_VERSION = 'V1.9.4';

// Bumped only when the SHAPE of a public/admin JSON response this
// project exposes changes in a way a consumer (Shared Feed, /version,
// /admin/deployment-status) would need to know about — not on every
// feature round. Currently unchanged since it was first introduced.
export const SCHEMA_VERSION = 1;
