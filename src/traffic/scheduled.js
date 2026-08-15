// Cron entry point (every 5 minutes, see wrangler.jsonc `triggers.crons`).
// Runs the pipeline and logs a one-line summary. Deliberately does not
// send anything anywhere yet (no LINE/push this round) — the point of
// V1.2A is just to prove fetch -> Hsinchu filter -> KV dedup runs cleanly
// on a schedule; GET /debug/status exposes the same computation on demand.

import { runTdxPipeline } from './pipeline.js';

export async function runScheduledTdxSync(env) {
  const summary = await runTdxPipeline(env);

  const failed = summary.sources.filter((s) => !s.ok).map((s) => s.source);
  console.log(
    `[cron] tokenOk=${summary.tokenOk} totalEvents=${summary.totalEvents} ` +
      `pending=${summary.pendingCount} duplicate=${summary.duplicateCount} ` +
      `kvAvailable=${summary.kvAvailable} kvError=${summary.kvError ?? 'none'} ` +
      `failedSources=${failed.length ? failed.join(',') : 'none'}`
  );

  return summary;
}
