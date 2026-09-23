// Minimal HTTP wiring for the PBS Relay. Node built-ins only (node:http),
// no framework. createServer() is exported so tests can spin up
// ephemeral instances on random ports with an injected fetchImpl —
// actual listen()/env reading only happens when this file is run
// directly (`npm start` / `node src/server.js`), not when imported.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { createPbsCache } from './cache.js';
import { handlePbsRequest } from './pbsHandler.js';
import {
  createHealthCheckLogger, logServerStart, logSignal, logUncaughtException, logUnhandledRejection,
} from './serverRuntime.js';

function extractPbsPathToken(url) {
  const match = /^\/pbs\/([^/?#]+)$/.exec(url);
  return match ? match[1] : null;
}

// 路況-080: logDirectory is opt-in and defaults to null (logging
// disabled). Existing callers — including every test in
// tests/server.test.js — never pass it, so createServer()'s behavior,
// responses and console output are byte-for-byte unchanged for them.
// Only the production bootstrap below (the isMainModule block) passes a
// real directory. The health-check logger instance lives in this
// closure, one per createServer() call, so concurrent/ephemeral test
// servers never share throttling state.
export function createServer({
  relayToken, fetchImpl = globalThis.fetch, cache = createPbsCache(), logDirectory = null,
} = {}) {
  const logHealthCheck = logDirectory ? createHealthCheckLogger(logDirectory) : null;
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        logHealthCheck?.('ok');
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
  // 路況-080: pbs-relay/logs/relay/ — separate from LocalMonitor's
  // pbs-relay/logs/*.jsonl. Only ever computed/used inside this
  // isMainModule block, so importing server.js (every test does) never
  // touches the filesystem for this.
  const LOG_DIRECTORY = process.env.PBS_RELAY_LOG_DIRECTORY
    || resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'relay');

  if (!RELAY_TOKEN) {
    // Never log the token itself — just the fact that it's missing.
    console.warn('[pbs-relay] warning: RELAY_TOKEN is not set — GET /pbs will reject all requests (fail closed)');
  }

  const server = createServer({ relayToken: RELAY_TOKEN, logDirectory: LOG_DIRECTORY });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[pbs-relay] listening on 0.0.0.0:${PORT}`);
    logServerStart(LOG_DIRECTORY, { port: PORT });
  });

  // 路況-080: these are new listeners — none existed before. Registering
  // them here (only reached when this file is run directly, never on
  // import) changes nothing about how server.js already ran: with no
  // listener, Node's own default action for each of these is to print
  // the error/reason to stderr and terminate the process (uncaught
  // exception / unhandled rejection), or to terminate immediately on the
  // signal (SIGTERM/SIGINT). Each handler below reproduces that same
  // outcome — it still logs to console and the process still exits —
  // the only addition is that the event is also durably recorded to
  // disk first, which is the entire point of 路況-080.
  process.on('uncaughtException', (error) => {
    logUncaughtException(LOG_DIRECTORY, error);
    console.error('[pbs-relay] uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logUnhandledRejection(LOG_DIRECTORY, reason);
    console.error('[pbs-relay] unhandled rejection:', reason);
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    logSignal(LOG_DIRECTORY, 'SIGTERM');
    process.exit(143); // 128 + SIGTERM(15), matching the default OS action's exit status
  });
  process.on('SIGINT', () => {
    logSignal(LOG_DIRECTORY, 'SIGINT');
    process.exit(130); // 128 + SIGINT(2), matching the default OS action's exit status
  });
}
