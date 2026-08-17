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
 * @param {object} env
 * @param {object} [options]
 * @param {string[]} [options.sourceIds] - V1.6.1: when given, only fetch
 *   these SOURCES ids (see sources.js's PRODUCTION_TDX_SOURCE_IDS) —
 *   used by the Cron path to stop scheduling CMS/Bus Alert entirely.
 *   Omitted (the default) fetches all 5, unchanged — GET /debug/tdx and
 *   GET /debug/status both call this with no options and keep their full
 *   existing behavior.
 * @returns {{ tokenOk: boolean, results: Array<{
 *   source: string, label: string, ok: boolean, count: number,
 *   normalizedCount: number, rawCount: number, durationMs: number,
 *   events: object[], rawSample: object[], status: number|null,
 *   error: string|null,
 * }> }}
 *
 * `count` = post-filter (Hsinchu-relevant / noise-filtered) event count,
 * used everywhere the old behavior already relied on it (e.g. /debug/tdx).
 * `normalizedCount` = successfully-parsed count *before* that filter, for
 * /debug/status's normalizedCount vs. hsinchuFilteredCount distinction.
 */
export async function fetchAllSources(env, { sourceIds } = {}) {
  let accessToken = null;
  let tokenError = null;

  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    tokenError = safeErrorMessage(err);
  }

  const sourcesToFetch = sourceIds ? SOURCES.filter((s) => sourceIds.includes(s.id)) : SOURCES;

  const results = await Promise.all(
    sourcesToFetch.map(async (source) => {
      const startedAt = Date.now();

      if (!accessToken) {
        return {
          source: source.id,
          label: source.label,
          ok: false,
          count: 0,
          normalizedCount: 0,
          rawCount: 0,
          durationMs: 0,
          events: [],
          rawSample: [],
          status: null,
          error: `TDX token unavailable: ${tokenError}`,
        };
      }

      try {
        const { rawItems, normalizedAll, normalized } = await fetchSource(source, accessToken);
        return {
          source: source.id,
          label: source.label,
          ok: true,
          count: normalized.length,
          normalizedCount: normalizedAll.length,
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
          normalizedCount: 0,
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
