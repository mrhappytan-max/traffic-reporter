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

test('GET /pbs without path token -> 404', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/pbs`);
      assert.equal(res.status, 404);
    }
  );
});

test('GET /pbs with a wrong path token -> 401', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/pbs/totally-wrong`);
      assert.equal(res.status, 401);
    }
  );
});

test('GET /pbs with the correct token -> 200, raw JSON passed through byte-for-byte, X-PBS-Cache header present', async () => {
  const raw = '[{"UID":"E2E-1","comment":"整合測試 事故"}]';
  await withServer(
    async () => new Response(raw, { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/pbs/${encodeURIComponent(TOKEN)}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-pbs-cache'), 'MISS');
      const text = await res.text();
      assert.equal(text, raw);
    }
  );
});

test('GET /pbs end-to-end with the exact real PBS response shape (text/plain content-type, {"result":[...]} envelope, ~330KB body) -> 200, untouched', async () => {
  // Reproduces the real PBS endpoint's actual response exactly as
  // confirmed live: Content-Type text/plain;charset=UTF-8 (not
  // application/json) and the array wrapped as {"result":[...]}. This
  // is the scenario that used to come back as a 502 — see
  // upstreamClient.js's fetchOnce fix (body-read now covered by the
  // same try/catch as the initial fetch() call).
  const records = Array.from({ length: 1000 }, (_, i) => ({
    UID: `PBS-${i}`,
    road: '',
    direction: '西行',
    areaNm: '測試路段',
    roadtype: '事故',
    comment: `測試事件 ${i}`,
    happendate: '2026-08-16',
    happentime: '05:52:00',
    modDttm: '2026-08-16 05:55:00',
    x1: '120.9987',
    y1: '24.7912',
    srcdetail: '民眾報案',
  }));
  const raw = JSON.stringify({ result: records });

  await withServer(
    async () => new Response(raw, { status: 200, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }),
    async (base) => {
      const res = await fetch(`${base}/pbs/${encodeURIComponent(TOKEN)}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-pbs-cache'), 'MISS');
      const text = await res.text();
      assert.equal(text, raw); // byte-for-byte — envelope and 1000 records untouched
      const parsed = JSON.parse(text);
      assert.equal(parsed.result.length, 1000);
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
      const res = await fetch(`${base}/pbs/wrong-guess`);
      const text = await res.text();
      assert.doesNotMatch(text, new RegExp(TOKEN));
    }
  );
});
