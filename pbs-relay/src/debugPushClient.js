const ALLOWED_LIFECYCLES = new Set(['NEW', 'UPDATED', 'CLEARED']);
const EVENT_FIELDS = ['road', 'areaNm', 'direction', 'comment', 'longitude', 'latitude', 'sourceDetail'];

export const DEBUG_PUSH_ENDPOINT = 'https://traffic-reporter.mr-happytan.workers.dev/internal/pbs-debug-push';
export const DEFAULT_DEBUG_PUSH_TIMEOUT_MS = 5000;
export const DEFAULT_DEBUG_PUSH_MAX_ATTEMPTS = 2;

export class DebugPushError extends Error {
  constructor(code, { status = null, attempts = 0, ack = null } = {}) {
    super(code);
    this.name = 'DebugPushError';
    this.code = code;
    this.status = status;
    this.attempts = attempts;
    this.ack = ack;
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new DebugPushError(`invalid_${name}`);
  return value;
}

export function buildDebugPushPayload(input, now = new Date()) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new DebugPushError('invalid_payload');
  if (Array.isArray(input.event) || !input.event || typeof input.event !== 'object') {
    throw new DebugPushError('invalid_event');
  }
  const lifecycle = requiredString(input.lifecycle, 'lifecycle');
  if (!ALLOWED_LIFECYCLES.has(lifecycle)) throw new DebugPushError('invalid_lifecycle');

  const event = {};
  for (const field of EVENT_FIELDS) {
    const value = input.event[field];
    if (value === undefined || value === null) continue;
    if (field === 'longitude' || field === 'latitude') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new DebugPushError(`invalid_${field}`);
    } else if (typeof value !== 'string') {
      throw new DebugPushError(`invalid_${field}`);
    }
    event[field] = value;
  }
  if (Object.keys(event).length === 0) throw new DebugPushError('empty_event');

  const payload = {
    generatedAt: input.generatedAt || now.toISOString(),
    source: 'pbs',
    eventId: requiredString(input.eventId, 'eventId'),
    lifecycle,
    fingerprint: requiredString(input.fingerprint, 'fingerprint'),
    requestId: requiredString(input.requestId, 'requestId'),
    event,
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > 16_384) throw new DebugPushError('payload_too_large');
  return payload;
}

function safeAck(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const ack = {};
    for (const field of ['ok', 'accepted', 'duplicate', 'debugOnly']) {
      if (typeof value[field] === 'boolean') ack[field] = value[field];
    }
    if (typeof value.error === 'string' && /^[a-z0-9_]{1,64}$/i.test(value.error)) ack.error = value.error;
    return ack;
  } catch {
    return null;
  }
}

function isTimeout(error) {
  return error?.name === 'AbortError' || error?.code === 'timeout';
}

export async function sendDebugPush(input, {
  fetchImpl = globalThis.fetch,
  secret = process.env.PBS_DEBUG_PUSH_SECRET,
  endpoint = DEBUG_PUSH_ENDPOINT,
  timeoutMs = DEFAULT_DEBUG_PUSH_TIMEOUT_MS,
  maxAttempts = DEFAULT_DEBUG_PUSH_MAX_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = new Date(),
} = {}) {
  if (typeof secret !== 'string' || secret === '') throw new DebugPushError('missing_secret');
  if (maxAttempts !== 2) throw new DebugPushError('invalid_max_attempts');
  const payload = buildDebugPushPayload(input, now);
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const ack = safeAck(await response.text());
      if (response.ok) {
        return { httpStatus: response.status, ack, attempts: attempt, durationMs: Date.now() - startedAt, payload };
      }
      const notConfigured = response.status === 503 && ack?.error === 'pbs_debug_push_not_configured';
      if (response.status === 401 || response.status === 403) {
        throw new DebugPushError('AUTH_FAILED', { status: response.status, attempts: attempt, ack });
      }
      if (notConfigured) throw new DebugPushError('pbs_debug_push_not_configured', { status: 503, attempts: attempt, ack });
      if (response.status >= 500 && attempt < maxAttempts) {
        await sleep(100);
        continue;
      }
      throw new DebugPushError('http_error', { status: response.status, attempts: attempt, ack });
    } catch (error) {
      if (error instanceof DebugPushError) throw error;
      const code = isTimeout(error) ? 'timeout' : 'network';
      if (attempt < maxAttempts) {
        await sleep(100);
        continue;
      }
      throw new DebugPushError(code, { attempts: attempt });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new DebugPushError('unreachable');
}
