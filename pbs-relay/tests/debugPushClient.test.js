import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDebugPushPayload, DebugPushError, sendDebugPush } from '../src/debugPushClient.js';
import { writeDebugPushLog } from '../src/localRuntime.js';

const SECRET = 'unit-test-secret-never-log';
const base = (lifecycle = 'NEW') => ({
  eventId: `windows-debug-test-${lifecycle.toLowerCase()}-001`,
  requestId: `windows-debug-request-${lifecycle.toLowerCase()}-001`,
  lifecycle,
  fingerprint: `windows-debug-fingerprint-${lifecycle.toLowerCase()}-001`,
  event: {
    road: 'TEST', areaNm: 'DEBUG_ONLY', direction: 'TEST',
    comment: `Windows debug push ${lifecycle} verification`, longitude: 121,
    latitude: 24.8, sourceDetail: 'WINDOWS_MANUAL_DEBUG_ONLY',
  },
});

test('payload build has exact top-level contract and source=pbs', () => {
  const payload = buildDebugPushPayload(base(), new Date('2026-08-27T00:00:00Z'));
  assert.deepEqual(Object.keys(payload), ['generatedAt', 'source', 'eventId', 'lifecycle', 'fingerprint', 'requestId', 'event']);
  assert.equal(payload.source, 'pbs');
  assert.equal(payload.generatedAt, '2026-08-27T00:00:00.000Z');
});

test('explicit generatedAt makes a byte-for-byte deterministic duplicate payload', () => {
  const input = { ...base(), generatedAt: '2026-08-27T00:00:00.000Z' };
  const first = JSON.stringify(buildDebugPushPayload(input, new Date('2026-08-27T01:00:00Z')));
  const second = JSON.stringify(buildDebugPushPayload(input, new Date('2026-08-27T02:00:00Z')));
  assert.equal(second, first);
});

for (const lifecycle of ['NEW', 'UPDATED', 'CLEARED']) {
  test(`${lifecycle} payload is accepted and preserved`, () => {
    assert.equal(buildDebugPushPayload(base(lifecycle)).lifecycle, lifecycle);
  });
}

test('event uses only the seven allowed fields', () => {
  const input = base();
  input.event.rawFeed = Array.from({ length: 1000 }, (_, UID) => ({ UID }));
  input.state = { everything: true };
  const payload = buildDebugPushPayload(input);
  assert.deepEqual(Object.keys(payload.event), ['road', 'areaNm', 'direction', 'comment', 'longitude', 'latitude', 'sourceDetail']);
  assert.equal('rawFeed' in payload.event, false);
  assert.equal('state' in payload, false);
});

test('oversized allowed-field payload is rejected', () => {
  const input = base();
  input.event.comment = 'x'.repeat(20_000);
  assert.throws(() => buildDebugPushPayload(input), (error) => error.code === 'payload_too_large');
});

test('raw arrays or objects cannot be smuggled through allowed event fields', () => {
  const input = base();
  input.event.comment = Array.from({ length: 1000 }, (_, UID) => ({ UID }));
  assert.throws(() => buildDebugPushPayload(input), (error) => error.code === 'invalid_comment');
});

test('missing secret fails closed before fetch', async () => {
  let calls = 0;
  await assert.rejects(sendDebugPush(base(), { secret: '', fetchImpl: async () => { calls += 1; } }),
    (error) => error.code === 'missing_secret');
  assert.equal(calls, 0);
});

test('Authorization header is constructed in memory and request contains one event only', async () => {
  let init;
  const result = await sendDebugPush(base(), {
    secret: SECRET,
    fetchImpl: async (_url, requestInit) => { init = requestInit; return new Response('{"ok":true,"debugOnly":true}', { status: 200 }); },
  });
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(Array.isArray(JSON.parse(init.body)), false);
  assert.equal(result.ack.debugOnly, true);
});

test('ACK fields are parsed', async () => {
  const result = await sendDebugPush(base(), {
    secret: SECRET,
    fetchImpl: async () => new Response('{"ok":true,"accepted":true,"duplicate":false,"debugOnly":true}', { status: 200 }),
  });
  assert.deepEqual(result.ack, { ok: true, accepted: true, duplicate: false, debugOnly: true });
  assert.equal(result.httpStatus, 200);
});

test('timeout is classified and retries only once', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    calls += 1;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(sendDebugPush(base(), { secret: SECRET, fetchImpl, timeoutMs: 5, sleep: async () => {} }),
    (error) => error.code === 'timeout' && error.attempts === 2);
  assert.equal(calls, 2);
});

test('network error retries and succeeds', async () => {
  let calls = 0;
  const result = await sendDebugPush(base(), { secret: SECRET, sleep: async () => {}, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response('{"debugOnly":true}', { status: 200 });
  } });
  assert.equal(result.attempts, 2);
});

test('5xx retries and succeeds', async () => {
  let calls = 0;
  const result = await sendDebugPush(base(), { secret: SECRET, sleep: async () => {}, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? new Response('{"error":"temporary"}', { status: 500 }) : new Response('{"debugOnly":true}', { status: 200 });
  } });
  assert.equal(result.attempts, 2);
});

for (const status of [400, 404, 405]) {
  test(`${status} does not retry`, async () => {
    let calls = 0;
    await assert.rejects(sendDebugPush(base(), { secret: SECRET, fetchImpl: async () => {
      calls += 1; return new Response('{"error":"bad_request"}', { status });
    } }), (error) => error.code === 'http_error' && error.attempts === 1);
    assert.equal(calls, 1);
  });
}

for (const status of [401, 403]) {
  test(`${status} is AUTH_FAILED and does not retry`, async () => {
    let calls = 0;
    await assert.rejects(sendDebugPush(base(), { secret: SECRET, fetchImpl: async () => {
      calls += 1; return new Response('{"error":"unauthorized"}', { status });
    } }), (error) => error.code === 'AUTH_FAILED' && error.attempts === 1);
    assert.equal(calls, 1);
  });
}

test('503 pbs_debug_push_not_configured stops without retry', async () => {
  let calls = 0;
  await assert.rejects(sendDebugPush(base(), { secret: SECRET, fetchImpl: async () => {
    calls += 1; return new Response('{"error":"pbs_debug_push_not_configured"}', { status: 503 });
  } }), (error) => error.code === 'pbs_debug_push_not_configured' && error.attempts === 1);
  assert.equal(calls, 1);
});

test('all retryable failures stop at exactly two attempts', async () => {
  let calls = 0;
  await assert.rejects(sendDebugPush(base(), { secret: SECRET, sleep: async () => {}, fetchImpl: async () => {
    calls += 1; return new Response('{}', { status: 500 });
  } }), (error) => error.attempts === 2);
  assert.equal(calls, 2);
});

test('secret is absent from errors and operational log', async () => {
  let thrown;
  try {
    await sendDebugPush(base(), { secret: SECRET, fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }) });
  } catch (error) { thrown = error; }
  assert.ok(thrown instanceof DebugPushError);
  assert.doesNotMatch(JSON.stringify(thrown), new RegExp(SECRET));
  assert.doesNotMatch(thrown.message, /Authorization|Bearer/);

  const directory = await mkdtemp(join(tmpdir(), 'pbs-debug-log-'));
  await writeDebugPushLog(directory, {
    debugPushResult: thrown.code, httpStatus: thrown.status, requestId: base().requestId,
    eventId: base().eventId, lifecycle: 'NEW', durationMs: 1, attempts: thrown.attempts,
    secret: SECRET, Authorization: `Bearer ${SECRET}`,
  }, new Date('2026-08-27T00:00:00Z'));
  const text = await readFile(join(directory, '2026-08-27.jsonl'), 'utf8');
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(text, /Authorization|Bearer/);
});

test('server text cannot echo a secret through the parsed error', async () => {
  let thrown;
  try {
    await sendDebugPush(base(), {
      secret: SECRET,
      fetchImpl: async () => new Response(JSON.stringify({ error: SECRET, detail: `Bearer ${SECRET}` }), { status: 401 }),
    });
  } catch (error) { thrown = error; }
  assert.doesNotMatch(JSON.stringify(thrown), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(thrown), /Bearer/);
});

test('push failure does not modify local state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-debug-state-'));
  const statePath = join(directory, 'state.json');
  const original = '{"schemaVersion":1,"events":{"fixture":{"missingCount":1}}}\n';
  await writeFile(statePath, original);
  await sendDebugPush(base(), { secret: SECRET, fetchImpl: async () => new Response('{}', { status: 400 }) }).catch(() => {});
  assert.equal(await readFile(statePath, 'utf8'), original);
});

test('local monitor uses the gated dispatcher and never calls the HTTP client directly', async () => {
  const monitor = await readFile(new URL('../src/localMonitor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(monitor, /debugPushClient|sendDebugPush/);
  assert.match(monitor, /dispatchDebugChanges/);
  assert.match(monitor, /isDebugPushEnabled/);
});
