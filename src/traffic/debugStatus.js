// GET /debug/status — read-only preview of the full pipeline (fetch TDX ->
// normalize -> Hsinchu filter -> read KV dedup state -> classify). This
// endpoint is deliberately incapable of writing: it calls
// runTdxPipelinePreview, which never calls commitDedupeState, so opening
// this URL any number of times can never create the baseline, mark events
// as seen, or otherwise change what the next Cron run decides. Only the
// scheduled handler (src/traffic/scheduled.js) commits state.

import { runTdxPipelinePreview } from './pipeline.js';

// Safety cap so a runaway source can't blow up the response payload.
const MAX_LISTED_EVENTS = 100;

export async function handleDebugStatus(env) {
  const summary = await runTdxPipelinePreview(env);

  const body = {
    lastRunAt: summary.lastRunAt,
    tokenOk: summary.tokenOk,
    baselineInitialized: summary.baselineInitialized,
    kvAvailable: summary.kvAvailable,
    kvError: summary.kvError,
    rawCounts: summary.rawCounts,
    normalizedCount: summary.normalizedCount,
    hsinchuFilteredCount: summary.hsinchuFilteredCount,
    newEventsCount: summary.newEventsCount,
    updatedEventsCount: summary.updatedEventsCount,
    duplicateCount: summary.duplicateCount,
    pushableEventsCount: summary.pushableEventsCount,
    baselineSeedCount: summary.baselineSeedCount,
    missingKeysCount: summary.missingKeysCount,
    failedSources: summary.failedSources,
    errors: summary.errors,
    sources: summary.sources,
    sample: summary.sample,
    pending: summary.pending.slice(0, MAX_LISTED_EVENTS),
  };

  return Response.json(body, { status: summary.tokenOk ? 200 : 502 });
}
