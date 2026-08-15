import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArray } from '../src/tdx/extract.js';
import { normalizeRoadEvent, normalizeCmsEvent, normalizeBusAlert } from '../src/tdx/normalize.js';
import { fetchSource, SOURCES } from '../src/tdx/sources.js';
import {
  realFreewayEvent,
  realHighwayConstructionEvent,
  busAlertNormalOperationById,
  busAlertNormalOperationByText,
  busAlertRealDetour,
  cmsSafetySlogan,
  cmsCongestionMessage,
} from './fixtures.js';

test('extractArray finds the named key, then falls back to the first array property', () => {
  assert.deepEqual(extractArray({ RoadEvents: [1, 2] }, ['RoadEvents']), [1, 2]);
  assert.deepEqual(extractArray({ SomethingElse: [3] }, ['RoadEvents']), [3]);
  assert.deepEqual(extractArray([9, 8], ['RoadEvents']), [9, 8]);
  assert.deepEqual(extractArray({ nothing: 'here' }, ['RoadEvents']), []);
});

test('normalizeRoadEvent maps a plausible freeway record and keeps KM/lane fields', () => {
  const raw = {
    EventID: 'EVT001',
    EventType: '事故',
    RoadName: '國道1號',
    Direction: '南向',
    Description: '南向120K發生車輛事故，外側車道封閉',
    Location: { StartLocationMile: '120K', EndLocationMile: '121K' },
    ImpactLane: { BlockedLanesNum: 1 },
    EventStartTime: '2026-08-15T08:00:00+08:00',
    UpdateTime: '2026-08-15T08:05:00+08:00',
  };

  const event = normalizeRoadEvent(raw, 'freeway');

  assert.equal(event.source, 'freeway');
  assert.equal(event.type, 'accident');
  assert.equal(event.road, '國道1號');
  assert.equal(event.direction, '南向');
  assert.equal(event.startKM, '120K');
  assert.equal(event.endKM, '121K');
  assert.equal(event.blockedLanes, 1);
  assert.equal(event.rawId, 'EVT001');
  assert.equal(event.startTime, '2026-08-15T08:00:00+08:00');
});

test('normalizeRoadEvent falls back to keyword classification when EventType is unrecognized', () => {
  const event = normalizeRoadEvent(
    { EventID: '2', Description: '路段施工作業，請減速慢行' },
    'highway'
  );
  assert.equal(event.type, 'construction');
  assert.equal(event.source, 'highway');
});

test('normalizeCmsEvent joins message rows and classifies the text', () => {
  const event = normalizeCmsEvent({
    CMSID: 'CMS01',
    RoadName: '公道五路',
    Message: { MessageRow1: '前方', MessageRow2: '壅塞' },
  });
  assert.equal(event.source, 'cms');
  assert.equal(event.type, 'congestion');
  assert.match(event.description, /前方/);
  assert.match(event.description, /壅塞/);
});

test('normalizeBusAlert defaults to "alert" type for generic disruption text', () => {
  const event = normalizeBusAlert(
    { RouteID: '5路', Description: '因活動交通管制，暫停行駛光復路' },
    'bus-hsinchu'
  );
  assert.equal(event.source, 'bus-hsinchu');
  assert.equal(event.type, 'control');

  const generic = normalizeBusAlert({ RouteID: '5路', Description: '路線調整通知' }, 'bus-hsinchu');
  assert.equal(generic.type, 'alert');
});

test('fetchSource isolates a malformed record instead of failing the whole source', async () => {
  const source = SOURCES.find((s) => s.id === 'freeway');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        RoadEvents: [
          { EventID: '1', Description: '事故' },
          null, // malformed — normalize() would throw reading its fields
        ],
      }),
      { status: 200 }
    );

  try {
    const { rawItems, normalized } = await fetchSource(source, 'token');
    assert.equal(rawItems.length, 2);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].rawId, '1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeRoadEvent (real freeway schema): road/direction/startKM/endKM/title are populated', () => {
  const event = normalizeRoadEvent(realFreewayEvent, 'freeway');

  assert.equal(event.title, '國道1號南向122K車輛事故');
  assert.equal(event.road, '國道1號');
  assert.equal(event.direction, '南向');
  assert.equal(event.startKM, 121.8);
  assert.equal(event.endKM, 122.3);
  assert.equal(event.blockedLanes, 1);
  assert.equal(event.type, 'accident');
  assert.equal(event.startTime, '2026-08-15T08:12:00+08:00');
  assert.equal(event.updatedAt, '2026-08-15T08:20:00+08:00');
  assert.match(event.location, /國道1號/);
  assert.match(event.location, /南向/);
  assert.match(event.location, /121\.8/);

  for (const field of ['title', 'road', 'direction', 'location']) {
    assert.ok(event[field] && event[field].length > 0, `${field} should not be empty`);
  }
});

test('normalizeRoadEvent (real highway schema): classifies via EventType even when EventSubType is more specific', () => {
  const event = normalizeRoadEvent(realHighwayConstructionEvent, 'highway');

  assert.equal(event.type, 'construction');
  assert.equal(event.road, '台68線');
  assert.equal(event.direction, '東向');
  assert.equal(event.startKM, 4.5);
  assert.equal(event.endKM, 6);
  assert.equal(event.title, '台68線東向5K道路施工');
});

test('bus alert filter drops AlertID "0" and any 正常營運 text, keeps real disruptions', async () => {
  const source = SOURCES.find((s) => s.id === 'bus-hsinchu');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        Alerts: [busAlertNormalOperationById, busAlertNormalOperationByText, busAlertRealDetour],
      }),
      { status: 200 }
    );

  try {
    const { rawItems, normalized } = await fetchSource(source, 'token');
    assert.equal(rawItems.length, 3);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].rawId, 'A-9982');
    assert.equal(normalized[0].type, 'control');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeBusAlert + filter: AlertID "0" alone is enough to drop it even with no text', () => {
  const event = normalizeBusAlert(busAlertNormalOperationById, 'bus-hsinchu');
  assert.equal(event.rawId, '0');
});

test('cms filter drops generic safety slogans and keeps real congestion messages', async () => {
  const source = SOURCES.find((s) => s.id === 'cms');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ CMSs: [cmsSafetySlogan, cmsCongestionMessage] }), { status: 200 });

  try {
    const { rawItems, normalized } = await fetchSource(source, 'token');
    assert.equal(rawItems.length, 2);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].rawId, 'CMS-HC-021');
    assert.equal(normalized[0].type, 'congestion');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchSource for cms filters out signboards with no message text', async () => {
  const source = SOURCES.find((s) => s.id === 'cms');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        CMSs: [{ CMSID: 'A', Message: '壅塞警示' }, { CMSID: 'B', Message: '' }],
      }),
      { status: 200 }
    );

  try {
    const { normalized } = await fetchSource(source, 'token');
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].rawId, 'A');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
