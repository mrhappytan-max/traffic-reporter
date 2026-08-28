import { sendDebugPush } from './debugPushClient.js';
import { writeDebugPushLog } from './localRuntime.js';

const PUSH_LIFECYCLES = ['NEW', 'UPDATED', 'CLEARED'];

export function isDebugPushEnabled(value = process.env.PBS_DEBUG_PUSH_ENABLED) {
  return String(value || '').toLowerCase() === 'true';
}

export function buildDeterministicRequestId(event, lifecycle) {
  const id = String(event?.id || '');
  const fingerprint = String(event?.fingerprint || '');
  if (!id || !fingerprint || !PUSH_LIFECYCLES.includes(lifecycle)) {
    throw new Error('invalid_debug_change_identity');
  }
  return `pbs:${id}:${lifecycle}:${fingerprint.slice(0, 16)}`;
}

export function buildDebugChangeInput(event, lifecycle, generatedAt) {
  return {
    generatedAt,
    eventId: event.id,
    lifecycle,
    fingerprint: event.fingerprint,
    requestId: buildDeterministicRequestId(event, lifecycle),
    event: {
      road: event.road,
      areaNm: event.areaNm,
      direction: event.direction,
      comment: event.comment,
      longitude: event.longitude,
      latitude: event.latitude,
      sourceDetail: event.sourceDetail,
    },
  };
}

function emptyResult(enabled) {
  return {
    debugPushEnabled: enabled,
    debugPushAttemptedCount: 0,
    debugPushAcceptedCount: 0,
    debugPushDuplicateCount: 0,
    debugPushFailedCount: 0,
    results: [],
  };
}

export async function dispatchDebugChanges(summary, {
  enabled = isDebugPushEnabled(),
  sendImpl = sendDebugPush,
  logImpl = writeDebugPushLog,
  logDirectory,
} = {}) {
  const aggregate = emptyResult(enabled);
  if (!enabled || summary?.baseline || !summary?.shouldPush) return aggregate;

  for (const lifecycle of PUSH_LIFECYCLES) {
    for (const event of summary?.changes?.[lifecycle] || []) {
      const input = buildDebugChangeInput(event, lifecycle, summary.fetchedAt);
      aggregate.debugPushAttemptedCount += 1;
      try {
        const response = await sendImpl(input);
        const accepted = response.ack?.accepted === true;
        const duplicate = response.ack?.duplicate === true;
        if (accepted) aggregate.debugPushAcceptedCount += 1;
        if (duplicate) aggregate.debugPushDuplicateCount += 1;
        const result = {
          debugPushResult: 'ACK', httpStatus: response.httpStatus,
          requestId: input.requestId, eventId: input.eventId, lifecycle,
          accepted, duplicate, attempts: response.attempts, durationMs: response.durationMs,
        };
        aggregate.results.push(result);
        if (logImpl) await logImpl(logDirectory, result);
      } catch (error) {
        aggregate.debugPushFailedCount += 1;
        const result = {
          debugPushResult: error?.code || 'FAILED', httpStatus: error?.status ?? null,
          requestId: input.requestId, eventId: input.eventId, lifecycle,
          accepted: false, duplicate: false, attempts: error?.attempts || 0, durationMs: null,
        };
        aggregate.results.push(result);
        if (logImpl) await logImpl(logDirectory, result);
      }
    }
  }
  return aggregate;
}
