// V1.6.1 — "資料來源與 TDX 用量瘦身". TDX (國道+省道 only, see
// ../tdx/sources.js's PRODUCTION_TDX_SOURCE_IDS) is no longer fetched every
// Cron tick — only every 2nd tick (minute 00/20/40), and only during
// 08:00:00–21:59:59 Asia/Taipei. PBS keeps running every tick, 24/7 (see
// scheduled.js) — this module only decides TDX's own cadence.
//
// Pure function of `now`, no I/O — trivially unit-testable, and reused
// unchanged by scheduled.js (the real Cron) and this module's own tests.
//
// Three states, not just a boolean — the health snapshot/page need to tell
// these apart (a skipped-by-schedule or night-sleep tick must NEVER be
// misread as a TDX failure, see healthSnapshot.js/health.js):
//   - 'scheduled'           — this tick should fetch TDX.
//   - 'skipped-by-schedule' — daytime, but not a 20-minute mark (a
//                             PBS-only tick).
//   - 'night-sleep'         — outside 08:00–22:00 entirely; TDX isn't
//                             expected to run again until the next 08:00.

import { toTaipeiParts, isWithinBroadcastHours } from './broadcastHours.js';

export function getTdxScheduleState(now = new Date()) {
  if (!isWithinBroadcastHours(now)) return 'night-sleep';
  const { minute } = toTaipeiParts(now);
  return minute % 20 === 0 ? 'scheduled' : 'skipped-by-schedule';
}
