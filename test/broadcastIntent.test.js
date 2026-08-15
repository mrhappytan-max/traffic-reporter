import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBroadcastCommand } from '../src/line/broadcastIntent.js';

function intentOf(text) {
  return parseBroadcastCommand(text).intent;
}

test('ON: core fixed phrases + English forms', () => {
  const cases = [
    '啟動播報', '開啟播報', '打開播報', '開始播報',
    '播報啟動', '播報開啟', '播報打開',
    '開始路況播報', '啟動路況播報', '打開路況播報',
    'ON', 'on', 'On',
  ];
  for (const text of cases) {
    assert.equal(intentOf(text), 'enable', `"${text}" should be enable`);
  }
});

test('ON: natural equivalent phrasing (我要/幫我 + verb, and 路況 as the target)', () => {
  const cases = [
    '我要開啟播報',
    '幫我開啟播報',
    '幫我打開播報',
    '我要開始播報',
    '開啟路況',
    '開始路況',
    '路況播報開啟',
    '路況播報啟動',
  ];
  for (const text of cases) {
    assert.equal(intentOf(text), 'enable', `"${text}" should be enable`);
  }
});

test('OFF: core fixed phrases + English forms', () => {
  const cases = [
    '關閉播報', '關掉播報', '停止播報',
    '播報關閉', '播報關掉', '播報停止',
    'OFF', 'off', 'Off',
  ];
  for (const text of cases) {
    assert.equal(intentOf(text), 'disable', `"${text}" should be disable`);
  }
});

test('OFF: natural equivalent phrasing, including the "不要...了" stop phrases', () => {
  const cases = [
    '我要關閉播報',
    '幫我關閉播報',
    '幫我關掉播報',
    '不要播報了',
    '停止路況播報',
    '關閉路況播報',
    '路況播報關閉',
    '路況播報停止',
    '不要再播了',
    '暫停播報',
  ];
  for (const text of cases) {
    assert.equal(intentOf(text), 'disable', `"${text}" should be disable`);
  }
});

test('status queries', () => {
  const cases = ['播報狀態', '路況播報狀態', '現在有開播報嗎', '播報有開嗎', '播報開著嗎'];
  for (const text of cases) {
    assert.equal(intentOf(text), 'status', `"${text}" should be status`);
  }
});

test('must NOT be misjudged as enable/disable: negated verbs and unrelated questions', () => {
  const cases = [
    '我不要關閉播報',
    '不要停止播報',
    '我不要開啟播報',
    '為什麼播報關閉了',
    '今天路況如何',
    '現在有事故嗎',
  ];
  for (const text of cases) {
    const intent = intentOf(text);
    assert.notEqual(intent, 'enable', `"${text}" must not be enable`);
    assert.notEqual(intent, 'disable', `"${text}" must not be disable`);
  }
});

test('more negation cases from the spec (不要開啟/不要開始/不要關掉)', () => {
  const cases = ['不要關閉播報', '不要開啟播報', '不要開始播報', '不要關掉播報'];
  for (const text of cases) {
    const intent = intentOf(text);
    assert.equal(intent, 'unknown', `"${text}" should be unknown (ambiguous negation), got "${intent}"`);
  }
});

test('bare, contentless fragments stay unknown — no substring guessing', () => {
  for (const text of ['播報', '啟動', '關閉', '開始']) {
    assert.equal(intentOf(text), 'unknown', `"${text}" alone should be unknown`);
  }
});

test('text normalization: leading/trailing whitespace (incl. fullwidth space) and fullwidth English letters are tolerated', () => {
  assert.equal(intentOf('  啟動播報  \n'), 'enable');
  assert.equal(intentOf('　關閉播報　'), 'disable'); // fullwidth ideographic spaces
  assert.equal(intentOf('ｏｎ'), 'enable'); // fullwidth "on"
  assert.equal(intentOf('ＯＦＦ'), 'disable'); // fullwidth "OFF"
});

test('empty / non-string input is unknown, never throws', () => {
  assert.equal(intentOf(''), 'unknown');
  assert.equal(intentOf('   '), 'unknown');
  assert.equal(parseBroadcastCommand(undefined).intent, 'unknown');
  assert.equal(parseBroadcastCommand(null).intent, 'unknown');
});

test('unrelated chit-chat never matches', () => {
  for (const text of ['今天天氣真好', '午餐吃什麼', '謝謝', '哈囉']) {
    assert.equal(intentOf(text), 'unknown', `"${text}" should be unknown`);
  }
});
