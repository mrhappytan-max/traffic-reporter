// V1.5: "路況播報員" no longer interrupts for ordinary traffic flow —
// professional drivers already have Google Maps/1968 for that. Only
// genuinely sudden/abnormal events (accident/closure/control/other) are
// broadcast-eligible; pure congestion never is, regardless of severity.
// See broadcastRules.js's isBroadcastEligibleType.
//
// These exercise the real Cron path end to end (runScheduledTdxSync),
// same style as pbsLineBroadcast.test.js/congestionValidationIntegration.test.js.

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
    // 2026-08-23: this file pins broadcastRules.js's V1.5 eligibility
    // whitelist, which the 重大事故限定 push policy did NOT change. The
    // policy is a separate layer on top (broadcastPolicy.js), so these
    // cases opt into ALL_ELIGIBLE to keep testing the whitelist itself
    // rather than silently re-testing the policy. Production runs
    // MAJOR_ACCIDENT_ONLY — that behaviour is pinned in
    // test/pbsCctvMajorAccidentOnly.test.js.
  return {
    TDX_CLIENT_ID: 'id',
    TDX_CLIENT_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_PUSH_POLICY: 'ALL_ELIGIBLE',
    TRAFFIC_KV,
  };
}

afterEach(() => resetTdxTokenCache());

test('1. pure congestion (壅塞) -> 0 LINE messages', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({ EventID: 'FRW-CONG', EventType: '壅塞', Description: '北向92K壅塞回堵' });
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.line.typeIneligibleCount, 1);
});

test('2. 車多 -> 0 LINE messages', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({ EventID: 'FRW-BUSY', EventType: '車多', Description: '北向92K車多' });
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.line.typeIneligibleCount, 1);
});

test('3. accident -> 1 LINE message', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({ EventID: 'FRW-ACC', EventType: '事故', Description: '北向92K車輛事故' });
  const { pushed } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /🚨 交通事故/);
});

test('4. closure (匝道封閉) -> 1 LINE message', async () => {
  const env = await baseEnv();
  // closure is not a LIVE event type (only accident/congestion are — see
  // effectiveWindow.js), so it needs a parseable Chinese date range in
  // the description to become broadcast-relevant — same requirement as
  // the project's existing construction/closure/control tests (see
  // broadcastPipeline.test.js #20).
  const raw = freewayRaw({ EventID: 'FRW-CLOSE', EventType: '封閉', Description: '8月15日8時至12時北向92K匝道封閉' });
  const { pushed } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /🚧 道路封閉/);
});

test('5. flooding (淹水) -> classifies as "other", still 1 LINE message', async () => {
  const env = await baseEnv();
  // No accident/construction/closure/control/congestion keyword at all —
  // TDX's own classify.js has no dedicated flooding pattern, so this
  // (correctly, per the existing "寧可不亂猜" classification design)
  // falls through to 'other', which stays broadcast-eligible. 'other' is
  // also not a LIVE type, so it needs the same parseable date range.
  const raw = freewayRaw({ EventID: 'FRW-FLOOD', EventType: '其他', Description: '8月15日8時至12時北向92K路段淹水，請改道' });
  const { pushed } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  // V1.8.6.4: messageFormat.js now gives a recognized 'other' anomaly its
  // own specific headline instead of the old generic "ℹ️ 路況異常" — see
  // test/provincialRoadMessageClarity.test.js for the dedicated coverage.
  // `event.type` itself is still plain 'other', unchanged — this is a
  // display-only refinement, still gated by the same eligibility rule.
  assert.match(pushed[0], /🌊 道路積水/);
});

test('6. congestion + accident describing the SAME incident -> exactly 1 LINE message, framed as the accident', async () => {
  const env = await baseEnv();
  // Two separate TDX records for the same real spot: one tagged 壅塞, one
  // tagged 事故 — TDX/PBS never merge same-source-different-type records
  // into one, so both flow through as independent unified events; the
  // congestion one is excluded at the broadcast-eligibility gate, the
  // accident one broadcasts normally on its own.
  const congestionRaw = freewayRaw({ EventID: 'FRW-CONG-SAME', EventType: '壅塞', Description: '北向92K壅塞回堵' });
  const accidentRaw = freewayRaw({ EventID: 'FRW-ACC-SAME', EventType: '事故', Description: '北向92K車輛事故' });

  const { pushed, result } = await withPushCapture(
    mockFetch({ freewayEvents: [congestionRaw, accidentRaw] }),
    () => runScheduledTdxSync(env, NOW)
  );

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /🚨 交通事故/);
  assert.equal(result.line.typeIneligibleCount, 1); // the congestion record, and only that one
});

test('7. PBS + TDX report the SAME accident -> exactly 1 LINE message (cross-source dedup unaffected)', async () => {
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

  assert.equal(pushed.length, 1);
  assert.equal(result.pbs.canonicalEventCount, 1);
  assert.match(pushed[0], /🚨 交通事故/);
});

// --- V1.5 whitelist refinement: construction/other are now conditional, alert defaults off ---

test('8. routine construction (no impact keyword) -> 0 LINE messages', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({
    EventID: 'FRW-CONST-ROUTINE', EventType: '施工',
    Description: '8月15日8時至12時北向92K路面刨鋪施工',
  });
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.line.ineligibleByReason['construction-no-impact-keyword'], 1);
});

test('9. construction WITH an impact keyword (車道封閉) -> 1 LINE message', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({
    EventID: 'FRW-CONST-IMPACT', EventType: '施工',
    Description: '8月15日8時至12時北向92K施工，車道封閉',
  });
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /🚧 道路施工/);
  assert.equal(result.line.ineligibleByReason['construction-no-impact-keyword'] || 0, 0);
});

test('10. unrecognized "other" (no anomaly keyword) -> 0 LINE messages', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({
    EventID: 'FRW-OTHER-UNKNOWN', EventType: '其他',
    Description: '8月15日8時至12時北向92K一般公告事項',
  });
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 0);
  assert.equal(result.line.ineligibleByReason['other-no-anomaly-keyword'], 1);
});

test('11. "other" with a recognized anomaly keyword (落石) -> 1 LINE message', async () => {
  const env = await baseEnv();
  const raw = freewayRaw({
    EventID: 'FRW-OTHER-ROCKSLIDE', EventType: '其他',
    Description: '8月15日8時至12時北向92K路段落石',
  });
  const { pushed } = await withPushCapture(mockFetch({ freewayEvents: [raw] }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  // V1.8.6.4: specific anomaly headline (⛰️ 落石), not the old generic
  // "ℹ️ 路況異常" — see test/provincialRoadMessageClarity.test.js.
  assert.match(pushed[0], /⛰️ 落石/);
});

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

test('13. ineligibleByReason breaks down multiple exclusion reasons correctly in one run', async () => {
  const env = await baseEnv();
  const events = [
    freewayRaw({ EventID: 'FRW-CONG', EventType: '壅塞', Description: '北向92K壅塞' }),
    freewayRaw({ EventID: 'FRW-ROUTINE-CONST', EventType: '施工', Description: '8月15日8時至12時路面刨鋪' }),
    freewayRaw({ EventID: 'FRW-UNKNOWN-OTHER', EventType: '其他', Description: '8月15日8時至12時一般公告' }),
    freewayRaw({ EventID: 'FRW-ACC-OK', EventType: '事故', Description: '北向92K車輛事故' }),
  ];
  const { pushed, result } = await withPushCapture(mockFetch({ freewayEvents: events }), () => runScheduledTdxSync(env, NOW));

  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /🚨 交通事故/);
  assert.equal(result.line.ineligibleByReason['congestion-excluded'], 1);
  assert.equal(result.line.ineligibleByReason['construction-no-impact-keyword'], 1);
  assert.equal(result.line.ineligibleByReason['other-no-anomaly-keyword'], 1);
  assert.equal(result.line.typeIneligibleCount, 3);
});
