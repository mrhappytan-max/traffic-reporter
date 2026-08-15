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
  assert.equal(
    text,
    ['🚨 交通事故', '國道一號 北向', '95K附近', '事故影響通行', '請提前避開', '🕒 12:35更新'].join('\n')
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
