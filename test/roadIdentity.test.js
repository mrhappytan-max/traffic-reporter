// V1.8.6.5 — road-name canonicalization. See src/traffic/roadIdentity.js's
// own module comment: these must be data-driven/generic (any freeway or
// provincial route number), never a hardcoded per-route special case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFreewayRoad, canonicalProvincialRoad } from '../src/traffic/roadIdentity.js';

test('canonicalFreewayRoad: Arabic-numeral form converts to canonical Chinese-numeral form (generic, not a per-route table)', () => {
  assert.equal(canonicalFreewayRoad('國道1號'), '國道一號');
  assert.equal(canonicalFreewayRoad('國道3號'), '國道三號');
  assert.equal(canonicalFreewayRoad('國道10號'), '國道十號');
  assert.equal(canonicalFreewayRoad('國道61號'), '國道六十一號');
  assert.equal(canonicalFreewayRoad('國道88號'), '國道八十八號');
});

test('canonicalFreewayRoad: already-Chinese-numeral form passes through / normalizes spacing', () => {
  assert.equal(canonicalFreewayRoad('國道一號'), '國道一號');
  assert.equal(canonicalFreewayRoad('國道 三 號'), '國道三號');
  assert.equal(canonicalFreewayRoad('國道三'), '國道三號'); // missing 號 suffix still recognized
});

test('canonicalFreewayRoad: historical nickname aliases resolve to canonical form', () => {
  assert.equal(canonicalFreewayRoad('中山高'), '國道一號');
  assert.equal(canonicalFreewayRoad('中山高速公路'), '國道一號');
  assert.equal(canonicalFreewayRoad('福爾摩沙高速公路'), '國道三號');
  assert.equal(canonicalFreewayRoad('二高'), '國道三號');
});

test('canonicalFreewayRoad: unrecognized / non-freeway text returns null, never a guess', () => {
  assert.equal(canonicalFreewayRoad('台3線'), null);
  assert.equal(canonicalFreewayRoad('中華路'), null);
  assert.equal(canonicalFreewayRoad(''), null);
  assert.equal(canonicalFreewayRoad(undefined), null);
  assert.equal(canonicalFreewayRoad('國道999號'), null); // out of the 1-99 numeral range this module supports
});

test('canonicalProvincialRoad: strips "線" suffix and "省道" prefix, keeps the route+alphabetic-suffix identity', () => {
  assert.equal(canonicalProvincialRoad('台3線'), '台3');
  assert.equal(canonicalProvincialRoad('台3'), '台3');
  assert.equal(canonicalProvincialRoad('台13甲線'), '台13甲');
  assert.equal(canonicalProvincialRoad('省道台61線'), '台61');
});

test('canonicalProvincialRoad: leading zeros are stripped', () => {
  assert.equal(canonicalProvincialRoad('台03線'), '台3');
});

test('canonicalProvincialRoad: unrecognized / non-provincial text returns null, never a guess', () => {
  assert.equal(canonicalProvincialRoad('國道一號'), null);
  assert.equal(canonicalProvincialRoad('中華路'), null);
  assert.equal(canonicalProvincialRoad(''), null);
  assert.equal(canonicalProvincialRoad(undefined), null);
});
