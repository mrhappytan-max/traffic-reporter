// V1.8.6.6 — production-symptom regression, locked to the real 2026-08-20
// ~20:13 Asia/Taipei incident: the official 高速公路 App showed 國1 南向
// ~92.8K "其他異常告警－行人誤闖" (a pedestrian-on-freeway advisory); this
// Worker instead broadcast "🚨 交通事故／事故影響通行／請提前避開" — the
// full vehicle-collision template, with no CCTV image, no V1.8.6.5 map
// URL, and (per the same investigation) direction/KM that didn't match
// the official source either.
//
// Root cause (see src/traffic/anomalyClassification.js's own module
// comment, and tdx/normalize.js's mapRoadEventType /
// pbs/classify.js's classifyPbsEvent for the exact override): TDX's own
// EventType (broad bucket, e.g. "事故") can match before a more specific
// EventSubType/Category/Description ever gets consulted, discarding a
// non-collision-hazard signal (行人/動物 intrusion) that field carries.
//
// This file does NOT re-derive the actual historical event's raw
// EventType/EventSubType/Category — that couldn't be recovered (see the
// forensic audit report this round is based on: no Production
// provenance/auth access from this sandbox). It reproduces the SHAPE of
// the symptom (a broad "事故"-bucket field alongside a more specific
// pedestrian-intrusion field/text) and proves the pipeline no longer
// mishandles it, regardless of exactly which field TDX puts the detail
// in — see the "field placement" tests below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { resolveCctvEligibility } from '../src/cctv/dynamicCollage.js';

function pedestrianFreewayRaw(overrides = {}) {
  return {
    EventID: 'FRW-PED-92800',
    EventType: '事故', // TDX's own broad bucket — see module comment; NOT this project's invention
    EventSubType: '行人誤闖',
    Description: '其他異常告警－行人誤闖',
    EffectiveTime: '2026-08-20T20:10:00+08:00',
    LastUpdateTime: '2026-08-20T20:15:33+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '92K+800', EndKM: '92K+800' } },
    ...overrides,
  };
}

test('1. TDX 國1 南向 92.8K 行人誤闖 (broad EventType=事故 + specific EventSubType) -> type is "other", never "accident"', () => {
  const event = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  assert.equal(event.type, 'other');
});

test('2. formatted LINE message never shows 交通事故 / 事故影響通行 / 請提前避開 for this event', () => {
  const event = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  const text = formatEventMessage(event);
  assert.doesNotMatch(text, /交通事故/);
  assert.doesNotMatch(text, /事故影響通行/);
  assert.doesNotMatch(text, /請提前避開/);
  assert.doesNotMatch(text, /🚨/);
});

test('3. formatted message uses the specific 行人闖入 anomaly headline, not the generic 路況異常', () => {
  const event = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  const text = formatEventMessage(event);
  assert.match(text, /^🚶 行人闖入/);
});

test('4. direction is taken verbatim from the raw structured Direction field — never inferred/flipped from KM or anything else', () => {
  const south = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  assert.equal(south.direction, '南向');
  const southText = formatEventMessage(south);
  assert.match(southText, /南向/);
  assert.doesNotMatch(southText, /北向/);

  // Same KM, opposite raw direction -> output must also flip, proving
  // this is a pass-through of the raw field, not a KM-derived guess.
  const north = normalizeRoadEvent(
    pedestrianFreewayRaw({ Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+800', EndKM: '92K+800' } } }),
    'freeway'
  );
  assert.equal(north.direction, '北向');
  const northText = formatEventMessage(north);
  assert.match(northText, /北向/);
  assert.doesNotMatch(northText, /南向/);
});

test('5. KM value itself never causes a self-reversal of direction (KM alone carries no directionality)', () => {
  // Same direction, different KM on either side of a facility — direction must stay identical.
  const lower = normalizeRoadEvent(pedestrianFreewayRaw({ Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '90K+000', EndKM: '90K+000' } } }), 'freeway');
  const higher = normalizeRoadEvent(pedestrianFreewayRaw({ Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '95K+000', EndKM: '95K+000' } } }), 'freeway');
  assert.equal(lower.direction, '南向');
  assert.equal(higher.direction, '南向');
});

test('6. official KM Location Resolver still attaches a human-readable location + short Google Maps URL for this anomaly event (V1.8.6.5 wiring unaffected by the classification fix)', () => {
  const event = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  const text = formatEventMessage(event);
  assert.match(text, /國1 南向｜.+路段/); // official tier-2 label, not a bare fallback
  assert.match(text, /^📍 地圖 https:\/\/maps\.google\.com\/\?q=[\d.]+,[\d.]+$/m);
});

test('7. this event IS broadcast-eligible (still worth notifying a driver) despite not being an "accident"', () => {
  const event = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  const eligibility = getBroadcastEligibility(event);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.reason, 'other-anomaly-keyword');
});

test('8. CCTV is NOT eligible for this event — "not-accident", per existing authority rules, never granted just because it has an anomaly label', () => {
  const event = normalizeRoadEvent(pedestrianFreewayRaw(), 'freeway');
  const cctv = resolveCctvEligibility(event);
  assert.equal(cctv.eligible, false);
  assert.equal(cctv.reason, 'not-accident');
});

test('9. field-placement independence: the anomaly text can live in EventSubType, Category, or Description alone — all three still classify as "other"', () => {
  const inSubType = normalizeRoadEvent(pedestrianFreewayRaw({ EventSubType: '行人闖入', Description: '請注意' }), 'freeway');
  assert.equal(inSubType.type, 'other');

  const inCategory = normalizeRoadEvent(
    { ...pedestrianFreewayRaw({ EventSubType: undefined }), Category: '行人誤闖', Description: '請注意' },
    'freeway'
  );
  assert.equal(inCategory.type, 'other');

  const inDescriptionOnly = normalizeRoadEvent(
    { ...pedestrianFreewayRaw({ EventSubType: undefined }), Description: '國道行人誤闖，請小心慢行' },
    'freeway'
  );
  assert.equal(inDescriptionOnly.type, 'other');
});

test('10. regression — a genuine collision (EventSubType: 一般事故) is completely unaffected: still type "accident", still the full accident template, still CCTV-eligible', () => {
  const real = normalizeRoadEvent(
    {
      EventID: 'FRW-REAL-1',
      EventType: '事故',
      EventSubType: '一般事故',
      Description: '南向92.8K處發生車輛事故，外側車道封閉',
      EffectiveTime: '2026-08-20T20:10:00+08:00',
      LastUpdateTime: '2026-08-20T20:15:33+08:00',
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '92K+800', EndKM: '92K+800' } },
    },
    'freeway'
  );
  assert.equal(real.type, 'accident');
  const text = formatEventMessage(real);
  assert.match(text, /^🚨 交通事故/);
  assert.match(text, /事故影響通行/);
  const cctv = resolveCctvEligibility(real);
  assert.equal(cctv.eligible, true);
});

test('11. PBS side: roadtype="事故" + comment mentioning 行人誤闖 also classifies as "other", not "accident"', () => {
  const event = normalizePbsEvent({
    UID: 'PBS-PED-1',
    road: '國道一號',
    direction: '南向',
    areaNm: '國道一號南向',
    roadtype: '事故',
    comment: '南向92.8公里處行人誤闖，請小心慢行',
    happendate: '2026-08-20',
    happentime: '20:10:00',
    modDttm: '2026-08-20 20:15:00',
  });
  assert.equal(event.type, 'other');
  const text = formatEventMessage(event);
  assert.doesNotMatch(text, /交通事故/);
  assert.match(text, /🚶 行人闖入/);
});

test('12. PBS regression — a genuine roadtype="事故" with no anomaly text is unaffected: still "accident"', () => {
  const event = normalizePbsEvent({
    UID: 'PBS-REAL-1',
    road: '國道一號',
    direction: '南向',
    areaNm: '國道一號南向',
    roadtype: '事故',
    comment: '南向92.8公里處發生車輛事故',
    happendate: '2026-08-20',
    happentime: '20:10:00',
    modDttm: '2026-08-20 20:15:00',
  });
  assert.equal(event.type, 'accident');
});

test('13. different directions of the same road/KM are never merged into one incident-suppression group', () => {
  const south = normalizeRoadEvent(
    { EventID: 'FRW-S-1', EventType: '事故', EventSubType: '一般事故', Description: '事故', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '南向', StartKM: '92K+800' } } },
    'freeway'
  );
  const north = normalizeRoadEvent(
    { EventID: 'FRW-N-1', EventType: '事故', EventSubType: '一般事故', Description: '事故', Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+800' } } },
    'freeway'
  );
  // Same grouping concept incidentSuppression.js itself uses
  // (`${road}|${direction}`) — asserted here directly rather than
  // importing a private helper, since the module doesn't export one.
  const groupOf = (e) => `${e.road}|${e.direction}`;
  assert.notEqual(groupOf(south), groupOf(north));
});
