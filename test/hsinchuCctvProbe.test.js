// V1.7 next stage — GET /admin/cctv-hsinchu-probe + /admin/cctv-hsinchu-frame/0..3.
// Exercises the real Worker entry point end to end. No real TDX or
// Production calls anywhere in this file — every fetch is mocked.
//
// V1.7 CCTV 四象限選鏡規則 / 4-camera cross-direction search (see
// PROJECT_HANDOFF.md section 14): candidates are selected into 4 fixed
// quadrant slots — [0]=S前 (S, km<target), [1]=S後 (S, km>target),
// [2]=N前 (N, km<target), [3]=N後 (N, km>target) — each independently
// preferring +/-2km, widening to +/-4km only if empty, else left null.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import worker from '../src/index.js';
import { extractFirstJpegFrame, MAX_FRAME_BYTES, PROBE_USED_KEY, CANDIDATES_KEY } from '../src/tdx/hsinchuCctvProbe.js';

const FIXED_USERNAME = 'admin';
const ADMIN_PASSWORD = 'test-admin-pass-hsinchu';
const TDX_CLIENT_ID = 'test-tdx-client-id-hsinchu';
const TDX_CLIENT_SECRET = 'test-tdx-client-secret-hsinchu';

function kv(initial, { failPutForValue } = {}) {
  const store = new Map();
  if (initial) for (const [k, v] of Object.entries(initial)) store.set(k, v);
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, _options) {
      if (failPutForValue && value === failPutForValue) throw new Error('KV write outage');
      store.set(key, value);
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    ADMIN_PASSWORD,
    TDX_CLIENT_ID,
    TDX_CLIENT_SECRET,
    TRAFFIC_KV: kv(),
    ...overrides,
  };
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function authedRequest(path) {
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, {
    method: 'GET',
    headers: { Authorization: basicAuthHeader(FIXED_USERNAME, ADMIN_PASSWORD) },
  });
}

function unauthedRequest(path) {
  return new Request(`https://traffic-reporter.example.workers.dev${path}`, { method: 'GET' });
}

// --- Mock CCTV metadata for the four-quadrant selector (TARGET_KM=82.1) ---
//
// Quadrant outcomes deliberately exercise all 3 tiers:
//   [0] S前 (S, km<82.1): CCTV-SB-NEAR (dist 0.1, within +/-2km) wins over
//       CCTV-SB-FAR (dist 2.1, also S-before but farther) -> nearest-wins.
//   [1] S後 (S, km>82.1): only CCTV-SA-WIDE (dist 3.4) exists -> nothing
//       within +/-2km, widens to +/-4km and picks it.
//   [2] N前 (N, km<82.1): only CCTV-NB-TOOFAR (dist 12.1) exists, which is
//       beyond +/-4km -> quadrant is left null, never reached further.
//   [3] N後 (N, km>82.1): CCTV-NA-NEAR (dist 1.4, within +/-2km) wins.

function cctvRecord(overrides) {
  return {
    CCTVID: 'CCTV-DEFAULT',
    RoadID: '000010',
    RoadName: '國道1號',
    RoadDirection: 'S',
    LocationMile: '82K+000',
    PositionLon: 120.9,
    PositionLat: 24.8,
    VideoStreamURL: 'https://cctv1.freeway.gov.tw/stream/default.jpg',
    ...overrides,
  };
}

const MOCK_RECORDS = [
  cctvRecord({ CCTVID: 'CCTV-SB-NEAR', RoadDirection: 'S', LocationMile: '82K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/sb-near.jpg' }), // S, before, dist 0.1 -> picked
  cctvRecord({ CCTVID: 'CCTV-SB-FAR', RoadDirection: 'S', LocationMile: '80K+000', VideoStreamURL: 'https://cctv2.freeway.gov.tw/sb-far.jpg' }), // S, before, dist 2.1 -> excluded (not nearest)
  cctvRecord({ CCTVID: 'CCTV-SA-WIDE', RoadDirection: 'S', LocationMile: '85K+500', VideoStreamURL: 'https://cctv3.freeway.gov.tw/sa-wide.jpg' }), // S, after, dist 3.4 -> picked via +/-4km widen
  cctvRecord({ CCTVID: 'CCTV-NB-TOOFAR', RoadDirection: 'N', LocationMile: '70K+000', VideoStreamURL: 'https://cctv4.freeway.gov.tw/nb-toofar.jpg' }), // N, before, dist 12.1 -> excluded, slot left null
  cctvRecord({ CCTVID: 'CCTV-NA-NEAR', RoadDirection: 'N', LocationMile: '83K+500', VideoStreamURL: 'https://cctv5.freeway.gov.tw/na-near.jpg' }), // N, after, dist 1.4 -> picked
  cctvRecord({ CCTVID: 'CCTV-WRONGROAD', RoadID: '000030', RoadName: '國道3號', LocationMile: '82K+000', VideoStreamURL: 'https://cctv6.freeway.gov.tw/wrong.jpg' }), // wrong road -> excluded
  cctvRecord({ CCTVID: 'CCTV-NOURL', LocationMile: '82K+050', VideoStreamURL: '' }), // no image URL -> excluded
  cctvRecord({ CCTVID: 'CCTV-BADKM', LocationMile: 'N/A', VideoStreamURL: 'https://cctv7.freeway.gov.tw/badkm.jpg' }), // unparseable KM -> excluded
  cctvRecord({ CCTVID: 'CCTV-NODIR', RoadDirection: 'X', LocationMile: '82K+000', VideoStreamURL: 'https://cctv8.freeway.gov.tw/nodir.jpg' }), // unrecognized direction -> excluded
];

// Index-aligned to QUADRANTS: [S前, S後, N前, N後].
const EXPECTED_QUADRANT_ORDER = ['CCTV-SB-NEAR', 'CCTV-SA-WIDE', null, 'CCTV-NA-NEAR'];

function makeFetch({ cctvStatus = 200, cctvRecords = MOCK_RECORDS, tokenStatus = 200 } = {}) {
  const tdxHits = [];

  const fetchFn = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      tdxHits.push({ kind: 'token', href });
      if (tokenStatus !== 200) return new Response('unauthorized', { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/Road/Traffic/CCTV/Freeway')) {
      tdxHits.push({ kind: 'cctv-metadata', href });
      if (cctvStatus !== 200) return new Response('error', { status: cctvStatus });
      return new Response(JSON.stringify({ CCTVs: cctvRecords }), { status: 200 });
    }
    throw new Error(`unexpected TDX-side fetch in test: ${href}`);
  };

  return { fetchFn, tdxHits };
}

function textBytes(str) {
  return new TextEncoder().encode(str);
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);

/** A well-behaved MJPEG stream: preamble, one complete JPEG frame, then trailing bytes for the "next" frame — must never be read if extraction stops correctly. */
function mjpegStreamThatHangsAfterFrame() {
  let pullCount = 0;
  return new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(textBytes('--myboundary\r\nContent-Type: image/jpeg\r\n\r\n'));
        return;
      }
      if (pullCount === 2) {
        controller.enqueue(JPEG_BYTES);
        return;
      }
      // A 3rd pull means extraction kept reading past the complete frame
      // — hang forever so the test itself fails/times out instead of
      // silently passing.
      return new Promise(() => {});
    },
  });
}

function oversizedStream() {
  const CHUNK = new Uint8Array(65536); // no FF D8/FF D9 anywhere in this data
  const chunkCount = Math.ceil((MAX_FRAME_BYTES + 65536) / CHUNK.length);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(CHUNK);
    },
  });
}

// Simulates a stalled upstream (connected, but the stream never produces
// a complete JPEG) that eventually errors out the way a real aborted
// fetch would. Uses its own setTimeout rather than actually observing
// the AbortSignal passed to fetch() — production code (extractFirstJpegFrame)
// legitimately relies on the standard, independently-verified Fetch API
// contract that `AbortSignal.timeout()` aborts an in-flight fetch/read;
// this test only needs to prove OUR code correctly classifies and
// reports that failure once it happens, which this simulates directly.
function hangingThenErrorsStream(delayMs) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(textBytes('--myboundary\r\n')); // no complete JPEG yet
      setTimeout(() => {
        controller.error(Object.assign(new Error('simulated timeout'), { name: 'AbortError' }));
      }, delayMs);
    },
  });
}

let priorFetch;
afterEach(() => {
  if (priorFetch) globalThis.fetch = priorFetch;
  priorFetch = undefined;
  resetTdxTokenCache();
});

// --- 1. not logged in -> 0 TDX calls ---

test('1. GET /admin/cctv-hsinchu-probe with no Authorization -> 401, 0 TDX calls', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 401);
  assert.equal(tdxHits.length, 0);
});

test('1b. GET /admin/cctv-hsinchu-frame/0 with no Authorization -> 401, 0 TDX calls', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(unauthedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 401);
  assert.equal(tdxHits.length, 0);
});

// --- 2. metadata called at most once, and fills the 4 quadrant slots ---

test('2. first legitimate run makes exactly 1 CCTV metadata call and selects the four-quadrant candidates (S前/S後/N前/N後) in order', async () => {
  const env = baseEnv();
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  assert.equal(tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);

  const html = await res.text();
  // Filled quadrant slots (0, 1, 3) rendered as image tags pointing at
  // their frame endpoint; the empty quadrant (2, N前) has no image tag.
  assert.match(html, /\/admin\/cctv-hsinchu-frame\/0/);
  assert.match(html, /\/admin\/cctv-hsinchu-frame\/1/);
  assert.doesNotMatch(html, /\/admin\/cctv-hsinchu-frame\/2/);
  assert.match(html, /\/admin\/cctv-hsinchu-frame\/3/);
  // Excluded records never leak into the page.
  assert.doesNotMatch(html, /CCTV-SB-FAR|CCTV-NB-TOOFAR|CCTV-WRONGROAD|CCTV-NOURL|CCTV-BADKM|CCTV-NODIR/);
  // All 4 quadrant labels are visible, including the empty one.
  assert.match(html, /S前/);
  assert.match(html, /S後/);
  assert.match(html, /N前/);
  assert.match(html, /N後/);
  assert.match(html, /無符合鏡頭/); // the empty N前 slot is shown explicitly, not omitted
  assert.match(html, /TDX CCTV metadata calls: 1/);
  assert.match(html, /CCTV quadrants filled: 3 \/ 4/);

  const storedRaw = env.TRAFFIC_KV.store.get(CANDIDATES_KEY);
  const stored = JSON.parse(storedRaw);
  assert.equal(stored.candidates.length, 4);
  assert.deepEqual(stored.candidates.map((c) => (c ? c.cctvId : null)), EXPECTED_QUADRANT_ORDER);
  // Only the 6 allowed fields are persisted on each filled slot; the empty
  // slot is persisted as a literal null, not omitted.
  for (const c of stored.candidates) {
    if (c === null) continue;
    assert.deepEqual(Object.keys(c).sort(), ['cctvId', 'locationMile', 'positionLat', 'positionLon', 'roadDirection', 'videoStreamUrl'].sort());
  }
  assert.equal(stored.candidates[2], null);
});

// --- 2b/2c: distance-tier boundaries, isolated from the other quadrants ---

test('2b. a quadrant with nothing within +/-2km widens to +/-4km and picks the nearest candidate there', async () => {
  const env = baseEnv();
  const records = [
    cctvRecord({ CCTVID: 'CCTV-WIDEN-HIT', RoadDirection: 'S', LocationMile: '85K+900', VideoStreamURL: 'https://cctv1.freeway.gov.tw/widen-hit.jpg' }), // S, after, dist 3.8 -> within +/-4km
  ];
  const { fetchFn } = makeFetch({ cctvRecords: records });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const stored = JSON.parse(env.TRAFFIC_KV.store.get(CANDIDATES_KEY));
  assert.equal(stored.candidates[1].cctvId, 'CCTV-WIDEN-HIT'); // S後 slot
});

test('2c. a quadrant with nothing within +/-4km is left null — never reaches further to fill the slot', async () => {
  const env = baseEnv();
  const records = [
    cctvRecord({ CCTVID: 'CCTV-TOO-FAR', RoadDirection: 'N', LocationMile: '77K+000', VideoStreamURL: 'https://cctv1.freeway.gov.tw/too-far.jpg' }), // N, before, dist 5.1 -> beyond +/-4km
  ];
  const { fetchFn } = makeFetch({ cctvRecords: records });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const stored = JSON.parse(env.TRAFFIC_KV.store.get(CANDIDATES_KEY));
  assert.deepEqual(stored.candidates, [null, null, null, null]); // N前 (and every other quadrant) stays empty
  const html = await res.text();
  assert.doesNotMatch(html, /CCTV-TOO-FAR/);
  assert.match(html, /CCTV quadrants filled: 0 \/ 4/);
});

// --- 2d-2g: V1.8.1 hard rule — 服務區/休息站/服務站 CCTV must never be
// selected as an incident camera, no matter how close its KM is. The
// real-world case that surfaced this: 國1 82K+100 incident, N後 quadrant
// picking 86K+000 "北上湖口服務區" over a legitimate mainline camera.

test('2d. a service-area camera is excluded even though it is the single nearest candidate in its quadrant — a farther mainline camera is picked instead', async () => {
  const env = baseEnv();
  const records = [
    // N後 quadrant (N, km>82.1): the real-world case — 86K+000 "北上湖口服務區"
    // (dist 3.9, the NEAREST candidate) must be excluded; a farther-but-
    // still-within-+/-4km mainline camera (86K+050, dist 3.95) must win.
    cctvRecord({ CCTVID: 'CCTV-HUKOU-SA', RoadDirection: 'N', LocationMile: '86K+000', RoadSection: '北上湖口服務區', VideoStreamURL: 'https://cctv1.freeway.gov.tw/hukou-sa.jpg' }), // dist 3.90, nearest, service area -> must be excluded
    cctvRecord({ CCTVID: 'CCTV-MAINLINE-FAR', RoadDirection: 'N', LocationMile: '86K+050', VideoStreamURL: 'https://cctv2.freeway.gov.tw/mainline-far.jpg' }), // dist 3.95, farther, mainline -> must win once the SA one is excluded
  ];
  const { fetchFn, tdxHits } = makeFetch({ cctvRecords: records });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  // The service-area exclusion is local filtering on the SAME single
  // metadata response — it must never add a second TDX call.
  assert.equal(tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);
  const stored = JSON.parse(env.TRAFFIC_KV.store.get(CANDIDATES_KEY));
  assert.equal(stored.candidates[3].cctvId, 'CCTV-MAINLINE-FAR'); // N後 slot
  const html = await res.text();
  assert.doesNotMatch(html, /CCTV-HUKOU-SA/);
  assert.doesNotMatch(html, /湖口服務區/);
});

test('2e. a quadrant whose only candidates within +/-4km are all service-area cameras is left null, never backfilled with one', async () => {
  const env = baseEnv();
  const records = [
    cctvRecord({ CCTVID: 'CCTV-SA-ONLY', RoadDirection: 'N', LocationMile: '86K+000', RoadSection: '北上湖口服務區', VideoStreamURL: 'https://cctv1.freeway.gov.tw/sa-only.jpg' }), // N, after, dist 3.9, service area -> excluded, N後 has nothing else
  ];
  const { fetchFn } = makeFetch({ cctvRecords: records });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const stored = JSON.parse(env.TRAFFIC_KV.store.get(CANDIDATES_KEY));
  assert.equal(stored.candidates[3], null); // N後 stays empty — never filled with the service-area camera
  const html = await res.text();
  assert.doesNotMatch(html, /CCTV-SA-ONLY|湖口服務區/);
  assert.match(html, /CCTV quadrants filled: 0 \/ 4/);
});

test('2f. a service-area camera much closer than a mainline camera is still rejected — proximity never overrides the exclusion', async () => {
  const env = baseEnv();
  const records = [
    // S後 quadrant (S, km>82.1): service-area camera at dist 0.1, mainline at dist 0.5.
    cctvRecord({ CCTVID: 'CCTV-SA-VERYNEAR', RoadDirection: 'S', LocationMile: '82K+200', RoadName: '國道1號', RoadSection: '南下服務區', VideoStreamURL: 'https://cctv1.freeway.gov.tw/sa-verynear.jpg' }), // dist 0.1, service area -> excluded despite being nearest
    cctvRecord({ CCTVID: 'CCTV-MAINLINE-NEAR', RoadDirection: 'S', LocationMile: '82K+600', VideoStreamURL: 'https://cctv2.freeway.gov.tw/mainline-near.jpg' }), // dist 0.5, mainline -> must win
  ];
  const { fetchFn } = makeFetch({ cctvRecords: records });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const stored = JSON.parse(env.TRAFFIC_KV.store.get(CANDIDATES_KEY));
  assert.equal(stored.candidates[1].cctvId, 'CCTV-MAINLINE-NEAR'); // S後 slot
});

test('2g. 休息站/服務站 keywords are excluded the same as 服務區, regardless of which field carries the text — and exclusion is load-bearing (the excluded candidates are the NEARER ones)', async () => {
  const env = baseEnv();
  const records = [
    // N前 quadrant (N, km<82.1). Deliberately: both excluded candidates
    // are NEARER to the incident than the mainline one — if exclusion
    // were broken, one of them (not CCTV-MAINLINE) would win.
    cctvRecord({ CCTVID: 'CCTV-SERVICE-STATION', RoadDirection: 'N', LocationMile: '81K+800', LocationType: '服務站', VideoStreamURL: 'https://cctv1.freeway.gov.tw/service-station.jpg' }), // dist 0.3 (nearest of the 3), keyword in LocationType (as literal text, not a guessed enum code) -> excluded
    cctvRecord({ CCTVID: 'CCTV-REST-STOP', RoadDirection: 'N', LocationMile: '81K+500', RoadName: '國道1號 頭份休息站', VideoStreamURL: 'https://cctv2.freeway.gov.tw/rest-stop.jpg' }), // dist 0.6, keyword in RoadName -> excluded
    cctvRecord({ CCTVID: 'CCTV-MAINLINE', RoadDirection: 'N', LocationMile: '81K+100', VideoStreamURL: 'https://cctv3.freeway.gov.tw/mainline.jpg' }), // dist 1.0 (farthest of the 3, but only eligible one) -> must win
  ];
  const { fetchFn } = makeFetch({ cctvRecords: records });
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const stored = JSON.parse(env.TRAFFIC_KV.store.get(CANDIDATES_KEY));
  assert.equal(stored.candidates[2].cctvId, 'CCTV-MAINLINE'); // N前 slot
  const html = await res.text();
  assert.doesNotMatch(html, /CCTV-SERVICE-STATION|CCTV-REST-STOP|服務站|休息站/);
});

// --- 3. refresh after completion uses KV, 0 TDX calls ---

test('3. after completion, refreshing the probe page reads candidates from KV -> 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;
  const res1 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res1.status, 200);
  assert.equal(env.TRAFFIC_KV.store.get(PROBE_USED_KEY), 'completed');

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res2.status, 200);
  assert.equal(second.tdxHits.length, 0);
  const html2 = await res2.text();
  assert.match(html2, /CCTV quadrants filled: 3 \/ 4/);
});

// --- 4. all filled frame endpoints make 0 TDX calls; the empty quadrant 404s ---

test('4. all filled /admin/cctv-hsinchu-frame/N endpoints make 0 TDX calls; the empty quadrant slot 404s', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env); // populates candidates KV

  const frameHits = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('tdx.transportdata.tw')) {
      frameHits.push(href);
      throw new Error('frame endpoints must never call TDX');
    }
    return new Response(mjpegStreamThatHangsAfterFrame(), { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' } });
  };

  // Filled slots: 0 (S前), 1 (S後), 3 (N後).
  for (const i of [0, 1, 3]) {
    const res = await worker.fetch(authedRequest(`/admin/cctv-hsinchu-frame/${i}`), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  }
  // Empty slot: 2 (N前) — 404, never fetched.
  const emptyRes = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/2'), env);
  assert.equal(emptyRes.status, 404);
  assert.equal(frameHits.length, 0);
});

test('4b. /admin/cctv-hsinchu-frame/4 (a 5th slot) is not a registered route — the hard 4-camera cap', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);

  globalThis.fetch = async () => {
    throw new Error('must never fetch for an out-of-range frame index');
  };
  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/4'), env);
  assert.equal(res.status, 404);
});

// --- 5. frame request carries no Authorization header ---

test('5. the frame fetch to freeway.gov.tw never includes an Authorization header', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);

  let sawAuthHeader = false;
  let sawFreewayCall = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('freeway.gov.tw')) {
      sawFreewayCall = true;
      if (init && init.headers && (init.headers.Authorization || init.headers.authorization)) sawAuthHeader = true;
      return new Response(mjpegStreamThatHangsAfterFrame(), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 200);
  assert.equal(sawFreewayCall, true);
  assert.equal(sawAuthHeader, false);
});

// --- 6. non-freeway.gov.tw URL is rejected ---

test('6. a candidate whose VideoStreamURL is not on *.freeway.gov.tw is rejected (400), never fetched', async () => {
  const env = baseEnv();
  await env.TRAFFIC_KV.put(
    PROBE_USED_KEY,
    'completed'
  );
  await env.TRAFFIC_KV.put(
    CANDIDATES_KEY,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidates: [{ cctvId: 'CCTV-EVIL', roadDirection: 'N', locationMile: '82K+000', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'https://evil.example.com/steal.jpg' }],
    })
  );

  let called = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    called = true;
    throw new Error(`must never fetch untrusted host: ${url}`);
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('6b. a plain-http (non-https) VideoStreamURL is rejected, never fetched', async () => {
  const env = baseEnv();
  await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'completed');
  await env.TRAFFIC_KV.put(
    CANDIDATES_KEY,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidates: [{ cctvId: 'CCTV-HTTP', roadDirection: 'N', locationMile: '82K+000', positionLon: 120.9, positionLat: 24.8, videoStreamUrl: 'http://cctv1.freeway.gov.tw/a.jpg' }],
    })
  );
  let called = false;
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must never fetch a non-https URL');
  };

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

// --- 7. MJPEG capture: extracts the first complete JPEG and stops reading ---

test('7. extractFirstJpegFrame captures exactly the first complete JPEG frame and stops reading the stream', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(mjpegStreamThatHangsAfterFrame(), { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' } });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [...JPEG_BYTES]);
});

// --- 8. over 2MB with no complete frame -> abort ---

test('8. a stream exceeding 2MB with no complete JPEG marker pair -> aborted, reason too-large', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(oversizedStream(), { status: 200 });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
});

// --- 9. timeout -> abort ---

test('9. a stalled stream is aborted once the timeout elapses', async () => {
  priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(hangingThenErrorsStream(30), { status: 200 });

  const result = await extractFirstJpegFrame('https://cctv1.freeway.gov.tw/a.jpg', { timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

// --- 10. webhook / Cron entirely unaffected ---

test('10a. POST /webhook is unaffected by the new hsinchu endpoints existing', async () => {
  const env = { TRAFFIC_KV: kv(), LINE_CHANNEL_SECRET: undefined };
  const req = new Request('https://traffic-reporter.example.workers.dev/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.headers.get('WWW-Authenticate'), null);
  assert.notEqual(res.status, 503);
});

test('10b. scheduled()/Cron is unaffected by the new hsinchu endpoints existing', async () => {
  const env = { TRAFFIC_KV: kv() };
  priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) return new Response('unauthorized', { status: 401 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  let waited;
  const ctx = { waitUntil: (p) => { waited = p; } };
  worker.scheduled({}, env, ctx);
  await waited;
});

// --- extra: PRE-ARM guard mirrors tdx/cctvProbe.js's fix ---

test('PRE-ARM: metadata failure leaves KV "armed"; a refresh makes 0 TDX calls', async () => {
  const env = baseEnv();
  const first = makeFetch({ cctvStatus: 500 });
  priorFetch = globalThis.fetch;
  globalThis.fetch = first.fetchFn;
  const res1 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res1.status, 502);
  assert.equal(env.TRAFFIC_KV.store.get(PROBE_USED_KEY), 'armed');
  assert.equal(first.tdxHits.filter((h) => h.kind === 'cctv-metadata').length, 1);

  const second = makeFetch();
  globalThis.fetch = second.fetchFn;
  const res2 = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res2.status, 200);
  assert.equal(second.tdxHits.length, 0);
});

test('PRE-ARM: pre-arm KV.put failure -> 503, 0 TDX calls at all', async () => {
  const env = baseEnv({ TRAFFIC_KV: kv(undefined, { failPutForValue: 'armed' }) });
  const { fetchFn, tdxHits } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 503);
  assert.equal(tdxHits.length, 0);
});

test('no secrets ever appear in the probe page or frame error responses', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  const raw = await res.text();
  assert.doesNotMatch(raw, new RegExp(ADMIN_PASSWORD));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_ID));
  assert.doesNotMatch(raw, new RegExp(TDX_CLIENT_SECRET));
  assert.doesNotMatch(raw, /Bearer\s+\S+/);
});

// --- CSP hotfix: the probe page's same-origin <img> tags must not be blocked ---

test('CSP: /admin/cctv-hsinchu-probe HTML response includes img-src \'self\'', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  assert.equal(res.status, 200);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /img-src 'self'/);
});

test('CSP: /admin/cctv-hsinchu-probe response never allows img-src *', async () => {
  const env = baseEnv();
  const { fetchFn } = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env);
  const csp = res.headers.get('Content-Security-Policy');
  assert.doesNotMatch(csp, /img-src \*/);
  assert.doesNotMatch(csp, /img-src[^;]*freeway\.gov\.tw/); // never allow the CCTV host directly either
});

test('CSP: the /admin/cctv-hsinchu-frame/N image/jpeg response never gets the HTML-only CSP header', async () => {
  const env = baseEnv();
  const setup = makeFetch();
  priorFetch = globalThis.fetch;
  globalThis.fetch = setup.fetchFn;
  await worker.fetch(authedRequest('/admin/cctv-hsinchu-probe'), env); // populates candidates KV

  globalThis.fetch = async () =>
    new Response(mjpegStreamThatHangsAfterFrame(), { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace;boundary=--myboundary' } });

  const res = await worker.fetch(authedRequest('/admin/cctv-hsinchu-frame/0'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(res.headers.get('Content-Security-Policy'), null);
});
