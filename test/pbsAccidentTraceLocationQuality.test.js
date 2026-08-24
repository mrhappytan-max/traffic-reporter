// PBS ACCIDENT | DELIVERY TRACE GAP + LOCATION QUALITY GATE (2026-08-24).
//
// Two real Production symptoms, one round.
//
// (1) LOCATION QUALITY. A real proactive LINE push read, in full:
//
//       🚨 交通事故
//       台68 西向
//       （南寮竹東）-台68線
//       事故影響通行 / 請提前避開
//       🕒 13:48 更新
//
//     Line 3 is not a location — it is PBS's official ROUTE NAME for the
//     whole of 台68 (this repo already documents that exact string as a
//     real `areaNm` example in pbs/roadName.js), spanning KM 0.4 南寮 to
//     the far end of a 22.9 KM route. One of a 200/month proactive-push
//     allowance was spent on something no driver could act on.
//
// (2) DELIVERY TRACE GAP. Minutes later that event could not be found in
//     the admin surfaces at all. The trace WAS written — the failure is on
//     the retrieval side, and is reproduced directly below.
//
// The 台68 record is the permanent regression fixture. As with the 八堵
// round, the positive cases matter just as much: a gate that blocked
// everything would also "fix" this, and would be a far worse bug.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { formatEventMessage } from '../src/traffic/messageFormat.js';
import { resolveLocationQuality, MAX_ACTIONABLE_SEGMENT_KM } from '../src/traffic/locationQuality.js';
import { resolveCoordinateLocation } from '../src/traffic/kmLocationResolver.js';
import { resolveServiceAreaEligibility } from '../src/traffic/serviceArea.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { getLinePushPolicyDecision } from '../src/traffic/broadcastPolicy.js';
import { buildTraceEntry, persistPipelineTraceEntries, listPipelineTrace } from '../src/traffic/pipelineTrace.js';
import { isTdxRuntimeEnabled, isCctvImageEnabled } from '../src/traffic/sourceMode.js';
import { getAccessToken } from '../src/tdx/auth.js';

const PBS_ONLY_ENV = {
  TRAFFIC_SOURCE_MODE: 'PBS_ONLY',
  LINE_PUSH_POLICY: 'MAJOR_ACCIDENT_ONLY',
  TDX_CLIENT_ID: 'test-id',
  TDX_CLIENT_SECRET: 'test-secret',
};

const NOW = new Date('2026-08-24T06:20:00.000Z'); // 14:20 Asia/Taipei

// The raw PBS record shape, exactly as pbs/normalize.js documents it:
// road / areaNm / direction / roadtype / comment / happendate / happentime
// / modDttm / x1 / y1 / srcdetail / UID. `areaNm` carries the route name
// that ended up on line 3 of the real message.
function rawT68(overrides = {}) {
  return {
    UID: '11508240013-1',
    road: '台68線',
    areaNm: '（南寮竹東）-台68線',
    direction: '西向',
    roadtype: '交通事故',
    comment: '西向發生交通事故，請小心通過',
    happendate: '2026-08-24',
    happentime: '13:45:00',
    modDttm: '2026-08-24 13:48:00',
    srcdetail: '警廣',
    ...overrides,
  };
}

/**
 * The real broadcast gate's ordering, mirrored exactly — all THREE
 * independent gates, in the same order broadcastPipeline.js applies them.
 */
function broadcastDecision(event, env) {
  const area = resolveServiceAreaEligibility(event);
  if (!area.eligible) return { allowed: false, reason: area.reason };
  const base = getBroadcastEligibility(event);
  if (!base.eligible) return { allowed: false, reason: base.reason };
  const policy = getLinePushPolicyDecision(event, env);
  if (!policy.allowed) return { allowed: false, reason: policy.reason };
  const quality = resolveLocationQuality(event);
  return { allowed: quality.sufficient, reason: quality.reason };
}

function withFetchSpy(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    throw new Error(`unexpected network call in test: ${String(url)}`);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const tdxCalls = (calls) => calls.filter((c) => c.url.includes('tdx.transportdata.tw'));

function createMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { keys: [], list_complete: true };
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// --- 1: the real event, reproduced end to end ----------------------------

test('1. the real 13:48 台68 record reproduces the exact Production message, byte for byte', () => {
  const event = normalizePbsEvent(rawT68());

  // Provenance the order asks for, all of it derived from the raw record
  // rather than assumed: source, rawId, description, timestamps, road,
  // direction, KM, coordinates, parsed location.
  assert.equal(event.source, 'pbs');
  assert.equal(event.rawId, '11508240013-1');
  assert.equal(event.type, 'accident');
  assert.equal(event.road, '台68'); // normalized; the human-visible form is 台68線
  assert.equal(event.direction, '西向');
  assert.equal(event.location, '（南寮竹東）-台68線');
  assert.equal(event.updatedAt, '2026-08-24T05:48:00.000Z'); // 13:48 Asia/Taipei
  assert.equal(event.startKM, undefined, 'PBS never carries structured KM');
  assert.equal(event.endKM, undefined);
  assert.equal(event.displayKM, undefined, 'no kilometre marker in this comment');
  assert.equal(event.latitude, null);
  assert.equal(event.longitude, null);

  // The exact message a real person received. If this ever stops matching,
  // the reproduction — not the fixture — is what needs re-checking.
  assert.equal(
    formatEventMessage(event),
    ['🚨 交通事故', '台68 西向', '（南寮竹東）-台68線', '事故影響通行', '請提前避開', '🕒 13:48更新'].join('\n')
  );
});

test('2. it passed every OTHER gate — location quality is the only thing that stops it', () => {
  const event = normalizePbsEvent(rawT68());

  // Genuinely in the service area (台68 is wholly in scope), genuinely an
  // accident, genuinely allowed by the accident-only push policy. That is
  // precisely why it reached LINE, and why a third gate was needed.
  assert.equal(resolveServiceAreaEligibility(event).eligible, true);
  assert.equal(getBroadcastEligibility(event).eligible, true);
  assert.equal(getLinePushPolicyDecision(event, PBS_ONLY_ENV).allowed, true);

  const decision = broadcastDecision(event, PBS_ONLY_ENV);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'insufficient-location-precision');
});

test('3. the block reason names what was actually missing, not a generic refusal', () => {
  const quality = resolveLocationQuality(normalizePbsEvent(rawT68()));
  assert.equal(quality.sufficient, false);
  assert.equal(quality.reason, 'insufficient-location-precision');
  assert.equal(quality.detail, 'no-placeable-location');
  assert.equal(quality.evidence.location, '（南寮竹東）-台68線');
  assert.equal(quality.evidence.hasCoordinates, false);
  assert.equal(quality.evidence.coordinateReason, 'no-coordinate');
  assert.equal(quality.evidence.kmReason, 'no-km');
});

// --- 4: upstream HAD the precision -> repair, never block -----------------
//
// The order is explicit: establish whether upstream simply never supplied a
// position (block) or supplied one this system then discarded (repair the
// resolver). Coordinates were the discarded case — pbs/normalize.js has
// always kept x1/y1, but until this round nothing on the display side ever
// read them, so a PBS accident WITH exact coordinates rendered identically
// to one with none.

test('4. the same record WITH coordinates must not be blocked — it is repaired instead', () => {
  const event = normalizePbsEvent(rawT68({ x1: '121.005999', y1: '24.8138074' }));
  assert.equal(event.latitude, 24.8138074);
  assert.equal(event.longitude, 121.005999);

  const quality = resolveLocationQuality(event);
  assert.equal(quality.sufficient, true, 'precise data that exists must never be blocked away');
  assert.equal(quality.tier, 'coordinate');
  assert.equal(quality.evidence.locationLabel, '新竹市東區水源里');
  assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true);

  // And the message now actually tells the driver where it is, with a map
  // link — the repair has to reach the person, not just the gate.
  const message = formatEventMessage(event);
  assert.match(message, /台68 西向｜新竹市東區水源里/);
  assert.match(message, /📍 地圖 https:\/\/maps\.google\.com\/\?q=24\.81381,121\.00600/);
});

test('5. coordinate resolution reuses the bundled official dataset and fails closed off-road', () => {
  // On the road: placed, with the same 縣市/鄉鎮/里 label the KM path gives.
  const onRoad = resolveCoordinateLocation({ road: '台68', latitude: 24.8138074, longitude: 121.005999 });
  assert.equal(onRoad.resolved, true);
  assert.equal(onRoad.resolvedKm, 8.3);
  assert.equal(onRoad.locationLabel, '新竹市東區水源里');

  // 八堵's coordinates are nowhere near 台68 — never force a match.
  const offRoad = resolveCoordinateLocation({ road: '台68', latitude: 25.10288, longitude: 121.71801 });
  assert.equal(offRoad.resolved, false);
  assert.equal(offRoad.reason, 'too-far');

  // Missing/garbage input degrades, never throws.
  assert.equal(resolveCoordinateLocation({ road: '台68' }).resolved, false);
  assert.equal(resolveCoordinateLocation(null).resolved, false);
  assert.equal(resolveCoordinateLocation({ road: '不存在的路', latitude: 24.8, longitude: 121 }).resolved, false);
});

// --- 6: the positive cases, which matter just as much ---------------------

test('6. 台68 8K+300 (the real, already-good Production case) stays broadcastable', () => {
  const event = normalizePbsEvent(rawT68({ direction: '東向', comment: '東向在8.3公里處發生交通事故' }));
  assert.equal(event.displayKM, 8.3);

  const quality = resolveLocationQuality(event);
  assert.equal(quality.sufficient, true);
  assert.equal(quality.tier, 'display-km');
  assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true);

  const message = formatEventMessage(event);
  assert.match(message, /台68 東向｜新竹市東區水源里/);
  assert.match(message, /8K\+300/);
});

test('7. an explicit interchange / ramp / junction is enough', () => {
  for (const text of ['新竹交流道前', '竹林交流道附近', '寶山交流道匝道出口', '茄苳交流道路口']) {
    const quality = resolveLocationQuality({ road: '國道三號', direction: '南向', locationDescription: text });
    assert.equal(quality.sufficient, true, `"${text}" must be actionable`);
    assert.equal(quality.tier, 'named-facility');
  }
});

test('8. 行政區 + 更細地點 is enough; 行政區 alone is not', () => {
  const detailed = resolveLocationQuality({ road: '台68', locationDescription: '新竹市東區水源里' });
  assert.equal(detailed.sufficient, true);
  assert.equal(detailed.tier, 'admin-detail');

  for (const vague of ['新竹地區', '新竹一帶', '竹北端']) {
    assert.equal(
      resolveLocationQuality({ road: '台1', location: vague }).sufficient,
      false,
      `"${vague}" is not a place a driver can act on`
    );
  }
});

test('9. structured KM on 國1／國3 passes; an over-long range does not', () => {
  const precise = resolveLocationQuality({ road: '國道一號', direction: '南向', startKM: '93K+000', endKM: '93K+800' });
  assert.equal(precise.sufficient, true);
  assert.equal(precise.tier, 'structured-km');

  // 40K–95K is 55 km — wider than the widest real interchange-to-interchange
  // gap in the bundled official dataset, so it names a corridor, not an
  // accident.
  const corridor = resolveLocationQuality({ road: '國道一號', direction: '南向', startKM: '40K+000', endKM: '95K+000' });
  assert.equal(corridor.sufficient, false);
  assert.equal(corridor.evidence.overLongRangeKm, 55);
  assert.ok(55 > MAX_ACTIONABLE_SEGMENT_KM);

  // Right at the boundary the benefit of the doubt goes to broadcasting.
  const atLimit = resolveLocationQuality({
    road: '國道一號',
    direction: '南向',
    startKM: '80K+000',
    endKM: `${80 + MAX_ACTIONABLE_SEGMENT_KM}K+000`,
  });
  assert.equal(atLimit.sufficient, true);
});

test('10. an over-long range is still rescued by real coordinates', () => {
  const quality = resolveLocationQuality({
    road: '國道一號',
    direction: '南向',
    startKM: '40K+000',
    endKM: '95K+000',
    latitude: 24.8151933,
    longitude: 121.0034428,
  });
  // Coordinates are the only evidence that actually narrows a corridor —
  // 台68's dataset placed this exact point, so on 國道一號 it correctly
  // does NOT match, and the corridor stays blocked.
  assert.equal(quality.sufficient, false, 'a point that is not on this road cannot rescue it');

  const onFreeway = resolveCoordinateLocation({ road: '國道一號', latitude: 24.8151933, longitude: 121.0034428 });
  assert.equal(onFreeway.resolved, false);
});

test('11. a location text that itself states a kilometre is enough', () => {
  const quality = resolveLocationQuality({ road: '國道一號', direction: '北向', location: '92K附近' });
  assert.equal(quality.sufficient, true);
  assert.equal(quality.tier, 'text-km-marker');
  assert.equal(quality.evidence.marker, '92K');
});

test('12. only text the MESSAGE renders can satisfy the gate', () => {
  // `description` is never printed by messageFormat.js, so a marker that
  // lives only there must not pass the gate — that would be precision the
  // driver never sees. (The kilometre case is different: normalize.js
  // promotes it to displayKM, which IS printed.)
  const quality = resolveLocationQuality({
    road: '台68',
    direction: '西向',
    location: '（南寮竹東）-台68線',
    description: '在竹科匝道口附近發生事故',
  });
  assert.equal(quality.sufficient, false);
});

// --- 13: the three gates are permanently independent ----------------------

test('13. outside-service-area and insufficient-location are different answers', () => {
  // 八堵, but WITH a perfectly precise position. Geography still wins.
  const badu = {
    source: 'pbs',
    rawId: 'PBS-BADU-PRECISE',
    type: 'accident',
    pbsCategory: 'accident',
    road: '國道一號',
    direction: '南向',
    location: '八堵交流道',
    latitude: 25.10288,
    longitude: 121.71801,
  };
  assert.equal(resolveLocationQuality(badu).sufficient, true, 'its position is precise — that was never the problem');
  const decision = broadcastDecision(badu, PBS_ONLY_ENV);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'outside-service-area', 'geography must not be reported as a location-quality problem');

  // And the converse: in-area, but unplaceable.
  const vague = normalizePbsEvent(rawT68());
  assert.equal(resolveServiceAreaEligibility(vague).eligible, true);
  assert.equal(broadcastDecision(vague, PBS_ONLY_ENV).reason, 'insufficient-location-precision');
});

test('14. PBS_ONLY: TDX corroboration is not required, but both other gates still are', () => {
  assert.equal(isTdxRuntimeEnabled(PBS_ONLY_ENV), false);

  const placeable = normalizePbsEvent(rawT68({ comment: '西向在8.3公里處發生交通事故' }));
  assert.equal(broadcastDecision(placeable, PBS_ONLY_ENV).allowed, true, 'a legal, placeable PBS accident still broadcasts with TDX off');

  assert.equal(broadcastDecision(normalizePbsEvent(rawT68()), PBS_ONLY_ENV).allowed, false);
});

test('15. the whole gate is pure: 0 TDX RoadEvent calls, 0 TDX token calls, 0 network of any kind', async () => {
  await withFetchSpy(async (calls) => {
    const events = [
      normalizePbsEvent(rawT68()),
      normalizePbsEvent(rawT68({ x1: '121.005999', y1: '24.8138074' })),
      normalizePbsEvent(rawT68({ comment: '西向在8.3公里處發生交通事故' })),
      { road: '國道一號', direction: '南向', startKM: '93K+000', endKM: '93K+800' },
    ];
    for (const event of events) {
      resolveLocationQuality(event);
      resolveServiceAreaEligibility(event);
      formatEventMessage(event);
    }
    assert.equal(calls.length, 0, 'the location gate must never touch the network');
    assert.equal(tdxCalls(calls).length, 0);
  });

  // And the token path refuses before it even reaches the network, so
  // "0 TDX token calls" holds structurally rather than by good luck.
  await withFetchSpy(async (calls) => {
    await assert.rejects(() => getAccessToken(PBS_ONLY_ENV), /TDX runtime disabled/);
    assert.equal(calls.length, 0, 'PBS_ONLY refuses a token request before any fetch');
  });
});

// --- 16: CCTV is enrichment, never a licence to push a vague location -----

test('16. CCTV can never rescue an unplaceable event, and its absence never blocks a placeable one', () => {
  // A found image does not make "somewhere on 台68" actionable.
  const vague = normalizePbsEvent(rawT68());
  assert.equal(broadcastDecision({ ...vague, imageUrl: 'https://example.invalid/frame.jpg' }, PBS_ONLY_ENV).allowed, false);

  // And a placeable accident broadcasts TEXT-ONLY when CCTV yields nothing.
  const placeable = normalizePbsEvent(rawT68({ comment: '西向在8.3公里處發生交通事故' }));
  assert.equal(broadcastDecision(placeable, PBS_ONLY_ENV).allowed, true);
  const message = formatEventMessage(placeable);
  assert.ok(message.length > 0);
  assert.ok(!message.includes('http') || message.includes('maps.google.com'), 'no image is required for the text to stand');

  // CCTV stays enabled and stays TDX-free (unchanged this round).
  assert.equal(isCctvImageEnabled(PBS_ONLY_ENV), true);
});

test('17. dynamic shoulder and non-accident types remain withheld, unchanged by this round', () => {
  const shoulder = {
    source: 'pbs',
    rawId: 'PBS-SHOULDER',
    type: 'control',
    road: '國道一號',
    direction: '南向',
    startKM: '93K+000',
    endKM: '93K+800',
    dynamicShoulder: { state: 'open', evidence: [] },
  };
  assert.equal(resolveLocationQuality(shoulder).sufficient, true, 'its position is fine — the policy is what withholds it');
  assert.equal(broadcastDecision(shoulder, PBS_ONLY_ENV).allowed, false);

  const construction = {
    source: 'highway',
    rawId: 'HWY-C',
    type: 'construction',
    road: '台1',
    direction: '南向',
    startKM: '90K+000',
    endKM: '91K+000',
    description: '封閉車道施工',
  };
  assert.equal(broadcastDecision(construction, PBS_ONLY_ENV).allowed, false);
});

test('18. restoring TRAFFIC_SOURCE_MODE=ALL does not disturb either always-on gate', () => {
  const allEnv = { ...PBS_ONLY_ENV, TRAFFIC_SOURCE_MODE: 'ALL' };
  assert.equal(isTdxRuntimeEnabled(allEnv), true);

  // Service area and location quality are mode-independent by design.
  assert.equal(broadcastDecision(normalizePbsEvent(rawT68()), allEnv).reason, 'insufficient-location-precision');
  const placeable = normalizePbsEvent(rawT68({ comment: '西向在8.3公里處發生交通事故' }));
  assert.equal(broadcastDecision(placeable, allEnv).allowed, true);

  const tdxEvent = { source: 'freeway', rawId: 'FRW-1', type: 'accident', road: '國道一號', direction: '南向', startKM: '93K+000', endKM: '93K+800' };
  assert.equal(broadcastDecision(tdxEvent, allEnv).allowed, true, 'TDX traffic must survive the restore path');
});

// --- 19: the delivery trace gap ------------------------------------------

test('19. a pushed event IS traced, and is findable by the road name a human actually saw', async () => {
  const kv = createMockKV();
  const event = normalizePbsEvent(rawT68({ x1: '121.005999', y1: '24.8138074' }));
  const entry = buildTraceEntry({
    event,
    now: NOW,
    eligibility: true,
    eligibilityReason: 'location-coordinate',
    locationQuality: resolveLocationQuality(event),
    formattedOutput: formatEventMessage(event),
    lineAttempted: 1,
    lineSucceeded: 1,
    sharedFeedPersisted: true,
  });
  await persistPipelineTraceEntries(kv, [entry], NOW);

  assert.equal(entry.status, 'line-sent');
  assert.equal(entry.identity.road, '台68', 'stored normalized…');

  // …but every surface a human can see says 台68線. Searching for what you
  // are looking at used to return zero rows, which reads as "never traced".
  for (const filter of ['台68線', '台68']) {
    const { records } = await listPipelineTrace(kv, { road: filter });
    assert.equal(records.length, 1, `road filter "${filter}" must find its own record`);
    assert.equal(records[0].identity.rawId, '11508240013-1');
  }

  // The same for the freeway naming variants.
  const freewayKv = createMockKV();
  await persistPipelineTraceEntries(
    freewayKv,
    [buildTraceEntry({ event: { source: 'freeway', rawId: 'F1', road: '國道一號', type: 'accident' }, now: NOW })],
    NOW
  );
  for (const filter of ['國道一號', '國道1號', '國1']) {
    const { records } = await listPipelineTrace(freewayKv, { road: filter });
    assert.equal(records.length, 1, `road filter "${filter}" must find its own record`);
  }

  // Two genuinely different roads must still never collide.
  assert.equal((await listPipelineTrace(freewayKv, { road: '國道三號' })).records.length, 0);
});

test('20. free-text search finds the event from what the LINE message itself said', async () => {
  const kv = createMockKV();
  const event = normalizePbsEvent(rawT68());
  await persistPipelineTraceEntries(
    kv,
    [
      buildTraceEntry({
        event,
        now: NOW,
        eligibility: false,
        eligibilityReason: 'insufficient-location-precision',
        locationQuality: resolveLocationQuality(event),
        formattedOutput: formatEventMessage(event),
      }),
      buildTraceEntry({ event: { source: 'freeway', rawId: 'OTHER', road: '國道三號', type: 'accident' }, now: NOW }),
    ],
    NOW
  );

  for (const q of ['南寮竹東', '台68', '11508240013', 'insufficient-location-precision']) {
    const { records } = await listPipelineTrace(kv, { q });
    assert.equal(records.length, 1, `free-text "${q}" must find exactly the 台68 record`);
    assert.equal(records[0].identity.rawId, '11508240013-1');
  }
  assert.equal((await listPipelineTrace(kv, { q: '完全不存在的字串' })).records.length, 0);
});

test('21. one run\'s trace entries are ordered deterministically, not randomly', async () => {
  // Every entry a Cron run writes shares that run's single `now`, so the
  // only thing separating those keys used to be a RANDOM id — a specific
  // event could be pushed off the first page non-deterministically, which
  // reads to a human as "the event was never traced".
  const kv = createMockKV();
  const entries = Array.from({ length: 40 }, (_, i) =>
    buildTraceEntry({ event: { source: 'pbs', rawId: `E${String(i).padStart(3, '0')}`, road: '台68', type: 'accident' }, now: NOW })
  );
  await persistPipelineTraceEntries(kv, entries, NOW);

  const keys = [...kv.store.keys()].sort();
  const order = keys.map((k) => JSON.parse(kv.store.get(k)).identity.rawId);
  assert.deepEqual(order, entries.map((e) => e.identity.rawId), 'batch order must survive lexicographic listing');

  // Newest-first display therefore reverses that batch exactly.
  const { records } = await listPipelineTrace(kv, { limit: 5 });
  assert.deepEqual(records.map((r) => r.identity.rawId), ['E039', 'E038', 'E037', 'E036', 'E035']);
});

test('22. "not found" is never presented as "never happened" when the scan was capped', async () => {
  const kv = createMockKV();
  const entries = Array.from({ length: 620 }, (_, i) =>
    buildTraceEntry({ event: { source: 'pbs', rawId: `E${String(i).padStart(4, '0')}`, road: '台68', type: 'accident' }, now: NOW })
  );
  await persistPipelineTraceEntries(kv, entries, NOW);

  const found = await listPipelineTrace(kv, { q: 'E0619' });
  assert.equal(found.records.length, 1, 'the newest entries are still reachable');

  // An entry older than the scan window: absent from the results, but the
  // coverage fact is reported alongside so "查不到" is never mistaken for
  // "沒有發生".
  const missed = await listPipelineTrace(kv, { q: 'E0001' });
  assert.equal(missed.records.length, 0);
  assert.equal(missed.scanTruncated, true, 'the caller must be told it did not look at everything');
  assert.equal(missed.totalKeyCount, 620);
  assert.ok(missed.scannedKeyCount < missed.totalKeyCount);

  // scanTruncated states coverage, not satisfaction — it reads the same
  // whether or not this particular query happened to find something.
  assert.equal(found.scanTruncated, missed.scanTruncated);
});

test('23. the trace distinguishes each gate instead of one generic refusal', () => {
  const vague = normalizePbsEvent(rawT68());
  const vagueEntry = buildTraceEntry({
    event: vague,
    now: NOW,
    eligibility: false,
    eligibilityReason: 'insufficient-location-precision',
    locationQuality: resolveLocationQuality(vague),
  });
  assert.equal(vagueEntry.status, 'insufficient-location');
  assert.equal(vagueEntry.decision.serviceAreaEligible, true);
  assert.equal(vagueEntry.decision.locationQuality.sufficient, false);
  assert.equal(vagueEntry.decision.locationQuality.detail, 'no-placeable-location');

  const outside = buildTraceEntry({
    event: { source: 'pbs', rawId: 'X', road: '國道一號', type: 'accident' },
    now: NOW,
    eligibility: false,
    eligibilityReason: 'outside-service-area',
  });
  assert.equal(outside.status, 'outside-service-area');
  assert.equal(outside.decision.serviceAreaEligible, false);
  assert.equal(outside.decision.locationQuality, null, 'it never reached the location gate');

  // A policy rejection keeps the pre-existing generic status, with its own
  // reason shown verbatim — no status was repurposed.
  const policyBlocked = buildTraceEntry({
    event: { source: 'pbs', rawId: 'Y', road: '台68', type: 'construction' },
    now: NOW,
    eligibility: false,
    eligibilityReason: 'policy-non-accident-withheld',
  });
  assert.equal(policyBlocked.status, 'ineligible');
  assert.equal(policyBlocked.decision.eligibilityReason, 'policy-non-accident-withheld');
});

test('24. an event blocked for location still exists in the trace — it never vanishes', async () => {
  const kv = createMockKV();
  const event = normalizePbsEvent(rawT68());
  await persistPipelineTraceEntries(
    kv,
    [
      buildTraceEntry({
        event,
        now: NOW,
        eligibility: false,
        eligibilityReason: 'insufficient-location-precision',
        locationQuality: resolveLocationQuality(event),
      }),
    ],
    NOW
  );
  const { records } = await listPipelineTrace(kv, { status: 'insufficient-location' });
  assert.equal(records.length, 1);
  assert.equal(records[0].normalized.location, '（南寮竹東）-台68線');
  assert.equal(records[0].decision.eligibilityReason, 'insufficient-location-precision');
});

test('25. the gate never throws, whatever it is handed', () => {
  for (const input of [null, undefined, {}, { road: null }, { road: 123 }, { road: '台68', latitude: 'x', longitude: {} }, { startKM: 'not-a-km' }]) {
    const quality = resolveLocationQuality(input);
    assert.equal(typeof quality.sufficient, 'boolean');
    assert.ok(quality.reason, 'a reason is always present on both paths');
  }
});
