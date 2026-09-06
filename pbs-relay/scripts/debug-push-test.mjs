import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sendDebugPush } from '../src/debugPushClient.js';
import { writeDebugPushLog } from '../src/localRuntime.js';

const mode = String(process.argv[2] || '').toUpperCase();
if (!['NEW', 'UPDATED', 'CLEARED', 'DUPLICATE'].includes(mode)) {
  console.error('Usage: npm.cmd run debug-push-test -- NEW|UPDATED|CLEARED|DUPLICATE');
  process.exit(2);
}

const lifecycle = mode === 'DUPLICATE' ? 'NEW' : mode;
const lower = lifecycle.toLowerCase();
const input = {
  generatedAt: '2026-08-27T00:00:00.000Z',
  eventId: `windows-debug-test-${lower}-001`,
  requestId: `windows-debug-request-${lower}-001`,
  lifecycle,
  fingerprint: `windows-debug-fingerprint-${lower}-001`,
  event: {
    road: 'TEST', areaNm: 'DEBUG_ONLY', direction: 'TEST',
    comment: `Windows debug push ${lifecycle} verification`,
    sourceDetail: 'WINDOWS_MANUAL_DEBUG_ONLY',
  },
};

const logDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const sends = mode === 'DUPLICATE' ? 2 : 1;
for (let sequence = 1; sequence <= sends; sequence += 1) {
  const startedAt = Date.now();
  try {
    const result = await sendDebugPush(input);
    await writeDebugPushLog(logDirectory, {
      debugPushResult: 'ACK', httpStatus: result.httpStatus, requestId: input.requestId,
      eventId: input.eventId, lifecycle, durationMs: result.durationMs, attempts: result.attempts,
    });
    console.log(JSON.stringify({ sequence, httpStatus: result.httpStatus, ...result.ack, attempts: result.attempts, durationMs: result.durationMs }));
  } catch (error) {
    await writeDebugPushLog(logDirectory, {
      debugPushResult: error?.code || 'FAILED', httpStatus: error?.status,
      requestId: input.requestId, eventId: input.eventId, lifecycle,
      durationMs: Date.now() - startedAt, attempts: error?.attempts || 0,
    });
    console.error(JSON.stringify({ sequence, error: error?.code || 'FAILED', httpStatus: error?.status || null, attempts: error?.attempts || 0 }));
    process.exitCode = 1;
    break;
  }
}
