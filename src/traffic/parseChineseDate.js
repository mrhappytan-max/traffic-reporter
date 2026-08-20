// Parses the Chinese date/time-range phrasing seen in real TDX
// Description/CMS text into concrete Asia/Taipei instants. Supports (at
// least) the 3 confirmed real-data formats:
//
//   "8月27日8時至24時"                    -> this year, 08:00 -> next-day 00:00
//   "115年8月16日當日7時起至16時止"        -> ROC 115 = 2026, 07:00 -> 16:00
//   "8月22日9時至19時"                     -> this year, 09:00 -> 19:00
//
// V1.8.6.8 — plus two announced-schedule shapes real 施工/封路/繞境-class
// notices can carry that the original 3 formats above never exercised: an
// overnight window that genuinely crosses midnight (single occurrence,
// e.g. "8月20日21時至翌日6時"), and a multi-day date range with a
// recurring nightly window (e.g. "8月20日至8月25日每日21時至翌日6時", or a
// date-less "每日21時至翌日6時" for an indefinitely-recurring rule). See
// this file's own function comments for the exact matching/resolution
// logic. Neither addition changes how the 3 already-confirmed formats
// parse — every existing test for those keeps passing unmodified.
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
// (?:翌日|次日)?     optional "next day" marker before the end hour —
//                    informational only; the actual midnight-rollover
//                    decision below is arithmetic (end <= start), so this
//                    marker is never REQUIRED for a crossing window to
//                    resolve correctly, only additional textual evidence.
// (\d{1,2})時        end hour
// (?:止)?            optional filler word
const SINGLE_RANGE_PATTERN =
  /(?:(\d{2,3})年)?(\d{1,2})月(\d{1,2})日(?:當日)?(\d{1,2})時(?:起)?至(?:翌日|次日)?(\d{1,2})時(?:止)?/;

// A multi-day date range (optional) plus a required "每日" (daily-
// recurring) marker plus an hour range, optionally crossing midnight via
// the same 翌日/次日 marker. The date-range clause is entirely optional —
// a bare "每日21時至翌日6時" (no date at all) matches too, resolved as an
// indefinitely-recurring rule anchored on whatever day is being evaluated
// (see resolveRecurringOccurrence). "每日" is the required anchor word
// distinguishing this pattern from SINGLE_RANGE_PATTERN above — without
// it, a single dated range is still handled by SINGLE_RANGE_PATTERN
// alone, so there is no ambiguity between the two.
const RECURRING_PATTERN =
  /(?:(?:(\d{2,3})年)?(\d{1,2})月(\d{1,2})日(?:\s*(?:至|~|～)\s*(?:(\d{2,3})年)?(\d{1,2})月(\d{1,2})日)?\s*)?每日(\d{1,2})時(?:起)?至(?:翌日|次日)?(\d{1,2})時(?:止)?/;

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

function taipeiYearOf(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCFullYear();
}

/** {year, month, day} for the Taipei calendar date containing `date`. */
function taipeiDateOnly(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Calendar-date arithmetic via Date.UTC's own month/day overflow normalization — safe across month/year boundaries. */
function addCalendarDays(dateOnly, deltaDays) {
  const dt = new Date(Date.UTC(dateOnly.year, dateOnly.month - 1, dateOnly.day + deltaDays));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/** -1 / 0 / 1, calendar-date-only comparison (no time-of-day component). */
function compareDateOnly(a, b) {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return 0;
}

/**
 * One calendar day's own [start, end) instant pair for a daily
 * startHour/endHour window, rolling `end` into the FOLLOWING calendar day
 * whenever the same-day interpretation would put it at or before `start`
 * (endHour=24 already worked this way before this round via Date.UTC's
 * own normalization; this generalizes the same idea to any endHour <=
 * startHour, e.g. 21 -> 6, which the same-day interpretation would
 * otherwise put 15 hours in the PAST relative to start — the actual
 * cross-midnight bug this round fixes).
 */
function occurrenceForAnchorDay(anchor, startHour, endHour) {
  const start = taipeiPartsToUtcDate(anchor.year, anchor.month, anchor.day, startHour);
  let end = taipeiPartsToUtcDate(anchor.year, anchor.month, anchor.day, endHour);
  if (end.getTime() <= start.getTime()) {
    const nextDay = addCalendarDays(anchor, 1);
    end = taipeiPartsToUtcDate(nextDay.year, nextDay.month, nextDay.day, endHour);
  }
  return { start, end };
}

/**
 * Resolves a recurring daily window (optionally bounded by
 * [rangeStart, rangeEnd] calendar dates, either of which may be null for
 * an unbounded/indefinite side) to the ONE concrete occurrence relevant
 * to `referenceDate` — active right now if one is, otherwise the nearest
 * upcoming one (for isBroadcastRelevant's 60-minute-forecast leniency),
 * otherwise the most recent one that already ended (so effectiveEnd<=now
 * correctly reads "ended" rather than silently vanishing). Every field
 * `computeEffectiveWindow`'s existing consumers already expect
 * (effectiveStart/effectiveEnd, a single absolute pair) comes out of this
 * unchanged — this function is resolved FRESH on every call (same as the
 * whole effectiveWindow.js layer already is, every Cron tick), so there
 * is no separate recurring-schedule state to keep in sync anywhere.
 */
function resolveRecurringOccurrence({ rangeStart, rangeEnd, startHour, endHour, referenceDate }) {
  const today = taipeiDateOnly(referenceDate);
  const yesterday = addCalendarDays(today, -1);
  const nowMs = referenceDate.getTime();

  const inRange = (day) => (!rangeStart || compareDateOnly(day, rangeStart) >= 0) && (!rangeEnd || compareDateOnly(day, rangeEnd) <= 0);

  const candidateDays = [yesterday, today].filter(inRange);

  let active = null;
  let nearestFuture = null;
  let mostRecentPast = null;
  for (const anchor of candidateDays) {
    const occ = occurrenceForAnchorDay(anchor, startHour, endHour);
    if (occ.start.getTime() <= nowMs && nowMs < occ.end.getTime()) {
      active = occ;
    } else if (occ.start.getTime() > nowMs) {
      if (!nearestFuture || occ.start.getTime() < nearestFuture.start.getTime()) nearestFuture = occ;
    } else if (!mostRecentPast || occ.end.getTime() > mostRecentPast.end.getTime()) {
      mostRecentPast = occ;
    }
  }
  if (active) return active;
  if (nearestFuture) return nearestFuture;
  if (mostRecentPast) return mostRecentPast;

  // Neither yesterday nor today falls inside [rangeStart, rangeEnd] at
  // all — evaluating either strictly before the range starts or strictly
  // after it ends. Return the range's own boundary occurrence so the
  // result honestly reads "not yet started" or "already ended" against
  // the ACTUAL announced range, never a guess about content outside it.
  if (rangeStart && compareDateOnly(today, rangeStart) < 0) return occurrenceForAnchorDay(rangeStart, startHour, endHour);
  if (rangeEnd) return occurrenceForAnchorDay(rangeEnd, startHour, endHour);
  // No bounds at all on either side (fully indefinite recurring) — every
  // day is in range by construction above, so this is unreachable in
  // practice; kept as a defensive, honest fallback (today's own
  // occurrence) rather than throwing.
  return occurrenceForAnchorDay(today, startHour, endHour);
}

function matchSingleRange(text, referenceDate) {
  const match = text.match(SINGLE_RANGE_PATTERN);
  if (!match) return null;

  const [, rocYearStr, monthStr, dayStr, startHourStr, endHourStr] = match;
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const startHour = parseInt(startHourStr, 10);
  const endHour = parseInt(endHourStr, 10);

  if (!isPlausibleMonthDayHour(month, day, startHour) || !isPlausibleMonthDayHour(month, day, endHour)) return null;

  const year = rocYearStr ? parseInt(rocYearStr, 10) + ROC_YEAR_OFFSET : taipeiYearOf(referenceDate);
  const { start, end } = occurrenceForAnchorDay({ year, month, day }, startHour, endHour);
  return { start, end, confidence: 'high' };
}

function matchRecurring(text, referenceDate) {
  const match = text.match(RECURRING_PATTERN);
  if (!match) return null;

  const [, startRocYearStr, startMonthStr, startDayStr, endRocYearStr, endMonthStr, endDayStr, startHourStr, endHourStr] = match;
  const startHour = parseInt(startHourStr, 10);
  const endHour = parseInt(endHourStr, 10);
  if (!isPlausibleMonthDayHour(1, 1, startHour) || !isPlausibleMonthDayHour(1, 1, endHour)) return null;

  let rangeStart = null;
  if (startMonthStr && startDayStr) {
    const month = parseInt(startMonthStr, 10);
    const day = parseInt(startDayStr, 10);
    if (!isPlausibleMonthDayHour(month, day, 0)) return null;
    const year = startRocYearStr ? parseInt(startRocYearStr, 10) + ROC_YEAR_OFFSET : taipeiYearOf(referenceDate);
    rangeStart = { year, month, day };
  }

  let rangeEnd = null;
  if (endMonthStr && endDayStr) {
    const month = parseInt(endMonthStr, 10);
    const day = parseInt(endDayStr, 10);
    if (!isPlausibleMonthDayHour(month, day, 0)) return null;
    const year = endRocYearStr ? parseInt(endRocYearStr, 10) + ROC_YEAR_OFFSET : taipeiYearOf(referenceDate);
    rangeEnd = { year, month, day };
  }

  const { start, end } = resolveRecurringOccurrence({ rangeStart, rangeEnd, startHour, endHour, referenceDate });
  return { start, end, confidence: 'high' };
}

/**
 * @param {string} text
 * @param {{ referenceDate?: Date }} [options] - referenceDate supplies the
 *   year when the text doesn't specify one (defaults to the current year in
 *   Asia/Taipei), and is also the instant a recurring window is resolved
 *   relative to.
 * @returns {{ start: Date, end: Date, confidence: 'high' } | null}
 */
export function parseChineseDateRange(text, { referenceDate = new Date() } = {}) {
  if (!text || typeof text !== 'string') return null;

  // Try the recurring ("每日") pattern first — it's the more specific
  // match (requires the "每日" anchor word) and, unlike
  // SINGLE_RANGE_PATTERN, would never accidentally match a
  // SINGLE_RANGE_PATTERN-shaped substring anyway (SINGLE_RANGE_PATTERN
  // has no "每日" token), so ordering here doesn't create ambiguity —
  // it's simply "check for a recurring notice, else fall back to a
  // single dated occurrence."
  return matchRecurring(text, referenceDate) || matchSingleRange(text, referenceDate);
}
