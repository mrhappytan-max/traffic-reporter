import { handleDebugTdx } from './tdx/debug.js';
import { handleDebugStatus } from './traffic/debugStatus.js';
import { runScheduledTdxSync } from './traffic/scheduled.js';
import { handleLineWebhook } from './line/webhook.js';
import { handleDebugPbs } from './pbs/debugPbs.js';
import { handleSharedFeed } from './traffic/sharedFeedHandler.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return Response.json({
        service: 'traffic-reporter',
        status: 'ok',
        version: 'v1-bootstrap',
      });
    }

    if (url.pathname === '/debug/tdx' && request.method === 'GET') {
      return handleDebugTdx(env);
    }

    if (url.pathname === '/debug/status' && request.method === 'GET') {
      return handleDebugStatus(env);
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleLineWebhook(request, env);
    }

    if (url.pathname === '/debug/pbs' && request.method === 'GET') {
      return handleDebugPbs(env);
    }

    // V57 Shared Traffic Feed. Matched on pathname ALONE, before the 404,
    // so a non-GET verb gets an honest 405 from the handler instead of a
    // misleading "Not Found" — the read-only contract has to be visible to
    // a caller that tries to write.
    if (url.pathname === '/internal/shared-feed') {
      return handleSharedFeed(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  // Every 5 minutes (see wrangler.jsonc triggers.crons): fetch TDX ->
  // Hsinchu geo-filter -> KV dedup/baseline -> (08:00-22:00 only) LINE
  // push to enabled users/groups.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduledTdxSync(env).catch((err) => {
        console.error(`[cron] pipeline failed: ${err && err.message}`);
      })
    );
  },
};
