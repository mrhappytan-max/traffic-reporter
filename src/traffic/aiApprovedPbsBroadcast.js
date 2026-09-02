// V1.9.9 Phase 3B — the scoped LINE execution path for a Windows PBS event
// Workers AI has already validated as notify:true (see
// pbs/aiDecisionEngine.js). This is the order's own suggested
// runAiApprovedPbsBroadcast() (order section 十): a NEW, SCOPED function
// rather than a second full copy of traffic/broadcastPipeline.js.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// -------------------------------------
// It never calls traffic/broadcastRules.js#getBroadcastEligibility, traffic/
// broadcastPolicy.js#getLinePushPolicyDecision, or traffic/
// locationQuality.js#resolveLocationQuality — those are the content-
// judgment hard rules this whole round exists to retire from the Windows
// PBS decision path (order: "AI verdict 是 Windows PBS semantic
// authority... 不得再讓 MAJOR_ACCIDENT_ONLY／getBroadcastEligibility／
// locationQuality hard-reject 重新否決 AI 已經判定 notify=true 的 Windows
// PBS event"). It also never re-derives a time-window relevance judgment
// (traffic/effectiveWindow.js) — a Windows-sourced AI candidate is, by
// construction, something Windows just detected as a live NEW/UPDATED
// transition; treating it as anything other than "relevant right now"
// would silently drop exactly the non-accident/non-congestion event types
// (construction/control/other) this round exists to let AI approve at all
// (effectiveWindow.js's LIVE_TYPES is deliberately narrower than that).
//
// WHAT IT DOES REUSE, UNCHANGED (order section 十 — "應盡量重用現有")
// -----------------------------------------------------------------------
// - traffic/subscriptions.js#readSubscriptions — same targets list.
// - traffic/notified.js#computeNotificationFingerprint/
//   targetNeedsNotification/applyNotifiedTargets/persistNotifiedState —
//   the SAME per-target dedupe/notified-state machinery every other
//   source uses; a resend of the identical AI-approved content still
//   correctly dedupes per target.
// - traffic/incidentSuppression.js (accident type only) — same real-
//   incident suppression/escalation logic TDX/polling-PBS accidents get,
//   so an AI-approved accident doesn't spam the same real crash.
// - traffic/messageFormat.js#formatEventMessage — byte-identical message
//   text to every other source.
// - cctv/dynamicCollage.js#prepareCctvImageForEvent (accident type only)
//   — the SAME CCTV eligibility/budget/fail-safe machinery; no CCTV logic
//   duplicated here.
// - line/pushMessage.js#pushLineMessages — the one real LINE API call.
//
// WHAT IT STILL ENFORCES (order section 三 — "必須保留")
// ---------------------------------------------------------
// Broadcast hours (traffic/broadcastHours.js) — execution/quota safety,
// not a content judgment.
//
// V2.4.4 — SERVICE AREA IS NOW RE-CHECKED HERE TOO (this paragraph
// previously said the opposite — "Service area is NOT re-checked here:
// Phase 2's isWindowsPbsAiCandidateEligible() already gated candidate
// construction on it, before this function is ever reached" — that
// single upstream gate was proven insufficient in Production on
// 2026-09-01: a TDX event (台61線／桃園市觀音區) reached real LINE despite
// it. serviceArea.js#resolveHsinchuOnlyProductionEligibility() is now
// called FIRST in this function, before any I/O — a deterministic
// geography hard gate the AI's own notify:true verdict can never
// override. See that function's own comment for the full root-cause
// writeup and why a SECOND check, right before LINE, is now required.
//
// Deliberately does NOT touch Shared Feed itself — the caller
// (pbs/debugPush.js) is responsible for calling traffic/sharedFeed.js's
// runSharedFeedPersist() with this function's own completedProducts,
// exactly the same reuse pattern the existing V1.9.8 legacy call already
// uses, so this module stays a pure "decide + push" unit.

import { isWithinBroadcastHours } from './broadcastHours.js';
import { resolveHsinchuOnlyProductionEligibility } from './serviceArea.js';
import { readSubscriptions } from './subscriptions.js';
import {
  readNotifiedState,
  targetNeedsNotification,
  applyNotifiedTargets,
  persistNotifiedState,
  computeNotificationFingerprint,
} from './notified.js';
import { readIncidentSuppressionState, resolveIncidentNotifications, persistIncidentSuppressionState } from './incidentSuppression.js';
import { formatEventMessage } from './messageFormat.js';
import { pushLineMessages } from '../line/pushMessage.js';
import { prepareCctvImageForEvent } from '../cctv/dynamicCollage.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

function eventKeyOf(event) {
  return `${event.source}:${event.rawId}`;
}

/**
 * @param {object} env
 * @param {{event:object, now?:Date, suppressLineNotify?:boolean}} options -
 *   `event` is the SAME normalized-event shape both pbs/normalize.js#
 *   normalizePbsEvent AND (V2.4.0) tdx/normalize.js#normalizeRoadEvent
 *   already produce — already confirmed AI notify:true. This function's
 *   own logic (subscriptions/notified/incidentSuppression/messageFormat/
 *   CCTV/pushMessage) only ever reads the generic unified-event fields
 *   (road/direction/type/startKM/endKM/description/...), never anything
 *   PBS-specific — see V2.4.0 architecture audit section 六's own finding
 *   that this function needed ZERO logic fork to also serve TDX
 *   candidates.
 *
 *   `suppressLineNotify` (V2.4.0, default false) -- order section
 *   二十's PHASE B gate ("允許進 Queue/AI，但暫不讓 TDX source 正式發
 *   LINE"). When true, incident suppression state is still read/written
 *   and notified-state per-target dedup is still computed (so
 *   `result.suppressed`/`result.pendingTargetCount` stay meaningful for
 *   Observatory/Pipeline Trace), but the function returns BEFORE CCTV
 *   preparation, R2 publish, or the real `pushLineMessages` call -- none
 *   of the three ever run: `pushAttempted`/`pushSucceeded` stay 0,
 *   `completedProducts[0].imageUrl` stays null, and notified-state is
 *   never persisted for a target that was never actually notified
 *   (persisting it would wrongly make a REAL future Phase-C send look
 *   like an already-seen duplicate).
 *
 *   V2_4_0_PHASE_B_QUEUE_OBSERVE_ENABLE (2026-09-01): moved this check to
 *   run BEFORE CCTV preparation (previously it only gated the LINE push
 *   itself, letting a TDX-origin notify:true accident still do a real
 *   frame fetch + R2 publish "for observability" -- that traded real
 *   side effects for a nice-to-have, and the order that enabled Queue
 *   ingress explicitly requires `TDX_CCTV_STRUCTURALLY_BLOCKED = YES`,
 *   never relying on "AI happened to say notify=false" as the safety
 *   guarantee). Every Observatory field this round actually requires
 *   (SOURCE/EVENT_ID/LIFECYCLE/MEMORY_CANDIDATES/SAME_INCIDENT/
 *   MATERIAL_CHANGE/AI_NOTIFY/AI_IMPACT/AI_REASON/PRIMARY_SOURCE/
 *   LAST_NOTIFIED_AT/MEMORY_WRITE) comes from the AI decision result
 *   computed earlier in debugPush.js#runAiDecisionPath, not from
 *   completedProducts -- so skipping CCTV prep here loses no information
 *   Phase B needs to observe. Never driven by any config value -- see
 *   debugPush.js's own V2.4.0 comment on why this is hardcoded at the
 *   call site, not a wrangler.jsonc switch.
 * @returns {Promise<{
 *   lineReady:boolean, withinBroadcastHours:boolean, suppressed:boolean,
 *   pendingTargetCount:number, pushAttempted:number, pushSucceeded:number,
 *   completedProducts:object[], lineErrors:string[],
 * }>}
 */
export async function runAiApprovedPbsBroadcast(env, { event, now = new Date(), suppressLineNotify = false }) {
  const result = {
    lineReady: false,
    withinBroadcastHours: isWithinBroadcastHours(now),
    serviceAreaEligible: true,
    suppressed: false,
    pendingTargetCount: 0,
    pushAttempted: 0,
    pushSucceeded: 0,
    completedProducts: [],
    lineErrors: [],
  };

  // V2.4.4 — order section 七's own geographic HARD GATE, checked FIRST,
  // before any I/O and before the AI's own notify:true verdict gets any
  // further say. Deliberately independent of, and stricter than,
  // pbs/aiCandidate.js's own isWindowsPbsAiCandidateEligible() (which
  // only ran once, at candidate-build time, using the same resolver that
  // let today's 台61線/桃園市觀音區 leak through on a since-corrected but
  // still-imperfect KM table) — see serviceArea.js's own V2.4.4 comment
  // for the full root-cause writeup and why this is checked again here,
  // right before LINE, for both PBS and TDX uniformly. This is a
  // deterministic geography gate, not a semantic judgment — AI notify:true
  // can NEVER override it; an ineligible event gets 0 LINE, 0 CCTV, 0 R2,
  // unconditionally.
  const areaGate = resolveHsinchuOnlyProductionEligibility(event);
  result.serviceAreaEligible = areaGate.eligible;
  if (!areaGate.eligible) {
    return result;
  }

  const hasToken = Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!hasToken) result.lineErrors.push('LINE_CHANNEL_ACCESS_TOKEN not configured');

  const subsState = await readSubscriptions(env.TRAFFIC_KV, now);
  if (!subsState.kvAvailable) result.lineErrors.push(`subscriptions unavailable: ${subsState.kvError}`);

  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  if (!notifiedState.kvAvailable) result.lineErrors.push(`notified state unavailable: ${notifiedState.kvError}`);

  const failClosed = !hasToken || !subsState.kvAvailable || !notifiedState.kvAvailable;
  result.lineReady = !failClosed;
  if (failClosed) return result;

  // Execution/quota safety (unchanged product policy), not a content
  // judgment — see this module's own header comment.
  if (!result.withinBroadcastHours) return result;

  const enabledUsers = Object.entries(subsState.subscriptions.users || {}).filter(([, e]) => e.enabled);
  const enabledGroups = Object.entries(subsState.subscriptions.groups || {}).filter(([, e]) => e.enabled);
  const targets = [
    ...enabledUsers.map(([id, e]) => ({ kind: 'user', id, enabledAt: e.enabledAt })),
    ...enabledGroups.map(([id, e]) => ({ kind: 'group', id, enabledAt: e.enabledAt })),
  ];

  // Incident suppression — accident type only, same scope as the legacy
  // pipeline's own use of it. Persisted regardless of suppressed/not,
  // mirroring broadcastPipeline.js's own WRITE_ON_CHANGE call shape.
  //
  // V2_4_0_PHASE_C_PRODUCTION_NOTIFY_IMPLEMENTATION — `trustCallerDecision:
  // true` because this function is only ever reached AFTER the AI
  // decision engine has already validated notify:true (see debugPush.js's
  // own runAiDecisionPath) — the AI, not this module's own escalation
  // heuristic, is the semantic authority on whether this deserves a
  // (re-)notification. See resolveIncidentNotifications's own doc comment.
  let eventKeyStr = eventKeyOf(event);
  if (event.type === 'accident') {
    const incidentState = await readIncidentSuppressionState(env.TRAFFIC_KV);
    if (!incidentState.kvAvailable) result.lineErrors.push(`incident suppression state unavailable: ${incidentState.kvError}`);
    if (incidentState.kvAvailable) {
      const before = structuredClone(incidentState.incidentsByGroup);
      const { results, nextIncidentsByGroup } = resolveIncidentNotifications([event], incidentState.incidentsByGroup, now, { trustCallerDecision: true });
      const [resolved] = results;
      eventKeyStr = resolved.notificationKey;
      result.suppressed = resolved.suppressed;
      const commit = await persistIncidentSuppressionState(env.TRAFFIC_KV, nextIncidentsByGroup, now, {
        previousIncidentsByGroup: before,
        previousStateExisted: incidentState.existed,
      });
      if (!commit.committed) result.lineErrors.push(`failed to persist incident suppression state: ${commit.error}`);
    }
  }

  const fingerprint = computeNotificationFingerprint(event);
  const text = formatEventMessage(event, { forecast: false, minutesUntilStart: null });
  const completedProduct = { eventKeyStr, fingerprint, text, event, imageUrl: null, imageExpiresAt: null };
  result.completedProducts.push(completedProduct);

  // Same real incident, no material change since last notified — 0
  // pending targets, matches broadcastPipeline.js's own semantics exactly.
  if (result.suppressed) return result;

  const pendingTargets = targets.filter((target) => targetNeedsNotification(eventKeyStr, target, fingerprint, notifiedState.notifiedMap));
  result.pendingTargetCount = pendingTargets.length;
  if (pendingTargets.length === 0) return result;

  // V2_4_0_PHASE_B_QUEUE_OBSERVE_ENABLE — Phase B gate (see this
  // function's own doc comment above for the full rationale). Checked
  // HERE, before CCTV preparation/R2 publish, not just before the LINE
  // push — a TDX-origin notify:true event must do ZERO real CCTV/R2 work
  // in Phase B, never relying on "AI happened to say notify=false" as the
  // safety boundary. `completedProducts[0].imageUrl` stays null in this
  // path; nothing downstream (Shared Feed) ever sees it either way.
  if (suppressLineNotify) {
    return result;
  }

  let messages = [{ type: 'text', text }];
  if (event.type === 'accident') {
    try {
      const cctv = await prepareCctvImageForEvent(env, event, {});
      if (cctv.ok) {
        messages = [{ type: 'text', text }, { type: 'image', originalContentUrl: cctv.imageUrl, previewImageUrl: cctv.imageUrl }];
        completedProduct.imageUrl = cctv.imageUrl;
        completedProduct.imageExpiresAt = cctv.imageExpiresAt;
      }
    } catch (err) {
      // CCTV must never be able to block a text push — same fail-safe
      // principle as the legacy pipeline's own CCTV integration.
      result.lineErrors.push(`CCTV prepare failed (non-blocking): ${safeErrorMessage(err)}`);
    }
  }

  const successfulTargets = [];
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

  if (successfulTargets.length > 0) {
    const notifiedMap = applyNotifiedTargets(notifiedState.notifiedMap, eventKeyStr, fingerprint, successfulTargets, now);
    const commit = await persistNotifiedState(env.TRAFFIC_KV, notifiedMap, now.toISOString(), now, 0);
    if (!commit.committed) {
      result.lineErrors.push(
        `HIGH RISK: event ${eventKeyStr} was pushed to ${successfulTargets.length} target(s) but notified-state write failed (${commit.error})`
      );
    }
  }

  return result;
}
