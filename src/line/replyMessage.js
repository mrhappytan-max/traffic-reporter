// LINE Messaging API — reply (webhook command responses). Never includes
// the access token in any thrown error message.

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

export class LineReplyError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'LineReplyError';
    this.status = status;
  }
}

export async function replyLineMessage(env, replyToken, text) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new LineReplyError('Missing LINE_CHANNEL_ACCESS_TOKEN');

  let response;
  try {
    response = await fetch(LINE_REPLY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
  } catch (err) {
    throw new LineReplyError(`Network error calling LINE reply API: ${err.message}`);
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new LineReplyError(
      `LINE reply API responded with HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      { status: response.status }
    );
  }

  return true;
}
