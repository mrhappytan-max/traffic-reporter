import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyLineSignature } from '../src/line/verifySignature.js';

const SECRET = 'test-channel-secret';
const BODY = JSON.stringify({ events: [{ type: 'message' }] });

// Independent reference implementation (node:crypto) so this test isn't
// just checking the code against itself.
function referenceSignature(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

test('a correctly computed signature verifies as valid', async () => {
  const signature = referenceSignature(SECRET, BODY);
  assert.equal(await verifyLineSignature(BODY, signature, SECRET), true);
});

test('a wrong signature is rejected', async () => {
  const wrongSignature = referenceSignature('a-different-secret', BODY);
  assert.equal(await verifyLineSignature(BODY, wrongSignature, SECRET), false);
});

test('a tampered body is rejected even with the "right" signature for the original body', async () => {
  const signature = referenceSignature(SECRET, BODY);
  const tamperedBody = BODY.replace('message', 'evil');
  assert.equal(await verifyLineSignature(tamperedBody, signature, SECRET), false);
});

test('missing signature header or missing secret both fail closed', async () => {
  assert.equal(await verifyLineSignature(BODY, null, SECRET), false);
  assert.equal(await verifyLineSignature(BODY, referenceSignature(SECRET, BODY), undefined), false);
});
