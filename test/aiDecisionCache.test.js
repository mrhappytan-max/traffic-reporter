// V1.9.9 Phase 3B — src/pbs/aiDecisionCache.js unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_DECISION_CACHE_TTL_SECONDS, readAiDecisionCache, persistAiDecisionCache } from '../src/pbs/aiDecisionCache.js';
import { buildAiDecisionCacheKvKey, computeAiDecisionCacheKeyHash, AI_DECISION_CACHE_KV_PREFIX } from '../src/pbs/aiCandidate.js';

function countingKV() {
  const store = new Map();
  return {
    store,
    getCalls: 0,
    putCalls: 0,
    async get(key) {
      this.getCalls += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      this.putCalls += 1;
      store.set(key, value);
      this.lastPutOptions = options;
    },
  };
}

test('AI_DECISION_CACHE_TTL_SECONDS is 48 hours, same value as debugPush.js IDEMPOTENCY_TTL_SECONDS', () => {
  assert.equal(AI_DECISION_CACHE_TTL_SECONDS, 48 * 60 * 60);
});

test('readAiDecisionCache: miss on an empty store', async () => {
  const kv = countingKV();
  const key = buildAiDecisionCacheKvKey(await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp1' }));
  const result = await readAiDecisionCache(kv, key);
  assert.equal(result.hit, false);
});

test('readAiDecisionCache: no kv binding at all -> miss, never throws', async () => {
  const result = await readAiDecisionCache(undefined, 'debug:pbs-ai-decision-cache:v1:abc');
  assert.equal(result.hit, false);
});

test('readAiDecisionCache: hit after a persist round-trip', async () => {
  const kv = countingKV();
  const key = buildAiDecisionCacheKvKey(await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp1' }));
  const decision = { notify: true, impact: 'HIGH', reason: '雙向封閉', confidence: 0.9 };
  await persistAiDecisionCache(kv, key, { eventId: 'E1', fingerprint: 'fp1', decision, model: 'm', decidedAt: new Date().toISOString() });
  const result = await readAiDecisionCache(kv, key);
  assert.equal(result.hit, true);
  assert.deepEqual(result.decision, decision);
});

test('persistAiDecisionCache always sets expirationTtl = AI_DECISION_CACHE_TTL_SECONDS', async () => {
  const kv = countingKV();
  const key = buildAiDecisionCacheKvKey(await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp1' }));
  await persistAiDecisionCache(kv, key, { eventId: 'E1', fingerprint: 'fp1', decision: { notify: false, impact: 'LOW', reason: 'x', confidence: 0.1 }, model: 'm', decidedAt: 'now' });
  assert.ok(kv.lastPutOptions);
  assert.equal(kv.lastPutOptions.expirationTtl, AI_DECISION_CACHE_TTL_SECONDS);
});

test('readAiDecisionCache: corrupt JSON blob -> miss, never throws', async () => {
  const kv = countingKV();
  const key = buildAiDecisionCacheKvKey(await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp1' }));
  kv.store.set(key, 'not valid json');
  const result = await readAiDecisionCache(kv, key);
  assert.equal(result.hit, false);
});

test('readAiDecisionCache: KV outage on get() fails OPEN (miss, not a throw)', async () => {
  const kv = { async get() { throw new Error('simulated outage'); } };
  const result = await readAiDecisionCache(kv, 'debug:pbs-ai-decision-cache:v1:abc');
  assert.equal(result.hit, false);
  assert.equal(result.kvOutage, true);
});

test('persistAiDecisionCache: KV outage on put() fails OPEN (never throws)', async () => {
  const kv = { async put() { throw new Error('simulated outage'); } };
  const result = await persistAiDecisionCache(kv, 'debug:pbs-ai-decision-cache:v1:abc', { eventId: 'E1', fingerprint: 'fp1', decision: {}, model: 'm', decidedAt: 'now' });
  assert.equal(result.committed, false);
  assert.ok(result.error);
});

test('cache key is always under AI_DECISION_CACHE_KV_PREFIX, distinct from the idempotency prefix', async () => {
  const key = buildAiDecisionCacheKvKey(await computeAiDecisionCacheKeyHash({ eventId: 'PBS-UID-1', fingerprint: 'fp-secret' }));
  assert.ok(key.startsWith(`${AI_DECISION_CACHE_KV_PREFIX}:`));
  assert.ok(!key.startsWith('debug:pbs-push-idempotency'));
  assert.ok(!key.includes('PBS-UID-1'));
  assert.ok(!key.includes('fp-secret'));
});
