export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return Response.json({
        service: 'traffic-reporter',
        status: 'ok',
        version: 'v1-bootstrap',
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
