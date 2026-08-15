// GET /debug/tdx — fetches all 5 sources and reports, per source, how many
// records were found, a small sample, and any error. Never touches KV/D1
// and never schedules anything; this is a one-shot fetch for manual/CI
// verification.

import { fetchAllSources } from './fetchAll.js';

export async function handleDebugTdx(env) {
  const { tokenOk, results } = await fetchAllSources(env);

  const sources = results.map((r) => ({
    source: r.source,
    label: r.label,
    ok: r.ok,
    count: r.count,
    rawCount: r.rawCount,
    durationMs: r.durationMs,
    status: r.status,
    error: r.error,
    ...(r.ok ? { sample: r.events.slice(0, 3), rawSample: r.rawSample } : {}),
  }));

  const failedSources = sources
    .filter((s) => !s.ok)
    .map(({ source, label, status, error }) => ({ source, label, status, error }));

  const totalNormalizedCount = results.reduce((sum, r) => sum + r.count, 0);

  const body = {
    tokenOk,
    generatedAt: new Date().toISOString(),
    totalNormalizedCount,
    sources,
    failedSources,
  };

  // 200 unless every single source failed (including auth failure).
  const allFailed = results.every((r) => !r.ok);
  return Response.json(body, { status: allFailed ? 502 : 200 });
}
