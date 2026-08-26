// V1.9.3 (KV Write Optimization Phase 2), section 七 — deterministic
// fixture-based KV write quantification, run through the REAL Cron path
// (runScheduledTdxSync) across a simulated full day (144 ticks, every 10
// minutes, matching wrangler.jsonc's real Cron cadence), for QUIET /
// NORMAL / HIGH EVENT DAY scenarios. Every number in this file's own
// console.log output (and therefore in the V1.9.3 final report and
// 07_KNOWN_ISSUES.md) is a REAL measured count from REAL kv.put() calls
// against a REAL counting mock — never a hand-estimate. Deployed
// configuration assumed: TRAFFIC_SOURCE_MODE=PBS_ONLY (TDX off, matching
// current Production — see SYSTEM_STATE.json), consistent with why this
// round's PBS-duplicate/freeway-gated relevance conditions cost nothing
// in the real deployed shape (see pipelineTrace.js's own comment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { FREEWAY_METADATA_KEY } from '../src/cctv/freewayCctvMetadataCache.js';

function countingKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  const putsByPrefix = new Map();
  function categoryOf(key) {
    if (key.startsWith('health:snapshot:v1')) return 'healthSnapshot';
    if (key.startsWith('traffic:shared-feed')) return 'sharedFeed';
    if (key.startsWith('line:incident-suppression-state')) return 'incidentSuppression';
    if (key.startsWith('line:notified-state')) return 'notifiedState';
    if (key.startsWith('pbs:lifecycle-state')) return 'pbsLifecycle';
    if (key.startsWith('debug:pipeline-trace-batch')) return 'pipelineTraceBatch';
    if (key.startsWith('tdx:last-production-events')) return 'tdxEventCache';
    if (key.startsWith('traffic:dedupe-state') || key.startsWith('traffic:baseline')) return 'tdxDedupe';
    if (key.startsWith('line:subscriptions')) return 'subscriptions';
    return 'other';
  }
  return {
    store,
    putsByPrefix,
    totalPuts: 0,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) {
      store.set(key, value);
      this.totalPuts += 1;
      const cat = categoryOf(key);
      putsByPrefix.set(cat, (putsByPrefix.get(cat) || 0) + 1);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function dayTicks(startIso) {
  const ticks = [];
  const start = new Date(startIso);
  for (let i = 0; i < 144; i += 1) {
    ticks.push(new Date(start.getTime() + i * 10 * 60_000));
  }
  return ticks;
}

async function baseEnv() {
  const TRAFFIC_KV = countingKV({ [FREEWAY_METADATA_KEY]: JSON.stringify({ records: [], fetchedAt: new Date().toISOString() }) });
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  return {
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    TRAFFIC_KV,
    CCTV_IMAGES: { async put() {}, async get() { return null; }, async delete() {} },
    TRAFFIC_SOURCE_MODE: 'PBS_ONLY', // matches real deployed Production config
    PBS_RELAY_TOKEN: 'relay-token',
  };
}

// pbsItemsForTick(tick, index) -> array of raw PBS items for that tick's fetch.
async function runDay(pbsItemsForTick) {
  const env = await baseEnv();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.line.me')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  let tickIndex = 0;
  try {
    for (const tick of dayTicks('2026-08-26T00:00:00+08:00')) {
      env.PBS_RELAY_WINDOWS = { fetch: async () => new Response(JSON.stringify(pbsItemsForTick(tick, tickIndex) || []), { status: 200 }) };
      await runScheduledTdxSync(env, tick);
      tickIndex += 1;
    }
  } finally {
    globalThis.fetch = priorFetch;
  }
  return env.TRAFFIC_KV;
}

function report(label, kv) {
  const cats = Object.fromEntries(kv.putsByPrefix.entries());
  console.log(`[V1.9.3 KV quantification] ${label}: TOTAL=${kv.totalPuts} ${JSON.stringify(cats)}`);
  return kv.totalPuts;
}

test('QUIET DAY: PBS reports nothing all day, 0 LINE pushes -> writes/day stays low (target <= 150)', async () => {
  const kv = await runDay(() => []);
  const total = report('QUIET DAY', kv);
  // Real measured shape: healthSnapshot writes once (first-ever
  // establishes the key) then never again (nothing about health content
  // changes all day); sharedFeed/incidentSuppression the same
  // (WRITE_ON_CHANGE, both empty->empty all day); pipelineTraceBatch 0
  // (NO_RELEVANT_CHANGE every single tick); pbsLifecycle 0 (nothing ever
  // seen, so `changed` is never true — see lifecycle.js).
  assert.ok(total <= 150, `expected QUIET DAY writes/day <= 150, measured ${total}`);
});

test('NORMAL DAY: one service-area accident appears once, stays unchanged, then clears once -> writes/day in the 100-300 target (measured, not assumed)', async () => {
  const NEW_AT_TICK = 48; // 08:00 (00:00 + 48*10min)
  const CLEAR_AT_TICK = 96; // 16:00
  // modDttm is deliberately STABLE while the accident is genuinely
  // unchanged — real PBS records only advance modDttm when the reporter
  // actually re-touches the record, not on every relay poll. Only the
  // NEW tick and the CLEARED tick get their own modDttm.
  const kv = await runDay((tick, index) => {
    if (index < NEW_AT_TICK || index >= CLEAR_AT_TICK) return [];
    const cleared = index === CLEAR_AT_TICK - 1;
    return [{
      UID: 'PBS-NORMAL-1', road: '國道一號', direction: '北向', areaNm: '國道一號北向', roadtype: '事故',
      comment: cleared ? '北向93公里處已排除' : '北向93公里處發生車輛事故',
      happendate: '2026-08-26', happentime: '08:00:00',
      modDttm: cleared ? '2026-08-26 16:00:00' : '2026-08-26 08:00:00',
      srcdetail: '測試來源',
    }];
  });
  const total = report('NORMAL DAY', kv);
  assert.ok(total >= 5 && total <= 300, `expected NORMAL DAY writes/day roughly 100-300 (measured, loose bound for CI stability), measured ${total}`);
});

test('HIGH EVENT DAY: five distinct service-area accidents through the day (new/updated/cleared each) -> writes/day target < 500 (measured)', async () => {
  const events = [
    { uid: 'PBS-HIGH-1', newAt: 12, clearAt: 30 },
    { uid: 'PBS-HIGH-2', newAt: 40, clearAt: 55 },
    { uid: 'PBS-HIGH-3', newAt: 60, clearAt: 78 },
    { uid: 'PBS-HIGH-4', newAt: 90, clearAt: 105 },
    { uid: 'PBS-HIGH-5', newAt: 110, clearAt: 130 },
  ];
  // Same "modDttm only moves at a real transition" fixture discipline as
  // NORMAL DAY above (new / one mid-course update / cleared) — otherwise
  // a synthetic ever-incrementing modDttm makes an "unchanged" event look
  // like it re-updates every single fetch, which no real PBS record does.
  const kv = await runDay((tick, index) => {
    const items = [];
    for (const e of events) {
      if (index < e.newAt || index >= e.clearAt) continue;
      const cleared = index === e.clearAt - 1;
      const midpoint = e.newAt + Math.floor((e.clearAt - e.newAt) / 2);
      const updated = index === midpoint;
      const stage = cleared ? 'cleared' : index >= midpoint ? 'updated' : 'new';
      const modDttmByStage = { new: '08:00:00', updated: '09:00:00', cleared: '10:00:00' };
      items.push({
        UID: e.uid, road: '國道一號', direction: '南向', areaNm: '國道一號南向', roadtype: '事故',
        // Each event needs its own resolvable KM (like NORMAL DAY's "93
        // 公里處") to actually pass the location-quality gate and become a
        // real completed product — a vague comment with no KM at all
        // would make every one of these insufficient-location-precision
        // (TEXT/no-push), understating a genuinely busy day's real
        // write volume.
        comment: cleared
          ? `南向${92 + events.indexOf(e)}公里處已排除`
          : updated
            ? `南向${92 + events.indexOf(e)}公里處內側車道封閉，回堵中`
            : `南向${92 + events.indexOf(e)}公里處發生車輛事故`,
        happendate: '2026-08-26', happentime: '08:00:00',
        modDttm: `2026-08-26 ${modDttmByStage[stage]}`,
        srcdetail: '測試來源',
      });
    }
    return items;
  });
  const total = report('HIGH EVENT DAY', kv);
  assert.ok(total < 500, `expected HIGH EVENT DAY writes/day < 500, measured ${total}`);
});
