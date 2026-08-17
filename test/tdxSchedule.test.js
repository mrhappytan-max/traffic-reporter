// V1.6.1 — pure unit tests for getTdxScheduleState (see tdxSchedule.js).
// Integration-level regression tests (the real Cron path end to end) live
// in tdxUsageReduction.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTdxScheduleState } from '../src/traffic/tdxSchedule.js';

test('minute 00/20/40 within 08:00-22:00 -> scheduled', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:00:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:20:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:40:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T21:40:00+08:00')), 'scheduled');
});

test('minute 10/30/50 within 08:00-22:00 -> skipped-by-schedule', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:10:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:30:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:50:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T21:50:00+08:00')), 'skipped-by-schedule');
});

test('21:59:59 is still daytime -> scheduled at the 21:40 mark, skipped otherwise', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T21:59:00+08:00')), 'skipped-by-schedule');
});

test('22:00 through 07:59:59 -> night-sleep, regardless of minute', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T22:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T22:20:00+08:00')), 'night-sleep'); // even on a 20-min mark
  assert.equal(getTdxScheduleState(new Date('2026-08-18T23:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T00:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T03:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T07:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T07:40:00+08:00')), 'night-sleep'); // even on a 20-min mark
  assert.equal(getTdxScheduleState(new Date('2026-08-19T07:59:00+08:00')), 'night-sleep');
});

test('08:00:00 is the exact boundary where TDX resumes', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-19T08:00:00+08:00')), 'scheduled');
});

test('default argument uses the real clock (does not throw)', () => {
  const state = getTdxScheduleState();
  assert.ok(['scheduled', 'skipped-by-schedule', 'night-sleep'].includes(state));
});
