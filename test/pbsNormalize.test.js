import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePbsEvent,
  normalizePbsDirection,
  parseHappenedAt,
  parsePbsDateTime,
  extractDisplayKmFromText,
} from '../src/pbs/normalize.js';

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

// V1.8.5.1 — production repro (2026-08-18): a real 17:05 accident LINE
// message showed no KM at all (only a route-name string on the second
// line), because PBS never carries a structured KM field. These tests
// cover the new DISPLAY-ONLY extractDisplayKmFromText() and its
// placement on the normalized event as `displayKM`.

test('6. extractDisplayKmFromText recognizes "93K+300" (K+ format)', () => {
  assert.equal(extractDisplayKmFromText('南向93K+300處發生交通事故'), 93.3);
});

test('extractDisplayKmFromText recognizes a bare "93K" / "93.3K" (no +NNN suffix)', () => {
  assert.equal(extractDisplayKmFromText('南向93K處發生交通事故'), 93);
  assert.equal(extractDisplayKmFromText('南向93.3K處發生交通事故'), 93.3);
});

test('extractDisplayKmFromText recognizes "93公里"/"93.3公里" (the already-confirmed real 8.1公里 fixture shape)', () => {
  assert.equal(extractDisplayKmFromText('西行在8.1公里處內側車道發生交通事故'), 8.1);
  assert.equal(extractDisplayKmFromText('南向約93公里處'), 93);
  assert.equal(extractDisplayKmFromText('南向約93.3公里處'), 93.3);
});

test('7. plain unrelated numbers ("2車事故、3人受傷、17:05") are never misread as a kilometer', () => {
  assert.equal(extractDisplayKmFromText('2車事故、3人受傷、17:05'), null);
  assert.equal(extractDisplayKmFromText(''), null);
  assert.equal(extractDisplayKmFromText(null), null);
  assert.equal(extractDisplayKmFromText(undefined), null);
});

test('8. normalizePbsEvent: a comment with a parseable KM gets `displayKM`, and it is NEVER written into startKM/endKM', () => {
  const event = normalizePbsEvent({
    UID: 'PBS-2026-08180001',
    road: '',
    direction: '南向',
    areaNm: '中山高速公路-國道1號',
    roadtype: '事故',
    comment: '南向在93.3公里處內側車道發生交通事故，請小心慢行',
    happendate: '2026-08-18',
    happentime: '17:05:00',
    modDttm: '2026-08-18 17:05:00',
  });

  assert.equal(event.displayKM, 93.3);
  assert.equal(event.startKM, undefined);
  assert.equal(event.endKM, undefined);
  assert.equal(event.road, '國道一號');
  assert.equal(event.location, '中山高速公路-國道1號'); // unchanged — still the raw areaNm text
});

test('a PBS comment with no recognizable KM never gets a `displayKM` field at all (not even null)', () => {
  const event = normalizePbsEvent({
    UID: 'PBS-2026-08180002',
    road: '',
    areaNm: '中山高速公路-國道1號',
    roadtype: '事故',
    comment: '2車事故、3人受傷、17:05',
  });
  assert.equal('displayKM' in event, false);
});
