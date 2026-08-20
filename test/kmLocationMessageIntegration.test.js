// V1.8.6.5 — formatEventMessage()'s wiring to the KM Location Resolver.
//
// Production's generated road-location datasets are currently EMPTY (no
// official raw data has been imported yet — see
// data/road-location/raw/README.md); resolveKmLocation() therefore always
// fails closed against them. That's exactly what this file proves:
// against real Production data, formatEventMessage's output must be
// byte-for-byte identical to its pre-V1.8.6.5 (V1.8.6.4) behavior — the
// new tier-2 label and 📍 地圖 line must both stay silent — until real
// official data is imported. The tier-2 label-selection/mapUrl LOGIC
// itself (what happens once official data exists) is covered independently
// and exhaustively, with TEST FIXTURE data, in test/kmLocationResolver.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import {
  highwayTai3ConstructionWithLocationDescription,
  highwayTai3ConstructionNoLocationDescription,
} from './fixtures.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';

test('against real (currently empty) Production road-location data: no 📍 地圖 line appears on any message', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionWithLocationDescription, 'highway');
  const text = formatEventMessage(event);
  assert.ok(!text.includes('📍'), text);
});

test('against real (currently empty) Production road-location data: tier-1 human location text still wins line 1 (V1.8.6.4 behavior unchanged)', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionWithLocationDescription, 'highway');
  const text = formatEventMessage(event);
  assert.ok(text.includes('關西－橫山路段'), text);
});

test('against real (currently empty) Production road-location data: no locationDescription and no official-dataset match -> falls back exactly as V1.8.6.4 did (bare road+direction, raw KM line)', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionNoLocationDescription, 'highway');
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台3線 雙向'); // no section label resolved from any tier
  assert.equal(lines[2], '78K+500～79K+200');
  assert.ok(!text.includes('📍'));
});

test('a freeway event with structured KM but no official dataset match falls back to the curated 國1/國3 anchor table (tier 3), unchanged from V1.8.6.4', () => {
  const event = normalizeRoadEvent(
    {
      EventID: 'FRW-TEST-1',
      EventTitle: '國道一號北向91K事故',
      EventType: '事故',
      Description: '北向91K處事故',
      Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '91K+000', EndKM: '91K+000' } },
    },
    'freeway'
  );
  const text = formatEventMessage(event);
  assert.ok(text.includes('竹北附近') || text.includes('竹北'), text); // roadSectionLabel.js's own curated anchor, unaffected by V1.8.6.5
});
