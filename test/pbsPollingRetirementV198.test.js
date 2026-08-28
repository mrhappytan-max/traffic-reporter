// V1.9.8 — order section 八/十 (items 14/15): "退休 Cloudflare 30 分鐘 PBS
// Polling". Targeted, minimal proof that PBS_30_MIN_POLLING_ENABLED=false
// (pbs/pbsConfig.js) makes the Cron tick NEVER perform the PBS HTTP fetch
// itself — even at a wall-clock minute pbsSchedule.js's own
// getPbsScheduleState() would otherwise call 'scheduled' — while every
// OTHER piece of the same Cron tick (TDX fetch/dedupe, health snapshot,
// Shared Feed, Pipeline Trace) keeps running completely unaffected. This
// is deliberately NOT a full day-long quantification sweep (that already
// exists, unrelated to this round, in
// test/kvWriteQuantificationV193.test.js) — just the specific, minimum
// proof this round's own order asks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { getPbsScheduleState } from '../src/traffic/pbsSchedule.js';
import { PBS_30_MIN_POLLING_ENABLED, resolvePbsPollingEnabled } from '../src/pbs/pbsConfig.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';

function countingKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

async function baseEnv() {
  const TRAFFIC_KV = countingKV({ [FREEWAY_METADATA_KEY]: JSON.stringify({ records: [], fetchedAt: new Date().toISOString() }) });
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return {
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    TRAFFIC_KV,
    CCTV_IMAGES: { async put() {}, async get() { return null; }, async delete() {} },
    TRAFFIC_SOURCE_MODE: 'PBS_ONLY', // matches real deployed Production config
    PBS_RELAY_TOKEN: 'relay-token',
  };
}

// A real Asia/Taipei 07:30 tick — 07:00-22:00 window, on-the-30-minute-mark
// — is exactly what pbsSchedule.js's own getPbsScheduleState() calls
// 'scheduled' (the OLD trigger for a real PBS fetch). This is deliberately
// chosen so the test proves the retirement flag wins over the schedule
// gate, not merely that PBS sits outside its old fetch window.
const SCHEDULED_TICK = new Date('2026-08-27T07:30:00+08:00');

test('V1.9.8 (14): PBS_30_MIN_POLLING_ENABLED is false — the retirement flag is set', () => {
  assert.equal(PBS_30_MIN_POLLING_ENABLED, false);
});

test('V1.9.8 (14): resolvePbsPollingEnabled(env) is false by default (no env override), and real Production wrangler.jsonc sets no such var', () => {
  assert.equal(resolvePbsPollingEnabled({}), false);
  assert.equal(resolvePbsPollingEnabled(undefined), false);
});

test('V1.9.8 (14): resolvePbsPollingEnabled(env) can be overridden — used ONLY by this repo\'s own pre-existing PBS/CCTV test suite, never by Production', () => {
  assert.equal(resolvePbsPollingEnabled({ PBS_30_MIN_POLLING_ENABLED: true }), true);
});

test('V1.9.8 (14): getPbsScheduleState() itself is UNCHANGED — still reports "scheduled" at this tick (rollback-readiness proof)', () => {
  assert.equal(getPbsScheduleState(SCHEDULED_TICK), 'scheduled');
});

test('V1.9.8 (14): at a would-have-been-"scheduled" tick, PBS is NEVER actually fetched — env.PBS_RELAY_WINDOWS.fetch is never called', async () => {
  const env = await baseEnv();
  let pbsFetchCalled = false;
  env.PBS_RELAY_WINDOWS = {
    fetch: async () => {
      pbsFetchCalled = true;
      throw new Error('PBS fetch must never be called — polling is retired (V1.9.8)');
    },
  };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const result = await runScheduledTdxSync(env, SCHEDULED_TICK);
    assert.equal(pbsFetchCalled, false, 'PBS fetch must never be attempted once polling is retired');
    // buildSkippedPbsSummary() shape — pbsOk:null (schedule-skip shape, not
    // a failure), 0 raw/active/cleared/stale counts, committed:false.
    assert.equal(result.pbs.pbsOk, null);
    assert.equal(result.pbs.committed, false);
    assert.equal(result.pbs.rawCount, 0);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('V1.9.8 (15): retiring PBS polling does not disturb the REST of the same Cron tick — health/LINE/Shared Feed/Pipeline Trace all still run', async () => {
  const env = await baseEnv(); // TRAFFIC_SOURCE_MODE=PBS_ONLY, matching real deployed Production — TDX itself is already off, independent of this round
  env.PBS_RELAY_WINDOWS = { fetch: async () => { throw new Error('PBS fetch must never be called'); } };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${s}`);
  };
  try {
    const tick = new Date('2026-08-27T08:00:00+08:00');
    const result = await runScheduledTdxSync(env, tick);
    // The tick must complete fully and return a full summary shape — same
    // "a source being off/skipped never takes down the Cron run" isolation
    // this project has always had, now also true for PBS's own retirement.
    assert.ok(result.line, 'expected the LINE broadcast step to still run');
    assert.ok(result.sharedFeed, 'expected the Shared Feed step to still run');
    assert.ok(result.pipelineTrace, 'expected the Pipeline Trace step to still run');
    assert.equal(result.pbs.pbsOk, null, 'PBS still reports its own honest schedule-skip shape, never a false success/failure');
  } finally {
    globalThis.fetch = priorFetch;
  }
});
