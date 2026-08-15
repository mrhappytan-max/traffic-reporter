import { handleDebugTdx } from './tdx/debug.js';
import { handleDebugStatus } from './traffic/debugStatus.js';
import { runScheduledTdxSync } from './traffic/scheduled.js';
import { handleLineWebhook } from './line/webhook.js';

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
