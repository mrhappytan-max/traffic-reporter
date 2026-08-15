import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCrossSourceMatch, buildCanonicalEvent, crossSourceDedup } from '../src/pbs/crossSourceDedup.js';

function tdxEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '國道一號 北向 87K+800',
    description: '國道一號北向87.8K車輛事故，外側車道封閉',
    startKM: '87K+800',
    endKM: '88K+000',
    startTime: '2026-08-15T14:15:00.000Z',
    updatedAt: '2026-08-15T14:20:00.000Z',
    blockedLanes: 1,
  };
}

function pbsEvent(overrides = {}) {
  return {
    source: 'pbs',
    rawId: 'PBS-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '(湖口)-國道１號',
    description: '回堵4K，湖口服務區前，內線2自小事故',
    updatedAt: '2026-08-15T14:22:00.000Z',
    happenedAt: '2026-08-15T14:16:00.000Z',
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

test('road/direction/type/time all agree, no KM info on the PBS side beyond description -> matches via description KM parsing', () => {
  const pbs = pbsEvent({ description: '回堵4K，湖口服務區前，內線2自小事故，約在87.8公里處' });
  const match = findCrossSourceMatch(pbs, [tdxEvent()]);
  assert.ok(match);
  assert.equal(match.rawId, 'FRW-1');
});

test('different type never merges (accident vs construction)', () => {
  const pbs = pbsEvent({ type: 'construction', description: '國道一號北向87.8公里施工' });
  const match = findCrossSourceMatch(pbs, [tdxEvent()]);
  assert.equal(match, null);
});

test('different road never merges', () => {
  const pbs = pbsEvent({ road: '國道三號', description: '國道三號北向87.8公里事故' });
  const match = findCrossSourceMatch(pbs, [tdxEvent()]);
  assert.equal(match, null);
});

test('different direction never merges', () => {
  const pbs = pbsEvent({ direction: '南向', description: '國道一號南向87.8公里事故' });
  const match = findCrossSourceMatch(pbs, [tdxEvent()]);
  assert.equal(match, null);
});

test('KM too far apart (> max diff) does not merge', () => {
  const pbs = pbsEvent({ description: '國道一號北向120公里事故' }); // way past 87.8K
  const match = findCrossSourceMatch(pbs, [tdxEvent()]);
  assert.equal(match, null);
});

test('time too far apart (> ±15 min) does not merge even with everything else matching', () => {
  const pbs = pbsEvent({
    description: '國道一號北向87.8公里事故',
    updatedAt: '2026-08-15T16:00:00.000Z', // way later than tdxEvent's 14:20
  });
  const match = findCrossSourceMatch(pbs, [tdxEvent()]);
  assert.equal(match, null);
});

test('coordinates on both sides within the distance threshold match even without KM text', () => {
  const pbs = pbsEvent({ description: '回堵4K，內線事故', latitude: 24.85, longitude: 121.05 });
  const tdx = { ...tdxEvent(), latitude: 24.851, longitude: 121.051 }; // ~150m away
  const match = findCrossSourceMatch(pbs, [tdx]);
  assert.ok(match);
});

test('buildCanonicalEvent: TDX structured fields stay primary, PBS contributes detail', () => {
  const canonical = buildCanonicalEvent(tdxEvent(), pbsEvent());
  assert.equal(canonical.primarySource, 'tdx');
  assert.deepEqual(canonical.sources, ['tdx', 'pbs']);
  assert.equal(canonical.road, '國道一號');
  assert.equal(canonical.direction, '北向');
  assert.equal(canonical.type, 'accident');
  assert.match(canonical.pbsDetail, /回堵4K/);
  assert.equal(canonical.tdxRawId, 'FRW-1');
  assert.equal(canonical.pbsRawId, 'PBS-1');
});

test('crossSourceDedup: a matched PBS event becomes canonical and is excluded from uniquePbsEvents; an unmatched one stays unique', () => {
  const matching = pbsEvent({ description: '回堵4K，內線事故，約87.8公里' });
  const unrelated = pbsEvent({ rawId: 'PBS-2', road: '台68', description: '西行8.1公里事故' });

  const { canonicalEvents, duplicatePbsEvents, uniquePbsEvents } = crossSourceDedup([matching, unrelated], [tdxEvent()]);

  assert.equal(canonicalEvents.length, 1);
  assert.equal(duplicatePbsEvents.length, 1);
  assert.equal(duplicatePbsEvents[0].rawId, 'PBS-1');
  assert.equal(uniquePbsEvents.length, 1);
  assert.equal(uniquePbsEvents[0].rawId, 'PBS-2');
});

test('no TDX events at all -> every PBS event is unique, no canonical events, no crash', () => {
  const { canonicalEvents, duplicatePbsEvents, uniquePbsEvents } = crossSourceDedup([pbsEvent()], []);
  assert.equal(canonicalEvents.length, 0);
  assert.equal(duplicatePbsEvents.length, 0);
  assert.equal(uniquePbsEvents.length, 1);
});
