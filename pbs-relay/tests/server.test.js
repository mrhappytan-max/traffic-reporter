// Real HTTP integration tests: an ephemeral server bound to 127.0.0.1 on
// a random port, hit with real fetch() calls. Only the upstream PBS call
// is mocked (via the injected fetchImpl) — no real network access.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// 路況-080: with no logDirectory passed (every test above), createServer()
// must behave exactly as it always did — nothing above this line was
// changed to prove that. These two tests cover the new, opt-in behavior
// itself.
test('GET /health without logDirectory still returns 200 and writes nothing (logging stays off by default)', async () => {
  await withServer(
    async () => new Response('[]', { status: 200 }),
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
    }
  );
  // No assertion beyond "did not throw" is possible here without a
  // directory to check — the absence of a logDirectory means
  // createHealthCheckLogger() is never even constructed (see server.js),
  // which is exercised directly in the next test instead.
});

test('GET /health with logDirectory set writes a health_check log record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pbs-relay-server-health-log-'));
  const server = createServer({
    relayToken: TOKEN,
    fetchImpl: async () => new Response('[]', { status: 200 }),
    logDirectory: directory,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const log = await readFile(join(directory, `${today}.jsonl`), 'utf8');
    assert.match(log, /"event":"health_check"/);
    assert.match(log, /"status":"ok"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
