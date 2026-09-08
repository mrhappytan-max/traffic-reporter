// LINE/Telegram pushes are only allowed 07:00:00–22:30:00 Asia/Taipei. Cron
// itself keeps running around the clock (fetch/normalize/baseline/dedup) —
// this only gates the push step, see broadcastPipeline.js.
//
// V2.8.0 (路況-064, following 路況-063's own read-only查證) — boundary moved
// from 08:00-22:00 to 07:00-22:30. isWithinBroadcastHours() is the ONE
// shared function this module-level change flows through to BOTH real
// consumers: aiApprovedPbsBroadcast.js's own LINE/Telegram push gate, and
// tdxSchedule.js's TDX fetch gate (路況-063 confirmed these are the only
// two real-Production call sites; broadcastPipeline.js/pipelineTrace.js
// are the legacy/display-only references). By design this round keeps
// both call sites on the exact same boundary (真人已定案 in 路況-064's own
// order — TDX抓取與LINE/電報推播採相同07:00~22:30), so a single change
// here is sufficient; splitting into two independent functions was
// explicitly NOT authorized this round.
//
// The comparison itself moved from an hour-only check (`hour>=8 && hour<22`
// — structurally unable to express a non-round ":30" boundary) to a
// minutes-since-midnight comparison, reusing the exact arithmetic pattern
// traffic/pbsSchedule.js's own WINDOW_START_MINUTES/WINDOW_END_MINUTES
// already established (路況-063's own item五 finding) — never a new
// algorithm design.

/**
 * Asia/Taipei is a fixed UTC+8 offset (no DST) — safe to hard-code.
 * Exported (V1.6.1) so tdxSchedule.js can reuse the exact same wall-clock
 * conversion for its own minute-of-hour check, rather than re-deriving it.
 */
export function toTaipeiParts(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

// V2.8.0 (路況-064) — minutes-since-midnight, same idiom as pbsSchedule.js's
// own WINDOW_START_MINUTES/WINDOW_END_MINUTES.
const BROADCAST_WINDOW_START_MINUTES = 7 * 60; // 07:00
const BROADCAST_WINDOW_END_MINUTES = 22 * 60 + 30; // 22:30 (inclusive — 22:30:00~22:30:59 itself still within window)

/** 07:00:00 (inclusive) through 22:30:59 (inclusive) Asia/Taipei. */
export function isWithinBroadcastHours(now = new Date()) {
  const { hour, minute } = toTaipeiParts(now);
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= BROADCAST_WINDOW_START_MINUTES && totalMinutes <= BROADCAST_WINDOW_END_MINUTES;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Human-readable Asia/Taipei timestamp for /debug/status, e.g. "2026-08-15 17:30:00+08:00". */
export function formatTaipeiTime(now = new Date()) {
  const p = toTaipeiParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+08:00`;
}
