import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHealthSnapshot,
  persistHealthSnapshot,
  readHealthSnapshot,
  healthSnapshotContentEqual,
} from '../src/traffic/healthSnapshot.js';

function kv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function tdxSources(overrides = []) {
  const base = [
    { source: 'freeway', label: '國道即時道路事件', ok: true, status: 200 },
    { source: 'highway', label: '省道即時道路事件', ok: true, status: 200 },
    { source: 'cms', label: '新竹市 CMS 即時看板', ok: true, status: 200 },
    { source: 'bus-hsinchu', label: '新竹市公車營運通阻', ok: true, status: 200 },
    { source: 'bus-hsinchu-county', label: '新竹縣公車營運通阻', ok: true, status: 200 },
  ];
  return base.map((s, i) => ({ ...s, ...(overrides[i] || {}) }));
}

function healthySummary(overrides = {}) {
  return { tokenOk: true, kvAvailable: true, sources: tdxSources(), ...overrides };
}

function healthyPbsSummary(overrides = {}) {
  return { pbsOk: true, relayOk: true, relayStatus: 200, rawCount: 1000, hsinchuCount: 27, activeCount: 5, clearedCount: 15, staleCount: 7, ...overrides };
}

function healthyLineSummary(overrides = {}) {
  return {
    lineReady: true,
    enabledUsersCount: 1,
    enabledGroupsCount: 0,
    pushAttempted: 0,
    pushSucceeded: 0,
    partialPushFailures: 0,
    lastLinePushAt: null,
    broadcastRelevantCount: 0,
    pendingTargetCount: 0,
    typeIneligibleCount: 0,
    ineligibleByReason: {},
    incidentSuppressedCount: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-08-17T09:05:00+08:00');

test('all healthy -> status normal', () => {
  const snapshot = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  assert.equal(snapshot.status, 'normal');
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.generatedAt, NOW.toISOString());
});

// --- V1.6.1: tdxScheduleState / carry-forward (see tdxSchedule.js) ---

test('tdxScheduleState defaults to "scheduled" -> tdx block computed fresh from summary, as before', () => {
  const snapshot = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  assert.equal(snapshot.tdx.scheduledThisRun, true);
  assert.equal(snapshot.tdx.sleeping, false);
  assert.equal(snapshot.tdx.lastFetchedAt, NOW.toISOString());
  assert.equal(snapshot.tdx.successfulSourceCount, 5);
  assert.equal(snapshot.tdx.totalSourceCount, 5);
});

test('skipped-by-schedule tick with a previous healthy snapshot -> tdx health carried forward unchanged, status stays normal', () => {
  const previousTdx = {
    tokenOk: true,
    successfulSourceCount: 2,
    totalSourceCount: 2,
    sources: tdxSources().slice(0, 2),
    lastFetchedAt: '2026-08-17T09:00:00.000Z',
    scheduledThisRun: true,
    sleeping: false,
  };
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: [] }), // this tick made no TDX calls at all
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
    tdxScheduleState: 'skipped-by-schedule',
    previousTdx,
  });
  assert.equal(snapshot.tdx.scheduledThisRun, false);
  assert.equal(snapshot.tdx.sleeping, false);
  assert.equal(snapshot.tdx.tokenOk, true);
  assert.equal(snapshot.tdx.successfulSourceCount, 2);
  assert.equal(snapshot.tdx.totalSourceCount, 2);
  assert.equal(snapshot.tdx.lastFetchedAt, '2026-08-17T09:00:00.000Z'); // carried, NOT this tick's `now`
  assert.equal(snapshot.status, 'normal');
});

test('night-sleep tick with a previous healthy snapshot -> tdx health carried forward unchanged, status stays normal', () => {
  const previousTdx = {
    tokenOk: true, successfulSourceCount: 2, totalSourceCount: 2, sources: [],
    lastFetchedAt: '2026-08-17T21:40:00.000Z', scheduledThisRun: true, sleeping: false,
  };
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: [] }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
    tdxScheduleState: 'night-sleep',
    previousTdx,
  });
  assert.equal(snapshot.tdx.sleeping, true);
  assert.equal(snapshot.tdx.scheduledThisRun, false);
  assert.equal(snapshot.tdx.successfulSourceCount, 2);
  assert.equal(snapshot.status, 'normal');
});

test('skipped tick carrying forward a PREVIOUSLY FAILED TDX fetch -> stays degraded (a skip must not silently heal a real failure either)', () => {
  const previousTdx = {
    tokenOk: true, successfulSourceCount: 1, totalSourceCount: 2,
    sources: [{ source: 'freeway', label: '國道', ok: false, httpStatus: 429 }, { source: 'highway', label: '省道', ok: true, httpStatus: 200 }],
    lastFetchedAt: '2026-08-17T09:00:00.000Z', scheduledThisRun: true, sleeping: false,
  };
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: [] }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
    tdxScheduleState: 'skipped-by-schedule',
    previousTdx,
  });
  assert.equal(snapshot.status, 'degraded');
});

test('skipped tick with NO previous snapshot at all (very first ticks after deploy) -> unknown, not critical', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: [] }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
    tdxScheduleState: 'skipped-by-schedule',
    previousTdx: null,
  });
  assert.equal(snapshot.tdx.tokenOk, null);
  assert.equal(snapshot.tdx.totalSourceCount, 0);
  assert.equal(snapshot.tdx.lastFetchedAt, null);
  assert.equal(snapshot.status, 'normal'); // "unknown" must never look like "failed"
});

test('KV unavailable -> critical, regardless of everything else being fine', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ kvAvailable: false }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
  });
  assert.equal(snapshot.status, 'critical');
});

test('LINE not ready -> critical', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary({ lineReady: false }),
    now: NOW,
  });
  assert.equal(snapshot.status, 'critical');
});

test('TDX all 5 sources failed AND PBS also failed -> critical', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ tokenOk: false, sources: tdxSources([{ ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }]) }),
    pbsSummary: healthyPbsSummary({ pbsOk: false, relayOk: false, relayStatus: 502 }),
    lineSummary: healthyLineSummary(),
    now: NOW,
  });
  assert.equal(snapshot.status, 'critical');
});

test('TDX all sources failed but PBS still OK -> degraded, NOT critical', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: tdxSources([{ ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }]) }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
  });
  assert.equal(snapshot.status, 'degraded');
});

test('PBS failed alone, TDX fully healthy -> degraded, not critical', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary({ pbsOk: false, relayOk: false, relayStatus: null }),
    lineSummary: healthyLineSummary(),
    now: NOW,
  });
  assert.equal(snapshot.status, 'degraded');
});

test('partial TDX source failure (not all 5) -> degraded', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: tdxSources([{ ok: false, status: 500 }]) }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: NOW,
  });
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.tdx.successfulSourceCount, 4);
  assert.equal(snapshot.tdx.totalSourceCount, 5);
});

test('LINE partial push failures > 0 -> degraded', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary({ partialPushFailures: 1 }),
    now: NOW,
  });
  assert.equal(snapshot.status, 'degraded');
});

test('lastLinePushAt=null and 0 events this run -> still normal (never treated as unhealthy on their own)', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary({ lastLinePushAt: null, broadcastRelevantCount: 0, pendingTargetCount: 0, pushSucceeded: 0, pushAttempted: 0 }),
    now: NOW,
  });
  assert.equal(snapshot.status, 'normal');
  assert.equal(snapshot.line.lastLinePushAt, null);
});

test('tdx.tokenOk is present as a boolean', () => {
  const snapshotTrue = buildHealthSnapshot({ summary: healthySummary({ tokenOk: true }), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  const snapshotFalse = buildHealthSnapshot({ summary: healthySummary({ tokenOk: false }), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  assert.equal(snapshotTrue.tdx.tokenOk, true);
  assert.equal(snapshotFalse.tdx.tokenOk, false);
});

test('minimal PBS fallback shape (pipeline threw, see scheduled.js) never crashes buildHealthSnapshot', () => {
  const minimalPbsSummary = { pbsOk: false, pbsError: 'boom' }; // no rawCount/hsinchuCount/etc at all
  const snapshot = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: minimalPbsSummary, lineSummary: healthyLineSummary(), now: NOW });
  assert.equal(snapshot.pbs.ok, false);
  assert.equal(snapshot.pbs.rawCount, 0);
  assert.equal(snapshot.pbs.hsinchuCount, 0);
  assert.equal(snapshot.status, 'degraded'); // PBS down alone, TDX fine
});

test('snapshot never includes a raw error message, token, or userId/groupId field anywhere', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary({ sources: tdxSources([{ ok: false, status: 429 }]) }),
    pbsSummary: healthyPbsSummary({ pbsOk: false, relayStatus: 502 }),
    lineSummary: healthyLineSummary({ lastLinePushAt: '2026-08-17T09:00:00.000Z' }),
    now: NOW,
  });
  const serialized = JSON.stringify(snapshot);
  // Word-boundary match: the schema deliberately includes a `tokenOk`
  // boolean field name (not a secret value) — \btoken\b does not match
  // inside "tokenOk" since there's no boundary between "n" and "O".
  assert.doesNotMatch(serialized, /\btoken\b/i);
  assert.doesNotMatch(serialized, /secret/i);
  assert.doesNotMatch(serialized, /userId|groupId/i);
  assert.doesNotMatch(serialized, /Authorization/i);
});

test('ineligibleByReason passes through unchanged (Chinese mapping happens at render time, not here)', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary({ ineligibleByReason: { 'congestion-excluded': 2, 'other-no-anomaly-keyword': 1 } }),
    now: NOW,
  });
  assert.deepEqual(snapshot.broadcast.ineligibleByReason, { 'congestion-excluded': 2, 'other-no-anomaly-keyword': 1 });
});

test('persistHealthSnapshot + readHealthSnapshot round-trip', async () => {
  const TRAFFIC_KV = kv();
  const snapshot = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  const commit = await persistHealthSnapshot(TRAFFIC_KV, snapshot);
  assert.equal(commit.committed, true);

  const { kvAvailable, snapshot: read } = await readHealthSnapshot(TRAFFIC_KV);
  assert.equal(kvAvailable, true);
  assert.deepEqual(read, snapshot);
});

test('persistHealthSnapshot: no KV -> reports failure, never throws', async () => {
  const commit = await persistHealthSnapshot(null, {});
  assert.equal(commit.committed, false);
});

test('persistHealthSnapshot: KV.put throws -> reports failure, never throws', async () => {
  const brokenKv = { async put() { throw new Error('KV write outage'); } };
  const commit = await persistHealthSnapshot(brokenKv, {});
  assert.equal(commit.committed, false);
  assert.equal(commit.reason, 'kv-error');
});

test('readHealthSnapshot: no snapshot written yet -> kvAvailable true, snapshot null', async () => {
  const { kvAvailable, snapshot } = await readHealthSnapshot(kv());
  assert.equal(kvAvailable, true);
  assert.equal(snapshot, null);
});

test('readHealthSnapshot: no TRAFFIC_KV binding -> kvAvailable false, no throw', async () => {
  const { kvAvailable, snapshot } = await readHealthSnapshot(null);
  assert.equal(kvAvailable, false);
  assert.equal(snapshot, null);
});

test('readHealthSnapshot: KV.get throws -> kvAvailable false, no throw', async () => {
  const brokenKv = { async get() { throw new Error('KV read outage'); } };
  const { kvAvailable, snapshot } = await readHealthSnapshot(brokenKv);
  assert.equal(kvAvailable, false);
  assert.equal(snapshot, null);
});

test('readHealthSnapshot: corrupt JSON -> treated as no snapshot, no throw', async () => {
  const TRAFFIC_KV = kv();
  TRAFFIC_KV.store.set('health:snapshot:v1', 'not valid json{{{');
  const { kvAvailable, snapshot } = await readHealthSnapshot(TRAFFIC_KV);
  assert.equal(kvAvailable, true);
  assert.equal(snapshot, null);
});

// --- V1.9.3 (KV Write Optimization Phase 2): PBS schedule carry-forward
// (pbsSchedule.js) — same idiom as the TDX tests above, now for `pbs`. ---

test('pbsScheduleState defaults to "scheduled" -> pbs block computed fresh from pbsSummary, as before', () => {
  const snapshot = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  assert.equal(snapshot.pbs.scheduledThisRun, true);
  assert.equal(snapshot.pbs.sleeping, false);
  assert.equal(snapshot.pbs.lastFetchedAt, NOW.toISOString());
  assert.equal(snapshot.pbs.ok, true);
});

test('PBS skipped-by-schedule tick with a previous healthy snapshot -> pbs health carried forward unchanged, status stays normal (not misjudged as failure)', () => {
  const previousPbs = {
    ok: true, relayOk: true, relayStatus: 200, rawCount: 1000, hsinchuCount: 27,
    activeCount: 5, clearedCount: 15, staleCount: 7,
    lastFetchedAt: '2026-08-17T09:00:00.000Z', scheduledThisRun: true, sleeping: false,
  };
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: { pbsOk: null }, // this tick made no PBS call at all
    lineSummary: healthyLineSummary(),
    now: NOW,
    pbsScheduleState: 'skipped-by-schedule',
    previousPbs,
  });
  assert.equal(snapshot.pbs.scheduledThisRun, false);
  assert.equal(snapshot.pbs.sleeping, false);
  assert.equal(snapshot.pbs.ok, true);
  assert.equal(snapshot.pbs.activeCount, 5);
  assert.equal(snapshot.pbs.lastFetchedAt, '2026-08-17T09:00:00.000Z'); // carried, NOT this tick's `now`
  assert.equal(snapshot.status, 'normal');
});

test('PBS night-sleep tick with a previous healthy snapshot -> pbs health carried forward unchanged, status stays normal', () => {
  const previousPbs = {
    ok: true, relayOk: true, relayStatus: 200, rawCount: 900, hsinchuCount: 20,
    activeCount: 3, clearedCount: 10, staleCount: 4,
    lastFetchedAt: '2026-08-17T21:30:00.000Z', scheduledThisRun: true, sleeping: false,
  };
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: { pbsOk: null },
    lineSummary: healthyLineSummary(),
    now: NOW,
    pbsScheduleState: 'night-sleep',
    previousPbs,
  });
  assert.equal(snapshot.pbs.sleeping, true);
  assert.equal(snapshot.pbs.scheduledThisRun, false);
  assert.equal(snapshot.pbs.activeCount, 3);
  assert.equal(snapshot.status, 'normal');
});

test('PBS skipped tick carrying forward a PREVIOUSLY FAILED fetch -> stays degraded (a skip must not silently heal a real failure)', () => {
  const previousPbs = {
    ok: false, relayOk: false, relayStatus: 502, rawCount: 0, hsinchuCount: 0,
    activeCount: 0, clearedCount: 0, staleCount: 0,
    lastFetchedAt: '2026-08-17T09:00:00.000Z', scheduledThisRun: true, sleeping: false,
  };
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: { pbsOk: null },
    lineSummary: healthyLineSummary(),
    now: NOW,
    pbsScheduleState: 'skipped-by-schedule',
    previousPbs,
  });
  assert.equal(snapshot.status, 'degraded');
});

test('PBS skipped tick with NO previous snapshot at all (very first ticks after deploy) -> unknown, not degraded/critical', () => {
  const snapshot = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: { pbsOk: null },
    lineSummary: healthyLineSummary(),
    now: NOW,
    pbsScheduleState: 'skipped-by-schedule',
    previousPbs: null,
  });
  assert.equal(snapshot.pbs.ok, null);
  assert.equal(snapshot.pbs.lastFetchedAt, null);
  assert.equal(snapshot.status, 'normal'); // "unknown" must never look like "failed"
});

// --- V1.9.3 item 一: persistHealthSnapshot is now WRITE_ON_CHANGE ---
// (test list items #1-#3 from the V1.9.3 order, section 六).

test('#1 Health content identical, only generatedAt (and tdx/pbs.lastFetchedAt) differ -> 0 KV write', async () => {
  const TRAFFIC_KV = kv();
  const first = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  const firstCommit = await persistHealthSnapshot(TRAFFIC_KV, first, null);
  assert.equal(firstCommit.committed, true);
  assert.equal(firstCommit.written, true); // first-ever write always happens
  const storedAfterFirst = TRAFFIC_KV.store.get('health:snapshot:v1');

  const later = new Date(NOW.getTime() + 10 * 60 * 1000); // 10 minutes later
  const second = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: later });
  assert.notEqual(second.generatedAt, first.generatedAt); // proves the two snapshots really do differ in raw JSON
  const secondCommit = await persistHealthSnapshot(TRAFFIC_KV, second, first);
  assert.equal(secondCommit.committed, true);
  assert.equal(secondCommit.written, false); // real content unchanged -> SKIP
  assert.equal(TRAFFIC_KV.store.get('health:snapshot:v1'), storedAfterFirst); // KV literally untouched
});

test('#2 PBS OK -> FAIL (a real status flip) -> health write = 1', async () => {
  const TRAFFIC_KV = kv();
  const ok = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  await persistHealthSnapshot(TRAFFIC_KV, ok, null);

  const later = new Date(NOW.getTime() + 10 * 60 * 1000);
  const failed = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary({ pbsOk: false, relayOk: false, relayStatus: 502 }),
    lineSummary: healthyLineSummary(),
    now: later,
  });
  const commit = await persistHealthSnapshot(TRAFFIC_KV, failed, ok);
  assert.equal(commit.written, true);
  assert.equal(JSON.parse(TRAFFIC_KV.store.get('health:snapshot:v1')).pbs.ok, false);
});

test('#3 PBS FAIL -> OK (a real status flip back) -> health write = 1', async () => {
  const TRAFFIC_KV = kv();
  const failed = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary({ pbsOk: false, relayOk: false, relayStatus: 502 }),
    lineSummary: healthyLineSummary(),
    now: NOW,
  });
  await persistHealthSnapshot(TRAFFIC_KV, failed, null);

  const later = new Date(NOW.getTime() + 10 * 60 * 1000);
  const ok = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: later });
  const commit = await persistHealthSnapshot(TRAFFIC_KV, ok, failed);
  assert.equal(commit.written, true);
  assert.equal(JSON.parse(TRAFFIC_KV.store.get('health:snapshot:v1')).pbs.ok, true);
});

test('TDX OK -> FAIL (a real status flip, not just a timestamp) -> health write = 1', async () => {
  const TRAFFIC_KV = kv();
  const ok = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  await persistHealthSnapshot(TRAFFIC_KV, ok, null);

  const later = new Date(NOW.getTime() + 10 * 60 * 1000);
  const failed = buildHealthSnapshot({
    summary: healthySummary({ tokenOk: false, sources: tdxSources([{ ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }, { ok: false, status: 429 }]) }),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary(),
    now: later,
  });
  const commit = await persistHealthSnapshot(TRAFFIC_KV, failed, ok);
  assert.equal(commit.written, true);
});

test('a real LINE push happening (lastLinePushAt moves) with everything else unchanged -> still SKIPPED (lastLinePushAt is stripped; pushAttempted/pushSucceeded already carry the real signal)', async () => {
  const TRAFFIC_KV = kv();
  const first = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary({ lastLinePushAt: null }), now: NOW });
  await persistHealthSnapshot(TRAFFIC_KV, first, null);

  const later = new Date(NOW.getTime() + 10 * 60 * 1000);
  const second = buildHealthSnapshot({
    summary: healthySummary(),
    pbsSummary: healthyPbsSummary(),
    lineSummary: healthyLineSummary({ lastLinePushAt: later.toISOString() }), // ONLY this changed
    now: later,
  });
  const commit = await persistHealthSnapshot(TRAFFIC_KV, second, first);
  assert.equal(commit.written, false);
});

test('healthSnapshotContentEqual: order-independent, ignores generatedAt/tdx.lastFetchedAt/pbs.lastFetchedAt/line.lastLinePushAt', () => {
  const a = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  const b = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: new Date(NOW.getTime() + 60000) });
  assert.equal(healthSnapshotContentEqual(a, b), true);
});

test('healthSnapshotContentEqual: a real content change (activeCount) is NOT equal', () => {
  const a = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary(), lineSummary: healthyLineSummary(), now: NOW });
  const b = buildHealthSnapshot({ summary: healthySummary(), pbsSummary: healthyPbsSummary({ activeCount: 6 }), lineSummary: healthyLineSummary(), now: NOW });
  assert.equal(healthSnapshotContentEqual(a, b), false);
});
