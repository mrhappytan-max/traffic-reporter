// GET /debug/tdx — fetches all 5 sources and reports, per source, how many
// records were found, a small sample, and any error. Never touches KV/D1
// and never schedules anything; this is a one-shot fetch for manual/CI
// verification.

import { getAccessToken } from './auth.js';
import { fetchSource, SOURCES } from './sources.js';

/** Error messages only ever come from our own error classes, which are
 * already careful not to include secrets — this just guards against a
 * non-Error being thrown somewhere unexpected. */
function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

export async function handleDebugTdx(env) {
  let accessToken = null;
  let tokenError = null;

  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    tokenError = safeErrorMessage(err);
  }

  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const startedAt = Date.now();

      if (!accessToken) {
        return {
          source: source.id,
          label: source.label,
          ok: false,
          count: 0,
          rawCount: 0,
          durationMs: 0,
          status: null,
          error: `TDX token unavailable: ${tokenError}`,
        };
      }

      try {
        const { rawItems, normalized } = await fetchSource(source, accessToken);
        return {
          source: source.id,
          label: source.label,
          ok: true,
          count: normalized.length,
          rawCount: rawItems.length,
          durationMs: Date.now() - startedAt,
          sample: normalized.slice(0, 3),
          rawSample: rawItems.slice(0, 1),
        };
      } catch (err) {
        return {
          source: source.id,
          label: source.label,
          ok: false,
          count: 0,
          rawCount: 0,
          durationMs: Date.now() - startedAt,
          status: err && typeof err.status === 'number' ? err.status : null,
          error: safeErrorMessage(err),
        };
      }
    })
  );

  const failedSources = results.filter((r) => !r.ok);
  const totalNormalizedCount = results.reduce((sum, r) => sum + r.count, 0);

  const body = {
    tokenOk: Boolean(accessToken),
    generatedAt: new Date().toISOString(),
    totalNormalizedCount,
    sources: results,
    failedSources: failedSources.map((r) => ({
      source: r.source,
      label: r.label,
      status: r.status,
      error: r.error,
    })),
  };

  // 200 unless every single source failed (including auth failure).
  const allFailed = results.every((r) => !r.ok);
  return Response.json(body, { status: allFailed ? 502 : 200 });
}
