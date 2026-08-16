// Fetches the raw PBS (警廣) road-data JSON from the official endpoint.
// This client only proxies bytes — it never parses, filters, dedups, or
// otherwise interprets the payload. That logic stays in the Cloudflare
// Worker's own src/pbs/* pipeline; this Relay is not wired into it yet.
//
// Retry policy: at most DEFAULT_MAX_ATTEMPTS (2) total requests — the
// initial attempt plus one retry. A retry only happens for timeout,
// network error, or 5xx; a 4xx never retries. A short randomized backoff
// separates the two attempts. No third attempt, ever.

const DEFAULT_PBS_URL = 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 2;
const BACKOFF_MIN_MS = 300;
const BACKOFF_MAX_MS = 1000;

// Honest, conservative identification — no fake browser UA, no cookies,
// no login, no automation.
const USER_AGENT = 'traffic-reporter-pbs-relay/1.0';

export class UpstreamError extends Error {
  constructor(message, { status = null, code = 'unknown' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code; // 'timeout' | 'network' | 'http_status'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBackoffMs() {
  return BACKOFF_MIN_MS + Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS);
}

// 5xx and "no HTTP status at all" (timeout / network error) are
// retryable; a 4xx is not (it won't fix itself by trying again).
function isRetryable(err) {
  if (err instanceof UpstreamError && err.code === 'http_status') {
    return err.status >= 500;
  }
  return true;
}

async function fetchOnce(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new UpstreamError(`PBS upstream request timed out after ${timeoutMs}ms`, { code: 'timeout' });
    }
    throw new UpstreamError(`Network error calling PBS upstream: ${err && err.message}`, { code: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new UpstreamError(`PBS upstream responded with HTTP ${response.status} ${response.statusText}`, {
      status: response.status,
      code: 'http_status',
    });
  }

  // Raw text only — never JSON.parse + re-stringify. Fields, key order,
  // and number formatting stay byte-for-byte whatever PBS sent.
  return response.text();
}

/**
 * @returns {Promise<{ rawText: string, attempts: number, durationMs: number }>}
 *   Throws UpstreamError (with .attempts/.durationMs set) after maxAttempts
 *   failed attempts, or immediately on a non-retryable (4xx) failure.
 */
export async function fetchPbsUpstream({
  fetchImpl = globalThis.fetch,
  url = DEFAULT_PBS_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  const startedAt = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    try {
      const rawText = await fetchOnce(fetchImpl, url, timeoutMs);
      return { rawText, attempts: attemptsMade, durationMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxAttempts && isRetryable(err);
      if (!canRetry) break;
      await sleep(randomBackoffMs());
    }
  }

  lastError.attempts = attemptsMade;
  lastError.durationMs = Date.now() - startedAt;
  throw lastError;
}

export { DEFAULT_PBS_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS };
