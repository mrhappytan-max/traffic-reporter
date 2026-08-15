// LINE Messaging API — push (proactive, Cron-triggered notifications).
// Never includes the access token in any thrown error message.

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

export class LinePushError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'LinePushError';
    this.status = status;
  }
}

export async function pushLineMessage(env, to, text) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new LinePushError('Missing LINE_CHANNEL_ACCESS_TOKEN');

  let response;
  try {
    response = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
  } catch (err) {
    throw new LinePushError(`Network error calling LINE push API: ${err.message}`);
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch {
      // ignore — body isn't required for the error to be useful
    }
    throw new LinePushError(
      `LINE push API responded with HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      { status: response.status }
    );
  }

  return true;
}
