import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChineseDateRange } from '../src/traffic/parseChineseDate.js';

test('"8月27日8時至24時" -> this year 08:00 to next-day 00:00 Asia/Taipei', () => {
  const referenceDate = new Date('2026-01-01T00:00:00Z');
  const result = parseChineseDateRange('8月27日8時至24時', { referenceDate });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-27T00:00:00.000Z'); // 08:00 +08:00
  // "24時" = next-day 00:00 Taipei, which IS 2026-08-27T16:00:00Z (not a
  // day-later UTC timestamp — same instant, just described past midnight
  // local time).
  assert.equal(result.end.toISOString(), '2026-08-27T16:00:00.000Z'); // next-day 00:00 +08:00
  assert.equal(result.confidence, 'high');
});

test('"115年8月16日當日7時起至16時止" -> ROC 115 = 2026, 07:00 to 16:00', () => {
  const result = parseChineseDateRange('115年8月16日當日7時起至16時止', { referenceDate: new Date('2026-01-01T00:00:00Z') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-15T23:00:00.000Z'); // 07:00 +08:00 = prior-day 23:00 UTC
  assert.equal(result.end.toISOString(), '2026-08-16T08:00:00.000Z'); // 16:00 +08:00
});

test('"8月22日9時至19時" -> year inferred from referenceDate (Asia/Taipei)', () => {
  const result = parseChineseDateRange('8月22日9時至19時', { referenceDate: new Date('2026-03-01T00:00:00Z') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-22T01:00:00.000Z'); // 09:00 +08:00
  assert.equal(result.end.toISOString(), '2026-08-22T11:00:00.000Z'); // 19:00 +08:00
});

test('unmatched text returns null (caller must treat as unknown, not "now")', () => {
  assert.equal(parseChineseDateRange('前方壅塞請小心'), null);
  assert.equal(parseChineseDateRange(''), null);
  assert.equal(parseChineseDateRange(null), null);
  assert.equal(parseChineseDateRange(undefined), null);
});

// --- V1.8.6.8: cross-midnight / recurring-daily schedules ---------------

test('"8月20日21時至翌日6時" -> single occurrence genuinely crosses midnight (end is the NEXT calendar day, not 15h in the past)', () => {
  const result = parseChineseDateRange('8月20日21時至翌日6時', { referenceDate: new Date('2026-08-20T00:00:00+08:00') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-20T13:00:00.000Z'); // 21:00 +08:00, 8/20
  assert.equal(result.end.toISOString(), '2026-08-20T22:00:00.000Z'); // 06:00 +08:00, 8/21 (next day)
  assert.ok(result.end.getTime() > result.start.getTime(), 'end must be AFTER start, never before');
});

test('the same cross-midnight rollover applies even without an explicit 翌日/次日 marker (pure end<=start arithmetic)', () => {
  // "次日" omitted entirely — the rollover is a general end<=start rule,
  // not conditioned on the marker being textually present (see
  // occurrenceForAnchorDay's own comment).
  const withMarker = parseChineseDateRange('8月20日21時至翌日6時', { referenceDate: new Date('2026-08-20T00:00:00+08:00') });
  const withoutMarker = parseChineseDateRange('8月20日21時至6時', { referenceDate: new Date('2026-08-20T00:00:00+08:00') });
  assert.equal(withoutMarker.start.toISOString(), withMarker.start.toISOString());
  assert.equal(withoutMarker.end.toISOString(), withMarker.end.toISOString());
});

test('multi-day recurring: "8月20日至8月25日每日21時至翌日6時" resolves to the occurrence relevant to referenceDate — a middle day', () => {
  // Evaluated at 8/22 23:00 (a middle day of the range) -> must resolve
  // to 8/22 21:00 -> 8/23 06:00, the occurrence actually covering "now".
  const result = parseChineseDateRange('8月20日至8月25日每日21時至翌日6時', { referenceDate: new Date('2026-08-22T23:00:00+08:00') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-22T13:00:00.000Z'); // 21:00 +08:00, 8/22
  assert.equal(result.end.toISOString(), '2026-08-22T22:00:00.000Z'); // 06:00 +08:00, 8/23
});

test('multi-day recurring: the LAST day (8/25) still crosses midnight correctly, evaluated at 8/26 02:00', () => {
  const result = parseChineseDateRange('8月20日至8月25日每日21時至翌日6時', { referenceDate: new Date('2026-08-26T02:00:00+08:00') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-25T13:00:00.000Z'); // 21:00 +08:00, 8/25 (last day)
  assert.equal(result.end.toISOString(), '2026-08-25T22:00:00.000Z'); // 06:00 +08:00, 8/26
});

test('multi-day recurring: evaluated AFTER the whole range has ended -> resolves to the range\'s own last occurrence (reads as "ended", never silently vanishes)', () => {
  const result = parseChineseDateRange('8月20日至8月25日每日21時至翌日6時', { referenceDate: new Date('2026-08-27T12:00:00+08:00') });
  assert.ok(result);
  assert.equal(result.end.toISOString(), '2026-08-25T22:00:00.000Z'); // 8/25's occurrence, ending 8/26 06:00
  assert.ok(result.end.getTime() < new Date('2026-08-27T12:00:00+08:00').getTime());
});

test('multi-day recurring: evaluated BEFORE the range has started -> resolves to the range\'s own first occurrence (reads as "not started")', () => {
  const result = parseChineseDateRange('8月20日至8月25日每日21時至翌日6時', { referenceDate: new Date('2026-08-18T12:00:00+08:00') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-20T13:00:00.000Z'); // 8/20's occurrence
  assert.ok(result.start.getTime() > new Date('2026-08-18T12:00:00+08:00').getTime());
});

test('date-less recurring "每日21時至翌日6時" (no month/day at all) resolves relative to referenceDate, indefinitely', () => {
  const result = parseChineseDateRange('每日21時至翌日6時', { referenceDate: new Date('2026-08-20T23:00:00+08:00') });
  assert.ok(result);
  assert.equal(result.start.toISOString(), '2026-08-20T13:00:00.000Z');
  assert.equal(result.end.toISOString(), '2026-08-20T22:00:00.000Z');
});
