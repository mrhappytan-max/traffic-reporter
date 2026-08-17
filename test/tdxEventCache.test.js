// V1.6.2 — unit tests for tdxEventCache.js (persist/read only, no
// pipeline involved). Integration-level coverage of the actual PBS-only
// cross-source dedup fix lives in pbsOnlyCrossSourceDedup.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  persistProductionTdxEventCache,
  readProductionTdxEventCache,
  TDX_EVENT_CACHE_MAX_AGE_MS,
} from '../src/traffic/tdxEventCache.js';

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

const SAMPLE_EVENTS = [
  { source: 'freeway', rawId: 'FRW-1', type: 'accident', road: '國道一號', direction: '北向', startKM: 92, endKM: 92.5 },
];

test('persist + read round-trip: fresh cache is used as-is, not stale', async () => {
  const TRAFFIC_KV = kv();
  const writtenAt = new Date('2026-08-18T08:00:00+08:00');
  const commit = await persistProductionTdxEventCache(TRAFFIC_KV, SAMPLE_EVENTS, writtenAt);
  assert.equal(commit.committed, true);

  const readAt = new Date('2026-08-18T08:10:00+08:00'); // +10 min
  const { events, lastFetchedAt, stale } = await readProductionTdxEventCache(TRAFFIC_KV, readAt);
  assert.equal(stale, false);
  assert.equal(lastFetchedAt, writtenAt.toISOString());
  assert.deepEqual(events, SAMPLE_EVENTS);
});

test('cache exactly at the 30-min boundary is still usable', async () => {
  const TRAFFIC_KV = kv();
  const writtenAt = new Date('2026-08-18T08:00:00+08:00');
  await persistProductionTdxEventCache(TRAFFIC_KV, SAMPLE_EVENTS, writtenAt);

  const readAt = new Date(writtenAt.getTime() + TDX_EVENT_CACHE_MAX_AGE_MS); // exactly 30 min
  const { events, stale } = await readProductionTdxEventCache(TRAFFIC_KV, readAt);
  assert.equal(stale, false);
  assert.deepEqual(events, SAMPLE_EVENTS);
});

test('cache older than 30 min is stale -> events=[], never used', async () => {
  const TRAFFIC_KV = kv();
  const writtenAt = new Date('2026-08-18T08:00:00+08:00');
  await persistProductionTdxEventCache(TRAFFIC_KV, SAMPLE_EVENTS, writtenAt);

  const readAt = new Date(writtenAt.getTime() + TDX_EVENT_CACHE_MAX_AGE_MS + 1000); // 30min + 1s
  const { events, lastFetchedAt, stale } = await readProductionTdxEventCache(TRAFFIC_KV, readAt);
  assert.equal(stale, true);
  assert.deepEqual(events, []);
  assert.equal(lastFetchedAt, writtenAt.toISOString()); // still reported, for diagnostics
});

test('no cache written yet -> events=[], stale=true, lastFetchedAt=null', async () => {
  const { events, lastFetchedAt, stale } = await readProductionTdxEventCache(kv(), new Date());
  assert.deepEqual(events, []);
  assert.equal(lastFetchedAt, null);
  assert.equal(stale, true);
});

test('no TRAFFIC_KV binding -> events=[], stale=true, no throw', async () => {
  const result = await readProductionTdxEventCache(null, new Date());
  assert.deepEqual(result.events, []);
  assert.equal(result.stale, true);
});

test('corrupt JSON in the cache key -> treated as no cache, no throw', async () => {
  const TRAFFIC_KV = kv();
  TRAFFIC_KV.store.set('tdx:last-production-events:v1', 'not valid json{{{');
  const { events, stale } = await readProductionTdxEventCache(TRAFFIC_KV, new Date());
  assert.deepEqual(events, []);
  assert.equal(stale, true);
});

test('persistProductionTdxEventCache: no KV -> reports failure, never throws', async () => {
  const commit = await persistProductionTdxEventCache(null, SAMPLE_EVENTS, new Date());
  assert.equal(commit.committed, false);
  assert.equal(commit.reason, 'no-kv');
});

test('persistProductionTdxEventCache: KV.put throws -> reports failure, never throws', async () => {
  const brokenKv = {
    async put() {
      throw new Error('KV write outage');
    },
  };
  const commit = await persistProductionTdxEventCache(brokenKv, SAMPLE_EVENTS, new Date());
  assert.equal(commit.committed, false);
  assert.equal(commit.reason, 'kv-error');
});

test('readProductionTdxEventCache: KV.get throws -> events=[], stale=true, no throw', async () => {
  const brokenKv = {
    async get() {
      throw new Error('KV read outage');
    },
  };
  const result = await readProductionTdxEventCache(brokenKv, new Date());
  assert.deepEqual(result.events, []);
  assert.equal(result.stale, true);
});

test('cache never includes a token/secret/Authorization substring', async () => {
  const TRAFFIC_KV = kv();
  await persistProductionTdxEventCache(TRAFFIC_KV, SAMPLE_EVENTS, new Date('2026-08-18T08:00:00+08:00'));
  const raw = TRAFFIC_KV.store.get('tdx:last-production-events:v1');
  assert.doesNotMatch(raw, /\btoken\b/i);
  assert.doesNotMatch(raw, /secret/i);
  assert.doesNotMatch(raw, /Authorization/i);
});
