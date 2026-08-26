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

export const APP_VERSION = 'V1.9.2';

// Bumped only when the SHAPE of a public/admin JSON response this
// project exposes changes in a way a consumer (Shared Feed, /version,
// /admin/deployment-status) would need to know about — not on every
// feature round. Currently unchanged since it was first introduced.
export const SCHEMA_VERSION = 1;
