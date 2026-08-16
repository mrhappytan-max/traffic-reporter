import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetTdxTokenCache } from '../src/tdx/auth.js';
import { runScheduledTdxSync } from '../src/traffic/scheduled.js';
import { setUserEnabled } from '../src/traffic/subscriptions.js';
import { PBS_BROADCAST_ENABLED } from '../src/pbs/pbsConfig.js';

function kv() {
  const store = new Map();
  return { store, async get(key) { return store.get(key) ?? null; }, async put(key, value) { store.set(key, value); } };
}

afterEach(() => resetTdxTokenCache());

test('PBS is never passed to LINE, even when the Windows relay is healthy', async () => {
  const TRAFFIC_KV = kv();
  await setUserEnabled(TRAFFIC_KV, 'U1', true, new Date('2026-08-01T00:00:00+08:00'));
  let lineCalled = false;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (href.includes('RoadEvent') || href.includes('/CMS') || href.includes('/Bus/Alert')) return new Response(JSON.stringify({ RoadEvents: [], CMSs: [], Alerts: [] }), { status: 200 });
    if (href.includes('api.line.me')) lineCalled = true;
    return new Response('{}', { status: 200 });
  };
  try {
    const result = await runScheduledTdxSync({
      TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token', TRAFFIC_KV,
      PBS_RELAY_TOKEN: 'relay-token',
      PBS_RELAY_WINDOWS: { fetch: async () => new Response(JSON.stringify([]), { status: 200 }) },
    }, new Date('2026-08-15T10:00:00+08:00'));
    assert.equal(result.pbs.pbsOk, true);
    assert.equal(PBS_BROADCAST_ENABLED, false);
    assert.equal(result.line.broadcastRelevantCount, 0);
    assert.equal(lineCalled, false);
  } finally {
    globalThis.fetch = priorFetch;
  }
});
