// GET /debug/tdx — fetches the production TDX sources and reports, per
// source, how many records were found, a small sample, and any error.
// Never schedules anything; this is a one-shot fetch for manual/CI
// verification. This handler does NOT touch KV/D1 in the traffic/dedupe/
// notified sense — no operational state is ever read or written here.
//
// V1.8.6 used to also write an append-only TDX usage-telemetry entry
// here (context='debug-tdx'). V1.9.2 (TDX Usage Summary retirement — a
// real person now checks TDX's own official back-office dashboard
// directly) removed that KV write: the raw ledger existed solely to feed
// the now-retired tdx:usage:summary:v1 compaction/health-page dashboard
// (see usageLedger.js's own header comment) and had no other reader.
// `tdxUsageSink` is still threaded through fetchAllSources below —
// recordTdxDataCall/recordTdxOAuthCall are pure in-memory pushes,
// completely harmless to keep collecting — it is simply never persisted
// to KV anymore.
//
// V1.6.2: restricted to PRODUCTION_TDX_SOURCE_IDS (freeway+highway) —
// CMS/Bus Alert are retired from production entirely (see V1.6.1) and
// must not be quietly re-fetched just because a human opens this debug
// URL. At most 2 TDX data calls per request.

import { fetchAllSources } from './fetchAll.js';
import { PRODUCTION_TDX_SOURCE_IDS } from './sources.js';

export async function handleDebugTdx(env) {
  const tdxUsageSink = [];
  const { tokenOk, results } = await fetchAllSources(env, { sourceIds: PRODUCTION_TDX_SOURCE_IDS, usageSink: tdxUsageSink });

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
