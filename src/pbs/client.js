// Fetches the PBS (警察廣播電臺) real-time road-condition JSON. Official
// JSON endpoint only — never the RoadAll.html page. No API key needed.
// Isolated from TDX on purpose: a PBS outage must never affect TDX's own
// fetch/normalize/dedupe/LINE-push pipeline, and vice versa.
//
// Retry policy: at most PBS_MAX_ATTEMPTS (2) total requests — the initial
// attempt plus one retry. A retry only happens for timeout, network error,
// or 5xx; a 4xx never retries (client-side/permanent errors won't fix
// themselves by trying again). A short randomized backoff separates the
// two attempts. Both `fetchPbsData`'s success return value and the
// PbsFetchError thrown on total failure carry `attempts` and `durationMs`
// so callers (pipeline.js -> /debug/pbs) can show exactly what happened.

import { extractArray } from '../tdx/extract.js';
import {
  PBS_ENDPOINT_URL,
  PBS_FETCH_TIMEOUT_MS,
  PBS_MAX_ATTEMPTS,
  PBS_RETRY_BACKOFF_MIN_MS,
  PBS_RETRY_BACKOFF_MAX_MS,
} from './pbsConfig.js';

export class PbsFetchError extends Error {
  constructor(message, { status = null, attempts = null, durationMs = null } = {}) {
    super(message);
    this.name = 'PbsFetchError';
    this.status = status;
    this.attempts = attempts;
    this.durationMs = durationMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBackoffMs() {
  return PBS_RETRY_BACKOFF_MIN_MS + Math.random() * (PBS_RETRY_BACKOFF_MAX_MS - PBS_RETRY_BACKOFF_MIN_MS);
}

// 5xx and "no HTTP status at all" (timeout / network error) are
// retryable; any other status (4xx) is not.
function isRetryableFailure(err) {
  if (err instanceof PbsFetchError && err.status != null) {
    return err.status >= 500;
  }
  return true;
}

async function fetchOnce() {
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

/**
 * @returns {Promise<{ items: object[], attempts: number, durationMs: number }>}
 *   Throws PbsFetchError (with .attempts/.durationMs set) after
 *   PBS_MAX_ATTEMPTS failed attempts, or immediately on a non-retryable
 *   (4xx) failure. Callers must catch this and degrade gracefully (see
 *   pipeline.js), never let it propagate into the TDX pipeline.
 */
export async function fetchPbsData() {
  const startedAt = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= PBS_MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    try {
      const items = await fetchOnce();
      return { items, attempts: attemptsMade, durationMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      const canRetry = attempt < PBS_MAX_ATTEMPTS && isRetryableFailure(err);
      if (!canRetry) break;
      await sleep(randomBackoffMs());
    }
  }

  lastError.attempts = attemptsMade;
  lastError.durationMs = Date.now() - startedAt;
  throw lastError;
}
