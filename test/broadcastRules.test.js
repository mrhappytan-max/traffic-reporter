import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBroadcastRelevant, getBroadcastEligibility, isBroadcastEligibleType } from '../src/traffic/broadcastRules.js';
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

// --- V1.5: broadcast eligibility whitelist/conditional rule ---

for (const type of ['accident', 'closure', 'control']) {
  test(`getBroadcastEligibility: ${type} is always eligible, no keyword needed`, () => {
    const result = getBroadcastEligibility({ type, title: '', description: '' });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'eligible-type');
  });
}

test('getBroadcastEligibility: congestion is never eligible', () => {
  const result = getBroadcastEligibility({ type: 'congestion', description: '嚴重壅塞' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'congestion-excluded');
});

test('getBroadcastEligibility: alert is not eligible by default', () => {
  const result = getBroadcastEligibility({ type: 'alert', description: '公車繞道公告' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'alert-excluded');
});

test('getBroadcastEligibility: construction WITHOUT an impact keyword (routine paving) is not eligible', () => {
  const result = getBroadcastEligibility({ type: 'construction', description: '8月15日9時至12時路面刨鋪施工' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'construction-no-impact-keyword');
});

test('getBroadcastEligibility: construction WITH an impact keyword is eligible', () => {
  for (const keyword of ['封閉', '車道封閉', '占用車道', '佔用車道', '禁止通行', '無法通行', '改道', '交通管制']) {
    const result = getBroadcastEligibility({ type: 'construction', description: `施工${keyword}` });
    assert.equal(result.eligible, true, `expected eligible for keyword: ${keyword}`);
    assert.equal(result.reason, 'construction-impact-keyword');
  }
});

test('getBroadcastEligibility: construction impact keyword may appear in the title instead of the description', () => {
  const result = getBroadcastEligibility({ type: 'construction', title: '國道施工車道封閉', description: '' });
  assert.equal(result.eligible, true);
});

test('getBroadcastEligibility: other WITHOUT a recognized anomaly keyword is not eligible', () => {
  const result = getBroadcastEligibility({ type: 'other', description: '一般公告事項' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'other-no-anomaly-keyword');
});

test('getBroadcastEligibility: other WITH a recognized anomaly keyword is eligible', () => {
  for (const keyword of [
    '淹水', '積水', '涵洞', '落石', '坍方', '路基流失', '樹倒', '電線掉落', '電線桿倒',
    '掉落物', '貨物散落', '火災', '橋梁封閉', '橋梁異常', '河川暴漲', '溪水暴漲', '道路中斷', '無法通行',
  ]) {
    const result = getBroadcastEligibility({ type: 'other', description: `路況異常：${keyword}` });
    assert.equal(result.eligible, true, `expected eligible for keyword: ${keyword}`);
    assert.equal(result.reason, 'other-anomaly-keyword');
  }
});

test('getBroadcastEligibility: an unrecognized type fails closed', () => {
  const result = getBroadcastEligibility({ type: 'made-up-future-type', description: '封閉' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unrecognized-type');
});

test('isBroadcastEligibleType is a thin boolean wrapper around getBroadcastEligibility', () => {
  assert.equal(isBroadcastEligibleType({ type: 'accident' }), true);
  assert.equal(isBroadcastEligibleType({ type: 'congestion' }), false);
  assert.equal(isBroadcastEligibleType({ type: 'construction', description: '施工' }), false);
  assert.equal(isBroadcastEligibleType({ type: 'construction', description: '施工車道封閉' }), true);
});
