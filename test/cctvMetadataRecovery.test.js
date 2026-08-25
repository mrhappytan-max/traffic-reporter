// CCTV METADATA RECOVERY | 國1 93K 19:01 Production regression (2026-08-25).
//
// That evening a real 國道1號 93K accident was pushed to LINE with correct
// text and no picture. Every gate was green; the camera selector, the frame
// fetch and R2 were all fine. The failure was one layer below all of them:
//
//   metadata-cache-unavailable
//
// cctv:freeway-metadata:v1 was simply gone from TRAFFIC_KV, because
// freewayCctvMetadataCache.js wrote it with a 7-day expirationTtl and its
// ONLY writer is the TDX-dependent admin probe — which cannot run while
// TRAFFIC_SOURCE_MODE=PBS_ONLY. Seven days after the last probe the key
// expired and nothing was permitted to put it back. Not a transient: a
// deadlock with no exit that did not involve switching TDX on.
//
// The fix has three parts, and this file pins all three:
//   1. the inventory is stored with NO expiry;
//   2. a write must be an upgrade — an empty/garbage refresh can never
//      replace a good inventory with nothing;
//   3. the official 交通部高速公路局 open-data inventory is bundled, so an
//      empty KV still yields a usable camera list and the deadlock cannot
//      recur even if KV is wiped.
//
// The 93K case is the permanent fixture. As always the negative cases
// matter too: CCTV is enrichment, and none of this may make an event
// broadcastable that the three gates rejected.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREEWAY_METADATA_KEY,
  BUNDLED_INVENTORY_RECORDS,
  BUNDLED_INVENTORY_METADATA,
  readFreewayCctvMetadataCache,
  writeFreewayCctvMetadataCache,
  describeFreewayCctvMetadata,
} from '../src/cctv/freewayCctvMetadataCache.js';
import { selectFourQuadrantCandidates, extractFirstJpegFrame } from '../src/tdx/hsinchuCctvProbe.js';
import { resolveCctvEligibility, prepareCctvImageForEvent } from '../src/cctv/dynamicCollage.js';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import { resolveServiceAreaEligibility } from '../src/traffic/serviceArea.js';
import { resolveLocationQuality } from '../src/traffic/locationQuality.js';
import { getBroadcastEligibility } from '../src/traffic/broadcastRules.js';
import { getLinePushPolicyDecision } from '../src/traffic/broadcastPolicy.js';
import { buildHealthSnapshot } from '../src/traffic/healthSnapshot.js';
import { getAccessToken } from '../src/tdx/auth.js';
import { parseNfbCctvXml } from '../scripts/lib/nfbCctvXml.mjs';

// Mirrors cctv/dynamicCollage.js's CCTV_SUPPORTED_ROADS, which is module-private
// on purpose (a positive allowlist nothing outside that file may widen). Test 14
// guards the behaviour — that an unlisted road still gets no camera — so this
// copy only has to name the two Production-confirmed RoadIDs.
const CCTV_SUPPORTED_ROADS = new Set(['000010', '000030']);

const PBS_ONLY_ENV = {
  TRAFFIC_SOURCE_MODE: 'PBS_ONLY',
  LINE_PUSH_POLICY: 'MAJOR_ACCIDENT_ONLY',
  TDX_CLIENT_ID: 'test-id',
  TDX_CLIENT_SECRET: 'test-secret',
};

const N1 = { roadId: '000010', roadNamePattern: /國道1號|國道一號/ };
const N3 = { roadId: '000030', roadNamePattern: /國道3號|國道三號/ };

/** KV whose inventory key is simply absent — the exact 2026-08-25 state. */
const emptyKv = () => ({ gets: [], async get(k) { this.gets.push(k); return null; }, async put() {} });

function kvWith(payload) {
  return {
    async get() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
    async put() {},
  };
}

/** The real 19:01 event, in the shape PBS actually delivers. */
function accident93K(overrides = {}) {
  return {
    ...normalizePbsEvent({
      UID: '11508251901-1',
      road: '中山高速公路-國道1號',
      areaNm: '(新竹交流道-新竹系統交流道)-國道1號',
      direction: '南向',
      roadtype: '交通事故',
      comment: '南向93公里處發生交通事故',
      happendate: '2026-08-25',
      happentime: '19:01:00',
      modDttm: '2026-08-25 19:01:00',
    }),
    ...overrides,
  };
}

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

function withFetchSpy(fn, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (handler) return handler(String(url), init);
    throw new Error(`unexpected network call: ${String(url)}`);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const tdxCalls = (calls) => calls.filter((c) => c.url.includes('tdx.transportdata.tw'));

// --- 1: the XML conversion ------------------------------------------------

test('1. the official NFB XML converts to the cache\'s own record shape', () => {
  const xml = `<?xml version="1.0"?>
<CCTVList xmlns="http://traffic.transportdata.tw/standard/traffic/schema/">
  <UpdateTime>2026-08-25T20:05:36+08:00</UpdateTime>
  <UpdateInterval>86400</UpdateInterval>
  <AuthorityCode>NFB</AuthorityCode>
  <LinkVersion>25.12.1</LinkVersion>
  <CCTVs>
    <CCTV>
      <CCTVID>CCTV-N1-S-93.080-M</CCTVID>
      <SubAuthorityCode>NFB-NR</SubAuthorityCode>
      <LinkID>0000100930000C</LinkID>
      <VideoStreamURL>https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10930</VideoStreamURL>
      <LocationType>1</LocationType>
      <PositionLon>120.98</PositionLon>
      <PositionLat>24.81</PositionLat>
      <RoadID>000010</RoadID>
      <RoadName>國道1號</RoadName>
      <RoadClass>0</RoadClass>
      <RoadDirection>S</RoadDirection>
      <RoadSection><Start>新竹交流道</Start><End>新竹系統交流道</End></RoadSection>
      <LocationMile>93K+000</LocationMile>
    </CCTV>
    <CCTV>
      <CCTVID>CCTV-BROKEN-NO-URL</CCTVID>
      <RoadID>000010</RoadID>
      <RoadName>國道1號</RoadName>
      <RoadDirection>S</RoadDirection>
      <LocationMile>50K+000</LocationMile>
    </CCTV>
  </CCTVs>
</CCTVList>`;

  const { metadata, records, skipped } = parseNfbCctvXml(xml);
  assert.equal(metadata.authorityCode, 'NFB');
  assert.equal(metadata.updateTime, '2026-08-25T20:05:36+08:00');

  // Field names are preserved VERBATIM — the selector reads these exact keys.
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    CCTVID: 'CCTV-N1-S-93.080-M',
    SubAuthorityCode: 'NFB-NR',
    LinkID: '0000100930000C',
    VideoStreamURL: 'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10930',
    LocationType: '1',
    PositionLon: '120.98',
    PositionLat: '24.81',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadClass: '0',
    RoadDirection: 'S',
    RoadSection: { Start: '新竹交流道', End: '新竹系統交流道' },
    LocationMile: '93K+000',
  });

  // A record without a usable image URL is dropped, not guessed at — and it
  // is COUNTED, so a shrinking inventory can never pass silently.
  assert.equal(skipped, 1);
});

test('2. the converter refuses input it cannot vouch for', () => {
  assert.throws(() => parseNfbCctvXml(''), /empty input/);
  assert.throws(
    () => parseNfbCctvXml('<CCTVList><AuthorityCode>OTHER</AuthorityCode><CCTV><CCTVID>x</CCTVID></CCTV></CCTVList>'),
    /unexpected AuthorityCode/
  );
  assert.throws(() => parseNfbCctvXml('<CCTVList><AuthorityCode>NFB</AuthorityCode></CCTVList>'), /0 usable records/);
});

// --- 3: the bundled official inventory ------------------------------------

test('3. the bundled inventory is real, official, and covers both roads', () => {
  assert.ok(BUNDLED_INVENTORY_RECORDS.length > 1000, 'the full official inventory, not a trimmed sample');
  assert.equal(BUNDLED_INVENTORY_METADATA.authorityCode, 'NFB');
  assert.ok(BUNDLED_INVENTORY_METADATA.sourceUpdatedAt, 'carries the file\'s own publication time');

  const n1 = BUNDLED_INVENTORY_RECORDS.filter((r) => r.RoadID === '000010');
  const n3 = BUNDLED_INVENTORY_RECORDS.filter((r) => r.RoadID === '000030');
  assert.ok(n1.length > 0, '國道1號 present');
  assert.ok(n3.length > 0, '國道3號 present');

  // Every record carries what the selector needs — no half-usable entries.
  for (const r of BUNDLED_INVENTORY_RECORDS) {
    assert.ok(r.CCTVID && r.VideoStreamURL && r.LocationMile && r.RoadDirection);
  }

  // Every record the broadcast path can actually REACH streams from
  // freeway.gov.tw. Scoped to the supported roads deliberately: the real
  // official file is not uniform. It carries 1943 NFB cameras, of which
  // exactly one — CCTV-T64-E-23.750-M on 快速公路64號 — is hosted on
  // cctv-ss02.thb.gov.tw instead. That is genuine published data, not a
  // parse error, so the inventory keeps it verbatim rather than quietly
  // dropping a record the authority published.
  for (const r of BUNDLED_INVENTORY_RECORDS.filter((r) => CCTV_SUPPORTED_ROADS.has(r.RoadID))) {
    assert.match(r.VideoStreamURL, /freeway\.gov\.tw/, 'reachable frames only come from freeway.gov.tw');
  }
});

test('3b. the one non-freeway-hosted record is unreachable twice over', async () => {
  const offHost = BUNDLED_INVENTORY_RECORDS.filter((r) => !/freeway\.gov\.tw/.test(r.VideoStreamURL));
  assert.equal(offHost.length, 1, 'if this count ever moves, re-check the host allowlist below');

  // First barrier: not a supported road, so the selector never offers it.
  assert.ok(!CCTV_SUPPORTED_ROADS.has(offHost[0].RoadID), '快速公路64號 is not a CCTV-supported road');

  // Second barrier: even handed straight to the frame fetcher it is refused
  // before any network call. Fail-closed, not fail-open.
  await withFetchSpy(
    async (calls) => {
      const frame = await extractFirstJpegFrame(offHost[0].VideoStreamURL);
      assert.equal(frame.ok, false);
      assert.equal(frame.reason, 'untrusted-hostname');
      assert.equal(calls.length, 0, 'refused before the request, not after');
    },
    async () => new Response('should never be requested', { status: 200 })
  );
});

// --- 4: the 93K accident, re-run --------------------------------------------

test('4. 國1 93K with an EMPTY KV now fills all four quadrants', async () => {
  const kv = emptyKv();
  const records = await readFreewayCctvMetadataCache(kv);
  assert.ok(records && records.length > 0, 'an empty KV must no longer mean no cameras');

  const quadrants = selectFourQuadrantCandidates(records, { ...N1, targetKm: 93 });
  assert.equal(quadrants.filter(Boolean).length, 4, 'this is the exact 19:01 failure, now resolved');
  for (const c of quadrants) {
    assert.match(c.videoStreamUrl, /freeway\.gov\.tw/);
    assert.ok(Math.abs(c.km - 93) < 5, 'candidates are actually near the incident');
  }
});

test('5. 國3 selection still works too', async () => {
  const records = await readFreewayCctvMetadataCache(emptyKv());
  assert.equal(selectFourQuadrantCandidates(records, { ...N3, targetKm: 96.7 }).filter(Boolean).length, 4);
});

test('6. the 93K event reaches camera selection through the real gates', () => {
  const event = accident93K();
  assert.equal(event.source, 'pbs');
  assert.equal(event.road, '國道一號');
  assert.equal(event.displayKM, 93);
  assert.equal(broadcastDecision(event, PBS_ONLY_ENV).allowed, true);
  const elig = resolveCctvEligibility(event);
  assert.equal(elig.eligible, true);
  assert.equal(elig.targetKm, 93);
  assert.equal(elig.roadId, '000010');
});

// --- 7: the storage rules --------------------------------------------------

test('7. a write carries no expiry at all', async () => {
  const puts = [];
  const kv = { async get() { return null; }, async put(key, value, options) { puts.push({ key, value, options }); } };
  const result = await writeFreewayCctvMetadataCache(kv, BUNDLED_INVENTORY_RECORDS.slice(0, 3), new Date('2026-08-25T12:00:00Z'), {
    source: 'NFB_OPEN_DATA',
    sourceUpdatedAt: '2026-08-25T20:05:36+08:00',
  });
  assert.equal(result.committed, true);
  assert.equal(puts[0].key, FREEWAY_METADATA_KEY);
  assert.equal(puts[0].options, undefined, 'no expirationTtl — this is the whole bug');

  const stored = JSON.parse(puts[0].value);
  assert.equal(stored.records.length, 3);
  assert.equal(stored.fetchedAt, '2026-08-25T12:00:00.000Z');
  assert.equal(stored.source, 'NFB_OPEN_DATA');
  assert.equal(stored.sourceUpdatedAt, '2026-08-25T20:05:36+08:00');
});

test('8. a failed or empty refresh can never wipe a good inventory', async () => {
  const puts = [];
  const kv = { async get() { return null; }, async put(k, v, o) { puts.push({ k, v, o }); } };

  for (const bad of [[], null, undefined, 'not-an-array', {}]) {
    const result = await writeFreewayCctvMetadataCache(kv, bad);
    assert.equal(result.committed, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(result.reason, 'refused-empty-record-set');
  }
  assert.equal(puts.length, 0, 'not one write reached KV — the old copy stays untouched');

  // A KV that throws is also survivable, and still never deletes.
  const throwingKv = { async get() { throw new Error('kv down'); }, async put() { throw new Error('kv down'); } };
  assert.equal((await writeFreewayCctvMetadataCache(throwingKv, [{ CCTVID: 'x' }])).committed, false);
  const described = await describeFreewayCctvMetadata(throwingKv);
  assert.equal(described.source, 'bundled', 'a broken KV falls back, it does not blank out');
  assert.ok(described.records.length > 0);
});

test('9. KV wins when it holds a usable inventory; the bundle is the floor', async () => {
  const fresh = [{ CCTVID: 'KV-1', VideoStreamURL: 'https://cctvn.freeway.gov.tw/x', LocationMile: '1K+000', RoadDirection: 'S', RoadID: '000010' }];
  const fromKv = await describeFreewayCctvMetadata(
    kvWith({ records: fresh, fetchedAt: '2026-08-25T10:00:00.000Z', source: 'NFB_OPEN_DATA' })
  );
  assert.equal(fromKv.source, 'kv');
  assert.equal(fromKv.records.length, 1);
  assert.equal(fromKv.sourceName, 'NFB_OPEN_DATA');

  // Corrupt or empty KV content falls back rather than propagating garbage.
  for (const junk of ['{not json', JSON.stringify({ records: [] }), JSON.stringify({ nope: 1 })]) {
    const d = await describeFreewayCctvMetadata(kvWith(junk));
    assert.equal(d.source, 'bundled', `junk payload ${junk.slice(0, 20)} must fall back`);
  }
});

// --- 10: TDX stays off -----------------------------------------------------

test('10. recovering and reading the inventory makes 0 TDX calls of any kind', async () => {
  await withFetchSpy(async (calls) => {
    await readFreewayCctvMetadataCache(emptyKv());
    await describeFreewayCctvMetadata(emptyKv());
    selectFourQuadrantCandidates(BUNDLED_INVENTORY_RECORDS, { ...N1, targetKm: 93 });
    assert.equal(calls.length, 0, 'the whole inventory path is offline');
    assert.equal(tdxCalls(calls).length, 0);
  });

  await withFetchSpy(async (calls) => {
    await assert.rejects(() => getAccessToken(PBS_ONLY_ENV), /TDX runtime disabled/);
    assert.equal(calls.length, 0, 'TDX token calls');
  });
});

test('11. the cache module imports no TDX client or auth', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/cctv/freewayCctvMetadataCache.js', import.meta.url), 'utf8');
  // Match real import statements only. The module's header explains the
  // deadlock in prose and names tdx/auth.js while doing so; a bare substring
  // check would fail on the comment and prove nothing about the code.
  const imports = (src.match(/^import[\s\S]*?from\s+'[^']+';/gm) || []).join('\n');
  assert.ok(!imports.includes('tdx/auth.js'), 'must not import tdx/auth.js');
  assert.ok(!imports.includes('tdx/client.js'), 'must not import tdx/client.js');
  assert.ok(!imports.includes('/tdx/'), 'must not import anything under tdx/ at all');
});

// --- 12: everything downstream still degrades to text-only -----------------

test('12. frame failure and R2 failure are still text-only, not push failures', async () => {
  const env = {
    ...PBS_ONLY_ENV,
    TRAFFIC_KV: emptyKv(),
    CCTV_IMAGES: { put: async () => {} },
    PUBLIC_BASE_URL: 'https://example.workers.dev',
  };

  await withFetchSpy(
    async (calls) => {
      const result = await prepareCctvImageForEvent(env, accident93K(), {});
      assert.equal(result.ok, false, 'a dead camera never becomes a push failure');
      assert.equal(tdxCalls(calls).length, 0);
      assert.ok(calls.every((c) => c.url.includes('freeway.gov.tw')), 'only freeway.gov.tw is contacted');
    },
    async () => new Response('down', { status: 500 })
  );

  const r2Down = { ...env, TRAFFIC_KV: emptyKv(), CCTV_IMAGES: { put: async () => { throw new Error('R2 down'); } } };
  await withFetchSpy(
    async () => {
      const result = await prepareCctvImageForEvent(r2Down, accident93K(), {});
      assert.equal(result.ok, false);
      assert.ok(result.reason);
    },
    async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 })
  );
});

// --- 13: the gates are untouched -------------------------------------------

test('13. service area, location quality and push policy are all unchanged', () => {
  // 八堵 still blocked, even though the inventory would happily find cameras.
  const badu = {
    source: 'pbs', rawId: 'PBS-BADU', type: 'accident', pbsCategory: 'accident',
    road: '國道一號', direction: '南向', location: '八堵交流道',
    latitude: 25.10288, longitude: 121.71801, displayKM: 2.5,
  };
  assert.equal(broadcastDecision(badu, PBS_ONLY_ENV).reason, 'outside-service-area');

  // Unplaceable accident still blocked.
  const vague = normalizePbsEvent({
    UID: 'V', road: '(南寮竹東)-台68線', areaNm: '（南寮竹東）-台68線', direction: '西向',
    roadtype: '交通事故', comment: '西向發生交通事故',
    happendate: '2026-08-25', happentime: '19:01:00', modDttm: '2026-08-25 19:01:00',
  });
  assert.equal(broadcastDecision(vague, PBS_ONLY_ENV).reason, 'insufficient-location-precision');

  // Dynamic shoulder and non-accident still withheld.
  const shoulder = {
    source: 'pbs', rawId: 'S', type: 'control', road: '國道一號', direction: '南向',
    startKM: '93K+000', endKM: '93K+800', dynamicShoulder: { state: 'open', evidence: [] },
  };
  assert.equal(broadcastDecision(shoulder, PBS_ONLY_ENV).allowed, false);
  const construction = { source: 'pbs', rawId: 'C', type: 'construction', road: '國道一號', direction: '南向', displayKM: 93 };
  assert.equal(broadcastDecision(construction, PBS_ONLY_ENV).allowed, false);
});

test('14. no unverified road was added to the CCTV registry', () => {
  // 台68 has a perfectly good kilometre and still gets no camera — this
  // round did not widen the confirmed-road set.
  const t68 = normalizePbsEvent({
    UID: 'T', road: '(南寮竹東)-台68線', areaNm: '（南寮竹東）-台68線', direction: '西向',
    roadtype: '交通事故', comment: '西向8.3公里處發生交通事故',
    happendate: '2026-08-25', happentime: '19:01:00', modDttm: '2026-08-25 19:01:00',
  });
  assert.equal(t68.displayKM, 8.3);
  assert.equal(resolveCctvEligibility(t68).eligible, false);
});

// --- 15: it is visible on /health before the next accident -----------------

test('15. /health reports the inventory\'s state, source and age', () => {
  const base = {
    summary: { sources: [], tokenOk: true, kvAvailable: true },
    pbsSummary: { pbsOk: true },
    lineSummary: { lineReady: true },
    now: new Date('2026-08-25T12:00:00Z'),
  };

  const healthy = buildHealthSnapshot({
    ...base,
    cctvMetadata: { source: 'bundled', recordCount: 1943, fetchedAt: null, sourceName: null, sourceUpdatedAt: '2026-08-25T20:05:36+08:00' },
  });
  assert.equal(healthy.cctvMetadata.recordCount, 1943);
  assert.equal(healthy.cctvMetadata.source, 'bundled');
  assert.equal(healthy.cctvMetadata.sourceUpdatedAt, '2026-08-25T20:05:36+08:00');

  // The state that caused the incident must be representable and visible.
  const missing = buildHealthSnapshot({ ...base, cctvMetadata: { source: 'none', recordCount: 0, fetchedAt: null, sourceName: null, sourceUpdatedAt: null } });
  assert.equal(missing.cctvMetadata.recordCount, 0);

  // An older snapshot that predates this field must not break the page.
  assert.equal(buildHealthSnapshot(base).cctvMetadata, null);
});

test('16. the health page renders all three inventory states in Chinese', async () => {
  const { renderHealthCctvMetadataCardForTest } = await import('../src/traffic/health.js').then((m) => ({
    renderHealthCctvMetadataCardForTest: m.__renderCctvMetadataCardForTest,
  }));
  const now = new Date('2026-08-25T12:00:00Z');

  const ok = renderHealthCctvMetadataCardForTest({ source: 'bundled', recordCount: 1943, fetchedAt: null, sourceName: null, sourceUpdatedAt: '2026-08-25T20:05:36+08:00' }, now);
  assert.match(ok, /正常/);
  assert.match(ok, /1943/);

  const missing = renderHealthCctvMetadataCardForTest({ source: 'none', recordCount: 0, fetchedAt: null, sourceName: null, sourceUpdatedAt: null }, now);
  assert.match(missing, /遺失/);
  assert.match(missing, /攝影機基礎資料遺失，事故文字仍可播報，但 CCTV 圖片無法產生/);

  const old = renderHealthCctvMetadataCardForTest({ source: 'kv', recordCount: 1943, fetchedAt: '2026-01-01T00:00:00.000Z', sourceName: 'NFB_OPEN_DATA', sourceUpdatedAt: '2026-01-01T00:00:00+08:00' }, now);
  assert.match(old, /過舊/);
});
