import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBroadcastRelevant } from '../src/traffic/broadcastRules.js';
import { isWithinBroadcastHours, formatTaipeiTime } from '../src/traffic/broadcastHours.js';

const now1510 = new Date('2026-08-15T15:10:00+08:00');

test('60-min rule: now=15:10, starts 15:30 -> broadcastable (20 min away)', () => {
  assert.equal(isBroadcastRelevant({ effectiveStart: '2026-08-15T15:30:00+08:00', effectiveEnd: null }, now1510), true);
});

test('60-min rule: now=15:10, starts 16:00 -> broadcastable (50 min away)', () => {
  assert.equal(isBroadcastRelevant({ effectiveStart: '2026-08-15T16:00:00+08:00', effectiveEnd: null }, now1510), true);
});

test('60-min rule: now=15:10, starts 16:11 -> NOT broadcastable (71 min away)', () => {
  assert.equal(isBroadcastRelevant({ effectiveStart: '2026-08-15T16:11:00+08:00', effectiveEnd: null }, now1510), false);
});

test('60-min rule: starts tomorrow -> NOT broadcastable', () => {
  assert.equal(isBroadcastRelevant({ effectiveStart: '2026-08-16T09:00:00+08:00', effectiveEnd: null }, now1510), false);
});

test('60-min rule: already ended -> NOT broadcastable', () => {
  assert.equal(
    isBroadcastRelevant({ effectiveStart: '2026-08-15T13:00:00+08:00', effectiveEnd: '2026-08-15T15:00:00+08:00' }, now1510),
    false
  );
});

test('60-min rule: an accident currently happening (started earlier, still open) -> broadcastable', () => {
  assert.equal(isBroadcastRelevant({ effectiveStart: '2026-08-15T14:55:00+08:00', effectiveEnd: null }, now1510), true);
});

test('broadcast hours: 07:59:59 Taipei -> not within hours (0 push)', () => {
  assert.equal(isWithinBroadcastHours(new Date('2026-08-15T07:59:59+08:00')), false);
});

test('broadcast hours: 08:00:00 Taipei -> within hours (push allowed)', () => {
  assert.equal(isWithinBroadcastHours(new Date('2026-08-15T08:00:00+08:00')), true);
});

test('broadcast hours: 21:59:59 Taipei -> within hours (push allowed)', () => {
  assert.equal(isWithinBroadcastHours(new Date('2026-08-15T21:59:59+08:00')), true);
});

test('broadcast hours: 22:00:00 Taipei -> not within hours (0 push)', () => {
  assert.equal(isWithinBroadcastHours(new Date('2026-08-15T22:00:00+08:00')), false);
});

test('formatTaipeiTime renders a readable +08:00 timestamp', () => {
  assert.equal(formatTaipeiTime(new Date('2026-08-15T07:30:00Z')), '2026-08-15 15:30:00+08:00');
});
