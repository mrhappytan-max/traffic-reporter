// Structured, single-purpose diagnostic logging for GET /pbs. Plain
// console.log lines (grep-able "key=value" pairs), no logging library —
// this Relay stays minimal on purpose. Every function here takes a
// fixed, named set of fields, so there is no generic "log this whole
// object" escape hatch a caller could accidentally pass a token or
// Authorization header through.

export function generateRequestId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `pbs-${now}-${rand}`;
}

export function logRequestStart({ requestId, cacheStatus }) {
  console.log(`[PBS] request start requestId=${requestId} cacheStatus=${cacheStatus}`);
}

export function logUpstreamAttemptStart({ requestId, attempt, url }) {
  console.log(`[PBS] upstream attempt start requestId=${requestId} attempt=${attempt} url=${url}`);
}

export function logUpstreamSuccess({ requestId, attempt, status, durationMs, contentType }) {
  console.log(
    `[PBS] upstream success requestId=${requestId} attempt=${attempt} status=${status} durationMs=${durationMs} contentType=${contentType}`
  );
}

export function logUpstreamHttpError({ requestId, attempt, status, durationMs }) {
  console.log(`[PBS] upstream http error requestId=${requestId} attempt=${attempt} status=${status} durationMs=${durationMs}`);
}

export function logUpstreamTimeout({ requestId, attempt, durationMs, errorName, errorCode }) {
  console.log(
    `[PBS] upstream timeout requestId=${requestId} attempt=${attempt} durationMs=${durationMs} errorName=${errorName} errorCode=${errorCode}`
  );
}

// causeCode/message come from Node's underlying system error (DNS/TLS/
// connection-refused etc., surfaced by undici's fetch as `err.cause`).
// Only .name/.code/.message are ever read — never the whole error/cause
// object — so nothing unexpected (e.g. a header dump some future error
// type might attach) can leak through this path.
export function logUpstreamNetworkError({ requestId, attempt, durationMs, errorName, errorCode, causeCode, message }) {
  console.log(
    `[PBS] upstream network error requestId=${requestId} attempt=${attempt} durationMs=${durationMs} ` +
      `errorName=${errorName} errorCode=${errorCode} causeCode=${causeCode} message=${message}`
  );
}

export function logRetryScheduled({ requestId, nextAttempt, reason, backoffMs }) {
  console.log(`[PBS] retry scheduled requestId=${requestId} nextAttempt=${nextAttempt} reason=${reason} backoffMs=${backoffMs}`);
}

export function logNoRetry({ requestId, reason }) {
  console.log(`[PBS] no retry requestId=${requestId} reason=${reason}`);
}

/** status: 'HIT' | 'MISS' | 'STALE' */
export function logCacheStatus({ status, requestId }) {
  console.log(`[PBS] cache ${status} requestId=${requestId}`);
}

export function logStaleFallback({ requestId, cacheAgeMs }) {
  console.log(`[PBS] stale fallback requestId=${requestId} cacheAgeMs=${cacheAgeMs}`);
}

export function logNoFallbackCache({ requestId }) {
  console.log(`[PBS] no fallback cache requestId=${requestId}`);
}

export function logRequestComplete({ requestId, status, cache, durationMs }) {
  console.log(`[PBS] request complete requestId=${requestId} status=${status} cache=${cache} durationMs=${durationMs}`);
}
