// V1.8.5 — src/line/pushMessage.js: pushLineMessages(env, to, messages) +
// the backward-compatible pushLineMessage(env, to, text) wrapper.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushLineMessage, pushLineMessages, LinePushError } from '../src/line/pushMessage.js';

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
});

function mockFetch(status = 200) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return new Response(status === 200 ? '{}' : 'error', { status });
    },
  };
}

test('pushLineMessage(text) is a thin wrapper: sends byte-for-byte the same body it always did', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await pushLineMessage({ LINE_CHANNEL_ACCESS_TOKEN: 'tok' }, 'U1', 'hello');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { to: 'U1', messages: [{ type: 'text', text: 'hello' }] });
});

test('pushLineMessages sends exactly one HTTP request carrying the full messages array, in order', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const messages = [
    { type: 'text', text: '國1 82K+100 事故' },
    { type: 'image', originalContentUrl: 'https://example.workers.dev/cctv/image/abc', previewImageUrl: 'https://example.workers.dev/cctv/image/abc' },
  ];
  await pushLineMessages({ LINE_CHANNEL_ACCESS_TOKEN: 'tok' }, 'U1', messages);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.messages, messages);
  assert.equal(calls[0].body.messages[0].type, 'text');
  assert.equal(calls[0].body.messages[1].type, 'image');
});

test('missing LINE_CHANNEL_ACCESS_TOKEN throws LinePushError, 0 fetch calls', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await assert.rejects(() => pushLineMessages({}, 'U1', [{ type: 'text', text: 'x' }]), LinePushError);
  assert.equal(calls.length, 0);
});

test('a non-2xx LINE response throws LinePushError with the status attached, single call, no retry inside this function', async () => {
  const { fetchFn, calls } = mockFetch(500);
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await assert.rejects(
    () => pushLineMessages({ LINE_CHANNEL_ACCESS_TOKEN: 'tok' }, 'U1', [{ type: 'text', text: 'x' }]),
    (err) => err instanceof LinePushError && err.status === 500
  );
  assert.equal(calls.length, 1); // exactly one attempt — no internal retry, no second text-only fallback call
});

test('the access token never appears in a thrown error message', async () => {
  const { fetchFn } = mockFetch(500);
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  try {
    await pushLineMessages({ LINE_CHANNEL_ACCESS_TOKEN: 'super-secret-token' }, 'U1', [{ type: 'text', text: 'x' }]);
    assert.fail('expected pushLineMessages to throw');
  } catch (err) {
    assert.doesNotMatch(err.message, /super-secret-token/);
  }
});
