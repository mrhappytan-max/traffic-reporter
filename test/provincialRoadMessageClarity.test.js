// V1.8.6.4 — 台3線 (and other 省道) LINE message-clarity correction.
//
// Production repro: a 台3線 event's LINE message showed only bare KM (no
// human-readable section context) and, for an 'other'-typed anomaly, a
// generic "路況異常" headline that never said WHAT happened. Root cause
// (see src/tdx/normalize.js and src/traffic/messageFormat.js's own
// V1.8.6.4 comments for the full writeup):
//
//   A. roadSectionLabel.js only ever had named anchors for 國1/國3 — any
//      other road (including every 省道) always fell through to bare KM,
//      by design (no fabricated anchor table for roads with no confirmed
//      mileage data — "不要猜不存在的交流道").
//   B. normalizeRoadEvent's `location` field is composed as
//      road+direction+KM the instant KM is present, which silently
//      shadowed TDX's own `LocationDescription`/`Location.Description`/
//      `RoadSection` fields before they ever reached the formatter — even
//      though those fields, when the source actually supplies them, are
//      exactly the human-readable section text a driver needs.
//   C. messageFormat.js's TYPE_LABEL/TYPE_EMOJI keyed purely off
//      `event.type` — a legitimately-eligible 'other' anomaly (積水/落石/
//      掉落物/...) always rendered as the same generic "ℹ️ 路況異常",
//      even though broadcastRules.js's own OTHER_ANOMALY_PATTERNS already
//      knows exactly which keyword made it eligible.
//
// Fix: (1) normalizeRoadEvent now preserves TDX's own human location text
// as a separate `event.locationDescription` field, never shadowed by KM
// composition. (2) messageFormat.js prefers that source text (filtered to
// reject anything that's just another KM string) over the curated
// anchor-table label, which still only covers 國1/國3 — no invented
// provincial-road anchor table was added, since this repo has no
// independently-confirmed KM-anchor data for 台1/台3/etc (see the
// project's own "不要猜" rule). (3) A display-only anomaly-detail
// classifier gives an 'other' event a specific headline when the source
// text (or PBS's own structured `pbsCategory`) supports one, without
// touching `event.type`/dedupe/fingerprint/eligibility semantics at all.
// (4) A `direction==='雙向'` event gets direction-aware impact wording
// scoped to its own type — never upgraded to imply full closure unless
// `type==='closure'` itself.
//
// No TDX/PBS/LINE network calls anywhere in this file — everything below
// runs entirely off local fixtures (test/fixtures.js) or hand-built event
// objects, per this round's explicit "不要為了調查增加 TDX 額度" constraint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import {
  highwayTai3ConstructionWithLocationDescription,
  highwayTai3ConstructionNoLocationDescription,
  highwayTai3AccidentWithLocationDescription,
  highwayTai3Closure,
  highwayTai3Control,
  highwayTai3Flooding,
  highwayTai3RockslideRaw,
  realFreewayEvent,
} from './fixtures.js';

function normalizeAndFormat(raw, source = 'highway') {
  const event = normalizeRoadEvent(raw, source);
  return { event, text: formatEventMessage(event) };
}

// ===========================================================================
// normalize.js — locationDescription is preserved, never shadowed by KM,
// and `location`'s own existing value (fingerprint-relevant) is untouched.
// ===========================================================================

test('normalizeRoadEvent preserves LocationDescription as a separate field even when structured KM is also present', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionWithLocationDescription, 'highway');
  assert.equal(event.locationDescription, '關西－橫山路段');
  assert.equal(event.startKM, '78K+500');
  assert.equal(event.endKM, '79K+200');
  // `location` (fingerprint-relevant, see notified.js) keeps its existing
  // road+direction+KM composition, completely unchanged by this round.
  assert.equal(event.location, '台3線 雙向 78K+500 - 79K+200');
});

test('normalizeRoadEvent: no LocationDescription on the raw record -> no locationDescription field at all (never fabricated)', () => {
  const event = normalizeRoadEvent(highwayTai3ConstructionNoLocationDescription, 'highway');
  assert.equal(event.locationDescription, undefined);
  assert.equal(event.startKM, '78K+500');
});

// ===========================================================================
// 1. 台3事件有 KM + human-readable LocationDescription -> LINE 同時顯示
//    人類路段 + KM.
// ===========================================================================

test('1. 台3 construction with KM + genuine LocationDescription -> both the human section AND the KM range are shown', () => {
  const { text } = normalizeAndFormat(highwayTai3ConstructionWithLocationDescription);
  const lines = text.split('\n');
  assert.equal(lines[1], '台3線 雙向｜關西－橫山路段');
  assert.equal(lines[2], '78K+500～79K+200');
});

// ===========================================================================
// 2. 台3沒有可靠 location text -> 不猜地址，正常顯示 KM.
// ===========================================================================

test('2. 台3 construction with KM but NO LocationDescription -> no invented section name, KM still shown', () => {
  const { text } = normalizeAndFormat(highwayTai3ConstructionNoLocationDescription);
  const lines = text.split('\n');
  assert.equal(lines[1], '台3線 雙向'); // no "｜..." suffix — nothing guessed
  assert.equal(lines[2], '78K+500～79K+200');
  assert.doesNotMatch(text, /關西|橫山/); // proves nothing was carried over/invented from the other fixture
});

// ===========================================================================
// 3. 台3施工 -> 明確顯示「道路施工」及適當 impact，不是「路況異常」。
//    Also covers requirement 8 (雙向 + construction must not read as 封閉).
// ===========================================================================

test('3. 台3 construction -> headline reads 道路施工, never 路況異常', () => {
  const { text } = normalizeAndFormat(highwayTai3ConstructionWithLocationDescription);
  assert.match(text, /^🚧 道路施工\n/);
  assert.doesNotMatch(text, /路況異常/);
});

test('8. 雙向 + construction -> impact line says 雙向施工管制, never misrepresented as 雙向封閉', () => {
  const { text } = normalizeAndFormat(highwayTai3ConstructionWithLocationDescription);
  assert.match(text, /雙向施工管制/);
  assert.doesNotMatch(text, /封閉/); // must never claim a closure a construction event didn't report
});

// ===========================================================================
// 4. 台3事故 -> 明確顯示「交通事故」。
// ===========================================================================

test('4. 台3 accident -> headline reads 交通事故, with its own human location text + KM', () => {
  const { text } = normalizeAndFormat(highwayTai3AccidentWithLocationDescription);
  const lines = text.split('\n');
  assert.match(text, /^🚨 交通事故\n/);
  assert.equal(lines[1], '台3線 南向｜關西鎮中山路附近');
  assert.equal(lines[2], '82K+300');
});

// ===========================================================================
// 5. 台3封閉 -> 明確顯示「道路封閉／請改道」類語意。
// ===========================================================================

test('5. 台3 closure -> headline reads 道路封閉, impact line says 雙向道路封閉 + 請改道行駛', () => {
  const { text } = normalizeAndFormat(highwayTai3Closure);
  assert.match(text, /^🚧 道路封閉\n/);
  assert.match(text, /雙向道路封閉/);
  assert.match(text, /請改道行駛/);
});

// ===========================================================================
// 6. 台3交通管制 -> 明確顯示「交通管制」。
// ===========================================================================

test('6. 台3 traffic control -> headline reads 交通管制, impact line says 雙向交通管制', () => {
  const { text } = normalizeAndFormat(highwayTai3Control);
  assert.match(text, /^⚠️ 交通管制\n/);
  assert.match(text, /雙向交通管制/);
});

// ===========================================================================
// 7. 明確 anomaly（積水／落石／掉落物）-> 不應全部退化成模糊「路況異常」。
// ===========================================================================

test('7a. 台3 flooding (積水) -> headline reads 🌊 道路積水, not the generic ℹ️ 路況異常', () => {
  const { text } = normalizeAndFormat(highwayTai3Flooding);
  assert.match(text, /^🌊 道路積水\n/);
});

test('7b. 台3 rockslide (落石) -> headline reads ⛰️ 落石', () => {
  const { text } = normalizeAndFormat(highwayTai3RockslideRaw);
  assert.match(text, /^⛰️ 落石\n/);
});

test('7c. debris (掉落物) on any road -> headline reads ⚠️ 掉落物, and PBS obstruction category resolves the same way', () => {
  const debrisEvent = {
    type: 'other',
    road: '台3線',
    direction: '南向',
    startKM: '40K+000',
    title: '台3線路況',
    description: '路面有掉落物，請小心閃避',
    updatedAt: '2026-08-19T14:00:00+08:00',
  };
  assert.match(formatEventMessage(debrisEvent), /^⚠️ 掉落物\n/);

  // Same conclusion via PBS's own structured pbsCategory, even with
  // description text that wouldn't itself match the keyword table.
  const pbsObstructionEvent = {
    type: 'other',
    pbsCategory: 'obstruction',
    road: '台3線',
    direction: '南向',
    displayKM: 40,
    title: '路況通報',
    description: '路面有不明異物',
    updatedAt: '2026-08-19T14:00:00+08:00',
  };
  assert.match(formatEventMessage(pbsObstructionEvent), /^⚠️ 掉落物\n/);
});

test('7d. fire (火災) -> headline reads 🔥 火災', () => {
  const event = {
    type: 'other',
    road: '台3線',
    direction: '北向',
    startKM: '30K+000',
    title: '台3線路況',
    description: '路旁邊坡火災，請小心慢行',
    updatedAt: '2026-08-19T15:00:00+08:00',
  };
  assert.match(formatEventMessage(event), /^🔥 火災\n/);
});

// ===========================================================================
// 9. 既有國1／國3 section label 行為保持正常。
// ===========================================================================

test('9. 國1 event with no locationDescription still resolves via the existing curated anchor table, unchanged', () => {
  const { text } = normalizeAndFormat(realFreewayEvent, 'freeway');
  const lines = text.split('\n');
  assert.match(lines[1], /^國1 北向｜/); // still resolves an anchor-based label, exactly as before this round
  assert.equal(lines[2], '92K+500～91K+800');
});

// ===========================================================================
// 10. 既有 V1.8.5.1 KM display regression 保持正常（KM 優先於 route-name
//     形狀的 location 字串；本輪新增的 locationDescription 邏輯不得覆蓋這個
//     既有保證）。
// ===========================================================================

test('10. V1.8.5.1 regression still holds: a route-name-shaped `location` never wins over displayKM, and is unaffected by the new locationDescription field', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '國道一號',
    direction: '',
    location: '中山高速公路-國道1號', // route-name text, not a real section — must never be shown as a section label
    displayKM: 93.3,
    description: '南向在93.3公里處內側車道發生交通事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '國1'); // no "｜..." suffix invented from `location`
  assert.equal(lines[2], '93K+300'); // KM still wins, unchanged from V1.8.5.1
});

// ===========================================================================
// 11. 沒有可靠資訊時 fail safe，不要創造地址或事件原因。
// ===========================================================================

test('11a. no locationDescription, no KM, no location text at all -> bare road+direction only, nothing invented', () => {
  const event = {
    type: 'accident',
    road: '台3線',
    direction: '北向',
    description: '事故',
    updatedAt: '2026-08-19T16:00:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台3線 北向');
  assert.doesNotMatch(text, /｜/); // no section label fabricated
});

test('11b. an "other" event whose text matches no known anomaly keyword -> stays the generic 路況異常, never a guessed specific cause', () => {
  const event = {
    type: 'other',
    road: '台3線',
    direction: '南向',
    startKM: '20K+000',
    title: '台3線路況',
    description: '路況通報，詳情請留意現場標示',
    updatedAt: '2026-08-19T17:00:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /^ℹ️ 路況異常\n/);
});

test('11c. a LocationDescription that is itself just another KM string (e.g. "92K+000") is never shown as if it were a place name', () => {
  const event = normalizeRoadEvent(
    {
      EventID: 'HWY-TEST-KMONLY',
      EventType: '事故',
      Description: '事故',
      LocationDescription: '92K+000', // KM-shaped, not real human text — mirrors a real observed TDX field pattern (see test/cctvProbe.test.js)
      Location: { FreeExpressHighway: { Road: '台3線', Direction: '南向', StartKM: '92K+000' } },
    },
    'highway'
  );
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台3線 南向'); // KM-shaped text rejected as a section label
  assert.equal(lines[2], '92K+000');
});
