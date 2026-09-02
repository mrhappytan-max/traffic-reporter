// V1.5: "路況播報員" no longer interrupts for ordinary traffic flow —
// professional drivers already have Google Maps/1968 for that. Only
// genuinely sudden/abnormal events (accident/closure/control/other) are
// broadcast-eligible; pure congestion never is, regardless of severity.
// See broadcastRules.js's isBroadcastEligibleType. That WHITELIST LOGIC
// ITSELF is still fully covered at the unit level in broadcastRules.test.js
// — never touched by V2.4.0, and not re-tested here.
//
// V2.4.0 (TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE) — order section
// 四: LEGACY_TDX_LINE_PIPELINE = RETIRED_FOR_ROADEVENT. This file used to
// exercise broadcastRules.js's whitelist end-to-end via
// runScheduledTdxSync's LEGACY runLineBroadcast path, fed by fetched TDX
// RoadEvents — that wiring is now retired: a TDX freeway/highway event no
// longer reaches `broadcastEvents` inside scheduled.js AT ALL, regardless
// of its own type/eligibility, so it never even reaches broadcastRules.js
// to be judged eligible or ineligible in the first place (see
// scheduled.js's own V2.4.0 comment on `broadcastEvents`). This file is
// repurposed (not deleted — every one of these scenarios is still a real,
// meaningful regression to guard) into exactly what order section 18's
// test 17 asks for: proof that TDX-fetched events of EVERY type never
// reach LINE via this legacy path, whatever their own eligibility would
// have been under the old rules. The new AI-driven path (Queue ingress +
// aiDecisionEngine.js) is where TDX events now get judged — see
// test/tdxQueueIngress.test.js/test/pbsDebugPush.test.js's TDX-branch
// coverage for that.

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

function freewayRaw(overrides = {}) {
  return {
    EventID: 'FRW-1',
    EventType: '事故',
    Description: '北向92K事件',
    EffectiveTime: '2026-08-15T08:12:00+08:00',
    LastUpdateTime: '2026-08-15T08:20:00+08:00',
    Location: { FreeExpressHighway: { Road: '國道一號', Direction: '北向', StartKM: '92K+500', EndKM: '91K+800' } },
    // V2.4.5 — coordinate evidence so resolveTdxHsinchuGeography() can
    // confirm this fixture's geography (matches pbsRawEvent's own
    // 121.0/24.8 elsewhere in this suite, where a same-incident proximity
    // match matters); official-polygon-confirmed inside 新竹市/縣.
    Positions: [{ PositionLon: 121.0, PositionLat: 24.8 }],
    ...overrides,
  };
}

function mockFetch({ freewayEvents = [] }) {
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
    if (href.includes('/Bus/Alert/City/HsinchuCounty') || href.includes('/Bus/Alert/City/Hsinchu')) {
      return new Response(JSON.stringify({ Alerts: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

const NOW = new Date('2026-08-15T09:00:00+08:00');

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

async function baseEnv() {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return {
    TDX_CLIENT_ID: 'id',
    TDX_CLIENT_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_PUSH_POLICY: 'ALL_ELIGIBLE',
    TRAFFIC_KV,
  };
}

afterEach(() => resetTdxTokenCache());

// One parameterized regression per real-world type this file used to
// individually broadcast-test — order test 17's own requirement, applied
// per type so a future accidental re-wiring of any ONE type back into the
// legacy path (not just a blanket regression) would still be caught.
const RETIRED_TDX_LEGACY_SCENARIOS = [
  ['1. pure congestion (壅塞)', { EventID: 'FRW-CONG', EventType: '壅塞', Description: '北向92K壅塞回堵' }],
  ['2. 車多', { EventID: 'FRW-BUSY', EventType: '車多', Description: '北向92K車多' }],
  ['3. accident (事故)', { EventID: 'FRW-ACC', EventType: '事故', Description: '北向92K車輛事故' }],
  ['4. closure (匝道封閉)', { EventID: 'FRW-CLOSE', EventType: '封閉', Description: '8月15日8時至12時北向92K匝道封閉' }],
  ['5. flooding (淹水, classified "other")', { EventID: 'FRW-FLOOD', EventType: '其他', Description: '8月15日8時至12時北向92K路段淹水，請改道' }],
  ['8. construction WITH an impact keyword (車道封閉)', { EventID: 'FRW-CONST-IMPACT', EventType: '施工', Description: '8月15日8時至12時北向92K施工，車道封閉' }],
  ['9. "other" with a recognized anomaly keyword (落石)', { EventID: 'FRW-OTHER-ROCKSLIDE', EventType: '其他', Description: '8月15日8時至12時北向92K路段落石' }],
];

for (const [label, overrides] of RETIRED_TDX_LEGACY_SCENARIOS) {
  test(`${label} -> 0 LINE messages via the legacy path (LEGACY_TDX_LINE_PIPELINE=RETIRED_FOR_ROADEVENT, V2.4.0)`, async () => {
    const env = await baseEnv();
    const raw = freewayRaw(overrides);
    const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

    // Under the old (pre-V2.4.0) legacy pipeline, several of these types
    // (accident/closure/flooding-as-other/construction-with-impact/
    // rockslide-as-other) WOULD have produced exactly 1 LINE message —
    // that is precisely the behavior this test now proves is gone,
    // regardless of the event's own would-have-been eligibility.
    assert.equal(pushed.length, 0, `${label}: TDX must never reach LINE via the legacy Cron path`);
    // The event was still genuinely fetched/classified (dedupe.js still
    // ran) — it simply never reached broadcastRules.js at all, so the
    // legacy eligibility counters stay at their empty defaults, not "1
    // ineligible" — there was no eligibility judgment to make.
    assert.equal(result.line.typeIneligibleCount, 0);
    assert.equal(result.baselineSeedCount, 1); // cold KV -> baseline seed, not 'new'
  });
}

test('6. congestion + accident describing the SAME incident -> still 0 LINE via legacy path (neither ever reaches broadcastRules.js)', async () => {
  const env = await baseEnv();
  const congestionRaw = freewayRaw({ EventID: 'FRW-CONG-SAME', EventType: '壅塞', Description: '北向92K壅塞回堵' });
  const accidentRaw = freewayRaw({ EventID: 'FRW-ACC-SAME', EventType: '事故', Description: '北向92K車輛事故' });

  const { pushed, result } = await withPushCapture(
    mockFetch({ freewayEvents: [congestionRaw, accidentRaw] }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 0);
  assert.equal(result.baselineSeedCount, 2); // cold KV -> baseline seed, not 'new'
});

test('7. PBS + TDX report the SAME accident -> only the PBS side is even a broadcast candidate (TDX corroboration still computed, TDX itself never broadcasts)', async () => {
  const env = await baseEnv();
  env.PBS_RELAY_TOKEN = 'relay-token';
  env.PBS_30_MIN_POLLING_ENABLED = true; // V1.9.8: this file exercises the (unchanged) PBS pipeline via the polling entry point on purpose
  env.PBS_RELAY_WINDOWS = {
    fetch: async () =>
      new Response(
        JSON.stringify([
          {
            UID: 'PBS-ACC-1', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '事故',
            comment: '北向92公里處發生車輛事故', happendate: '2026-08-15', happentime: '08:15:00',
            modDttm: '2026-08-15 08:22:00', srcdetail: '測試來源',
          },
        ]),
        { status: 200 }
      ),
  };
  const accidentRaw = freewayRaw({ EventID: 'FRW-ACC-PBS', EventType: '事故', Description: '北向92K車輛事故，外側車道封閉' });

  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [accidentRaw] }), () => runScheduledTdxSync(env, NOW));

  // PBS's own cross-source matching (V57.2) still runs and still finds
  // the TDX corroboration (canonicalEventCount=1) — that bookkeeping is
  // untouched. But `broadcastEvents` now only ever contains
  // pbsSummary.canonicalEvents/uniquePbsEvents, and PBS's legacy polling
  // pipeline itself is dormant in real Production (resolvePbsPollingEnabled
  // defaults false) — this test explicitly re-enables it (PBS_30_MIN_POLLING_ENABLED)
  // purely to prove the OTHER half of order section 四: PBS's own
  // (already-dormant) legacy fallback is untouched by this round, while
  // TDX's own RoadEvent never reaches LINE on its own right either way.
  assert.equal(result.pbs.canonicalEventCount, 1);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /🚨 交通事故/);
});

// --- V1.5 whitelist refinement scenarios that used to distinguish 0-vs-1
// via broadcastRules.js — now uniformly 0 via this legacy path; the
// whitelist distinction itself remains fully covered in
// broadcastRules.test.js. ---

const RETIRED_TDX_LEGACY_ZERO_SCENARIOS = [
  ['10. routine construction (no impact keyword)', { EventID: 'FRW-CONST-ROUTINE', EventType: '施工', Description: '8月15日8時至12時北向92K路面刨鋪施工' }],
  ['11. unrecognized "other" (no anomaly keyword)', { EventID: 'FRW-OTHER-UNKNOWN', EventType: '其他', Description: '8月15日8時至12時北向92K一般公告事項' }],
];

for (const [label, overrides] of RETIRED_TDX_LEGACY_ZERO_SCENARIOS) {
  test(`${label} -> 0 LINE messages via the legacy path (already 0 under the old rules too, still 0 for a different reason now)`, async () => {
    const env = await baseEnv();
    const raw = freewayRaw(overrides);
    const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

    assert.equal(pushed.length, 0);
    assert.equal(result.line.typeIneligibleCount, 0); // never reached the gate at all, not "reached and was rejected"
    assert.equal(result.baselineSeedCount, 1); // cold KV -> baseline seed, not 'new'
  });
}

// V1.6.1: Bus Alert (both Hsinchu city and county) is no longer fetched
// by the scheduled Cron at all (see scheduled.js's PRODUCTION_TDX_SOURCE_IDS)
// — so a live TDX bus alert can no longer even reach the eligibility gate
// via this path. The 'alert-excluded' rule itself is still fully covered
// at the unit level in broadcastRules.test.js. This test now verifies the
// V1.6.1 guarantee directly: the Cron never requests either Bus Alert
// endpoint, and (as a trivial consequence) never pushes anything from
// bus alert data even if the endpoint were somehow reached.
test('12. bus alert endpoints are never requested by the Cron -> 0 LINE messages (Bus Alert retired from scheduling, V1.6.1)', async () => {
  const env = await baseEnv();
  const priorFetch = globalThis.fetch;
  let pushed = [];
  const requestedUrls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    requestedUrls.push(href);
    if (href.includes('api.line.me')) {
      pushed.push(JSON.parse(init.body).messages[0].text);
      return new Response('{}', { status: 200 });
    }
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('/RoadEvent/LiveEvent/Freeway') || href.includes('/RoadEvent/LiveEvent/Highway')) {
      return new Response(JSON.stringify({ RoadEvents: [] }), { status: 200 });
    }
    // Deliberately NO handler for CMS/Bus Alert here — if the Cron ever
    // requests them again, this throws and fails the test loudly.
    throw new Error(`unexpected fetch: ${href}`);
  };
  let result;
  try {
    result = await runScheduledTdxSync(env, NOW);
  } finally {
    globalThis.fetch = priorFetch;
  }

  assert.ok(!requestedUrls.some((u) => u.includes('/Bus/Alert/City/Hsinchu')));
  assert.ok(!requestedUrls.some((u) => u.includes('/Bus/Alert/City/HsinchuCounty')));
  assert.ok(!requestedUrls.some((u) => u.includes('/Road/Traffic/Live/CMS')));
  assert.equal(pushed.length, 0);
  assert.equal(result.line.ineligibleByReason['alert-excluded'] || 0, 0);
});

test('13. a mixed batch (congestion+construction+other+accident) in one run -> 0 LINE via legacy path, all 4 still correctly fetched/classified', async () => {
  const env = await baseEnv();
  const events = [
    freewayRaw({ EventID: 'FRW-CONG', EventType: '壅塞', Description: '北向92K壅塞' }),
    freewayRaw({ EventID: 'FRW-ROUTINE-CONST', EventType: '施工', Description: '8月15日8時至12時路面刨鋪' }),
    freewayRaw({ EventID: 'FRW-UNKNOWN-OTHER', EventType: '其他', Description: '8月15日8時至12時一般公告' }),
    freewayRaw({ EventID: 'FRW-ACC-OK', EventType: '事故', Description: '北向92K車輛事故' }),
  ];
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: events }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.line.typeIneligibleCount, 0);
  assert.equal(result.baselineSeedCount, 4); // cold KV -> baseline seed, not 'new'
});
