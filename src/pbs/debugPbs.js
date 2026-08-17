// GET /debug/pbs — fully read-only PBS-focused debug view. Runs the PBS
// pipeline in preview mode (never writes KV, never calls LINE).
//
// V1.6.2: this endpoint must cost ZERO TDX API calls — it's a PBS-only
// diagnostic page. crossSourceDuplicateCount's matching input now comes
// from the small KV cache of the last successful SCHEDULED TDX fetch
// (see ../traffic/tdxEventCache.js) instead of a live TDX preview fetch;
// a stale (>30 min) or missing cache degrades to tdxEvents=[] (every PBS
// event reads as "unique" — never a live TDX request either way).

import { runPbsPipelinePreview } from './pipeline.js';
import { PBS_BROADCAST_ENABLED } from './pbsConfig.js';
import { readProductionTdxEventCache } from '../traffic/tdxEventCache.js';

export async function handleDebugPbs(env) {
  const now = new Date();
  const tdxCache = await readProductionTdxEventCache(env.TRAFFIC_KV, now);
  const pbsSummary = await runPbsPipelinePreview(env, { tdxEvents: tdxCache.events, now });

  const body = {
    generatedAt: now.toISOString(),
    // Diagnostic only — when this cache was last written by a real
    // scheduled TDX fetch, and whether it was too old to use for THIS
    // request's crossSourceDuplicateCount. Never a raw TDX call.
    tdxCacheLastFetchedAt: tdxCache.lastFetchedAt,
    tdxCacheStale: tdxCache.stale,
    pbsOk: pbsSummary.pbsOk,
    pbsError: pbsSummary.pbsError,
    attempts: pbsSummary.attempts,
    durationMs: pbsSummary.durationMs,
    pbsTransport: pbsSummary.pbsTransport,
    relayConfigured: pbsSummary.relayConfigured,
    relayOk: pbsSummary.relayOk,
    relayStatus: pbsSummary.relayStatus,
    relayDurationMs: pbsSummary.relayDurationMs,
    relayCache: pbsSummary.relayCache,
    relayUpstreamDurationMs: pbsSummary.relayUpstreamDurationMs,
    kvAvailable: pbsSummary.kvAvailable,
    kvError: pbsSummary.kvError,
    pbsBroadcastEnabled: PBS_BROADCAST_ENABLED,
    rawCount: pbsSummary.rawCount,
    hsinchuCount: pbsSummary.hsinchuCount,
    activeCount: pbsSummary.activeCount,
    clearedCount: pbsSummary.clearedCount,
    staleCount: pbsSummary.staleCount,
    filteredCount: pbsSummary.filteredCount,
    crossSourceDuplicateCount: pbsSummary.crossSourceDuplicateCount,
    canonicalEventCount: pbsSummary.canonicalEventCount,
    rawSample: pbsSummary.rawSample,
    normalizedSample: pbsSummary.normalizedSample,
    clearedSample: pbsSummary.clearedSample,
    staleSample: pbsSummary.staleSample,
    crossSourceSample: pbsSummary.crossSourceSample,
  };

  return Response.json(body, { status: pbsSummary.pbsOk ? 200 : 502 });
}
