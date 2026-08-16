import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../src/auth.js';

test('missing custom token header -> not authorized', () => {
  assert.equal(isAuthorized(undefined, 'secret-token'), false);
  assert.equal(isAuthorized(null, 'secret-token'), false);
  assert.equal(isAuthorized('', 'secret-token'), false);
});

test('wrong custom token -> not authorized', () => {
  assert.equal(isAuthorized('wrong-token', 'secret-token'), false);
});

test('correct custom token -> authorized', () => {
  assert.equal(isAuthorized('secret-token', 'secret-token'), true);
});

test('Bearer-formatted value is not accepted as a custom token', () => {
  assert.equal(isAuthorized('Bearer secret-token', 'secret-token'), false);
});

test('RELAY_TOKEN not configured -> always not authorized (fail closed)', () => {
  assert.equal(isAuthorized('anything', undefined), false);
  assert.equal(isAuthorized('anything', ''), false);
});

test('token comparison is exact, not a prefix/substring match', () => {
  assert.equal(isAuthorized('secret-token-extra', 'secret-token'), false);
  assert.equal(isAuthorized('secret-', 'secret-token'), false);
});
