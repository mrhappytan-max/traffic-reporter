// GET /debug/status — runs the full pipeline (fetch -> Hsinchu geo-filter
// -> noise filter -> KV dedup) on demand, so the dedup/geo-filter logic can
// be checked without waiting for the next Cron tick. Does not send
// anything anywhere.

import { runTdxPipeline } from './pipeline.js';

// Safety cap so a runaway source can't blow up the response payload.
const MAX_LISTED_EVENTS = 100;

export async function handleDebugStatus(env) {
  const summary = await runTdxPipeline(env);

  const body = {
    tokenOk: summary.tokenOk,
    generatedAt: summary.generatedAt,
    sources: summary.sources,
    totalEvents: summary.totalEvents,
    pendingCount: summary.pendingCount,
    duplicateCount: summary.duplicateCount,
    kvAvailable: summary.kvAvailable,
    kvError: summary.kvError,
    pending: summary.pending.slice(0, MAX_LISTED_EVENTS),
    duplicateSample: summary.duplicates.slice(0, 5),
  };

  return Response.json(body, { status: summary.tokenOk ? 200 : 502 });
}
