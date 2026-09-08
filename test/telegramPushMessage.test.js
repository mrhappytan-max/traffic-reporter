// V2.5.0 (路況-052) — src/telegram/pushMessage.js:
// pushTelegramMessage(env, chatId, text, imageUrl).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushTelegramMessage, TelegramPushError } from '../src/telegram/pushMessage.js';

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
      calls.push({ url: String(url), body: JSON.parse(init.body), signal: init.signal });
      return new Response(status === 200 ? '{}' : 'error', { status });
    },
  };
}

test('(a) with an imageUrl, calls sendPhoto exactly once with chat_id/photo/caption', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await pushTelegramMessage(
    { TELEGRAM_BOT_TOKEN: 'tok' },
    '-1004328365784',
    '🚨 交通事故\n國1 北向\n95K附近',
    'https://traffic-reporter.example.workers.dev/cctv/image/abc'
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bottok\/sendPhoto$/);
  assert.deepEqual(calls[0].body, {
    chat_id: '-1004328365784',
    photo: 'https://traffic-reporter.example.workers.dev/cctv/image/abc',
    caption: '🚨 交通事故\n國1 北向\n95K附近',
  });
});

test('(d) without an imageUrl (null/omitted), calls sendMessage instead — request body never carries a photo field', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await pushTelegramMessage({ TELEGRAM_BOT_TOKEN: 'tok' }, '-1004328365784', '🚧 施工\n國3 南向', null);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bottok\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: '-1004328365784', text: '🚧 施工\n國3 南向' });
  assert.equal('photo' in calls[0].body, false);
  assert.equal('caption' in calls[0].body, false);
});

test('every call carries an AbortSignal (8s timeout, per order section 三)', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await pushTelegramMessage({ TELEGRAM_BOT_TOKEN: 'tok' }, '-1004328365784', 'x', null);
  assert.ok(calls[0].signal instanceof AbortSignal, 'a real AbortSignal must be attached to the fetch call');
});

test('missing TELEGRAM_BOT_TOKEN throws TelegramPushError, 0 fetch calls', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await assert.rejects(() => pushTelegramMessage({}, '-1004328365784', 'x', null), TelegramPushError);
  assert.equal(calls.length, 0);
});

test('missing chatId throws TelegramPushError, 0 fetch calls', async () => {
  const { fetchFn, calls } = mockFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await assert.rejects(() => pushTelegramMessage({ TELEGRAM_BOT_TOKEN: 'tok' }, undefined, 'x', null), TelegramPushError);
  assert.equal(calls.length, 0);
});

test('a non-2xx Telegram response throws TelegramPushError with the status attached, single call, no retry inside this function', async () => {
  const { fetchFn, calls } = mockFetch(500);
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  await assert.rejects(
    () => pushTelegramMessage({ TELEGRAM_BOT_TOKEN: 'tok' }, '-1004328365784', 'x', null),
    (err) => err instanceof TelegramPushError && err.status === 500
  );
  assert.equal(calls.length, 1);
});

test('a network/timeout error throws TelegramPushError (never lets the raw fetch rejection escape)', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network unreachable');
  };

  await assert.rejects(() => pushTelegramMessage({ TELEGRAM_BOT_TOKEN: 'tok' }, '-1004328365784', 'x', null), TelegramPushError);
});

test('the bot token never appears in a thrown error message — neither the URL nor the response body path leaks it', async () => {
  const { fetchFn } = mockFetch(500);
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  try {
    await pushTelegramMessage({ TELEGRAM_BOT_TOKEN: 'super-secret-telegram-token' }, '-1004328365784', 'x', null);
    assert.fail('expected pushTelegramMessage to throw');
  } catch (err) {
    assert.doesNotMatch(err.message, /super-secret-telegram-token/);
  }
});
