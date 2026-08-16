// The testable core of GET /pbs — pure request-in/response-out, no
// direct http module or process.env dependency, so it can be unit
// tested without a real server or real network.
//
// Response schema is unchanged this round — success still returns the
// raw PBS JSON byte-for-byte, and the failure body is still
// { error: 'upstream_failed', message }. Only diagnostic logging
// (log.js) was added around the existing behavior.

import { fetchPbsUpstream, UpstreamError } from './upstreamClient.js';
import { isAuthorizedPathToken } from './auth.js';
import { generateRequestId, logRequestStart, logCacheStatus, logStaleFallback, logNoFallbackCache, logRequestComplete } from './log.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function handlePbsRequest({ cache, relayToken, pathToken, fetchImpl, now = Date.now(), requestId }) {
  if (!isAuthorizedPathToken(pathToken, relayToken)) {
    // Unauthorized requests are never "legitimate" /pbs requests for
    // diagnostic purposes — no requestId, no [PBS] log lines, and (per
    // auth.js) the Authorization header itself is never logged anywhere.
    return { status: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const id = requestId || generateRequestId(now);
  const handlerStartedAt = Date.now();
  const cached = cache.get();
  const predictedFresh = cache.isFresh(now);

  logRequestStart({ requestId: id, cacheStatus: predictedFresh ? 'HIT' : 'MISS' });

  if (predictedFresh) {
    logCacheStatus({ status: 'HIT', requestId: id });
    logRequestComplete({ requestId: id, status: 200, cache: 'HIT', durationMs: Date.now() - handlerStartedAt });
    return {
      status: 200,
      headers: { ...JSON_HEADERS, 'X-PBS-Cache': 'HIT' },
      body: cached.rawText,
    };
  }

  try {
    const { rawText, durationMs } = await fetchPbsUpstream({ fetchImpl, requestId: id });
    cache.set(rawText, now);
    logCacheStatus({ status: 'MISS', requestId: id });
    logRequestComplete({ requestId: id, status: 200, cache: 'MISS', durationMs: Date.now() - handlerStartedAt });
    return {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        'X-PBS-Cache': 'MISS',
        'X-PBS-Upstream-Duration-Ms': String(durationMs),
      },
      body: rawText,
    };
  } catch (err) {
    if (cached) {
      // Known-good stale data beats no data — but never fabricate.
      logCacheStatus({ status: 'STALE', requestId: id });
      logStaleFallback({ requestId: id, cacheAgeMs: now - cached.fetchedAt });
      logRequestComplete({ requestId: id, status: 200, cache: 'STALE', durationMs: Date.now() - handlerStartedAt });
      return {
        status: 200,
        headers: { ...JSON_HEADERS, 'X-PBS-Cache': 'STALE' },
        body: cached.rawText,
      };
    }

    logNoFallbackCache({ requestId: id });
    const status = err instanceof UpstreamError && err.code === 'timeout' ? 504 : 502;
    logRequestComplete({ requestId: id, status, cache: 'NONE', durationMs: Date.now() - handlerStartedAt });
    return {
      status,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'upstream_failed', message: safeMessage(err) }),
    };
  }
}

function safeMessage(err) {
  return err && typeof err.message === 'string' ? err.message : 'Unknown upstream error';
}
