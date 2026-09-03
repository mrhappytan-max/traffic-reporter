// V1.4 Alpha: PBS + TDX merged into ONE LINE broadcast (PBS_BROADCAST_ENABLED
// = true, see pbsConfig.js). Exercises the real Cron path (runScheduledTdxSync)
// end to end — TDX fetch/dedupe/baseline, PBS fetch/lifecycle, the
// crossSourceDedup merge (mergeForBroadcast), and the actual LINE push —
// so these tests prove what a real Cron tick does, not just the merge
// function in isolation (that's covered separately in
// pbsCrossSourceDedup.test.js).
//
// Single Alpha subscriber throughout (per the task: only one existing
// subscriber, no audience expansion).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { PBS_BROADCAST_ENABLED } from '../src/pbs/pbsConfig.js';

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

// Matches realFreewayEvent (fixtures.js): 國道一號 北向 92K+500-91K+800,
// accident, EffectiveTime 08:12+08:00, LastUpdateTime 08:20+08:00.
function freewayAccidentRaw(overrides = {}) {
  return {
    EventID: 'FRW-2026-0815-001',
    EventTitle: '國道一號北向92K車輛事故',
    EventType: '事故',
    Description: '北向92K處發生車輛事故，外側車道封閉，請小心慢行',
    EffectiveTime: '2026-08-15T08:12:00+08:00',
    LastUpdateTime: '2026-08-15T08:20:00+08:00',
    Location: {
      FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' },
    },
    Impact: { BlockedLanes: 1 },
    // V2.4.5 — service-area gate evidence; official-polygon-confirmed
    // inside 新竹市/新竹縣.
    Positions: [{ PositionLon: 121.0, PositionLat: 24.8 }],
    ...overrides,
  };
}

// Cross-source MATCHES freewayAccidentRaw(): same road/direction/type,
// ~92 KM (within CROSS_SOURCE_MAX_KM_DIFF), updatedAt within
// CROSS_SOURCE_MAX_TIME_DIFF_MS of TDX's LastUpdateTime.
function pbsMatchingAccidentRaw(overrides = {}) {
  return {
    UID: 'PBS-MATCH-1',
    road: '國道一號',
    direction: '北向',
    areaNm: '國道一號北向',
    roadtype: '事故',
    comment: '北向92公里處發生車輛事故，內側車道封閉，回堵中',
    happendate: '2026-08-15',
    happentime: '08:15:00',
    modDttm: '2026-08-15 08:22:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

// Independently Hsinchu-relevant (台68, ~5公里, matches
// realHighwayConstructionEvent's already-verified range) but on a
// completely different road from freewayAccidentRaw — never matches it.
function pbsUniqueAccidentRaw(overrides = {}) {
  return {
    UID: 'PBS-UNIQUE-1',
    road: '台68',
    direction: '東向',
    areaNm: '台68線',
    roadtype: '事故',
    comment: '東向5公里處發生車輛事故，內側車道封閉',
    happendate: '2026-08-15',
    happentime: '08:30:00',
    modDttm: '2026-08-15 08:35:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

function pbsClearedRaw(overrides = {}) {
  return {
    UID: 'PBS-CLEARED-1',
    road: '國道一號',
    direction: '北向',
    areaNm: '國道一號北向',
    roadtype: '事故',
    comment: '北向92公里處車輛事故已排除，車道恢復通行',
    happendate: '2026-08-15',
    happentime: '08:15:00',
    modDttm: '2026-08-15 08:40:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

// Not cleared, but modDttm/happendate are well past PBS_STALE_THRESHOLD_MS
// (2h) before `now` (09:00+08:00 in every test below).
function pbsStaleRaw(overrides = {}) {
  return {
    UID: 'PBS-STALE-1',
    road: '國道一號',
    direction: '北向',
    areaNm: '國道一號北向',
    roadtype: '事故',
    comment: '北向92公里處發生車輛事故',
    happendate: '2026-08-15',
    happentime: '04:00:00',
    modDttm: '2026-08-15 04:05:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

function mockTdxFetch(freewayEvents = []) {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response(JSON.stringify({ RoadEvents: freewayEvents }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS')) {
      return new Response(JSON.stringify({ CMSs: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    throw new Error(`unexpected TDX fetch: ${href}`);
  };
}

function pbsRelay(items) {
  return { fetch: async () => new Response(JSON.stringify(items), { status: 200 }) };
}

function throwingPbsRelay(message = 'relay unavailable') {
  return { fetch: async () => { throw new Error(message); } };
}

const NOW = new Date('2026-08-15T09:00:00+08:00'); // within broadcast hours, single subscriber only

async function withPushCapture(tdxFetch, run) {
  const pushed = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushed.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    return tdxFetch(url, init);
  };
  try {
    return { pushed, result: await run() };
  } finally {
    globalThis.fetch = priorFetch;
  }
}

afterEach(() => resetTdxTokenCache());

test('sanity: PBS_BROADCAST_ENABLED is true this round (Alpha)', () => {
  assert.equal(PBS_BROADCAST_ENABLED, true);
});

test('1. PBS only (no TDX events): one unique active PBS event -> exactly 1 message', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([pbsUniqueAccidentRaw()]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  assert.equal(result.pbs.activeCount, 1);
  assert.equal(result.line.pushSucceeded, 1);
});

test('2. TDX only (no PBS match, PBS relay empty): V2.4.0 — 0 messages via the legacy path (LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT; a TDX event with no PBS corroboration is no longer a legacy broadcast candidate at all — see scheduled.js\'s own V2.4.0 comment on `broadcastEvents`)', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.pbs.activeCount, 0);
  assert.equal(result.line.pushSucceeded, 0);
});

test('3. PBS + TDX describe the SAME incident -> exactly 1 message (canonical merge, not 2)', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([pbsMatchingAccidentRaw()]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1); // NOT 2 — this is the whole point of the merge
  assert.equal(result.pbs.canonicalEventCount, 1);
  assert.equal(result.pbs.crossSourceDuplicateCount, 1);
  // V2.4.8 — V2_4_8_AI_LINE_MESSAGE_EDITOR_AND_UNIFIED_PRESENTATION
  // deliberately REVERSES the old "never show PBS/TDX to the driver"
  // principle this test originally asserted (order section 六/九): a
  // "通報：【來源層級】單位" line is now a REQUIRED, intentional part of
  // every message, precisely so a driver (and a future debugger) can tell
  // which data pipeline an event came in through. The merged canonical
  // event here still carries `source: tdxEvent.source` (crossSourceDedup.js
  // — a real, documented, pre-existing merge convention, unchanged this
  // round), so it correctly shows the TDX reporter line.
  const text = pushed[0].messages[0].text;
  assert.match(text, /通報：【TDX】高公局/);
});

test('4. PBS + TDX describe DIFFERENT incidents -> V2.4.0: exactly 1 message (only PBS\'s own unique event; TDX\'s own unmatched event no longer reaches the legacy path, LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT)', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([pbsUniqueAccidentRaw()]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  assert.equal(result.pbs.canonicalEventCount, 0);
  assert.equal(result.pbs.crossSourceDuplicateCount, 0);
});

test('5. cleared PBS event ("已排除") -> 0 messages, never treated as a new event', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([pbsClearedRaw()]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.pbs.clearedCount, 1);
  assert.equal(result.pbs.activeCount, 0);
});

test('6. stale PBS event (>2h old, not cleared) -> 0 messages', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([pbsStaleRaw()]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.pbs.staleCount, 1);
  assert.equal(result.pbs.activeCount, 0);
});

test('7a. PBS relay throws -> V2.4.0: 0 messages (PBS failure still isolated from TDX\'s own data collection — dedupe.js/pipeline.js still run cleanly, "pbsOk=false" is honestly reported — but TDX no longer has any legacy-path broadcast of its own to protect, LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT; TDX broadcast now flows only through Queue ingress, unaffected by a PBS relay outage either way since the two are fully independent code paths)', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: throwingPbsRelay(),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () => runScheduledTdxSync(env, NOW));

  assert.equal(result.pbs.pbsOk, false);
  assert.equal(pushed.length, 0);
  assert.equal(result.line.pushSucceeded, 0);
});

test('7b. TDX has no data this run (token missing) -> PBS still broadcasts normally', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    // No TDX_CLIENT_ID/TDX_CLIENT_SECRET at all -> every TDX source fails
    // closed with 0 events, but TRAFFIC_KV itself is fine.
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token', PBS_30_MIN_POLLING_ENABLED: true /* V1.9.8: exercise the unchanged PBS pipeline directly */, PBS_RELAY_WINDOWS: pbsRelay([pbsUniqueAccidentRaw()]),
  };

  const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, NOW));

  assert.equal(result.tokenOk, false);
  assert.equal(result.pbs.pbsOk, true);
  assert.equal(pushed.length, 1); // PBS's own event still goes out
  assert.equal(result.line.pushSucceeded, 1);
});
