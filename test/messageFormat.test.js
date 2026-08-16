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
    ['🐢 嚴重壅塞', '國1 北向｜竹北－湖口路段', '91K+000～82K+400', '車多回堵\n請預留時間', '🕒 10:50更新'].join('\n')
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

test('a road without a resolvable section label (e.g. 台1線) falls back to the original road+direction/location display, unchanged', () => {
  const event = {
    type: 'construction',
    road: '台1線',
    direction: '南向',
    location: '台1線 南向 90K+000 - 91K+000',
    startKM: '90K+000',
    endKM: '91K+000',
    description: '施工',
    updatedAt: '2026-08-15T09:00:00+08:00',
  };
  const text = formatEventMessage(event);
  const lines = text.split('\n');
  assert.equal(lines[1], '台1線 南向');
  // The redundant "road direction " prefix is stripped even in the
  // fallback path, so the duplicate-line bug can't resurface here either.
  assert.equal(lines[2], '90K+000 - 91K+000');
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
  assert.match(text, /^🐢 嚴重壅塞\n國3 北向｜竹林－關西路段\n90K\+000～79K\+000\n/);
});
