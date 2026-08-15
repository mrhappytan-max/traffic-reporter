import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPbsEventHsinchuRelevant } from '../src/pbs/hsinchuFilter.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';

function pbsRaw(overrides = {}) {
  return {
    UID: 'U1',
    road: '',
    direction: '西行',
    areaNm: '(南寮竹東)-台68線',
    roadtype: '事故',
    comment: '西行在8.1公里處交通事故',
    happendate: '2026-08-15',
    happentime: '22:14:00',
    modDttm: '2026-08-15 22:20:00',
    x1: '',
    y1: '',
    srcdetail: '',
    ...overrides,
  };
}

// The real, confirmed 台68 fixture from this round's task — must pass.
test('real fixture: 台68 accident is judged Hsinchu-relevant (whole-route-in-scope road match)', () => {
  const event = normalizePbsEvent(pbsRaw());
  assert.equal(isPbsEventHsinchuRelevant(event), true);
});

test('coordinates inside the Hsinchu bounding box are authoritative -> relevant, even with no road/place-name match', () => {
  const event = normalizePbsEvent(pbsRaw({ road: '光復路', areaNm: '', comment: '路面不平', x1: '121.0', y1: '24.75' }));
  assert.equal(isPbsEventHsinchuRelevant(event), true);
});

test('coordinates clearly outside Hsinchu override a place-name match (the 新豐/花蓮新豐平大橋 false-positive guard)', () => {
  // "新豐" appears in the comment (a real ambiguity the task explicitly
  // flagged), but the coordinates are Hualien's, not Hsinchu's.
  const event = normalizePbsEvent(
    pbsRaw({
      road: '',
      areaNm: '花蓮縣',
      comment: '新豐平大橋前方施工',
      x1: '121.60', // Hualien-area longitude
      y1: '23.95', // Hualien-area latitude, well outside the Hsinchu box
    })
  );
  assert.equal(isPbsEventHsinchuRelevant(event), false);
});

test('a place-name mention with NO coordinates at all still needs a second corroborating signal (areaNm AND comment)', () => {
  // Comment mentions 新豐 but areaNm gives no Hsinchu signal, and no
  // coordinates exist to confirm or deny -> must NOT pass on the comment
  // keyword alone (地名只能當輔助，不可單獨決定).
  const event = normalizePbsEvent(
    pbsRaw({ road: '', areaNm: '某某路段', comment: '新豐路段回堵', x1: '', y1: '' })
  );
  assert.equal(isPbsEventHsinchuRelevant(event), false);
});

test('areaNm AND comment both independently mentioning a Hsinchu place name (no coordinates) -> relevant', () => {
  const event = normalizePbsEvent(
    pbsRaw({ road: '', areaNm: '新竹縣新豐鄉', comment: '新豐交流道附近回堵', x1: '', y1: '' })
  );
  assert.equal(isPbsEventHsinchuRelevant(event), true);
});

test('a priority road (國道一號) with a KM clearly outside the Hsinchu range is excluded, even though the road name matched', () => {
  const event = normalizePbsEvent(
    pbsRaw({ road: '', areaNm: '中山高速公路-國道１號', comment: '北向42公里處車多回堵', x1: '', y1: '' })
  );
  assert.equal(isPbsEventHsinchuRelevant(event), false); // 42K is Taoyuan-area, outside the configured Hsinchu range
});

test('a priority road (國道一號) with a KM inside the configured Hsinchu range is included', () => {
  const event = normalizePbsEvent(
    pbsRaw({ road: '', areaNm: '中山高速公路-國道１號', comment: '北向92公里處車多回堵', x1: '', y1: '' })
  );
  assert.equal(isPbsEventHsinchuRelevant(event), true);
});

test('a non-priority road with no coordinates and no Hsinchu place-name signal is excluded (fail closed)', () => {
  const event = normalizePbsEvent(
    pbsRaw({ road: '中正路', areaNm: '台北市', comment: '路面坑洞', x1: '', y1: '' })
  );
  assert.equal(isPbsEventHsinchuRelevant(event), false);
});
