// V1.8.6.7 — 24h Pipeline Trace. Best-effort, debug-only, Admin-Auth read.
// Purpose: let a non-programmer administrator look at ANY event that
// entered this run's pipeline — not just ones that actually got pushed to
// LINE (see broadcastProvenance.js for that, narrower, log) — and see
// exactly where it diverged: upstream vs normalized fields, which gate
// rejected/suppressed/gated it, what CCTV/KM enrichment did or didn't do,
// and what (if anything) actually got delivered.
//
// RELATIONSHIP TO broadcastProvenance.js (V1.8.6.4) — deliberately BOTH
// kept, they answer different questions:
//   - broadcastProvenance.js: "why did that ACTUALLY-SENT LINE message
//     look like that" — one record per successful push, 48h TTL.
//   - pipelineTrace.js (this module): "what happened to THIS event,
//     whether or not it ever reached LINE" — one record per event this
//     run touched at all (rejected/deduped/suppressed/gated included),
//     24h TTL. A superset of provenance's scope, shorter retention (the
//     volume is much higher — see "PERFORMANCE" below).
// Neither module re-implements the other's classification/eligibility/
// KM-resolution logic — every field here is copied from values the SAME
// pipeline run already computed elsewhere (describeClassificationEvidence
// is literally imported from broadcastProvenance.js, not duplicated).
//
// HARD BOUNDARIES (same isolation principle as every other debug log in
// this project — see broadcastProvenance.js/usageLedger.js):
//   - Zero additional TDX/PBS/CCTV/Google/LINE calls anywhere in this
//     module. Every field comes from data the pipeline already computed/
//     holds in memory. Never re-classifies, never re-resolves KM, never
//     re-queries CCTV.
//   - A trace write can NEVER affect the real pipeline outcome —
//     recordPipelineTrace() never throws; a KV failure degrades to "this
//     one event's trace is missing," nothing else.
//   - Never stores: a Secret, an Authorization header, a LINE userId/
//     groupId, a subscriber/push target, an access token, an admin
//     credential, or the full raw TDX/PBS JSON payload. Only whitelisted
//     structured upstream fields (see buildUpstreamSnapshot) and a
//     truncated description summary (max 120 chars, per instruction).
//   - One KV `put` per event, at most, per Cron run — entries are
//     accumulated in memory across the whole pipeline (see
//     broadcastPipeline.js's traceCollector / scheduled.js's
//     runPipelineTracePersist) and written in one centralized finalize
//     pass, never once per pipeline stage.
//
// PERFORMANCE (see PROJECT_HANDOFF.md's own writeup for the full
// assessment) — trace volume is every Hsinchu-filtered event this run
// touched (typically low tens), not just successful pushes, so this is a
// meaningfully higher KV write rate than broadcastProvenance.js. Bounded
// by: (a) 24h TTL — total stored volume never grows past
// (events/tick × ticks/day), self-limiting regardless of how long any one
// real-world event stays active; (b) the admin read endpoints below cap
// both the KV `list` scan (MAX_ENTRIES_SCANNED) and the response
// (MAX_LIST_LIMIT) — same bounded-scan pattern as broadcastProvenance.js.
// The write path itself never calls `list` — only `put`, exactly once per
// event, on the already-existing Cron hot path.

import { taipeiDateString } from '../tdx/usageLedger.js';
import { describeClassificationEvidence } from './broadcastProvenance.js';
import { normalizePbsDirection } from './directionEquivalence.js';
import { canonicalFreewayRoad, canonicalProvincialRoad } from './roadIdentity.js';

export const TRACE_KEY_PREFIX = 'debug:pipeline-trace:v1';
export const TRACE_TTL_SECONDS = 24 * 60 * 60; // 24h, per instruction

// V1.9.2 (KV Write Optimization) — BATCH persistence. Real Cloudflare
// alert: traffic-reporter-kv hit 733/1000 daily KV writes (97.9% of the
// account's whole daily budget), and the prior round's read-only KV
// forensic pass named Pipeline Trace's one-`put`-per-entry write pattern
// as a top writer — a busy tick with 20-30 traced events cost 20-30
// separate KV writes, every 10 minutes. This schema writes the WHOLE
// round's entries in ONE key instead: `debug:pipeline-trace-batch:v2:
// <date>:<epochMs>:<partIndex>:<opaqueId>`, `{schemaVersion:2,
// generatedAt, entries:[...]}`. `partIndex` only ever exceeds `00` when
// a single round's entries are large enough to need deterministic
// splitting (see chunkEntriesForTraceBatch below) — a real day's volume
// (this module's own PERFORMANCE note: "typically low tens" per tick)
// never comes close to needing a second part.
//
// BACKWARD COMPATIBILITY, non-negotiable: the OLD v1 per-entry keys
// (TRACE_KEY_PREFIX above) are NEVER deleted, NEVER bulk-migrated, and
// keep expiring on their own pre-existing 24h TTL exactly as before —
// recordPipelineTrace/persistPipelineTraceEntries below are UNCHANGED and
// stay exported (existing direct callers/tests keep working unmodified).
// listPipelineTrace now reads BOTH schemas and merges them into one
// newest-first timeline (see that function's own comment) — every
// existing v1-only record already in KV from before this deploy renders
// exactly as it always did, right up until its own 24h TTL expires it.
export const TRACE_BATCH_KEY_PREFIX = 'debug:pipeline-trace-batch:v2';

// Safety caps for deterministic splitting — real Cloudflare Workers KV
// per-value ceiling is 25 MiB, and this project's own realistic volume
// (low tens of entries/tick) puts a genuine batch at well under 100 KB
// even generously estimated. Both numbers below are therefore pure
// runaway-anomaly guards, not expected limits — "splitting only if truly
// needed", per this round's own instruction. MAX_TRACE_BATCH_BYTES is
// checked against each entry's OWN serialized size, so a single
// pathologically large entry is still written alone in its own part
// (never silently dropped) rather than blocked from ever committing.
export const MAX_TRACE_ENTRIES_PER_BATCH = 500;
export const MAX_TRACE_BATCH_BYTES = 2 * 1024 * 1024; // 2 MiB
const DESCRIPTION_SUMMARY_MAX_CHARS = 120; // per instruction — Description 只存摘要，最多 120 字
const UPSTREAM_FIELD_MAX_CHARS = 80; // same cap already used by provenance's classificationSource/locationSource values
// V1.9.1 — 30 -> 60. Raised per human-reported查修 need: a real查修 pass
// on a busy day routinely wants more than 30 rows visible without having
// to type a limit every time. MAX_LIST_LIMIT (the hard ceiling) and
// MAX_ENTRIES_SCANNED (the KV list() scan safety cap, unchanged) are
// untouched — this only moves the UNSPECIFIED-limit default, never the
// upper bound.
export const DEFAULT_LIST_LIMIT = 60;
export const MAX_LIST_LIMIT = 100;
// Same bounded-scan idiom as broadcastProvenance.js's MAX_ENTRIES_SCANNED
// — this endpoint is Admin-triggered, on-demand, never on the hot
// broadcast path, but still kept cheap and predictable regardless of how
// many entries exist within the 24h TTL window.
const MAX_ENTRIES_SCANNED = 500;
// V1.8.7.3 — root cause of "Pipeline Trace 篩選失效"/"看不到最新事件":
// see listPipelineTrace's own comment for the full write-up. This bounds
// the KEY-ENUMERATION pass (cheap `kv.list()` calls, no record bodies
// read yet) to a generous number of PAGES, high enough to comfortably
// reach the true end of a realistic 24h key range (this module's own
// PERFORMANCE note above puts worst-case daily volume in the low
// thousands) — deliberately NOT the same knob as MAX_ENTRIES_SCANNED,
// which governs something else entirely (how many of the NEWEST keys are
// then actually read+filtered). Only a defensive ceiling against a
// genuinely pathological key count (e.g. a future TTL/pruning bug) — the
// real termination condition is always `page.list_complete`.
const MAX_LIST_PAGES = 40;

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

// 64 bits of randomness for key uniqueness only — same construction as
// broadcastProvenance.js's own opaqueId(), duplicated locally per this
// project's established convention (each debug-log module stays
// independently readable).
function opaqueId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function truncate(text, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function eventKeyOf(event) {
  return `${(event && event.source) || 'unknown'}:${(event && event.rawId) || ''}`;
}

/**
 * Whitelist-only snapshot of the fields a human needs to compare "what
 * upstream actually said" against "what the system decided" — never the
 * full raw record. Called ONCE, at normalize time, from tdx/normalize.js
 * and pbs/normalize.js, from local variables those functions already
 * extracted for their own normal fields (no second parse, no re-read of
 * anything not already in scope there) — stored on the event as the
 * debug-only `event.pipelineTraceUpstream` field, mirroring the exact
 * pattern already established by `event.provenance` (V1.8.6.4): never
 * read by the formatter/fingerprint/eligibility/dedupe/CCTV-eligibility,
 * see those modules for confirmation none of them spread the whole event
 * object.
 *
 * @param {object} fields
 * @param {string|null} [fields.eventType] - TDX EventType, or PBS's
 *   analogous top-level category text (roadtype) — same field NAME used
 *   for both sources so the trace schema doesn't fork by source.
 * @param {string|null} [fields.eventSubType] - TDX EventSubType only; null for PBS (no analogous field).
 * @param {string|null} [fields.category] - TDX Category only; null for PBS.
 * @param {string|null} [fields.rawDirection] - the raw direction text BEFORE this project's own normalization/canonicalization.
 * @param {string|number|null} [fields.rawStartKM]
 * @param {string|number|null} [fields.rawEndKM]
 * @param {string|null} [fields.upstreamUpdatedAt] - the raw source's own last-update timestamp, already-parsed ISO (no re-parse here).
 * @param {string} [fields.description] - the raw description/comment text, truncated to 120 chars here (never stored longer, never the full text).
 */
export function buildUpstreamSnapshot({
  eventType = null,
  eventSubType = null,
  category = null,
  rawDirection = null,
  rawStartKM = null,
  rawEndKM = null,
  upstreamUpdatedAt = null,
  description = '',
} = {}) {
  return {
    EventType: eventType ? truncate(String(eventType), UPSTREAM_FIELD_MAX_CHARS) : null,
    EventSubType: eventSubType ? truncate(String(eventSubType), UPSTREAM_FIELD_MAX_CHARS) : null,
    Category: category ? truncate(String(category), UPSTREAM_FIELD_MAX_CHARS) : null,
    descriptionSummary: truncate(description, DESCRIPTION_SUMMARY_MAX_CHARS),
    rawDirection: rawDirection ? String(rawDirection) : null,
    rawStartKM: rawStartKM === undefined || rawStartKM === null || rawStartKM === '' ? null : rawStartKM,
    rawEndKM: rawEndKM === undefined || rawEndKM === null || rawEndKM === '' ? null : rawEndKM,
    upstreamUpdatedAt: upstreamUpdatedAt || null,
  };
}

// V1.8.6.5 — same sanitized, evidence-only view broadcastProvenance.js
// uses (never the raw coordinate/mapUrl) — this file re-exports that
// exact logic rather than a second copy. Kept local (not re-exported from
// broadcastProvenance.js, which has no reason to know this module exists)
// to avoid a circular concern; both modules read the SAME resolveKmLocation()
// result object, never re-run it.
function sanitizeKmLocationResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') return null;
  if (!resolution.resolved) {
    return { resolved: false, reason: resolution.reason || null };
  }
  return {
    resolved: true,
    dataset: resolution.dataset || null,
    road: resolution.road || null,
    targetKm: typeof resolution.targetKm === 'number' ? resolution.targetKm : null,
    resolvedKm: typeof resolution.resolvedKm === 'number' ? resolution.resolvedKm : null,
    locationLabel: resolution.locationLabel || null,
    segmentFrom: resolution.segmentFrom || null,
    segmentTo: resolution.segmentTo || null,
    coordinateAvailable: Boolean(resolution.coordinate),
  };
}

/**
 * Pure — builds one trace record. No I/O, directly unit-testable. Every
 * argument must be a value the SAME pipeline run already computed
 * elsewhere (see broadcastPipeline.js's per-event loop and scheduled.js's
 * pre-broadcast-pipeline dropout handling for the two call sites) —
 * nothing here re-derives classification, eligibility, KM resolution, or
 * CCTV outcome.
 *
 * `status` is a small fixed enum, computed here from the other fields,
 * used for the admin endpoints' `?status=` filter and the trace-view
 * page's at-a-glance badge:
 *   line-sent | eligible-no-target | suppressed | not-started |
 *   event-ended | outside-broadcast-window | not-relevant | ineligible |
 *   duplicate | gated | merged | line-failed
 *
 * V1.8.6.8 — `not-started`/`event-ended`/`outside-broadcast-window`
 * replace the old single catch-all `not-relevant` for a rejected
 * scheduled/announced event (construction/closure/control/other with a
 * parsed schedule) whenever `eventTimeStatus` is available — see section
 * 4 of this round's own task: a management page that only ever said
 * "尚未到播報時間" for every non-broadcast reason made it impossible to
 * tell, without reading code, whether an event simply hadn't started
 * yet, had already ended, or was genuinely active but outside the
 * product's own 08:00-22:00 window. `not-relevant` is kept ONLY as a
 * fallback for a caller that doesn't pass `eventTimeStatus` at all.
 */
export function buildTraceEntry({
  event,
  now = new Date(),
  dedupeResult = null, // 'new' | 'updated' | 'duplicate' | null
  gatingResult = null, // 'merged-into-canonical' | 'unique-candidate' | 'gated-freeway-no-tdx-match' | 'enriched-by-pbs-match' | null
  eligibility = null, // boolean | null
  eligibilityReason = null,
  relevant = null, // boolean | null — effectiveWindow.js's isBroadcastRelevant this run
  // V1.8.6.8 — see effectiveWindow.js's classifyEventTimeStatus (the
  // SAME classifier isBroadcastRelevant itself is built on, never a
  // second independent comparison): 'no-data' | 'not-started' | 'active'
  // | 'ended'. eventActive is a plain boolean convenience derived from
  // it (true only for 'active') for callers/tests that just want the
  // boolean this round's own task spec names.
  eventTimeStatus = null,
  eventWindow = null, // {effectiveStart, effectiveEnd, timeSource} | null — the raw computeEffectiveWindow() result, shown verbatim in the trace so a human can see the exact window the decision was based on
  // V1.8.6.8 — broadcastHours.js's isWithinBroadcastHours(now) result for
  // THIS run, threaded in by the caller (already computed once per run —
  // never recomputed per event). A completely separate axis from
  // eventTimeStatus: the PRODUCT's own 08:00-22:00 Asia/Taipei active-
  // hours policy, not the event's own announced timing.
  broadcastWindowActive = null,
  suppressionResult = null, // 'new-incident' | 'material-escalation' | 'same-incident-no-escalation' | null
  // 2026-08-24 (Location Quality Gate) — traffic/locationQuality.js's own
  // verdict for this event, verbatim: {sufficient, tier, reason, detail?,
  // evidence}. Recorded for every event that reached that gate, pass or
  // block, so the trace can say WHICH tier placed the event (or exactly
  // what was missing) instead of one undifferentiated "不符合播報資格".
  // Never re-computed here — same "copy what the pipeline already
  // decided" discipline as every other field in this module.
  locationQuality = null,
  kmLocationResolution = null,
  cctvEligible = null, // boolean | null
  cctvSkippedByReason = null, // string | null
  // 2026-08-25 — the kilometre the camera lookup actually aimed at
  // (cctv/dynamicCollage.js's eventTargetKm). Pipeline-computed, so it
  // is threaded in by the caller exactly like imageStrategy; null when
  // CCTV was never eligible for this event.
  cctvTargetKm = null, // number | null
  imagePrepared = null, // boolean | null
  imageUrlPresent = null,
  imageExpiresAt = null,
  formattedOutput = null,
  lineAttempted = null, // number | null — pending targets attempted this run for this event
  lineSucceeded = null, // number | null
  sharedFeedPersisted = null, // boolean | null
  sharedFeedWithImage = null, // boolean | null
  // V1.8.7.0 (Dynamic Shoulder) — imageStrategy/selectedCamera/
  // rangeResolution are PIPELINE-computed outcomes for THIS run (which
  // strategy was used, which camera won, what the range resolved to) —
  // unlike eventSemantic/shoulderState below, they cannot be derived from
  // `event` alone, so they're threaded in by the caller (see
  // broadcastPipeline.js's traceForEvent.imageStrategy/selectedCamera/
  // rangeResolution assignments) exactly like imagePrepared/
  // imageUrlPresent/imageExpiresAt already are.
  imageStrategy = null, // 'quad' | 'single' | null
  selectedCamera = null, // string | null — minimal `${cctvId}@${locationMile}` reference, NEVER the raw CCTV record (see enrichment block below)
  rangeResolution = null, // {segmentFrom, segmentTo, locationLabel} | null
  // V1.8.7.1 — minimal budget/fairness diagnostics (see this round's own
  // "選最有診斷價值、資料量最小的欄位" instruction — deliberately NOT the
  // full budgetAtStartMs/budgetRemainingMs pair the task's own example
  // list offered; `cctvBudgetClass` + `singleSlotIndex`/`singleSlotLimit`
  // already say the same thing more legibly, e.g. "this was slot 6 of a
  // 5-slot single-per-event cap" is immediately actionable, a bare
  // remaining-ms number is not, without cross-referencing a constant).
  // Threaded in by broadcastPipeline.js exactly like imageStrategy above
  // — pipeline-computed outcomes, never derivable from `event` alone.
  cctvBudgetClass = null, // 'quad-shared' | 'single-per-event' | null — WHICH budget regime this event's CCTV attempt (if any) used
  processingDurationMs = null, // number | null — wall-clock ms this event's own CCTV attempt actually took, win or lose
  singleSlotIndex = null, // number | null — this event's own 1-based attempt number this run, single-strategy only
  singleSlotLimit = null, // number | null — MAX_SINGLE_CCTV_EVENTS_PER_RUN at the time of this attempt, single-strategy only
  // V1.8.7.3 — minimal STAGE-LEVEL breakdown of processingDurationMs
  // above, single-strategy only (see cctv/dynamicCollage.js's
  // prepareSingleCctvImageWork, the only writer of these three) — added
  // specifically to answer "which stage of the single-CCTV budget is
  // actually consuming time" from real Production evidence, per this
  // round's own instruction. Deliberately just three small numbers/one
  // short string, never the frame bytes, the stream URL, or any other
  // candidate/metadata payload — same whitelist-only discipline as
  // selectedCamera above.
  frameFetchDurationMs = null, // number | null — ms extractFirstJpegFrame's fetch+body-read took, when it was reached
  r2PublishDurationMs = null, // number | null — ms publishCollageImage's R2 PUT took, when it was reached
  timeoutStage = null, // 'metadata' | 'candidate-selection' | 'frame-fetch' | 'r2-publish' | null — which stage was in flight when this attempt's budget ran out (only set on a 'prepare-timeout' outcome)
  // V1.9.0 (root-cause forensics, 國3 96K+700 2026-08-26) — the QUAD
  // (accident) path's own stage-level breakdown, only ever set by
  // cctv/dynamicCollage.js's prepareCctvImageWork (via its stageTracker
  // — see that function's own comment). Deliberately distinct field
  // names from frameFetchDurationMs/r2PublishDurationMs above: those are
  // single-camera (ONE fetch); these cover the quad path's BATCH of up
  // to 4 concurrent frame fetches plus the multi-frame collage compose
  // step, which the single-camera path has no equivalent of at all.
  // Plain numbers only, on EVERY outcome (success, failure, or timeout)
  // — never a stream URL, candidate record, or frame byte. Added
  // specifically because the quad path's 'prepare-timeout' used to
  // carry NO stage/timing information whatsoever (the exact
  // "09:20 沒有 completion log" symptom this round investigates).
  metadataElapsedMs = null, // number | null — ms the (memoized) metadata read took
  cameraSelectionElapsedMs = null, // number | null — ms selectFourQuadrantCandidates took (pure/local, expected near-0)
  frameFetchElapsedMs = null, // number | null — ms the whole 4-candidate PARALLEL fetch batch took (bounded by the SLOWEST candidate — see composeCollageFromCandidates's own comment)
  collageElapsedMs = null, // number | null — ms composeQuadrantCollage took (WASM codec load + SERIAL per-cell JPEG decode/encode)
  successfulFrameCount = null, // number | null — how many of the existing (non-null) candidates produced a genuinely DECODED frame
  failedFrameCount = null, // number | null — how many existing candidates did not (fetch failure OR decode failure) — a `null` (empty) quadrant slot is never counted as a failure
  r2PublishElapsedMs = null, // number | null — ms the quad path's own R2 PUT took, when it was reached
} = {}) {
  const anomalyDetail = event && event.nonCollisionAnomalyDetail ? event.nonCollisionAnomalyDetail : null;
  const upstream = (event && event.pipelineTraceUpstream) || buildUpstreamSnapshot({});
  const eventActive = eventTimeStatus === null ? null : eventTimeStatus === 'active';
  // V1.8.7.0 — unlike imageStrategy/selectedCamera/rangeResolution above,
  // these two ARE derivable directly from `event` itself (the SAME
  // `event.dynamicShoulder` tdx/normalize.js's detectDynamicShoulder
  // attached — see that module's own comment), so no new parameter is
  // needed for them — same "read straight off the event" pattern
  // `identity.road`/`identity.source` below already use.
  const dynamicShoulder = event && event.dynamicShoulder;
  const eventSemantic = dynamicShoulder ? 'dynamic-shoulder' : null;
  const shoulderState = dynamicShoulder ? dynamicShoulder.state : null;

  const status = computeStatus({
    dedupeResult,
    gatingResult,
    eligibility,
    eligibilityReason,
    relevant,
    eventTimeStatus,
    broadcastWindowActive,
    suppressionResult,
    lineAttempted,
    lineSucceeded,
  });

  return {
    eventKey: eventKeyOf(event),
    status,
    identity: {
      timestamp: now.toISOString(),
      source: (event && event.source) || null,
      rawId: (event && event.rawId) || null,
      road: (event && event.road) || null,
    },
    upstream,
    normalized: {
      type: (event && event.type) || null,
      direction: (event && event.direction) || null,
      startKM: event && event.startKM !== undefined ? event.startKM : null,
      endKM: event && event.endKM !== undefined ? event.endKM : null,
      displayKM: event && typeof event.displayKM === 'number' ? event.displayKM : null,
      location: (event && event.location) || null,
      classificationSource: (event && event.provenance && event.provenance.classificationSource) || null,
      classificationEvidence: describeClassificationEvidence(event, eligibilityReason, anomalyDetail),
      // V1.8.7.0 (Dynamic Shoulder) — derived directly from
      // event.dynamicShoulder above; null/null for every event that
      // isn't one. Deliberately NOT a second classificationEvidence —
      // this reuses the SAME evidence dynamicShoulderClassification.js
      // itself already captured (see event.dynamicShoulder.evidence,
      // carried through unchanged, never re-derived here) rather than
      // building a parallel evidence trail.
      eventSemantic,
      shoulderState,
      dynamicShoulderEvidence: dynamicShoulder ? dynamicShoulder.evidence : null,
    },
    decision: {
      eligibility,
      eligibilityReason,
      // 2026-08-24 — derived from the SAME eligibilityReason the service
      // area gate already produced (never a second, drifting check), so
      // "blocked by geography" is distinguishable at a glance from
      // "blocked by the accident-only policy" or "gated for no TDX
      // match". null when the event never reached the gate.
      serviceAreaEligible:
        eligibilityReason === null
          ? null
          : eligibilityReason !== 'outside-service-area' &&
            eligibilityReason !== 'service-area-unknown-source' &&
            eligibilityReason !== 'service-area-unresolvable',
      // 2026-08-24 — the third, permanently independent gate (see
      // locationQuality.js). serviceAreaEligible above answers "is it
      // ours", this answers "can a driver act on it". null when the event
      // never reached the gate (an earlier gate already stopped it).
      locationQuality: sanitizeLocationQuality(locationQuality),
      dedupeResult,
      suppressionResult,
      gatingResult,
      // V1.8.6.8 — see the param comments above. eventWindow is the raw
      // effectiveStart/effectiveEnd/timeSource computeEffectiveWindow()
      // already produced this run (never re-derived here); eventActive/
      // eventTimeStatus/broadcastWindowActive are the two-axis
      // "事件有效時間 x 播報時段" breakdown section 1/4 of this round asks for.
      eventActive,
      eventTimeStatus,
      eventWindow: eventWindow ? { effectiveStart: eventWindow.effectiveStart, effectiveEnd: eventWindow.effectiveEnd, timeSource: eventWindow.timeSource } : null,
      broadcastWindowActive,
    },
    enrichment: {
      kmLocationResolution: sanitizeKmLocationResolution(kmLocationResolution),
      cctvEligible,
      cctvSkippedByReason,
      cctvTargetKm: typeof cctvTargetKm === 'number' && Number.isFinite(cctvTargetKm) ? cctvTargetKm : null,
      imagePrepared,
      imageUrlPresent,
      imageExpiresAt,
      // V1.8.7.0 (Dynamic Shoulder) — see the param comments above.
      // selectedCamera is a minimal `${cctvId}@${locationMile}` string
      // ONLY (never the raw CCTV metadata record — this module's own
      // whitelist-only discipline, same as buildUpstreamSnapshot above).
      imageStrategy,
      selectedCamera,
      rangeResolution,
      // V1.8.7.1 — see the param comments above.
      cctvBudgetClass,
      processingDurationMs,
      singleSlotIndex,
      singleSlotLimit,
      // V1.8.7.3 — see the param comments above.
      frameFetchDurationMs,
      r2PublishDurationMs,
      timeoutStage,
      // V1.9.0 — see the param comments above; quad path only.
      metadataElapsedMs,
      cameraSelectionElapsedMs,
      frameFetchElapsedMs,
      collageElapsedMs,
      successfulFrameCount,
      failedFrameCount,
      r2PublishElapsedMs,
    },
    delivery: {
      lineAttempted,
      lineSucceeded,
      formattedOutput: formattedOutput || null,
      sharedFeedPersisted,
      sharedFeedWithImage,
    },
  };
}

// Kept deliberately small and whitelist-only, same discipline as
// sanitizeKmLocationResolution below: a trace record must never grow to
// carry a whole resolver payload. `evidence` is the only free-form part
// and is already just a handful of short scalars produced by
// locationQuality.js itself.
const INSUFFICIENT_LOCATION_REASON = 'insufficient-location-precision';

function sanitizeLocationQuality(quality) {
  if (!quality || typeof quality !== 'object') return null;
  return {
    sufficient: Boolean(quality.sufficient),
    tier: quality.tier || null,
    reason: quality.reason || null,
    detail: quality.detail || null,
    evidence: quality.evidence && typeof quality.evidence === 'object' ? quality.evidence : null,
  };
}

function computeStatus({
  dedupeResult,
  gatingResult,
  eligibility,
  eligibilityReason,
  relevant,
  eventTimeStatus,
  broadcastWindowActive,
  suppressionResult,
  lineAttempted,
  lineSucceeded,
}) {
  if (typeof lineSucceeded === 'number' && lineSucceeded > 0) return 'line-sent';
  if (typeof lineAttempted === 'number' && lineAttempted > 0 && lineSucceeded === 0) return 'line-failed';
  if (dedupeResult === 'duplicate') return 'duplicate';
  if (gatingResult === 'gated-freeway-no-tdx-match') return 'gated';
  if (gatingResult === 'merged-into-canonical') return 'merged';
  // 2026-08-24 — "不要全部只顯示「不符合播報資格」": the two gates a human
  // most often needs to tell apart get their own status, derived from the
  // SAME eligibilityReason the pipeline already produced (never a second,
  // drifting check). Everything else still falls through to the generic
  // 'ineligible', whose reason is now shown verbatim on the row.
  if (eligibility === false && eligibilityReason === 'outside-service-area') return 'outside-service-area';
  if (eligibility === false && eligibilityReason === INSUFFICIENT_LOCATION_REASON) return 'insufficient-location';
  if (eligibility === false) return 'ineligible';
  if (suppressionResult === 'same-incident-no-escalation') return 'suppressed';
  if (eventTimeStatus === 'ended') return 'event-ended';
  if (eventTimeStatus === 'not-started') return 'not-started';
  if (broadcastWindowActive === false) return 'outside-broadcast-window';
  if (relevant === false) return 'not-relevant'; // fallback: eventTimeStatus wasn't supplied
  if (eligibility === true && typeof lineAttempted === 'number' && lineAttempted === 0) return 'eligible-no-target';
  return 'eligible-no-target';
}

/**
 * Best-effort, fully isolated write — see module comment. NEVER throws.
 * A failed write here must never change anything about the real
 * pipeline's outcome, which already fully completed by the time this is
 * ever called (see scheduled.js's runPipelineTracePersist — the very last
 * step of a Cron run, after LINE push, notified-state, and Shared Feed
 * persistence).
 */
export async function recordPipelineTrace(kv, entry, now = new Date(), sequence = 0) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const date = taipeiDateString(now);
    // 2026-08-24 — `sequence` exists because EVERY entry a Cron run
    // writes shares that run's single `now` (scheduled.js passes one
    // Date), so `now.getTime()` is identical across the whole batch and
    // the only thing separating those keys used to be the RANDOM
    // opaqueId. Listing is lexicographic, so a run's own entries came
    // back in random order — and with the newest-first page bounded by
    // DEFAULT_LIST_LIMIT, a specific event could be pushed off page 1
    // non-deterministically, which reads to a human as "the event was
    // never traced". Zero-padded so it sorts as a number, and placed
    // before the opaqueId so the id keeps doing its only job (uniqueness).
    const key = `${TRACE_KEY_PREFIX}:${date}:${now.getTime()}:${String(sequence).padStart(6, '0')}:${opaqueId()}`;
    await kv.put(key, JSON.stringify(entry), { expirationTtl: TRACE_TTL_SECONDS });
    return { committed: true, key };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/**
 * Writes every entry in `entries`, one KV `put` each, best-effort and
 * fully isolated per-entry (one bad entry/write failure never blocks the
 * rest). Returns counts only — callers (scheduled.js) log-and-move-on,
 * exactly like every other end-of-run side effect in this project.
 */
export async function persistPipelineTraceEntries(kv, entries, now = new Date()) {
  let committed = 0;
  let failed = 0;
  const list = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < list.length; index += 1) {
    // Batch position is the stable tiebreaker within this run — see
    // recordPipelineTrace's own `sequence` comment.
    const result = await recordPipelineTrace(kv, list[index], now, index);
    if (result.committed) committed += 1;
    else failed += 1;
  }
  return { attempted: (entries || []).length, committed, failed };
}

/**
 * Pure. Splits `entries` (in their given order) into deterministic chunks,
 * each respecting BOTH MAX_TRACE_ENTRIES_PER_BATCH and
 * MAX_TRACE_BATCH_BYTES (measured as each entry's own UTF-8 JSON byte
 * length, additive). A chunk never starts empty-then-overflows: a single
 * entry larger than the byte cap on its own still becomes its own
 * one-entry chunk (never dropped, never blocked) — only ADDING a further
 * entry to an already-nonempty chunk is what the byte check guards
 * against. Deterministic given the same input — no randomness, no
 * wall-clock dependency, safe to unit-test directly.
 */
export function chunkEntriesForTraceBatch(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  const encoder = new TextEncoder();

  for (const entry of list) {
    const entryBytes = encoder.encode(JSON.stringify(entry)).length;
    const wouldExceedCount = current.length + 1 > MAX_TRACE_ENTRIES_PER_BATCH;
    const wouldExceedBytes = current.length > 0 && currentBytes + entryBytes > MAX_TRACE_BATCH_BYTES;
    if (current.length > 0 && (wouldExceedCount || wouldExceedBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entryBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * V1.9.2 — the Cron path's new write entry point, replacing
 * persistPipelineTraceEntries (kept above, unchanged, for backward-
 * compatible reads/tests — see this module's TRACE_BATCH_KEY_PREFIX
 * comment). Writes this WHOLE round's entries as one (or, only if
 * genuinely oversized, a few deterministically-split) KV `put` instead of
 * one per entry. Same isolation discipline as every write in this module:
 * never throws, a partial/total KV outage degrades to a `failed` count,
 * never affects the real pipeline outcome (already fully completed by the
 * time scheduled.js calls this).
 *
 * `committed`/`failed` below count ENTRIES (not batch keys) — same
 * meaning persistPipelineTraceEntries' return already had, so
 * scheduled.js's `[cron][pipeline-trace]` log line keeps its existing
 * shape. `batchCount`/`batchesCommitted` are the NEW, additional
 * batch-level numbers this round's `[kv-write-budget]` log reports.
 */
export async function persistPipelineTraceBatch(kv, entries, now = new Date()) {
  const list = Array.isArray(entries) ? entries : [];
  if (!kv) return { attempted: list.length, committed: 0, failed: list.length, batchCount: 0, batchesCommitted: 0 };
  if (list.length === 0) return { attempted: 0, committed: 0, failed: 0, batchCount: 0, batchesCommitted: 0 };

  const chunks = chunkEntriesForTraceBatch(list);
  const date = taipeiDateString(now);
  const timestamp = now.getTime();

  let committed = 0;
  let failed = 0;
  let batchesCommitted = 0;
  const keys = [];

  for (let partIndex = 0; partIndex < chunks.length; partIndex += 1) {
    const chunk = chunks[partIndex];
    const key = `${TRACE_BATCH_KEY_PREFIX}:${date}:${timestamp}:${String(partIndex).padStart(2, '0')}:${opaqueId()}`;
    const body = { schemaVersion: 2, generatedAt: now.toISOString(), entries: chunk };
    try {
      await kv.put(key, JSON.stringify(body), { expirationTtl: TRACE_TTL_SECONDS });
      committed += chunk.length;
      batchesCommitted += 1;
      keys.push(key);
    } catch {
      failed += chunk.length;
    }
  }

  return { attempted: list.length, committed, failed, batchCount: chunks.length, batchesCommitted, keys };
}

/**
 * Admin-only read. Bounded KV list+get, newest first, optional
 * source/road/rawId/status filters — never touches TDX/PBS/CCTV/LINE,
 * pure KV reads only. Never throws — a KV outage degrades to an empty
 * list with `kvAvailable:false`, same fail-safe shape as
 * broadcastProvenance.js's listBroadcastProvenance.
 */
// 2026-08-24 — ROAD FILTER, and why it used to find nothing.
//
// Real case: a PBS 台68 accident WAS traced and WAS pushed, but a human
// looking for it found nothing. The trace stores `identity.road` as the
// NORMALIZED road (`台68` — pbs/roadName.js), while every surface a human
// can actually see says something else: the LINE message shows
// "（南寮竹東）-台68線", PBS's own field says "台68線". The filter compared
// with `!==`, so searching for exactly what you were looking at returned
// zero rows — indistinguishable from "it was never recorded".
//
// Fixed by comparing through the SAME canonicalisers the pipeline itself
// uses (roadIdentity.js), so 台68 / 台68線 / 國1 / 國道1號 / 國道一號 all
// find their own records. Still a filter, never a fuzzy search: two
// genuinely different roads can never collide, because both sides are
// reduced by the identical function the normalizer used.
function roadFilterMatches(recordRoad, filter) {
  if (!filter) return true;
  const stored = String(recordRoad || '').trim();
  const wanted = String(filter).trim();
  if (!stored) return false;
  if (stored === wanted) return true;
  const canonical = (value) => canonicalFreewayRoad(value) || canonicalProvincialRoad(value) || null;
  const a = canonical(stored);
  const b = canonical(wanted);
  return Boolean(a && b && a === b);
}

// 2026-08-24 — free-text search over the fields a human ACTUALLY has in
// hand after receiving a LINE message: the road, the location text that
// was printed, the message body itself, and the ids. Without it the only
// way in was `rawId` (a PBS UID no human ever sees) or the road filter
// above. Substring, case-insensitive, applied to the same already-fetched
// record — no extra KV reads, no index, no new storage.
function matchesFreeText(record, query) {
  if (!query) return true;
  const needle = String(query).trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    record.eventKey,
    record.identity?.rawId,
    record.identity?.road,
    record.identity?.source,
    record.normalized?.location,
    record.normalized?.type,
    record.upstream?.descriptionSummary,
    record.delivery?.formattedOutput,
    record.decision?.eligibilityReason,
    record.status,
  ]
    .filter((v) => typeof v === 'string' && v)
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Bounded key-ENUMERATION pass for one key prefix — cheap `kv.list()`
 * calls only, no record bodies read yet. Shared by both the legacy v1
 * (one-entry-per-key) and the new v2 (one-batch-per-Cron-round) prefixes
 * — see MAX_LIST_PAGES's own comment for why this is a generous PAGE
 * ceiling, not an entry-count ceiling.
 */
async function listTraceKeysForPrefix(kv, prefix) {
  const keys = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys || []) keys.push(k.name);
    pages += 1;
    if (page.list_complete || !page.cursor || pages >= MAX_LIST_PAGES) break;
    cursor = page.cursor;
  }
  return keys;
}

/**
 * V1.9.2 — reads descriptors newest-first (already merged/sorted by the
 * caller — see listPipelineTrace) and flattens them into individual trace
 * records, stopping once `maxEntries` have been collected. A v1
 * descriptor yields exactly one record (its own `kv.get`); a v2 batch
 * descriptor yields every record in its `entries` array, newest-within-
 * batch first (see the loop below for why). `scannedKeyCount` counts KV
 * `get` OPERATIONS (one per descriptor actually read), matching what this
 * field always meant before v2 existed — "how many keys did this listing
 * actually read", not "how many entries came out of them".
 */
async function collectFlattenedTraceEntries(kv, descriptorsNewestFirst, maxEntries) {
  const entries = [];
  let scannedKeyCount = 0;
  for (const descriptor of descriptorsNewestFirst) {
    if (entries.length >= maxEntries) break;
    scannedKeyCount += 1;
    const raw = await kv.get(descriptor.key);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // corrupt entry/batch — skip it, never let one bad write break the listing
    }
    if (descriptor.type === 'v1') {
      if (parsed && typeof parsed === 'object') entries.push(parsed);
      continue;
    }
    // v2 batch — flatten. Reversed (last-appended-this-round shown
    // first): every entry in one batch shares the same (or
    // near-identical) round timestamp, so there is no real chronological
    // order to preserve within it — this mirrors the OLD v1 scheme's own
    // `sequence` tiebreak (higher sequence = written later this round =
    // shown first after the newest-first reverse — see
    // recordPipelineTrace's own comment), so a mixed v1/v2 history still
    // reads as one consistent convention throughout.
    if (!parsed || !Array.isArray(parsed.entries)) continue;
    for (let i = parsed.entries.length - 1; i >= 0; i -= 1) {
      if (entries.length >= maxEntries) break;
      const record = parsed.entries[i];
      if (record && typeof record === 'object') entries.push(record);
    }
  }
  return { entries, scannedKeyCount };
}

/**
 * Admin-only read. Bounded KV list+get, newest first, optional
 * source/road/rawId/status filters — never touches TDX/PBS/CCTV/LINE,
 * pure KV reads only. Never throws — a KV outage degrades to an empty
 * list with `kvAvailable:false`, same fail-safe shape as
 * broadcastProvenance.js's listBroadcastProvenance.
 *
 * V1.9.2 — reads and MERGES both schemas: the legacy per-entry
 * `debug:pipeline-trace:v1:...` keys (never deleted, never migrated —
 * left to expire on their own pre-existing 24h TTL) and the new
 * `debug:pipeline-trace-batch:v2:...` keys scheduled.js now writes (see
 * persistPipelineTraceBatch). Both key formats embed
 * `<date>:<epochMs>:...` immediately after their own (different-length,
 * different-text) fixed prefix, and epochMs is always exactly 13 digits
 * for every real date this project will ever run on (2001-09-09 through
 * 2286-11-20 — see recordPipelineTrace's own comment) — stripping each
 * key's own prefix before comparing means a v1 key and a v2 key from the
 * SAME instant sort correctly against each other on that shared suffix
 * alone, so the two schemas merge into one correct newest-first timeline
 * with no special-casing. Every existing filter/limit/pagination/
 * scan-truncation behavior is unchanged from the caller's point of view —
 * `handlePipelineTrace`/`handlePipelineTraceView` needed zero changes.
 */
export async function listPipelineTrace(kv, { limit = DEFAULT_LIST_LIMIT, source, road, rawId, status, q } = {}) {
  const boundedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || DEFAULT_LIST_LIMIT));
  if (!kv) return { records: [], kvAvailable: false };

  try {
    const v1Keys = await listTraceKeysForPrefix(kv, `${TRACE_KEY_PREFIX}:`);
    const v2Keys = await listTraceKeysForPrefix(kv, `${TRACE_BATCH_KEY_PREFIX}:`);

    const descriptors = [
      ...v1Keys.map((key) => ({ type: 'v1', key, sortKey: key.slice(TRACE_KEY_PREFIX.length + 1) })),
      ...v2Keys.map((key) => ({ type: 'v2', key, sortKey: key.slice(TRACE_BATCH_KEY_PREFIX.length + 1) })),
    ];
    // Newest first — see this function's own comment on why comparing
    // just the shared `<date>:<epochMs>:...` suffix is already correct
    // chronological order across both schemas.
    descriptors.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));

    // V1.8.7.3's own MAX_ENTRIES_SCANNED bound, now applied to flattened
    // ENTRIES rather than raw keys (see collectFlattenedTraceEntries) —
    // a v2 batch can carry many entries per key, so bounding by entry
    // count (not key count) is what actually keeps this cheap and
    // predictable regardless of how many entries one Cron round wrote.
    const { entries: scannedEntries, scannedKeyCount } = await collectFlattenedTraceEntries(kv, descriptors, MAX_ENTRIES_SCANNED);

    const records = [];
    for (const record of scannedEntries) {
      if (records.length >= boundedLimit) break;
      if (!record || typeof record !== 'object') continue;
      if (source && record.identity?.source !== source) continue;
      if (!roadFilterMatches(record.identity?.road, road)) continue;
      if (rawId && record.identity?.rawId !== rawId) continue;
      if (status && record.status !== status) continue;
      if (!matchesFreeText(record, q)) continue;
      records.push(record);
    }

    // 2026-08-24 — a query only ever READS the newest MAX_ENTRIES_SCANNED
    // entries, so "no rows" can mean either "no such event" or "it is
    // older than the window I looked at". Those are completely different
    // answers to a human debugging a missed broadcast, and no surface may
    // present the second as the first.
    //
    // Deliberately a statement of FACT about coverage — "there are keys
    // this scan never examined" — and nothing about whether the caller
    // liked the result. Presentation (when to actually warn a reader) is
    // the view's decision, not this function's. See this project's "no
    // silent caps" discipline.
    const scanTruncated = descriptors.length > scannedKeyCount;
    return { records, kvAvailable: true, scannedKeyCount, totalKeyCount: descriptors.length, scanTruncated };
  } catch (err) {
    return { records: [], kvAvailable: false, error: safeErrorMessage(err) };
  }
}

// --- Anomaly / diff detection (section H) -----------------------------
//
// Pure, display-only. Never influences the real pipeline in any way —
// only ever called from the admin JSON/HTML read endpoints below, from a
// trace record that is already fully written. Each anomaly is
// {severity, code, message} — `severity` is 'error' | 'warning', `code`
// is a short machine-stable identifier (matches the task's own list),
// `message` is the human-readable (Traditional Chinese) explanation shown
// on the trace-view page.

// V1.8.6.8 — production false-positive: 上游「北上」vs normalized「北向」
// (or 南下/南向, 東行/東向, 西行/西向, 南行/南向, 北行/北向) is the SAME
// semantic direction, two different words for it — not a real direction
// change. Reuses pbs/normalize.js's own normalizePbsDirection (the
// project's single existing direction-equivalence table — see that
// module's DIRECTION_MAP) rather than a second copy; the comparison
// below normalizes BOTH sides through it before comparing, so this stays
// correct if that table ever gains more equivalents, with zero changes
// needed here. Only a genuine semantic change (e.g. 北向 -> 南向) still
// flags DIRECTION_CHANGED.
function directionChanged(trace) {
  const raw = trace.upstream && trace.upstream.rawDirection;
  const normalized = trace.normalized && trace.normalized.direction;
  if (!raw || !normalized) return null;
  if (normalizePbsDirection(raw) === normalizePbsDirection(normalized)) return null;
  return {
    severity: 'error',
    code: 'DIRECTION_CHANGED',
    message: `上游方向「${raw}」與系統方向「${normalized}」不一致`,
  };
}

function typeSemanticMismatch(trace) {
  const subType = trace.upstream && (trace.upstream.EventSubType || trace.upstream.EventType);
  const normalizedType = trace.normalized && trace.normalized.type;
  if (!subType || !normalizedType) return null;
  // Only flag the specific, real-world shape this project has already
  // hit in Production: an upstream subtype text that itself describes a
  // non-collision hazard (行人/動物/積水/落石/etc — the SAME keyword table
  // anomalyClassification.js already uses, reused here rather than a
  // second copy) while normalized `type` still reads 'accident' — this
  // is exactly the V1.8.6.6-class bug this trace exists to catch early.
  if (normalizedType !== 'accident') return null;
  if (NON_COLLISION_HINT_PATTERN.test(subType)) {
    return {
      severity: 'error',
      code: 'TYPE_SEMANTIC_MISMATCH',
      message: `上游子類別「${subType}」疑似非碰撞事故，但系統仍分類為 accident`,
    };
  }
  return null;
}

// Deliberately reuses the SAME category of hazard keywords
// anomalyClassification.js's NON_COLLISION_ANOMALY_RULES already encodes
// (行人/動物/積水/落石/坍方/樹倒/電線/掉落物/火災/橋梁/道路中斷), inlined as
// one alternation here rather than importing that module's internal rule
// table — this check is diagnostic/display-only (section H explicitly:
// "只作 debug/display，不得影響正式 pipeline"), so it must never become a
// second place that could accidentally participate in real
// classification. If anomalyClassification.js's own patterns change, this
// diagnostic staying slightly stale is the correct failure mode (it only
// ever produces a WARNING for a human to look at, never a decision).
const NON_COLLISION_HINT_PATTERN = /誤闖|闖入|侵入|穿越|逗留|遊蕩|游蕩|牲畜|淹水|積水|涵洞|河川暴漲|溪水暴漲|落石|坍方|路基流失|樹倒|電線掉落|電線桿倒|掉落物|貨物散落|火災|橋梁封閉|橋梁異常|道路中斷/;

function kmChanged(trace) {
  const rawStart = trace.upstream && trace.upstream.rawStartKM;
  const rawEnd = trace.upstream && trace.upstream.rawEndKM;
  const normStart = trace.normalized && trace.normalized.startKM;
  const normEnd = trace.normalized && trace.normalized.endKM;
  if (rawStart === null || rawStart === undefined) return null;
  if (String(rawStart) === String(normStart) && String(rawEnd ?? '') === String(normEnd ?? '')) return null;
  return {
    severity: 'warning',
    code: 'KM_CHANGED',
    message: `上游 KM「${rawStart}${rawEnd ? ' - ' + rawEnd : ''}」與系統 KM「${normStart ?? '無'}${normEnd ? ' - ' + normEnd : ''}」不同`,
  };
}

function mapMissing(trace) {
  const resolution = trace.enrichment && trace.enrichment.kmLocationResolution;
  const output = trace.delivery && trace.delivery.formattedOutput;
  if (!resolution || !resolution.resolved) return null;
  if (!output) return null; // never sent — nothing to check the text of
  if (output.includes('maps.google.com')) return null;
  return {
    severity: 'error',
    code: 'MAP_MISSING',
    message: 'KM 已解析但地圖網址未進最終訊息',
  };
}

function imageExpectedButMissing(trace) {
  const enrichment = trace.enrichment || {};
  const delivery = trace.delivery || {};
  if (!enrichment.cctvEligible) return null;
  if (!enrichment.imagePrepared) return null;
  if (delivery.lineSucceeded > 0 && !enrichment.imageUrlPresent) {
    return {
      severity: 'error',
      code: 'IMAGE_EXPECTED_BUT_MISSING',
      message: 'CCTV 已合成圖片，但 LINE 訊息未附圖',
    };
  }
  return null;
}

function lineFailedAnomaly(trace) {
  if (trace.status === 'line-failed') {
    return { severity: 'error', code: 'LINE_FAILED', message: 'LINE 推播嘗試但全部失敗' };
  }
  return null;
}

function sharedFeedImageLost(trace) {
  const enrichment = trace.enrichment || {};
  const delivery = trace.delivery || {};
  if (!enrichment.imageUrlPresent) return null; // LINE itself never got an image — nothing to lose
  if (delivery.sharedFeedPersisted && delivery.sharedFeedWithImage === false) {
    return {
      severity: 'error',
      code: 'SHARED_FEED_IMAGE_LOST',
      message: '圖片在 LINE → Shared Feed 階段遺失',
    };
  }
  return null;
}

const ANOMALY_CHECKS = [
  directionChanged,
  typeSemanticMismatch,
  kmChanged,
  mapMissing,
  imageExpectedButMissing,
  lineFailedAnomaly,
  sharedFeedImageLost,
];

/**
 * Pure — {severity, code, message}[] for one trace record. Display-only,
 * never called from anywhere on the real pipeline (only from the admin
 * JSON/HTML read handlers below, and from tests).
 */
export function buildTraceAnomalies(trace) {
  if (!trace || typeof trace !== 'object') return [];
  const anomalies = [];
  for (const check of ANOMALY_CHECKS) {
    const result = check(trace);
    if (result) anomalies.push(result);
  }
  return anomalies;
}

/**
 * GET /admin/pipeline-trace (Admin-Basic-Auth-gated and method-restricted
 * at the route level — see index.js). Zero TDX/PBS/CCTV/LINE calls — pure
 * KV read via listPipelineTrace. `?limit=` (default 30, max 100),
 * `?source=`/`?road=`/`?rawId=`/`?status=` optional filters.
 */
export async function handlePipelineTrace(env, request) {
  const url = new URL(request.url);
  const { records, kvAvailable, error } = await listPipelineTrace(env.TRAFFIC_KV, {
    limit: url.searchParams.get('limit'),
    source: url.searchParams.get('source') || undefined,
    road: url.searchParams.get('road') || undefined,
    rawId: url.searchParams.get('rawId') || undefined,
    status: url.searchParams.get('status') || undefined,
  });

  return Response.json(
    { kvAvailable, count: records.length, records, ...(error ? { error } : {}) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
