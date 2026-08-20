// V1.8.6.5 — formatEventMessage()'s wiring to the KM Location Resolver,
// now exercised against the REAL imported official dataset (data.gov.tw
// 7040/95016/166496/8161 — see PROJECT_HANDOFF.md's V1.8.6.5 section).
// Tier-2 label-selection/mapUrl LOGIC itself (what happens for arbitrary
// roads/KMs) is covered independently and exhaustively, with TEST FIXTURE
// data, in test/kmLocationResolver.test.js — this file only checks the
// end-to-end wiring: which tier wins the label line, and that the 📍 地圖
// line shows up exactly when (and only when) a coordinate resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import {
  highwayTai3ConstructionWithLocationDescription,
  highwayTai3ConstructionNoLocationDescription,
} from './fixtures.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';

test('tier-1 human location text (locationDescription) still wins line 1 over the official resolver label (V1.8.6.4 priority unchanged)', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionWithLocationDescription, 'highway');
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台3線 雙向｜關西－橫山路段');
});

test('a 📍 地圖 line is still added even when tier-1 text wins the label — the map is a separate concern from which tier supplied the label text', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionWithLocationDescription, 'highway');
  const text = formatEventMessage(event);
  assert.match(text, /^📍 地圖 https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=[\d.,-]+$/m);
});

test('no locationDescription, but the official dataset covers this road -> tier-2 (resolver) label wins line 1, not a bare road+direction fallback', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionNoLocationDescription, 'highway');
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  // Real data.gov.tw 7040 coverage for 台3 at ~78.85K — see
  // test/kmLocationResolver.test.js's own acceptance-test-adjacent cases
  // for the resolver's own output shape; this only checks the label WON.
  assert.equal(lines[1], '台3線 雙向｜新竹縣北埔鄉');
  assert.equal(lines[2], '78K+500～79K+200'); // raw KM line is untouched, still shown
  assert.ok(text.includes('📍 地圖 https://www.google.com/maps/search/?api=1&query='));
});

test('a freeway event with structured KM the official dataset covers resolves via the resolver (tier 2), not the old curated anchor table (tier 3)', () => {
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
  const lines = text.split('\n');
  assert.equal(lines[1], '國1 北向｜竹北交流道附近');
  assert.ok(text.includes('📍 地圖 https://www.google.com/maps/search/?api=1&query=24.82443422,121.0177405'));
});

test('a road/KM the official dataset genuinely does not cover falls back exactly as V1.8.6.4 did: no tier-2 label, no 📍 line', () => {
  // 台99 is not a real provincial route — guaranteed absent from the
  // real imported dataset (see kmLocationResolver.test.js test 16).
  const event = normalizeRoadEvent(
    {
      EventID: 'HWY-TEST-NODATA',
      EventTitle: '台99線事故',
      EventType: '事故',
      Description: '台99線路段發生事故',
      Location: { FreeExpressHighway: { Road: '台99線', Direction: '南向', StartKM: '5K+000' } },
    },
    'highway'
  );
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台99線 南向'); // bare road+direction, no label from any tier
  assert.ok(!text.includes('📍'));
});
