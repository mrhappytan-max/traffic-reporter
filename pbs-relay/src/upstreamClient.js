// Fetches the raw PBS (警廣) road-data JSON from the official endpoint.
// This client only proxies bytes — it never parses, filters, dedups, or
// otherwise interprets the payload. That logic stays in the Cloudflare
// Worker's own src/pbs/* pipeline; this Relay is not wired into it yet.
//
// The upstream request is deliberately kept equivalent to plain
// `fetch(url)` — no custom headers of any kind. A live A/B repro
// (comparing this against plain fetch(url) on the same machine) showed
// PBS answering `Accept: application/json` with 406 Not Acceptable; PBS
// only ever serves text/plain;charset=UTF-8, so demanding
// application/json via Accept is a request it genuinely can't satisfy.
// See fetchOnce() below — the only addition over plain fetch(url) is
// the AbortSignal used for the timeout.
//
// Retry policy (unchanged this round): at most DEFAULT_MAX_ATTEMPTS (2)
// total requests — the initial attempt plus one retry. A retry only
// happens for timeout, network error, or 5xx; a 4xx never retries. A
// short randomized backoff separates the two attempts. No third
// attempt, ever.
//
// Diagnostic logging (see log.js): every attempt, its outcome (success/
// http-error/timeout/network-error), and the retry-or-not decision are
// logged with a requestId for correlation.

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

  // Bug fixed this round: the fetch() call and the response.text() body
  // read used to be two separate steps, with only fetch() wrapped in
  // try/catch and the abort timer cleared right after fetch() resolved.
  // fetch() itself resolves as soon as HEADERS arrive — the body (here,
  // a ~300KB JSON payload) streams in afterward. That meant:
  //   1. A failure while reading the body (a reset connection mid-
  //      download, an abort that should still apply while streaming,
  //      etc.) was never caught here at all — it escaped as a raw,
  //      unclassified error, with no [PBS] timeout/network-error log
  //      line, no requestId, nothing actionable.
  //   2. The 15s timeout stopped protecting the request the moment
  //      headers arrived, instead of covering the full request
  //      including the body — not the "15 second timeout" this was
  //      documented as.
  // Both are fixed by wrapping the fetch call AND the body read in the
  // same try/catch/finally, so any failure in either phase gets the
  // same timeout/network classification and logging, and the abort
  // timer stays armed for the whole attempt.
  // Real evidence (a live Windows repro comparing this against plain
  // fetch(url)): sending `Accept: application/json` made PBS respond
  // with 406 Not Acceptable — PBS only ever serves
  // text/plain;charset=UTF-8 and does real content negotiation against
  // Accept, so demanding application/json is a request PBS genuinely
  // cannot satisfy. No custom headers are sent at all now — this call
  // is deliberately kept equivalent to plain `fetch(url)`, plus only
  // the AbortSignal needed for the timeout. Do not add Accept,
  // User-Agent, or any other header here without live evidence it's
  // both necessary and doesn't trigger the same 406.
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      const durationMs = Date.now() - attemptStartedAt;
      logUpstreamHttpError({ requestId, attempt, status: response.status, durationMs });
      throw new UpstreamError(`PBS upstream responded with HTTP ${response.status} ${response.statusText}`, {
        status: response.status,
        code: 'http_status',
      });
    }

    // Success is HTTP 2xx + a readable body — nothing else. In
    // particular: the real PBS endpoint replies with
    // `Content-Type: text/plain;charset=UTF-8` (not application/json)
    // and wraps the array as `{"result":[...]}` rather than a bare
    // array — neither of those is ever inspected/validated here, so
    // neither can turn a genuinely successful response into a failure.
    // contentType is captured purely for the diagnostic success log.
    const contentType = response.headers.get('content-type');
    // Raw text only — never JSON.parse + re-stringify. Fields, key
    // order, and number formatting stay byte-for-byte whatever PBS
    // sent, whatever shape it's wrapped in.
    const rawText = await response.text();
    const durationMs = Date.now() - attemptStartedAt;
    logUpstreamSuccess({ requestId, attempt, status: response.status, durationMs, contentType });
    return { rawText, contentType };
  } catch (err) {
    if (err instanceof UpstreamError) throw err; // the !response.ok branch above already logged/classified this

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

    // undici's fetch wraps DNS/TLS/connection-refused/connection-reset
    // failures as `TypeError: fetch failed` with the real system error
    // (with its own .name/.code, e.g. ENOTFOUND for DNS, ECONNRESET for
    // a dropped connection mid-body) on `err.cause`. Only these three
    // primitive fields are ever read — never the whole error or cause
    // object — so nothing beyond what's explicitly listed here can end
    // up in a log line.
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
