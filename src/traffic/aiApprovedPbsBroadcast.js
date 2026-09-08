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
//   correctly dedupes per target. V2.6.0 (路況-055) — LINE and Telegram
//   now each call these functions against their OWN independently
//   persisted record (see this module's own V2.6.0 comment below); the
//   functions themselves are unchanged, only the KV key passed to them
//   differs per channel.
// - traffic/incidentSuppression.js (accident type only) — same real-
//   incident suppression/escalation logic TDX/polling-PBS accidents get,
//   so an AI-approved accident doesn't spam the same real crash. Still
//   ONE shared judgment for both channels (V2.6.0 does not touch this —
//   see this module's own V2.6.0 comment on why).
// - traffic/messageFormat.js#formatEventMessage — byte-identical message
//   text to every other source. Still computed ONCE, shared by both
//   channels (V2.6.0 does not touch this — 路況-054 section 三 already
//   concluded content preparation should stay shared; see this module's
//   own V2.6.0 comment).
// - cctv/dynamicCollage.js#prepareCctvImageForEvent — the SAME CCTV
//   eligibility/budget/fail-safe machinery; no CCTV logic duplicated here.
//   V2.4.18 — no longer gated to "accident type only" at this call site
//   (that separate, pre-existing `event.type === 'accident'` gate around
//   this call is REMOVED this round; see the call site's own V2.4.18
//   comment) — eligibility is now decided exclusively by that function's
//   own internal resolveCctvEligibility(), same as every other CCTV entry
//   point since V2.4.16. V2.6.0 — still invoked AT MOST ONCE per event
//   regardless of how many channels end up needing it (see
//   resolveBroadcastContent's own comment) — this is unchanged behavior,
//   not a new optimization.
// - line/pushMessage.js#pushLineMessages — the one real LINE API call.
// - telegram/pushMessage.js#pushTelegramMessage — the one real Telegram
//   API call (V2.5.0).
//
// V2.5.0 (路況-052) — telegram/pushMessage.js#pushTelegramMessage added as
// a second, independent notification destination (a private Telegram
// channel), originally wired in as one more synthetic entry in the SAME
// `targets` array LINE's own subscribers populated, sharing LINE's own
// readiness gate and notified-state record. V2.5.0's own sealed report
// already disclosed this as a known, deliberately-accepted "readiness-
// level (not delivery-level) coupling" — see engineering-memory's own
// V2.5.0 record.
//
// V2.6.0 (路況-055, following 路況-054's own plan) — THAT READINESS-LEVEL
// COUPLING IS NOW REMOVED. LINE and Telegram are two fully independent
// delivery paths: deliverToLineTargets() and deliverToTelegram() below
// each do their OWN readiness check, OWN target resolution, OWN
// notified-state read/write (against SEPARATE KV keys — see
// TELEGRAM_NOTIFIED_KEY below), OWN push call, and OWN error recording.
// Either can be fully healthy while the other is fully broken (missing
// token, unreachable KV, HTTP failure) with zero effect on the other —
// see this file's own test suite for the regression locks proving this
// in both directions. This does NOT change what counts as "the same
// event" or "already notified" from a content standpoint — both channels
// still key their own dedupe records by the SAME `eventKeyStr`/
// `fingerprint` this function already computes once, shared (see below);
// only WHERE that per-target/per-channel state is stored is now split.
//
// V2.6.0 deliberately does NOT touch:
//   - Incident suppression (traffic/incidentSuppression.js) — still ONE
//     shared judgment gating BOTH channels equally, exactly as before.
//     This is a real-world-incident content judgment (same real crash,
//     no material change), not a delivery-channel concern — 路況-054
//     never asked for this to split, and splitting it would let the two
//     channels disagree about whether the SAME real incident deserves a
//     re-notification, which is not the kind of "independence" this
//     round's order asked for.
//   - Content preparation (`text`/CCTV `messages`/`completedProduct`) —
//     still computed AT MOST ONCE per event, shared by both channels
//     (路況-054 section 三's own conclusion, reaffirmed by 路況-055's own
//     order: "不得拆分內容準備"). See resolveBroadcastContent below for
//     how this stays a single, memoized computation even though it can
//     now be triggered from either (or both, running in parallel)
//     delivery path.
//   - Broadcast hours / service area — unchanged, still two GLOBAL gates
//     ahead of BOTH channels (execution/quota safety and geography are
//     not delivery-channel concerns either).
//   - `suppressLineNotify` (V2.4.0 Phase B gate, see this function's own
//     doc comment) — its scope is UNCHANGED by this round: it already
//     suppressed Telegram too, from the moment V2.5.0 added Telegram
//     into the same pre-CCTV early-return this flag already gated. This
//     round only restructures HOW that suppression is applied (per
//     channel, inside each deliver function, instead of one shared
//     early-return) — the OBSERVABLE effect (zero CCTV/R2 work, zero
//     real push to either channel, notified-state never persisted) is
//     identical to before.
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
import { pushTelegramMessage } from '../telegram/pushMessage.js';
import { prepareCctvImageForEvent, resolveCctvEligibility } from '../cctv/dynamicCollage.js';

// V2.6.0 (路況-055) — Telegram's OWN, independently-persisted
// notified-state record — same schema, same notified.js functions, a
// DIFFERENT KV key from LINE's own 'line:notified-state' (see
// notified.js's own V2.6.0 comment on why NOTIFIED_KEY became a
// parameter rather than a hardcoded constant). Named following this
// project's existing convention (line:subscriptions, line:notified-
// state, line:incident-suppression-state — channel prefix, colon,
// record name).
export const TELEGRAM_NOTIFIED_KEY = 'telegram:notified-state';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

function eventKeyOf(event) {
  return `${event.source}:${event.rawId}`;
}

/**
 * Builds the shared content (text + CCTV-derived `messages`/image fields on
 * `completedProduct`) AT MOST ONCE, no matter how many times — or how many
 * channels concurrently — call the returned resolver. This is the SAME
 * CCTV try/catch this function has always run (byte-for-byte unchanged
 * logic; V2.4.18's own removed-gate history and V2.5.1's own
 * imageStrategy/cctvSkippedByReason/r2ReadbackElapsedMs wiring both still
 * apply exactly as before) — V2.6.0 only wraps it in a memoized resolver so
 * `deliverToLineTargets`/`deliverToTelegram` can each lazily trigger it
 * (only if THEY actually have a pending target to send to) without ever
 * running it twice, including when both run concurrently via Promise.all
 * below (a second, third, ... caller awaiting the SAME in-flight promise is
 * standard, safe JS — no lock needed).
 *
 * @returns {() => Promise<{messages:object[], imageUrl:string|null}>}
 */
function makeBroadcastContentResolver(env, event, text, completedProduct, lineErrorsSink) {
  let pending = null;
  return function resolveBroadcastContent() {
    if (!pending) {
      pending = (async () => {
        let messages = [{ type: 'text', text }];
        // V2.5.1 (路況-053, following 路況-046's own plan) — three
        // additional, PURELY OBSERVATIONAL fields, never a new judgment:
        //   - imageStrategy: read from a SEPARATE, direct call to
        //     resolveCctvEligibility(event) — the same pure, zero-I/O,
        //     already-established eligibility check
        //     prepareCctvImageForEvent() calls internally anyway. Chosen
        //     over the alternative (having prepareCctvImageForEvent()
        //     itself return imageStrategy) because it touches ONLY this
        //     file, never cctv/dynamicCollage.js. Only set when eligible.
        //   - r2ReadbackElapsedMs: read directly off `cctv` whenever
        //     present — prepareCctvImageWork()'s own snapshotStageTiming()
        //     already attaches this on EVERY return path.
        //   - cctvSkippedByReason: `cctv.reason` on the `!cctv.ok` branch.
        try {
          const eligibility = resolveCctvEligibility(event);
          if (eligibility.eligible) completedProduct.imageStrategy = eligibility.imageStrategy;
          const cctv = await prepareCctvImageForEvent(env, event, {});
          if (typeof cctv.r2ReadbackElapsedMs === 'number') completedProduct.r2ReadbackElapsedMs = cctv.r2ReadbackElapsedMs;
          if (cctv.ok) {
            messages = [{ type: 'text', text }, { type: 'image', originalContentUrl: cctv.imageUrl, previewImageUrl: cctv.imageUrl }];
            completedProduct.imageUrl = cctv.imageUrl;
            completedProduct.imageExpiresAt = cctv.imageExpiresAt;
          } else {
            completedProduct.cctvSkippedByReason = cctv.reason;
          }
        } catch (err) {
          // CCTV must never be able to block a text push — same fail-safe
          // principle as the legacy pipeline's own CCTV integration. Kept
          // in lineErrors (not a new bucket) — same attribution as before
          // this round; CCTV is shared content prep, not a delivery-
          // channel-specific failure.
          lineErrorsSink.push(`CCTV prepare failed (non-blocking): ${safeErrorMessage(err)}`);
        }
        return { messages, imageUrl: completedProduct.imageUrl };
      })();
    }
    return pending;
  };
}

/**
 * LINE's own, fully independent delivery path — own readiness check (LINE
 * token + LINE subscriptions KV + LINE's own notified-state KV), own
 * target resolution, own per-target push loop, own notified-state
 * persistence. Never reads or writes anything Telegram-specific.
 *
 * @returns {Promise<{ready:boolean, attempted:number, succeeded:number, errors:string[], pendingCount:number}>}
 */
async function deliverToLineTargets(env, { now, eventKeyStr, fingerprint, suppressLineNotify, resolveContent }) {
  const errors = [];

  const hasToken = Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!hasToken) errors.push('LINE_CHANNEL_ACCESS_TOKEN not configured');
  const subsState = await readSubscriptions(env.TRAFFIC_KV, now);
  if (!subsState.kvAvailable) errors.push(`subscriptions unavailable: ${subsState.kvError}`);
  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  if (!notifiedState.kvAvailable) errors.push(`notified state unavailable: ${notifiedState.kvError}`);
  const ready = hasToken && subsState.kvAvailable && notifiedState.kvAvailable;
  if (!ready) return { ready, attempted: 0, succeeded: 0, errors, pendingCount: 0 };

  const enabledUsers = Object.entries(subsState.subscriptions.users || {}).filter(([, e]) => e.enabled);
  const enabledGroups = Object.entries(subsState.subscriptions.groups || {}).filter(([, e]) => e.enabled);
  const targets = [
    ...enabledUsers.map(([id, e]) => ({ kind: 'user', id, enabledAt: e.enabledAt })),
    ...enabledGroups.map(([id, e]) => ({ kind: 'group', id, enabledAt: e.enabledAt })),
  ];
  const pendingTargets = targets.filter((target) => targetNeedsNotification(eventKeyStr, target, fingerprint, notifiedState.notifiedMap));
  if (pendingTargets.length === 0) return { ready, attempted: 0, succeeded: 0, errors, pendingCount: 0 };

  // V2_4_0_PHASE_B_QUEUE_OBSERVE_ENABLE (see this module's own doc
  // comment) — unchanged scope: a TDX-origin notify:true event still does
  // ZERO real CCTV/R2/push work in Phase B. pendingCount is still reported
  // (matches the pre-V2.6.0 behavior of computing pendingTargets before
  // this check) even though nothing downstream actually runs.
  if (suppressLineNotify) return { ready, attempted: 0, succeeded: 0, errors, pendingCount: pendingTargets.length };

  const { messages } = await resolveContent();

  let attempted = 0;
  let succeeded = 0;
  const successfulTargets = [];
  for (const target of pendingTargets) {
    attempted += 1;
    try {
      await pushLineMessages(env, target.id, messages);
      successfulTargets.push(target);
      succeeded += 1;
    } catch (err) {
      errors.push(`push failed (${target.kind}): ${safeErrorMessage(err)}`);
    }
  }

  if (successfulTargets.length > 0) {
    const nextMap = applyNotifiedTargets(notifiedState.notifiedMap, eventKeyStr, fingerprint, successfulTargets, now);
    const commit = await persistNotifiedState(env.TRAFFIC_KV, nextMap, now.toISOString(), now, 0);
    if (!commit.committed) {
      errors.push(`HIGH RISK: event ${eventKeyStr} was pushed to ${successfulTargets.length} LINE target(s) but notified-state write failed (${commit.error})`);
    }
  }

  return { ready, attempted, succeeded, errors, pendingCount: pendingTargets.length };
}

/**
 * Telegram's own, fully independent delivery path — own readiness check
 * (both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID present + Telegram's own
 * notified-state KV, under TELEGRAM_NOTIFIED_KEY, a SEPARATE key from
 * LINE's), own single-target resolution, own send, own notified-state
 * persistence. Never reads or writes anything LINE-specific. An
 * unconfigured Telegram integration (either env var missing) degrades
 * silently — no error pushed, exactly matching the pre-V2.5.0/pre-V2.6.0
 * "feature off" behavior, never a half-broken attempt.
 *
 * @returns {Promise<{ready:boolean, attempted:number, succeeded:number, errors:string[], pendingCount:number}>}
 */
async function deliverToTelegram(env, { now, eventKeyStr, fingerprint, text, suppressLineNotify, resolveContent }) {
  const errors = [];

  const configured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  if (!configured) return { ready: false, attempted: 0, succeeded: 0, errors, pendingCount: 0 };

  const notifiedState = await readNotifiedState(env.TRAFFIC_KV, TELEGRAM_NOTIFIED_KEY);
  if (!notifiedState.kvAvailable) errors.push(`telegram notified state unavailable: ${notifiedState.kvError}`);
  const ready = notifiedState.kvAvailable;
  if (!ready) return { ready, attempted: 0, succeeded: 0, errors, pendingCount: 0 };

  const target = { kind: 'telegram-channel', id: env.TELEGRAM_CHAT_ID, enabledAt: null };
  const pendingTargets = targetNeedsNotification(eventKeyStr, target, fingerprint, notifiedState.notifiedMap) ? [target] : [];
  if (pendingTargets.length === 0) return { ready, attempted: 0, succeeded: 0, errors, pendingCount: 0 };

  // Same Phase B scope as LINE's own check above — see this module's own
  // doc comment on why this is unchanged, not a new policy decision.
  if (suppressLineNotify) return { ready, attempted: 0, succeeded: 0, errors, pendingCount: pendingTargets.length };

  const { imageUrl } = await resolveContent();

  let attempted = 0;
  let succeeded = 0;
  const successfulTargets = [];
  for (const t of pendingTargets) {
    attempted += 1;
    try {
      await pushTelegramMessage(env, t.id, text, imageUrl);
      successfulTargets.push(t);
      succeeded += 1;
    } catch (err) {
      errors.push(`telegram push failed: ${safeErrorMessage(err)}`);
    }
  }

  if (successfulTargets.length > 0) {
    const nextMap = applyNotifiedTargets(notifiedState.notifiedMap, eventKeyStr, fingerprint, successfulTargets, now);
    const commit = await persistNotifiedState(env.TRAFFIC_KV, nextMap, now.toISOString(), now, 0, TELEGRAM_NOTIFIED_KEY);
    if (!commit.committed) {
      errors.push(`HIGH RISK: event ${eventKeyStr} was pushed to Telegram but notified-state write failed (${commit.error})`);
    }
  }

  return { ready, attempted, succeeded, errors, pendingCount: pendingTargets.length };
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
 *   Observatory/Pipeline Trace), but BOTH channels return BEFORE CCTV
 *   preparation, R2 publish, or any real push call — see
 *   deliverToLineTargets/deliverToTelegram's own suppressLineNotify
 *   checks. `pushAttempted`/`pushSucceeded` stay 0,
 *   `completedProducts[0].imageUrl` stays null, and neither channel's
 *   notified-state is ever persisted for a target that was never actually
 *   notified (persisting it would wrongly make a REAL future Phase-C send
 *   look like an already-seen duplicate).
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
 *   lineReady:boolean, telegramReady:boolean, withinBroadcastHours:boolean,
 *   suppressed:boolean, pendingTargetCount:number, pushAttempted:number,
 *   pushSucceeded:number, completedProducts:object[], lineErrors:string[],
 *   telegramErrors:string[],
 *   line:{attempted:number,succeeded:number},
 *   telegram:{attempted:number,succeeded:number},
 * }>}
 */
export async function runAiApprovedPbsBroadcast(env, { event, now = new Date(), suppressLineNotify = false, cleanSummary = null }) {
  const result = {
    lineReady: false,
    // V2.6.0 (路況-055) — Telegram's own readiness, fully independent of
    // lineReady (see deliverToTelegram's own doc comment). false both when
    // Telegram is unconfigured (no error) and when configured-but-not-
    // ready (its own notified-state KV read failed — see telegramErrors).
    telegramReady: false,
    withinBroadcastHours: isWithinBroadcastHours(now),
    serviceAreaEligible: true,
    suppressed: false,
    pendingTargetCount: 0,
    pushAttempted: 0,
    pushSucceeded: 0,
    completedProducts: [],
    lineErrors: [],
    // V2.5.0 (路況-052) — kept fully separate from lineErrors: a Telegram
    // failure is never a LINE failure, and this keeps that true in the
    // observable result shape too, not just in execution. Always present
    // (never undefined) so a caller/test can assert on it unconditionally,
    // same convention as lineErrors itself.
    telegramErrors: [],
    // V2.6.0 (路況-055) — per-channel attempted/succeeded counts, the
    // fields debugPush.js now reads to compute lineSent/telegramSent
    // WITHOUT either channel's outcome polluting the other's (see that
    // module's own V2.6.0 comment for the bug this fixes — pushAttempted/
    // pushSucceeded below remain the COMBINED total across both channels,
    // unchanged in meaning from before this round, for every existing
    // reader that already treats them as "any real push at all" — e.g.
    // debugPush.js's own persistSighting(pushSucceeded > 0) incident-
    // memory bookkeeping, which V2.6.0 does not touch or re-scope).
    line: { attempted: 0, succeeded: 0 },
    telegram: { attempted: 0, succeeded: 0 },
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
  // can NEVER override it; an ineligible event gets 0 LINE, 0 Telegram,
  // 0 CCTV, 0 R2, unconditionally.
  const areaGate = resolveHsinchuOnlyProductionEligibility(event);
  result.serviceAreaEligible = areaGate.eligible;
  if (!areaGate.eligible) {
    return result;
  }

  // Execution/quota safety (unchanged product policy), not a content
  // judgment — see this module's own header comment. V2.6.0 — moved
  // ahead of the (now per-channel) readiness KV reads: during quiet
  // hours neither channel will do any real work regardless of its own
  // readiness, so there is no reason to spend a subscriptions/notified-
  // state KV read on either channel first (a small, safe efficiency
  // improvement over the pre-V2.6.0 order of operations — no existing
  // test depends on those reads happening before this check).
  if (!result.withinBroadcastHours) return result;

  // Incident suppression — accident type only, same scope as the legacy
  // pipeline's own use of it. Persisted regardless of suppressed/not,
  // mirroring broadcastPipeline.js's own WRITE_ON_CHANGE call shape. Still
  // ONE shared judgment gating BOTH channels equally — see this module's
  // own V2.6.0 comment on why this is deliberately NOT split.
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
  // V2.4.8 — cleanSummary (pbs/aiDecisionEngine.js's own validated AI
  // text-edit, already fact-checked) is passed straight through to the
  // ONE shared formatter, same as every other option here — see
  // messageFormat.js's own V2.4.8 comment for the presentation this
  // produces.
  const text = formatEventMessage(event, { forecast: false, minutesUntilStart: null, cleanSummary });
  // V2.5.1 (路況-053, following 路況-046's own plan) — cctvSkippedByReason/
  // imageStrategy/r2ReadbackElapsedMs added alongside the existing
  // imageUrl/imageExpiresAt, same style (null default, only ever set when
  // resolveBroadcastContent's own CCTV try block actually runs and has
  // something to report). See that resolver's own comment for exactly
  // when each gets populated.
  const completedProduct = {
    eventKeyStr,
    fingerprint,
    text,
    event,
    imageUrl: null,
    imageExpiresAt: null,
    cctvSkippedByReason: null,
    imageStrategy: null,
    r2ReadbackElapsedMs: null,
  };
  result.completedProducts.push(completedProduct);

  // Same real incident, no material change since last notified — 0
  // pending targets on EITHER channel, matches broadcastPipeline.js's own
  // semantics exactly. Neither channel's readiness/notified-state is even
  // read past this point.
  if (result.suppressed) return result;

  // V2.6.0 (路況-055, following 路況-054's own plan) — this is the ONLY
  // new logic in this function's own body: dispatch to two fully
  // independent delivery paths, run concurrently (see report for why
  // parallel over sequential — the two channels share no mutable state
  // once resolveContent is memoized, see makeBroadcastContentResolver).
  // Each path does its OWN complete readiness→target→send→error
  // lifecycle; a failure or slow response in one never blocks or delays
  // the other's own result.
  const resolveContent = makeBroadcastContentResolver(env, event, text, completedProduct, result.lineErrors);
  const [lineResult, telegramResult] = await Promise.all([
    deliverToLineTargets(env, { now, eventKeyStr, fingerprint, suppressLineNotify, resolveContent }),
    deliverToTelegram(env, { now, eventKeyStr, fingerprint, text, suppressLineNotify, resolveContent }),
  ]);

  result.lineReady = lineResult.ready;
  result.telegramReady = telegramResult.ready;
  result.line = { attempted: lineResult.attempted, succeeded: lineResult.succeeded };
  result.telegram = { attempted: telegramResult.attempted, succeeded: telegramResult.succeeded };
  result.pushAttempted = lineResult.attempted + telegramResult.attempted;
  result.pushSucceeded = lineResult.succeeded + telegramResult.succeeded;
  result.pendingTargetCount = lineResult.pendingCount + telegramResult.pendingCount;
  result.lineErrors.push(...lineResult.errors);
  result.telegramErrors.push(...telegramResult.errors);

  return result;
}
