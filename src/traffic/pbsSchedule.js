// V1.9.3 — KV Write Optimization Phase 2, item 二 (PBS fetch cadence).
// Real Cloudflare account alert (see 07_KNOWN_ISSUES.md's V1.9.2 record)
// showed PBS's own fixed every-10-minute fetch as one of the largest
// remaining sources of downstream KV writes (lifecycle state, cross-source
// dedup, Shared Feed, Pipeline Trace all key off "did PBS fetch this
// tick"). PBS is now fetched at most every 30 minutes, and only during
// 07:00:00–22:00:00 Asia/Taipei — Cron ITSELF still runs every 10 minutes
// unchanged (see wrangler.jsonc/scheduled.js); this module only decides
// whether THIS tick should perform the actual PBS HTTP fetch.
//
// Safety check performed before this was written (not skipped): every PBS
// lifecycle rule that could plausibly depend on fetch cadence is
// wall-clock-based, not tick-count-based — PBS_STALE_THRESHOLD_MS (2h) and
// PBS_ABSENCE_GRACE_PERIOD_MS (24h), both in pbsConfig.js, are each far
// larger than both the 30-minute daytime gap and the ~9-hour night gap
// this introduces. LINE push itself is already restricted to
// 08:00–21:59:59 Asia/Taipei (broadcastHours.js), so the 07:00 PBS restart
// (one hour before broadcasting resumes) gives a full hour of buffer
// before anything could be pushed on stale night data. No known Production
// safety dependency requires a night-time PBS fetch; this was NOT
// self-decided against clear evidence and is recorded here so a future
// reader can verify the same conclusion from the same two constants.
//
// Pure function of `now`, no I/O — same idiom as tdxSchedule.js. Three
// states, not just a boolean, for the exact same reason tdxSchedule.js
// uses three: health.js/healthSnapshot.js must be able to tell "this tick
// deliberately didn't fetch" apart from "PBS is actually broken" (see
// healthSnapshot.js's pbs carry-forward).
//
//   - 'scheduled'           — this tick should fetch PBS.
//   - 'skipped-by-schedule' — inside 07:00–22:00, but not a 30-minute mark.
//   - 'night-sleep'         — outside 07:00–22:00 entirely.
//
// Examples (Asia/Taipei, matching the order's own worked table):
//   07:00 scheduled   07:10 skipped-by-schedule   07:20 skipped-by-schedule
//   07:30 scheduled   ...   22:00 scheduled
//   22:10..06:50 night-sleep   07:00 scheduled (resumes)

import { toTaipeiParts } from './broadcastHours.js';

const WINDOW_START_MINUTES = 7 * 60; // 07:00
const WINDOW_END_MINUTES = 22 * 60; // 22:00 (inclusive — 22:00 itself still fetches)
const FETCH_INTERVAL_MINUTES = 30;

export function getPbsScheduleState(now = new Date()) {
  const { hour, minute } = toTaipeiParts(now);
  const totalMinutes = hour * 60 + minute;
  const withinWindow = totalMinutes >= WINDOW_START_MINUTES && totalMinutes <= WINDOW_END_MINUTES;
  if (!withinWindow) return 'night-sleep';
  return totalMinutes % FETCH_INTERVAL_MINUTES === 0 ? 'scheduled' : 'skipped-by-schedule';
}
