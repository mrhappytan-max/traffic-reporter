import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedPathToken } from '../src/auth.js';

test('missing path token -> not authorized', () => {
  assert.equal(isAuthorizedPathToken(undefined, 'secret-token'), false);
  assert.equal(isAuthorizedPathToken(null, 'secret-token'), false);
  assert.equal(isAuthorizedPathToken('', 'secret-token'), false);
});

test('wrong path token -> not authorized', () => {
  assert.equal(isAuthorizedPathToken('wrong-token', 'secret-token'), false);
});

test('encoded correct path token -> authorized', () => {
  assert.equal(isAuthorizedPathToken(encodeURIComponent('secret/token'), 'secret/token'), true);
});

test('raw Bearer value is not a path token', () => {
  assert.equal(isAuthorizedPathToken('Bearer%20secret-token', 'secret-token'), false);
});

test('malformed encoding and missing RELAY_TOKEN fail closed', () => {
  assert.equal(isAuthorizedPathToken('%E0%A4%A', 'secret-token'), false);
  assert.equal(isAuthorizedPathToken(encodeURIComponent('anything'), undefined), false);
});

test('token comparison is exact, not a prefix/substring match', () => {
  assert.equal(isAuthorizedPathToken(encodeURIComponent('secret-token-extra'), 'secret-token'), false);
  assert.equal(isAuthorizedPathToken(encodeURIComponent('secret-'), 'secret-token'), false);
});
