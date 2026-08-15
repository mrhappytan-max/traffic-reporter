// TDX OAuth2 (client_credentials) token acquisition.
//
// Reads TDX_CLIENT_ID / TDX_CLIENT_SECRET from the Worker's runtime
// environment (Cloudflare Secrets, configured outside this repo). The
// values are only ever placed into the outgoing token-request body — they
// are never logged, thrown, or returned in any response.
//
// A token is kept in a module-scope variable for reuse within the same
// Worker isolate. This is NOT a persistence layer (no KV/D1, nothing
// survives a cold start) — it just avoids re-authenticating on every single
// request while the isolate is warm.

const TDX_AUTH_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

// Refresh this many ms before actual expiry to avoid edge-of-expiry races.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

export class TdxAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TdxAuthError';
  }
}

let tokenCache = null; // { accessToken, expiresAt }

/** Test-only: clear the in-memory token cache between test cases. */
export function resetTdxTokenCache() {
  tokenCache = null;
}

export async function getAccessToken(env) {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + EXPIRY_SAFETY_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  const clientId = env.TDX_CLIENT_ID;
  const clientSecret = env.TDX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new TdxAuthError(
      'Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET in the Worker environment'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  let response;
  try {
    response = await fetch(TDX_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new TdxAuthError(`Network error while requesting TDX token: ${err.message}`);
  }

  if (!response.ok) {
    // Deliberately status-code only: the response body from the auth
    // server is not included in case it ever echoes request parameters.
    throw new TdxAuthError(`TDX token request failed with HTTP ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new TdxAuthError(`Failed to parse TDX token response: ${err.message}`);
  }

  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new TdxAuthError('TDX token response did not include access_token');
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 3_600_000),
  };

  return tokenCache.accessToken;
}
