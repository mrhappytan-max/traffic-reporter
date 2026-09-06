import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDebugChangeInput, buildDeterministicRequestId, dispatchDebugChanges, isDebugPushEnabled } from '../src/localDebugPush.js';
import { sendDebugPush } from '../src/debugPushClient.js';
import { runLocalMonitor } from '../src/localMonitor.js';

function event(id, fingerprint = 'a'.repeat(64)) {
  return {
    id, fingerprint, road: 'TEST', areaNm: '新竹市', direction: '北向',
    comment: '兩車擦撞事故', longitude: 120.9, latitude: 24.8, sourceDetail: 'test',
  };
}

function summary(changes = {}, overrides = {}) {
  const merged = {
    NEW: [], UPDATED: [], CLEARED: [], UNCHANGED: [], MISSING_PENDING_CLEAR: [],
    ...changes,
  };
  return {
    baseline: false,
    shouldPush: merged.NEW.length + merged.UPDATED.length + merged.CLEARED.length > 0,
    fetchedAt: '2026-08-27T01:00:00.000Z', changes: merged, ...overrides,
  };
}

function successAck(extra = {}) {
  return { httpStatus: 200, ack: { accepted: true, debugOnly: true, ...extra }, attempts: 1, durationMs: 5 };
}

test('feature switch defaults false and only literal true enables it', () => {
  assert.equal(isDebugPushEnabled(undefined), false);
  assert.equal(isDebugPushEnabled('false'), false);
  assert.equal(isDebugPushEnabled('true'), true);
  assert.equal(isDebugPushEnabled('TRUE'), true);
});

for (const [name, value] of [
  ['SHOULD_PUSH=NO', summary()],
  ['baseline', summary({ NEW: [event('A')] }, { baseline: true })],
  ['UNCHANGED', summary({ UNCHANGED: [event('A')] })],
  ['MISSING_PENDING_CLEAR', summary({ MISSING_PENDING_CLEAR: [{ ...event('A'), missingCount: 1 }] })],
]) {
  test(`${name} produces zero pushes`, async () => {
    let calls = 0;
    const result = await dispatchDebugChanges(value, { enabled: true, sendImpl: async () => { calls += 1; }, logImpl: null });
    assert.equal(calls, 0);
    assert.equal(result.debugPushAttemptedCount, 0);
  });
}

for (const lifecycle of ['NEW', 'UPDATED', 'CLEARED']) {
  test(`${lifecycle}=1 produces exactly one per-event push`, async () => {
    const inputs = [];
    const result = await dispatchDebugChanges(summary({ [lifecycle]: [event(lifecycle)] }), {
      enabled: true, sendImpl: async (input) => { inputs.push(input); return successAck(); }, logImpl: null,
    });
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].lifecycle, lifecycle);
    assert.equal(result.debugPushAcceptedCount, 1);
  });
}

test('mixed NEW=2 UPDATED=1 CLEARED=1 produces four separate payloads', async () => {
  const inputs = [];
  const result = await dispatchDebugChanges(summary({
    NEW: [event('N1'), event('N2')], UPDATED: [event('U')],
    CLEARED: [{ ...event('C'), clearReason: 'confirmed-absence' }],
  }), { enabled: true, sendImpl: async (input) => { inputs.push(input); return successAck(); }, logImpl: null });
  assert.equal(inputs.length, 4);
  assert.equal(result.debugPushAttemptedCount, 4);
  assert.deepEqual(inputs.map((input) => input.eventId), ['N1', 'N2', 'U', 'C']);
});

test('deterministic requestId and payload identity use UID lifecycle fingerprint', () => {
  const item = event('UID-1', '1234567890abcdef'.repeat(4));
  const first = buildDebugChangeInput(item, 'NEW', '2026-08-27T01:00:00.000Z');
  const second = buildDebugChangeInput(item, 'NEW', '2026-08-27T01:00:00.000Z');
  assert.equal(first.requestId, 'pbs:UID-1:NEW:1234567890abcdef');
  assert.equal(buildDeterministicRequestId(item, 'NEW'), first.requestId);
  assert.deepEqual(second, first);
});

test('client retry sends the same requestId and byte-identical body', async () => {
  const bodies = [];
  let calls = 0;
  await sendDebugPush(buildDebugChangeInput(event('A'), 'NEW', '2026-08-27T01:00:00.000Z'), {
    secret: 'test-only', sleep: async () => {}, fetchImpl: async (_url, init) => {
      bodies.push(init.body); calls += 1;
      return calls === 1 ? new Response('{}', { status: 500 }) : new Response('{"accepted":true,"debugOnly":true}', { status: 200 });
    },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
});

test('duplicate ACK is counted without failure', async () => {
  const result = await dispatchDebugChanges(summary({ NEW: [event('A')] }), {
    enabled: true, sendImpl: async () => successAck({ accepted: false, duplicate: true }), logImpl: null,
  });
  assert.equal(result.debugPushAcceptedCount, 0);
  assert.equal(result.debugPushDuplicateCount, 1);
  assert.equal(result.debugPushFailedCount, 0);
});

test('one event failure does not block later events or throw', async () => {
  const called = [];
  const result = await dispatchDebugChanges(summary({ NEW: [event('bad'), event('good')] }), {
    enabled: true, sendImpl: async (input) => {
      called.push(input.eventId);
      if (input.eventId === 'bad') throw Object.assign(new Error('network'), { code: 'network', attempts: 2 });
      return successAck();
    }, logImpl: null,
  });
  assert.deepEqual(called, ['bad', 'good']);
  assert.equal(result.debugPushFailedCount, 1);
  assert.equal(result.debugPushAcceptedCount, 1);
});

test('feature switch false suppresses a real change', async () => {
  let calls = 0;
  const result = await dispatchDebugChanges(summary({ NEW: [event('A')] }), {
    enabled: false, sendImpl: async () => { calls += 1; }, logImpl: null,
  });
  assert.equal(calls, 0);
  assert.equal(result.debugPushEnabled, false);
});

test('push failure happens only after state is persisted and cannot roll it back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-integrated-state-'));
  const statePath = join(directory, 'state.json');
  const raw = (UID, comment = '兩車擦撞事故') => ({ UID, roadtype: '交通事故', road: '測試路', areaNm: '新竹市', comment, direction: '北向', x1: '120.9', y1: '24.8', srcdetail: 'test' });
  await runLocalMonitor({ statePath, now: new Date('2026-08-27T00:00:00Z'), fetchImpl: async () => new Response(JSON.stringify({ result: [raw('A')] })) });
  const changed = await runLocalMonitor({ statePath, now: new Date('2026-08-27T00:03:00Z'), fetchImpl: async () => new Response(JSON.stringify({ result: [raw('A'), raw('B')] })) });
  const persistedBeforePush = await readFile(statePath, 'utf8');
  const result = await dispatchDebugChanges(changed, {
    enabled: true, sendImpl: async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', attempts: 2 }); }, logImpl: null,
  });
  assert.equal(result.debugPushFailedCount, 1);
  assert.equal(await readFile(statePath, 'utf8'), persistedBeforePush);
});
