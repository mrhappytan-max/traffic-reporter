// V1.6.1 — "資料來源與 TDX 用量瘦身". Exercises the real Cron path
// (runScheduledTdxSync) end to end for the required acceptance scenarios:
// TDX (國道+省道 only) is fetched at most every 20 minutes (minute
// 00/20/40), only 08:00–21:59:59 Asia/Taipei; PBS keeps running every
// tick, 24/7; CMS/Bus Alert/VD static+live must never receive a
// scheduled request at all; a skipped/sleeping TDX tick must never be
// misread as a TDX failure in the health snapshot; TDX/PBS failures stay
// isolated from each other exactly as before this round.
//
// Unit-level coverage of the pure schedule decision itself lives in
// tdxSchedule.test.js — this file is the integration-level regression
// guard.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { readHealthSnapshot } from '../src/traffic/healthSnapshot.js';
import { getTdxScheduleState } from '../src/traffic/tdxSchedule.js';
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

function freewayRaw(overrides = {}) {
  return {
    EventID: 'FRW-1',
    EventType: '事故',
    Description: '北向92K事件',
    EffectiveTime: '2026-08-18T08:00:00+08:00',
    LastUpdateTime: '2026-08-18T08:00:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
    ...overrides,
  };
}

// Records every URL actually requested on the TDX side (including the
// OAuth token endpoint) — a skip/sleep tick must produce ZERO entries
// here, not just zero RoadEvent entries.
function trackingTdxFetch(hits, { freewayStatus = 200, highwayStatus = 200, freewayEvents = [] } = {}) {
  return async (url) => {
    const href = String(url);
    hits.push(href);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Freeway')) {
      if (freewayStatus !== 200) return new Response('err', { status: freewayStatus });
      return new Response(JSON.stringify({ RoadEvents: freewayEvents }), { status: 200 });
    }
    if (href.includes('/RoadEvent/LiveEvent/Highway')) {
      if (highwayStatus !== 200) return new Response('err', { status: highwayStatus });
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/Live/CMS')) {
      return new Response(JSON.stringify({ CMSs: [] }), { status: 200 });
    }
    if (href.includes('/Bus/Alert/City/HsinchuCounty') || href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/VD/Freeway') || href.includes('/Road/Traffic/Live/VD/Freeway')) {
      return new Response(JSON.stringify({}), { status: 200 });
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

function throwingPbsRelay(calls, message = 'relay unavailable') {
  return {
    fetch: async () => {
      calls.push(1);
      throw new Error(message);
    },
  };
}

async function envWithPbs(pbsCalls, items = []) {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return {
    TDX_CLIENT_ID: 'id',
    TDX_CLIENT_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token',
    PBS_RELAY_WINDOWS: pbsRelay(pbsCalls, items),
  };
}

function taipei(iso) {
  return new Date(iso);
}

async function withTdxFetch(hits, opts, run) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = trackingTdxFetch(hits, opts);
  try {
    return await run();
  } finally {
    globalThis.fetch = priorFetch;
  }
}

afterEach(() => resetTdxTokenCache());

// --- 1-9: the schedule matrix from the task's 驗收 list ---

test('1. 08:00 -> PBS + 國道 + 省道 both run', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T08:00:00+08:00')));

  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')));
  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Highway')));
  assert.equal(pbsCalls.length, 1);
});

test('2. 08:10 -> PBS only, TDX makes 0 requests', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T08:10:00+08:00')));

  assert.equal(hits.length, 0);
  assert.equal(pbsCalls.length, 1);
});

test('3. 08:20 -> PBS + TDX both run again', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T08:20:00+08:00')));

  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')));
  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Highway')));
  assert.equal(pbsCalls.length, 1);
});

test('4. 21:40 -> PBS + TDX (last daytime tick of the day)', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T21:40:00+08:00')));

  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')));
  assert.equal(pbsCalls.length, 1);
});

test('5. 21:50 -> PBS only', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T21:50:00+08:00')));

  assert.equal(hits.length, 0);
  assert.equal(pbsCalls.length, 1);
});

test('6. 22:00 -> PBS only, TDX enters night-sleep', async () => {
  assert.equal(getTdxScheduleState(taipei('2026-08-18T22:00:00+08:00')), 'night-sleep');

  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T22:00:00+08:00')));

  assert.equal(hits.length, 0);
  assert.equal(pbsCalls.length, 1);
});

test('7. 03:00 -> PBS only (deep night)', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T03:00:00+08:00')));

  assert.equal(hits.length, 0);
  assert.equal(pbsCalls.length, 1);
});

test('8. 07:50 -> PBS only (just before daytime starts)', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-18T07:50:00+08:00')));

  assert.equal(hits.length, 0);
  assert.equal(pbsCalls.length, 1);
});

test('9. next day 08:00 -> TDX resumes', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, () => runScheduledTdxSync(env, taipei('2026-08-19T08:00:00+08:00')));

  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')));
  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Highway')));
  assert.equal(pbsCalls.length, 1);
});

// --- 10-12: CMS / Bus Alert / VD must never receive a scheduled request ---

test('10. CMS never receives a scheduled request, across a full day/night sweep', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, async () => {
    for (const t of ['08:00', '08:10', '08:20', '21:40', '21:50', '22:00']) {
      await runScheduledTdxSync(env, taipei(`2026-08-18T${t}:00+08:00`));
    }
    await runScheduledTdxSync(env, taipei('2026-08-18T03:00:00+08:00'));
  });

  assert.ok(!hits.some((h) => h.includes('/Road/Traffic/Live/CMS')));
});

test('11. Bus Alert (Hsinchu city + county) never receives a scheduled request, across a full day/night sweep', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, async () => {
    for (const t of ['08:00', '08:10', '08:20', '21:40', '21:50', '22:00']) {
      await runScheduledTdxSync(env, taipei(`2026-08-18T${t}:00+08:00`));
    }
    await runScheduledTdxSync(env, taipei('2026-08-18T03:00:00+08:00'));
  });

  assert.ok(!hits.some((h) => h.includes('/Bus/Alert/City/Hsinchu')));
  assert.ok(!hits.some((h) => h.includes('/Bus/Alert/City/HsinchuCounty')));
});

test('12. VD static/live never receives a scheduled request, even with a congestion event present', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  // A pure congestion event this tick — under the OLD design this would
  // have triggered an extra VD confirmation call; V1.6.1 removes that
  // call from the Cron path entirely (see scheduled.js).
  const congestionRaw = freewayRaw({ EventID: 'FRW-CONG', EventType: '壅塞', Description: '北向92K壅塞回堵' });
  await withTdxFetch(hits, { freewayEvents: [congestionRaw] }, () =>
    runScheduledTdxSync(env, taipei('2026-08-18T08:00:00+08:00'))
  );

  assert.ok(!hits.some((h) => h.includes('/Road/Traffic/VD/Freeway')));
  assert.ok(!hits.some((h) => h.includes('/Road/Traffic/Live/VD/Freeway')));
});

// --- 13-15: health snapshot must correctly distinguish skip/sleep from a real TDX failure ---

test('13. 09:10 TDX skipped-by-schedule -> /health must not show degraded/critical because of the skip alone', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, async () => {
    await runScheduledTdxSync(env, taipei('2026-08-18T09:00:00+08:00')); // real, healthy fetch
    await runScheduledTdxSync(env, taipei('2026-08-18T09:10:00+08:00')); // skipped-by-schedule
  });

  const { snapshot } = await readHealthSnapshot(env.TRAFFIC_KV);
  assert.equal(snapshot.tdx.scheduledThisRun, false);
  assert.equal(snapshot.tdx.sleeping, false);
  // Carried forward from the healthy 09:00 fetch — 2/2 sources ok.
  assert.equal(snapshot.tdx.successfulSourceCount, 2);
  assert.equal(snapshot.tdx.totalSourceCount, 2);
  assert.equal(snapshot.status, 'normal');
});

test('14. night-sleep tick -> /health must not show degraded/critical because TDX is sleeping', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, {}, async () => {
    await runScheduledTdxSync(env, taipei('2026-08-18T21:40:00+08:00')); // last real daytime fetch, healthy
    await runScheduledTdxSync(env, taipei('2026-08-18T22:00:00+08:00')); // night-sleep
  });

  const { snapshot } = await readHealthSnapshot(env.TRAFFIC_KV);
  assert.equal(snapshot.tdx.sleeping, true);
  assert.equal(snapshot.tdx.scheduledThisRun, false);
  assert.equal(snapshot.tdx.successfulSourceCount, 2); // carried forward, still healthy
  assert.equal(snapshot.status, 'normal');
});

test('15. a REAL TDX fetch returning 429 -> /health correctly shows degraded (only a genuine failure does this)', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  const hits = [];
  await withTdxFetch(hits, { freewayStatus: 429 }, () =>
    runScheduledTdxSync(env, taipei('2026-08-18T08:20:00+08:00'))
  );

  const { snapshot } = await readHealthSnapshot(env.TRAFFIC_KV);
  assert.equal(snapshot.tdx.scheduledThisRun, true);
  assert.equal(snapshot.tdx.successfulSourceCount, 1);
  assert.equal(snapshot.tdx.totalSourceCount, 2);
  assert.equal(snapshot.status, 'degraded');
  const freewaySource = snapshot.tdx.sources.find((s) => s.source === 'freeway');
  assert.equal(freewaySource.ok, false);
  assert.equal(freewaySource.httpStatus, 429);
});

// --- 16-17: TDX/PBS failure isolation, unchanged by this round's restructuring ---

test('16. PBS relay throws -> TDX still fetches and still broadcasts normally', async () => {
  const pbsCalls = [];
  const env = await envWithPbs(pbsCalls);
  env.PBS_RELAY_WINDOWS = throwingPbsRelay(pbsCalls);
  const hits = [];
  const pushed = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushed.push(1);
      return new Response('{}', { status: 200 });
    }
    return trackingTdxFetch(hits, { freewayEvents: [freewayRaw()] })(url, init);
  };
  let result;
  try {
    result = await runScheduledTdxSync(env, taipei('2026-08-18T08:20:00+08:00'));
  } finally {
    globalThis.fetch = priorFetch;
  }

  assert.equal(result.pbs.pbsOk, false);
  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')));
  assert.equal(pushed.length, 1); // the TDX accident still went out
});

test('17. TDX freeway+highway both fail -> PBS still fetches and still broadcasts normally', async () => {
  const pbsCalls = [];
  // V57.2: a 國道 PBS event with no TDX match is now gated (never
  // broadcast) regardless of why it's unmatched — see
  // crossSourceDedup.js's own header comment. This test's actual point
  // (PBS pipeline resilience when TDX fails) is unrelated to that rule,
  // so it uses a 省道/highway fixture (unaffected by the V57.2 gate),
  // same fixture choice already used for this exact scenario in
  // test/pbsLineBroadcast.test.js's test 7b.
  const env = await envWithPbs(pbsCalls, [
    {
      UID: 'PBS-1', road: '台68', direction: '東向', areaNm: '台68線', roadtype: '事故',
      comment: '東向5公里處發生車輛事故', happendate: '2026-08-18', happentime: '08:15:00',
      modDttm: '2026-08-18 08:19:00', srcdetail: '測試來源',
    },
  ]);
  const hits = [];
  const pushed = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.line.me')) {
      pushed.push(1);
      return new Response('{}', { status: 200 });
    }
    return trackingTdxFetch(hits, { freewayStatus: 500, highwayStatus: 500 })(url, init);
  };
  let result;
  try {
    result = await runScheduledTdxSync(env, taipei('2026-08-18T08:20:00+08:00'));
  } finally {
    globalThis.fetch = priorFetch;
  }

  assert.equal(result.failedSources.length, 2);
  assert.equal(pbsCalls.length, 1);
  assert.equal(pushed.length, 1); // the PBS accident still went out
});
