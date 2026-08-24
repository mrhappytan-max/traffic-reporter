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

export const TRACE_KEY_PREFIX = 'debug:pipeline-trace:v1';
export const TRACE_TTL_SECONDS = 24 * 60 * 60; // 24h, per instruction
const DESCRIPTION_SUMMARY_MAX_CHARS = 120; // per instruction — Description 只存摘要，最多 120 字
const UPSTREAM_FIELD_MAX_CHARS = 80; // same cap already used by provenance's classificationSource/locationSource values
export const DEFAULT_LIST_LIMIT = 30;
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
  kmLocationResolution = null,
  cctvEligible = null, // boolean | null
  cctvSkippedByReason = null, // string | null
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

function computeStatus({
  dedupeResult,
  gatingResult,
  eligibility,
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
export async function recordPipelineTrace(kv, entry, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const date = taipeiDateString(now);
    const key = `${TRACE_KEY_PREFIX}:${date}:${now.getTime()}:${opaqueId()}`;
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
  for (const entry of Array.isArray(entries) ? entries : []) {
    const result = await recordPipelineTrace(kv, entry, now);
    if (result.committed) committed += 1;
    else failed += 1;
  }
  return { attempted: (entries || []).length, committed, failed };
}

/**
 * Admin-only read. Bounded KV list+get, newest first, optional
 * source/road/rawId/status filters — never touches TDX/PBS/CCTV/LINE,
 * pure KV reads only. Never throws — a KV outage degrades to an empty
 * list with `kvAvailable:false`, same fail-safe shape as
 * broadcastProvenance.js's listBroadcastProvenance.
 */
export async function listPipelineTrace(kv, { limit = DEFAULT_LIST_LIMIT, source, road, rawId, status } = {}) {
  const boundedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || DEFAULT_LIST_LIMIT));
  if (!kv) return { records: [], kvAvailable: false };

  try {
    const keys = [];
    let cursor;
    let pages = 0;
    for (;;) {
      const page = await kv.list({ prefix: `${TRACE_KEY_PREFIX}:`, cursor });
      for (const k of page.keys || []) keys.push(k.name);
      pages += 1;
      // V1.8.7.3 — deliberately NOT `keys.length >= MAX_ENTRIES_SCANNED`
      // here: that condition used to cut key-enumeration off after just
      // one list() page on any day with real trace volume above a single
      // page, which silently stranded the scan on the OLDEST slice of the
      // 24h key range and made both the unfiltered view and every
      // filtered query miss genuinely-matching newest records (see
      // MAX_LIST_PAGES's comment above for the full write-up). Enumeration
      // now always continues until the true end of the range
      // (list_complete/no cursor) or the much more generous MAX_LIST_PAGES
      // safety ceiling — MAX_ENTRIES_SCANNED is applied only below, to the
      // now-correctly-identified newest keys.
      if (page.list_complete || !page.cursor || pages >= MAX_LIST_PAGES) break;
      cursor = page.cursor;
    }

    // Keys embed <date>:<epochMs>:<opaqueId> — lexicographic order already
    // matches chronological order (same construction as
    // broadcastProvenance.js's own keys), so list() returns oldest-first;
    // take the most recent slice, then reverse for newest-first display.
    const newestFirstKeys = keys.slice(-MAX_ENTRIES_SCANNED).reverse();

    const records = [];
    for (const key of newestFirstKeys) {
      if (records.length >= boundedLimit) break;
      const raw = await kv.get(key);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue; // corrupt entry — skip it, never let one bad record break the listing
      }
      if (!record || typeof record !== 'object') continue;
      if (source && record.identity?.source !== source) continue;
      if (road && record.identity?.road !== road) continue;
      if (rawId && record.identity?.rawId !== rawId) continue;
      if (status && record.status !== status) continue;
      records.push(record);
    }

    return { records, kvAvailable: true };
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
