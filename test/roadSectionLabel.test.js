import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRoadSectionLabel, getRoadShortName } from '../src/traffic/roadSectionLabel.js';

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
