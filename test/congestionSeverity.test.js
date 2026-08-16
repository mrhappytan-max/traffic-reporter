import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCongestionSeverity, mostSevereCongestion, DEFAULT_CONGESTION_SEVERITY } from '../src/traffic/congestionSeverity.js';

test('"車多" alone classifies as moderate', () => {
  assert.equal(classifyCongestionSeverity('北向92K車多'), 'moderate');
});

test('"壅塞" classifies as congested, not moderate', () => {
  assert.equal(classifyCongestionSeverity('北向92K壅塞'), 'congested');
});

test('"回堵"/"塞車"/"擁擠"/"車潮" all classify as congested', () => {
  for (const text of ['北向回堵1公里', '國道塞車', '車道擁擠', '車潮眾多']) {
    assert.equal(classifyCongestionSeverity(text), 'congested', `expected congested for: ${text}`);
  }
});

test('text containing BOTH "車多" and a stronger keyword ("車多回堵") classifies as congested, not moderate', () => {
  assert.equal(classifyCongestionSeverity('北向車多回堵'), 'congested');
});

test('no recognizable keyword -> null (caller must treat as DEFAULT_CONGESTION_SEVERITY, never severe)', () => {
  assert.equal(classifyCongestionSeverity('北向92K事故'), null);
  assert.equal(classifyCongestionSeverity(''), null);
  assert.equal(classifyCongestionSeverity(null), null);
  assert.equal(classifyCongestionSeverity(undefined), null);
});

test('DEFAULT_CONGESTION_SEVERITY is "congested", never "severe"', () => {
  assert.equal(DEFAULT_CONGESTION_SEVERITY, 'congested');
});

test('mostSevereCongestion: severe > congested > moderate > null', () => {
  assert.equal(mostSevereCongestion('severe', 'congested'), 'severe');
  assert.equal(mostSevereCongestion('congested', 'severe'), 'severe');
  assert.equal(mostSevereCongestion('congested', 'moderate'), 'congested');
  assert.equal(mostSevereCongestion('moderate', 'congested'), 'congested');
  assert.equal(mostSevereCongestion(null, 'moderate'), 'moderate');
  assert.equal(mostSevereCongestion('moderate', null), 'moderate');
  assert.equal(mostSevereCongestion(null, null), null);
  assert.equal(mostSevereCongestion(undefined, undefined), null);
});

test('mostSevereCongestion never invents "severe" from two lower inputs', () => {
  assert.equal(mostSevereCongestion('moderate', 'congested'), 'congested');
  assert.notEqual(mostSevereCongestion('moderate', 'congested'), 'severe');
});
