import { handleDebugTdx } from './tdx/debug.js';

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

    return new Response('Not Found', { status: 404 });
  },
};
