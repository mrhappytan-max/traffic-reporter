// Fetches real-time PBS road-condition data only through the private Windows
// relay. A relay outage must never affect the independent TDX pipeline.

import { extractArray } from '../tdx/extract.js';
import {
  PBS_FETCH_TIMEOUT_MS,
  PBS_MAX_ATTEMPTS,
  PBS_RETRY_BACKOFF_MIN_MS,
  PBS_RETRY_BACKOFF_MAX_MS,
} from './pbsConfig.js';

export class PbsFetchError extends Error {
  constructor(message, {
    status = null,
    attempts = null,
    durationMs = null,
    relayConfigured = false,
    relayOk = false,
    relayStatus = null,
    relayCache = null,
    relayUpstreamDurationMs = null,
    retryable = true,
  } = {}) {
    super(message);
    this.name = 'PbsFetchError';
    this.status = status;
    this.attempts = attempts;
    this.durationMs = durationMs;
    this.relayConfigured = relayConfigured;
    this.relayOk = relayOk;
    this.relayStatus = relayStatus;
    this.relayCache = relayCache;
    this.relayUpstreamDurationMs = relayUpstreamDurationMs;
    this.retryable = retryable;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBackoffMs() {
  return PBS_RETRY_BACKOFF_MIN_MS + Math.random() * (PBS_RETRY_BACKOFF_MAX_MS - PBS_RETRY_BACKOFF_MIN_MS);
}

function isRetryableFailure(err) {
  if (err instanceof PbsFetchError && typeof err.retryable === 'boolean') return err.retryable;
  if (err instanceof PbsFetchError && err.status != null) return err.status >= 500;
  return true;
}

function parseDurationHeader(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function fetchOnce(env) {
  const relayConfigured = Boolean(env.PBS_RELAY_WINDOWS && env.PBS_RELAY_TOKEN);
  if (!env.PBS_RELAY_WINDOWS) {
    throw new PbsFetchError('PBS relay binding is not configured', { relayConfigured, retryable: false });
  }
  if (!env.PBS_RELAY_TOKEN) {
    throw new PbsFetchError('PBS relay token is not configured', { relayConfigured, retryable: false });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PBS_FETCH_TIMEOUT_MS);
  let response;

  try {
    const relayToken = encodeURIComponent(env.PBS_RELAY_TOKEN);
    response = await env.PBS_RELAY_WINDOWS.fetch(`http://pbs-relay.internal/pbs/${relayToken}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new PbsFetchError(`PBS relay request timed out after ${PBS_FETCH_TIMEOUT_MS}ms`, { relayConfigured });
    }
    throw new PbsFetchError('PBS relay request failed', { relayConfigured });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new PbsFetchError(`PBS relay responded with HTTP ${response.status}`, {
      status: response.status,
      relayConfigured,
      relayStatus: response.status,
      retryable: response.status >= 500,
    });
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new PbsFetchError('Failed to parse PBS relay JSON', {
      relayConfigured,
      relayOk: true,
      relayStatus: response.status,
    });
  }

  return {
    items: extractArray(json, ['data', 'items', 'result', 'RoadData', 'roadData']),
    relayConfigured,
    relayOk: true,
    relayStatus: response.status,
    relayCache: response.headers.get('x-pbs-relay-cache'),
    relayUpstreamDurationMs: parseDurationHeader(response.headers.get('x-pbs-relay-upstream-duration-ms')),
  };
}

export async function fetchPbsData(env) {
  const startedAt = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= PBS_MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    try {
      const result = await fetchOnce(env);
      return { ...result, attempts: attemptsMade, durationMs: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      if (attempt >= PBS_MAX_ATTEMPTS || !isRetryableFailure(err)) break;
      await sleep(randomBackoffMs());
    }
  }

  lastError.attempts = attemptsMade;
  lastError.durationMs = Date.now() - startedAt;
  throw lastError;
}
