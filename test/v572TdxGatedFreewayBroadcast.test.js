// V57.2 — "TDX 唯一播報閘門" for 國道 (freeway) events: TDX decides whether
// a 國道 incident broadcasts at all; CCTV (unchanged) decides whether it
// gets an image. A PBS-only 國道 report — no matching TDX event yet, or
// ever — must never push LINE, never enter the Shared Feed, and critically
// must never write notified-state/incident-suppression state that could
// later suppress the real TDX report of the SAME incident.
//
// The actual gate lives in src/pbs/crossSourceDedup.js (see its own
// header comment) — unit-level coverage of the gate itself is in
// test/pbsCrossSourceDedup.test.js. This file exercises the full Cron
// path (runScheduledTdxSync — the same real entry point Production uses)
// end to end, covering the task's required CASEs 1/2/3/5/6/7 (CASE 4 is
// unchanged pre-existing TDX-direct behavior, covered elsewhere; CASE 8
// is test/sharedFeedCctvTopUp.test.js, run unmodified as a regression
// check — see this round's final report).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';

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

function freewayAccidentRaw(overrides = {}) {
  return {
    EventID: 'FRW-97701-1',
    EventTitle: '國道一號北向92K車輛事故',
    EventType: '事故',
    Description: '北向92K處發生車輛事故，外側車道封閉',
    EffectiveTime: '2026-08-20T08:00:00+08:00',
    LastUpdateTime: '2026-08-20T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
    Impact: { BlockedLanes: 1 },
    ...overrides,
  };
}

// A 國道 PBS report with no plausible TDX match at all (a different
// direction/KM from pbsMatchingFreewayRaw/freewayAccidentRaw, and never
// fed a matching TDX event) — the CASE-1/3 shape: "PBS reported, TDX
// never did." KM 100 stays within FREEWAY_RULES's 國道一號 Hsinchu range
// (80-105, see hsinchuConfig.js) so it isn't dropped before ever reaching
// crossSourceDedup.
function pbsFreewayOnlyRaw(overrides = {}) {
  return {
    UID: 'PBS-FRW-ONLY-1',
    road: '國道一號',
    direction: '南向',
    areaNm: '國道一號南向',
    roadtype: '事故',
    comment: '南向100公里處發生車輛事故，內側車道封閉',
    happendate: '2026-08-20',
    happentime: '08:03:00',
    modDttm: '2026-08-20 08:05:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

// Matches freewayAccidentRaw(): same road/direction/~92KM/time window.
function pbsMatchingFreewayRaw(overrides = {}) {
  return {
    UID: 'PBS-FRW-MATCH-1',
    road: '國道一號',
    direction: '北向',
    areaNm: '國道一號北向',
    roadtype: '事故',
    comment: '北向92公里處發生車輛事故，內側車道封閉，回堵中',
    happendate: '2026-08-20',
    happentime: '08:02:00',
    modDttm: '2026-08-20 08:04:00',
    srcdetail: '測試來源',
    ...overrides,
  };
}

// Non-freeway (省道/highway) PBS event — CASE 5: must be completely
// unaffected by the V57.2 gate.
function pbsHighwayOnlyRaw(overrides = {}) {
  return {
    UID: 'PBS-HWY-ONLY-1',
    road: '台68',
    direction: '東向',
    areaNm: '台68線',
    roadtype: '事故',
    comment: '東向5公里處發生車輛事故，內側車道封閉',
    happendate: '2026-08-20',
    happentime: '08:03:00',
    modDttm: '2026-08-20 08:05:00',
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
    throw new Error(`unexpected TDX fetch (must never hit an unmocked source): ${href}`);
  };
}

function pbsRelay(items) {
  return { fetch: async () => new Response(JSON.stringify(items), { status: 200 }) };
}

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

async function envWithSubscriber(TRAFFIC_KV) {
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV };
}

const T0 = new Date('2026-08-20T08:00:00+08:00'); // within broadcast hours

afterEach(() => resetTdxTokenCache());

// ===========================================================================
// CASE 1 — PBS 國道事故單獨出現 -> 0 push / 0 Shared Feed / 0 notified /
// no incident-suppression record / 0 CCTV.
// ===========================================================================

test('CASE 1: PBS-only 國道 accident, no TDX at all -> 0 push, 0 Shared Feed, no incident-suppression record, no notified-state, 0 CCTV', async () => {
  const TRAFFIC_KV = kv();
  const env = { ...(await envWithSubscriber(TRAFFIC_KV)), PBS_RELAY_TOKEN: 'relay-token', PBS_RELAY_WINDOWS: pbsRelay([pbsFreewayOnlyRaw()]) };

  const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, T0));

  assert.equal(pushed.length, 0);
  assert.equal(result.pbs.freewayGatedCount, 1);
  assert.equal(result.pbs.canonicalEventCount, 0);
  assert.equal(result.line.pushSucceeded, 0);
  assert.equal(result.line.completedProducts.length, 0); // never even entered the Shared Feed's own product list
  assert.equal(result.line.cctvImagesAttachedCount, 0);
  assert.equal(result.sharedFeed.eventCount, 0);

  // No incident-suppression record for this road/direction was ever created.
  const suppressionRaw = await TRAFFIC_KV.get('line:incident-suppression-state');
  const suppression = suppressionRaw ? JSON.parse(suppressionRaw) : { incidents: {} };
  assert.deepEqual(suppression.incidents['國道一號|南向'] || [], []);

  // No notified-state entry for this PBS rawId was ever created.
  const notifiedRaw = await TRAFFIC_KV.get('line:notified-state');
  const notified = notifiedRaw ? JSON.parse(notifiedRaw) : { events: {} };
  const keys = Object.keys(notified.events || {});
  assert.ok(!keys.some((k) => k.includes('PBS-FRW-ONLY-1')), `expected no notified-state key for the gated PBS event, got: ${JSON.stringify(keys)}`);
});

// ===========================================================================
// CASE 2 — PBS 國道事故先到，之後 TDX freeway 同事故到 -> PBS 0 push, TDX
// 正常 push 1 次, Shared Feed 為 TDX 正式成品.
// ===========================================================================

test('CASE 2: PBS reports first (no TDX yet), TDX reports the same incident next tick -> PBS never pushes, TDX pushes normally, Shared Feed gets the TDX product', async () => {
  const TRAFFIC_KV = kv();
  const env = await envWithSubscriber(TRAFFIC_KV);

  // Tick 1 (08:00): PBS-only, unmatched (no TDX events this run at all).
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = pbsRelay([pbsMatchingFreewayRaw()]);
  const first = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, T0));
  assert.equal(first.pushed.length, 0);
  assert.equal(first.result.pbs.freewayGatedCount, 1);

  // Tick 2 (09:00): TDX now reports the same incident. PBS relay returns
  // the same report again (still active) — but it now cross-source-
  // matches the fresh TDX event, so it merges into the canonical TDX
  // event instead of being gated a second time. V1.9.3: PBS is now only
  // fetched every 30 minutes (pbsSchedule.js) — 09:00 is the next minute
  // both TDX's 20-minute marks and PBS's 30-minute marks land on
  // together, so this tick genuinely re-fetches PBS too (needed for the
  // cross-source match this assertion checks), not just TDX.
  const second = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () =>
    runScheduledTdxSync(env, new Date('2026-08-20T09:00:00+08:00'))
  );

  assert.equal(second.pushed.length, 1); // exactly one message — the TDX-identity one
  assert.equal(second.result.pbs.canonicalEventCount, 1);
  assert.equal(second.result.line.pushSucceeded, 1);
  assert.equal(second.result.sharedFeed.eventCount, 1); // TDX's own completed product reached the Shared Feed
});

// ===========================================================================
// CASE 3 — PBS 國道事故存在，但 TDX 永遠沒有這筆 -> 經過多輪 scheduled
// processing 仍 0 對外通知，不存在 timeout fallback.
// ===========================================================================

test('CASE 3: PBS reports it, TDX never does, across many ticks -> still 0 external notifications every time, no timeout fallback', async () => {
  const TRAFFIC_KV = kv();
  const env = await envWithSubscriber(TRAFFIC_KV);
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = pbsRelay([pbsFreewayOnlyRaw()]);

  // V1.9.3: every tick here must be a genuine PBS-scheduled minute (see
  // pbsSchedule.js — every 30 minutes, not every 10) so each round really
  // does re-fetch PBS and re-evaluate the gate, proving there's no
  // timeout fallback across REAL repeated PBS fetches, not just repeated
  // Cron ticks that happen to skip PBS entirely.
  const tickTimes = ['08:00', '08:30', '09:00', '09:30', '10:00'].map((t) => new Date(`2026-08-20T${t}:00+08:00`));
  for (const now of tickTimes) {
    const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, now));
    assert.equal(pushed.length, 0, `tick ${now.toISOString()} must push 0`);
    assert.equal(result.pbs.freewayGatedCount, 1, `tick ${now.toISOString()} must gate the PBS event, not time it out into a broadcast`);
  }
});

// ===========================================================================
// CASE 5 — PBS 非國道事件 -> 原本既有行為保持，不因 V57.2 被全面封殺.
// ===========================================================================

test('CASE 5: PBS non-freeway (省道) accident, no TDX match -> broadcasts exactly as before V57.2, unaffected by the gate', async () => {
  const TRAFFIC_KV = kv();
  const env = { ...(await envWithSubscriber(TRAFFIC_KV)), PBS_RELAY_TOKEN: 'relay-token', PBS_RELAY_WINDOWS: pbsRelay([pbsHighwayOnlyRaw()]) };

  const { pushed, result } = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, T0));

  assert.equal(pushed.length, 1);
  assert.equal(result.pbs.freewayGatedCount, 0);
  assert.equal(result.pbs.canonicalEventCount, 0);
  assert.equal(result.line.pushSucceeded, 1);
});

// ===========================================================================
// CASE 6 — PBS freeway 不得污染 suppression：PBS 處理後再送入匹配位置/方向
// 的 TDX freeway，pendingTargets 不得因 PBS 而變 0.
// ===========================================================================

test('CASE 6: after a gated PBS 國道 sighting, a later TDX freeway event at the SAME road/direction/km is a normal new broadcast candidate — pendingTargets is never 0 because of PBS', async () => {
  const TRAFFIC_KV = kv();
  const env = await envWithSubscriber(TRAFFIC_KV);

  // Tick 1: PBS reports 國道一號 北向 ~92K (same location TDX will report
  // next tick), gated (no TDX match this run).
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = pbsRelay([pbsMatchingFreewayRaw()]);
  const first = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, T0));
  assert.equal(first.pushed.length, 0);
  assert.equal(first.result.pbs.freewayGatedCount, 1);

  // Confirm no suppression record exists for this road/direction after
  // the gated PBS sighting — this is the actual thing V57.2 fixes.
  const suppressionRaw = await TRAFFIC_KV.get('line:incident-suppression-state');
  const suppression = suppressionRaw ? JSON.parse(suppressionRaw) : { incidents: {} };
  assert.deepEqual(suppression.incidents['國道一號|北向'] || [], []);

  // Tick 2: TDX now reports the same real incident, at the same road/
  // direction/km PBS already (uselessly) reported. PBS relay returns
  // nothing this tick (already cleared/not re-sent) to isolate the check
  // to "did the EARLIER PBS sighting leave any residue".
  env.PBS_RELAY_WINDOWS = pbsRelay([]);
  const second = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () =>
    runScheduledTdxSync(env, new Date('2026-08-20T08:20:00+08:00'))
  );

  assert.equal(second.result.line.pendingTargetCount, 1); // NOT 0 — never suppressed by the earlier PBS sighting
  assert.equal(second.pushed.length, 1);
  assert.equal(second.result.line.pushSucceeded, 1);
});

// ===========================================================================
// CASE 7 — Shared Feed：PBS-only freeway 不對外；TDX freeway 正常進 Feed.
// ===========================================================================

test('CASE 7: Shared Feed only ever receives the TDX product for a 國道 incident, never a PBS-only one', async () => {
  const TRAFFIC_KV = kv();
  const env = await envWithSubscriber(TRAFFIC_KV);

  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_RELAY_WINDOWS = pbsRelay([pbsFreewayOnlyRaw()]);
  const pbsOnly = await withPushCapture(mockTdxFetch([]), () => runScheduledTdxSync(env, T0));
  assert.equal(pbsOnly.result.sharedFeed.eventCount, 0);

  env.PBS_RELAY_WINDOWS = pbsRelay([]);
  const tdxOnly = await withPushCapture(mockTdxFetch([freewayAccidentRaw()]), () =>
    runScheduledTdxSync(env, new Date('2026-08-20T08:20:00+08:00'))
  );
  assert.equal(tdxOnly.result.sharedFeed.eventCount, 1);
  assert.equal(tdxOnly.result.line.completedProducts[0].event.source, 'freeway');
});
