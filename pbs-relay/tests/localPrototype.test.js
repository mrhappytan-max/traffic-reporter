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

test('service-area regression A-H reuses Production road/KM rules and rejects the old envelope', () => {
  const cases = [
    event('A-yingge', {
      road: '',
      areaNm: '福爾摩沙高速公路-國道３號',
      comment: '南下在55.8公里過鶯歌系統交流道，2小車追撞事故',
      x1: '121.31295',
      y1: '24.93051',
    }),
    event('B-yangmei', {
      road: '',
      areaNm: '中山高速公路-國道１號',
      comment: '南下在68.1公里楊梅前，2自小事故',
      x1: '121.1674',
      y1: '24.91688',
    }),
    event('C-zhubei', {
      road: '',
      areaNm: '中山高速公路-國道１號',
      comment: '北上在91.9公里竹北前，2自小事故',
      x1: '121.01271',
      y1: '24.81546',
    }),
    event('D-tai68', {
      road: '',
      areaNm: '(南寮竹東)-台68線',
      comment: '東向在9公里科學園區匝道，事故佔用部分車道',
      x1: '120.93918',
      y1: '24.84234',
    }),
    event('E-hsinchu-city', { areaNm: '新竹市' }),
    event('F-zhunan', { areaNm: '竹南鎮' }),
    event('G-toufen', { areaNm: '頭份市' }),
    event('H-old-envelope-only', {
      road: '',
      areaNm: '未知道路',
      comment: '兩車追撞事故',
      x1: '121.32',
      y1: '24.92',
    }),
  ];

  const filtered = filterRelevantAccidents(cases);
  assert.deepEqual(filtered.map((item) => item.id), [
    'C-zhubei',
    'D-tai68',
    'E-hsinchu-city',
    'F-zhunan',
    'G-toufen',
  ]);
  assert.match(filtered[0].matchReason, /^text:竹北$|^production-service-area:road-km:國道一號$/);
  assert.equal(filtered[1].matchReason, 'production-service-area:road-km:台68');
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
    event('cleared', { comment: '事故已排除' }),
    event('same'),
  ]);
  const result = compareWithPreviousState(current, baseline);
  assert.deepEqual(Object.fromEntries(Object.entries(result.changes).map(([key, value]) => [key, value.length])), {
    NEW: 1,
    UPDATED: 1,
    CLEARED: 1,
    UNCHANGED: 1,
    MISSING_PENDING_CLEAR: 0,
  });
  assert.equal(result.shouldPush, true);
});

test('UID 11508260013-5 requires two successful missing rounds before CLEARED', () => {
  const realUid = event('11508260013-5', {
    road: '',
    areaNm: '福爾摩沙高速公路-國道３號',
    direction: '南下',
    comment: '南下在96.7公里.過寶山休息站.外2線.1聯結車+4小客車追撞事故',
    x1: '121.02528',
    y1: '24.75515',
  });
  const initial = compareWithPreviousState(filterRelevantAccidents([realUid]), null, new Date('2026-08-27T01:00:00Z'));
  const legacyState = structuredClone(initial.state);
  delete legacyState.events['11508260013-5'].missingCount;
  delete legacyState.events['11508260013-5'].lastSeenAt;
  delete legacyState.events['11508260013-5'].firstMissingAt;

  const firstMissing = compareWithPreviousState([], legacyState, new Date('2026-08-27T01:03:00Z'));
  assert.equal(firstMissing.changes.CLEARED.length, 0);
  assert.equal(firstMissing.changes.MISSING_PENDING_CLEAR.length, 1);
  assert.equal(firstMissing.state.events['11508260013-5'].missingCount, 1);
  assert.equal(firstMissing.shouldPush, false);

  const secondMissing = compareWithPreviousState([], firstMissing.state, new Date('2026-08-27T01:06:00Z'));
  assert.equal(secondMissing.changes.CLEARED.length, 1);
  assert.equal(secondMissing.changes.CLEARED[0].clearReason, 'confirmed-absence');
  assert.equal(secondMissing.changes.MISSING_PENDING_CLEAR.length, 0);
  assert.equal(secondMissing.shouldPush, true);
});

test('a UID reappearing after one miss cancels pending clear and resets missingCount', () => {
  const original = filterRelevantAccidents([event('reappears')]);
  const baseline = compareWithPreviousState(original, null).state;
  const pending = compareWithPreviousState([], baseline).state;
  const result = compareWithPreviousState(original, pending);
  assert.equal(result.changes.CLEARED.length, 0);
  assert.equal(result.changes.UPDATED.length, 0);
  assert.equal(result.changes.UNCHANGED.length, 1);
  assert.equal(result.state.events.reappears.missingCount, 0);
  assert.equal(result.state.events.reappears.firstMissingAt, null);
  assert.equal(result.shouldPush, false);
});

test('a UID reappearing with changed content becomes UPDATED, never CLEARED', () => {
  const original = filterRelevantAccidents([event('changed')]);
  const baseline = compareWithPreviousState(original, null).state;
  const pending = compareWithPreviousState([], baseline).state;
  const changed = filterRelevantAccidents([event('changed', { comment: '三車追撞事故，外側車道受阻' })]);
  const result = compareWithPreviousState(changed, pending);
  assert.equal(result.changes.UPDATED.length, 1);
  assert.equal(result.changes.CLEARED.length, 0);
  assert.equal(result.state.events.changed.missingCount, 0);
  assert.equal(result.shouldPush, true);
});

test('explicit clear text clears a previously active event', () => {
  const baseline = compareWithPreviousState(filterRelevantAccidents([event('A')]), null).state;
  const current = filterRelevantAccidents([event('A', { comment: '事故已排除' })]);
  const result = compareWithPreviousState(current, baseline);
  assert.equal(result.changes.CLEARED[0].clearReason, 'explicit-clear-text');
  assert.equal(result.shouldPush, true);
});
