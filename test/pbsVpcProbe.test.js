import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handlePbsVpcProbe } from '../src/pbs/vpcProbe.js';

test('PBS VPC probe checks health then PBS and returns only safe bounded fields', async () => {
  const calls = [];
  const secret = 'probe-secret-token';
  const body = `${secret} ${'x'.repeat(400)}`;
  const response = await handlePbsVpcProbe({
    PBS_RELAY_TOKEN: secret,
    PBS_RELAY_WINDOWS: {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return new Response(body, { status: 200 });
      },
    },
  });
  const json = await response.json();

  assert.deepEqual(calls.map((call) => call.url), [
    'http://pbs-relay.internal/health',
    'http://pbs-relay.internal/pbs',
  ]);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(Object.keys(json).sort(), [
    'healthBody', 'healthOk', 'healthStatus', 'pbsBodyPreview', 'pbsOk', 'pbsStatus', 'relayConfigured',
  ].sort());
  assert.equal(json.healthStatus, 200);
  assert.equal(json.pbsStatus, 200);
  assert.equal(json.relayConfigured, true);
  assert.equal(json.healthBody.length, 300);
  assert.equal(json.pbsBodyPreview.length, 300);
  assert.doesNotMatch(JSON.stringify(json), /probe-secret-token|Authorization/);
});

test('PBS VPC probe reports fetch exceptions without leaking secrets', async () => {
  const secret = 'probe-secret-token';
  const response = await handlePbsVpcProbe({
    PBS_RELAY_TOKEN: secret,
    PBS_RELAY_WINDOWS: {
      fetch: async (url) => {
        if (url.endsWith('/health')) throw new TypeError(`Authorization Bearer ${secret} failed`);
        throw new Error('tunnel offline');
      },
    },
  });
  const json = await response.json();

  assert.equal(json.healthOk, false);
  assert.equal(json.pbsOk, false);
  assert.match(json.healthBody, /^TypeError: /);
  assert.match(json.pbsBodyPreview, /^Error: tunnel offline$/);
  assert.doesNotMatch(JSON.stringify(json), /probe-secret-token|Authorization/);
});
