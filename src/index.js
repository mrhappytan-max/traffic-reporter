import { handleDebugTdx } from './tdx/debug.js';
import { handleDebugStatus } from './traffic/debugStatus.js';
import { runScheduledTdxSync } from './traffic/scheduled.js';
import { handleLineWebhook } from './line/webhook.js';
import { handleDebugPbs } from './pbs/debugPbs.js';
import { handlePbsVpcProbe } from './pbs/vpcProbe.js';
import { handleHealth } from './traffic/health.js';
import { requireAdminAuth, applyAdminSecurityHeaders } from './security/adminAuth.js';
import { handleCctvProbe } from './tdx/cctvProbe.js';
import { handleHsinchuCctvProbe, handleHsinchuCctvFrame, handleHsinchuCctvCollage, handleHsinchuCctvPublishTest } from './tdx/hsinchuCctvProbe.js';
import { handlePublicCctvImage } from './cctv/publishedImage.js';
import { handleBroadcastProvenance } from './traffic/broadcastProvenance.js';

// V1.6.3 — Admin Protection: every human-facing admin/debug page requires
// HTTP Basic Auth (see security/adminAuth.js). Centralized here on
// purpose ("不要每個 endpoint 複製驗證程式") — one Set of paths, one gate,
// checked strictly BEFORE route dispatch, so an unauthenticated request
// never reaches a handler at all: 0 KV reads, 0 TDX calls, 0 PBS calls.
// POST /webhook (LINE's own signature verification) and the Cron
// scheduled handler below are intentionally NOT in this set — neither is
// a human browsing this Worker, and Basic Auth would break both.
//
// V1.7: /admin/cctv-probe joins this same set — a one-time-use, Admin
// Auth-gated diagnostic endpoint (see tdx/cctvProbe.js). It does not
// touch the real Cron/broadcast pipeline at all.
//
// V1.7 (next stage): /admin/cctv-hsinchu-probe (its own separate
// one-time-use TDX call, see tdx/hsinchuCctvProbe.js) and its 4 fixed
// frame paths /admin/cctv-hsinchu-frame/0..3 (each reads only a cached
// KV candidate and fetches directly from freeway.gov.tw — 0 TDX calls,
// enforced by that module's own import graph). Exactly 4, one per
// quadrant (S前/S後/N前/N後) — the ratified four-quadrant selector caps
// at 4 candidates, never more; see hsinchuCctvProbe.js's CANDIDATE_COUNT
// and PROJECT_HANDOFF.md section 14.
//
// V1.8: /admin/cctv-hsinchu-collage composes those same (up to) 4
// frames into a single 2x2 collage JPEG — read-only against the
// candidates KV, 0 TDX calls, never triggers the probe above. See
// tdx/hsinchuCctvProbe.js's handleHsinchuCctvCollage and
// PROJECT_HANDOFF.md's V1.8 section.
//
// V1.8.4: /admin/cctv-hsinchu-publish-test composes that same collage
// and publishes it to KV under a short-lived opaque id (see
// cctv/publishedImage.js), still Admin-Auth-gated like every other path
// in this Set — it does NOT call LINE. The public GET /cctv/image/:id
// route it feeds is handled entirely separately below, deliberately
// OUTSIDE this Set/Admin Basic Auth: LINE's servers cannot carry our
// Authorization header, so that route's security is opaque-id entropy +
// short TTL, not auth — see cctv/publishedImage.js's module comment.
const HSINCHU_FRAME_PATHS = Array.from({ length: 4 }, (_, i) => `/admin/cctv-hsinchu-frame/${i}`);

// V1.8.6.4: /admin/broadcast-provenance (see traffic/broadcastProvenance.js)
// — Admin-Basic-Auth-gated GET, same as everything else in ADMIN_PATHS
// below, but ALSO the first endpoint in this project that must explicitly
// answer 405 for any other HTTP method (rather than just falling through
// to the generic 404 every other admin path currently would for a wrong
// method) — handled as its own small pre-check in fetch() below, ahead of
// the generic GET-only ADMIN_PATHS dispatch.
const BROADCAST_PROVENANCE_PATH = '/admin/broadcast-provenance';

const ADMIN_PATHS = new Set([
  '/health',
  '/debug/status',
  '/debug/tdx',
  '/debug/pbs',
  '/debug/pbs-vpc-probe',
  '/admin/cctv-probe',
  '/admin/cctv-hsinchu-probe',
  '/admin/cctv-hsinchu-collage',
  '/admin/cctv-hsinchu-publish-test',
  BROADCAST_PROVENANCE_PATH,
  ...HSINCHU_FRAME_PATHS,
]);

const PUBLIC_CCTV_IMAGE_PREFIX = '/cctv/image/';

function routeAdminGet(pathname, env, request) {
  if (pathname === '/debug/tdx') return handleDebugTdx(env);
  if (pathname === '/debug/status') return handleDebugStatus(env);
  if (pathname === '/debug/pbs') return handleDebugPbs(env);
  if (pathname === '/debug/pbs-vpc-probe') return handlePbsVpcProbe(env);
  if (pathname === '/health') return handleHealth(env);
  if (pathname === '/admin/cctv-probe') return handleCctvProbe(env);
  if (pathname === '/admin/cctv-hsinchu-probe') return handleHsinchuCctvProbe(env);
  if (pathname === '/admin/cctv-hsinchu-collage') return handleHsinchuCctvCollage(env);
  if (pathname === '/admin/cctv-hsinchu-publish-test') return handleHsinchuCctvPublishTest(env, request);
  if (pathname === BROADCAST_PROVENANCE_PATH) return handleBroadcastProvenance(env, request);
  const frameIndex = HSINCHU_FRAME_PATHS.indexOf(pathname);
  if (frameIndex !== -1) return handleHsinchuCctvFrame(env, frameIndex);
  return new Response('Not Found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      // Public by design — kept to the same minimal service/status body
      // it always had; no admin/debug information belongs here.
      return Response.json({
        service: 'traffic-reporter',
        status: 'ok',
        version: 'v1-bootstrap',
      });
    }

    // V1.8.6.4: this ONE admin path also answers 405 for any non-GET
    // method (auth-gated first, same as every other admin path — a wrong
    // method never bypasses Admin Auth to learn the route even exists).
    if (url.pathname === BROADCAST_PROVENANCE_PATH && request.method !== 'GET') {
      const denied = await requireAdminAuth(request, env);
      if (denied) return applyAdminSecurityHeaders(denied);
      return applyAdminSecurityHeaders(new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } }));
    }

    if (request.method === 'GET' && ADMIN_PATHS.has(url.pathname)) {
      const denied = await requireAdminAuth(request, env);
      if (denied) return applyAdminSecurityHeaders(denied);
      return applyAdminSecurityHeaders(await routeAdminGet(url.pathname, env, request));
    }

    // V1.8.4 — public, deliberately UNAUTHENTICATED image read path (see
    // cctv/publishedImage.js's module comment for why: LINE's servers
    // cannot carry our Admin Basic Auth). NOT in ADMIN_PATHS, NOT routed
    // through requireAdminAuth/applyAdminSecurityHeaders — this handler
    // sets its own minimal headers. Security is the opaque id's entropy
    // plus a short KV TTL, never auth or URL obscurity.
    if (request.method === 'GET' && url.pathname.startsWith(PUBLIC_CCTV_IMAGE_PREFIX)) {
      const id = url.pathname.slice(PUBLIC_CCTV_IMAGE_PREFIX.length);
      return handlePublicCctvImage(env, id);
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleLineWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  // Every 10 minutes (see wrangler.jsonc triggers.crons): PBS every tick,
  // TDX (國道+省道) gated to every 2nd tick, 08:00-22:00 Asia/Taipei only
  // — see src/traffic/tdxSchedule.js. Entirely unaffected by Admin Auth
  // above — this is never an HTTP request.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduledTdxSync(env).catch((err) => {
        console.error(`[cron] pipeline failed: ${err && err.message}`);
      })
    );
  },
};
