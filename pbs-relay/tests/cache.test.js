import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPbsCache, CACHE_TTL_MS } from '../src/cache.js';

test('cache starts empty and not fresh', () => {
  const cache = createPbsCache();
  assert.equal(cache.get(), null);
  assert.equal(cache.isFresh(Date.now()), false);
});

test('CACHE_TTL_MS is 3 minutes', () => {
  assert.equal(CACHE_TTL_MS, 3 * 60 * 1000);
});

test('cache is fresh immediately after set, up to (but not including) the TTL boundary', () => {
  const cache = createPbsCache({ ttlMs: 3 * 60 * 1000 });
  const t0 = 1_000_000;
  cache.set('{"a":1}', t0);
  assert.equal(cache.isFresh(t0), true);
  assert.equal(cache.isFresh(t0 + 3 * 60 * 1000 - 1), true);
  assert.equal(cache.isFresh(t0 + 3 * 60 * 1000), false); // expired at exactly the TTL
});

test('get() returns the exact rawText last set, unmodified', () => {
  const cache = createPbsCache();
  const raw = '{"UID":"PBS-1","modDttm":"2026-08-16 10:00:00","comment":"事故 內側車道"}';
  cache.set(raw, Date.now());
  assert.equal(cache.get().rawText, raw);
});

test('set() replaces the previous entry', () => {
  const cache = createPbsCache();
  cache.set('old', 1000);
  cache.set('new', 2000);
  assert.equal(cache.get().rawText, 'new');
  assert.equal(cache.get().fetchedAt, 2000);
});
