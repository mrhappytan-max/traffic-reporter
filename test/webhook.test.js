import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleLineWebhook } from '../src/line/webhook.js';
import { readSubscriptions, isUserEnabled, isGroupEnabled } from '../src/traffic/subscriptions.js';

const SECRET = 'test-channel-secret';

function sign(body) {
  return createHmac('sha256', SECRET).update(body).digest('base64');
}

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

function makeRequest(bodyObj, signature) {
  const bodyText = JSON.stringify(bodyObj);
  const headers = new Headers();
  if (signature !== undefined) headers.set('X-Line-Signature', signature);
  return new Request('https://example.invalid/webhook', { method: 'POST', body: bodyText, headers });
}

let originalFetch;
let repliesSent;

function mockLineReplyFetch() {
  repliesSent = [];
  return async (url, init) => {
    repliesSent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('correct signature -> 200', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const body = { events: [] };
  const bodyText = JSON.stringify(body);
  const req = makeRequest(body, sign(bodyText));

  const res = await handleLineWebhook(req, env);
  assert.equal(res.status, 200);
});

test('wrong signature -> 401', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const req = makeRequest({ events: [] }, 'totally-wrong-signature');

  const res = await handleLineWebhook(req, env);
  assert.equal(res.status, 401);
});

test('empty events array (LINE webhook verify ping) -> 200, no side effects', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  const body = { events: [] };
  const bodyText = JSON.stringify(body);
  const req = makeRequest(body, sign(bodyText));

  const res = await handleLineWebhook(req, env);
  assert.equal(res.status, 200);
  assert.equal(kv.store.size, 0);
});

test('non-command text -> 200, no state change, no reply sent', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  const body = {
    events: [
      {
        type: 'message',
        replyToken: 'rt1',
        message: { type: 'text', text: '今天天氣真好' },
        source: { type: 'user', userId: 'U1' },
      },
    ],
  };
  const bodyText = JSON.stringify(body);
  const req = makeRequest(body, sign(bodyText));

  const res = await handleLineWebhook(req, env);
  assert.equal(res.status, 200);
  assert.equal(repliesSent.length, 0);
  assert.equal(kv.store.size, 0);
});

test('user: 啟動播報 -> enabled + reply, 播報狀態 -> "已啟動", 關閉播報 -> disabled + reply, 播報狀態 -> "已關閉"', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [
        {
          type: 'message',
          replyToken: `rt-${text}`,
          message: { type: 'text', text },
          source: { type: 'user', userId: 'U42' },
        },
      ],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  await send('啟動播報');
  let subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U42'), true);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);

  await send('播報狀態');
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);

  await send('關閉播報');
  subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U42'), false);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已關閉/);

  await send('播報狀態');
  assert.match(repliesSent.at(-1).body.messages[0].text, /已關閉/);
});

test('user: 停止播報 also disables (synonym for 關閉播報)', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'user', userId: 'U7' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  await send('啟動播報');
  await send('停止播報');
  const subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U7'), false);
});

test('group: 啟動播報/關閉播報/播報狀態 work the same as 1:1, independent of any user state', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'group', groupId: 'Cabc' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  let subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'Cabc'), false); // default OFF

  await send('啟動播報');
  subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'Cabc'), true);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);

  await send('關閉播報');
  subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'Cabc'), false);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已關閉/);
});
