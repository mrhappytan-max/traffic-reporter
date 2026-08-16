import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { applyCongestionSeverityValidation, SEVERE_CONGESTION_MAX_KPH } from '../src/traffic/congestionValidation.js';

const FAKE_ENV = { TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' };

const VD_STATIC_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/Freeway?$format=JSON';
const VD_LIVE_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON';

function congestionEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-1',
    type: 'congestion',
    congestionSeverity: 'congested',
    road: '國道一號',
    direction: '北向',
    startKM: '92K+000',
    endKM: '91K+000',
    description: '北向壅塞',
    updatedAt: '2026-08-15T10:00:00+08:00',
    ...overrides,
  };
}

function accidentEvent(overrides = {}) {
  return {
    source: 'freeway',
    rawId: 'FRW-2',
    type: 'accident',
    road: '國道一號',
    direction: '北向',
    startKM: '50K+000',
    endKM: '50K+000',
    description: '事故',
    updatedAt: '2026-08-15T10:00:00+08:00',
    ...overrides,
  };
}

function mockVdFetch({ speed } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href === VD_STATIC_URL) {
      return new Response(
        JSON.stringify({ VDs: [{ VDID: 'VD-1', RoadName: '國道一號', RoadDirection: 'N', LocationMile: '91K+500' }] }),
        { status: 200 }
      );
    }
    if (href === VD_LIVE_URL) {
      return new Response(
        JSON.stringify({ VDLives: [{ VDID: 'VD-1', LinkFlows: [{ Lanes: [{ Speed: speed }] }] }] }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

let originalFetch;
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  resetTdxTokenCache();
});

test('no congestion events at all -> does not call fetch (lazy, zero extra TDX calls)', async () => {
  let fetchCalled = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('should never be called');
  };

  const events = [accidentEvent()];
  const result = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.equal(fetchCalled, false);
  assert.deepEqual(result, events);
});

test('VD confirms low speed (< SEVERE_CONGESTION_MAX_KPH) nearby -> upgraded to severe', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockVdFetch({ speed: SEVERE_CONGESTION_MAX_KPH - 5 });

  const events = [congestionEvent(), accidentEvent()];
  const [congestion, accident] = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.equal(congestion.congestionSeverity, 'severe');
  // accident is untouched — same object even (never passed through any
  // severity logic at all).
  assert.equal(accident, events[1]);
});

test('VD reports normal speed (>= threshold) nearby -> severity NOT upgraded, stays as classified', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockVdFetch({ speed: SEVERE_CONGESTION_MAX_KPH + 20 });

  const events = [congestionEvent({ congestionSeverity: 'moderate' })];
  const [result] = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.equal(result.congestionSeverity, 'moderate'); // never upgraded
});

test('no nearby VD reading at all -> severity unchanged (fail-safe, not an error)', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href === VD_STATIC_URL) return new Response(JSON.stringify({ VDs: [] }), { status: 200 });
    if (href === VD_LIVE_URL) return new Response(JSON.stringify({ VDLives: [] }), { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  };

  const events = [congestionEvent({ congestionSeverity: 'congested' })];
  const [result] = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.equal(result.congestionSeverity, 'congested');
});

test('VD fetch fails entirely (network error) -> fail-safe, congestion event untouched, never throws', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openid-connect/token')) throw new Error('network down');
    throw new Error('should not reach here');
  };

  const events = [congestionEvent()];
  const result = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.deepEqual(result, events); // completely unchanged
});

test('a mix of accident/construction/closure/control events alongside congestion: only congestion is ever touched', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockVdFetch({ speed: SEVERE_CONGESTION_MAX_KPH - 5 });

  const construction = { ...accidentEvent({ rawId: 'FRW-3' }), type: 'construction' };
  const closure = { ...accidentEvent({ rawId: 'FRW-4' }), type: 'closure' };
  const control = { ...accidentEvent({ rawId: 'FRW-5' }), type: 'control' };
  const events = [congestionEvent(), accidentEvent(), construction, closure, control];

  const result = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.equal(result[0].congestionSeverity, 'severe');
  assert.equal(result[1], events[1]);
  assert.equal(result[2], events[2]);
  assert.equal(result[3], events[3]);
  assert.equal(result[4], events[4]);
});

test('input array is never mutated in place — returns new event objects', async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockVdFetch({ speed: SEVERE_CONGESTION_MAX_KPH - 5 });

  const original = congestionEvent();
  const events = [original];
  const [result] = await applyCongestionSeverityValidation(events, FAKE_ENV);

  assert.notEqual(result, original); // new object
  assert.equal(original.congestionSeverity, 'congested'); // original untouched
  assert.equal(result.congestionSeverity, 'severe');
});
