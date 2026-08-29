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
import { handleSharedFeed } from './traffic/sharedFeedHandler.js';
import { handlePipelineTrace } from './traffic/pipelineTrace.js';
import { handlePipelineTraceView } from './traffic/pipelineTraceView.js';
import { handleDeploymentStatus, handleVersion } from './traffic/deploymentStatus.js';
import { handleDeploymentStatusView } from './traffic/deploymentStatusView.js';
import { handlePbsDebugPush, PBS_DEBUG_PUSH_PATH } from './pbs/debugPush.js';
import { handleAiObservatoryView } from './pbs/aiObservatoryView.js';

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

// V1.8.6.7: /admin/pipeline-trace (JSON) and /admin/pipeline-trace-view
// (human-readable HTML) — same GET-only-with-explicit-405 treatment as
// BROADCAST_PROVENANCE_PATH above, for the same reason: a wrong method
// must never look like "route doesn't exist" (404) once past Admin Auth.
const PIPELINE_TRACE_PATH = '/admin/pipeline-trace';
const PIPELINE_TRACE_VIEW_PATH = '/admin/pipeline-trace-view';

// V1.8.6.9: /admin/deployment-status (JSON) and
// /admin/deployment-status-view (HTML) — same GET-only-with-explicit-405
// treatment as the paths above, for the same reason. See
// traffic/deploymentStatus.js for what these actually report (build-time
// commit/branch identity, drift detection, route/binding/secret
// presence) — 0 TDX/PBS/CCTV/LINE/GitHub/Cloudflare API calls.
const DEPLOYMENT_STATUS_PATH = '/admin/deployment-status';
const DEPLOYMENT_STATUS_VIEW_PATH = '/admin/deployment-status-view';

// V2.0.1 — /admin/pbs-ai-observatory-view (human-readable HTML). Same
// GET-only-with-explicit-405 treatment as the paths above. See
// pbs/aiObservatoryView.js for what this reports (PBS original fields ->
// AI decision -> LINE/Shared-Feed outcome for Windows PBS events) — pure
// KV reads, ZERO calls to Workers AI, ZERO KV writes.
const AI_OBSERVATORY_VIEW_PATH = '/admin/pbs-ai-observatory-view';

const METHOD_RESTRICTED_ADMIN_PATHS = new Set([
  BROADCAST_PROVENANCE_PATH,
  PIPELINE_TRACE_PATH,
  PIPELINE_TRACE_VIEW_PATH,
  DEPLOYMENT_STATUS_PATH,
  DEPLOYMENT_STATUS_VIEW_PATH,
  AI_OBSERVATORY_VIEW_PATH,
]);

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
  PIPELINE_TRACE_PATH,
  PIPELINE_TRACE_VIEW_PATH,
  DEPLOYMENT_STATUS_PATH,
  DEPLOYMENT_STATUS_VIEW_PATH,
  AI_OBSERVATORY_VIEW_PATH,
  ...HSINCHU_FRAME_PATHS,
]);

const PUBLIC_CCTV_IMAGE_PREFIX = '/cctv/image/';

// V1.8.6.9 — GET /version: public, deliberately UNAUTHENTICATED (see
// traffic/deploymentStatus.js's own module comment and
// PRODUCT_DECISIONS.md's V1.8.6.9 section for why). NOT in ADMIN_PATHS,
// NOT routed through requireAdminAuth — an automated deploy verifier
// (scripts/verify-production-deploy.mjs) must be able to confirm
// "Production SHA == main SHA" without an Admin password. Deliberately
// minimal — see getPublicVersionInfo() for the exact 5-field shape;
// never bindings/secrets/routes/drift-reasons, those stay Admin-only.
const VERSION_PATH = '/version';

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
  if (pathname === PIPELINE_TRACE_PATH) return handlePipelineTrace(env, request);
  if (pathname === PIPELINE_TRACE_VIEW_PATH) return handlePipelineTraceView(env, request);
  if (pathname === DEPLOYMENT_STATUS_PATH) return handleDeploymentStatus(env);
  if (pathname === DEPLOYMENT_STATUS_VIEW_PATH) return handleDeploymentStatusView(env);
  if (pathname === AI_OBSERVATORY_VIEW_PATH) return handleAiObservatoryView(env, request);
  const frameIndex = HSINCHU_FRAME_PATHS.indexOf(pathname);
  if (frameIndex !== -1) return handleHsinchuCctvFrame(env, frameIndex);
  return new Response('Not Found', { status: 404 });
}

export default {
  // V2.1.0 — `ctx` is now accepted (previously unused/undropped) so
  // POST /internal/pbs-debug-push can hand its background AI/LINE work to
  // ctx.waitUntil() instead of making the Windows HTTP response wait for
  // it — see src/pbs/debugPush.js's own module comment for the full
  // lifecycle-separation design. No other route reads `ctx`.
  async fetch(request, env, ctx) {
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

    // V1.8.6.9 — GET /version, public, no Admin Auth. See VERSION_PATH's
    // own comment above. Checked as its own early GET-only match, same
    // convention as the root `/` route right above — non-GET falls
    // through to the generic 404 at the bottom, same as `/` does.
    if (url.pathname === VERSION_PATH && request.method === 'GET') {
      return handleVersion();
    }

    // V1.8.6.4 (extended V1.8.6.7): these admin paths also answer 405 for
    // any non-GET method (auth-gated first, same as every other admin
    // path — a wrong method never bypasses Admin Auth to learn the route
    // even exists).
    if (METHOD_RESTRICTED_ADMIN_PATHS.has(url.pathname) && request.method !== 'GET') {
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

    // V57 — Shared Traffic Feed. Deliberately NOT in ADMIN_PATHS: this is a
    // machine-to-machine route reached over a Cloudflare Service Binding, and
    // Admin Basic Auth is the wrong credential for that caller. It carries its
    // own bearer token (TRAFFIC_FEED_SECRET) instead, checked inside the
    // handler, which also returns 503 rather than opening up if that secret is
    // absent. Matched on pathname ALONE so a non-GET verb gets an honest 405
    // instead of a misleading 404 — the read-only contract has to be visible to
    // a caller that tries to write.
    if (url.pathname === '/internal/shared-feed') {
      return handleSharedFeed(request, env);
    }

    // V1.9.5/V1.9.8 — POST /internal/pbs-debug-push: Windows PBS Local
    // Monitor → Cloudflare. V1.9.5 built the channel (auth/validation/
    // idempotency); V1.9.8 upgraded this SAME endpoint in place into the
    // formal Windows PBS Production ingress — a genuinely accepted NEW/
    // UPDATED event now reaches the canonical Business Pipeline (LINE/
    // Shared Feed), reusing the exact same functions the (now-retired)
    // PBS polling path always used — see pbs/debugPush.js's own module
    // comment for the full picture. Path/route/auth/method handling are
    // UNCHANGED from V1.9.5. Same machine-to-machine shape as
    // /internal/shared-feed just above: its own bearer secret
    // (PBS_DEBUG_PUSH_SECRET), NOT Admin Basic Auth, NOT in ADMIN_PATHS.
    // Matched on pathname alone (method handling — 405 for non-POST —
    // lives inside the handler itself) for the same reason: the contract
    // has to be visible to a caller that uses the wrong verb, not hidden
    // behind a 404.
    if (url.pathname === PBS_DEBUG_PUSH_PATH) {
      return handlePbsDebugPush(request, env, undefined, ctx);
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
