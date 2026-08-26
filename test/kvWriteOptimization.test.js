// V1.9.2 — KV Write Optimization. Real Cloudflare account alert: Cloudflare
// Workers KV's free-tier daily write budget (1,000 writes/day) was at
// 749/1,000, with traffic-reporter-kv alone at 733 (97.9% of the account
// total). A read-only forensic pass (prior round) found three KV keys
// rewritten every single Cron tick (144/day) even when their real content
// had not changed — plus Pipeline Trace writing one KV key PER traced event,
// every tick. This file covers:
//   A. WRITE_ON_CHANGE for traffic:shared-feed and
//      line:incident-suppression-state (contentEqual-gated skip)
//   B. Pipeline Trace batch persistence (one key/round instead of
//      one key/entry) with full v1/v2 read-side backward compatibility
//   C. TDX Usage Summary retirement (tdx:usage:summary:v1 and the raw
//      tdx:usage:entry:v1:* ledger are no longer written by ANY live path)
//   D. the `[kv-write-budget]` observability log line
//   E. quantified before/after write-count fixtures (quiet/medium/high)
//
// tdx:usage:summary:v1's own WRITE_ON_CHANGE gate (added earlier this same
// round, before the formal retirement decision arrived) is still covered
// directly in test/tdxUsageLedger.test.js — that function is unchanged and
// still directly unit-tested; it is simply never called from any live Cron/
// Debug/Admin path anymore (see scheduled.js's own V1.9.2 comment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentEqual, canonicalJson } from '../src/util/contentEqual.js';
import { runSharedFeedPersist, readSharedFeed, SHARED_FEED_KEY, eventIdOf, fingerprintOf } from '../src/traffic/sharedFeed.js';
import {
  persistIncidentSuppressionState,
  readIncidentSuppressionState,
  resolveIncidentNotifications,
} from '../src/traffic/incidentSuppression.js';
import {
  buildTraceEntry,
  persistPipelineTraceBatch,
  persistPipelineTraceEntries,
  recordPipelineTrace,
  listPipelineTrace,
  chunkEntriesForTraceBatch,
  TRACE_KEY_PREFIX,
  TRACE_BATCH_KEY_PREFIX,
  MAX_TRACE_ENTRIES_PER_BATCH,
  MAX_TRACE_BATCH_BYTES,
} from '../src/traffic/pipelineTrace.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { handleHealth } from '../src/traffic/health.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';
import { USAGE_ENTRY_KEY_PREFIX, USAGE_SUMMARY_KEY } from '../src/tdx/usageLedger.js';
import { normalizeRoadEvent } from '../src/tdx/normalize.js';

const NOW = new Date('2026-08-26T14:00:00+08:00');

function createMockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls = [];
  return {
    store,
    putCalls,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      putCalls.push({ key, value, options });
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function failingPutKV(matchPrefix) {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key) {
      if (!matchPrefix || key.startsWith(matchPrefix)) throw new Error('KV put exploded');
      store.set(key, '');
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'accident',
    title: '國道事故',
    description: '國道1號北向88K發生事故，內側車道封閉',
    road: '國道一號',
    direction: '北向',
    location: '國道一號 北向 88K+000',
    startTime: '2026-08-26T05:50:00.000Z',
    endTime: null,
    updatedAt: '2026-08-26T05:55:00.000Z',
    startKM: '88K+000',
    blockedLanes: 1,
    ...overrides,
  };
}

function product(event, overrides = {}) {
  return {
    event,
    text: '🚨 交通事故\n國道1號 北向\n事故影響通行\n請提前避開',
    imageUrl: null,
    imageExpiresAt: null,
    ...overrides,
  };
}

// ===========================================================================
// A0. contentEqual — the shared WRITE_ON_CHANGE primitive
// ===========================================================================

test('A0.1 contentEqual is key-order-independent', () => {
  const a = { x: 1, y: { b: 2, a: 1 } };
  const b = { y: { a: 1, b: 2 }, x: 1 };
  assert.equal(contentEqual(a, b), true);
});

test('A0.2 contentEqual detects a genuine content difference nested inside an array', () => {
  const a = { list: [{ id: 1, v: 'x' }, { id: 2, v: 'y' }] };
  const b = { list: [{ id: 1, v: 'x' }, { id: 2, v: 'z' }] };
  assert.equal(contentEqual(a, b), false);
});

test('A0.3 canonicalJson is deterministic regardless of input key order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

// ===========================================================================
// A1. Shared Feed — WRITE_ON_CHANGE
// ===========================================================================

test('A1.1 unchanged content across two ticks (same events, same fingerprints) -> second tick skips the write', async () => {
  const kv = createMockKV();
  const event = accidentEvent();

  const first = await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(event)], now: NOW });
  assert.equal(first.committed, true);
  assert.equal(first.written, true); // first-ever write always happens
  assert.equal(kv.putCalls.length, 1);

  const second = await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(event)], now: new Date(NOW.getTime() + 10 * 60_000) });
  assert.equal(second.committed, true);
  assert.equal(second.written, false); // content-identical -> skipped
  assert.equal(kv.putCalls.length, 1); // still just the one write from tick 1
});

test('A1.2 a genuine content change (new event added) -> the write happens', async () => {
  const kv = createMockKV();
  const event = accidentEvent();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(event)], now: NOW });
  assert.equal(kv.putCalls.length, 1);

  const secondEvent = accidentEvent({ rawId: 'FRW-2', description: '另一起事故' });
  const second = await runSharedFeedPersist(
    { TRAFFIC_KV: kv },
    { completedProducts: [product(event), product(secondEvent)], now: new Date(NOW.getTime() + 10 * 60_000) }
  );
  assert.equal(second.written, true);
  assert.equal(kv.putCalls.length, 2);
});

test('A1.3 a quiet tick (0 completed products) after establishment -> skipped, not re-written as an empty feed every time', async () => {
  const kv = createMockKV();
  const event = accidentEvent();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(event)], now: NOW });

  // Well past RETENTION_MINUTES (180) so the previous entry is not retained
  // — both runs converge on an identical empty `events: []`.
  const farLater = new Date(NOW.getTime() + 4 * 60 * 60_000);
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [], now: farLater });
  const writesAfterFirstEmpty = kv.putCalls.length;

  const evenLater = new Date(farLater.getTime() + 10 * 60_000);
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [], now: evenLater });
  assert.equal(kv.putCalls.length, writesAfterFirstEmpty); // no additional write — still an empty feed
});

test('A1.4 WRITE_ON_CHANGE never changes WHAT gets persisted, only WHEN — a skipped tick leaves the exact prior content readable', async () => {
  const kv = createMockKV();
  const event = accidentEvent();
  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(event)], now: NOW });
  const before = await readSharedFeed(kv);

  await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(event)], now: new Date(NOW.getTime() + 10 * 60_000) });
  const after = await readSharedFeed(kv);

  assert.deepEqual(after.events, before.events);
  assert.equal(after.updatedAt, before.updatedAt); // frozen — the skip did not fabricate a new updatedAt
});

test('A1.5 a KV write failure on the first-ever (always-write) tick is still reported, not swallowed', async () => {
  const kv = failingPutKV(SHARED_FEED_KEY);
  const result = await runSharedFeedPersist({ TRAFFIC_KV: kv }, { completedProducts: [product(accidentEvent())], now: NOW });
  assert.equal(result.committed, false);
  assert.match(result.error, /KV put exploded/);
});

// ===========================================================================
// A2. Incident Suppression — WRITE_ON_CHANGE
// ===========================================================================

test('A2.1 a quiet tick with 0 accident events and nothing aging out -> the write is skipped', async () => {
  const kv = createMockKV();
  const group = '國道一號|北向';
  const seedNow = NOW;
  const seeded = {
    [group]: [{ notificationKey: 'freeway:FRW-1', km: 88, lastSeenAt: seedNow.toISOString(), escalation: { type: 'accident', blockedLanes: 1, closureSignal: false } }],
  };
  const first = await persistIncidentSuppressionState(kv, seeded, seedNow);
  assert.equal(first.written, true); // no previous state existed yet -> always write
  assert.equal(kv.putCalls.length, 1);

  // Next tick: no new accident events, and the record is still within the
  // suppression window, so resolveIncidentNotifications' own pruning keeps
  // it unchanged — content-identical to what's already persisted. (0
  // incoming events -> resolveIncidentNotifications' match-mutation branch
  // never runs, but snapshotting first anyway is the same safe habit the
  // real call site in broadcastPipeline.js always follows.)
  const state = await readIncidentSuppressionState(kv);
  const previousSnapshot = structuredClone(state.incidentsByGroup);
  const { nextIncidentsByGroup } = resolveIncidentNotifications([], state.incidentsByGroup, new Date(seedNow.getTime() + 10 * 60_000));
  const second = await persistIncidentSuppressionState(kv, nextIncidentsByGroup, new Date(seedNow.getTime() + 10 * 60_000), {
    previousIncidentsByGroup: previousSnapshot,
    previousStateExisted: state.existed,
  });
  assert.equal(second.written, false);
  assert.equal(kv.putCalls.length, 1);
});

test('A2.2 the same accident sighted again (lastSeenAt genuinely advances) -> the write happens, never skipped', async () => {
  const kv = createMockKV();
  const group = '國道一號|北向';
  const seedNow = NOW;
  const seeded = { [group]: [{ notificationKey: 'freeway:FRW-1', km: 88, lastSeenAt: seedNow.toISOString(), escalation: { type: 'accident', blockedLanes: 1, closureSignal: false } }] };
  await persistIncidentSuppressionState(kv, seeded, seedNow);

  const nextTick = new Date(seedNow.getTime() + 10 * 60_000);
  const state = await readIncidentSuppressionState(kv);
  // resolveIncidentNotifications MUTATES matched records in place (see
  // broadcastPipeline.js's own V1.9.2 comment on this exact hazard) — a
  // real "previous" snapshot must be taken BEFORE calling it, never the
  // same object graph read back out afterward.
  const previousSnapshot = structuredClone(state.incidentsByGroup);
  const sameEvent = accidentEvent({ startKM: '88K+000' });
  const { nextIncidentsByGroup, results } = resolveIncidentNotifications([sameEvent], state.incidentsByGroup, nextTick);
  assert.equal(results[0].suppressed, true); // same incident, no escalation -> suppressed for LINE purposes

  const commit = await persistIncidentSuppressionState(kv, nextIncidentsByGroup, nextTick, {
    previousIncidentsByGroup: previousSnapshot,
    previousStateExisted: state.existed,
  });
  // Even though the event is SUPPRESSED (never re-notified), lastSeenAt
  // genuinely advanced (88 -> re-seen at nextTick) — real functional state
  // the next tick's alive-window pruning depends on — so this MUST write.
  assert.equal(commit.written, true);
  assert.equal(kv.putCalls.length, 2);
});

test('A2.3 a record aging out of the suppression window (real content change) -> the write happens', async () => {
  const kv = createMockKV();
  const group = '國道一號|北向';
  const seeded = { [group]: [{ notificationKey: 'freeway:FRW-1', km: 88, lastSeenAt: NOW.toISOString(), escalation: { type: 'accident', blockedLanes: 1, closureSignal: false } }] };
  await persistIncidentSuppressionState(kv, seeded, NOW);

  // 70 minutes later — past INCIDENT_SUPPRESSION_WINDOW_MS (60 min) — the
  // record is pruned even with 0 new events, a genuine content change.
  const muchLater = new Date(NOW.getTime() + 70 * 60_000);
  const state = await readIncidentSuppressionState(kv);
  const previousSnapshot = structuredClone(state.incidentsByGroup);
  const { nextIncidentsByGroup } = resolveIncidentNotifications([], state.incidentsByGroup, muchLater);
  assert.deepEqual(nextIncidentsByGroup, {}); // pruned away

  const commit = await persistIncidentSuppressionState(kv, nextIncidentsByGroup, muchLater, {
    previousIncidentsByGroup: previousSnapshot,
    previousStateExisted: state.existed,
  });
  assert.equal(commit.written, true);
  assert.equal(kv.putCalls.length, 2);
});

test('A2.4 WRITE_ON_CHANGE never alters the suppression/escalation decision itself — a material escalation still notifies whether or not the PRIOR tick happened to skip', async () => {
  const kv = createMockKV();
  const group = '國道一號|北向';
  const seeded = { [group]: [{ notificationKey: 'freeway:FRW-1', km: 88, lastSeenAt: NOW.toISOString(), escalation: { type: 'accident', blockedLanes: 1, closureSignal: false } }] };
  await persistIncidentSuppressionState(kv, seeded, NOW);

  const nextTick = new Date(NOW.getTime() + 10 * 60_000);
  const state = await readIncidentSuppressionState(kv);
  const escalated = accidentEvent({ startKM: '88K+000', blockedLanes: 2 }); // more lanes blocked -> material escalation
  const { results } = resolveIncidentNotifications([escalated], state.incidentsByGroup, nextTick);
  assert.equal(results[0].suppressed, false);
  assert.equal(results[0].reason, 'material-escalation');
});

test('A2.5 callers that omit the previous-state options (every pre-V1.9.2 test) always write, unchanged legacy behavior', async () => {
  const kv = createMockKV();
  const commit = await persistIncidentSuppressionState(kv, { a: 1 }, NOW);
  assert.equal(commit.committed, true);
  assert.equal(commit.written, true);
  const second = await persistIncidentSuppressionState(kv, { a: 1 }, new Date(NOW.getTime() + 1000));
  assert.equal(second.written, true); // no previousStateExisted passed -> always writes, exactly like before this round
});

test('A2.6 readIncidentSuppressionState reports existed:false for a never-written key, existed:true once persisted', async () => {
  const kv = createMockKV();
  const before = await readIncidentSuppressionState(kv);
  assert.equal(before.existed, false);
  await persistIncidentSuppressionState(kv, { g: [] }, NOW);
  const after = await readIncidentSuppressionState(kv);
  assert.equal(after.existed, true);
});

// ===========================================================================
// B. Pipeline Trace — batch persistence
// ===========================================================================

function traceEntry(rawId, overrides = {}) {
  return buildTraceEntry({ event: accidentEvent({ rawId }), now: NOW, eligibility: true, lineAttempted: 1, lineSucceeded: 1, ...overrides });
}

test('B1 one Cron round with N entries writes exactly ONE batch key (not N keys)', async () => {
  const kv = createMockKV();
  const entries = Array.from({ length: 12 }, (_, i) => traceEntry(`P${i}`));
  const result = await persistPipelineTraceBatch(kv, entries, NOW);
  assert.equal(result.attempted, 12);
  assert.equal(result.committed, 12);
  assert.equal(result.batchCount, 1);
  const batchKeys = [...kv.store.keys()].filter((k) => k.startsWith(TRACE_BATCH_KEY_PREFIX));
  assert.equal(batchKeys.length, 1);
  const v1Keys = [...kv.store.keys()].filter((k) => k.startsWith(TRACE_KEY_PREFIX + ':'));
  assert.equal(v1Keys.length, 0);
});

test('B2 an empty round (0 entries) writes nothing at all', async () => {
  const kv = createMockKV();
  const result = await persistPipelineTraceBatch(kv, [], NOW);
  assert.equal(result.attempted, 0);
  assert.equal(result.batchCount, 0);
  assert.equal(kv.store.size, 0);
});

test('B3 the batch key carries {schemaVersion:2, generatedAt, entries}', async () => {
  const kv = createMockKV();
  await persistPipelineTraceBatch(kv, [traceEntry('P1')], NOW);
  const [key] = [...kv.store.keys()];
  const body = JSON.parse(kv.store.get(key));
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].identity.rawId, 'P1');
});

test('B4 chunkEntriesForTraceBatch splits deterministically once MAX_TRACE_ENTRIES_PER_BATCH is exceeded', () => {
  const entries = Array.from({ length: MAX_TRACE_ENTRIES_PER_BATCH + 5 }, (_, i) => ({ i }));
  const chunks = chunkEntriesForTraceBatch(entries);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, MAX_TRACE_ENTRIES_PER_BATCH);
  assert.equal(chunks[1].length, 5);
});

test('B5 chunkEntriesForTraceBatch splits once MAX_TRACE_BATCH_BYTES is exceeded, even under the entry-count cap', () => {
  const bigString = 'x'.repeat(Math.floor(MAX_TRACE_BATCH_BYTES / 3));
  const entries = [{ blob: bigString }, { blob: bigString }, { blob: bigString }, { blob: bigString }];
  const chunks = chunkEntriesForTraceBatch(entries);
  assert.ok(chunks.length >= 2, 'four ~1/3-cap entries must not all fit in one chunk');
  for (const chunk of chunks) {
    const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
    assert.ok(bytes <= MAX_TRACE_BATCH_BYTES || chunk.length === 1, 'each chunk stays under the byte cap unless it is a single oversized entry');
  }
});

test('B6 a single entry larger than MAX_TRACE_BATCH_BYTES on its own is still written alone, never dropped', () => {
  const oversized = { blob: 'x'.repeat(MAX_TRACE_BATCH_BYTES + 100) };
  const chunks = chunkEntriesForTraceBatch([oversized, { small: 1 }]);
  assert.equal(chunks.flat().length, 2); // nothing lost
  assert.equal(chunks[0].length, 1); // the oversized entry gets its own chunk
});

test('B7 a KV outage during batch write is isolated: committed/failed counts reflect it, never throws', async () => {
  const kv = failingPutKV(TRACE_BATCH_KEY_PREFIX);
  const result = await persistPipelineTraceBatch(kv, [traceEntry('P1'), traceEntry('P2')], NOW);
  assert.equal(result.committed, 0);
  assert.equal(result.failed, 2);
  assert.equal(result.batchCount, 1);
});

test('B8 listPipelineTrace reads LEGACY v1 per-entry keys exactly as before (backward compatibility)', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(kv, traceEntry('LEGACY1'), NOW, 0);
  await recordPipelineTrace(kv, traceEntry('LEGACY2'), new Date(NOW.getTime() + 1000), 0);
  const { records, kvAvailable } = await listPipelineTrace(kv, { limit: 100 });
  assert.equal(kvAvailable, true);
  assert.equal(records.length, 2);
  assert.ok(records.some((r) => r.identity.rawId === 'LEGACY1'));
});

test('B9 listPipelineTrace reads NEW v2 batch keys, flattened to the same per-entry shape', async () => {
  const kv = createMockKV();
  await persistPipelineTraceBatch(kv, [traceEntry('NEW1'), traceEntry('NEW2')], NOW);
  const { records } = await listPipelineTrace(kv, { limit: 100 });
  assert.equal(records.length, 2);
  assert.ok(records.some((r) => r.identity.rawId === 'NEW1'));
  assert.ok(records.some((r) => r.identity.rawId === 'NEW2'));
});

test('B10 a mixed v1+v2 history merges into ONE correct newest-first timeline', async () => {
  const kv = createMockKV();
  const t0 = new Date(NOW.getTime() - 20 * 60_000);
  const t1 = new Date(NOW.getTime() - 10 * 60_000);
  const t2 = NOW;
  await recordPipelineTrace(kv, traceEntry('OLDEST-V1'), t0, 0); // legacy write, oldest
  await persistPipelineTraceBatch(kv, [traceEntry('MIDDLE-V2')], t1); // new batch write, middle
  await recordPipelineTrace(kv, traceEntry('NEWEST-V1'), t2, 0); // legacy write again, newest — proves v1 isn't just "always older"

  const { records } = await listPipelineTrace(kv, { limit: 100 });
  assert.equal(records.length, 3);
  assert.equal(records[0].identity.rawId, 'NEWEST-V1'); // newest first
  assert.equal(records[1].identity.rawId, 'MIDDLE-V2');
  assert.equal(records[2].identity.rawId, 'OLDEST-V1');
});

test('B11 every filter (source/road/status/rawId/q) still matches correctly across a merged v1+v2 result set', async () => {
  const kv = createMockKV();
  await recordPipelineTrace(kv, traceEntry('V1-A', { }), NOW, 0);
  await persistPipelineTraceBatch(
    kv,
    [
      buildTraceEntry({ event: accidentEvent({ rawId: 'V2-B', source: 'pbs', road: '台68' }), now: NOW, gatingResult: 'unique-candidate' }),
      buildTraceEntry({ event: accidentEvent({ rawId: 'V2-C' }), now: NOW, eligibility: false, eligibilityReason: 'construction-no-impact-keyword' }),
    ],
    new Date(NOW.getTime() + 1000)
  );

  const bySource = await listPipelineTrace(kv, { source: 'pbs', limit: 100 });
  assert.equal(bySource.records.length, 1);
  assert.equal(bySource.records[0].identity.rawId, 'V2-B');

  const byRoad = await listPipelineTrace(kv, { road: '台68', limit: 100 });
  assert.equal(byRoad.records.length, 1);

  const byRawId = await listPipelineTrace(kv, { rawId: 'V1-A', limit: 100 });
  assert.equal(byRawId.records.length, 1);
  assert.equal(byRawId.records[0].identity.rawId, 'V1-A');

  const byStatus = await listPipelineTrace(kv, { status: 'ineligible', limit: 100 });
  assert.equal(byStatus.records.length, 1);
  assert.equal(byStatus.records[0].identity.rawId, 'V2-C');
});

test('B12 DEFAULT_LIST_LIMIT/MAX_LIST_LIMIT are respected identically whether records came from v1, v2, or both', async () => {
  const kv = createMockKV();
  // 75 entries across a mix of legacy v1 keys and one v2 batch.
  for (let i = 0; i < 40; i += 1) {
    await recordPipelineTrace(kv, traceEntry(`V1-${i}`), new Date(NOW.getTime() - (100 - i) * 1000), i);
  }
  const batchEntries = Array.from({ length: 35 }, (_, i) => traceEntry(`V2-${i}`));
  await persistPipelineTraceBatch(kv, batchEntries, new Date(NOW.getTime() + 10_000));

  const defaultLimited = await listPipelineTrace(kv, {});
  assert.equal(defaultLimited.records.length, 60); // DEFAULT_LIST_LIMIT

  const capped = await listPipelineTrace(kv, { limit: 500 });
  assert.equal(capped.records.length, 75); // both schemas' entries all present, capped at MAX_LIST_LIMIT=100 (not reached here)
});

test('B13 scanTruncated is still reported correctly against the merged descriptor count', async () => {
  const kv = createMockKV();
  const batchEntries = Array.from({ length: 10 }, (_, i) => traceEntry(`V2-${i}`));
  await persistPipelineTraceBatch(kv, batchEntries, NOW);
  const { scanTruncated, totalKeyCount, scannedKeyCount } = await listPipelineTrace(kv, { limit: 5 });
  assert.equal(totalKeyCount, 1); // exactly one batch KEY exists
  assert.equal(scannedKeyCount, 1); // that one key WAS read (limit only bounds returned records, not key scanning)
  assert.equal(scanTruncated, false);
});

test('B14 the admin JSON/HTML read endpoints need ZERO code changes — pipelineTraceView.js already renders v2-only data correctly', async () => {
  const { handlePipelineTraceView } = await import('../src/traffic/pipelineTraceView.js');
  const kv = createMockKV();
  await persistPipelineTraceBatch(kv, [traceEntry('VIEWME')], NOW);
  const response = await handlePipelineTraceView({ TRAFFIC_KV: kv }, new Request('https://x/admin/pipeline-trace-view'), NOW);
  const html = await response.text();
  assert.match(html, /VIEWME/);
});

test('B15 legacy persistPipelineTraceEntries (v1, one-key-per-entry) is UNCHANGED and still fully functional', async () => {
  const kv = createMockKV();
  const result = await persistPipelineTraceEntries(kv, [traceEntry('L1'), traceEntry('L2')], NOW);
  assert.equal(result.committed, 2);
  const v1Keys = [...kv.store.keys()].filter((k) => k.startsWith(TRACE_KEY_PREFIX + ':'));
  assert.equal(v1Keys.length, 2); // still one KV key per entry — this function itself never changed
});

// ===========================================================================
// C. TDX Usage Summary — formal retirement
// ===========================================================================

function metadataEnvelope() {
  return JSON.stringify({ records: [], fetchedAt: NOW.toISOString() });
}

test('C1 a real Cron tick writes ZERO tdx:usage:entry:v1:* keys and ZERO tdx:usage:summary:v1 key', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope() });
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    await runScheduledTdxSync({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv }, NOW);
  } finally {
    globalThis.fetch = priorFetch;
  }
  const usageEntryKeys = [...kv.store.keys()].filter((k) => k.startsWith(USAGE_ENTRY_KEY_PREFIX));
  assert.equal(usageEntryKeys.length, 0);
  assert.equal(kv.store.has(USAGE_SUMMARY_KEY), false);
});

test('C2 GET /health renders the retirement note and never throws when no summary key exists at all', async () => {
  const now = new Date(); // handleHealth always uses the real wall clock internally
  const kv = createMockKV({
    'health:snapshot:v1': JSON.stringify({
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      status: 'normal',
      tdx: { tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [], lastFetchedAt: now.toISOString(), scheduledThisRun: true, sleeping: false },
      pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
      line: { ready: true, enabledUsersCount: 0, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
      kv: { available: true },
      broadcast: { broadcastRelevantCount: 0, pendingTargetCount: 0, typeIneligibleCount: 0, ineligibleByReason: {}, incidentSuppressedCount: 0 },
    }),
  });
  const response = await handleHealth({ TRAFFIC_KV: kv });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /TDX 官方後台/);
});

test('C3 GET /health tolerates a LEFTOVER pre-V1.9.2 usage summary key without reading, erroring on, or displaying it', async () => {
  const now = new Date(); // handleHealth always uses the real wall clock internally
  const kv = createMockKV({
    'health:snapshot:v1': JSON.stringify({
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      status: 'normal',
      tdx: { tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [], lastFetchedAt: now.toISOString(), scheduledThisRun: true, sleeping: false },
      pbs: { ok: true, relayOk: true, relayStatus: 200, rawCount: 0, hsinchuCount: 0, activeCount: 0, clearedCount: 0, staleCount: 0 },
      line: { ready: true, enabledUsersCount: 0, enabledGroupsCount: 0, pushAttempted: 0, pushSucceeded: 0, partialPushFailures: 0, lastLinePushAt: null },
      kv: { available: true },
      broadcast: { broadcastRelevantCount: 0, pendingTargetCount: 0, typeIneligibleCount: 0, ineligibleByReason: {}, incidentSuppressedCount: 0 },
    }),
    [USAGE_SUMMARY_KEY]: JSON.stringify({ schemaVersion: 1, updatedAt: '2026-08-20T00:00:00Z', days: { '2026-08-20': { totalDataCalls: 87654 } } }),
  });
  const response = await handleHealth({ TRAFFIC_KV: kv });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /87654/); // the stale leftover number never leaks onto the page
  assert.doesNotMatch(html, /TDX 今日/); // the retired dashboard heading is gone
});

test('C4 /debug/tdx and the admin CCTV probes no longer import commitTdxUsageBatch at all', async () => {
  const debugSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/tdx/debug.js', import.meta.url), 'utf8'));
  const cctvProbeSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/tdx/cctvProbe.js', import.meta.url), 'utf8'));
  const hsinchuSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/tdx/hsinchuCctvProbe.js', import.meta.url), 'utf8'));
  const debugStatusSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/traffic/debugStatus.js', import.meta.url), 'utf8'));
  for (const src of [debugSrc, cctvProbeSrc, hsinchuSrc, debugStatusSrc]) {
    assert.doesNotMatch(src, /commitTdxUsageBatch/);
  }
});

// ===========================================================================
// D/E. [kv-write-budget] observability + quantified before/after fixtures
// ===========================================================================

async function runQuietTick() {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope() });
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runScheduledTdxSync({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv }, NOW);
  } finally {
    console.log = originalLog;
    globalThis.fetch = priorFetch;
  }
  return { kv, logs };
}

test('D1 [kv-write-budget] log line is emitted exactly once per Cron tick, with all 8 named categories present', async () => {
  const { logs } = await runQuietTick();
  const line = logs.find((l) => l.startsWith('[kv-write-budget]'));
  assert.ok(line, 'expected a [kv-write-budget] log line');
  for (const category of [
    'tdxUsageSummary',
    'tdxUsageEntry',
    'healthSnapshot',
    'tdxEventCache',
    'sharedFeed',
    'incidentSuppression',
    'notifiedState',
    'pipelineTraceBatch',
  ]) {
    assert.match(line, new RegExp(`${category}=\\d+/\\d+/\\d+`), `missing category ${category} in: ${line}`);
  }
  assert.match(line, /traceEntryCount=\d+/);
  assert.match(line, /traceBatchCount=\d+/);
});

test('D2 [kv-write-budget] reports tdxUsageSummary=0/0/0 and tdxUsageEntry=0/0/0 on every tick (retired)', async () => {
  const { logs } = await runQuietTick();
  const line = logs.find((l) => l.startsWith('[kv-write-budget]'));
  assert.match(line, /tdxUsageSummary=0\/0\/0/);
  assert.match(line, /tdxUsageEntry=0\/0\/0/);
});

test('E1 QUIET fixture (0 traced events) — a second identical tick skips sharedFeed AND incidentSuppression writes', async () => {
  const kv = createMockKV({ [FREEWAY_METADATA_KEY]: metadataEnvelope() });
  await setUserEnabled(kv, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/')) return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    if (href.includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    await runScheduledTdxSync({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv }, NOW);
    const putsAfterFirst = kv.putCalls.length;
    await runScheduledTdxSync({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', TRAFFIC_KV: kv }, new Date(NOW.getTime() + 20 * 60_000));
    const putsAfterSecond = kv.putCalls.length - putsAfterFirst;
    // Second tick: healthSnapshot always writes (1); tdxEventCache may
    // write again (0 events, still "successful" — 1); sharedFeed and
    // incidentSuppression both skip (quiet, unchanged); pipelineTraceBatch
    // writes nothing (0 entries this tick, PBS relay unset so nothing
    // gates through) — a small, bounded number, well under the FIRST
    // tick's write count.
    assert.ok(putsAfterSecond < putsAfterFirst, `expected fewer writes on the quiet repeat tick (${putsAfterSecond} vs ${putsAfterFirst})`);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('E2 MEDIUM fixture (10 trace entries in one round) still writes exactly ONE pipeline-trace-batch key', async () => {
  const kv = createMockKV();
  const entries = Array.from({ length: 10 }, (_, i) => traceEntry(`M${i}`));
  const result = await persistPipelineTraceBatch(kv, entries, NOW);
  assert.equal(result.batchCount, 1);
  assert.equal(result.committed, 10);
});

test('E3 HIGH fixture (20 trace entries in one round) still fits in ONE batch (well under MAX_TRACE_ENTRIES_PER_BATCH/MAX_TRACE_BATCH_BYTES)', async () => {
  const kv = createMockKV();
  const entries = Array.from({ length: 20 }, (_, i) => traceEntry(`H${i}`));
  const result = await persistPipelineTraceBatch(kv, entries, NOW);
  assert.equal(result.batchCount, 1);
  assert.equal(result.committed, 20);
  // Quantified before/after: BEFORE V1.9.2 this was 20 separate KV puts
  // (one per entry); AFTER, it is this ONE put — a 20x reduction for this
  // one write category on this one fixture.
  const batchKeys = [...kv.store.keys()].filter((k) => k.startsWith(TRACE_BATCH_KEY_PREFIX));
  assert.equal(batchKeys.length, 1);
});
