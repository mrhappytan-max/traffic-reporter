// PBS is an isolated, best-effort data source. Its relay failures never
// propagate into TDX, LINE, or the scheduled handler.

import { fetchPbsData } from './client.js';
import { normalizePbsEvent } from './normalize.js';
import { isPbsEventHsinchuRelevant } from './hsinchuFilter.js';
import { readPbsLifecycleState, classifyPbsLifecycle, commitPbsLifecycleState } from './lifecycle.js';
import { crossSourceDedup } from './crossSourceDedup.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

async function runPbsCore(env, now) {
  let rawItems = [];
  let pbsOk = true;
  let pbsError = null;
  let attempts = null;
  let durationMs = null;
  let relayConfigured = false;
  let relayOk = false;
  let relayStatus = null;
  let relayCache = null;
  let relayUpstreamDurationMs = null;

  try {
    const result = await fetchPbsData(env);
    rawItems = result.items;
    attempts = result.attempts;
    durationMs = result.durationMs;
    relayConfigured = result.relayConfigured;
    relayOk = result.relayOk;
    relayStatus = result.relayStatus;
    relayCache = result.relayCache;
    relayUpstreamDurationMs = result.relayUpstreamDurationMs;
  } catch (err) {
    pbsOk = false;
    pbsError = safeErrorMessage(err);
    attempts = typeof err.attempts === 'number' ? err.attempts : null;
    durationMs = typeof err.durationMs === 'number' ? err.durationMs : null;
    relayConfigured = Boolean(err.relayConfigured);
    relayOk = Boolean(err.relayOk);
    relayStatus = typeof err.relayStatus === 'number' ? err.relayStatus : null;
    relayCache = typeof err.relayCache === 'string' ? err.relayCache : null;
    relayUpstreamDurationMs = typeof err.relayUpstreamDurationMs === 'number' ? err.relayUpstreamDurationMs : null;
  }

  const normalized = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      normalized.push(normalizePbsEvent(raw));
    } catch {
      // A malformed PBS record cannot fail the feed.
    }
  }

  const hsinchuFiltered = normalized.filter(isPbsEventHsinchuRelevant);
  const { clearedEvents, staleEvents, activeEvents, seenIds } = classifyPbsLifecycle(hsinchuFiltered, now);
  const lifecycleState = await readPbsLifecycleState(env.TRAFFIC_KV);

  return {
    rawItems,
    normalized,
    hsinchuFiltered,
    clearedEvents,
    staleEvents,
    activeEvents,
    seenIds,
    pbsOk,
    pbsError,
    attempts,
    durationMs,
    relayConfigured,
    relayOk,
    relayStatus,
    relayCache,
    relayUpstreamDurationMs,
    lifecycleState,
  };
}

function buildSummary(core, tdxEvents, commitResult) {
  const { rawItems, hsinchuFiltered, clearedEvents, staleEvents, activeEvents, pbsOk, pbsError, attempts, durationMs, relayConfigured, relayOk, relayStatus, relayCache, relayUpstreamDurationMs, lifecycleState } = core;
  const { canonicalEvents, duplicatePbsEvents, uniquePbsEvents } = crossSourceDedup(activeEvents, tdxEvents);

  return {
    pbsOk,
    pbsError,
    attempts,
    durationMs,
    pbsTransport: 'vpc-relay',
    relayConfigured,
    relayOk,
    relayStatus,
    relayDurationMs: durationMs,
    relayCache,
    relayUpstreamDurationMs,
    kvAvailable: lifecycleState.kvAvailable,
    kvError: lifecycleState.kvError,
    committed: Boolean(commitResult && commitResult.committed),
    commitReason: commitResult ? commitResult.reason || null : null,
    rawCount: rawItems.length,
    hsinchuCount: hsinchuFiltered.length,
    activeCount: activeEvents.length,
    clearedCount: clearedEvents.length,
    staleCount: staleEvents.length,
    filteredCount: uniquePbsEvents.length,
    crossSourceDuplicateCount: duplicatePbsEvents.length,
    canonicalEventCount: canonicalEvents.length,
    canonicalEvents,
    uniquePbsEvents,
    activeEvents,
    rawSample: rawItems.slice(0, 2),
    normalizedSample: hsinchuFiltered.slice(0, 3),
    clearedSample: clearedEvents.slice(0, 2),
    staleSample: staleEvents.slice(0, 2),
    crossSourceSample: canonicalEvents.slice(0, 2),
  };
}

export async function runPbsPipelinePreview(env, { tdxEvents = [], now = new Date() } = {}) {
  const core = await runPbsCore(env, now);
  return buildSummary(core, tdxEvents, null);
}

export async function runPbsPipelineAndCommit(env, { tdxEvents = [], now = new Date() } = {}) {
  const core = await runPbsCore(env, now);
  let commitResult = { committed: false, reason: 'kv-unavailable' };
  if (core.lifecycleState.kvAvailable) {
    commitResult = await commitPbsLifecycleState(
      env.TRAFFIC_KV,
      core.lifecycleState.pbsMap,
      { clearedEvents: core.clearedEvents, activeEvents: core.activeEvents, seenIds: core.seenIds },
      core.pbsOk,
      now
    );
  }
  return buildSummary(core, tdxEvents, commitResult);
}
