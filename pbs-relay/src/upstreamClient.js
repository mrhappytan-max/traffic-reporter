// Fetches the raw PBS (警廣) road-data JSON from the official endpoint.
// This client only proxies bytes — it never parses, filters, dedups, or
// otherwise interprets the payload. That logic stays in the Cloudflare
// Worker's own src/pbs/* pipeline; this Relay is not wired into it yet.
//
// Retry policy (unchanged this round): at most DEFAULT_MAX_ATTEMPTS (2)
// total requests — the initial attempt plus one retry. A retry only
// happens for timeout, network error, or 5xx; a 4xx never retries. A
// short randomized backoff separates the two attempts. No third
// attempt, ever.
//
// This round adds diagnostic logging only (see log.js) — every attempt,
// its outcome (success/http-error/timeout/network-error), and the
// retry-or-not decision are logged with a requestId for correlation.
// Nothing about the fetch/retry/timeout behavior itself changed.

import {
  logUpstreamAttemptStart,
  logUpstreamSuccess,
  logUpstreamHttpError,
  logUpstreamTimeout,
  logUpstreamNetworkError,
  logRetryScheduled,
  logNoRetry,
} from './log.js';

const DEFAULT_PBS_URL = 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 2;
const BACKOFF_MIN_MS = 300;
const BACKOFF_MAX_MS = 1000;

// Honest, conservative identification — no fake browser UA, no cookies,
// no login, no automation.
const USER_AGENT = 'traffic-reporter-pbs-relay/1.0';

export class UpstreamError extends Error {
  constructor(message, { status = null, code = 'unknown', errorName = null, errorCode = null, causeName = null, causeCode = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code; // 'timeout' | 'network' | 'http_status'
    // Raw diagnostic fields, only ever used for logging — never surfaced
    // in the HTTP response (response schema is unchanged this round).
    this.errorName = errorName;
    this.errorCode = errorCode;
    this.causeName = causeName;
    this.causeCode = causeCode;
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

// timeout/network/5xx/4xx/other — used only for the retry-decision log
// line's `reason=` field.
function classifyReason(err) {
  if (!(err instanceof UpstreamError)) return 'other';
  if (err.code === 'timeout') return 'timeout';
  if (err.code === 'network') return 'network';
  if (err.code === 'http_status' && err.status != null) {
    if (err.status >= 500) return '5xx';
    if (err.status >= 400) return '4xx';
  }
  return 'other';
}

function safeMessage(err) {
  return err && typeof err.message === 'string' ? err.message : 'Unknown error';
}

async function fetchOnce(fetchImpl, url, timeoutMs, { requestId, attempt }) {
  logUpstreamAttemptStart({ requestId, attempt, url });
  const attemptStartedAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    const durationMs = Date.now() - attemptStartedAt;

    if (err && err.name === 'AbortError') {
      const errorCode = err && err.code != null ? err.code : null;
      logUpstreamTimeout({ requestId, attempt, durationMs, errorName: err.name, errorCode });
      throw new UpstreamError(`PBS upstream request timed out after ${timeoutMs}ms`, {
        code: 'timeout',
        errorName: err.name,
        errorCode,
      });
    }

    // undici's fetch wraps DNS/TLS/connection-refused failures as
    // `TypeError: fetch failed` with the real system error (with its own
    // .name/.code, e.g. ENOTFOUND for DNS) on `err.cause`. Only these
    // three primitive fields are ever read — never the whole error or
    // cause object — so nothing beyond what's explicitly listed here can
    // end up in a log line.
    const errorName = err && err.name ? err.name : null;
    const errorCode = err && err.code != null ? err.code : null;
    const cause = err && err.cause;
    const causeName = cause && cause.name ? cause.name : null;
    const causeCode = cause && cause.code != null ? cause.code : null;
    const causeMessage = cause && typeof cause.message === 'string' ? cause.message : null;

    logUpstreamNetworkError({
      requestId,
      attempt,
      durationMs,
      errorName,
      errorCode: errorCode ?? causeCode,
      causeCode,
      message: causeMessage || safeMessage(err),
    });
    throw new UpstreamError(`Network error calling PBS upstream: ${safeMessage(err)}`, {
      code: 'network',
      errorName,
      errorCode,
      causeName,
      causeCode,
    });
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - attemptStartedAt;

  if (!response.ok) {
    logUpstreamHttpError({ requestId, attempt, status: response.status, durationMs });
    throw new UpstreamError(`PBS upstream responded with HTTP ${response.status} ${response.statusText}`, {
      status: response.status,
      code: 'http_status',
    });
  }

  const contentType = response.headers.get('content-type');
  // Raw text only — never JSON.parse + re-stringify. Fields, key order,
  // and number formatting stay byte-for-byte whatever PBS sent.
  const rawText = await response.text();
  logUpstreamSuccess({ requestId, attempt, status: response.status, durationMs, contentType });
  return { rawText, contentType };
}

/**
 * @returns {Promise<{ rawText: string, contentType: string|null, attempts: number, durationMs: number }>}
 *   Throws UpstreamError (with .attempts/.durationMs set) after maxAttempts
 *   failed attempts, or immediately on a non-retryable (4xx) failure.
 */
export async function fetchPbsUpstream({
  fetchImpl = globalThis.fetch,
  url = DEFAULT_PBS_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  requestId = null,
} = {}) {
  const startedAt = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    try {
      const { rawText, contentType } = await fetchOnce(fetchImpl, url, timeoutMs, { requestId, attempt });
      return { rawText, contentType, attempts: attemptsMade, durationMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxAttempts && isRetryable(err);
      const reason = classifyReason(err);
      if (!canRetry) {
        logNoRetry({ requestId, reason });
        break;
      }
      const backoffMs = randomBackoffMs();
      logRetryScheduled({ requestId, nextAttempt: attempt + 1, reason, backoffMs: Math.round(backoffMs) });
      await sleep(backoffMs);
    }
  }

  lastError.attempts = attemptsMade;
  lastError.durationMs = Date.now() - startedAt;
  throw lastError;
}

export { DEFAULT_PBS_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS };
