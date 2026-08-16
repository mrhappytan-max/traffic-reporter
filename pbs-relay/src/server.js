// Minimal HTTP wiring for the PBS Relay. Node built-ins only (node:http),
// no framework. createServer() is exported so tests can spin up
// ephemeral instances on random ports with an injected fetchImpl —
// actual listen()/env reading only happens when this file is run
// directly (`npm start` / `node src/server.js`), not when imported.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { createPbsCache } from './cache.js';
import { handlePbsRequest } from './pbsHandler.js';

function extractPbsPathToken(url) {
  const match = /^\/pbs\/([^/?#]+)$/.exec(url);
  return match ? match[1] : null;
}

export function createServer({ relayToken, fetchImpl = globalThis.fetch, cache = createPbsCache() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const pathToken = req.method === 'GET' ? extractPbsPathToken(req.url) : null;
      if (req.method === 'GET' && pathToken !== null) {
        const result = await handlePbsRequest({
          cache,
          relayToken,
          pathToken,
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

// Compares two plain OS paths (not raw URL/argv strings) so this is
// immune to two real footguns the old `import.meta.url === 'file://' +
// process.argv[1]` string comparison had:
//   1. process.argv[1] isn't guaranteed absolute (`npm start` runs
//      `node src/server.js` with a *relative* argv[1] on some npm/Node
//      version combinations) — path.resolve() against cwd fixes that.
//   2. import.meta.url is a URL-encoded string (spaces become %20 etc.)
//      while argv[1] is a plain path — fileURLToPath() decodes it back
//      to a real path so both sides compare like-for-like.
// A silent false here means server.listen() below never runs, which is
// exactly the kind of "process starts, logs look fine, nothing is
// actually listening for real traffic" failure mode worth hardening
// against on any hosting platform, even one with no confirmed repro.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
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
