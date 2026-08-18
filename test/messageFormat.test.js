import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEventMessage } from '../src/traffic/messageFormat.js';

test('accident message matches the required short template shape', () => {
  const event = {
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    location: '95K附近',
    description: '這是一段很長的原始 TDX 敘述，不應該整段被貼上 LINE，因為司機正在開車，需要短訊息。',
    updatedAt: '2026-08-15T12:35:00+08:00',
  };
  const text = formatEventMessage(event);
  // V1.2C: road names are shortened (國道一號 -> 國1) in the LINE display —
  // see roadSectionLabel.js's ROAD_SHORT_NAME.
  assert.equal(
    text,
    ['🚨 交通事故', '國1 北向', '95K附近', '事故影響通行', '請提前避開', '🕒 12:35更新'].join('\n')
  );
  assert.doesNotMatch(text, /很長的原始 TDX 敘述/); // raw Description never dumped in
});

test('construction message matches the required short template shape', () => {
  const event = {
    type: 'construction',
    road: '台68',
    direction: '東向',
    location: '新竹路段',
    description: '施工細節冗長描述...',
    updatedAt: '2026-08-15T09:20:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.equal(
    text,
    ['🚧 道路施工', '台68 東向', '新竹路段', '施工影響通行', '請注意車道', '🕒 09:20更新'].join('\n')
  );
});

test('forecast (60-minute) message includes the countdown and does not include the active-event footer', () => {
  const event = { type: 'closure', road: '西大路', direction: '', location: '單向封閉路段' };
  const text = formatEventMessage(event, { forecast: true, minutesUntilStart: 40 });
  assert.match(text, /^⚠️ 60分鐘路況預報/);
  assert.match(text, /約40分鐘後開始/);
  assert.match(text, /建議提前改道/);
  assert.doesNotMatch(text, /🕒/); // no "updated at" footer on forecast messages
});

test('message is always short (a handful of lines, no raw description dump)', () => {
  const longDescription = '事故'.repeat(200);
  const event = {
    type: 'accident',
    road: '國道三號',
    direction: '南向',
    location: '90K附近',
    description: longDescription,
    updatedAt: '2026-08-15T10:00:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.ok(text.length < 100);
  assert.doesNotMatch(text, new RegExp(longDescription));
});

// --- V1.2C: 道路簡稱 + 人類路段 label, no duplicate road/direction lines ---

test('6. the reported duplicate-line bug ("國道一號 北向" then "國道一號 北向 91K...") never resurfaces', () => {
  const event = {
    type: 'congestion',
    road: '國道一號',
    direction: '北向',
    location: '國道一號 北向 91K+000 - 82K+400', // exact composeLocation() shape from the real report
    startKM: '91K+000',
    endKM: '82K+400',
    description: '車多回堵',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  // "國道一號 北向" (or its short form) must not appear as a standalone
  // prefix on two different lines.
  const roadDirectionLines = lines.filter((l) => l.includes('北向') && !l.includes('｜'));
  assert.ok(roadDirectionLines.length <= 1, `expected at most one bare road+direction line, got: ${JSON.stringify(lines)}`);
  assert.doesNotMatch(text, /國道一號 北向\n.*國道一號 北向/s);
});

test('7. congestion message matches the required new short format exactly', () => {
  // V1.4.1: no congestionSeverity set here (this event predates the field
  // entirely, same as a hand-built fixture) -> defaults to 'congested'
  // ("壅塞"), never the old hardcoded "嚴重壅塞" — see
  // congestionSeverity.test.js for the full moderate/congested/severe
  // matrix this default is part of.
  const event = {
    type: 'congestion',
    road: '國道一號',
    direction: '北向',
    startKM: 91,
    endKM: 82.4,
    description: '車多回堵',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.equal(
    text,
    ['🐢 壅塞', '國1 北向｜竹北－湖口路段', '91K+000～82K+400', '車多回堵\n請預留時間', '🕒 10:50更新'].join('\n')
  );
});

test('accident message with a resolvable section label uses the "道路 方向｜路段" first line and a pure-KM second line', () => {
  const event = {
    type: 'accident',
    road: '國道三號',
    direction: '南向',
    startKM: '90K+200',
    endKM: '90K+800',
    description: '事故',
    updatedAt: '2026-08-15T11:19:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.match(lines[1], /^國3 南向｜/);
  assert.match(lines[2], /^90K\+200～90K\+800$/);
});

// V1.8.5.1 — CORRECTED: this test previously asserted that an
// unresolvable-section-label road fell back to raw `location` TEXT even
// when structured startKM/endKM were present. That was the exact class of
// bug fixed this round ("不要因為無法產生 section label 就把明確 KM 丟掉")
// — a real Production accident had genuine KM but no resolvable section
// label, and the old fallback silently showed a route-name string instead
// of the KM. See required regression test 4 immediately below for the
// explicit "no section label but has KM -> KM still shown" case; this
// test now only covers the genuinely-no-KM-at-all fallback.
test('a road without a resolvable section label (e.g. 台1線) and with NO usable KM at all falls back to the original road+direction/location display, unchanged', () => {
  const event = {
    type: 'construction',
    road: '台1線',
    direction: '南向',
    location: '台1線 南向 施工路段',
    description: '施工',
    updatedAt: '2026-08-15T09:00:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台1線 南向');
  assert.equal(lines[2], '施工路段');
});

// --- V1.8.5.1: KM must never be dropped just because no section label resolves ---

test('1. TDX structured startKM only -> KM is shown as a single point, on its own line', () => {
  const event = {
    source: 'freeway',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+300',
    description: '事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.match(lines[1], /^國1 南向/);
  assert.equal(lines[2], '93K+300');
});

test('2. TDX structured endKM only -> KM is shown as a single point', () => {
  const event = {
    source: 'freeway',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    endKM: '93K+300',
    description: '事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[2], '93K+300');
});

test('3. start/end range -> KM is shown as a "start～end" range', () => {
  const event = {
    source: 'freeway',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+300',
    endKM: '94K+100',
    description: '事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[2], '93K+300～94K+100');
});

test('4. structured KM present but NO resolvable section label (road outside roadSectionLabel.js\'s curated table) -> KM is still shown, never silently dropped', () => {
  const event = {
    type: 'construction',
    road: '台1線', // not in roadSectionLabel.js's ROAD_ANCHORS/ROAD_ALIASES
    direction: '南向',
    location: '台1線 南向 90K+000 - 91K+000', // a location string that is NOT a KM display and must not be shown instead
    startKM: '90K+000',
    endKM: '91K+000',
    description: '施工',
    updatedAt: '2026-08-15T09:00:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台1線 南向'); // no section label, so plain road+direction
  assert.equal(lines[2], '90K+000～91K+000'); // structured KM shown, not the location text
});

// Required test 5's spirit: PBS itself never carries a structured KM
// field today (see pbs/normalize.js's module comment) — but IF an event
// ever does carry both a structured KM and a displayKM (e.g. a future
// schema addition), the structured value must always win. This proves
// that priority ordering directly, independent of source.
test('5. when BOTH a structured KM and a displayKM are present, structured KM wins (displayKM is a lower-priority fallback only)', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+300',
    displayKM: 12.7, // deliberately conflicting — must be ignored
    description: '事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[2], '93K+300');
});

test('6. a PBS event with ONLY a parsed displayKM (no structured KM at all) shows it, formatted the same "NNK+NNN" way', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '國道一號',
    direction: '',
    location: '中山高速公路-國道1號', // the real reported-bug shape: route-name text, not a KM
    displayKM: 93.3,
    description: '南向在93.3公里處內側車道發生交通事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '國1');
  assert.equal(lines[2], '93K+300'); // NOT "中山高速公路-國道1號"
});

test('an event with neither structured KM nor a usable displayKM (undefined/NaN) falls back to location text, unchanged', () => {
  const event = {
    source: 'pbs',
    type: 'accident',
    road: '國道一號',
    direction: '',
    location: '中山高速公路-國道1號',
    displayKM: NaN,
    description: '事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[2], '中山高速公路-國道1號');
});

// 12. regression: the real, already-working 國1 南向 93K+300 case (from
// the Production report of what SHOULD keep working) still renders
// correctly after this round's fix.
test('12. regression — the real working "國1 南向｜新竹／科學園區附近 / 93K+300" case still renders unchanged', () => {
  const event = {
    source: 'freeway',
    type: 'accident',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+300',
    description: '事故',
    updatedAt: '2026-08-18T17:05:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.equal(
    text,
    ['🚨 交通事故', '國1 南向｜新竹／科學園區附近', '93K+300', '事故影響通行', '請提前避開', '🕒 17:05更新'].join('\n')
  );
});

test('a congestion cluster candidate (numeric startKM/endKM from congestionCluster.js) formats identically to a normal event', () => {
  const clusterCandidate = {
    source: 'congestion-cluster',
    rawId: 'freeway:N1+freeway:N2',
    type: 'congestion',
    road: '國道三號',
    direction: '北向',
    startKM: 90,
    endKM: 79,
    description: '車多回堵',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(clusterCandidate);
  // V1.4.1: defaults to "壅塞", not "嚴重壅塞" — see the test above.
  assert.match(text, /^🐢 壅塞\n國3 北向｜竹林－關西路段\n90K\+000～79K\+000\n/);
});

// --- V1.4.1: congestion severity (moderate/congested/severe) — see congestionSeverity.js ---

test('congestion severity "moderate" (車多) renders as 車流偏多, never as 嚴重壅塞', () => {
  const event = {
    type: 'congestion',
    congestionSeverity: 'moderate',
    road: '國道一號',
    direction: '北向',
    startKM: 91,
    endKM: 82.4,
    description: '北向車多',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /^🚗 車流偏多\n/);
  assert.doesNotMatch(text, /嚴重壅塞/);
});

test('congestion severity "congested" (壅塞) renders as 壅塞, not 嚴重壅塞', () => {
  const event = {
    type: 'congestion',
    congestionSeverity: 'congested',
    road: '國道一號',
    direction: '北向',
    startKM: 91,
    endKM: 82.4,
    description: '北向壅塞',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /^🐢 壅塞\n/);
  assert.doesNotMatch(text, /嚴重壅塞/);
});

test('congestion severity "severe" (VD-confirmed only) renders as 嚴重壅塞', () => {
  const event = {
    type: 'congestion',
    congestionSeverity: 'severe',
    road: '國道一號',
    direction: '北向',
    startKM: 91,
    endKM: 82.4,
    description: '北向壅塞',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /^🐢 嚴重壅塞\n/);
});

test('congestion with no congestionSeverity at all (e.g. an older/foreign event shape) defaults to 壅塞, never 嚴重壅塞', () => {
  const event = {
    type: 'congestion',
    road: '國道一號',
    direction: '北向',
    startKM: 91,
    endKM: 82.4,
    description: '北向車多',
    updatedAt: '2026-08-15T10:50:00+08:00',
  };
  const text = formatEventMessage(event);
  assert.match(text, /^🐢 壅塞\n/);
  assert.doesNotMatch(text, /嚴重壅塞/);
});
