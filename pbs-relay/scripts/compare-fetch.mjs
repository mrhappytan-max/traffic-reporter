#!/usr/bin/env node
// Minimal reproduction / A-vs-B comparison tool for diagnosing "direct
// fetch() to PBS works, but going through the Relay's upstreamClient
// doesn't" reports.
//
// Usage (from pbs-relay/):
//   node scripts/compare-fetch.mjs
//
// A: calls the Relay's actual fetchPbsUpstream() (src/upstreamClient.js)
//    — the exact code path GET /pbs uses.
// B: calls plain global fetch(url) with no options at all.
//
// Both print full, safe diagnostics (status, duration, content-type,
// body length, and — on failure — error name/code/cause). Nothing here
// ever touches RELAY_TOKEN; this only talks to the public PBS endpoint.

import { fetchPbsUpstream, DEFAULT_PBS_URL } from '../src/upstreamClient.js';

function printErr(label, err) {
  console.log(`${label} threw:`);
  console.log(`  name: ${err && err.name}`);
  console.log(`  message: ${err && err.message}`);
  console.log(`  code: ${err && err.code}`);
  if (err && err.cause) {
    console.log(`  cause.name: ${err.cause.name}`);
    console.log(`  cause.code: ${err.cause.code}`);
    console.log(`  cause.message: ${err.cause.message}`);
  }
  if (err && typeof err.status === 'number') console.log(`  status: ${err.status}`);
  if (err && err.code === 'timeout') console.log('  (classified as: timeout)');
  if (err && err.code === 'network') console.log('  (classified as: network — see cause above)');
}

async function runA() {
  console.log('=== A: fetchPbsUpstream() — the Relay\'s real code path ===');
  const t0 = Date.now();
  try {
    const result = await fetchPbsUpstream({ requestId: 'compare-A' });
    console.log(`OK — attempts=${result.attempts} durationMs=${result.durationMs}`);
    console.log(`contentType: ${result.contentType}`);
    console.log(`bodyLength: ${result.rawText.length}`);
    console.log(`bodyPreview: ${result.rawText.slice(0, 200)}`);
  } catch (err) {
    console.log(`FAILED after ${Date.now() - t0}ms (err.attempts=${err.attempts}, err.durationMs=${err.durationMs})`);
    printErr('A', err);
  }
}

async function runB() {
  console.log('\n=== B: plain fetch(url), zero options ===');
  const t0 = Date.now();
  try {
    const res = await fetch(DEFAULT_PBS_URL);
    const text = await res.text();
    console.log(`OK — status=${res.status} durationMs=${Date.now() - t0}`);
    console.log(`contentType: ${res.headers.get('content-type')}`);
    console.log(`bodyLength: ${text.length}`);
    console.log(`bodyPreview: ${text.slice(0, 200)}`);
  } catch (err) {
    console.log(`FAILED after ${Date.now() - t0}ms`);
    printErr('B', err);
  }
}

async function main() {
  console.log(`Target: ${DEFAULT_PBS_URL}`);
  console.log(`Node: ${process.version}  Platform: ${process.platform}\n`);
  await runA();
  await runB();
  console.log('\n=== done — compare the two blocks above ===');
  console.log('If A fails and B succeeds, the [PBS] log lines A printed above (from src/log.js) name the exact classification (timeout/network/http) and, for network errors, the real cause.code — that is the root cause.');
}

main();
