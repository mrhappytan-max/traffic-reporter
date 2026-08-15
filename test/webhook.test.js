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

test('user: 播報啟動 (new ON synonym) enables, 播報關閉 (new OFF synonym) disables', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'user', userId: 'U100' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  // 1. 啟動播報 -> ON
  await send('啟動播報');
  let subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U100'), true);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);

  // 3. 關閉播報 -> OFF
  await send('關閉播報');
  subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U100'), false);

  // 2. 播報啟動 -> ON
  await send('播報啟動');
  subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U100'), true);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);

  // 4. 播報關閉 -> OFF
  await send('播報關閉');
  subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U100'), false);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已關閉/);

  // 5. 啟動播報 -> ON again
  await send('啟動播報');
  subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U100'), true);

  // 6. 播報關閉 -> OFF again
  await send('播報關閉');
  subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U100'), false);
});

test('group: 播報啟動/播報關閉 work identically to 啟動播報/關閉播報', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'group', groupId: 'C200' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  await send('播報啟動');
  let subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'C200'), true);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);

  await send('播報關閉');
  subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'C200'), false);
  assert.match(repliesSent.at(-1).body.messages[0].text, /已關閉/);

  // 播報狀態 still works after using the new synonyms.
  await send('播報狀態');
  assert.match(repliesSent.at(-1).body.messages[0].text, /已關閉/);

  await send('啟動播報');
  await send('播報狀態');
  assert.match(repliesSent.at(-1).body.messages[0].text, /已啟動/);
});

test('leading/trailing whitespace around a command is trimmed before matching', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  const body = {
    events: [
      {
        type: 'message',
        replyToken: 'rt',
        message: { type: 'text', text: '  啟動播報  \n' },
        source: { type: 'user', userId: 'U300' },
      },
    ],
  };
  const bodyText = JSON.stringify(body);
  await handleLineWebhook(makeRequest(body, sign(bodyText)), env);

  const subs = await readSubscriptions(kv);
  assert.equal(isUserEnabled(subs.subscriptions, 'U300'), true);
});

test('bare fragments ("播報" alone, "啟動" alone) must not accidentally trigger ON/OFF (no fuzzy matching)', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'user', userId: 'U400' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  for (const text of ['播報', '啟動']) {
    repliesSent.length = 0;
    await send(text);
    const subs = await readSubscriptions(kv);
    assert.equal(isUserEnabled(subs.subscriptions, 'U400'), false, `"${text}" must not enable`);
    assert.equal(repliesSent.length, 0, `"${text}" must not trigger a reply`);
  }
});

// "播報開啟" / "請幫我啟動播報" / "播報啟動吧" were previously (fixed-string
// era) treated as near-misses. Under this round's intent parser they are
// explicitly recognized natural phrasings (see broadcastIntent.js) — this
// documents that intentional behavior change.
test('natural phrasings recognized by the new parser: "播報開啟", "請幫我啟動播報", "播報啟動吧" all enable', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text, userId) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'user', userId } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  for (const [text, userId] of [
    ['播報開啟', 'U401'],
    ['請幫我啟動播報', 'U402'],
    ['播報啟動吧', 'U403'],
  ]) {
    await send(text, userId);
    const subs = await readSubscriptions(kv);
    assert.equal(isUserEnabled(subs.subscriptions, userId), true, `"${text}" should enable`);
  }
});

test('must not be misjudged: negated verbs and unrelated questions never flip ON/OFF or reply', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'user', userId: 'U500' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  for (const text of [
    '我不要關閉播報',
    '不要停止播報',
    '我不要開啟播報',
    '為什麼播報關閉了',
    '今天路況如何',
    '現在有事故嗎',
  ]) {
    repliesSent.length = 0;
    await send(text);
    const subs = await readSubscriptions(kv);
    assert.equal(isUserEnabled(subs.subscriptions, 'U500'), false, `"${text}" must not change the (default OFF) state`);
    assert.equal(repliesSent.length, 0, `"${text}" must not trigger a reply`);
  }
});

test('group: the same negation/question texts never flip a group\'s ON/OFF state either', async () => {
  const kv = createMockKV();
  const env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockLineReplyFetch();

  async function send(text) {
    const body = {
      events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source: { type: 'group', groupId: 'Cneg' } }],
    };
    const bodyText = JSON.stringify(body);
    return handleLineWebhook(makeRequest(body, sign(bodyText)), env);
  }

  await send('啟動播報');
  let subs = await readSubscriptions(kv);
  assert.equal(isGroupEnabled(subs.subscriptions, 'Cneg'), true);

  for (const text of ['我不要關閉播報', '不要停止播報', '為什麼播報關閉了']) {
    await send(text);
    subs = await readSubscriptions(kv);
    assert.equal(isGroupEnabled(subs.subscriptions, 'Cneg'), true, `"${text}" must not disable the group`);
  }
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
