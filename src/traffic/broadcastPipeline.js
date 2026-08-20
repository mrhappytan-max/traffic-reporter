// Ties together: 60-minute relevance, quiet hours, subscriptions (with
// per-target enabledAt backfill guard), and PER-TARGET notified-state to
// decide what actually gets pushed to LINE this Cron run, and to whom.
//
// Two modes, matching the dedupe.js preview/commit split:
//   - dryRun=true (GET /debug/status): computes every stat but never
//     calls the LINE API, never calls persistNotifiedState, and never
//     persists a subscriptions migration. Read-only by construction.
//   - dryRun=false (the Cron scheduled handler): does the real push,
//     per target, and updates notified-state only for targets that were
//     actually, successfully delivered to.
//
// Fail-closed: a missing token, unavailable subscriptions, or unavailable
// notified-state all result in 0 pushes for every target, never a guess.
//
// V1.8.5: type==='accident' events additionally get a best-effort CCTV
// collage image attached (see cctv/dynamicCollage.js) — composed/
// published at most once per event, sent in the SAME LINE API request as
// the text (never a second call). CCTV enrichment is BOUNDED, not
// blocking-forever: it runs under a hard time budget
// (CCTV_PREPARE_BUDGET_MS, ~4s) applied to the WHOLE RUN's CCTV
// enrichment, not freshly per event — this loop is sequential, so N
// eligible accidents each getting their own fresh ~4s would let CCTV
// delay accumulate to N*4s before the last event's text is even
// considered; one shared deadline computed once before the loop (see
// cctvRunDeadlineAt below) is what actually bounds the whole tick. Any
// failure OR timeout at any stage falls back to the exact text-only push
// this pipeline always did, this SAME tick — never waits for the next
// Cron run. See the per-event loop below for the integration point and
// dynamicCollage.js's module comment for the full fail-closed rationale
// (including the three Production blockers — unbounded delay, unbounded
// TDX usage, and per-event budget accumulation — this correction fixed).
//
// V1.8.6.4: every event that actually gets pushed to >=1 target also gets
// a best-effort "broadcast provenance" debug record written (see
// broadcastProvenance.js) — a short-TTL, Admin-only KV log answering "why
// did that LINE message look like that" without ever needing to re-query
// TDX/PBS. Written strictly AFTER the real push/notified-state write
// below, from data already in scope; the write is fully isolated (never
// throws) and never runs for an eligible-but-unsent/deduped/0-subscriber
// event. See that module's own comment for the full boundary list.
//
// V57.1: an event with 0 pending LINE targets (already notified, or
// incident-suppressed) is still eligible for a CCTV image FOR THE SHARED
// TRAFFIC FEED ONLY — see topUpSharedFeedCctvImages at the bottom of this
// file for the Production incident that motivated it. That pass runs
// strictly after every push and every notified-state write, has its own
// budget, reuses (never recomposes) a still-valid stored image, and
// changes nothing about what this Worker sends its own subscribers.

import { isWithinBroadcastHours } from './broadcastHours.js';
import { computeEffectiveWindow, classifyEventTimeStatus } from './effectiveWindow.js';
import { isBroadcastRelevant, getBroadcastEligibility } from './broadcastRules.js';
import { readSubscriptions, persistSubscriptions } from './subscriptions.js';
import {
  readNotifiedState,
  targetKey,
  targetNeedsNotification,
  targetNeedsCongestionNotification,
  applyNotifiedTargets,
  removePrunedEvents,
  persistNotifiedState,
  computeNotificationFingerprint,
} from './notified.js';
import { clusterCongestionEvents } from './congestionCluster.js';
import { formatEventMessage, resolveOtherAnomalyDetail } from './messageFormat.js';
import { resolveKmLocation } from './kmLocationResolver.js';
import { pushLineMessages } from '../line/pushMessage.js';
import {
  readIncidentSuppressionState,
  resolveIncidentNotifications,
  persistIncidentSuppressionState,
} from './incidentSuppression.js';
import { resolveCctvEligibility, prepareCctvImageForEvent, CCTV_PREPARE_BUDGET_MS } from '../cctv/dynamicCollage.js';
import { PUBLISHED_IMAGE_TTL_SECONDS } from '../cctv/publishedImage.js';
import { buildProvenanceRecord, recordBroadcastProvenance } from './broadcastProvenance.js';
import { readSharedFeed, eventIdOf, fingerprintOf, isStoredImageStillValid } from './sharedFeed.js';
import { buildTraceEntry } from './pipelineTrace.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

function eventKeyOf(event) {
  return `${event.source}:${event.rawId}`;
}

/**
 * "When was this event's CURRENT content first established?" — reused
 * from dedupe.js's own bookkeeping (lastSeenAt is only rewritten on
 * new/updated/reappear-from-absence; a steady-state duplicate keeps its
 * original value) rather than tracking a second, separate timestamp.
 * Falls back to `now` for anything unexpectedly missing, which favors
 * DELIVERING (not silently suppressing) content whose history we can't
 * account for.
 */
function effectiveContentSince(event, { newUpdatedKeys, dedupeMapSnapshot, now }) {
  const key = eventKeyOf(event);
  if (newUpdatedKeys.has(key)) return now;
  const existing = dedupeMapSnapshot ? dedupeMapSnapshot[key] : undefined;
  if (existing && existing.missingSince) return now; // reappeared this run
  if (existing && existing.lastSeenAt) return new Date(existing.lastSeenAt);
  return now;
}

/**
 * Same idea as effectiveContentSince, but for a congestion cluster
 * candidate: computed from the LIFECYCLE of its original member events
 * (never the synthetic candidate itself, which didn't exist before this
 * run), and conservatively takes the EARLIEST content-since among them.
 * This means: if even one member of "the same traffic jam" predates a
 * new subscriber's enabledAt, the whole cluster is treated as at least
 * that old — so KM churn on the other members can never make an
 * otherwise-old jam look like fresh content for the enabledAt backfill
 * guard (see runLineBroadcast below). Never resets just because the
 * union range grew/shrank on a later tick.
 */
function clusterContentSince(members, { newUpdatedKeys, dedupeMapSnapshot, now }) {
  const perMember = members.map((member) => effectiveContentSince(member, { newUpdatedKeys, dedupeMapSnapshot, now }));
  return perMember.reduce((earliest, d) => (d.getTime() < earliest.getTime() ? d : earliest), perMember[0] || now);
}

/**
 * @param {object} env
 * @param {object} options
 * @param {object[]} options.allEvents - every currently Hsinchu-relevant,
 *   noise-filtered event this run.
 * @param {boolean} options.dedupeAvailable - pipeline.js's kvAvailable.
 * @param {Set<string>} [options.newUpdatedKeys] - eventKeys classified as
 *   new/updated THIS run (for the enabledAt guard).
 * @param {object} [options.dedupeMapSnapshot] - dedupe-state as read at
 *   the start of this run (for the enabledAt guard).
 * @param {string[]} [options.prunedKeys] - eventKeys dedupe.js just
 *   pruned this run; their notified-state entries are removed too.
 * @param {Date} [options.now]
 * @param {boolean} [options.dryRun]
 * @param {{decodeJpeg,encodeJpeg}} [options.cctvCodecOverride] - TEST-ONLY,
 *   threaded through to cctv/dynamicCollage.js's prepareCctvImageForEvent
 *   (see that module's doc comment) so a test can exercise a genuinely
 *   successful CCTV compose without hitting the real Workers-only `.wasm`
 *   import, which plain Node cannot load. Production (scheduled.js) never
 *   passes this.
 * @param {number} [options.cctvPrepareBudgetMs] - TEST-ONLY override of
 *   dynamicCollage.js's CCTV_PREPARE_BUDGET_MS. Represents the budget
 *   for THIS WHOLE RUN's CCTV enrichment (not per-event — see
 *   dynamicCollage.js's CCTV_PREPARE_BUDGET_MS comment for why that
 *   distinction matters), so a test can exercise the run-level timeout
 *   path in milliseconds instead of really waiting ~4s. Production
 *   never passes this (defaults to the real CCTV_PREPARE_BUDGET_MS).
 */
export async function runLineBroadcast(
  env,
  {
    allEvents,
    dedupeAvailable,
    newUpdatedKeys = new Set(),
    dedupeMapSnapshot = {},
    prunedKeys = [],
    now = new Date(),
    dryRun = false,
    cctvCodecOverride,
    cctvPrepareBudgetMs,
    // V1.8.6.7 (Pipeline Trace) — Map<`${source}:${rawId}`, {dedupeResult,
    // gatingResult}>, built by scheduled.js from data dedupe.js/
    // crossSourceDedup.js ALREADY decided this run (new/updated TDX
    // events, canonical-merge/unique-candidate PBS events) — never
    // re-derived here. Optional; defaults to empty so every existing
    // caller/test that doesn't pass it keeps working unchanged (trace
    // entries simply carry dedupeResult/gatingResult:null in that case).
    eventMeta = new Map(),
  }
) {
  const result = {
    withinBroadcastHours: isWithinBroadcastHours(now),
    lineReady: false,
    enabledUsersCount: 0,
    enabledGroupsCount: 0,
    subscriptionsCount: 0,
    notifiedEventCount: 0,
    // V1.5: how many of this run's events were excluded by the type/
    // keyword eligibility gate (see broadcastRules.js's
    // getBroadcastEligibility) before relevance/pending-target
    // computation even started, broken down by WHY (ineligibleByReason
    // keys: congestion-excluded, alert-excluded,
    // construction-no-impact-keyword, other-no-anomaly-keyword,
    // unrecognized-type). Purely observational — GET /debug/status
    // surfaces both so every excluded event's data collection stays
    // fully visible and its exclusion reason is verifiable.
    typeIneligibleCount: 0,
    ineligibleByReason: {},
    // V1.5.1: accident-specific incident-level suppression stats — see
    // incidentSuppression.js. incidentSuppressedCount/ByReason count
    // accident events this run that matched an already-notified, real-
    // world incident with no material change (never pushed);
    // materialRebroadcastCount counts ones that matched an existing
    // incident but were allowed through because something actually
    // changed (escalation to closure/control, more lanes blocked, a new
    // closure/impassable signal). Purely observational.
    incidentSuppressedCount: 0,
    incidentSuppressedByReason: {},
    materialRebroadcastCount: 0,
    // V1.8.5 — dynamic per-accident CCTV image enrichment (see
    // cctv/dynamicCollage.js). cctvEligibleAccidentCount is a PURE,
    // zero-I/O count (resolveCctvEligibility never touches TDX/KV/R2) —
    // computed and populated even under dryRun, per instruction
    // ("dryRun 可以新增純統計欄位"). cctvImagesAttachedCount/
    // cctvSkippedByReason are the REAL outcome and are only ever
    // populated on the actual (non-dryRun) push path below, since they
    // require actually attempting the CCTV pipeline.
    cctvEligibleAccidentCount: 0,
    cctvImagesAttachedCount: 0,
    cctvSkippedByReason: {},
    // V57.1 — the Shared-Feed-only CCTV top-up pass (see
    // topUpSharedFeedCctvImages below). Deliberately SEPARATE counters
    // from cctvImagesAttachedCount/cctvSkippedByReason above, which
    // remain exactly what they always were: "what the real LINE push
    // path did". Nothing counted here was ever pushed to LINE.
    //   Attempted — CCTV pipeline actually invoked for the feed's sake
    //   Attached  — that invocation produced a URL
    //   Reused    — a still-valid stored image was carried forward with
    //               ZERO frame fetches / compose / R2 publish
    cctvFeedOnlyAttemptedCount: 0,
    cctvFeedOnlyAttachedCount: 0,
    cctvFeedOnlyReusedCount: 0,
    cctvFeedOnlySkippedByReason: {},
    // V57 — the finished products of THIS run, in broadcast order: exactly
    // the events that survived every gate this pipeline applies (type
    // eligibility, 60-minute relevance, congestion clustering, incident
    // suppression) together with the exact `text` this Worker would send
    // and, when one was actually composed for the real push below, that
    // event's CCTV image URL and expiry.
    //
    // Populated regardless of whether any target still needed notifying,
    // because a consumer of the Shared Traffic Feed has its OWN audience
    // and its own delivery state — "everyone here already knows" must not
    // mean "nobody else may ever learn". Building the text costs nothing
    // (formatEventMessage is pure); the CCTV image is NEVER composed for
    // this list's sake — it is only ever recorded when the real broadcast
    // path composed one anyway, so the feed adds ZERO CCTV work.
    //
    // Empty under dryRun, fail-closed, and outside broadcast hours — all
    // three are states in which this Worker itself produces nothing.
    completedProducts: [],
    broadcastRelevantCount: 0,
    activeNowCount: 0,
    futureWithin60MinCount: 0,
    pendingTargetCount: 0,
    pushAttempted: 0,
    pushSucceeded: 0,
    partialPushFailures: 0,
    lastLinePushAt: null,
    lineErrors: [],
    // V1.8.6.7 (Pipeline Trace) — built below, one entry per event in
    // `allEvents` (see traceInputByEvent). Populated even under dryRun/
    // fail-closed (same "purely observational, safe under every mode"
    // principle as ineligibleByReason/cctvEligibleAccidentCount above) —
    // scheduled.js is the only caller that actually persists these to KV,
    // and only on the real (non-dryRun) Cron path.
    pipelineTraceEntries: [],
  };

  // V1.8.6.7 (Pipeline Trace) — accumulates PARTIAL trace input per event
  // (object identity keyed, same idiom as eligibilityReasonByEvent below)
  // as this event's lifecycle progresses through the stages below; built
  // into final immutable trace entries in ONE pass at the very end of this
  // function (see the bottom of this function, after
  // topUpSharedFeedCctvImages) — "在記憶體中累積，事件生命週期結束時
  // centralized finalize 一次寫入", never a per-stage KV write. An event
  // whose lifecycle ends early (ineligible, not-relevant) still gets its
  // entry finalized at the end from whatever partial data it accumulated.
  const traceInputByEvent = new Map();
  function traceFor(event) {
    let input = traceInputByEvent.get(event);
    if (!input) {
      const meta = eventMeta.get(`${event.source}:${event.rawId}`) || {};
      // V1.8.6.8 — broadcastWindowActive is the SAME isWithinBroadcastHours(now)
      // result already computed once, above, for this whole run
      // (result.withinBroadcastHours) — never recomputed per event, and
      // set here (at first-touch) so every trace entry carries it
      // regardless of which stage first creates its input.
      input = {
        event,
        now,
        dedupeResult: meta.dedupeResult ?? null,
        gatingResult: meta.gatingResult ?? null,
        broadcastWindowActive: result.withinBroadcastHours,
      };
      traceInputByEvent.set(event, input);
    }
    return input;
  }

  const hasToken = Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!hasToken) result.lineErrors.push('LINE_CHANNEL_ACCESS_TOKEN not configured');
  if (!dedupeAvailable) result.lineErrors.push('dedupe/baseline state unavailable this run');

  const subsState = await readSubscriptions(env.TRAFFIC_KV, now);
  if (!subsState.kvAvailable) result.lineErrors.push(`subscriptions unavailable: ${subsState.kvError}`);

  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  if (!notifiedState.kvAvailable) result.lineErrors.push(`notified state unavailable: ${notifiedState.kvError}`);

  result.lastLinePushAt = notifiedState.lastLinePushAt || null;
  result.notifiedEventCount = Object.keys(notifiedState.notifiedMap || {}).length;
  result.partialPushFailures = notifiedState.lastPartialPushFailureCount || 0;

  // One-time legacy-format migration (bare `true` -> {enabled, enabledAt})
  // — only the real Cron path persists it; /debug/status stays read-only.
  if (!dryRun && subsState.kvAvailable && subsState.migrationNeeded) {
    await persistSubscriptions(env.TRAFFIC_KV, subsState.subscriptions);
  }

  const enabledUsers = Object.entries(subsState.subscriptions.users || {}).filter(([, e]) => e.enabled);
  const enabledGroups = Object.entries(subsState.subscriptions.groups || {}).filter(([, e]) => e.enabled);
  result.enabledUsersCount = enabledUsers.length;
  result.enabledGroupsCount = enabledGroups.length;

  const targets = subsState.kvAvailable
    ? [
        ...enabledUsers.map(([id, e]) => ({ kind: 'user', id, enabledAt: e.enabledAt })),
        ...enabledGroups.map(([id, e]) => ({ kind: 'group', id, enabledAt: e.enabledAt })),
      ]
    : [];
  result.subscriptionsCount = targets.length;

  // V1.5: whitelist/conditional eligibility gate FIRST — before
  // clustering, before relevance, before anything else (see
  // broadcastRules.js's getBroadcastEligibility for the actual rule:
  // accident/closure/control always eligible; construction/other only
  // with a matching impact/anomaly keyword; congestion/alert never).
  // This is a pure gate at the very entrance of the broadcast pipeline;
  // it does not touch TDX/PBS's own fetch/normalize/classify/VD-validate
  // stages at all (those already completed by the time `allEvents` gets
  // here — see scheduled.js/debugStatus.js), so every excluded event's
  // data collection and GET /debug/status visibility are unaffected.
  const broadcastEligibleEvents = [];
  const ineligibleByReason = {};
  // V1.8.6.4 — captured once, here, at the single existing
  // getBroadcastEligibility() call site — never re-invoked later just to
  // label a provenance record (that would be a second, possibly-drifting
  // copy of the same decision). Keyed by object identity: every event
  // reference below (perEventPending, the push loop) is this SAME object,
  // never a clone, all the way from allEvents.
  const eligibilityReasonByEvent = new Map();
  for (const event of allEvents) {
    const { eligible, reason } = getBroadcastEligibility(event);
    eligibilityReasonByEvent.set(event, reason);
    // V1.8.6.7 (Pipeline Trace) — every event in allEvents gets a trace
    // input record right here, regardless of outcome; an ineligible
    // event's lifecycle effectively ends at this exact point (it never
    // reaches clustering/relevance/suppression below), so this is also
    // the last chance to record it.
    const trace = traceFor(event);
    trace.eligibility = eligible;
    trace.eligibilityReason = reason;
    if (eligible) {
      broadcastEligibleEvents.push(event);
    } else {
      ineligibleByReason[reason] = (ineligibleByReason[reason] || 0) + 1;
    }
  }
  result.typeIneligibleCount = allEvents.length - broadcastEligibleEvents.length;
  result.ineligibleByReason = ineligibleByReason;

  // V1.2C: cluster same-run congestion events into candidates BEFORE
  // computing relevance/pending targets at all, so N overlapping
  // congestion rows this Cron tick become exactly one candidate — never
  // N separate pending-target computations. This is what stops "5
  // overlapping congestion rows this tick -> 5 pushes this run" — see
  // congestionCluster.js and the "同一 Cron 不准洗版" requirement.
  // Non-congestion events (accident/construction/closure/control/alert/
  // other) pass through completely untouched. (Since congestion is now
  // filtered out above, this will always yield congestionClusters:[] in
  // practice — left in place unchanged rather than removed, so a future
  // round can re-admit a congestion subtype here without restructuring
  // this pipeline.)
  const { nonCongestionEvents, congestionClusters } = clusterCongestionEvents(broadcastEligibleEvents);

  const withWindow = [
    ...nonCongestionEvents.map((event) => ({ event, window: computeEffectiveWindow(event, now), cluster: null })),
    ...congestionClusters.map((cluster) => ({
      event: cluster.candidate,
      window: computeEffectiveWindow(cluster.candidate, now),
      cluster,
    })),
  ];
  const relevant = withWindow.filter(({ window }) => isBroadcastRelevant(window, now));
  result.broadcastRelevantCount = relevant.length;
  result.activeNowCount = relevant.filter(({ window }) => new Date(window.effectiveStart).getTime() <= now.getTime()).length;
  result.futureWithin60MinCount = result.broadcastRelevantCount - result.activeNowCount;

  // V1.8.6.7 (Pipeline Trace) — an eligible event that isn't relevant yet
  // (or isn't relevant anymore — e.g. effectiveWindow fail-closed to
  // null) also has its lifecycle end right here; every relevant one gets
  // `relevant:true` for now (an accident that gets suppressed below still
  // reads relevant:true — suppression is a separate, later decision).
  //
  // V1.8.6.8 — eventTimeStatus/eventWindow are recorded from the EXACT
  // same `window` isBroadcastRelevant(window, now) itself just evaluated
  // (classifyEventTimeStatus is the shared classifier isBroadcastRelevant
  // is built on — see effectiveWindow.js) — never a second, independent
  // window computation. This is what lets Pipeline Trace distinguish
  // "尚未開始"/"事件已結束"/"事件有效" instead of one generic
  // "尚未到播報時間" for every non-relevant reason (section 4 of this round).
  const relevantEventSet = new Set(relevant.map(({ event }) => event));
  for (const { event, window } of withWindow) {
    const trace = traceFor(event);
    trace.relevant = relevantEventSet.has(event);
    trace.eventTimeStatus = classifyEventTimeStatus(window, now);
    trace.eventWindow = window;
  }

  // V1.5.1: accident-specific incident-level suppression — see
  // incidentSuppression.js. Read regardless of dryRun (debug/status
  // needs it for its own preview stats — never writes below when
  // dryRun); decided here, independent of LINE readiness/broadcast
  // hours, same as dedupe.js's own state updates — "was this accident
  // seen again, and did it actually get worse" is a data-layer fact,
  // not a LINE-availability-dependent one.
  const incidentState = await readIncidentSuppressionState(env.TRAFFIC_KV);
  if (!incidentState.kvAvailable) result.lineErrors.push(`incident suppression state unavailable: ${incidentState.kvError}`);

  const accidentRelevant = relevant.filter(({ event, cluster }) => !cluster && event.type === 'accident');
  const otherRelevant = relevant.filter(({ event, cluster }) => cluster || event.type !== 'accident');

  // Pure, zero-I/O — safe (and populated) under dryRun too; see the
  // cctvEligibleAccidentCount field comment above.
  result.cctvEligibleAccidentCount = accidentRelevant.filter(({ event }) => resolveCctvEligibility(event).eligible).length;

  const { results: incidentResults, nextIncidentsByGroup } = resolveIncidentNotifications(
    accidentRelevant.map(({ event }) => event),
    incidentState.incidentsByGroup,
    now
  );
  const incidentResolutionByEvent = new Map(incidentResults.map((r) => [r.event, r]));

  // V1.8.6.7 (Pipeline Trace) — suppressionResult only ever applies to
  // accident-typed events (see incidentSuppression.js's own scope); every
  // other event's trace input keeps suppressionResult:null.
  for (const r of incidentResults) {
    traceFor(r.event).suppressionResult = r.reason;
  }

  for (const r of incidentResults) {
    if (r.suppressed) {
      result.incidentSuppressedCount += 1;
      result.incidentSuppressedByReason[r.reason] = (result.incidentSuppressedByReason[r.reason] || 0) + 1;
    } else if (r.reason === 'material-escalation') {
      result.materialRebroadcastCount += 1;
    }
  }

  if (!dryRun && incidentState.kvAvailable) {
    const commit = await persistIncidentSuppressionState(env.TRAFFIC_KV, nextIncidentsByGroup, now);
    if (!commit.committed) result.lineErrors.push(`failed to persist incident suppression state: ${commit.error}`);
  }

  // V1.8.6.7 (Pipeline Trace) — the ONE finalize/build point, called
  // right before every return in this function. Builds immutable trace
  // entries from whatever partial input each event accumulated by this
  // point in its lifecycle — never a per-stage write (see
  // traceInputByEvent's own comment above).
  function finalizeTrace() {
    result.pipelineTraceEntries = [...traceInputByEvent.values()].map((input) => buildTraceEntry(input));
  }

  const failClosed = !hasToken || !dedupeAvailable || !subsState.kvAvailable || !notifiedState.kvAvailable;
  result.lineReady = !failClosed;
  if (failClosed) {
    finalizeTrace();
    return result; // 0 push for every target, whether dry-run or real
  }

  // Per (event, target) pending list. A congestion cluster uses a
  // corridor-scoped notification key ("congestion:<road>:<direction>:
  // <corridor>") plus a time-based cooldown
  // (targetNeedsCongestionNotification, see notified.js) instead of the
  // fingerprint-based check every other event type uses below — the
  // whole point of clustering is that a congestion cluster's KM range is
  // *expected* to shift every ~5 minutes without that being new
  // information for a driver. construction/closure/control/alert/other
  // keep the original fingerprint-based, no-cooldown logic (now using
  // computeNotificationFingerprint — see notified.js — instead of
  // dedupe.js's description-including computeFingerprint). accident gets
  // its own incident-level suppression layer below (V1.5.1) — see
  // incidentResolutionByEvent, computed above.
  const perEventPending = [
    ...otherRelevant.map(({ event, window, cluster }) => {
      if (cluster) {
        const eventKeyStr = cluster.notificationKey;
        // Stored for record-keeping/debugging only — targetNeedsCongestionNotification
        // never reads it, so it can never gate whether a congestion cluster gets pushed.
        const fingerprint = computeNotificationFingerprint(event);
        const contentSince = clusterContentSince(cluster.members, { newUpdatedKeys, dedupeMapSnapshot, now });

        const pendingTargets = targets.filter((target) => {
          if (!targetNeedsCongestionNotification(eventKeyStr, target, notifiedState.notifiedMap, now)) return false;
          if (target.enabledAt && contentSince.getTime() < new Date(target.enabledAt).getTime()) return false;
          return true;
        });

        return { event, window, eventKeyStr, fingerprint, pendingTargets };
      }

      const eventKeyStr = eventKeyOf(event);
      const fingerprint = computeNotificationFingerprint(event);
      const contentSince = effectiveContentSince(event, { newUpdatedKeys, dedupeMapSnapshot, now });

      const pendingTargets = targets.filter((target) => {
        if (!targetNeedsNotification(eventKeyStr, target, fingerprint, notifiedState.notifiedMap)) return false;
        // Backfill guard: this exact content predates the target's
        // subscription and hasn't changed since -> don't send it.
        if (target.enabledAt && contentSince.getTime() < new Date(target.enabledAt).getTime()) return false;
        return true;
      });

      return { event, window, eventKeyStr, fingerprint, pendingTargets };
    }),
    ...accidentRelevant.map(({ event, window }) => {
      const resolution = incidentResolutionByEvent.get(event);
      // Should always be found — every accidentRelevant event was fed
      // into resolveIncidentNotifications above. Fail toward the
      // event's OWN key/not-suppressed if somehow missing, never toward
      // silently dropping a real accident.
      const eventKeyStr = resolution ? resolution.notificationKey : eventKeyOf(event);
      const fingerprint = computeNotificationFingerprint(event);

      if (resolution && resolution.suppressed) {
        // Same real incident, no material change since it was last
        // notified — 0 pending targets, no per-target check needed.
        return { event, window, eventKeyStr, fingerprint, pendingTargets: [] };
      }

      const contentSince = effectiveContentSince(event, { newUpdatedKeys, dedupeMapSnapshot, now });
      const pendingTargets = targets.filter((target) => {
        if (!targetNeedsNotification(eventKeyStr, target, fingerprint, notifiedState.notifiedMap)) return false;
        if (target.enabledAt && contentSince.getTime() < new Date(target.enabledAt).getTime()) return false;
        return true;
      });

      return { event, window, eventKeyStr, fingerprint, pendingTargets };
    }),
  ];

  result.pendingTargetCount = perEventPending.reduce((sum, e) => sum + e.pendingTargets.length, 0);

  if (dryRun) {
    finalizeTrace();
    return result; // preview stops here — no push, no writes
  }

  // Prune notified-state entries dedupe.js just retired, in-memory; this
  // rides along with whatever write happens below (or gets its own small
  // write at the end if nothing else writes this run).
  let notifiedMap = removePrunedEvents(notifiedState.notifiedMap, prunedKeys);
  let anyWriteHappened = false;
  let partialFailureCountThisRun = 0;

  if (!result.withinBroadcastHours) {
    // Cron still ran fetch/normalize/baseline/dedupe — just no push. Still
    // flush a pending prune-only cleanup if there is one.
    if (prunedKeys.length > 0) {
      const commit = await persistNotifiedState(env.TRAFFIC_KV, notifiedMap, result.lastLinePushAt, now, result.partialPushFailures);
      if (!commit.committed) result.lineErrors.push(`failed to record notified-state prune cleanup: ${commit.error}`);
    }
    finalizeTrace();
    return result;
  }

  // V1.8.5 — shared, per-Cron-run CCTV metadata cache/in-flight-promise
  // memo (see cctv/dynamicCollage.js's getFreewayCctvMetadata doc
  // comment): created ONCE here, threaded into every accident's
  // prepareCctvImageForEvent call below, so N accidents this tick share
  // at most 1 metadata KV read — never N.
  const cctvRunCache = {};

  // CORRECTION (post-review): CCTV_PREPARE_BUDGET_MS is a PER-CALL
  // budget on prepareCctvImageForEvent, not an automatic whole-run
  // guarantee — this loop is SEQUENTIAL (one event's push loop finishes
  // before the next event's CCTV prep even starts), so naively passing
  // every event the same fresh ~4s would let N eligible accidents in one
  // tick accumulate up to N*4s of possible delay before the LAST event's
  // text even gets considered. Fixed here: ONE deadline for the WHOLE
  // run's CCTV enrichment, computed once, before the loop starts; each
  // event below gets only whatever's LEFT of it (see the loop body).
  // Never recomputed/reset per event.
  const cctvRunDeadlineAt = Date.now() + (cctvPrepareBudgetMs ?? CCTV_PREPARE_BUDGET_MS);

  // V57.1 — products this run finished but had NO pending LINE target for
  // (already notified, or incident-suppressed). Collected here and handled
  // AFTER the push loop by topUpSharedFeedCctvImages, never inside it — see
  // that function's comment for why the ordering is the whole point.
  const feedOnlyProducts = [];

  for (const { event, window, eventKeyStr, fingerprint, pendingTargets } of perEventPending) {
    const startMs = new Date(window.effectiveStart).getTime();
    const forecast = startMs > now.getTime();
    const minutesUntilStart = forecast ? Math.max(1, Math.round((startMs - now.getTime()) / 60000)) : null;
    const text = formatEventMessage(event, { forecast, minutesUntilStart });

    // V57: record the finished product BEFORE the pending-target
    // short-circuit below. formatEventMessage is pure and was already
    // being called at exactly this point for every event that did have
    // pending targets, so this reorder changes nothing about what gets
    // pushed — it only stops an event from being invisible to the Shared
    // Traffic Feed just because this Worker's own subscribers happen to
    // have been notified already.
    const completedProduct = { eventKeyStr, fingerprint, text, event, imageUrl: null, imageExpiresAt: null };
    result.completedProducts.push(completedProduct);

    // V1.8.6.7 (Pipeline Trace) — formattedOutput is recorded for EVERY
    // event that reaches this point, whether or not it ends up with a
    // pending target — same reasoning as `completedProduct` itself above
    // (a Shared-Feed-only consumer's audience is independent of whether
    // THIS Worker's own subscribers already got it).
    traceFor(event).formattedOutput = text;

    if (pendingTargets.length === 0) {
      const trace = traceFor(event);
      trace.lineAttempted = 0;
      trace.lineSucceeded = 0;
      // Pure, zero-I/O — safe to compute here even though the real CCTV
      // attempt (if any) only happens later, in topUpSharedFeedCctvImages
      // (see that function's own comment for why the ordering matters).
      // imagePrepared/imageUrlPresent/imageExpiresAt are patched onto this
      // SAME trace input object right after that pass runs, below.
      if (event.type === 'accident') trace.cctvEligible = resolveCctvEligibility(event).eligible;
      // V57.1: still a candidate for a CCTV image — for the Shared Traffic
      // Feed ONLY, never for a LINE re-push. Deferred to after this loop so
      // it can never take budget (or wall-clock) away from an event that
      // does have a real push to make. See topUpSharedFeedCctvImages.
      feedOnlyProducts.push(completedProduct);
      continue;
    }

    // V1.8.5 — CCTV image enrichment: composed/published AT MOST ONCE
    // per event, BEFORE the per-target push loop, so every pending
    // target for this event shares the exact same imageUrl (never
    // re-composed/re-published per target). Only ever attempted for
    // type==='accident' — see dynamicCollage.js's resolveCctvEligibility
    // for the full fail-closed gate (freeway source, a road with a
    // Production-confirmed CCTV mapping, a reliable KM, a metadata cache
    // that's actually populated — this path is CACHE-ONLY and NEVER
    // calls TDX itself). ANY failure OR timeout at any stage (ineligible,
    // metadata cache unavailable, 0 cameras, all frame fetches failed,
    // encode/compose failure, R2 publish failure, or the WHOLE RUN's
    // cctvRunDeadlineAt already passed) simply means `messages` stays
    // text-only — this is never treated as a push failure, never touches
    // notified-state on its own. Bounded for the run as a whole, not
    // just per-event: once cctvRunDeadlineAt passes, every remaining
    // event in this tick skips CCTV entirely (0 wait, not even an
    // attempt) rather than each getting its own fresh budget.
    let messages = [{ type: 'text', text }];
    // V1.8.6.7 (Pipeline Trace) — tracks this event's CCTV outcome for the
    // trace entry below; never a second CCTV attempt, purely a local
    // reference to the SAME `cctv` result the real push path already
    // computed (or an explicit note when it wasn't even attempted).
    const traceForEvent = traceFor(event);
    if (event.type === 'accident') {
      traceForEvent.cctvEligible = resolveCctvEligibility(event).eligible;
      const remainingRunBudgetMs = cctvRunDeadlineAt - Date.now();
      if (remainingRunBudgetMs <= 0) {
        result.cctvSkippedByReason['run-budget-exhausted'] = (result.cctvSkippedByReason['run-budget-exhausted'] || 0) + 1;
        traceForEvent.imagePrepared = false;
        traceForEvent.imageUrlPresent = false;
        traceForEvent.cctvSkippedByReason = 'run-budget-exhausted';
      } else {
        const cctv = await prepareCctvImageForEvent(env, event, cctvRunCache, cctvCodecOverride, remainingRunBudgetMs);
        if (cctv.ok) {
          result.cctvImagesAttachedCount += 1;
          messages = [{ type: 'text', text }, { type: 'image', originalContentUrl: cctv.imageUrl, previewImageUrl: cctv.imageUrl }];
          // V57: reuse — never re-compose — the image this push already has.
          completedProduct.imageUrl = cctv.imageUrl;
          completedProduct.imageExpiresAt = cctv.imageExpiresAt;
          traceForEvent.imagePrepared = true;
          traceForEvent.imageUrlPresent = true;
          traceForEvent.imageExpiresAt = cctv.imageExpiresAt;
        } else {
          result.cctvSkippedByReason[cctv.reason] = (result.cctvSkippedByReason[cctv.reason] || 0) + 1;
          traceForEvent.imagePrepared = false;
          traceForEvent.imageUrlPresent = false;
          traceForEvent.cctvSkippedByReason = cctv.reason;
        }
      }
    }

    // V1.8.6.7 (Pipeline Trace) / V1.8.6.5 pattern reused: computed ONCE
    // here, for EVERY event that reaches this point (not gated on push
    // success) — messageFormat.js already called resolveKmLocation() a
    // moment ago, for this SAME event, to build `text` above; this is the
    // same "call the pure, 0-I/O function again for a second consumer"
    // pattern already established (see resolveOtherAnomalyDetail below),
    // just no longer gated behind `successfulTargets.length > 0` so the
    // trace entry gets it even for an event that didn't end up pushed.
    const kmLocationResolution = resolveKmLocation({
      road: event.road,
      direction: event.direction,
      startKM: event.startKM,
      endKM: event.endKM,
      displayKM: event.displayKM,
    });
    traceForEvent.kmLocationResolution = kmLocationResolution;

    const successfulTargets = [];
    // Best-effort per target — one target's failure never blocks another.
    // Exactly ONE LINE API call per target, carrying `messages` as built
    // above (text-only, or text+image) — never a separate second call
    // for the image; see pushMessage.js's module comment for why a
    // text-then-image two-call sequence was rejected.
    for (const target of pendingTargets) {
      result.pushAttempted += 1;
      try {
        await pushLineMessages(env, target.id, messages);
        successfulTargets.push(target);
        result.pushSucceeded += 1;
      } catch (err) {
        result.lineErrors.push(`push failed (${target.kind}): ${safeErrorMessage(err)}`);
      }
    }
    traceForEvent.lineAttempted = pendingTargets.length;
    traceForEvent.lineSucceeded = successfulTargets.length;

    const failedCount = pendingTargets.length - successfulTargets.length;
    if (successfulTargets.length > 0 && failedCount > 0) {
      partialFailureCountThisRun += 1;
      result.lineErrors.push(
        `event ${eventKeyStr}: ${successfulTargets.length}/${pendingTargets.length} targets notified, ${failedCount} pending retry next run`
      );
    }

    if (successfulTargets.length > 0) {
      notifiedMap = applyNotifiedTargets(notifiedMap, eventKeyStr, fingerprint, successfulTargets, now);
      result.lastLinePushAt = now.toISOString();

      // Write immediately after each event with successful targets, not
      // batched for the whole run — bounds a KV write failure's blast
      // radius to THIS event's successful targets, not every event this
      // run. See module comment in notified.js.
      const commit = await persistNotifiedState(env.TRAFFIC_KV, notifiedMap, result.lastLinePushAt, now, partialFailureCountThisRun);
      anyWriteHappened = true;
      if (!commit.committed) {
        result.lineErrors.push(
          `HIGH RISK: event ${eventKeyStr} was pushed to ${successfulTargets.length} target(s) but notified-state write failed (${commit.error}) — those target(s) may be re-notified next run`
        );
      }

      // V1.8.6.4 — broadcast provenance (see broadcastProvenance.js's own
      // module comment for the full design). Written ONLY here, AFTER a
      // real push already succeeded to >=1 target — never for an eligible-
      // but-unsent, deduped, or 0-subscriber event. Reuses
      // eligibilityReasonByEvent (captured once, at the single existing
      // getBroadcastEligibility() call site above) and messageFormat.js's
      // own resolveOtherAnomalyDetail — never a second classification
      // pass. Fully isolated: recordBroadcastProvenance() never throws, so
      // this can never affect the push/notified-state outcome above,
      // which already completed by the time this runs.
      const anomalyDetail = event.type === 'other' ? resolveOtherAnomalyDetail(event) : null;
      // kmLocationResolution: hoisted above (V1.8.6.7) — computed once for
      // every event reaching this point, reused here unchanged from its
      // original V1.8.6.5 "call the pure function again for this
      // consumer" reasoning.
      const imageAttached = messages.length > 1;
      const record = buildProvenanceRecord({
        event,
        formattedOutput: text,
        eligibilityReason: eligibilityReasonByEvent.get(event) || null,
        anomalyDetail,
        kmLocationResolution,
        image: {
          attached: imageAttached,
          urlPresent: imageAttached,
          expiresAt: imageAttached ? new Date(now.getTime() + PUBLISHED_IMAGE_TTL_SECONDS * 1000).toISOString() : null,
        },
        now,
      });
      await recordBroadcastProvenance(env.TRAFFIC_KV, record, now);
    }
  }

  result.partialPushFailures = partialFailureCountThisRun;

  // V57.1 — every LINE push for this tick has now completed and every
  // notified-state write for it has been committed. Only now do we top up
  // the Shared Traffic Feed's images. Nothing below this line can push,
  // re-push, or delay a LINE message.
  await topUpSharedFeedCctvImages(env, result, feedOnlyProducts, {
    now,
    cctvRunCache,
    cctvCodecOverride,
    cctvPrepareBudgetMs,
  });

  // V1.8.6.7 (Pipeline Trace) — patch the trace input for every
  // feed-only product NOW that topUpSharedFeedCctvImages has run (it
  // mutates `completedProduct.imageUrl`/`imageExpiresAt` in place — see
  // that function's own comment). Never a second CCTV attempt: this only
  // reads the outcome the top-up pass already produced.
  for (const product of feedOnlyProducts) {
    const trace = traceFor(product.event);
    trace.imagePrepared = Boolean(product.imageUrl);
    trace.imageUrlPresent = Boolean(product.imageUrl);
    trace.imageExpiresAt = product.imageExpiresAt || null;
    if (product.cctvSkipReason) trace.cctvSkippedByReason = product.cctvSkipReason;
  }

  if (!anyWriteHappened && prunedKeys.length > 0) {
    const commit = await persistNotifiedState(env.TRAFFIC_KV, notifiedMap, result.lastLinePushAt, now, partialFailureCountThisRun);
    if (!commit.committed) result.lineErrors.push(`failed to record notified-state prune cleanup: ${commit.error}`);
  }

  finalizeTrace();
  return result;
}

// --- V57.1: Shared-Feed-only CCTV top-up ---------------------------------
//
// THE PRODUCTION BUG THIS FIXES (real incident, 2026-08-20 08:00–08:20
// Asia/Taipei, 國1 南向 88K+000 交通事故):
//
//   08:10 tick — not a TDX tick, so the accident was only known from PBS.
//                PBS-sourced accidents are structurally CCTV-ineligible
//                (dynamicCollage.js's 'not-freeway-source' gate). Pushed
//                text-only. Correct, and deliberately UNCHANGED here.
//   08:20 tick — the TDX `freeway` twin of the same accident arrived. It
//                WAS CCTV-eligible, the metadata cache was fresh, and all
//                four quadrant cameras existed (87K+050 / 88K+590 /
//                87K+490 / 89K+300). But incident suppression had already
//                matched it to the PBS report, so pendingTargets === 0 and
//                the push loop `continue`d BEFORE CCTV preparation ever
//                ran. R2 confirms it: not one object was published that
//                day. The Shared Feed therefore recorded imageUrl: null,
//                and the consuming project could only ever send text.
//
// So a completed product's image was gated on THIS Worker's own delivery
// state — "my subscribers already know" silently meant "nobody else may
// ever get a picture". That is exactly the coupling the Shared Feed exists
// to remove, and this pass removes it.
//
// WHAT THIS PASS DELIBERATELY DOES NOT DO
//   - It does not push, re-push, or modify a single LINE message. It runs
//     strictly AFTER the push loop and after every notified-state write,
//     and it touches nothing but `completedProducts` (+ its own counters).
//   - It does not relax CCTV eligibility. resolveCctvEligibility is called
//     unchanged, so a PBS-sourced accident still gets nothing, no KM is
//     ever guessed from free text, and camera matching is untouched.
//   - It never runs on a read path. The whole function is reachable only
//     from runLineBroadcast's real (non-dryRun, in-hours, not-fail-closed)
//     Cron branch — GET /internal/shared-feed imports only readSharedFeed
//     and selectFeedWindow, so serving the feed still makes 0 upstream
//     calls of any kind.
//
// ANTI-REDO GUARD (the reason this cannot become a per-tick collage loop)
// A still-valid stored image is REUSED, never recomposed: one read-only KV
// read for the whole pass, then isStoredImageStillValid decides per event.
// A collage is composed only when the feed has no image for that eventId,
// or its stored expiry has already passed, or the content fingerprint
// changed. Combined with sharedFeed.js's matching carry-forward, a single
// accident costs at most one compose+publish per 15-minute image lifetime,
// not one per 10-minute tick.
//
// BUDGET
// Its own deadline, started here rather than sharing cctvRunDeadlineAt,
// precisely because it begins after all pushes are done: giving it the
// leftovers of the push path's budget would have made "did the feed get an
// image?" depend on how busy this Worker's own broadcast happened to be —
// the same coupling this whole change removes. Running out of budget is
// just "no image this tick"; the next tick retries, and no already-valid
// image is ever lost, because carrying one forward costs no budget at all.
async function topUpSharedFeedCctvImages(env, result, feedOnlyProducts, { now, cctvRunCache, cctvCodecOverride, cctvPrepareBudgetMs }) {
  if (feedOnlyProducts.length === 0) return;

  // Cheapest gate first, and ZERO I/O — resolveCctvEligibility is pure.
  // A PBS-sourced accident (or a non-accident, unsupported road, or an
  // event with no reliable structured KM) exits here, so this pass cannot
  // read KV, fetch a frame, or write to R2 on its behalf.
  const eligible = feedOnlyProducts.filter((product) => resolveCctvEligibility(product.event).eligible);
  if (eligible.length === 0) return;

  // Exactly ONE read-only KV read for the whole pass, no matter how many
  // candidates there are.
  const feed = await readSharedFeed(env.TRAFFIC_KV);
  if (!feed.kvAvailable) {
    // Can't prove the feed lacks a valid image -> don't do expensive work
    // on a guess. Fail-closed, same as every other CCTV failure mode.
    result.cctvFeedOnlySkippedByReason['feed-unavailable'] = (result.cctvFeedOnlySkippedByReason['feed-unavailable'] || 0) + eligible.length;
    return;
  }
  const storedById = new Map(
    feed.events.filter((entry) => entry && typeof entry.eventId === 'string').map((entry) => [entry.eventId, entry])
  );

  const deadlineAt = Date.now() + (cctvPrepareBudgetMs ?? CCTV_PREPARE_BUDGET_MS);

  for (const product of eligible) {
    // The feed's OWN identity/fingerprint definitions (sharedFeed.js), not
    // this pipeline's notification fingerprint — the stored entry we are
    // comparing against was written with these, and there must be exactly
    // one definition of "the same feed entry".
    const eventId = eventIdOf(product.event);
    const feedFingerprint = await fingerprintOf(product.event);
    const stored = storedById.get(eventId);

    if (isStoredImageStillValid(stored, feedFingerprint, now)) {
      product.imageUrl = stored.imageUrl;
      product.imageExpiresAt = stored.imageExpiresAt;
      result.cctvFeedOnlyReusedCount += 1;
      continue; // 0 frame fetches, 0 compose, 0 R2 publish
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      result.cctvFeedOnlySkippedByReason['run-budget-exhausted'] = (result.cctvFeedOnlySkippedByReason['run-budget-exhausted'] || 0) + 1;
      // V1.8.6.7 (Pipeline Trace) — mirrors `product.imageUrl` itself:
      // recorded on the product object so runLineBroadcast's trace-patch
      // pass (right after this function returns) can show WHY, without a
      // second CCTV call.
      product.cctvSkipReason = 'run-budget-exhausted';
      continue;
    }

    result.cctvFeedOnlyAttemptedCount += 1;
    const cctv = await prepareCctvImageForEvent(env, product.event, cctvRunCache, cctvCodecOverride, remainingMs);
    if (cctv.ok) {
      product.imageUrl = cctv.imageUrl;
      product.imageExpiresAt = cctv.imageExpiresAt;
      result.cctvFeedOnlyAttachedCount += 1;
    } else {
      result.cctvFeedOnlySkippedByReason[cctv.reason] = (result.cctvFeedOnlySkippedByReason[cctv.reason] || 0) + 1;
      product.cctvSkipReason = cctv.reason;
    }
  }

  // Observability: the absence of any signal here is precisely what made
  // the 2026-08-20 incident slow to diagnose. Logged only when this pass
  // actually did something, so a quiet tick stays quiet.
  if (result.cctvFeedOnlyAttemptedCount > 0 || result.cctvFeedOnlyReusedCount > 0) {
    console.log(
      `[line][feed-cctv] candidates=${feedOnlyProducts.length} eligible=${eligible.length} ` +
        `attempted=${result.cctvFeedOnlyAttemptedCount} attached=${result.cctvFeedOnlyAttachedCount} ` +
        `reused=${result.cctvFeedOnlyReusedCount} ` +
        `skipped=${JSON.stringify(result.cctvFeedOnlySkippedByReason)}`
    );
  }
}
