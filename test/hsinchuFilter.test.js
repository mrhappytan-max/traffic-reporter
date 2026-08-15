import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHsinchuRelevant, parseKM } from '../src/traffic/hsinchuFilter.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import {
  realFreewayEvent,
  freewayEventOutsideHsinchu,
  freewayEventUnknownRoad,
  realHighwayConstructionEvent,
  highwayEventTai1InRange,
  highwayEventTai1BorderlineWithMention,
  highwayEventTai1FarOutsideRange,
  highwayEventPositionOnly,
  highwayEventNoLocationSignal,
} from './fixtures.js';

test('parseKM handles "NNK+NNN", "NNK", and plain numbers', () => {
  assert.equal(parseKM('42K+000'), 42);
  assert.equal(parseKM('92K+500'), 92.5);
  assert.equal(parseKM('10K'), 10);
  assert.equal(parseKM(42.5), 42.5);
  assert.equal(parseKM(''), null);
  assert.equal(parseKM(undefined), null);
  assert.equal(parseKM('not a km'), null);
});

test('Freeway: keeps an in-range 國道一號 event, drops an out-of-range one on the same road', () => {
  const inRange = normalizeRoadEvent(realFreewayEvent, 'freeway');
  const outOfRange = normalizeRoadEvent(freewayEventOutsideHsinchu, 'freeway');

  assert.equal(isHsinchuRelevant(inRange, realFreewayEvent), true);
  assert.equal(isHsinchuRelevant(outOfRange, freewayEventOutsideHsinchu), false);
});

test('Freeway: drops roads that are not on the priority list at all (fails closed)', () => {
  const event = normalizeRoadEvent(freewayEventUnknownRoad, 'freeway');
  assert.equal(isHsinchuRelevant(event, freewayEventUnknownRoad), false);
});

test('Highway: 台68 is treated as entirely within Hsinchu regardless of KM', () => {
  const event = normalizeRoadEvent(realHighwayConstructionEvent, 'highway');
  assert.equal(isHsinchuRelevant(event, realHighwayConstructionEvent), true);
});

test('Highway: 台1線 in range is kept, far outside range is dropped even though the road matches', () => {
  const inRange = normalizeRoadEvent(highwayEventTai1InRange, 'highway');
  const farOutside = normalizeRoadEvent(highwayEventTai1FarOutsideRange, 'highway');

  assert.equal(isHsinchuRelevant(inRange, highwayEventTai1InRange), true);
  assert.equal(isHsinchuRelevant(farOutside, highwayEventTai1FarOutsideRange), false);
});

test('Highway: a KM just past the range boundary is pulled in when the description mentions 新竹', () => {
  const event = normalizeRoadEvent(highwayEventTai1BorderlineWithMention, 'highway');
  assert.equal(isHsinchuRelevant(event, highwayEventTai1BorderlineWithMention), true);
});

test('Highway: no KM but Positions inside the Hsinchu bounding box are used as a fallback signal', () => {
  const event = normalizeRoadEvent(highwayEventPositionOnly, 'highway');
  assert.equal(isHsinchuRelevant(event, highwayEventPositionOnly), true);
});

test('Highway: no KM and no position at all fails closed (excluded, not guessed)', () => {
  const event = normalizeRoadEvent(highwayEventNoLocationSignal, 'highway');
  assert.equal(isHsinchuRelevant(event, highwayEventNoLocationSignal), false);
});
