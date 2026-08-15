import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePbsEvent, normalizePbsDirection, parseHappenedAt, parsePbsDateTime } from '../src/pbs/normalize.js';

test('normalizePbsDirection maps PBS compass terms to the TDX-style 向 vocabulary', () => {
  assert.equal(normalizePbsDirection('西行'), '西向');
  assert.equal(normalizePbsDirection('東行'), '東向');
  assert.equal(normalizePbsDirection('北上'), '北向');
  assert.equal(normalizePbsDirection('南下'), '南向');
  assert.equal(normalizePbsDirection('北向'), '北向'); // already normalized
  assert.equal(normalizePbsDirection(''), '');
});

test('parseHappenedAt: "2026-08-15" + "22:14:00" -> Asia/Taipei instant', () => {
  const iso = parseHappenedAt('2026-08-15', '22:14:00');
  assert.equal(iso, '2026-08-15T14:14:00.000Z'); // 22:14 +08:00 = 14:14 UTC
});

test('parsePbsDateTime handles "YYYY-MM-DD HH:MM:SS" as Asia/Taipei local time', () => {
  assert.equal(parsePbsDateTime('2026-08-15 22:20:00'), '2026-08-15T14:20:00.000Z');
});

test('parsePbsDateTime returns null for missing/unparseable input', () => {
  assert.equal(parsePbsDateTime(''), null);
  assert.equal(parsePbsDateTime(null), null);
  assert.equal(parsePbsDateTime('not a date'), null);
});

// The real, confirmed PBS example from this round's task: 台68 accident.
test('real fixture: 台68 accident (areaNm-derived road, 西行 direction, comment mentions 事故)', () => {
  const raw = {
    UID: 'PBS-2026-08150001',
    road: '',
    direction: '西行',
    areaNm: '(南寮竹東)-台68線',
    roadtype: '事故',
    comment: '西行在8.1公里處內側車道發生交通事故，請小心慢行',
    happendate: '2026-08-15',
    happentime: '22:14:00',
    modDttm: '2026-08-15 22:20:00',
    x1: '120.9987',
    y1: '24.7912',
    srcdetail: '民眾報案',
  };

  const event = normalizePbsEvent(raw);

  assert.equal(event.source, 'pbs');
  assert.equal(event.rawId, 'PBS-2026-08150001');
  assert.equal(event.road, '台68');
  assert.equal(event.direction, '西向');
  assert.equal(event.type, 'accident');
  assert.equal(event.pbsCategory, 'accident');
  assert.equal(event.description, raw.comment);
  assert.equal(event.location, raw.areaNm);
  assert.equal(event.updatedAt, '2026-08-15T14:20:00.000Z');
  assert.equal(event.happenedAt, '2026-08-15T14:14:00.000Z');
  assert.equal(event.latitude, 24.7912);
  assert.equal(event.longitude, 120.9987);
  assert.equal(event.sourceDetail, '民眾報案');
});

test('normalizePbsEvent handles missing/empty coordinate fields without crashing', () => {
  const event = normalizePbsEvent({ UID: 'X1', road: '', areaNm: '', comment: '' , x1: '', y1: '' });
  assert.equal(event.latitude, null);
  assert.equal(event.longitude, null);
  assert.equal(event.rawId, 'X1');
});
