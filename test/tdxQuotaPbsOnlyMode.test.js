// TDX QUOTA PROTECTION — temporary PBS-only mode (2026-08-23).
//
// TDX's API quota was exhausted. TRAFFIC_SOURCE_MODE=PBS_ONLY must stop
// every TDX API call from the Cron path while 警廣 PBS keeps working
// exactly as before.
//
// The assertions that actually matter are the negative ones: a real
// `fetch` recorder is installed and the tests assert it was never called
// for a TDX URL — including the OAuth token endpoint, since a token
// request is itself a TDX API call and would burn quota for a data source
// nothing is going to read.
//
// The reverse direction is asserted too (mode ALL still fetches), because
// a gate that can only be proven to block is a gate nobody can safely
// restore — and restoring is the whole point of doing this as a flag
// rather than a deletion.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import {
  resolveTrafficSourceMode,
  isTdxRuntimeEnabled,
  isTdxCctvEnabled,
  isPbsEnabled,
  describeSourceMode,
  SOURCE_MODE_ALL,
  SOURCE_MODE_PBS_ONLY,
} from '../src/traffic/sourceMode.js';

const TDX_HOST = 'tdx.transportdata.tw';

function kv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: null };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function pbsItem() {
  return {
    id: 'PBS-QUOTA-1',
    areaNm: '中山高速公路-國道１號',
    happenDate: '2026-08-23',
    happenTime: '10:05',
    modDate: '2026-08-23 10:05',
    road: '國道一號',
    direction: '北向',
    comment: '國道一號北向92公里處發生交通事故，佔用外側車道',
  };
}

function pbsRelay(calls, items) {
  return {
    fetch: async () => {
      calls.push(1);
      return new Response(JSON.stringify(items), { status: 200 });
    },
  };
}

/** Records EVERY outbound fetch so "zero TDX calls" is proven, not assumed. */
function recordingFetch(hits, { freewayEvents = [] } = {}) {
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
    if (href.includes('api.line.me')) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
}

async function envFor(mode, pbsCalls, items = []) {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  const env = {
    TDX_CLIENT_ID: 'id',
    TDX_CLIENT_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    TRAFFIC_KV,
    PBS_RELAY_TOKEN: 'relay-token',
    PBS_RELAY_WINDOWS: pbsRelay(pbsCalls, items),
  };
  if (mode !== null) env.TRAFFIC_SOURCE_MODE = mode;
  return env;
}

async function withFetch(hits, opts, run) {
  const prior = globalThis.fetch;
  globalThis.fetch = recordingFetch(hits, opts);
  try {
    return await run();
  } finally {
    globalThis.fetch = prior;
  }
}

const tdxHits = (hits) => hits.filter((h) => h.includes(TDX_HOST));

// A minute-00 tick inside broadcast hours: the schedule would normally
// fetch TDX here, so any absence of TDX calls is caused by the quota gate
// and nothing else.
const TDX_SCHEDULED_TICK = new Date('2026-08-23T10:00:00+08:00');

afterEach(() => resetTdxTokenCache());

// --- required checks 1-4: zero TDX runtime calls ---

test('1-3. PBS_ONLY: Freeway, Highway and CCTV TDX fetches are all 0', async () => {
  const pbsCalls = [];
  const env = await envFor(SOURCE_MODE_PBS_ONLY, pbsCalls, [pbsItem()]);
  const hits = [];

  await withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK));

  assert.deepEqual(tdxHits(hits), [], `no TDX host call may happen in PBS-only mode, saw: ${JSON.stringify(tdxHits(hits))}`);
  assert.equal(hits.filter((h) => h.includes('/RoadEvent/LiveEvent/Freeway')).length, 0);
  assert.equal(hits.filter((h) => h.includes('/RoadEvent/LiveEvent/Highway')).length, 0);
  assert.equal(hits.filter((h) => h.includes('/Road/Traffic/CCTV')).length, 0);
});

test('4. PBS_ONLY: no TDX OAuth token is requested for a disabled source', async () => {
  const pbsCalls = [];
  const env = await envFor(SOURCE_MODE_PBS_ONLY, pbsCalls, [pbsItem()]);
  const hits = [];

  await withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK));

  assert.equal(hits.filter((h) => h.includes('openid-connect/token')).length, 0);
});

// --- required check 5: PBS untouched ---

test('5. PBS_ONLY: PBS ingestion still runs on the same tick', async () => {
  const pbsCalls = [];
  const env = await envFor(SOURCE_MODE_PBS_ONLY, pbsCalls, [pbsItem()]);
  const hits = [];

  const result = await withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK));

  assert.equal(pbsCalls.length, 1, 'PBS must be fetched exactly once, exactly as before');
  assert.ok(result, 'the scheduled run must still return a summary');
});

test('5b. PBS_ONLY: the scheduled run does NOT fail just because TDX is disabled', async () => {
  const pbsCalls = [];
  const env = await envFor(SOURCE_MODE_PBS_ONLY, pbsCalls, [pbsItem()]);
  const hits = [];

  // The contract is "does not throw" — a Cron failure caused by a
  // deliberately disabled source would be a self-inflicted outage.
  await assert.doesNotReject(() => withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK)));
});

// --- required check 6: no-CCTV fallback ---

// 2026-08-23: CCTV is no longer tied to the TDX gate (frames come from
// freeway.gov.tw, metadata from the KV cache — see sourceMode.js's
// isCctvImageEnabled), so PBS_ONLY alone no longer disables it. What this
// check is really about — "a CCTV that cannot run degrades safely to
// text-only instead of throwing" — is unchanged and still worth pinning,
// so it now drives the degrade through the explicit kill switch.
test('6. a disabled CCTV prepare degrades to a safe text-only result, never a throw', async () => {
  const event = {
    source: 'freeway',
    rawId: 'X-1',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '92K+500',
    endKM: '91K+800',
    text: '國道一號北向92K交通事故',
  };
  const env = {
    TRAFFIC_SOURCE_MODE: SOURCE_MODE_PBS_ONLY,
    CCTV_IMAGE_ENABLED: 'false',
    CCTV_IMAGES: {},
    TRAFFIC_KV: kv(),
  };

  const hits = [];
  const out = await withFetch(hits, {}, () => prepareCctvImageForEvent(env, event, new Map()));

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'cctv-image-disabled');
  // The gate must short-circuit BEFORE any I/O: no frame fetch, no TDX call.
  assert.deepEqual(hits, [], 'a disabled CCTV prepare must perform no network I/O at all');
});

// --- required checks 7-8: contracts unchanged ---

test('7-8. PBS_ONLY: Shared Feed and Consumer contract shape are untouched by this change', async () => {
  const pbsCalls = [];
  const env = await envFor(SOURCE_MODE_PBS_ONLY, pbsCalls, [pbsItem()]);
  const hits = [];

  await withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK));

  const raw = await env.TRAFFIC_KV.get('traffic:shared-feed');
  if (raw !== null) {
    const parsed = JSON.parse(raw);
    // The consumer reads schemaVersion + events[]; this change must not
    // alter either. It may legitimately be an empty window.
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion'));
    assert.ok(Array.isArray(parsed.events));
    for (const e of parsed.events) {
      assert.equal(typeof e.eventId, 'string');
      assert.equal(typeof e.fingerprint, 'string');
      assert.equal(typeof e.text, 'string');
      assert.equal(typeof e.updatedAt, 'string');
      // No TDX-sourced product may be newly produced while TDX is off.
      assert.ok(!e.eventId.startsWith('freeway:'), `PBS-only mode must not mint new TDX products: ${e.eventId}`);
      assert.ok(!e.eventId.startsWith('highway:'), `PBS-only mode must not mint new TDX products: ${e.eventId}`);
    }
  }
});

// --- required check 9 + restore safety: the gate is reversible ---

test('9. mode ALL still fetches TDX — the gate is reversible, not a deletion', async () => {
  const pbsCalls = [];
  const env = await envFor(SOURCE_MODE_ALL, pbsCalls, [pbsItem()]);
  const hits = [];

  await withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK));

  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')), 'restoring the flag must restore freeway fetching');
  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Highway')), 'restoring the flag must restore highway fetching');
  assert.equal(pbsCalls.length, 1);
});

test('9b. an ABSENT flag behaves exactly like ALL (a missing var never starves production)', async () => {
  const pbsCalls = [];
  const env = await envFor(null, pbsCalls, [pbsItem()]);
  const hits = [];

  await withFetch(hits, {}, () => runScheduledTdxSync(env, TDX_SCHEDULED_TICK));

  assert.ok(hits.some((h) => h.includes('/RoadEvent/LiveEvent/Freeway')));
});

// V1.9.3 (KV Write Optimization Phase 2) — the 9/1 TDX restore path
// (flipping TRAFFIC_SOURCE_MODE back to ALL/absent) must remain
// completely independent of PBS's own new 30-minute fetch schedule (see
// pbsSchedule.js): restoring TDX must neither couple PBS's cadence to
// TDX's nor accidentally revert PBS to its old 24/7 cadence. A tick that
// is NOT a PBS-scheduled minute (10:10, unlike TDX_SCHEDULED_TICK's
// 10:00) must skip PBS the exact same way whether TDX is ON or OFF.
test('9c (V1.9.3): PBS\'s own 30-minute schedule is identical whether TDX is restored (ALL) or still off (PBS_ONLY) — the two schedules never couple', async () => {
  const offPbsSchedule = new Date('2026-08-23T10:10:00+08:00'); // TDX-scheduled (mod20=0) but NOT PBS-scheduled (mod30=10)

  const pbsCallsAll = [];
  const envAll = await envFor(SOURCE_MODE_ALL, pbsCallsAll, [pbsItem()]);
  await withFetch([], {}, () => runScheduledTdxSync(envAll, offPbsSchedule));
  assert.equal(pbsCallsAll.length, 0, 'mode ALL: PBS still correctly skips a non-PBS-scheduled minute');

  const pbsCallsPbsOnly = [];
  const envPbsOnly = await envFor(SOURCE_MODE_PBS_ONLY, pbsCallsPbsOnly, [pbsItem()]);
  await withFetch([], {}, () => runScheduledTdxSync(envPbsOnly, offPbsSchedule));
  assert.equal(pbsCallsPbsOnly.length, 0, 'mode PBS_ONLY: identical PBS skip behavior — TDX mode never changes PBS\'s own schedule');
});

// --- the resolver itself ---

test('resolver: only the exact PBS_ONLY value disables TDX; PBS is never gated', () => {
  assert.equal(resolveTrafficSourceMode({ TRAFFIC_SOURCE_MODE: 'PBS_ONLY' }), SOURCE_MODE_PBS_ONLY);
  assert.equal(resolveTrafficSourceMode({ TRAFFIC_SOURCE_MODE: '  pbs_only  ' }), SOURCE_MODE_PBS_ONLY);
  assert.equal(resolveTrafficSourceMode({}), SOURCE_MODE_ALL);
  assert.equal(resolveTrafficSourceMode({ TRAFFIC_SOURCE_MODE: 'ALL' }), SOURCE_MODE_ALL);
  // A typo must NOT silently disable TDX, and must not silently enable a
  // half-configured state either — it resolves to ALL and warns.
  assert.equal(resolveTrafficSourceMode({ TRAFFIC_SOURCE_MODE: 'PBS-ONLY' }), SOURCE_MODE_ALL);

  assert.equal(isTdxRuntimeEnabled({ TRAFFIC_SOURCE_MODE: 'PBS_ONLY' }), false);
  assert.equal(isTdxRuntimeEnabled({}), true);
  // CCTV is deliberately NOT gated by this flag any more — see
  // sourceMode.js's isCctvImageEnabled for the evidence (zero TDX calls).
  assert.equal(isTdxCctvEnabled({}), true);
  assert.equal(isTdxCctvEnabled({ TRAFFIC_SOURCE_MODE: 'PBS_ONLY' }), true);

  // PBS can never be switched off by this module, under any value.
  for (const v of ['PBS_ONLY', 'ALL', 'nonsense', undefined]) {
    assert.equal(isPbsEnabled({ TRAFFIC_SOURCE_MODE: v }), true);
  }
});

test('observability: describeSourceMode states the pause reason, not just a boolean', () => {
  const paused = describeSourceMode({ TRAFFIC_SOURCE_MODE: 'PBS_ONLY' });
  assert.equal(paused.trafficSourceMode, SOURCE_MODE_PBS_ONLY);
  assert.equal(paused.tdxRuntimeEnabled, false);
  // CCTV images stay ON while paused (they cost no TDX quota); what stays
  // OFF is refilling the TDX-derived metadata cache from TDX.
  assert.equal(paused.cctvImageEnabled, true);
  assert.equal(paused.tdxCctvMetadataRefreshEnabled, false);
  assert.equal(paused.pbsEnabled, true);
  assert.match(paused.tdxPausedReason, /quota/i);
  assert.match(paused.tdxPausedReason, /sourceMode\.js/, 'the reason must point at the restore entry point');

  const normal = describeSourceMode({});
  assert.equal(normal.trafficSourceMode, SOURCE_MODE_ALL);
  assert.equal(normal.tdxRuntimeEnabled, true);
  assert.equal(normal.tdxPausedReason, null);
});
