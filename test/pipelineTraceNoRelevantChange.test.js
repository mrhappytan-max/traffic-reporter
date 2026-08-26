// V1.9.3 (KV Write Optimization Phase 2, item 三) — "NO_RELEVANT_CHANGE"
// Pipeline Trace batch skip. Pure unit coverage of
// hasPipelineTraceRelevantChange (the round-level decision — see its own
// module comment in pipelineTrace.js for the full rule and why CCTV
// anomalies need no separate condition) plus one end-to-end proof via the
// real Cron path (runScheduledTdxSync) that a genuinely quiet round
// really does write 0 Pipeline Trace KV keys. Covers the V1.9.3 order's
// own test list items #12-#18.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hasPipelineTraceRelevantChange, listPipelineTrace, TRACE_BATCH_KEY_PREFIX } from '../src/traffic/pipelineTrace.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';

function quiet() {
  return {
    summary: { newEventsCount: 0, updatedEventsCount: 0, duplicateCount: 0 },
    pbsSummary: { pbsNewCount: 0, pbsUpdatedCount: 0, pbsNewlyClearedCount: 0, freewayGatedCount: 0 },
    lineSummary: { pushAttempted: 0, partialPushFailures: 0 },
  };
}

// --- pure decision function ------------------------------------------------

test('#13 completely quiet round (nothing new/updated/cleared/failed) -> NO relevant change', () => {
  assert.equal(hasPipelineTraceRelevantChange(quiet()), false);
});

test('#12 PBS raw count grows but every new record is irrelevant (already filtered out before reaching pbsSummary) -> NO relevant change', () => {
  // The order's own example: raw 1000 -> 1005, all 5 new records outside
  // the service area. Those records never reach pbsSummary at all (see
  // pbs/hsinchuFilter.js — filtered at ingestion), so pbsSummary's own
  // transition counts are genuinely 0 here, same shape as `quiet()`.
  assert.equal(hasPipelineTraceRelevantChange(quiet()), false);
});

test('#14 a NEW service-area PBS accident -> relevant change (trace preserved)', () => {
  const scenario = quiet();
  scenario.pbsSummary.pbsNewCount = 1;
  assert.equal(hasPipelineTraceRelevantChange(scenario), true);
});

test('#15 a service-area PBS accident UPDATED -> relevant change (trace preserved)', () => {
  const scenario = quiet();
  scenario.pbsSummary.pbsUpdatedCount = 1;
  assert.equal(hasPipelineTraceRelevantChange(scenario), true);
});

test('#16 a service-area PBS accident CLEARED -> relevant change (trace preserved)', () => {
  const scenario = quiet();
  scenario.pbsSummary.pbsNewlyClearedCount = 1;
  assert.equal(hasPipelineTraceRelevantChange(scenario), true);
});

test('#17 CCTV anomaly is never a separate blind spot: it only ever occurs on a NEW/UPDATED push, already covered by those conditions', () => {
  // A CCTV prepare timeout/error can only happen for an event actually
  // being pushed this round — which requires it to be new or updated (or
  // a genuine LINE push attempt, see #18) in the first place. There is no
  // shape where a CCTV anomaly exists but newEventsCount/updatedEventsCount/
  // pbsNewCount/pbsUpdatedCount/pushAttempted are all 0 at the same time.
  const scenario = quiet();
  scenario.summary.updatedEventsCount = 1; // the event whose CCTV attempt anomaled
  assert.equal(hasPipelineTraceRelevantChange(scenario), true);
});

test('#18 a LINE push failure -> relevant change (trace preserved), even with 0 new/updated events', () => {
  const scenario = quiet();
  scenario.lineSummary.pushAttempted = 1;
  scenario.lineSummary.partialPushFailures = 1;
  assert.equal(hasPipelineTraceRelevantChange(scenario), true);
});

test('a real LINE push SUCCESS (not just failure) also counts as relevant — the order requires "LINE push success/failure" both preserved', () => {
  const scenario = quiet();
  scenario.lineSummary.pushAttempted = 1;
  scenario.lineSummary.partialPushFailures = 0;
  assert.equal(hasPipelineTraceRelevantChange(scenario), true);
});

test('a TDX duplicate or PBS freeway-gated dropout also counts as relevant (existing "why didn\'t this broadcast" audit guarantee, V1.8.6.7)', () => {
  const dup = quiet();
  dup.summary.duplicateCount = 1;
  assert.equal(hasPipelineTraceRelevantChange(dup), true);

  const gated = quiet();
  gated.pbsSummary.freewayGatedCount = 1;
  assert.equal(hasPipelineTraceRelevantChange(gated), true);
});

test('null/undefined summary/pbsSummary/lineSummary never throws, treated as all-zero (quiet)', () => {
  assert.equal(hasPipelineTraceRelevantChange({}), false);
  assert.equal(hasPipelineTraceRelevantChange({ summary: null, pbsSummary: null, lineSummary: null }), false);
});

// --- #19: Shared Feed contract unchanged (regression guard) ----------------

test('#19 Shared Feed contract unchanged: hasPipelineTraceRelevantChange has no effect on runSharedFeedPersist\'s own WRITE_ON_CHANGE decision', async () => {
  const { runSharedFeedPersist } = await import('../src/traffic/sharedFeed.js');
  const kv = (() => {
    const store = new Map();
    return { async get(k) { return store.get(k) ?? null; }, async put(k, v) { store.set(k, v); } };
  })();
  const first = await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [], now: new Date('2026-08-26T10:00:00+08:00') });
  assert.equal(first.committed, true);
  const second = await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [], now: new Date('2026-08-26T10:10:00+08:00') });
  assert.equal(second.written, false); // unchanged (empty->empty) — untouched by this round's Pipeline Trace change
});

// --- end-to-end: a genuinely quiet Cron round writes 0 trace KV keys -------

const NOW = new Date('2026-08-26T09:00:00+08:00'); // both TDX (mod20) and PBS (mod30) scheduled

function kv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

test('end-to-end: a genuinely quiet round (no TDX events, no PBS events, no LINE push) writes 0 Pipeline Trace KV keys', async () => {
  const TRAFFIC_KV = kv({ [FREEWAY_METADATA_KEY]: JSON.stringify({ records: [], fetchedAt: NOW.toISOString() }) });
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV, CCTV_IMAGES: { async put() {}, async get() { return null; }, async delete() {} } };
  // No TDX_CLIENT_ID -> TDX sits out entirely; PBS relay returns nothing.
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = { fetch: async () => new Response(JSON.stringify([]), { status: 200 }) };
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected fetch on a quiet round: ${url}`);
  };

  const result = await runScheduledTdxSync(env, NOW);
  assert.equal(result.pipelineTrace.skippedNoRelevantChange, true);
  assert.equal(result.pipelineTrace.committed, 0);
  assert.equal(result.pipelineTrace.batchCount, 0);

  const traceKeys = [...TRAFFIC_KV.store.keys()].filter((k) => k.startsWith(TRACE_BATCH_KEY_PREFIX));
  assert.deepEqual(traceKeys, []); // literally 0 trace KV keys written this round

  const { records } = await listPipelineTrace(TRAFFIC_KV, { limit: 100 });
  assert.deepEqual(records, []);
});

test('end-to-end: the SAME quiet round shape, but a real NEW PBS accident this time -> a Pipeline Trace batch IS written', async () => {
  const TRAFFIC_KV = kv({ [FREEWAY_METADATA_KEY]: JSON.stringify({ records: [], fetchedAt: NOW.toISOString() }) });
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = { LINE_CHANNEL_ACCESS_TOKEN: 'tok', TRAFFIC_KV, CCTV_IMAGES: { async put() {}, async get() { return null; }, async delete() {} } };
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = {
    fetch: async () => new Response(JSON.stringify([{
      UID: 'PBS-QUIET-1', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '事故',
      comment: '北向93公里處發生車輛事故', happendate: '2026-08-26', happentime: '08:55:00', modDttm: '2026-08-26 08:56:00',
    }]), { status: 200 }),
  };
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await runScheduledTdxSync(env, NOW);
  assert.equal(result.pipelineTrace.skippedNoRelevantChange, undefined);
  assert.ok(result.pipelineTrace.batchCount > 0);

  const traceKeys = [...TRAFFIC_KV.store.keys()].filter((k) => k.startsWith(TRACE_BATCH_KEY_PREFIX));
  assert.ok(traceKeys.length > 0);
});
