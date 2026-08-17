#!/usr/bin/env node
// V1.8 — automates the genuine workerd/wrangler-compatible check for
// src/cctv/jpegCodecWorker.js: starts a real `wrangler dev --local`
// instance against test/wranglerSmoke/collageWasmSmoke.js (a minimal
// standalone Worker entry, never part of the deployed traffic-reporter
// Worker), hits it once, asserts the JSON result proves a real
// encode/decode round-trip through the actual Cloudflare Workers WASM
// mechanism, then shuts the dev server down.
//
// This is intentionally separate from `npm test` (which runs under
// plain `node --test` and cannot load a `.wasm` ES module at all — see
// jpegCodecWorker.js's module comment) — a real Workers runtime takes
// real seconds to boot, so keeping it out of the fast, always-on `npm
// test` loop is deliberate. Run manually or in CI as a dedicated step:
//   npm run smoke:wasm
//
// Never touches TDX, KV candidates, or any real network endpoint —
// collageWasmSmoke.js only exercises the codec with an in-memory
// synthetic image, so this is safe to run anywhere `wrangler dev
// --local` itself works (no Cloudflare credentials or account required
// for local-only workerd execution).

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 18799;
const ENTRY = 'scripts/wranglerSmoke/collageWasmSmoke.js';
const MAX_WAIT_MS = 20000;
const POLL_INTERVAL_MS = 500;

function log(...args) {
  console.log('[smoke:wasm]', ...args);
}

async function pollUntilReady(url, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res;
    } catch {
      await delay(POLL_INTERVAL_MS);
    }
  }
  return null;
}

async function main() {
  log(`starting: npx wrangler dev ${ENTRY} --local --port ${PORT}`);
  // detached + killing the whole process group: `wrangler dev` spawns
  // nested child processes (the actual workerd binary among them) that
  // don't reliably die from a plain SIGTERM to the `npx` wrapper alone,
  // which otherwise leaves this script hanging well past a successful
  // result.
  const child = spawn('npx', ['wrangler', 'dev', ENTRY, '--local', '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const shutdown = () => {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = whole process group
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
    }
  };

  try {
    const res = await pollUntilReady(`http://127.0.0.1:${PORT}/`, MAX_WAIT_MS);
    if (!res) {
      log('FAIL: wrangler dev never became ready within', MAX_WAIT_MS, 'ms');
      log('--- captured output ---');
      console.log(output);
      process.exitCode = 1;
      return;
    }

    const body = await res.json();
    log('response:', JSON.stringify(body));

    if (res.status !== 200 || !body.ok) {
      log('FAIL: the real Workers runtime could not load/exercise the WASM JPEG codec.');
      log('This means src/cctv/jpegCodecWorker.js is NOT deployable — do not ship this branch.');
      process.exitCode = 1;
      return;
    }

    log('PASS: real workerd runtime loaded the .wasm static import and round-tripped a JPEG encode/decode successfully.');
  } finally {
    shutdown();
    await delay(200);
  }
}

main()
  .catch((err) => {
    console.error('[smoke:wasm] unexpected error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Hard guarantee: some lingering handle from the killed child's
    // pipes has occasionally kept the event loop alive past a
    // successful/failed result — force the exit once we're done.
    process.exit(process.exitCode ?? 0);
  });
