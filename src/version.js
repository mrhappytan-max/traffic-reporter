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

// V1.9.5 (2026-08-27) — Windows → Cloudflare Debug-only Push Endpoint.
// New POST /internal/pbs-debug-push (src/pbs/debugPush.js +
// src/pbs/debugPushAuth.js). Proves ONE thing end to end, nothing more:
// Windows PBS Local Monitor -> sends a minimal event payload -> Cloudflare
// authenticates it -> validates its shape -> makes a best-effort
// idempotency judgment -> logs it to Workers Logs -> ACKs. This round
// does NOT wire Windows to actually send anything yet
// (WINDOWS_PUSH_ENABLED = NO) and does NOT integrate this endpoint into
// the real broadcast pipeline in any way.
//
// AUTH — its own dedicated Cloudflare Secret, PBS_DEBUG_PUSH_SECRET
// (`Authorization: Bearer <secret>`, same header shape as the existing
// TRAFFIC_FEED_SECRET convention), verified with the same hashed
// constant-time comparison technique security/adminAuth.js already uses.
// Deliberately never falls back to PBS_RELAY_TOKEN (the existing,
// unrelated Cloudflare->Windows PULL credential), any LINE/TDX secret, or
// ADMIN_PASSWORD — confirmed by dedicated tests. Missing secret
// configuration fails closed (503); wrong/absent token is 401.
//
// SCHEMA — required: generatedAt, source ('pbs' only), eventId,
// lifecycle (NEW|UPDATED|CLEARED only), fingerprint, requestId. `event`
// is optional and whitelist-read (road/areaNm/direction/comment/
// longitude/latitude/sourceDetail) for the Workers Logs line only — never
// the raw upstream PBS record, never the whole ~1000-record feed. Body
// capped at 16 KiB (a generous ceiling for one event, nowhere near a raw
// feed dump).
//
// IDEMPOTENCY — Cloudflare Workers isolates cannot reliably dedupe across
// requests without a KV write, and this round deliberately adds ZERO new
// KV writes (its own explicit instruction: never add a KV write just for
// a debug-only endpoint's idempotency). Implemented as a best-effort,
// per-isolate, in-memory fingerprint Map instead, honestly reported as
// PBS_DEBUG_PUSH_IDEMPOTENCY_MODE = 'NOT_PERSISTENT' rather than implying
// a cross-isolate guarantee this design cannot make.
//
// STRUCTURAL DEBUG-ONLY BOUNDARY — src/pbs/debugPush.js imports NOTHING
// from line/, cctv/, traffic/sharedFeed(Handler)?.js,
// traffic/incidentSuppression.js, traffic/notified.js,
// traffic/broadcastProvenance.js, traffic/pipelineTrace.js, or pbs/
// lifecycle.js|pipeline.js, and never touches env.TRAFFIC_KV (or any
// other binding) — there is no import path to LINE/CCTV/Shared Feed/
// Pipeline Trace/business KV writes, structurally, not by a runtime flag
// that could be forgotten. Confirmed by test/pbsDebugPush.test.js (33
// tests): 0 fetch calls, 0 KV get/put calls of any kind, across NEW/
// UPDATED/CLEARED.
//
// NOT touched by this round (explicit prohibition, verified): LINE, CCTV,
// Shared Feed, the real Pipeline, real KV event state, Production PBS
// takeover, the existing PBS 30-minute polling gate (V1.9.3, unchanged),
// TDX, Cron, the Windows Prototype, and the feature/pbs-local-edge-
// filter-prototype branch (not merged, not touched).
//
// See test/pbsDebugPush.test.js for the full CASE A-R acceptance suite
// plus auth/schema/idempotency/boundary edge cases, and 07_KNOWN_ISSUES.md
// for the full record.

// V1.9.6 (2026-08-27) — PBS Windows Local Edge Debug Push Integration
// (GOVERNANCE SEAL). This is a documentation/version-governance round,
// not a Cloudflare runtime change: no source file under src/ other than
// this one was touched. It records, into Engineering Memory, an
// architecture that was actually built and is actually running on the
// human's own Windows machine between 2026-08-26 and 2026-08-27 —
// see 03_ARCHITECTURE.md's own new section and 07_KNOWN_ISSUES.md's
// "PBS Windows Local Edge Debug Push Integration" record for the full
// write-up. Bumped (not left as a docs-only non-bump) because the order
// itself is explicit that this is a genuine Product architecture
// addition, not pure prose: Windows now runs a persistent local-edge PBS
// monitor with a real, active push channel into the V1.9.5 Cloudflare
// Debug-only receiver.
//
// Summary (full detail in 07_KNOWN_ISSUES.md, independently verified by
// this Cloud Session where noted):
//   - Windows side: feature/pbs-local-edge-filter-prototype branch,
//     commit 95ecdc4718f836ff36c974e829b549f262e6b936, confirmed NOT
//     merged into main (git merge-base --is-ancestor). Confirmed via a
//     clean `git worktree` checkout + `node --test`: 118/118 tests pass
//     (the prior round's missing cache.js gap is fixed in this commit).
//   - Service-area governance fix (confirmed by reading the diff): the
//     old loose lat/lng rectangle that could independently INCLUDE an
//     event (causing real false-positives at 國3 55.8K 鶯歌 and 國1
//     68.1K 楊梅) is retired; pbs-relay/src/localPrototype.js now
//     directly imports and reuses this repo's own
//     src/pbs/hsinchuFilter.js#isPbsEventHsinchuRelevant and
//     src/pbs/roadName.js#normalizePbsRoad.
//   - CLEARED governance fix (confirmed by reading the code): explicit
//     clear text (已排除/排除/已解除/解除) still clears immediately;
//     absence-only now requires two consecutive successful PBS fetch
//     rounds missing the UID (MISSING_PENDING_CLEAR -> CONFIRMED_CLEARED)
//     before SHOULD_PUSH=YES, replacing the old single-round-absence
//     design that was proven to false-positive.
//   - Windows now runs a persistent Task Scheduler job
//     (TrafficReporter-PBS-LocalMonitor) with a watchdog, and a real
//     Debug Push Client (5s timeout, max 2 attempts, retries only
//     timeout/network/5xx) calling V1.9.5's POST /internal/pbs-debug-push
//     — PBS_DEBUG_PUSH_ENABLED is now true (human-enabled), and a real
//     Secret-binding incident (a Secret existing on a non-Active
//     Deployment Version) was hit, diagnosed, and resolved — recorded as
//     a permanent lesson for future Secret changes.
//   - Explicitly NOT done this round or before it: merging the feature
//     branch, LINE/CCTV/business-KV integration, retiring Cloudflare's
//     own existing PBS 30-minute poll (still PRESERVED and still the
//     production path), or resolving cross-isolate persistent
//     idempotency (flagged PENDING_BEFORE_PRODUCTION, required before any
//     future LINE integration).
//
// See 07_KNOWN_ISSUES.md for the full architecture diagram, the two real
// bugs found and fixed, the Secret governance incident, the current stage
// flags, and the six-phase roadmap (Phase 1 real-debug-observation is
// current; Phase 6 Cloudflare-polling-retirement is explicitly not to be
// started early).

// V1.9.7 (2026-08-28) — Persistent PBS Debug Push Idempotency. V1.9.6's
// own real Production evidence (a genuine 台68 西向 5K event: Windows
// Debug Push at 08:48:30, Cloudflare's own 30-minute polling only caught
// it at 09:00:39 — Windows ~12.1 minutes earlier) confirmed the channel
// works; this round closes its one open risk: V1.9.5's idempotency was
// per-isolate in-memory ONLY (PBS_DEBUG_PUSH_IDEMPOTENCY_MODE =
// NOT_PERSISTENT) — an isolate eviction, Worker restart, or redeploy
// could re-accept the identical event.
//
// Fix: src/pbs/debugPush.js now adds a durable L2 layer in TRAFFIC_KV
// under its OWN debug-only prefix (`debug:pbs-push-idempotency:v1:*`,
// IDEMPOTENCY_KV_PREFIX) — never a business key. Keyed by a STABLE,
// deterministic SHA-256 hash of `source:eventId:lifecycle:fingerprint`
// (never requestId, which differs across a client's own retries) —
// computeIdempotencyKeyHash. The V1.9.5 in-memory Map is kept as an L1
// fast-path (skips a KV read for a genuine same-isolate repeat) but is
// NEVER the sole source of truth: an L1 miss always falls through to an
// L2 KV read before a request is accepted, so a fresh isolate with empty
// L1 still correctly sees an L2 record written by a different isolate.
// TTL: 48 hours (IDEMPOTENCY_TTL_SECONDS) — see that constant's own
// comment for the reasoning. A duplicate NEVER costs a KV write (get-only
// on a hit); only a genuinely new idempotency key costs exactly 1 write —
// measured via test/pbsDebugPush.test.js's KV-cost-quantification tests:
// 10/30/100 distinct accepted events/day cost exactly 10/30/100 KV writes
// (+118/day existing Production baseline stays ≈128/148/218 writes/day,
// all far under the 1,000/day account budget — KV_WRITE_PRESSURE = LOW).
//
// KV_ONLY_ATOMICITY = NOT_SUFFICIENT for a true atomic exactly-once
// guarantee (Cloudflare KV's get-then-put has no compare-and-swap) —
// reported honestly, NOT solved with a Durable Object this round (the
// order's own "不要過度設計" instruction): the actual identified risk
// (isolate/restart/redeploy causing re-acceptance of the SAME transition
// sent again LATER) is fully closed regardless of this narrow race, whose
// blast radius is bounded to a harmless duplicate debug log line — this
// endpoint still has ZERO business side effects (LINE=0, CCTV=0, Shared
// Feed=0, business KV=0), so a race here can never double-push anything
// real. PERSISTENT_CROSS_ISOLATE_IDEMPOTENCY is therefore honestly
// reported as PARTIAL, not ACTIVE — a Durable Object would be the correct
// fix if this endpoint is ever wired to a genuine business side effect,
// not before.
//
// A KV outage on the idempotency read/write fails OPEN (the event is
// still accepted) rather than closed — a debug-only observability
// feature must never lose a legitimate event to a KV hiccup.
//
// NOT touched this round: LINE, CCTV, Shared Feed, Business KV, the real
// Broadcast Pipeline, Cloudflare's existing PBS 30-minute polling gate
// (still PRESERVED), the Windows Prototype's own code/Secret/Task
// Scheduler, and the debug API's response schema (unchanged, verified
// backward-compatible by test).
//
// See test/pbsDebugPush.test.js (52 tests) and 07_KNOWN_ISSUES.md for the
// full design, the race-condition analysis, and the KV cost table.

// V1.9.8 (2026-08-28) — Windows PBS Push -> Production Business Pipeline,
// and RETIREMENT of Cloudflare's own 30-minute PBS polling. New production
// main line: PBS official source -> Windows local fetch (~3 min) -> local
// service-area filter -> NEW/UPDATED/CLEARED lifecycle -> POST
// /internal/pbs-debug-push -> V1.9.7 Persistent Idempotency -> (this round)
// the SAME canonical Business Pipeline (LINE/Shared Feed) the polling path
// always used -> formal broadcast eligibility -> LINE.
//
// INGRESS — upgraded src/pbs/debugPush.js IN PLACE (order's own "least
// change, least duplicated code" instruction: Option A, not a second
// endpoint). A genuinely accepted (non-duplicate) NEW/UPDATED event is
// normalized via pbs/normalize.js's UNCHANGED normalizePbsEvent() (see
// debugPush.js's new buildRawPbsRecordFromPush() for the one place a
// Windows payload becomes a raw-PBS-shaped record — happendate/happentime/
// modDttm are a PRECISE Asia/Taipei reconstruction of the payload's own
// generatedAt, not a guess; roadtype is left '' since Windows's own local
// filter already guarantees a forwarded NEW/UPDATED event's comment
// carries an accident keyword, so comment-only classification is
// faithful), then handed to traffic/broadcastPipeline.js's UNCHANGED
// runLineBroadcast() — the EXACT function traffic/scheduled.js's Cron path
// has always called — followed by the EXACT traffic/sharedFeed.js
// runSharedFeedPersist() call scheduled.js makes right after it. Zero
// second copies of accident/service-area/location-quality/eligibility/
// dedupe/CCTV/Shared-Feed logic exist in debugPush.js.
//
// CLEARED — acknowledged/logged, but deliberately NEVER routed into
// runLineBroadcast, mirroring pbs/pipeline.js's own long-standing
// behavior (clearedEvents never reach broadcastEvents either).
//
// LINE POLICY — completely untouched: MAJOR_ACCIDENT_ONLY and every
// existing eligibility/service-area/location-quality gate inside
// runLineBroadcast apply identically regardless of source.
//
// RETIREMENT (order section 八) — pbs/pbsConfig.js's new
// PBS_30_MIN_POLLING_ENABLED=false (resolvePbsPollingEnabled(env), env-
// overridable — same idiom as TRAFFIC_SOURCE_MODE/LINE_PUSH_POLICY, used
// ONLY by this repo's own pre-existing PBS/CCTV test suite, never set by
// Production) makes traffic/scheduled.js's pbsFetchPerformed permanently
// false. pbsSchedule.js's getPbsScheduleState(), pbs/pipeline.js, and
// pbs/lifecycle.js are all left completely intact, untouched, and fully
// rollback-ready (flip the flag back) — no code deleted. The rest of the
// same Cron tick (TDX, health snapshot, Shared Feed, Pipeline Trace) is
// unaffected. Known accepted side effect: pbs:lifecycle-state stops being
// updated (Windows tracks PBS lifecycle independently); GET /health's
// `pbs` block freezes at its last pre-retirement value.
//
// Windows = fast detector/edge filter. Cloudflare = Traffic Producer /
// Business Authority — the final LINE-or-not decision is still made
// entirely by Cloudflare's own existing, unmodified rules.
//
// See test/pbsDebugPush.test.js's V1.9.8 section (15-item targeted list,
// order section 十) and test/pbsPollingRetirementV198.test.js (retirement
// items 14/15), and 07_KNOWN_ISSUES.md for the full record.

// V1.9.9 Phase 1 (2026-08-28, fix commit 7acb82a) — restricted the Windows
// PBS Local Edge Filter's service area to 新竹市／新竹縣 only (竹南/頭份/
// 苗栗市 and the rest of Miaoli County are now excluded — the old broad
// bounding box could no longer let a Miaoli event through on its own).
// Entirely a pbs-relay/ (Windows-side) change, now committed to main rather
// than an unmerged feature branch. See 07_KNOWN_ISSUES.md for the full
// record.
//
// V1.9.9 Phase 2 (2026-08-28) — AI-ready Business Pipeline Simplification.
// Preparation for a future Workers AI decision stage (Phase 3), NOT an
// integration with one. New src/pbs/aiCandidate.js builds a minimal AI
// candidate object for every genuinely accepted (non-duplicate) NEW/
// UPDATED Windows-sourced event, applying ONLY the service-area gate
// (reusing the canonical resolver runLineBroadcast itself uses) — NOT
// today's content-judgment hard rules (MAJOR_ACCIDENT_ONLY, the V1.5
// type/keyword whitelist, location-quality hard-reject). This candidate is
// observability-only: PBS_AI_DECISION_MODE = 'PREPARED_NOT_ACTIVE' — it is
// built and logged, but never used to decide anything, never reaches LINE/
// CCTV/Shared Feed, and no AI model is ever called. The REAL LINE decision
// (src/pbs/debugPush.js's existing call into traffic/broadcastPipeline.js's
// runLineBroadcast) is completely unmodified — every existing hard rule
// stays fully active as the "legacy policy" gatekeeper of every real LINE
// push this round, exactly as before V1.9.9. Also adds a minimal, unused-
// this-round AI-decision-cache key design (computeAiDecisionCacheKeyHash,
// eventId+fingerprint — reusing Windows's own existing stable fingerprint,
// deliberately not a new NLP/semantic one) for Phase 3 to adopt. No KV
// read/write, no AI call, no LINE behavior change anywhere in this round.
// AI_INTEGRATION = NOT_STARTED, LINE_AI_DECISION = NOT_ACTIVE. See
// src/pbs/aiCandidate.js's own header comment, test/pbsAiCandidate.test.js,
// and test/pbsDebugPush.test.js's V1.9.9 Phase 2 section (15-item targeted
// list, order section 十) for the full design and proof.

// V1.9.9 Phase 3B (2026-08-28) — Workers AI Driver Impact Decision
// Integration. Wires a real Workers AI call ('@cf/zai-org/glm-4.7-flash',
// binding 'AI') into the Windows PBS candidate Phase 2 built but never
// used: src/pbs/aiDecisionEngine.js#resolveAiDecision does cache lookup
// (src/pbs/aiDecisionCache.js, reusing Phase 2's reserved
// AI_DECISION_CACHE_KV_PREFIX/computeAiDecisionCacheKeyHash — same
// eventId+fingerprint authority, 48h TTL) -> on a miss, one Workers AI
// call with a short fixed Traditional-Chinese prompt ("would this
// materially affect a working taxi/for-hire driver's ability to get
// through, right now" — never event-TYPE-based) -> strict structured-
// output validation ({notify:boolean, impact:'HIGH'|'LOW', reason,
// confidence} — anything else is AI_DECISION_INVALID, never reaches
// LINE) -> persist. A validated notify:true routes to the NEW
// traffic/aiApprovedPbsBroadcast.js#runAiApprovedPbsBroadcast() — a
// scoped executor that reuses (never duplicates) notified-state dedupe,
// incident suppression, message formatting, CCTV, and the LINE sender,
// but deliberately never re-applies MAJOR_ACCIDENT_ONLY/the V1.5 type
// whitelist/location-quality hard-reject — those are exactly the
// content-judgment rules this round retires from the Windows PBS
// decision path; the AI verdict is now that path's sole semantic
// authority. Any AI failure (missing binding, call error, invalid
// response) fails closed to 0 LINE with NO fallback to the legacy
// hard-rule decision (never two judges for the same event).
//
// SAFETY: src/pbs/aiConfig.js#PBS_AI_DECISION_ENABLED_DEFAULT = false
// (env-overridable, same idiom as PBS_30_MIN_POLLING_ENABLED) is the ONE
// branch point in src/pbs/debugPush.js — when off (the shipped default),
// behavior is BYTE-IDENTICAL to V1.9.8/Phase 2: the existing legacy
// runLineBroadcast() call remains the sole judge, completely unmodified.
// Enabling AI decisions is a deliberate, separate human action (after
// Cloudflare Dashboard confirms the AI binding is actually live) —
// deploying this code alone changes nothing in Production.
//
// AI_INTEGRATION = CODE_READY, AI_BINDING = PENDING_GPT_WORK, AI_DECISION
// = DISABLED, LINE_AI_DECISION = NOT_ACTIVE. See test/aiDecisionEngine.test.js,
// test/aiDecisionCache.test.js, test/aiApprovedPbsBroadcast.test.js, and
// test/pbsAiDecisionScenarios.test.js (order section 十七's A-P scenarios,
// deterministic mocked AI adapter) for the full design and proof.
//
// V1.9.9 PHASE 3D HOTFIX (2026-08-28) — CLOUDFLARE_STRING_BOOLEAN_PARSING_FIX.
// GPT Work set the Dashboard Variable PBS_AI_DECISION_ENABLED = "true" and
// AI decisions stayed off in Production. Root cause: Cloudflare Dashboard/
// CLI Variables are injected into the Worker as STRINGS, never real
// booleans — src/pbs/aiConfig.js#resolvePbsAiDecisionEnabled()'s strict
// `typeof === 'boolean'` check never matched the string "true", so every
// request silently fell through to the safe default (false). Not a
// Dashboard mistake; a resolver bug. Fix: resolvePbsAiDecisionEnabled()
// now also accepts the Cloudflare-runtime string form ("true"/"false",
// case-insensitive, trimmed); every other value (undefined, null, "",
// other truthy spellings like "1"/"yes"/"on", or any non-string/
// non-boolean) still fails safe to PBS_AI_DECISION_ENABLED_DEFAULT =
// false — no loose truthy check was added. GPT Work's own rollback
// (PBS_AI_DECISION_ENABLED = FALSE) stays in effect; this round only
// fixes the parser so a future retry with the string "true" actually
// works. Nothing else in the AI pipeline (prompt/model/schema/cache/
// runAiApprovedPbsBroadcast/LINE policy/service area/lifecycle/
// idempotency/CCTV/Shared Feed) was touched. AI_BINDING = ACTIVE
// (GPT Work confirmed), AI_DECISION = DISABLED_PENDING_GPT_WORK_RETRY.
//
// ============================================================================
// V2.0.0 MILESTONE (2026-08-28) — ARCHITECTURE GENERATION CHANGE, not a
// feature round. Bumped major per this file's own rule above ("large
// incompatible change -> major"): the Windows PBS + Cloudflare Workers AI
// pipeline built across V1.9.5-V1.9.9 Phase 3D is a full replacement of
// how this project decides what a taxi/for-hire driver gets notified
// about for Windows-sourced PBS events — the OLD generation and the NEW
// generation are not two versions of the same decision logic, they are
// two different judges:
//
//   OLD (retired for the Windows PBS path, code preserved for rollback):
//     Cloudflare 30-min PBS polling -> MAJOR_ACCIDENT_ONLY / V1.5 type
//     whitelist / location-quality hard-reject -> LINE
//
//   NEW (the V2.0.0 canonical path):
//     PBS official source -> Windows PBS Relay (Hsinchu-only local edge
//     filter, lifecycle NEW/UPDATED/MISSING_PENDING_CLEAR/CLEARED) ->
//     Cloudflare production ingress (POST /internal/pbs-debug-push) ->
//     persistent transport idempotency (TRAFFIC_KV, 48h) -> AI candidate
//     (pbs/aiCandidate.js) -> AI decision cache (48h) -> Cloudflare
//     Workers AI (@cf/zai-org/glm-4.7-flash, driver-impact judgment, NOT
//     event-type-based) -> validated notify:true only -> the EXISTING
//     LINE execution infrastructure (subscriptions/notified-state/
//     incident suppression/message formatting/CCTV/pushMessage, reused
//     unchanged) -> LINE.
//
// See 03_ARCHITECTURE.md's own "V2.0.0 接手地圖" section for the full
// 26-question onboarding map (where Windows runs, how auth works, where
// duplicates are stopped, how to roll back, how to troubleshoot a missing
// LINE push, etc.) and 02_PROJECT_HANDOFF.md for the Dashboard settings
// manual and rollback runbook. This bump does not change any runtime
// decision logic itself — it is a documentation/governance milestone
// marking that this architecture generation is now the recorded canonical
// state, on top of the already-shipped V1.9.5-V1.9.9 Phase 3D code.
//
// FIRST_REAL_AI_EVENT = WAITING — a real Production PBS event flowing all
// the way through Workers AI to a LINE push has not yet been observed by
// this session (sandbox network egress blocks the Production domain and
// Cloudflare Dashboard). AI_BINDING/AI_DECISION/LINE_AI_DECISION = ACTIVE
// per GPT Work's own report; this session has not independently verified
// Production activation and does not claim to.
// ============================================================================
//
// V2.0.1 (2026-08-29) — AI Decision Observatory. PATCH — observability/
// diagnostic UI only, does not change AI semantic authority. New Admin
// page GET /admin/pbs-ai-observatory-view (src/pbs/aiObservatoryView.js)
// answers "what did PBS say -> what did the AI decide -> why -> what
// finally happened" for a Windows PBS event, entirely from data already
// produced at decision time — READ ONLY OBSERVABILITY, never a new
// Workers AI call (opening/refreshing/searching the page always makes 0
// AI calls). New thin index (src/pbs/aiObservatoryIndex.js,
// debug:pbs-ai-observatory-index:v1:*, 48h TTL, +1 KV write per
// genuinely accepted non-duplicate event, +0 additional reads) captures
// the PBS original fields and final outcome for every event, including
// the outcomes (AI_CALL_FAILED/AI_DECISION_INVALID/SERVICE_AREA_EXCLUDED/
// legacy-path) nothing else persists today; the actual notify/impact/
// reason/confidence is NEVER duplicated into it — the page reads that
// straight from the EXISTING pbs/aiDecisionCache.js record at render
// time, so a shown reason is always the exact one the AI produced,
// never regenerated. Legacy TDX-oriented labels ("不符合播報資格") are
// never used for a Windows PBS AI-path event — see the new page's own
// OUTCOME_META vocabulary. AI prompt/model/notify semantics/impact
// semantics/confidence semantics/service area/Windows PBS filter/
// lifecycle/transport idempotency/LINE quota policy/CCTV policy/Shared
// Feed product policy are all UNCHANGED this round. FIRST_REAL_AI_EVENT
// remains WAITING; AI_DRIVER_SUMMARY remains a documented FUTURE
// candidate only, not implemented.
//
// V2.0.2 (2026-08-29) — Config Drift Hotfix. PATCH — Production
// configuration correctness fix, does not change AI semantic behavior.
// Root cause: PBS_AI_DECISION_ENABLED lived ONLY as a manually-set
// Cloudflare Dashboard Variable from V1.9.9 Phase 3D through V2.0.1 —
// Workers Builds treats wrangler.jsonc as authoritative on every
// deploy (same mechanism already documented next to
// TRAFFIC_SOURCE_MODE's own var), so a Dashboard-only value is silently
// dropped the next time this repo's main branch deploys. GPT Work's
// manual "true" setting was removed this way, without anyone changing
// PBS_AI_DECISION_ENABLED on purpose, and AI decisions fell back to the
// code-level default (false). Fix: wrangler.jsonc's own "vars" block now
// declares `"PBS_AI_DECISION_ENABLED": "true"` (the string form — see
// that var's own wrangler.jsonc comment) — wrangler.jsonc / GitHub main
// is now the ONE canonical source of truth for this switch; the
// Dashboard is no longer used to set it long-term. No `keep_vars` was
// added — Dashboard-state-authoritative is exactly the failure mode
// this round retires, not something to preserve. Nothing in
// src/pbs/aiConfig.js, aiDecisionEngine.js, aiCandidate.js, the AI
// prompt/model, Windows PBS filter, service area, lifecycle, message
// formatting, LINE policy, Shared Feed, or CCTV changed this round.
//
// FIRST_REAL_AI_EVENT remains WAITING. A real 台68 event observed at
// 17:49 during the config-drift window is NOT counted as a genuine AI
// decision — PBS_AI_DECISION_ENABLED had already been dropped back to
// false by that point, so that event was decided by the legacy path,
// not by Workers AI. A separate, already-known, NOT fixed this round,
// issue is tracked as PBS_PRECISE_COMMENT_LOCATION_NOT_USED_BY_LINE_
// FORMATTER — the LINE message formatter does not yet surface a PBS
// comment's own precise interchange/ramp text (e.g. "近竹科匝道") even
// when it's present in the source comment; see 07_KNOWN_ISSUES.md.

// V2.1.0 (2026-08-29) — Transport Ack Decoupled From Business Processing.
// Real Production incident: two genuine NEW events reached service-area +
// AI_CALL_STARTED successfully, but Windows's own 5-second HTTP timeout
// fired while src/pbs/debugPush.js's handler was still `await`ing the
// real Workers AI call — because that work had never been handed to
// `ctx.waitUntil()`, the Workers runtime cancelled the still-running
// handler the instant the client disconnected, and this endpoint's OWN
// idempotency record (written at accept time, BEFORE business processing
// began) then silently blocked every later Windows retry from ever
// re-attempting the AI decision (AI decision complete = 0, Observatory
// = no record).
//
// MINOR, not a PATCH (per this file's own versioning rule — "clear new
// feature / arch phase") — this is a genuine data-flow/responsibility-
// boundary change (order's own framing: "屬於正式資料流／責任邊界調整"),
// not a timeout-number tweak.
//
// TWO changes, together closing the whole failure mode:
//   1. BACKGROUND EXECUTION — a genuinely accepted (non-duplicate) NEW/
//      UPDATED event's business processing (AI-or-legacy path + LINE/
//      Shared Feed + Observatory record) is now handed to `ctx.waitUntil()`
//      instead of being awaited before the response. src/index.js's fetch
//      handler now accepts and forwards `ctx`. The Windows HTTP response
//      now reflects ONLY "did Cloudflare durably accept this transition",
//      never "did the AI finish deciding" — Windows's own short timeout
//      can no longer race against Workers AI at all. `ctx` is an optional
//      4th parameter (after the pre-existing `now`); every existing unit
//      test call site is unaffected and falls back to a direct `await`,
//      preserving byte-identical synchronous-completion behavior.
//   2. TWO-PHASE IDEMPOTENCY MARKER — the KV idempotency record now
//      carries `status: 'PROCESSING' | 'COMPLETED'`. PROCESSING is written
//      at accept time; COMPLETED once business processing genuinely
//      finishes. A retry against a fresh PROCESSING record (younger than
//      PROCESSING_STALE_MS = 60s) is still deduped — the original
//      ctx.waitUntil-protected attempt is trusted to finish on its own. A
//      retry against a STALE PROCESSING record (the rare case where the
//      original attempt never even got scheduled — e.g. an isolate
//      evicted before ctx.waitUntil could run, NOT the client-timeout
//      case fix #1 already prevents) is NOT treated as a duplicate and
//      genuinely re-attempts business processing. A legacy pre-V2.1.0
//      record with no `status` field, or status=COMPLETED, is still
//      always treated as a duplicate — unchanged backward-compatible
//      behavior.
//
// Deliberately NOT a Cloudflare Queue (order's own "不要先引入 Queue，除非
// 現有 Worker lifecycle 無法可靠完成" — ctx.waitUntil IS the existing
// Worker lifecycle primitive, and is sufficient here) and NOT a Durable
// Object (same "不要過度設計" precedent this file's own KV_ONLY_ATOMICITY
// note already established) — a bounded staleness window on a KV record
// is the minimum viable fix for the ACTUAL identified failure.
//
// RAW PBS TEXT IMMUTABILITY (order section 一/五) — re-verified, not
// re-implemented: buildRawPbsRecordFromPush/normalizePbsEvent/
// buildAiCandidate/buildAiUserPrompt were NOT touched this round; a live
// code-execution trace (this round's own final report) confirms
// comment/sourceDetail still reach the real AI prompt byte-for-byte
// unmodified, exactly as an earlier read-only investigation this session
// already proved for V2.0.2.
//
// WINDOWS DUPLICATE-LOGIC AUDIT (order section 六) — read-only, no code
// change: pbs-relay/'s own NEW/UPDATED/CLEARED classification
// (localPrototype.js#fingerprintEvent/classifyPbsChanges) is driven purely
// by content-fingerprint comparison — no "same event within N hours"
// content-suppression rule exists anywhere in pbs-relay/. Nothing to
// remove; no violation of the new four-layer role boundary found.
//
// EXPLICITLY UNCHANGED THIS ROUND: AI prompt/model/schema/cache, Windows
// PBS service-area/eligibility gate, LINE message formatting,
// driverSummary, hourly reminder, CCTV, TDX, service area, and the
// Observatory admin page UI (查修頁 second-phase work, deliberately
// deferred — order section 十二).
//
// See src/pbs/debugPush.js's own header comment for the full design and
// test/pbsDebugPushBackgroundProcessing.test.js for the dedicated
// regression suite (fast ACK, fresh-vs-stale PROCESSING dedupe/recovery,
// CLEARED immediate completion, no-ctx byte-identical fallback, Observatory
// outcome survives background execution).
//
// V2.2.0 (2026-08-29) — AI Decision Observatory: Four-Layer Event
// Lifecycle. MINOR — a backward-compatible observability/UI expansion of
// the existing V2.0.1 Observatory page, not a change to AI semantic
// authority, the Windows PBS filter, LINE policy, or the V2.1.0 transport-
// ack/background-execution architecture. Upgrades GET /admin/pbs-ai-
// observatory-view from a single AI-outcome list into an explicit
// per-event four-layer view (① PBS/Windows ② Cloudflare ③ AI ④ LINE), each
// with its own visible status (成功/未執行/失敗/未知) and detail section.
//
// RAW PBS TEXT (order section 一/七) — src/pbs/aiObservatoryIndex.js's
// `commentSummary` (previously truncated to 120 chars) is retired,
// replaced by `rawComment`/`rawSourceDetail` — the PBS original free-text
// fields, stored COMPLETE and UNTRUNCATED, independently labeled from the
// separate, pre-existing parsed/formatted fields (road/direction/areaNm/
// displayKM) — never merged. Only ever read live from the Observatory
// index record itself; no new upstream data path was touched.
//
// FAILURE VISIBILITY (order section 一/九) — the real gap this round
// closes: an event whose background processing (ctx.waitUntil, V2.1.0)
// crashed or never completed previously left ZERO trace on the
// Observatory page (the index record was only ever written once, at the
// very end). src/pbs/debugPush.js's processAcceptedEvent now writes an
// EARLY record (AI_OUTCOME.PROCESSING_STARTED) the instant business
// processing begins — built from the raw Windows payload fields, before
// anything that could throw — which the pre-existing FINAL write later
// overwrites in place (identical KV key both times: same idempotencyKeyHash
// + taipeiDate + accept-time `now`). A stalled/crashed event is therefore
// still visible, frozen at PROCESSING_STARTED, instead of invisible.
// EXTRA_KV_WRITES_PER_ACCEPTED_EVENT = 1 (measured, not estimated — see
// test/pbsAiObservatoryFourLayer.test.js's own KV cost formula test):
// puts = 4N + 2 (idempotency PROCESSING+COMPLETED, observatory
// PROCESSING_STARTED+final, +1 incident-suppression-state +1 shared-feed
// per run) — 202/402/802 puts/day at 50/100/200 accepted events/day,
// comfortably under the Workers KV Free Plan's 1,000 writes/day budget.
// REUSE_EXISTING_DATA_FIRST held throughout: the Cloudflare layer's
// PROCESSING/COMPLETED status is read LIVE from the existing V2.1.0
// transport idempotency record (computeIdempotencyKeyHash/
// buildIdempotencyKvKey exported from debugPush.js, reused — never a
// second hash implementation); the AI layer's notify/impact/reason/
// confidence is still read live from the existing V2.0.1 aiDecisionCache
// record, never duplicated. Zero new KV prefixes were created.
//
// ZERO SIDE EFFECTS UNCHANGED (order section 五) — opening/refreshing/
// searching/filtering the Observatory page still makes 0 Workers AI calls
// and 0 KV writes (only reads: the existing per-row aiDecisionCache
// lookup, plus a new per-row transport-idempotency-status lookup — reads
// were never restricted by this round's own rule, only writes).
//
// EXPLICITLY UNCHANGED THIS ROUND: Windows PBS filter/relay transport,
// the V2.1.0 ctx.waitUntil architecture, AI prompt/model/semantic policy,
// service area, LINE policy/formatter, Shared Feed, CCTV, TDX,
// driverSummary, hourly reminder, and any "same-event-within-an-hour" AI
// context feature (not implemented — deliberately not started this round).
//
// See src/pbs/aiObservatoryIndex.js/aiObservatoryView.js/debugPush.js's
// own header comments for the full design and
// test/pbsAiObservatoryFourLayer.test.js for the dedicated 16-item
// regression suite (order section 十二's own minimum list).

// V2.3.0 (2026-08-30) — PBS AI Queue Reliability: Cloudflare Queues
// Replace ctx.waitUntil() As The AI Background-Execution Carrier. MINOR —
// per this file's own versioning rule ("正式改變 AI business processing 的
// 執行架構與可靠性模型" is a genuine arch-phase change, not a patch-sized
// timeout tweak), not a change to AI semantic authority, the Windows PBS
// filter, LINE policy, or the Observatory page's overall UI.
//
// REAL PRODUCTION INCIDENT this round exists to fix — a DIFFERENT failure
// mode from the one V2.1.0 already closed: EVENT_ID=11508290166-0 reached
// Cloudflare and started the Workers AI call successfully
// (16:49:03.112), but the AI call itself did not return before
// Cloudflare's own ctx.waitUntil() background-execution time budget
// expired — entirely independent of Windows's own short HTTP timeout,
// which V2.1.0's ctx.waitUntil() fix already solved. At 16:49:32.912 the
// platform force-cancelled the whole task ("waitUntil() tasks did not
// complete within the allowed time after invocation end and have been
// cancelled"), permanently losing the AI decision and leaving the
// idempotency record stuck at PROCESSING forever — AI_CALL_COMPLETED=NO,
// AI_DECISION=NONE, LINE=NOT_EXECUTED, OBSERVATORY_FINAL=NONE.
// REAL_INCIDENT_ROOT_CAUSE = WAITUNTIL_BACKGROUND_WINDOW_EXCEEDED.
//
// THE FIX — ctx.waitUntil() is RETIRED as an AI carrier entirely
// (WAITUNTIL_AI_PROCESSING = 'RETIRED'), replaced by ONE Cloudflare Queue
// (AI_BACKGROUND_EXECUTION = 'CLOUDFLARE_QUEUE', QUEUE_ROLE =
// 'RELIABLE_AI_BUSINESS_PROCESSING') as the reliable execution carrier:
//   - HTTP ingress (handlePbsDebugPush) now only: validates -> computes
//     the transport idempotency key -> checks duplicate -> writes
//     status=PROCESSING -> writes the early Observatory PROCESSING_STARTED
//     record -> Queue.send() -> only on send SUCCESS does it ACK
//     accepted:true. A Queue.send() failure returns a genuine transport
//     failure (503 pbs_ai_queue_not_configured/queue_send_failed) — never
//     "已成功接收並排入處理" when the event could not actually be handed
//     off reliably. The existing PROCESSING_STALE_MS (60s) window recovers
//     an orphaned PROCESSING record naturally — no new orphan-recovery
//     mechanism was needed.
//   - A genuinely separate Queue Consumer invocation (src/index.js's new
//     `queue(batch, env, ctx)` export -> handlePbsAiQueueBatch ->
//     processQueuedPbsEvent) owns ALL AI/LINE/Observatory-final work, with
//     zero dependency on the original HTTP request or any ExecutionContext
//     staying alive — REUSING (never re-implementing) the EXISTING
//     buildAiCandidate, AI decision engine, AI decision cache,
//     runAiApprovedPbsBroadcast, Observatory writer, transport idempotency,
//     and LINE duplicate protection.
//
// RETRY POLICY — the order's own key design decision: AI_CALL_FAILED (the
// Workers AI call itself did not reliably complete — network/5xx/
// capacity/timeout/binding-missing) is now Queue-retryable, bounded by
// MAX_QUEUE_RETRIES=3 (matches wrangler.jsonc's own `max_retries: 3`, so
// this code's own deterministic bail-out fires before any unconfigured
// platform DLQ/drop would). The EXISTING fail-closed AI_DECISION_INVALID
// policy (the call DID complete, with a schema-invalid answer) is
// deliberately left UNTOUCHED — never retried, terminal on the very first
// attempt, exactly as V2.1.0/V2.2.0 already treated it. Only genuinely
// "工作未可靠完成" cases retry; an invalid-but-completed answer is not
// re-questioned.
//
// ONE NEW MINIMAL TERMINAL STATE — AI_OUTCOME.PROCESSING_FAILED, written
// by the Queue Consumer only once MAX_QUEUE_RETRIES genuinely exhausts
// without a reliable completion: marks idempotency COMPLETED (a
// PERMANENTLY-failed event must never show PROCESSING forever) and acks
// the message — authored deterministically by the consumer itself, never
// left for an unconfigured Cloudflare DLQ/drop to silently explain. "使用
// 最小新增狀態，不要建立大型狀態機" — one terminal state, not a state
// machine.
//
// DUPLICATE PROTECTION — Cloudflare Queues delivery is AT_LEAST_ONCE
// (QUEUE_DELIVERY_MODEL), never exactly-once; the required business
// outcome is EFFECTIVELY_ONCE (BUSINESS_OUTCOME_MODEL): processQueuedPbsEvent
// re-checks the idempotency record FIRST on every delivery — an
// already-COMPLETED redelivery is acked and skipped immediately (0
// additional AI calls, 0 additional LINE pushes), reusing the existing
// transport idempotency record, AI decision cache, notified-state, and
// incident suppression rather than a second duplicate-protection layer.
//
// OBSERVATORY KEY-IDENTITY FIX — a real bug found and fixed during this
// round's own development, not anticipated in the initial design: because
// the Queue Consumer runs as a genuinely separate invocation, its own
// `now = new Date()` differs from the HTTP ingress's original accept-time
// `now` — using it directly for the final Observatory write would create a
// SECOND KV entry instead of overwriting the early PROCESSING_STARTED
// record (breaking the V2.2.0 "same key overwrite" design). Fixed by
// reconstructing `observatoryNow` from the queue message's own
// `acceptedFirstAcceptedAt` field for BOTH Observatory writes, while
// keeping the genuine current `now` for every real business-decision
// (AI call, LINE broadcast-hour gating) and for markProcessingComplete's
// own `completedAt` (which correctly reflects genuine completion time, not
// accept time). See test/pbsDebugPushBackgroundProcessing.test.js's own
// "observatoryNow key-identity regression guard" test.
//
// RAW_PBS_TEXT_POLICY = IMMUTABLE_END_TO_END_UNTIL_AI — unchanged this
// round, re-verified: the queue message's own `event` field is a verbatim
// shallow clone (buildPbsAiQueueMessage), never truncated/summarized/
// rewritten/regenerated; parsed fields may be added alongside, never
// replacing raw text.
//
// KV COST — measured, not estimated: puts = 4N + 2 (IDENTICAL to V2.2.0's
// own formula — EXTRA_KV_WRITES_PER_EVENT vs V2.2.0 = 0, the same four
// writes just split across two Worker invocations); gets = 6N (+1 per
// event vs V2.2.0's 5N — the Queue Consumer's own idempotency re-check).
// At 50/100/200 accepted events/day: 202/402/802 puts/day, 300/600/1200
// gets/day, both comfortably under the Workers KV Free Plan's 1,000
// writes/day budget. See test/pbsDebugPush.test.js's own KV cost
// quantification tests.
//
// QUEUE COST (Cloudflare Queues operations, engineering estimate — no live
// Cloudflare billing API access from this sandbox to verify against actual
// account usage): a clean success is 1 write (Queue.send) + 1 read/ack
// (Queue Consumer's single delivery) = 2 operations/event; an event that
// exhausts all 3 retries is 1 write + 4 read attempts (3 retried + 1 final
// ack) = 5 operations/event (worst case). At 50/100/200 events/day, even
// the all-retries-exhausted worst case is 250/500/1000 operations/day —
// comfortably under the documented 10,000/day free-tier operation budget;
// real traffic (low volume, rare AI failures) sits far closer to the
// 100/200/400 operations/day clean-success figure.
//
// EXPLICITLY UNCHANGED THIS ROUND: Windows PBS filter, Windows's own HTTP
// timeout, PBS raw text content, AI prompt/model/semantic policy, service
// area, LINE formatter, driverSummary, hourly reminder, TDX, CCTV, Shared
// Feed product logic, LINE broadcast rules, and the Observatory page's
// overall UI (only the HTTP-ingress -> AI work-carrying mechanism, and the
// Observatory's outcome vocabulary gaining PROCESSING_FAILED, changed).
//
// See src/pbs/debugPush.js's own header comment for the full design,
// test/pbsDebugPushBackgroundProcessing.test.js for HTTP-ingress-level
// lifecycle-separation coverage (rewritten this round for the Queue
// architecture), and the NEW test/pbsAiQueueReliability.test.js for
// Queue-specific reliability coverage (bounded retry, AI_DECISION_INVALID
// staying non-retryable, PROCESSING_FAILED, AT_LEAST_ONCE->EFFECTIVELY_ONCE
// duplicate protection, RAW_PBS_TEXT_POLICY through the queue message, and
// the real EVENT_ID=11508290166-0 incident regression fixture — a
// controllable Promise stands in for a 30+ second AI delay, never a real
// test sleep).

export const APP_VERSION = 'V2.3.0';

// Bumped only when the SHAPE of a public/admin JSON response this
// project exposes changes in a way a consumer (Shared Feed, /version,
// /admin/deployment-status) would need to know about — not on every
// feature round. Currently unchanged since it was first introduced.
export const SCHEMA_VERSION = 1;
