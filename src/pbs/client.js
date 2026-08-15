// Fetches the PBS (警察廣播電臺) real-time road-condition JSON. Official
// JSON endpoint only — never the RoadAll.html page. No API key needed.
// Isolated from TDX on purpose: a PBS outage must never affect TDX's own
// fetch/normalize/dedupe/LINE-push pipeline, and vice versa.

import { extractArray } from '../tdx/extract.js';
import { PBS_ENDPOINT_URL, PBS_FETCH_TIMEOUT_MS } from './pbsConfig.js';

export class PbsFetchError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'PbsFetchError';
    this.status = status;
  }
}

/**
 * @returns {Promise<object[]>} the raw PBS record array. Throws
 *   PbsFetchError on timeout/network/HTTP failure — callers must catch
 *   this and degrade gracefully (see pipeline.js), never let it propagate
 *   into the TDX pipeline.
 */
export async function fetchPbsData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PBS_FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(PBS_ENDPOINT_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new PbsFetchError(`PBS request timed out after ${PBS_FETCH_TIMEOUT_MS}ms`);
    }
    throw new PbsFetchError(`Network error calling PBS: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch {
      // ignore — body isn't required for the error to be useful
    }
    throw new PbsFetchError(
      `PBS API responded with HTTP ${response.status} ${response.statusText}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      { status: response.status }
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new PbsFetchError(`Failed to parse PBS JSON: ${err.message}`);
  }

  // Defensive envelope handling, same pattern as TDX's extractArray — the
  // exact wrapper shape (bare array vs {data:[...]}) isn't confirmed live
  // in this session.
  return extractArray(json, ['data', 'items', 'result', 'RoadData', 'roadData']);
}
