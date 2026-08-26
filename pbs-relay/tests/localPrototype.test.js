import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWithPreviousState, filterRelevantAccidents, parsePbsPayload } from '../src/localPrototype.js';

function event(UID, overrides = {}) {
  return {
    UID,
    roadtype: '交通事故',
    road: '測試路',
    areaNm: '新竹市',
    comment: '兩車擦撞，請小心通行',
    direction: '北向',
    happendate: '2026-08-26',
    happentime: '10:00:00.0000000',
    modDttm: '2026-08-26 10:05:00.0',
    x1: '120.96',
    y1: '24.80',
    srcdetail: 'test',
    ...overrides,
  };
}

test('parses wrapped PBS result and rejects unexpected shape', () => {
  assert.equal(parsePbsPayload(JSON.stringify({ result: [event('1')] })).length, 1);
  assert.throws(() => parsePbsPayload('{}'), /does not contain an array/);
});

test('filters accidents for all requested named areas and rejects unrelated/non-accidents', () => {
  const areas = ['新竹市', '新竹縣', '竹北', '竹南', '頭份'];
  const input = areas.map((area, index) => event(String(index), { areaNm: area }));
  input.push(event('outside', { areaNm: '高雄市', comment: '交通事故', x1: '120.30', y1: '22.62' }));
  input.push(event('construction', { roadtype: '道路施工', comment: '竹北道路施工' }));
  assert.deepEqual(filterRelevantAccidents(input).map((item) => item.id), ['0', '1', '2', '3', '4']);
});

test('first healthy run creates a quiet baseline', () => {
  const current = filterRelevantAccidents([event('A')]);
  const result = compareWithPreviousState(current, null, new Date('2026-08-26T02:00:00Z'));
  assert.equal(result.baseline, true);
  assert.equal(result.shouldPush, false);
  assert.equal(result.changes.UNCHANGED.length, 1);
});

test('classifies NEW UPDATED CLEARED and UNCHANGED and sets SHOULD_PUSH', () => {
  const baselineEvents = filterRelevantAccidents([event('updated'), event('cleared'), event('same')]);
  const baseline = compareWithPreviousState(baselineEvents, null).state;
  const current = filterRelevantAccidents([
    event('new'),
    event('updated', { comment: '兩車追撞，外側車道受阻' }),
    event('same'),
  ]);
  const result = compareWithPreviousState(current, baseline);
  assert.deepEqual(Object.fromEntries(Object.entries(result.changes).map(([key, value]) => [key, value.length])), {
    NEW: 1,
    UPDATED: 1,
    CLEARED: 1,
    UNCHANGED: 1,
  });
  assert.equal(result.shouldPush, true);
});

test('explicit clear text clears a previously active event', () => {
  const baseline = compareWithPreviousState(filterRelevantAccidents([event('A')]), null).state;
  const current = filterRelevantAccidents([event('A', { comment: '事故已排除' })]);
  const result = compareWithPreviousState(current, baseline);
  assert.equal(result.changes.CLEARED[0].clearReason, 'explicit-clear-text');
  assert.equal(result.shouldPush, true);
});
