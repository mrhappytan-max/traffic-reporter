import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runPbsPipelinePreview, runPbsPipelineAndCommit } from '../src/pbs/pipeline.js';
import { readPbsLifecycleState } from '../src/pbs/lifecycle.js';

function createMockKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    store,
  };
}

// The real, confirmed 台68 fixture from this round's task.
const REAL_PBS_FIXTURE = {
  UID: 'PBS-2026-08150001',
  road: '',
  direction: '西行',
  areaNm: '(南寮竹東)-台68線',
  roadtype: '事故',
  comment: '西行在8.1公里處內側車道發生交通事故，請小心慢行',
  happendate: '2026-08-15',
  happentime: '22:14:00',
  modDttm: '2026-08-15 22:20:00',
  x1: '120.9987',
  y1: '24.7912',
  srcdetail: '民眾報案',
};

let originalFetch;

function mockPbsFetch(items, status = 200) {
  return async () => new Response(status === 200 ? JSON.stringify(items) : 'error', { status });
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('real fixture: 台68 accident is judged new/active end-to-end through the full pipeline', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockPbsFetch([REAL_PBS_FIXTURE]);

  const now = new Date('2026-08-15T22:25:00+08:00');
  const result = await runPbsPipelineAndCommit(env, { tdxEvents: [], now });

  assert.equal(result.pbsOk, true);
  assert.equal(result.rawCount, 1);
  assert.equal(result.hsinchuCount, 1);
  assert.equal(result.activeCount, 1);
  assert.equal(result.clearedCount, 0);
  assert.equal(result.staleCount, 0);

  const state = await readPbsLifecycleState(kv);
  assert.equal(state.pbsMap['PBS-2026-08150001'].lifecycle, 'active');
});

test('the same event clearing next round (comment says 排除) drops out of active/pushable entirely', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;

  const t0 = new Date('2026-08-15T22:25:00+08:00');
  globalThis.fetch = mockPbsFetch([REAL_PBS_FIXTURE]);
  const first = await runPbsPipelineAndCommit(env, { tdxEvents: [], now: t0 });
  assert.equal(first.activeCount, 1);

  const t1 = new Date('2026-08-15T23:00:00+08:00');
  globalThis.fetch = mockPbsFetch([{ ...REAL_PBS_FIXTURE, comment: '西行8.1公里事故，北控:排除', modDttm: '2026-08-15 23:00:00' }]);
  const second = await runPbsPipelineAndCommit(env, { tdxEvents: [], now: t1 });

  assert.equal(second.activeCount, 0);
  assert.equal(second.clearedCount, 1);
});

test('source health: a PBS fetch failure never wipes existing lifecycle state', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;

  const t0 = new Date('2026-08-15T22:25:00+08:00');
  globalThis.fetch = mockPbsFetch([REAL_PBS_FIXTURE]);
  await runPbsPipelineAndCommit(env, { tdxEvents: [], now: t0 });

  const t1 = new Date('2026-08-15T22:30:00+08:00');
  globalThis.fetch = mockPbsFetch([], 500); // PBS API down
  const failedRun = await runPbsPipelineAndCommit(env, { tdxEvents: [], now: t1 });
  assert.equal(failedRun.pbsOk, false);
  assert.equal(failedRun.committed, false);

  const state = await readPbsLifecycleState(kv);
  assert.equal(state.pbsMap['PBS-2026-08150001'].lifecycle, 'active'); // untouched
  assert.equal(state.pbsMap['PBS-2026-08150001'].missingSince, null); // not marked missing
});

test('runPbsPipelinePreview never writes to KV, even when called repeatedly', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockPbsFetch([REAL_PBS_FIXTURE]);

  const before = kv.store.size;
  await runPbsPipelinePreview(env, { tdxEvents: [], now: new Date() });
  await runPbsPipelinePreview(env, { tdxEvents: [], now: new Date() });
  assert.equal(kv.store.size, before);
});

test('a stale (old, not cleared) event does not appear in activeCount', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  const oldEvent = { ...REAL_PBS_FIXTURE, modDttm: '2026-08-15T18:00:00' };
  globalThis.fetch = mockPbsFetch([oldEvent]);

  const now = new Date('2026-08-15T22:25:00+08:00'); // hours after modDttm
  const result = await runPbsPipelinePreview(env, { tdxEvents: [], now });
  assert.equal(result.staleCount, 1);
  assert.equal(result.activeCount, 0);
});

test('malformed raw records are skipped without failing the whole feed', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockPbsFetch([REAL_PBS_FIXTURE, null, { UID: '', road: '', areaNm: '' }]);

  const result = await runPbsPipelinePreview(env, { tdxEvents: [], now: new Date('2026-08-15T22:25:00+08:00') });
  assert.equal(result.rawCount, 3);
  assert.equal(result.hsinchuCount, 1); // only the real fixture is Hsinchu-relevant
});

test('cross-source dedup runs inside the pipeline: a matching TDX event reduces filteredCount and produces a canonical event', async () => {
  const kv = createMockKV();
  const env = { TRAFFIC_KV: kv };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockPbsFetch([REAL_PBS_FIXTURE]);

  const tdxEvent = {
    source: 'highway',
    rawId: 'HWY-9',
    type: 'accident',
    road: '台68',
    direction: '西向',
    location: '台68 西向 8K附近',
    description: '台68西向8公里事故',
    startKM: '8K+000',
    endKM: '8K+200',
    updatedAt: '2026-08-15T14:22:00.000Z', // close to the PBS modDttm (14:20 UTC)
  };

  const result = await runPbsPipelinePreview(env, { tdxEvents: [tdxEvent], now: new Date('2026-08-15T22:25:00+08:00') });
  assert.equal(result.crossSourceDuplicateCount, 1);
  assert.equal(result.canonicalEventCount, 1);
  assert.equal(result.filteredCount, 0); // the one active PBS event was absorbed into the canonical match
});
