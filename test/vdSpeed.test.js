import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { fetchFreewayVdSpeeds, findNearbySpeedKph, VD_MATCH_MAX_KM_DIFF } from '../src/tdx/vdSpeed.js';

const FAKE_ENV = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' };

const VD_STATIC_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/Freeway?$format=JSON';
const VD_LIVE_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON';
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
}

function mockFetch({ staticVds = [], liveVds = [], staticStatus = 200, liveStatus = 200 } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return tokenResponse();
    if (href === VD_STATIC_URL) return new Response(JSON.stringify({ VDs: staticVds }), { status: staticStatus });
    if (href === VD_LIVE_URL) return new Response(JSON.stringify({ VDLives: liveVds }), { status: liveStatus });
    throw new Error(`unexpected fetch: ${href}`);
  };
}

afterEach(() => {
  resetTdxTokenCache();
});

test('joins static (road/direction/km) with live (speed) by VDID, taking the slowest lane', async () => {
  globalThis.fetch = mockFetch({
    staticVds: [{ VDID: 'VD-1', RoadName: '國道一號', RoadDirection: 'N', LocationMile: '92K+000' }],
    liveVds: [
      {
        VDID: 'VD-1',
        LinkFlows: [{ Lanes: [{ Speed: 80 }, { Speed: 25 }] }],
      },
    ],
  });

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], { road: '國道一號', direction: '北向', km: 92, speedKph: 25 });
});

test('direction code N/S/E/W is normalized to Chinese 北向/南向/東向/西向', async () => {
  globalThis.fetch = mockFetch({
    staticVds: [
      { VDID: 'VD-S', RoadName: '國道一號', RoadDirection: 'S', LocationMile: '80K+000' },
      { VDID: 'VD-E', RoadName: '台68', RoadDirection: 'E', LocationMile: '5K+000' },
    ],
    liveVds: [
      { VDID: 'VD-S', LinkFlows: [{ Lanes: [{ Speed: 60 }] }] },
      { VDID: 'VD-E', LinkFlows: [{ Lanes: [{ Speed: 60 }] }] },
    ],
  });

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.records.find((r) => r.road === '國道一號').direction, '南向');
  assert.equal(result.records.find((r) => r.road === '台68').direction, '東向');
});

test('a live VDID with no matching static record is skipped, not crashed on', async () => {
  globalThis.fetch = mockFetch({
    staticVds: [{ VDID: 'VD-1', RoadName: '國道一號', RoadDirection: 'N', LocationMile: '92K+000' }],
    liveVds: [
      { VDID: 'VD-1', LinkFlows: [{ Lanes: [{ Speed: 30 }] }] },
      { VDID: 'VD-UNKNOWN', LinkFlows: [{ Lanes: [{ Speed: 10 }] }] },
    ],
  });

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].speedKph, 30);
});

test('negative "no data" sentinel speeds (-99/-1) are never treated as a real (very slow) reading', async () => {
  globalThis.fetch = mockFetch({
    staticVds: [{ VDID: 'VD-1', RoadName: '國道一號', RoadDirection: 'N', LocationMile: '92K+000' }],
    liveVds: [{ VDID: 'VD-1', LinkFlows: [{ Lanes: [{ Speed: -99 }, { Speed: 55 }] }] }],
  });

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.records[0].speedKph, 55);
});

test('a static record missing road or a parseable KM is skipped (not joinable)', async () => {
  globalThis.fetch = mockFetch({
    staticVds: [
      { VDID: 'VD-NO-ROAD', RoadDirection: 'N', LocationMile: '92K+000' },
      { VDID: 'VD-NO-KM', RoadName: '國道一號', RoadDirection: 'N' },
    ],
    liveVds: [
      { VDID: 'VD-NO-ROAD', LinkFlows: [{ Lanes: [{ Speed: 10 }] }] },
      { VDID: 'VD-NO-KM', LinkFlows: [{ Lanes: [{ Speed: 10 }] }] },
    ],
  });

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 0);
});

test('network/HTTP failure never throws — resolves ok:false with empty records', async () => {
  globalThis.fetch = mockFetch({ liveStatus: 500 });

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.ok, false);
  assert.equal(result.records.length, 0);
  assert.equal(typeof result.error, 'string');
});

test('TDX OAuth failure (e.g. 429) never throws — resolves ok:false', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) return new Response('rate limited', { status: 429 });
    throw new Error('should not reach VD endpoints without a token');
  };

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.ok, false);
  assert.equal(result.records.length, 0);
});

test('an unexpected envelope shape (no VDs/VDLives array) degrades to zero records, not a crash', async () => {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return tokenResponse();
    if (href === VD_STATIC_URL) return new Response(JSON.stringify({ somethingElse: 'unexpected' }), { status: 200 });
    if (href === VD_LIVE_URL) return new Response(JSON.stringify({ somethingElse: 'unexpected' }), { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };

  const result = await fetchFreewayVdSpeeds(FAKE_ENV);
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 0);
});

test('findNearbySpeedKph: matches within VD_MATCH_MAX_KM_DIFF, same road+direction, takes the slowest', () => {
  const records = [
    { road: '國道一號', direction: '北向', km: 92, speedKph: 60 },
    { road: '國道一號', direction: '北向', km: 93, speedKph: 20 },
    { road: '國道一號', direction: '南向', km: 92, speedKph: 5 }, // wrong direction -> excluded
    { road: '台68', direction: '北向', km: 92, speedKph: 1 }, // wrong road -> excluded
  ];
  const speed = findNearbySpeedKph(records, { road: '國道一號', direction: '北向', km: 92 });
  assert.equal(speed, 20);
});

test('findNearbySpeedKph: outside VD_MATCH_MAX_KM_DIFF -> null', () => {
  const records = [{ road: '國道一號', direction: '北向', km: 92 + VD_MATCH_MAX_KM_DIFF + 1, speedKph: 10 }];
  const speed = findNearbySpeedKph(records, { road: '國道一號', direction: '北向', km: 92 });
  assert.equal(speed, null);
});

test('findNearbySpeedKph: no records at all, or unusable km -> null (never throws)', () => {
  assert.equal(findNearbySpeedKph([], { road: '國道一號', direction: '北向', km: 92 }), null);
  assert.equal(findNearbySpeedKph([{ road: '國道一號', direction: '北向', km: 92, speedKph: 10 }], { road: '國道一號', direction: '北向', km: null }), null);
});
