import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPbsScheduleState } from '../src/traffic/pbsSchedule.js';

// Asia/Taipei is UTC+8 — construct times directly with the +08:00 offset
// so these tests read exactly like the V1.9.3 order's own worked table.
function taipei(hhmm) {
  return new Date(`2026-08-26T${hhmm}:00+08:00`);
}

// V1.9.3 order, section 六, tests #4-#11 (07:00 YES / 07:10 NO / 07:20 NO /
// 07:30 YES / 22:00 YES / 22:10 NO / 06:50 NO / 07:00 YES again).

test('#4 07:00 -> scheduled (FETCH)', () => {
  assert.equal(getPbsScheduleState(taipei('07:00')), 'scheduled');
});

test('#5 07:10 -> skipped-by-schedule (SKIP)', () => {
  assert.equal(getPbsScheduleState(taipei('07:10')), 'skipped-by-schedule');
});

test('#6 07:20 -> skipped-by-schedule (SKIP)', () => {
  assert.equal(getPbsScheduleState(taipei('07:20')), 'skipped-by-schedule');
});

test('#7 07:30 -> scheduled (FETCH)', () => {
  assert.equal(getPbsScheduleState(taipei('07:30')), 'scheduled');
});

test('#8 22:00 -> scheduled (FETCH) — the window boundary itself still fetches', () => {
  assert.equal(getPbsScheduleState(taipei('22:00')), 'scheduled');
});

test('#9 22:10 -> night-sleep (SKIP)', () => {
  assert.equal(getPbsScheduleState(taipei('22:10')), 'night-sleep');
});

test('#10 06:50 -> night-sleep (SKIP)', () => {
  assert.equal(getPbsScheduleState(taipei('06:50')), 'night-sleep');
});

test('#11 07:00 (next day) -> scheduled (FETCH) — resumes correctly', () => {
  const nextDay = new Date('2026-08-27T07:00:00+08:00');
  assert.equal(getPbsScheduleState(nextDay), 'scheduled');
});

// Extra coverage beyond the order's own table: every 10-minute Cron tick
// across a full day, so the whole schedule shape is locked, not just the
// eleven called-out points.
test('full-day sweep: every 10-minute Cron tick matches the exact 07:00-22:00 / 30-minute-mark rule', () => {
  const expectedFetchMinutesOfDay = new Set();
  for (let totalMinutes = 7 * 60; totalMinutes <= 22 * 60; totalMinutes += 30) {
    expectedFetchMinutesOfDay.add(totalMinutes);
  }
  for (let totalMinutes = 0; totalMinutes < 24 * 60; totalMinutes += 10) {
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    const state = getPbsScheduleState(taipei(`${hh}:${mm}`));
    const withinWindow = totalMinutes >= 7 * 60 && totalMinutes <= 22 * 60;
    if (expectedFetchMinutesOfDay.has(totalMinutes)) {
      assert.equal(state, 'scheduled', `${hh}:${mm} should be scheduled`);
    } else if (withinWindow) {
      assert.equal(state, 'skipped-by-schedule', `${hh}:${mm} should be skipped-by-schedule`);
    } else {
      assert.equal(state, 'night-sleep', `${hh}:${mm} should be night-sleep`);
    }
  }
});

test('pure function of `now` — no I/O, no hidden state, same input always gives same output', () => {
  const a = getPbsScheduleState(taipei('07:30'));
  const b = getPbsScheduleState(taipei('07:30'));
  assert.equal(a, b);
});
