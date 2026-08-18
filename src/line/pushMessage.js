// LINE Messaging API — push (proactive, Cron-triggered notifications).
// Never includes the access token in any thrown error message.
//
// V1.8.5: generalized from single-text-message-only to an arbitrary
// `messages` array (pushLineMessages), so a single LINE API call can
// carry BOTH the accident text AND its CCTV collage image (see
// traffic/broadcastPipeline.js) — LINE's own API already supports up to
// 5 message objects per push in one request; this was never a LINE-side
// limitation, only this module's own signature. pushLineMessage(text) is
// kept as a thin wrapper over pushLineMessages([{type:'text',text}]) —
// byte-for-byte the same request body it always sent — so every existing
// caller/test keeps working unchanged.

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

export class LinePushError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'LinePushError';
    this.status = status;
  }
}

/**
 * Sends exactly ONE LINE push API request carrying `messages` (1-5
 * message objects, per LINE's own API limit — not enforced here, since
 * every caller in this project only ever sends 1 or 2). Deliberately a
 * single request, never multiple: see broadcastPipeline.js's V1.8.5
 * comment on why a text-then-image two-call sequence was rejected (a
 * second call failing after the first succeeded would leave
 * notified-state semantics ambiguous — did this target get notified or
 * not).
 *
 * @param {object} env
 * @param {string} to
 * @param {Array<object>} messages - LINE message objects, e.g.
 *   [{type:'text',text}] or
 *   [{type:'text',text}, {type:'image',originalContentUrl,previewImageUrl}].
 * @returns {Promise<true>} resolves true only on an HTTP 2xx response —
 *   this is the ONLY thing that means "this target was notified" (see
 *   module comment); anything else throws LinePushError.
 */
export async function pushLineMessages(env, to, messages) {
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
      body: JSON.stringify({ to, messages }),
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

/** Thin backward-compatible wrapper — see module comment. */
export async function pushLineMessage(env, to, text) {
  return pushLineMessages(env, to, [{ type: 'text', text }]);
}
