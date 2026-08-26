// V1.6.3 — Admin Protection. HTTP Basic Auth gate for the human-facing
// admin/debug endpoints (GET /health, /debug/status, /debug/tdx,
// /debug/pbs, /debug/pbs-vpc-probe — see index.js's ADMIN_PATHS).
// Deliberately NOT used for POST /webhook (LINE's own X-Line-Signature
// verification — see line/verifySignature.js) or the Cron scheduled
// handler: neither is a human browsing this Worker, and Basic Auth would
// break both.
//
// Final V1.6.3 shape: the username is a fixed constant ("admin") — no
// first-run setup page, no per-account username, no Cookie session, no
// password ever stored in KV. The ONLY Cloudflare Secret is
// env.ADMIN_PASSWORD (`wrangler secret put`, never wrangler.jsonc, never
// committed). If it's missing, requireAdminAuth fails closed with 503 —
// a missing Secret must never silently turn an admin page public.
//
// Minimal by design: HTTP Basic Auth only, no login page, no cookies, no
// JWT, no query-string token fallback (query strings end up in access
// logs/browser history — never accepted as a credential channel here).
// Browsers cache Basic Auth credentials per-origin for the session, so
// entering it once on /health carries over to /debug/status, /debug/pbs,
// etc. automatically — no extra state needed on our side.
//
// Callers MUST invoke this BEFORE calling any handler that touches
// KV/TDX/PBS — see index.js, where the auth check happens strictly
// before route dispatch, so an unauthenticated request never reaches a
// handler at all (0 KV reads, 0 TDX calls, 0 PBS calls, by construction).

const REALM = 'Traffic Reporter Admin';
const ADMIN_USERNAME = 'admin'; // fixed by design — see module comment

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bufferToHex(digest);
}

/**
 * Constant-time byte comparison — no early return on a per-character
 * mismatch (that's exactly the "obviously timing-leaking" comparison
 * this must avoid). Both inputs are always SHA-256 hex digests here (see
 * credentialMatches below), so they're always the same fixed length
 * (64 hex chars) regardless of the ORIGINAL credential's length — the
 * length check below is therefore never reached for real digests, and
 * the actual username/password length is never observable via timing
 * either.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Hash both sides before comparing so neither the supplied nor the
 * expected credential's raw length or content ever participates in the
 * comparison directly. */
async function credentialMatches(candidate, expected) {
  const [candidateHash, expectedHash] = await Promise.all([sha256Hex(candidate), sha256Hex(expected)]);
  return timingSafeEqual(candidateHash, expectedHash);
}

/** Decodes an `Authorization: Basic base64(username:password)` header.
 * Returns null for anything malformed — never throws. */
function parseBasicAuthHeader(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;
  const encoded = headerValue.slice('Basic '.length).trim();
  if (!encoded) return null;

  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return null; // not valid base64
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return null;

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

/** Body kept deliberately generic — never reveals whether the username
 * existed, whether only the password was wrong, etc. */
function unauthorizedResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
    },
  });
}

function misconfiguredResponse() {
  return new Response('Admin authentication is not configured', { status: 503 });
}

/**
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response|null>} a Response to return immediately
 *   (401 or 503) when access must be denied, or null when the request is
 *   authorized and the caller should proceed to its handler. Never
 *   throws. Never logs, echoes, or otherwise surfaces ADMIN_PASSWORD or
 *   the request's supplied credentials anywhere.
 */
export async function requireAdminAuth(request, env) {
  const expectedPassword = env.ADMIN_PASSWORD;

  // Fail closed — a missing Secret must never make this endpoint public.
  if (!expectedPassword) {
    return misconfiguredResponse();
  }

  const credentials = parseBasicAuthHeader(request.headers.get('Authorization'));
  if (!credentials) return unauthorizedResponse();

  // Evaluate BOTH comparisons unconditionally (no `&&` short-circuit)
  // before deciding — a correct username with a wrong password must take
  // the same code path/time as a wrong username, never revealing "which
  // half" was correct via response content OR control flow. The username
  // is a fixed public constant (not a secret), but it's still compared
  // via the same constant-time path for consistency/simplicity.
  const [usernameOk, passwordOk] = await Promise.all([
    credentialMatches(credentials.username, ADMIN_USERNAME),
    credentialMatches(credentials.password, expectedPassword),
  ]);

  if (!usernameOk || !passwordOk) return unauthorizedResponse();

  return null; // authorized
}

/**
 * Applies the required security headers (see index.js's ADMIN_PATHS
 * wiring) to every protected admin/debug response — success, 401, AND
 * 503 alike. A GET-only, no-store, non-indexable, non-embeddable
 * response class throughout. HTML responses (GET /health and, as of
 * V1.7, GET /admin/cctv-hsinchu-probe) additionally get a strict CSP —
 * this project ships no external JS/CSS on any admin page, so
 * `default-src 'none'` never breaks anything.
 *
 * V1.7 hotfix: `img-src 'self'` added. The Hsinchu CCTV probe page
 * embeds <img> tags pointing at its own SAME-ORIGIN frame endpoints
 * (/admin/cctv-hsinchu-frame/0..4) — those were being blocked by the
 * previous `default-src 'none'` with no img-src override. Deliberately
 * `'self'` only, never `*` and never the freeway.gov.tw hostname
 * directly: the browser must only ever load a CCTV image through this
 * Worker's own frame endpoint (which fetches it server-side with its
 * own hostname/size/timeout checks — see tdx/hsinchuCctvProbe.js),
 * never as a direct cross-origin image load straight from
 * freeway.gov.tw.
 *
 * Rebuilds the Response (rather than mutating `response.headers` in
 * place) so this is safe regardless of how the original Response was
 * constructed.
 *
 * V1.9.1 CORRECTION — `form-action 'none'` (real Production bug, root
 * cause confirmed with a real browser, not inferred from the CSP spec):
 * pipelineTraceView.js's filter <form method="get"> looked completely
 * broken to a real human on a real phone — selecting a source/road and
 * tapping 篩選 never changed the results. A prior investigation
 * (V1.8.7.6) traced the ENTIRE server-side path (form markup, query
 * string, listPipelineTrace's predicates, pagination, at both small and
 * realistic KV scale) and found every layer correct, concluding the
 * remaining leading hypothesis was client-side staleness — but its own
 * headless-browser reproduction was "not itself part of this repo's own
 * CI-run test suite" and evidently never drove a REAL HTTP response
 * carrying this header. Reproduced here directly: a real Chromium
 * instance (Playwright) loading the actual handlePipelineTraceView
 * response through applyAdminSecurityHeaders, then physically clicking
 * the rendered submit button, never navigates — the browser's own
 * console reports exactly why:
 *   "Refused to send form data to '...' because it violates the
 *    following Content Security Policy directive: form-action 'none'."
 * Stripping only this one directive (all else identical) makes the same
 * click navigate correctly to the filtered URL. So the server-side
 * filtering logic was never broken; this ONE directive silently blocked
 * every admin page's <form> from ever submitting, on every browser that
 * enforces CSP form-action (which is all current major engines).
 *
 * Fixed to `form-action 'self'`: a same-origin GET/POST form (exactly
 * what this project's one <form> — and any future one — legitimately
 * needs) may still submit; an attacker still cannot redirect this page's
 * form data to an external origin, which is the actual protection
 * form-action exists to provide. This is the ONLY directive changed;
 * default-src/style-src/img-src/base-uri/frame-ancestors are untouched.
 */
export function applyAdminSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, private');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');

  if ((headers.get('Content-Type') || '').includes('text/html')) {
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
