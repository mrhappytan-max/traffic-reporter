// Real HTTP integration tests: an ephemeral server bound to 127.0.0.1 on
// a random port, hit with real fetch() calls. Only the upstream PBS call
// is mocked (via the injected fetchImpl) — no real network access.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const TOKEN = 'integration-token';

async function withServer(fetchImpl, testFn) {
  const server = createServer({ relayToken: TOKEN, fetchImpl });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await testFn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /health -> 200 {ok:true}, no Authorization required', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { ok: true });
    }
  );
});

test('GET /pbs without Authorization -> 401', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/pbs`);
      assert.equal(res.status, 401);
    }
  );
});

test('GET /pbs with a wrong token -> 401', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/pbs`, { headers: { Authorization: 'Bearer totally-wrong' } });
      assert.equal(res.status, 401);
    }
  );
});

test('GET /pbs with the correct token -> 200, raw JSON passed through byte-for-byte, X-PBS-Cache header present', async () => {
  const raw = '[{"UID":"E2E-1","comment":"整合測試 事故"}]';
  await withServer(
    async () => new Response(raw, { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/pbs`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-pbs-cache'), 'MISS');
      const text = await res.text();
      assert.equal(text, raw);
    }
  );
});

test('an unknown route -> 404', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/nope`);
      assert.equal(res.status, 404);
    }
  );
});

test('RELAY_TOKEN never appears in any response body across the whole request/response cycle', async () => {
  await withServer(
    async () => new Response('error', { status: 500 }),
    async (base) => {
      const res = await fetch(`${base}/pbs`, { headers: { Authorization: 'Bearer wrong-guess' } });
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(TOKEN));
    }
  );
});
