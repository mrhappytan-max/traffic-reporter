// GET /debug/pbs — fully read-only PBS-focused debug view. Runs the PBS
// pipeline in preview mode (never writes KV, never calls LINE) against
// this run's live TDX events (also fetched fresh, not persisted here).

import { runTdxPipelinePreview } from '../traffic/pipeline.js';
import { runPbsPipelinePreview } from './pipeline.js';
import { PBS_BROADCAST_ENABLED } from './pbsConfig.js';

export async function handleDebugPbs(env) {
  const now = new Date();
  const tdxSummary = await runTdxPipelinePreview(env);
  const pbsSummary = await runPbsPipelinePreview(env, { tdxEvents: tdxSummary.allEvents, now });

  const body = {
    generatedAt: now.toISOString(),
    pbsOk: pbsSummary.pbsOk,
    pbsError: pbsSummary.pbsError,
    attempts: pbsSummary.attempts,
    durationMs: pbsSummary.durationMs,
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
