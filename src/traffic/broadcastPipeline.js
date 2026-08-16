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

import { isWithinBroadcastHours } from './broadcastHours.js';
import { computeEffectiveWindow } from './effectiveWindow.js';
import { isBroadcastRelevant } from './broadcastRules.js';
import { readSubscriptions, persistSubscriptions } from './subscriptions.js';
import {
  readNotifiedState,
  targetKey,
  targetNeedsNotification,
  targetNeedsCongestionNotification,
  applyNotifiedTargets,
  removePrunedEvents,
  persistNotifiedState,
  computeFingerprint,
} from './notified.js';
import { clusterCongestionEvents } from './congestionCluster.js';
import { formatEventMessage } from './messageFormat.js';
import { pushLineMessage } from '../line/pushMessage.js';

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
  }
) {
  const result = {
    withinBroadcastHours: isWithinBroadcastHours(now),
    lineReady: false,
    enabledUsersCount: 0,
    enabledGroupsCount: 0,
    subscriptionsCount: 0,
    notifiedEventCount: 0,
    broadcastRelevantCount: 0,
    activeNowCount: 0,
    futureWithin60MinCount: 0,
    pendingTargetCount: 0,
    pushAttempted: 0,
    pushSucceeded: 0,
    partialPushFailures: 0,
    lastLinePushAt: null,
    lineErrors: [],
  };

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

  // V1.2C: cluster same-run congestion events into candidates BEFORE
  // computing relevance/pending targets at all, so N overlapping
  // congestion rows this Cron tick become exactly one candidate — never
  // N separate pending-target computations. This is what stops "5
  // overlapping congestion rows this tick -> 5 pushes this run" — see
  // congestionCluster.js and the "同一 Cron 不准洗版" requirement.
  // Non-congestion events (accident/construction/closure/control/alert/
  // other) pass through completely untouched.
  const { nonCongestionEvents, congestionClusters } = clusterCongestionEvents(allEvents);

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

  const failClosed = !hasToken || !dedupeAvailable || !subsState.kvAvailable || !notifiedState.kvAvailable;
  result.lineReady = !failClosed;
  if (failClosed) return result; // 0 push for every target, whether dry-run or real

  // Per (event, target) pending list. A congestion cluster uses a
  // corridor-scoped notification key ("congestion:<road>:<direction>:
  // <corridor>") plus a time-based cooldown
  // (targetNeedsCongestionNotification, see notified.js) instead of the
  // fingerprint-based check every other event type uses below — the
  // whole point of clustering is that a congestion cluster's KM range is
  // *expected* to shift every ~5 minutes without that being new
  // information for a driver. Accident/construction/closure/control/
  // alert/other keep the original fingerprint-based, no-cooldown logic
  // completely unchanged, per the explicit "事故不要套壅塞冷卻" requirement.
  const perEventPending = relevant.map(({ event, window, cluster }) => {
    if (cluster) {
      const eventKeyStr = cluster.notificationKey;
      // Stored for record-keeping/debugging only — targetNeedsCongestionNotification
      // never reads it, so it can never gate whether a congestion cluster gets pushed.
      const fingerprint = computeFingerprint(event);
      const contentSince = clusterContentSince(cluster.members, { newUpdatedKeys, dedupeMapSnapshot, now });

      const pendingTargets = targets.filter((target) => {
        if (!targetNeedsCongestionNotification(eventKeyStr, target, notifiedState.notifiedMap, now)) return false;
        if (target.enabledAt && contentSince.getTime() < new Date(target.enabledAt).getTime()) return false;
        return true;
      });

      return { event, window, eventKeyStr, fingerprint, pendingTargets };
    }

    const eventKeyStr = eventKeyOf(event);
    const fingerprint = computeFingerprint(event);
    const contentSince = effectiveContentSince(event, { newUpdatedKeys, dedupeMapSnapshot, now });

    const pendingTargets = targets.filter((target) => {
      if (!targetNeedsNotification(eventKeyStr, target, fingerprint, notifiedState.notifiedMap)) return false;
      // Backfill guard: this exact content predates the target's
      // subscription and hasn't changed since -> don't send it.
      if (target.enabledAt && contentSince.getTime() < new Date(target.enabledAt).getTime()) return false;
      return true;
    });

    return { event, window, eventKeyStr, fingerprint, pendingTargets };
  });

  result.pendingTargetCount = perEventPending.reduce((sum, e) => sum + e.pendingTargets.length, 0);

  if (dryRun) return result; // preview stops here — no push, no writes

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
    return result;
  }

  for (const { event, window, eventKeyStr, fingerprint, pendingTargets } of perEventPending) {
    if (pendingTargets.length === 0) continue;

    const startMs = new Date(window.effectiveStart).getTime();
    const forecast = startMs > now.getTime();
    const minutesUntilStart = forecast ? Math.max(1, Math.round((startMs - now.getTime()) / 60000)) : null;
    const text = formatEventMessage(event, { forecast, minutesUntilStart });

    const successfulTargets = [];
    // Best-effort per target — one target's failure never blocks another.
    for (const target of pendingTargets) {
      result.pushAttempted += 1;
      try {
        await pushLineMessage(env, target.id, text);
        successfulTargets.push(target);
        result.pushSucceeded += 1;
      } catch (err) {
        result.lineErrors.push(`push failed (${target.kind}): ${safeErrorMessage(err)}`);
      }
    }

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
    }
  }

  result.partialPushFailures = partialFailureCountThisRun;

  if (!anyWriteHappened && prunedKeys.length > 0) {
    const commit = await persistNotifiedState(env.TRAFFIC_KV, notifiedMap, result.lastLinePushAt, now, partialFailureCountThisRun);
    if (!commit.committed) result.lineErrors.push(`failed to record notified-state prune cleanup: ${commit.error}`);
  }

  return result;
}
