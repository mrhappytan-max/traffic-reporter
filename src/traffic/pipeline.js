// Full V1.2A pipeline: fetch all 5 TDX sources (Hsinchu geo-filter and
// noise filters already applied per-source, see src/tdx/sources.js) ->
// dedupe against KV -> return the pending-to-broadcast events.
//
// This does not send anything anywhere (no LINE/push) — it only computes
// and returns/records state. Used by both the Cron scheduled handler and
// GET /debug/status.

import { fetchAllSources } from '../tdx/fetchAll.js';
import { filterNewEvents } from './dedupe.js';

export async function runTdxPipeline(env) {
  const { tokenOk, results } = await fetchAllSources(env);
  const allEvents = results.flatMap((r) => r.events);

  const dedupe = await filterNewEvents(env.TRAFFIC_KV, allEvents);

  return {
    tokenOk,
    generatedAt: new Date().toISOString(),
    sources: results.map((r) => ({
      source: r.source,
      label: r.label,
      ok: r.ok,
      count: r.count,
      rawCount: r.rawCount,
      status: r.status,
      error: r.error,
    })),
    totalEvents: allEvents.length,
    pendingCount: dedupe.pending.length,
    duplicateCount: dedupe.duplicates.length,
    kvAvailable: dedupe.kvAvailable,
    kvError: dedupe.kvError,
    pending: dedupe.pending,
    duplicates: dedupe.duplicates,
  };
}
