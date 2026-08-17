import { handleDebugTdx } from './tdx/debug.js';
import { handleDebugStatus } from './traffic/debugStatus.js';
import { runScheduledTdxSync } from './traffic/scheduled.js';
import { handleLineWebhook } from './line/webhook.js';
import { handleDebugPbs } from './pbs/debugPbs.js';
import { handlePbsVpcProbe } from './pbs/vpcProbe.js';
import { handleHealth } from './traffic/health.js';
import { requireAdminAuth, applyAdminSecurityHeaders } from './security/adminAuth.js';
import { handleCctvProbe } from './tdx/cctvProbe.js';
import { handleHsinchuCctvProbe, handleHsinchuCctvFrame } from './tdx/hsinchuCctvProbe.js';

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
const HSINCHU_FRAME_PATHS = Array.from({ length: 4 }, (_, i) => `/admin/cctv-hsinchu-frame/${i}`);
const ADMIN_PATHS = new Set([
  '/health',
  '/debug/status',
  '/debug/tdx',
  '/debug/pbs',
  '/debug/pbs-vpc-probe',
  '/admin/cctv-probe',
  '/admin/cctv-hsinchu-probe',
  ...HSINCHU_FRAME_PATHS,
]);

function routeAdminGet(pathname, env) {
  if (pathname === '/debug/tdx') return handleDebugTdx(env);
  if (pathname === '/debug/status') return handleDebugStatus(env);
  if (pathname === '/debug/pbs') return handleDebugPbs(env);
  if (pathname === '/debug/pbs-vpc-probe') return handlePbsVpcProbe(env);
  if (pathname === '/health') return handleHealth(env);
  if (pathname === '/admin/cctv-probe') return handleCctvProbe(env);
  if (pathname === '/admin/cctv-hsinchu-probe') return handleHsinchuCctvProbe(env);
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

    if (request.method === 'GET' && ADMIN_PATHS.has(url.pathname)) {
      const denied = await requireAdminAuth(request, env);
      if (denied) return applyAdminSecurityHeaders(denied);
      return applyAdminSecurityHeaders(await routeAdminGet(url.pathname, env));
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
