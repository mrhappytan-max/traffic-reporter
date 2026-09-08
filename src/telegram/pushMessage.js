// Telegram Bot API — push (proactive, second notification destination
// alongside LINE — see traffic/aiApprovedPbsBroadcast.js's own V2.5.0
// comment for how this is wired in). Never includes the bot token in any
// thrown error message — unlike LINE (token in an Authorization header),
// Telegram's own API puts the token IN THE URL PATH
// (https://api.telegram.org/bot<token>/<method>), so this module never
// echoes the request URL itself into an error either — only the bare
// method name (sendMessage/sendPhoto), which carries no secret.
//
// V2.5.0 (路況-052, following 路況-050's own plan) — Telegram channel push.
// This module is deliberately as small as LINE's own pushMessage.js: one
// function, one job. It does not know about targets, dedupe, or
// notified-state — see aiApprovedPbsBroadcast.js's own comment for how the
// caller reuses the EXISTING per-target loop/notified-state machinery
// (路況-050's "Plan B") by treating the channel as one more synthetic
// target (`kind: 'telegram-channel'`) rather than inventing a second,
// parallel dedupe mechanism here.
//
// chat_id (env.TELEGRAM_CHAT_ID) is NOT a secret — see wrangler.jsonc's own
// comment on that var — only env.TELEGRAM_BOT_TOKEN (a Cloudflare Secret,
// never read by anything but this module) is.

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_CALL_TIMEOUT_MS = 8000; // 路況-052 order section 三 — same AbortSignal.timeout() idiom as tdx/hsinchuCctvProbe.js:988

export class TelegramPushError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'TelegramPushError';
    this.status = status;
  }
}

/**
 * Sends exactly ONE Telegram Bot API call — `sendPhoto` (photo by URL,
 * with `caption: text`) when `imageUrl` is present, otherwise `sendMessage`
 * (`text` alone). This project's own message templates are always far
 * short of Telegram's 1024-char sendPhoto caption limit (well under both
 * that and sendMessage's 4096-char limit — see messageFormat.js's own
 * fixed short templates), so a single call always suffices; this function
 * never splits text+photo into two calls.
 *
 * @param {object} env
 * @param {string} chatId - env.TELEGRAM_CHAT_ID, the numeric channel id
 * @param {string} text
 * @param {string|null} [imageUrl] - the SAME CCTV image URL already
 *   computed for LINE (cctv.imageUrl / completedProduct.imageUrl) — never
 *   recomputed or re-resolved here.
 * @returns {Promise<true>} resolves true only on an HTTP 2xx response;
 *   anything else (non-2xx, network error, timeout) throws
 *   TelegramPushError.
 */
export async function pushTelegramMessage(env, chatId, text, imageUrl = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramPushError('Missing TELEGRAM_BOT_TOKEN');
  if (!chatId) throw new TelegramPushError('Missing TELEGRAM_CHAT_ID');

  const method = imageUrl ? 'sendPhoto' : 'sendMessage';
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const body = imageUrl
    ? { chat_id: chatId, photo: imageUrl, caption: text }
    : { chat_id: chatId, text };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_CALL_TIMEOUT_MS),
    });
  } catch (err) {
    // err.message from a fetch/AbortSignal failure never contains the
    // request URL itself (only DOMException-style reasons like "The
    // operation was aborted" / "fetch failed") — still never echo `url`
    // here regardless, only the bare method name.
    throw new TelegramPushError(`Network error calling Telegram ${method}: ${err.message}`);
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch {
      // ignore — body isn't required for the error to be useful
    }
    throw new TelegramPushError(
      `Telegram ${method} responded with HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      { status: response.status }
    );
  }

  return true;
}
