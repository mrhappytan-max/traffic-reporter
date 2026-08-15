// LINE webhook signature verification per LINE's official spec:
// base64(HMAC-SHA256(channelSecret, rawRequestBody)) must equal the
// X-Line-Signature header. Uses Web Crypto (available in the Workers
// runtime) — never Node's `crypto` module.

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Constant-time-ish string compare — length is not itself sensitive here
 * (HMAC-SHA256 base64 output is always the same length), only content is. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * @param {string} rawBody - the exact, unparsed request body text
 * @param {string|null} signatureHeader - the X-Line-Signature header value
 * @param {string|undefined} channelSecret - env.LINE_CHANNEL_SECRET
 */
export async function verifyLineSignature(rawBody, signatureHeader, channelSecret) {
  if (!signatureHeader || !channelSecret) return false;

  let key;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(channelSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    return false;
  }

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = bufferToBase64(mac);

  return timingSafeEqual(computed, signatureHeader);
}
