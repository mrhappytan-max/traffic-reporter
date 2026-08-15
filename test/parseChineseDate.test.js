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
