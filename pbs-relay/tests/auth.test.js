import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../src/auth.js';

test('no Authorization header -> not authorized', () => {
  assert.equal(isAuthorized(undefined, 'secret-token'), false);
  assert.equal(isAuthorized(null, 'secret-token'), false);
});

test('wrong token -> not authorized', () => {
  assert.equal(isAuthorized('Bearer wrong-token', 'secret-token'), false);
});

test('correct token -> authorized', () => {
  assert.equal(isAuthorized('Bearer secret-token', 'secret-token'), true);
});

test('missing "Bearer " prefix -> not authorized', () => {
  assert.equal(isAuthorized('secret-token', 'secret-token'), false);
});

test('RELAY_TOKEN not configured on this deploy -> always not authorized (fail closed)', () => {
  assert.equal(isAuthorized('Bearer anything', undefined), false);
  assert.equal(isAuthorized('Bearer anything', ''), false);
});

test('token comparison is exact, not a prefix/substring match', () => {
  assert.equal(isAuthorized('Bearer secret-token-extra', 'secret-token'), false);
  assert.equal(isAuthorized('Bearer secret-', 'secret-token'), false);
});
