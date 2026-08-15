// LINE pushes are only allowed 08:00:00–21:59:59 Asia/Taipei. Cron itself
// keeps running around the clock (fetch/normalize/baseline/dedup) — this
// only gates the push step, see broadcastPipeline.js.

/** Asia/Taipei is a fixed UTC+8 offset (no DST) — safe to hard-code. */
function toTaipeiParts(date) {
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

/** 08:00:00 (inclusive) through 21:59:59 (inclusive) Asia/Taipei. */
export function isWithinBroadcastHours(now = new Date()) {
  const { hour } = toTaipeiParts(now);
  return hour >= 8 && hour < 22;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Human-readable Asia/Taipei timestamp for /debug/status, e.g. "2026-08-15 17:30:00+08:00". */
export function formatTaipeiTime(now = new Date()) {
  const p = toTaipeiParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+08:00`;
}
