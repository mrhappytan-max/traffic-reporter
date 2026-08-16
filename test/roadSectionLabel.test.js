import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRoadSectionLabel, getRoadShortName, getCorridorId } from '../src/traffic/roadSectionLabel.js';

test('1. 國1 北向 91K -> 82K includes both 竹北 and 湖口', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '91K+000', endKM: '82K+400' });
  assert.match(label, /竹北/);
  assert.match(label, /湖口/);
});

test('2. 國1 南向 86.5K -> 87.2K includes 湖口服務區', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '86K+500', endKM: '87K+200' });
  assert.match(label, /湖口服務區/);
});

test('3. 國1 南向 91K -> 95K is a 竹北-新竹 range', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '91K+000', endKM: '95K+000' });
  assert.match(label, /竹北/);
  assert.match(label, /新竹/);
});

test('4. 國1 95K -> 99K is 新竹／科學園區－新竹系統路段', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '95K+000', endKM: '99K+000' });
  assert.equal(label, '新竹／科學園區－新竹系統路段');
});

// V1.4.1: production report — 國1 北向 105.72K - 104.52K had no section
// label at all (anchors previously stopped at 新竹系統/99K).
test('4b. 國1 北向 105.72K -> 104.52K (production report) is 頭份－新竹系統路段', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '105K+720', endKM: '104K+520' });
  assert.equal(label, '頭份－新竹系統路段');
});

test('4c. 國1 頭份 anchor point (109K+720) resolves to 頭份附近', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '109K+720', endKM: '109K+720' });
  assert.equal(label, '頭份附近');
});

test('5. 國3 anchor mapping: 關西/竹林/寶山/新竹系統', () => {
  const kx_zl = getRoadSectionLabel({ road: '國道三號', startKM: '79K+000', endKM: '90K+000' });
  assert.match(kx_zl.label, /關西/);
  assert.match(kx_zl.label, /竹林/);

  const zl_bs = getRoadSectionLabel({ road: '國道三號', startKM: '90K+000', endKM: '98K+000' });
  assert.match(zl_bs.label, /竹林/);
  assert.match(zl_bs.label, /寶山/);

  const nearBaoshan = getRoadSectionLabel({ road: '國道三號', startKM: '97K+500', endKM: '98K+200' });
  assert.equal(nearBaoshan.label, '寶山附近');

  const nearSystem = getRoadSectionLabel({ road: '國道三號', startKM: '99K+800', endKM: '100K+300' });
  assert.equal(nearSystem.label, '新竹系統附近');

  const qt_xs = getRoadSectionLabel({ road: '國道三號', startKM: '103K+000', endKM: '109K+000' });
  assert.match(qt_xs.label, /茄苳/);
  assert.match(qt_xs.label, /香山/);
});

test('北向 91K -> 82K reads "竹北－湖口" (start->end order preserved, matches direction of travel)', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '91K+000', endKM: '82K+400' });
  assert.equal(label, '竹北－湖口路段');
});

test('南向 83K -> 91K reads "湖口－竹北" (reversed order, matches the other direction of travel)', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '83K+000', endKM: '91K+000' });
  assert.equal(label, '湖口－竹北路段');
});

test('a single close KM point collapses to "XX附近" rather than a repeated two-name range', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '87K+600', endKM: '87K+600' });
  assert.equal(label, '湖口服務區附近');
});

test('corridorId is stable/direction-agnostic: both direction orderings of the same corridor share one id', () => {
  const northbound = getRoadSectionLabel({ road: '國道一號', startKM: '91K+000', endKM: '82K+400' });
  const southbound = getRoadSectionLabel({ road: '國道一號', startKM: '83K+000', endKM: '91K+000' });
  assert.equal(northbound.corridorId, southbound.corridorId);
});

test('fallback: an unsupported road (台1/台61/台68) returns label=null, corridorId=null — never a guessed interchange', () => {
  for (const road of ['台1線', '台61線', '台68線', '台3線']) {
    const result = getRoadSectionLabel({ road, startKM: '90K+000', endKM: '91K+000' });
    assert.equal(result.label, null, `${road} should not get a fabricated label`);
    assert.equal(result.corridorId, null);
  }
});

test('fallback: unparseable/missing KM returns label=null, never throws', () => {
  assert.deepEqual(getRoadSectionLabel({ road: '國道一號' }), { label: null, corridorId: null });
  assert.deepEqual(getRoadSectionLabel({ road: '國道一號', startKM: 'garbage', endKM: 'garbage' }), {
    label: null,
    corridorId: null,
  });
});

test('fallback: a KM point far outside the whole anchor table (e.g. 20K, Taoyuan area) returns null, not a wild guess', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: '20K+000', endKM: '19K+000' });
  assert.equal(label, null);
});

test('getRoadShortName maps the two known roads and passes through anything else unchanged', () => {
  assert.equal(getRoadShortName('國道一號'), '國1');
  assert.equal(getRoadShortName('國道三號'), '國3');
  assert.equal(getRoadShortName('台68線'), '台68線');
  assert.equal(getRoadShortName(''), '');
});

test('accepts numeric startKM/endKM too (congestionCluster.js candidates use numbers, not TDX strings)', () => {
  const { label } = getRoadSectionLabel({ road: '國道一號', startKM: 91, endKM: 82.4 });
  assert.equal(label, '竹北－湖口路段');
});

// --- getCorridorId: notification-key stability (post-f32830a fix) ------

test('same jam crossing the old 90km bucket boundary keeps the same corridor id (82.4-91 vs 88-93)', () => {
  const wide = getCorridorId({ road: '國道一號', startKM: 82.4, endKM: 91 }); // old midpoint 86.7 -> old bucket z8
  const shrunk = getCorridorId({ road: '國道一號', startKM: 88, endKM: 93 }); // old midpoint 90.5 -> old bucket z9 (would have flipped)
  assert.equal(wide, shrunk);
});

test('same jam shrinking through several intermediate ranges keeps one stable corridor id throughout', () => {
  const ids = [
    getCorridorId({ road: '國道一號', startKM: 82.4, endKM: 91 }),
    getCorridorId({ road: '國道一號', startKM: 84, endKM: 91 }),
    getCorridorId({ road: '國道一號', startKM: 86, endKM: 92 }),
    getCorridorId({ road: '國道一號', startKM: 88, endKM: 93 }),
  ];
  assert.ok(ids.every((id) => id === ids[0]), `expected all identical, got: ${JSON.stringify(ids)}`);
});

test('genuinely distant congestion (82-87 vs 96-100) gets different corridor ids', () => {
  const a = getCorridorId({ road: '國道一號', startKM: 82, endKM: 87 });
  const b = getCorridorId({ road: '國道一號', startKM: 96, endKM: 100 });
  assert.notEqual(a, b);
});

test('getCorridorId is direction-agnostic by itself — direction is layered on separately by the caller (congestionCluster.js)', () => {
  const northbound = getCorridorId({ road: '國道一號', startKM: 91, endKM: 82.4 }); // descending KM order
  const southbound = getCorridorId({ road: '國道一號', startKM: 82.4, endKM: 91 }); // ascending KM order
  assert.equal(northbound, southbound);
});

test('國3 gets its own independent corridor ids, never colliding with 國1 values for a similar KM range', () => {
  const gd1 = getCorridorId({ road: '國道一號', startKM: 82.4, endKM: 91 });
  const gd3 = getCorridorId({ road: '國道三號', startKM: 82.4, endKM: 91 });
  assert.notEqual(gd1, gd3); // same numbers, different anchor tables (國1: 83/91/95/100.73/109.72, 國3: 79/90/98/103/109)
});

test('a road without a curated boundary table still gets a stable id from the generic 20km grid', () => {
  const a = getCorridorId({ road: '台1線', startKM: 90, endKM: 91 });
  const b = getCorridorId({ road: '台1線', startKM: 91, endKM: 93 });
  assert.equal(a, b);
  assert.notEqual(a, null);
});

test('getCorridorId returns null only when neither KM value is usable at all', () => {
  assert.equal(getCorridorId({ road: '國道一號', startKM: undefined, endKM: undefined }), null);
  assert.equal(getCorridorId({ road: '國道一號', startKM: 'garbage', endKM: 'garbage' }), null);
});
