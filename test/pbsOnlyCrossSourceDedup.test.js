// V1.6.2 — fixes the PBS-only tick cross-source dedup gap: TDX
// (freeway+highway) is only fetched every 20 minutes (see
// tdxSchedule.js), so a PBS-only tick (08:10/08:30/08:50 etc.) has
// summary.allEvents === [] this run — without a fix, PBS could never
// cross-source-dedup against the SAME real incident TDX saw 10-20
// minutes earlier, and would broadcast it again as if new. See
// tdxEventCache.js for the fix and scheduled.js for how it's wired in.
//
// Covers the task's required scenarios E-H:
//   E. PBS-only tick uses a <=30-min cached TDX event for cross-source dedup
//   F. A >30-min-old cached TDX event is NOT used (as of V57.2: for a
//      國道 PBS event, this means gated/not-broadcast, not "broadcast as
//      new" — see crossSourceDedup.js's own header comment)
//   G. The cached TDX event is used ONLY for cross-source dedup — never
//      creates a TDX new/updated event
//   H. Night-sleep tick: PBS fetches normally, TDX still makes 0 calls

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { persistProductionTdxEventCache } from '../src/traffic/tdxEventCache.js';

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

// Matches pbsMatchingAccidentRaw() below: same road/direction/~92KM,
// updatedAt within CROSS_SOURCE_MAX_TIME_DIFF_MS.
function freewayAccidentRaw(overrides = {}) {
  return {
    EventID: 'FRW-97700-1',
    EventType: '事故',
    Description: '北向92K處發生車輛事故，外側車道封閉',
    EffectiveTime: '2026-08-18T08:00:00+08:00',
    LastUpdateTime: '2026-08-18T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
    Impact: { BlockedLanes: 1 },
    ...overrides,
  };
}

function pbsMatchingAccidentRaw(overrides = {}) {
  return {
    UID: 'PBS-MATCH-1',
    road: '國道一號',
    direction: '北向',
    areaNm: '國道一號北向',
    roadtype: '事故',
    comment: '北向92公里處發生車輛事故，內側車道封閉，回堵中',
    happendate: '2026-08-18',
    happentime: '08:08:00',
    modDttm: '2026-08-18 08:09:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

function trackingTdxFetch(hits, { freewayEvents = [] } = {}) {
  return async (url) => {
    const href = String(url);
    hits.push(href);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      return new Response(JSON.stringify({ RoadEvents: freewayEvents }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    throw new Error(`unexpected TDX-side fetch: ${href}`);
  };
}

function pbsRelay(calls, items = []) {
  return {
    fetch: async () => {
      calls.push(1);
      return new Response(JSON.stringify(items), { status: 200 });
    },
  };
}

async function envWithSubscriber() {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV };
}

function taipei(iso) {
  return new Date(iso);
}

async function withPushCapture(tdxFetch, run) {
  const pushed = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.line.me')) {
      pushed.push(JSON.parse(init.body).messages[0].text);
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

// --- E. PBS-only tick uses a <=30-min cached TDX event for cross-source dedup ---

test('E. 08:00 TDX sees the accident; 08:10 PBS reports the SAME accident -> not re-broadcast (cross-source dedup via cache)', async () => {
  const env = await envWithSubscriber();
  const pbsCalls = [];

  const hits08_00 = [];
  const first = await withPushCapture(trackingTdxFetch(hits08_00, { freewayEvents: [freewayAccidentRaw()] }), () => {
    env.PBS_RELAY_TOKEN = 'relay-token';
    env.PBS_RELAY_WINDOWS = pbsRelay(pbsCalls, []); // no PBS match yet at 08:00
    return runScheduledTdxSync(env, taipei('2026-08-18T08:00:00+08:00'));
  });
  assert.equal(first.pushed.length, 1); // TDX accident broadcast once

  // V1.9.3: PBS itself is now only fetched every 30 minutes (see
  // pbsSchedule.js) — 08:30 (not 08:10) is the next minute that's a real
  // PBS fetch AND still a TDX skip, so this tick genuinely exercises a
  // real PBS-side cross-source-dedup match against the cached TDX event.
  const hits08_30 = [];
  const second = await withPushCapture(trackingTdxFetch(hits08_30, { freewayEvents: [] }), () => {
    env.PBS_RELAY_WINDOWS = pbsRelay(pbsCalls, [pbsMatchingAccidentRaw()]); // PBS now reports the same accident
    return runScheduledTdxSync(env, taipei('2026-08-18T08:30:00+08:00'));
  });

  assert.equal(hits08_30.length, 0); // PBS-only tick: 0 TDX calls
  assert.equal(second.pushed.length, 0); // NOT re-broadcast — already seen at 08:00
  assert.equal(second.result.pbs.crossSourceDuplicateCount, 1); // matched the cached TDX event
});

// --- F. A >30-min-old cached TDX event is NOT used ---

test('F. a >30-min-old cached TDX event is ignored -> a 國道 PBS event is NOT broadcast (V57.2: TDX-only gate for 國道, no PBS fallback)', async () => {
  const env = await envWithSubscriber();
  const pbsCalls = [];
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = pbsRelay(pbsCalls, [pbsMatchingAccidentRaw()]);

  // Seed a cache entry directly, 40 minutes before the tick under test —
  // simulates "TDX's last successful fetch was a while ago and hasn't
  // refreshed since" without needing to orchestrate many intermediate ticks.
  const staleWrittenAt = taipei('2026-08-18T07:30:00+08:00');
  await persistProductionTdxEventCache(env.TRAFFIC_KV, [
    {
      source: 'freeway', rawId: 'FRW-97700-1', type: 'accident', road: '國道一號', direction: '北向',
      startKM: 92.5, endKM: 91.8, updatedAt: '2026-08-18T07:30:00.000Z', startTime: '2026-08-18T07:30:00.000Z',
    },
  ], staleWrittenAt);

  // V1.9.3: 08:30, not 08:10 — the next minute that is both a genuine PBS
  // fetch (pbsSchedule.js: every 30 min) and still a TDX skip.
  const hits = [];
  const { pushed, result } = await withPushCapture(trackingTdxFetch(hits, { freewayEvents: [] }), () =>
    runScheduledTdxSync(env, taipei('2026-08-18T08:30:00+08:00')) // 60 min after the cache was written
  );

  assert.equal(hits.length, 0); // still a PBS-only tick: 0 TDX calls
  assert.equal(result.pbs.crossSourceDuplicateCount, 0); // stale cache -> no match at all
  // V57.2: this is a 國道 PBS event (road: 國道一號) — unmatched means
  // gated, never broadcast, regardless of how it got unmatched (stale
  // cache here; genuinely never-reported by TDX in other scenarios).
  assert.equal(pushed.length, 0);
  assert.equal(result.pbs.freewayGatedCount, 1);
});

// --- G. cached TDX event used ONLY for cross-source dedup, never creates a TDX new/update ---

test('G. a PBS-only tick with a cache match never produces a TDX new/updated event', async () => {
  const env = await envWithSubscriber();
  const pbsCalls = [];

  const hitsFirst = [];
  await withPushCapture(trackingTdxFetch(hitsFirst, { freewayEvents: [freewayAccidentRaw()] }), () => {
    env.PBS_RELAY_TOKEN = 'relay-token';
    env.PBS_RELAY_WINDOWS = pbsRelay(pbsCalls, []);
    return runScheduledTdxSync(env, taipei('2026-08-18T08:00:00+08:00'));
  });

  const hitsSecond = [];
  const { result } = await withPushCapture(trackingTdxFetch(hitsSecond, { freewayEvents: [] }), () => {
    env.PBS_RELAY_WINDOWS = pbsRelay(pbsCalls, [pbsMatchingAccidentRaw()]);
    return runScheduledTdxSync(env, taipei('2026-08-18T08:10:00+08:00'));
  });

  // TDX's own classification is untouched by the cache — this tick made
  // no TDX fetch at all, so it can only ever report 0 here.
  assert.equal(result.newEventsCount, 0);
  assert.equal(result.updatedEventsCount, 0);
  assert.equal(result.pushableEventsCount, 0);
});

// --- H. Night-sleep tick: PBS fetches normally, TDX still 0 calls ---

test('H. night-sleep tick -> BOTH TDX and PBS make 0 calls (V1.9.3: PBS is no longer 24/7 either, see pbsSchedule.js)', async () => {
  const env = await envWithSubscriber();
  const pbsCalls = [];
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = pbsRelay(pbsCalls, []);

  const hits = [];
  await withPushCapture(trackingTdxFetch(hits, {}), () => runScheduledTdxSync(env, taipei('2026-08-18T23:00:00+08:00')));

  assert.equal(hits.length, 0);
  assert.equal(pbsCalls.length, 0); // pre-V1.9.3 this was 1 (PBS ran 24/7) — now correctly 0, 23:00 is within PBS's own 22:10-06:50 night-sleep window
});
