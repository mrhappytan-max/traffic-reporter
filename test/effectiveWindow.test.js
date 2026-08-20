import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEffectiveWindow, classifyEventTimeStatus } from '../src/traffic/effectiveWindow.js';
import { isBroadcastRelevant } from '../src/traffic/broadcastRules.js';

const now = new Date('2026-08-15T15:10:00+08:00'); // 15:10 Taipei

test('live accident event: effectiveStart from startTime, effectiveEnd open, high confidence', () => {
  const event = {
    source: 'freeway',
    type: 'accident',
    description: '國道1號事故',
    startTime: '2026-08-15T14:50:00+08:00',
    endTime: null,
  };
  const window = computeEffectiveWindow(event, now);
  assert.equal(window.effectiveStart, '2026-08-15T14:50:00+08:00');
  assert.equal(window.effectiveEnd, null);
  assert.equal(window.timeSource, 'structured');
  assert.equal(window.confidence, 'high');
});

test('CMS source is always treated as live regardless of type', () => {
  const event = { source: 'cms', type: 'congestion', description: '車多壅塞', startTime: null, endTime: null };
  const window = computeEffectiveWindow(event, now);
  assert.equal(window.timeSource, 'structured');
  assert.ok(window.effectiveStart); // falls back to "now" since no startTime
});

test('announced construction event: parses a real date/time window from description', () => {
  const event = {
    source: 'highway',
    type: 'construction',
    description: '台1線8月22日9時至19時施工',
    startTime: '2026-08-14T00:00:00+08:00', // deliberately NOT trusted as effectiveStart
  };
  const window = computeEffectiveWindow(event, new Date('2026-08-15T00:00:00+08:00'));
  assert.equal(window.timeSource, 'description');
  assert.equal(window.confidence, 'high');
  assert.equal(window.effectiveStart, '2026-08-22T01:00:00.000Z'); // 09:00 +08:00
  assert.equal(window.effectiveEnd, '2026-08-22T11:00:00.000Z'); // 19:00 +08:00
});

test('announced construction with unparseable description: effectiveStart is null (do not guess "now")', () => {
  const event = {
    source: 'highway',
    type: 'construction',
    description: '近期將進行路面維修工程',
    startTime: '2026-08-15T08:00:00+08:00', // must NOT be used as a fallback
  };
  const window = computeEffectiveWindow(event, now);
  assert.equal(window.effectiveStart, null);
  assert.equal(window.effectiveEnd, null);
  assert.equal(window.timeSource, 'fallback');
  assert.equal(window.confidence, 'low');
});

test('isBroadcastRelevant: null effectiveStart (unknown timing) is never broadcast', () => {
  assert.equal(isBroadcastRelevant({ effectiveStart: null, effectiveEnd: null }, now), false);
});

test('isBroadcastRelevant: already started and not ended -> true', () => {
  assert.equal(
    isBroadcastRelevant({ effectiveStart: '2026-08-15T14:50:00+08:00', effectiveEnd: null }, now),
    true
  );
});

test('isBroadcastRelevant: already ended -> false', () => {
  assert.equal(
    isBroadcastRelevant({ effectiveStart: '2026-08-15T13:00:00+08:00', effectiveEnd: '2026-08-15T14:00:00+08:00' }, now),
    false
  );
});

// --- V1.8.6.8: classifyEventTimeStatus — the shared classifier
// isBroadcastRelevant() is itself built on (see broadcastRules.js), and
// what Pipeline Trace's eventActive/eventTimeStatus fields read directly.

test('classifyEventTimeStatus: no effectiveStart at all -> "no-data"', () => {
  assert.equal(classifyEventTimeStatus({ effectiveStart: null, effectiveEnd: null }, now), 'no-data');
  assert.equal(classifyEventTimeStatus(null, now), 'no-data');
});

test('classifyEventTimeStatus: started, not ended -> "active"', () => {
  assert.equal(classifyEventTimeStatus({ effectiveStart: '2026-08-15T14:50:00+08:00', effectiveEnd: null }, now), 'active');
});

test('classifyEventTimeStatus: already ended -> "ended"', () => {
  assert.equal(
    classifyEventTimeStatus({ effectiveStart: '2026-08-15T13:00:00+08:00', effectiveEnd: '2026-08-15T14:00:00+08:00' }, now),
    'ended'
  );
});

test('classifyEventTimeStatus: starts in the future (any distance, even beyond the 60-min forecast) -> "not-started"', () => {
  assert.equal(classifyEventTimeStatus({ effectiveStart: '2026-08-15T18:00:00+08:00', effectiveEnd: null }, now), 'not-started');
  // Confirms this differs from isBroadcastRelevant's own forecast
  // leniency: "not-started" here regardless of how far away, while
  // isBroadcastRelevant adds its OWN 60-minute allowance on top.
  assert.equal(isBroadcastRelevant({ effectiveStart: '2026-08-15T18:00:00+08:00', effectiveEnd: null }, now), false);
});

test('classifyEventTimeStatus: isBroadcastRelevant\'s 60-minute forecast leniency is unchanged by this round — starts within 60min -> relevant true, but eventTimeStatus still reads "not-started" (the two axes are genuinely distinct)', () => {
  const window = { effectiveStart: '2026-08-15T15:40:00+08:00', effectiveEnd: null }; // 30 min after `now`
  assert.equal(classifyEventTimeStatus(window, now), 'not-started');
  assert.equal(isBroadcastRelevant(window, now), true);
});
