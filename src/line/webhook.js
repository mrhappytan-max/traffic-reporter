// POST /webhook — LINE Messaging API webhook. Verifies X-Line-Signature
// before touching anything else. Only handles the 4 recognized text
// commands for 1:1 chats and groups; everything else is a silent 200 ack
// (per LINE's webhook contract — non-200 responses cause retries/webhook
// disablement).

import { verifyLineSignature } from './verifySignature.js';
import { replyLineMessage } from './replyMessage.js';
import { setUserEnabled, setGroupEnabled, readSubscriptions, isUserEnabled, isGroupEnabled } from '../traffic/subscriptions.js';

const ENABLE_COMMANDS = new Set(['啟動播報']);
const DISABLE_COMMANDS = new Set(['關閉播報', '停止播報']);
const STATUS_COMMANDS = new Set(['播報狀態']);

const REPLY_ENABLED =
  '✅ 路況播報已啟動\n播報時間：08:00～22:00\n僅通知目前或未來60分鐘內會影響行車的路況。';
const REPLY_DISABLED = '🔕 路況播報已關閉';

export async function handleLineWebhook(request, env, now = new Date()) {
  const bodyText = await request.text();
  const signature = request.headers.get('X-Line-Signature');

  const valid = await verifyLineSignature(bodyText, signature, env.LINE_CHANNEL_SECRET);
  if (!valid) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response('OK', { status: 200 }); // malformed body, ack anyway
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  if (events.length === 0) {
    return new Response('OK', { status: 200 }); // LINE's webhook "Verify" ping
  }

  for (const event of events) {
    try {
      await handleSingleEvent(event, env, now);
    } catch (err) {
      // Never let one bad event fail the whole webhook ack.
      console.error(`[line-webhook] event handling failed: ${err && err.message}`);
    }
  }

  return new Response('OK', { status: 200 });
}

async function handleSingleEvent(event, env, now) {
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;

  const text = typeof event.message.text === 'string' ? event.message.text.trim() : '';
  const replyToken = event.replyToken;
  const source = event.source || {};

  let targetKind;
  let targetId;
  if (source.type === 'user') {
    targetKind = 'user';
    targetId = source.userId;
  } else if (source.type === 'group') {
    targetKind = 'group';
    targetId = source.groupId;
  } else {
    return; // rooms / unknown source types are out of scope this round
  }
  if (!targetId) return;

  if (ENABLE_COMMANDS.has(text)) {
    if (targetKind === 'user') await setUserEnabled(env.TRAFFIC_KV, targetId, true, now);
    else await setGroupEnabled(env.TRAFFIC_KV, targetId, true, now);
    if (replyToken) await replyLineMessage(env, replyToken, REPLY_ENABLED);
    return;
  }

  if (DISABLE_COMMANDS.has(text)) {
    if (targetKind === 'user') await setUserEnabled(env.TRAFFIC_KV, targetId, false, now);
    else await setGroupEnabled(env.TRAFFIC_KV, targetId, false, now);
    if (replyToken) await replyLineMessage(env, replyToken, REPLY_DISABLED);
    return;
  }

  if (STATUS_COMMANDS.has(text)) {
    const state = await readSubscriptions(env.TRAFFIC_KV, now);
    const enabled = targetKind === 'user' ? isUserEnabled(state.subscriptions, targetId) : isGroupEnabled(state.subscriptions, targetId);
    const statusText = enabled ? '目前：✅ 已啟動' : '目前：🔕 已關閉';
    if (replyToken) await replyLineMessage(env, replyToken, statusText);
    return;
  }

  // Non-command text: do nothing.
}
