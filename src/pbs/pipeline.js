// PBS is an isolated, best-effort data source. Its relay failures never
// propagate into TDX, LINE, or the scheduled handler.

import { fetchPbsData } from './client.js';
import { normalizePbsEvent } from './normalize.js';
import { isPbsEventHsinchuRelevant } from './hsinchuFilter.js';
import { readPbsLifecycleState, classifyPbsLifecycle, commitPbsLifecycleState } from './lifecycle.js';
import { crossSourceDedup } from './crossSourceDedup.js';
import { isTdxRuntimeEnabled } from '../traffic/sourceMode.js';

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

const ZERO_PBS_TRANSITIONS = { newCount: 0, updatedCount: 0, newlyClearedCount: 0 };

function buildSummary(core, tdxEvents, commitResult, env) {
  const { rawItems, hsinchuFiltered, clearedEvents, staleEvents, activeEvents, pbsOk, pbsError, attempts, durationMs, relayConfigured, relayOk, relayStatus, relayCache, relayUpstreamDurationMs, lifecycleState } = core;
  // 2026-08-24 — V57.2's 國道 gate defers a PBS 國道 event to a more
  // authoritative TDX report of the same incident. That only makes sense
  // while TDX is actually running: in PBS-only mode no TDX event can ever
  // arrive, so the gate would drop every 國道 PBS accident forever (a real
  // Production case did exactly that). Derived from the SAME source-mode
  // switch that turns TDX off, so the two can never disagree, and restoring
  // TRAFFIC_SOURCE_MODE=ALL restores V57.2 with no further change.
  const requireTdxCorrelationForFreeway = isTdxRuntimeEnabled(env);
  const { canonicalEvents, duplicatePbsEvents, uniquePbsEvents, filteredFreewayEvents } = crossSourceDedup(
    activeEvents,
    tdxEvents,
    { requireTdxCorrelationForFreeway }
  );

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
    // V1.9.3 (KV Write Optimization Phase 2) — real per-UID transition
    // counts from commitPbsLifecycleState's own comparison (see
    // lifecycle.js), so scheduled.js can tell "PBS fetched, but every
    // active event is exactly the same as last round" apart from a
    // genuine new/updated/cleared change, WITHOUT re-deriving a second
    // copy of that comparison. Always present (zeros when nothing
    // transitioned, e.g. a healthy fetch with no lifecycle change, or a
    // failed fetch where commitResult itself is the source-unhealthy
    // shape) — never omitted.
    pbsNewCount: (commitResult && commitResult.transitions ? commitResult.transitions : ZERO_PBS_TRANSITIONS).newCount,
    pbsUpdatedCount: (commitResult && commitResult.transitions ? commitResult.transitions : ZERO_PBS_TRANSITIONS).updatedCount,
    pbsNewlyClearedCount: (commitResult && commitResult.transitions ? commitResult.transitions : ZERO_PBS_TRANSITIONS)
      .newlyClearedCount,
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
    // V57.2 — 國道 PBS events with no TDX match this run: never a
    // broadcast candidate (see crossSourceDedup.js's own header comment),
    // kept here purely for internal observability/log/stats, exactly as
    // the product spec allows ("可以保留作內部觀察、log、統計或原始資料
    // 來源").
    freewayGatedCount: filteredFreewayEvents.length,
    freewayGatedEvents: filteredFreewayEvents,
    // 2026-08-24 — makes the mode-aware bypass readable instead of leaving
    // a future reader to wonder why freewayGatedCount is always 0. When
    // false, an unmatched 國道 PBS event is a normal broadcast candidate
    // and freewayGatedEvents is empty BY DESIGN, not because nothing
    // matched the gate.
    tdxCorrelationRequired: requireTdxCorrelationForFreeway,
    eligibilitySource: requireTdxCorrelationForFreeway ? 'PBS+TDX' : 'PBS',
    activeEvents,
    rawSample: rawItems.slice(0, 2),
    normalizedSample: hsinchuFiltered.slice(0, 3),
    clearedSample: clearedEvents.slice(0, 2),
    staleSample: staleEvents.slice(0, 2),
    crossSourceSample: canonicalEvents.slice(0, 2),
    freewayGatedSample: filteredFreewayEvents.slice(0, 2),
  };
}

export async function runPbsPipelinePreview(env, { tdxEvents = [], now = new Date() } = {}) {
  const core = await runPbsCore(env, now);
  return buildSummary(core, tdxEvents, null, env);
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
  return buildSummary(core, tdxEvents, commitResult, env);
}
