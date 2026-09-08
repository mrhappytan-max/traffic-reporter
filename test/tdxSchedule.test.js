// V1.6.1 — pure unit tests for getTdxScheduleState (see tdxSchedule.js).
// Integration-level regression tests (the real Cron path end to end) live
// in tdxUsageReduction.test.js.
//
// V2.8.0 (路況-064) — window moved 08:00-22:00 -> 07:00-22:30. Every
// assertion that fell inside the OLD-only or NEW-only delta band (07:00-
// 07:59:59 and 22:00-22:30:59) has been rewritten to the new real boundary
// — these are not stale comments, the OLD assertions would now be actively
// wrong (e.g. 22:00:00 used to be 'night-sleep', is now 'scheduled', a
// 20-minute mark). Assertions entirely inside both windows (08:xx-21:xx)
// or entirely outside both (23:00+, 00:00-06:59) are unaffected and kept
// as-is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTdxScheduleState } from '../src/traffic/tdxSchedule.js';

test('minute 00/20/40 within 07:00-22:30 -> scheduled', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:00:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:20:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:40:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T21:40:00+08:00')), 'scheduled');
  // V2.8.0 new territory: 07:00 and 22:20 are only 'scheduled' under the
  // new boundary — under the old 08:00-22:00 boundary both used to be
  // 'night-sleep'.
  assert.equal(getTdxScheduleState(new Date('2026-08-18T07:00:00+08:00')), 'scheduled');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T22:20:00+08:00')), 'scheduled');
});

test('minute 10/30/50 within 07:00-22:30 -> skipped-by-schedule', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:10:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:30:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T08:50:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T21:50:00+08:00')), 'skipped-by-schedule');
  // V2.8.0 new territory: 07:10/07:50 are only reachable now that 07:00 is
  // inside the window at all.
  assert.equal(getTdxScheduleState(new Date('2026-08-18T07:10:00+08:00')), 'skipped-by-schedule');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T07:50:00+08:00')), 'skipped-by-schedule');
});

test('21:59:59 is still daytime -> scheduled at the 21:40 mark, skipped otherwise', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T21:59:00+08:00')), 'skipped-by-schedule');
});

test('22:30:00 is the exact new inclusive boundary — still within the window, but minute 30 is not a 20-minute mark, so skipped-by-schedule not scheduled (V2.8.0)', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T22:30:00+08:00')), 'skipped-by-schedule');
});

test('22:31:00 through 06:59:59 -> night-sleep, regardless of minute', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-18T22:31:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-18T22:40:00+08:00')), 'night-sleep'); // even on a 20-min mark
  assert.equal(getTdxScheduleState(new Date('2026-08-18T23:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T00:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T03:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T06:00:00+08:00')), 'night-sleep');
  assert.equal(getTdxScheduleState(new Date('2026-08-19T06:40:00+08:00')), 'night-sleep'); // even on a 20-min mark
  assert.equal(getTdxScheduleState(new Date('2026-08-19T06:59:00+08:00')), 'night-sleep');
});

test('07:00:00 is the exact boundary where TDX resumes (V2.8.0)', () => {
  assert.equal(getTdxScheduleState(new Date('2026-08-19T07:00:00+08:00')), 'scheduled');
});

test('default argument uses the real clock (does not throw)', () => {
  const state = getTdxScheduleState();
  assert.ok(['scheduled', 'skipped-by-schedule', 'night-sleep'].includes(state));
});
