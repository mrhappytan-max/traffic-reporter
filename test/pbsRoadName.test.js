import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePbsRoad, toHalfwidthDigits } from '../src/pbs/roadName.js';

test('toHalfwidthDigits converts fullwidth digits to halfwidth', () => {
  assert.equal(toHalfwidthDigits('国道１号'), '国道1号');
  assert.equal(toHalfwidthDigits('台６８線'), '台68線');
  assert.equal(toHalfwidthDigits('no digits here'), 'no digits here');
});

test('"中山高速公路-國道１號" -> "國道一號"', () => {
  assert.equal(normalizePbsRoad('', '中山高速公路-國道１號'), '國道一號');
});

test('"福爾摩沙高速公路-國道３號" -> "國道三號"', () => {
  assert.equal(normalizePbsRoad('', '福爾摩沙高速公路-國道３號'), '國道三號');
});

test('"(南寮竹東)-台68線" -> "台68"', () => {
  assert.equal(normalizePbsRoad('', '(南寮竹東)-台68線'), '台68');
});

test('"(西濱快速)-台61線" -> "台61"', () => {
  assert.equal(normalizePbsRoad('', '(西濱快速)-台61線'), '台61');
});

test('a populated `road` field is preferred over areaNm (and gets the same style normalization)', () => {
  // road wins over areaNm; "台1線" -> "台1" via the same highway-name
  // pattern used for areaNm derivation, for a consistent output style
  // regardless of which field it came from.
  assert.equal(normalizePbsRoad('台1線', '(南寮竹東)-台68線'), '台1');
});

test('a populated `road` field that is not in areaNm-style text passes through unchanged (halfwidth-normalized)', () => {
  assert.equal(normalizePbsRoad('光復路', '新竹市'), '光復路');
});

test('an empty/whitespace `road` field falls back to areaNm derivation', () => {
  assert.equal(normalizePbsRoad('', '(南寮竹東)-台68線'), '台68');
  assert.equal(normalizePbsRoad('   ', '(南寮竹東)-台68線'), '台68');
});

test('areaNm with no recognizable road pattern falls back to the raw (halfwidth-normalized) text', () => {
  assert.equal(normalizePbsRoad('', '新竹市光復路'), '新竹市光復路');
});

test('both road and areaNm empty -> empty string, not a crash', () => {
  assert.equal(normalizePbsRoad('', ''), '');
  assert.equal(normalizePbsRoad(undefined, undefined), '');
});
