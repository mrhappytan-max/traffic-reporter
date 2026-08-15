// Ties together: 60-minute relevance, quiet hours, subscriptions, and
// notified-state to decide what (if anything) actually gets pushed to
// LINE this Cron run.
//
// Two modes, matching the dedupe.js preview/commit split:
//   - dryRun=true (GET /debug/status): computes every stat, including
//     "would this push" and "who would receive it", but never calls the
//     LINE API and never calls markNotified. Read-only by construction.
//   - dryRun=false (the Cron scheduled handler): does the real push and,
//     only for events that were successfully delivered to at least one
//     target, calls markNotified.
//
// Fail-closed: a missing token, unavailable subscriptions, or unavailable
// notified-state all result in 0 pushes, never a guess.

import { isWithinBroadcastHours } from './broadcastHours.js';
import { computeEffectiveWindow } from './effectiveWindow.js';
import { isBroadcastRelevant } from './broadcastRules.js';
import { readSubscriptions } from './subscriptions.js';
import { readNotifiedState, needsNotification, markNotified } from './notified.js';
import { formatEventMessage } from './messageFormat.js';
import { pushLineMessage } from '../line/pushMessage.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

/**
 * @param {object} env
 * @param {{ allEvents: object[], dedupeAvailable: boolean, now?: Date, dryRun?: boolean }} options
 *   `allEvents` = every currently Hsinchu-relevant, noise-filtered event
 *   this run (from the TDX pipeline, regardless of seen/duplicate status —
 *   LINE notification is judged independently of the seen-dedupe layer,
 *   see notified.js's module comment for why).
 *   `dedupeAvailable` = pipeline.js's kvAvailable (the base TDX pipeline's
 *   own dedupe-state read/write must have succeeded this run too — if the
 *   system as a whole can't reliably track state, LINE must not push).
 */
export async function runLineBroadcast(env, { allEvents, dedupeAvailable, now = new Date(), dryRun = false }) {
  const result = {
    withinBroadcastHours: isWithinBroadcastHours(now),
    lineReady: false,
    subscriptionsCount: 0,
    broadcastRelevantCount: 0,
    activeNowCount: 0,
    futureWithin60MinCount: 0,
    wouldPushCount: 0,
    pushAttempted: 0,
    pushSucceeded: 0,
    lastLinePushAt: null,
    lineErrors: [],
  };

  const hasToken = Boolean(env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!hasToken) result.lineErrors.push('LINE_CHANNEL_ACCESS_TOKEN not configured');
  if (!dedupeAvailable) result.lineErrors.push('dedupe/baseline state unavailable this run');

  const subsState = await readSubscriptions(env.TRAFFIC_KV);
  if (!subsState.kvAvailable) result.lineErrors.push(`subscriptions unavailable: ${subsState.kvError}`);

  const notifiedState = await readNotifiedState(env.TRAFFIC_KV);
  if (!notifiedState.kvAvailable) result.lineErrors.push(`notified state unavailable: ${notifiedState.kvError}`);

  result.lastLinePushAt = notifiedState.lastLinePushAt || null;

  const targets = subsState.kvAvailable
    ? [
        ...Object.entries(subsState.subscriptions.users || {})
          .filter(([, enabled]) => enabled)
          .map(([id]) => ({ kind: 'user', id })),
        ...Object.entries(subsState.subscriptions.groups || {})
          .filter(([, enabled]) => enabled)
          .map(([id]) => ({ kind: 'group', id })),
      ]
    : [];
  result.subscriptionsCount = targets.length;

  const withWindow = allEvents.map((event) => ({ event, window: computeEffectiveWindow(event, now) }));
  const relevant = withWindow.filter(({ window }) => isBroadcastRelevant(window, now));
  result.broadcastRelevantCount = relevant.length;
  result.activeNowCount = relevant.filter(({ window }) => new Date(window.effectiveStart).getTime() <= now.getTime()).length;
  result.futureWithin60MinCount = result.broadcastRelevantCount - result.activeNowCount;

  const failClosed = !hasToken || !dedupeAvailable || !subsState.kvAvailable || !notifiedState.kvAvailable;
  result.lineReady = !failClosed;

  if (failClosed) return result; // 0 push, whether dry-run or real

  const toNotify = relevant.filter(({ event }) => needsNotification(event, notifiedState.notifiedMap));

  if (dryRun) {
    result.wouldPushCount = result.withinBroadcastHours ? toNotify.length : 0;
    return result;
  }

  if (!result.withinBroadcastHours) return result; // Cron still ran fetch/normalize/baseline, just no push
  if (toNotify.length === 0 || targets.length === 0) return result;

  const successfullyNotified = [];
  for (const { event, window } of toNotify) {
    const startMs = new Date(window.effectiveStart).getTime();
    const forecast = startMs > now.getTime();
    const minutesUntilStart = forecast ? Math.max(1, Math.round((startMs - now.getTime()) / 60000)) : null;
    const text = formatEventMessage(event, { forecast, minutesUntilStart });

    let successCount = 0;
    // Best-effort per target — one target's failure never blocks another,
    // same isolation principle as the TDX sources.
    for (const target of targets) {
      result.pushAttempted += 1;
      try {
        await pushLineMessage(env, target.id, text);
        successCount += 1;
        result.pushSucceeded += 1;
      } catch (err) {
        result.lineErrors.push(`push failed (${target.kind}): ${safeErrorMessage(err)}`);
      }
    }

    if (successCount > 0) {
      successfullyNotified.push(event);
      result.lastLinePushAt = now.toISOString();
    }
    // If successCount === 0, this event stays un-notified and will be
    // retried on the NEXT Cron run — no in-run retry loop.
  }

  if (successfullyNotified.length > 0) {
    // notified state is only ever updated after a confirmed successful
    // send — never speculatively.
    const commit = await markNotified(env.TRAFFIC_KV, notifiedState.notifiedMap, successfullyNotified, now, result.lastLinePushAt);
    if (!commit.committed && commit.error) {
      result.lineErrors.push(`failed to record notified state: ${commit.error}`);
    }
  }

  return result;
}
