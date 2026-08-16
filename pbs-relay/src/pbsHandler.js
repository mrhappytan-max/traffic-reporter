// The testable core of GET /pbs — pure request-in/response-out, no
// direct http module or process.env dependency, so it can be unit
// tested without a real server or real network.

import { fetchPbsUpstream, UpstreamError } from './upstreamClient.js';
import { isAuthorized } from './auth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function handlePbsRequest({ cache, relayToken, authorizationHeader, fetchImpl, now = Date.now() }) {
  if (!isAuthorized(authorizationHeader, relayToken)) {
    return { status: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const cached = cache.get();

  if (cache.isFresh(now)) {
    return {
      status: 200,
      headers: { ...JSON_HEADERS, 'X-PBS-Cache': 'HIT' },
      body: cached.rawText,
    };
  }

  try {
    const { rawText, durationMs } = await fetchPbsUpstream({ fetchImpl });
    cache.set(rawText, now);
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
      return {
        status: 200,
        headers: { ...JSON_HEADERS, 'X-PBS-Cache': 'STALE' },
        body: cached.rawText,
      };
    }

    const status = err instanceof UpstreamError && err.code === 'timeout' ? 504 : 502;
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
