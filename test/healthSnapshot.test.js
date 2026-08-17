import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthSnapshot, persistHealthSnapshot, readHealthSnapshot } from '../src/traffic/healthSnapshot.js';

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
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, NOW.toISOString());
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
