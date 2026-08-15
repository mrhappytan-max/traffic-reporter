// Parses the Chinese date/time-range phrasing seen in real TDX
// Description/CMS text into concrete Asia/Taipei instants. Supports (at
// least) the 3 confirmed real-data formats:
//
//   "8月27日8時至24時"                    -> this year, 08:00 -> next-day 00:00
//   "115年8月16日當日7時起至16時止"        -> ROC 115 = 2026, 07:00 -> 16:00
//   "8月22日9時至19時"                     -> this year, 09:00 -> 19:00
//
// Returns null when nothing recognizable is found — callers must treat
// that as "cannot reliably determine timing" (see effectiveWindow.js),
// never as "assume it's happening now".

const ROC_YEAR_OFFSET = 1911;

// (?:(\d{2,3})年)?  optional ROC year, e.g. "115年"
// (\d{1,2})月(\d{1,2})日  month/day, required
// (?:當日)?          optional filler word, ignored
// (\d{1,2})時        start hour
// (?:起)?            optional filler word
// 至                 required range separator
// (\d{1,2})時        end hour
// (?:止)?            optional filler word
const RANGE_PATTERN = /(?:(\d{2,3})年)?(\d{1,2})月(\d{1,2})日(?:當日)?(\d{1,2})時(?:起)?至(\d{1,2})時(?:止)?/;

/** Asia/Taipei is a fixed UTC+8 offset (no DST) — safe to hard-code. */
function taipeiPartsToUtcDate(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0));
}

function isPlausibleMonthDayHour(month, day, hour) {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 24) return false;
  return true;
}

/**
 * @param {string} text
 * @param {{ referenceDate?: Date }} [options] - referenceDate supplies the
 *   year when the text doesn't specify one (defaults to the current year in
 *   Asia/Taipei).
 * @returns {{ start: Date, end: Date, confidence: 'high' } | null}
 */
export function parseChineseDateRange(text, { referenceDate = new Date() } = {}) {
  if (!text || typeof text !== 'string') return null;

  const match = text.match(RANGE_PATTERN);
  if (!match) return null;

  const [, rocYearStr, monthStr, dayStr, startHourStr, endHourStr] = match;

  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const startHour = parseInt(startHourStr, 10);
  const endHour = parseInt(endHourStr, 10);

  if (!isPlausibleMonthDayHour(month, day, startHour) || !isPlausibleMonthDayHour(month, day, endHour)) {
    return null;
  }

  const year = rocYearStr ? parseInt(rocYearStr, 10) + ROC_YEAR_OFFSET : taipeiYearOf(referenceDate);

  const start = taipeiPartsToUtcDate(year, month, day, startHour);
  // endHour=24 naturally rolls into 00:00 the next day via Date.UTC's own
  // normalization (hour-8 stays a valid 0-23 UTC hour, no special-casing
  // needed).
  const end = taipeiPartsToUtcDate(year, month, day, endHour);

  return { start, end, confidence: 'high' };
}

function taipeiYearOf(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCFullYear();
}
