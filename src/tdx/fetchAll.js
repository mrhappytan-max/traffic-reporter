// Shared "fetch every source, let each one fail independently" pipeline.
// Used by GET /debug/tdx, GET /debug/status, and the Cron scheduled
// handler so there's exactly one place that knows how to degrade
// gracefully when the token or an individual source is unavailable.

import { getAccessToken } from './auth.js';
import { fetchSource, SOURCES } from './sources.js';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown error';
}

/**
 * @returns {{ tokenOk: boolean, results: Array<{
 *   source: string, label: string, ok: boolean, count: number,
 *   rawCount: number, durationMs: number, events: object[],
 *   rawSample: object[], status: number|null, error: string|null,
 * }> }}
 */
export async function fetchAllSources(env) {
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
          events: [],
          rawSample: [],
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
          events: normalized,
          rawSample: rawItems.slice(0, 1),
          status: null,
          error: null,
        };
      } catch (err) {
        return {
          source: source.id,
          label: source.label,
          ok: false,
          count: 0,
          rawCount: 0,
          durationMs: Date.now() - startedAt,
          events: [],
          rawSample: [],
          status: err && typeof err.status === 'number' ? err.status : null,
          error: safeErrorMessage(err),
        };
      }
    })
  );

  return { tokenOk: Boolean(accessToken), results };
}
