// Minimal HTTP wiring for the PBS Relay. Node built-ins only (node:http),
// no framework. createServer() is exported so tests can spin up
// ephemeral instances on random ports with an injected fetchImpl —
// actual listen()/env reading only happens when this file is run
// directly (`npm start` / `node src/server.js`), not when imported.

import http from 'node:http';
import { createPbsCache } from './cache.js';
import { handlePbsRequest } from './pbsHandler.js';

export function createServer({ relayToken, fetchImpl = globalThis.fetch, cache = createPbsCache() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET' && req.url === '/pbs') {
        const result = await handlePbsRequest({
          cache,
          relayToken,
          authorizationHeader: req.headers['authorization'],
          fetchImpl,
        });
        res.writeHead(result.status, result.headers);
        res.end(result.body);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (err) {
      // Never let an unexpected error leak internals (or a Secret) into
      // the response — a bare 500 only.
      console.error(`[pbs-relay] unhandled error: ${err && err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const PORT = process.env.PORT || 3000;
  const RELAY_TOKEN = process.env.RELAY_TOKEN;

  if (!RELAY_TOKEN) {
    // Never log the token itself — just the fact that it's missing.
    console.warn('[pbs-relay] warning: RELAY_TOKEN is not set — GET /pbs will reject all requests (fail closed)');
  }

  const server = createServer({ relayToken: RELAY_TOKEN });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[pbs-relay] listening on 0.0.0.0:${PORT}`);
  });
}
