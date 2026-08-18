// GET /debug/tdx — fetches the production TDX sources and reports, per
// source, how many records were found, a small sample, and any error.
// Never schedules anything; this is a one-shot fetch for manual/CI
// verification. CORRECTED comment (V1.8.6): this handler does NOT touch
// KV/D1 in the traffic/dedupe/notified sense — no operational state is
// ever read or written here. The one exception is deliberate and
// isolated: it writes an append-only TDX usage-telemetry entry (see
// ../tdx/usageLedger.js, context='debug-tdx') so a human opening this
// URL is visible on /health's "人工額外呼叫" line instead of silently
// inflating what looks like Production's own count. That write can never
// affect this handler's own response, and a usage-ledger KV outage
// degrades to "this call's usage entry is missing," never to an error
// here.
//
// V1.6.2: restricted to PRODUCTION_TDX_SOURCE_IDS (freeway+highway) —
// CMS/Bus Alert are retired from production entirely (see V1.6.1) and
// must not be quietly re-fetched just because a human opens this debug
// URL. At most 2 TDX data calls per request.

import { fetchAllSources } from './fetchAll.js';
import { PRODUCTION_TDX_SOURCE_IDS } from './sources.js';
import { commitTdxUsageBatch } from './usageLedger.js';

export async function handleDebugTdx(env) {
  // V1.8.6: tagged context='debug-tdx' in the usage ledger — see
  // debugStatus.js's identical comment for why (visible on /health as
  // "人工額外呼叫", not silently counted as Production).
  const tdxUsageSink = [];
  const { tokenOk, results } = await fetchAllSources(env, { sourceIds: PRODUCTION_TDX_SOURCE_IDS, usageSink: tdxUsageSink });
  await commitTdxUsageBatch(env.TRAFFIC_KV, { context: 'debug-tdx', records: tdxUsageSink });

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
