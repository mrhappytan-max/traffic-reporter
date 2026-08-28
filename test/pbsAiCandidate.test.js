// V1.9.9 Phase 2 — src/pbs/aiCandidate.js unit tests. Pure functions, zero
// I/O — no KV mock, no fetch mock needed. Integration with
// src/pbs/debugPush.js (the real ingress call site) is covered separately
// in test/pbsDebugPush.test.js's own V1.9.9 Phase 2 section.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePbsEvent } from '../src/pbs/normalize.js';
import {
  PBS_AI_DECISION_MODE,
  AI_INTEGRATION,
  AI_MODEL,
  LINE_AI_DECISION,
  AI_DECISION_CACHE_KV_PREFIX,
  computeAiDecisionCacheKeyHash,
  buildAiDecisionCacheKvKey,
  isWindowsPbsAiCandidateEligible,
  buildAiCandidate,
} from '../src/pbs/aiCandidate.js';

function hsinchuAccidentRaw(overrides = {}) {
  return {
    UID: 'PBS-UID-1',
    road: '國道一號',
    areaNm: '國道一號北向',
    direction: '北向',
    roadtype: '',
    comment: '國道一號北向94公里處發生追撞事故，車道回堵',
    happendate: '2026-08-28',
    happentime: '10:00:00',
    modDttm: '2026-08-28 10:00:00',
    x1: 121.0,
    y1: 24.8,
    srcdetail: 'test',
    ...overrides,
  };
}

test('status constants are honestly reported (V1.9.9 Phase 2 safe-transition state)', () => {
  assert.equal(PBS_AI_DECISION_MODE, 'PREPARED_NOT_ACTIVE');
  assert.equal(AI_INTEGRATION, 'NOT_STARTED');
  assert.equal(AI_MODEL, 'NOT_SELECTED_IN_RUNTIME');
  assert.equal(LINE_AI_DECISION, 'NOT_ACTIVE');
});

test('AI_DECISION_CACHE_KV_PREFIX is its own dedicated debug-only prefix, distinct from every business/idempotency prefix', () => {
  assert.equal(AI_DECISION_CACHE_KV_PREFIX, 'debug:pbs-ai-decision-cache:v1');
  assert.ok(!AI_DECISION_CACHE_KV_PREFIX.startsWith('traffic:'));
  assert.ok(!AI_DECISION_CACHE_KV_PREFIX.startsWith('line:'));
  assert.ok(!AI_DECISION_CACHE_KV_PREFIX.startsWith('pbs:lifecycle'));
});

test('computeAiDecisionCacheKeyHash is deterministic for the same eventId+fingerprint', async () => {
  const a = await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp-1' });
  const b = await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp-1' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('computeAiDecisionCacheKeyHash differs when eventId or fingerprint differ (same event, changed content -> different key)', async () => {
  const base = await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp-1' });
  const diffEvent = await computeAiDecisionCacheKeyHash({ eventId: 'E2', fingerprint: 'fp-1' });
  const diffFingerprint = await computeAiDecisionCacheKeyHash({ eventId: 'E1', fingerprint: 'fp-2' });
  assert.notEqual(base, diffEvent);
  assert.notEqual(base, diffFingerprint);
});

test('buildAiDecisionCacheKvKey prefixes the hash under AI_DECISION_CACHE_KV_PREFIX, never a bare eventId/fingerprint', async () => {
  const hash = await computeAiDecisionCacheKeyHash({ eventId: 'PBS-UID-1', fingerprint: 'fp-secret' });
  const key = buildAiDecisionCacheKvKey(hash);
  assert.equal(key, `${AI_DECISION_CACHE_KV_PREFIX}:${hash}`);
  assert.ok(!key.includes('PBS-UID-1'));
  assert.ok(!key.includes('fp-secret'));
});

test('isWindowsPbsAiCandidateEligible: true for an event inside the service area', () => {
  const normalized = normalizePbsEvent(hsinchuAccidentRaw());
  assert.equal(isWindowsPbsAiCandidateEligible(normalized), true);
});

test('isWindowsPbsAiCandidateEligible: false for an event outside the service area (八堵)', () => {
  // Comment deliberately carries NO parseable KM marker — hsinchuFilter.js's
  // extractKmFromText would otherwise let a KM inside 國道一號's Hsinchu
  // range (80-105K) override the coordinates below; this fixture isolates
  // the coordinate-only decision path.
  const normalized = normalizePbsEvent(
    hsinchuAccidentRaw({ comment: '國道一號北向發生追撞事故', x1: 121.71801, y1: 25.10288 })
  );
  assert.equal(isWindowsPbsAiCandidateEligible(normalized), false);
});

test('isWindowsPbsAiCandidateEligible does NOT gate on event type — construction/control/congestion/other are all still eligible if in service area', () => {
  for (const comment of [
    '國道一號北向94公里處施工作業，車道封閉',
    '國道一號北向94公里處實施交通管制',
    '國道一號北向94公里處車多壅塞',
    '國道一號北向94公里處道路異常告警',
  ]) {
    const normalized = normalizePbsEvent(hsinchuAccidentRaw({ comment }));
    assert.equal(isWindowsPbsAiCandidateEligible(normalized), true, `expected eligible for comment: ${comment}`);
  }
});

test('buildAiCandidate produces the minimum schema (order section 七), never notify/impact fields', () => {
  const normalized = normalizePbsEvent(hsinchuAccidentRaw());
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-08-28T10:00:00+08:00' });

  assert.equal(candidate.source, 'pbs');
  assert.equal(candidate.eventId, 'PBS-UID-1');
  assert.equal(candidate.lifecycle, 'NEW');
  assert.equal(candidate.road, '國道一號');
  assert.equal(candidate.direction, '北向');
  assert.equal(candidate.areaNm, '國道一號北向');
  assert.equal(candidate.comment, '國道一號北向94公里處發生追撞事故，車道回堵');
  assert.equal(candidate.longitude, 121.0);
  assert.equal(candidate.latitude, 24.8);
  assert.equal(candidate.generatedAt, '2026-08-28T10:00:00+08:00');
  assert.equal(candidate.eventType, 'accident');
  assert.equal(candidate.sourceDetail, 'test');

  assert.ok(!('notify' in candidate), 'candidate must never pre-decide notify — that is Phase 3 AI work');
  assert.ok(!('impact' in candidate), 'candidate must never pre-decide impact — that is Phase 3 AI work');
});

test('buildAiCandidate: displayKM is null when the comment carries no parseable KM marker', () => {
  const normalized = normalizePbsEvent(hsinchuAccidentRaw({ comment: '國道一號北向發生追撞事故' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-08-28T10:00:00+08:00' });
  assert.equal(candidate.displayKM, null);
});

test('buildAiCandidate: displayKM is populated when the comment carries a parseable KM marker', () => {
  const normalized = normalizePbsEvent(hsinchuAccidentRaw({ comment: '國道一號北向94.5公里處發生追撞事故' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-08-28T10:00:00+08:00' });
  assert.equal(candidate.displayKM, 94.5);
});

test('buildAiCandidate: locationQuality is attached as metadata, never used to omit the candidate itself', () => {
  // A bare road-name-only areaNm with no KM/coordinates precise enough to
  // place -> resolveLocationQuality would normally be "insufficient" for
  // a real LINE push, but the candidate must still be built in full.
  const normalized = normalizePbsEvent(
    hsinchuAccidentRaw({ comment: '國道一號北向發生追撞事故', x1: undefined, y1: undefined })
  );
  const candidate = buildAiCandidate(normalized, { lifecycle: 'NEW', generatedAt: '2026-08-28T10:00:00+08:00' });
  assert.ok(candidate.locationQuality, 'expected a locationQuality object to be attached');
  assert.equal(typeof candidate.locationQuality.sufficient, 'boolean');
  // The candidate itself is still fully built regardless of the value:
  assert.equal(candidate.eventId, 'PBS-UID-1');
});

test('buildAiCandidate: CLEARED events are never passed to this function by the real call site — lifecycle is caller-supplied metadata only, not re-derived', () => {
  // This module has no opinion on lifecycle gating itself — debugPush.js's
  // own call site is what skips CLEARED entirely (see that module and its
  // own tests). Documented here as a structural note: buildAiCandidate
  // would happily stamp 'CLEARED' onto a candidate if called with it,
  // proving the safety boundary lives at the CALL SITE, not by chance here.
  const normalized = normalizePbsEvent(hsinchuAccidentRaw({ comment: '國道一號北向94公里處已排除' }));
  const candidate = buildAiCandidate(normalized, { lifecycle: 'CLEARED', generatedAt: '2026-08-28T10:00:00+08:00' });
  assert.equal(candidate.lifecycle, 'CLEARED');
});
