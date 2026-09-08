// V1.6.1 — "資料來源與 TDX 用量瘦身". TDX (國道+省道 only, see
// ../tdx/sources.js's PRODUCTION_TDX_SOURCE_IDS) is no longer fetched every
// Cron tick — only every 2nd tick (minute 00/20/40), and only during
// broadcastHours.js's own window (see below for its current boundary).
//
// V2.8.0 (路況-064, following 路況-063's own read-only查證) — the window
// this module gates on is now 07:00:00–22:30:59 Asia/Taipei (moved from
// the previous 08:00:00–21:59:59), via isWithinBroadcastHours()'s own
// V2.8.0 change — this module makes zero logic changes of its own, it
// only ever re-reads that shared function. The line below ("PBS keeps
// running every tick, 24/7") describing PBS is this module's own original
// V1.6.1-era note and has been stale since V1.9.3/V1.9.8: PBS is no
// longer fetched by Cloudflare's own Cron tick at all in real Production
// — see pbsConfig.js's own PBS_30_MIN_POLLING_ENABLED comment (defaults
// false since V1.9.8) — real PBS data now arrives via the Windows local
// edge monitor's own push ingress (pbs/debugPush.js), on its own
// independent schedule, outside Cloudflare's control entirely. This
// module only ever decided TDX's own cadence, never PBS's — the note is
// corrected here, not removed, since it is still accurate context for why
// this module doesn't also gate PBS.
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
//   - 'night-sleep'         — outside 07:00–22:30 entirely; TDX isn't
//                             expected to run again until the next 07:00.

import { toTaipeiParts, isWithinBroadcastHours } from './broadcastHours.js';

export function getTdxScheduleState(now = new Date()) {
  if (!isWithinBroadcastHours(now)) return 'night-sleep';
  const { minute } = toTaipeiParts(now);
  return minute % 20 === 0 ? 'scheduled' : 'skipped-by-schedule';
}
