// V2.0.1 — src/pbs/aiObservatoryIndex.js unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_OBSERVATORY_INDEX_KV_PREFIX,
  AI_OBSERVATORY_INDEX_TTL_SECONDS,
  AI_OUTCOME,
  buildAiObservatoryRecord,
  recordAiObservatoryEntry,
  listAiObservatoryEntries,
} from '../src/pbs/aiObservatoryIndex.js';

function countingKV() {
  const store = new Map();
  return {
    store,
    getCalls: 0,
    putCalls: 0,
    listCalls: 0,
    async get(key) {
      this.getCalls += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      this.putCalls += 1;
      store.set(key, value);
      this.lastPutOptions = options;
    },
    async list({ prefix, cursor } = {}) {
      this.listCalls += 1;
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

test('AI_OBSERVATORY_INDEX_TTL_SECONDS is 48 hours, same convention as sibling debug KV records', () => {
  assert.equal(AI_OBSERVATORY_INDEX_TTL_SECONDS, 48 * 60 * 60);
});

test('buildAiObservatoryRecord: pure function, never stores notify/impact/reason/confidence (order — never duplicate the AI decision cache payload)', () => {
  const candidate = { road: '台61', direction: '南向', areaNm: '台61南向', displayKM: 60.4, eventType: 'closure', comment: '雙向封閉' };
  const record = buildAiObservatoryRecord({
    candidate,
    eventId: 'E1',
    lifecycle: 'NEW',
    fingerprint: 'fp1',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    cacheStatus: 'MISS',
    lineAttempted: true,
    lineSent: true,
    now: new Date('2026-08-29T10:00:00+08:00'),
  });
  assert.equal(record.road, '台61');
  assert.equal(record.outcome, AI_OUTCOME.AI_NOTIFY_TRUE);
  assert.equal(record.cacheStatus, 'MISS');
  assert.equal(record.lineSent, true);
  assert.equal('notify' in record, false);
  assert.equal('impact' in record, false);
  assert.equal('reason' in record, false);
  assert.equal('confidence' in record, false);
});

test('buildAiObservatoryRecord: candidate=null (SERVICE_AREA_EXCLUDED / legacy path) still produces a valid record with null PBS fields', () => {
  const record = buildAiObservatoryRecord({ candidate: null, eventId: 'E2', lifecycle: 'NEW', fingerprint: 'fp2', outcome: AI_OUTCOME.SERVICE_AREA_EXCLUDED });
  assert.equal(record.road, null);
  assert.equal(record.outcome, AI_OUTCOME.SERVICE_AREA_EXCLUDED);
});

// V2.2.0 (order section 一/二/七) — the order's own highest-priority rule
// flips this test's old expectation: raw PBS text must NEVER be
// truncated/summarized/rewritten. `rawComment`/`rawSourceDetail` are
// stored complete; `road`/`direction`/`areaNm`/`displayKM` remain the
// SEPARATE parsed/formatted fields, never merged with the raw text.
test('buildAiObservatoryRecord: rawComment/rawSourceDetail are stored COMPLETE, never truncated', () => {
  const longComment = 'x'.repeat(500);
  const longSourceDetail = 'y'.repeat(500);
  const record = buildAiObservatoryRecord({
    candidate: { comment: longComment, sourceDetail: longSourceDetail, road: '台61', direction: '南向' },
    eventId: 'E3',
    lifecycle: 'NEW',
    fingerprint: 'fp3',
    outcome: AI_OUTCOME.AI_NOTIFY_FALSE,
  });
  assert.equal(record.rawComment, longComment);
  assert.equal(record.rawComment.length, 500);
  assert.equal(record.rawSourceDetail, longSourceDetail);
  // parsed/formatted fields stay separate — never merged with raw text
  assert.equal(record.road, '台61');
  assert.equal(record.direction, '南向');
});

// ============================================================================
// V2.5.1 (路況-053, following 路況-046's own plan) — CCTV diagnostic detail
// fields: imageUrl/imageExpiresAt/cctvSkippedByReason/imageStrategy/
// r2ReadbackElapsedMs. Depending on the actual current code path (路況-053
// re-verified this before writing these tests — see that round's own
// report for the full re-check): the V2.4.16/V2.4.18 type-gate removal
// means `cctv` is now computed for essentially any event that reaches
// aiApprovedPbsBroadcast.js's CCTV try block, so the two real scenarios
// this schema needs to represent are just "CCTV ineligible/failed" and
// "CCTV succeeded" — a `cctv`-never-computed-at-all case still exists
// (the function's own pre-existing suppressed/quiet-hours/phase-gate
// early-returns), but it is NOT type-based and is not new — it simply
// leaves these fields at their null defaults, which the schema already
// handles via ordinary parameter defaults, no special case needed.
// ============================================================================

test('buildAiObservatoryRecord: CCTV ineligible/failed scenario — cctvSkippedByReason set, imageUrl/imageExpiresAt/r2ReadbackElapsedMs stay null', () => {
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'E20',
    lifecycle: 'NEW',
    fingerprint: 'fp20',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    imageUrlPresent: false,
    cctvSkippedByReason: 'no-camera',
    imageStrategy: 'quad',
  });
  assert.equal(record.cctvSkippedByReason, 'no-camera');
  assert.equal(record.imageStrategy, 'quad', 'a strategy can be chosen even when the attempt ultimately fails');
  assert.equal(record.imageUrl, null);
  assert.equal(record.imageExpiresAt, null);
  assert.equal(record.r2ReadbackElapsedMs, null);
});

test('buildAiObservatoryRecord: CCTV success scenario — all 5 fields populated, cctvSkippedByReason stays null', () => {
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'E21',
    lifecycle: 'NEW',
    fingerprint: 'fp21',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    imageUrlPresent: true,
    imageUrl: 'https://traffic-reporter.example.workers.dev/cctv/image/abc123',
    imageExpiresAt: '2026-09-09T09:00:28.000Z',
    imageStrategy: 'quad',
    r2ReadbackElapsedMs: 42,
  });
  assert.equal(record.imageUrl, 'https://traffic-reporter.example.workers.dev/cctv/image/abc123');
  assert.equal(record.imageExpiresAt, '2026-09-09T09:00:28.000Z');
  assert.equal(record.imageStrategy, 'quad');
  assert.equal(record.r2ReadbackElapsedMs, 42);
  assert.equal(record.cctvSkippedByReason, null);
});

test('buildAiObservatoryRecord: r2ReadbackElapsedMs of exactly 0 is preserved (not treated as absent/falsy)', () => {
  const record = buildAiObservatoryRecord({
    candidate: null,
    eventId: 'E22',
    lifecycle: 'NEW',
    fingerprint: 'fp22',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    r2ReadbackElapsedMs: 0,
  });
  assert.equal(record.r2ReadbackElapsedMs, 0);
});

test('buildAiObservatoryRecord: omitting all 5 new fields (pre-V2.5.1 caller shape) degrades to null for every one of them — backward compatible with the existing imageUrlPresent-only contract', () => {
  const record = buildAiObservatoryRecord({
    candidate: null,
    eventId: 'E23',
    lifecycle: 'NEW',
    fingerprint: 'fp23',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    imageUrlPresent: true,
  });
  assert.equal(record.imageUrlPresent, true, 'the pre-existing field is completely unaffected by this round');
  assert.equal(record.imageUrl, null);
  assert.equal(record.imageExpiresAt, null);
  assert.equal(record.cctvSkippedByReason, null);
  assert.equal(record.imageStrategy, null);
  assert.equal(record.r2ReadbackElapsedMs, null);
});

// ============================================================================
// V2.6.0 (路況-055, following 路況-054's own plan) — telegramAttempted/
// telegramSent, the symmetric counterpart to lineAttempted/lineSent, same
// default-false convention (see this module's own V2.6.0 comment above
// the parameter declarations for why these degrade to false, not null,
// unlike the CCTV fields above).
// ============================================================================

test('buildAiObservatoryRecord: telegramAttempted/telegramSent independent of lineAttempted/lineSent — LINE sent, Telegram failed', () => {
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'E24',
    lifecycle: 'NEW',
    fingerprint: 'fp24',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    lineAttempted: true,
    lineSent: true,
    telegramAttempted: true,
    telegramSent: false,
  });
  assert.equal(record.lineSent, true);
  assert.equal(record.telegramAttempted, true);
  assert.equal(record.telegramSent, false, 'Telegram genuinely failed — must not be masked by LINE succeeding');
});

test('buildAiObservatoryRecord: telegramAttempted/telegramSent independent of lineAttempted/lineSent — symmetric, LINE failed, Telegram sent', () => {
  const record = buildAiObservatoryRecord({
    candidate: { road: '國道一號' },
    eventId: 'E25',
    lifecycle: 'NEW',
    fingerprint: 'fp25',
    outcome: AI_OUTCOME.AI_NOTIFY_TRUE,
    lineAttempted: true,
    lineSent: false,
    telegramAttempted: true,
    telegramSent: true,
  });
  assert.equal(record.lineSent, false, 'LINE genuinely failed — must not be masked by Telegram succeeding');
  assert.equal(record.telegramSent, true);
});

test('buildAiObservatoryRecord: omitting telegramAttempted/telegramSent (pre-V2.6.0 caller shape, e.g. the legacy AI_NOT_INVOKED_LEGACY_PATH/AI_CALL_FAILED call sites) degrades to false/false — never null/undefined', () => {
  const record = buildAiObservatoryRecord({
    candidate: null,
    eventId: 'E26',
    lifecycle: 'NEW',
    fingerprint: 'fp26',
    outcome: AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH,
    lineAttempted: false,
    lineSent: false,
  });
  assert.equal(record.telegramAttempted, false);
  assert.equal(record.telegramSent, false);
  assert.equal(typeof record.telegramAttempted, 'boolean', 'always boolean, never null/undefined — same convention as lineAttempted/lineSent');
  assert.equal(typeof record.telegramSent, 'boolean');
});

test('recordAiObservatoryEntry: writes exactly 1 KV put, key under the dedicated prefix, TTL set', async () => {
  const kv = countingKV();
  const record = buildAiObservatoryRecord({ candidate: null, eventId: 'E4', lifecycle: 'NEW', fingerprint: 'fp4', outcome: AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH });
  const result = await recordAiObservatoryEntry(kv, record, { taipeiDate: '2026-08-29', idempotencyKeyHash: 'abc123' });
  assert.equal(result.committed, true);
  assert.equal(kv.putCalls, 1);
  assert.ok(result.key.startsWith(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:`));
  assert.equal(kv.lastPutOptions.expirationTtl, AI_OBSERVATORY_INDEX_TTL_SECONDS);
});

test('recordAiObservatoryEntry: no kv binding -> degrades to not-committed, never throws', async () => {
  const record = buildAiObservatoryRecord({ candidate: null, eventId: 'E5', lifecycle: 'NEW', fingerprint: 'fp5', outcome: AI_OUTCOME.AI_NOTIFY_FALSE });
  const result = await recordAiObservatoryEntry(undefined, record, { taipeiDate: '2026-08-29', idempotencyKeyHash: 'x' });
  assert.equal(result.committed, false);
});

test('recordAiObservatoryEntry: KV outage on put() fails OPEN (never throws)', async () => {
  const kv = { async put() { throw new Error('simulated outage'); } };
  const record = buildAiObservatoryRecord({ candidate: null, eventId: 'E6', lifecycle: 'NEW', fingerprint: 'fp6', outcome: AI_OUTCOME.AI_NOTIFY_FALSE });
  const result = await recordAiObservatoryEntry(kv, record, { taipeiDate: '2026-08-29', idempotencyKeyHash: 'x' });
  assert.equal(result.committed, false);
  assert.ok(result.error);
});

test('listAiObservatoryEntries: no kv -> empty, kvAvailable false', async () => {
  const result = await listAiObservatoryEntries(undefined);
  assert.deepEqual(result.records, []);
  assert.equal(result.kvAvailable, false);
});

test('listAiObservatoryEntries: newest first', async () => {
  const kv = countingKV();
  for (const [eventId, hourOffset] of [['E7', 0], ['E8', 1], ['E9', 2]]) {
    const now = new Date(`2026-08-29T10:0${hourOffset}:00+08:00`);
    const record = buildAiObservatoryRecord({ candidate: { road: eventId }, eventId, lifecycle: 'NEW', fingerprint: 'fp', outcome: AI_OUTCOME.AI_NOTIFY_FALSE, now });
    await recordAiObservatoryEntry(kv, record, { taipeiDate: '2026-08-29', idempotencyKeyHash: eventId, now });
  }
  const { records } = await listAiObservatoryEntries(kv, { limit: 10 });
  assert.deepEqual(records.map((r) => r.eventId), ['E9', 'E8', 'E7']);
});

test('listAiObservatoryEntries: filters by outcome/road/eventId/q', async () => {
  const kv = countingKV();
  await recordAiObservatoryEntry(
    kv,
    buildAiObservatoryRecord({ candidate: { road: '台61', comment: '封閉' }, eventId: 'E10', lifecycle: 'NEW', fingerprint: 'fp', outcome: AI_OUTCOME.AI_NOTIFY_TRUE }),
    { taipeiDate: '2026-08-29', idempotencyKeyHash: 'h1' }
  );
  await recordAiObservatoryEntry(
    kv,
    buildAiObservatoryRecord({ candidate: { road: '國道一號', comment: '事故' }, eventId: 'E11', lifecycle: 'NEW', fingerprint: 'fp', outcome: AI_OUTCOME.AI_NOTIFY_FALSE }),
    { taipeiDate: '2026-08-29', idempotencyKeyHash: 'h2' }
  );

  assert.equal((await listAiObservatoryEntries(kv, { outcome: AI_OUTCOME.AI_NOTIFY_TRUE })).records.length, 1);
  assert.equal((await listAiObservatoryEntries(kv, { road: '台61' })).records.length, 1);
  assert.equal((await listAiObservatoryEntries(kv, { eventId: 'E11' })).records.length, 1);
  assert.equal((await listAiObservatoryEntries(kv, { q: '事故' })).records.length, 1);
  assert.equal((await listAiObservatoryEntries(kv, {})).records.length, 2);
});

test('listAiObservatoryEntries: corrupt entry skipped, never breaks the listing', async () => {
  const kv = countingKV();
  kv.store.set(`${AI_OBSERVATORY_INDEX_KV_PREFIX}:2026-08-29:1000:bad`, 'not json');
  await recordAiObservatoryEntry(
    kv,
    buildAiObservatoryRecord({ candidate: null, eventId: 'E12', lifecycle: 'NEW', fingerprint: 'fp', outcome: AI_OUTCOME.AI_NOTIFY_FALSE }),
    { taipeiDate: '2026-08-29', idempotencyKeyHash: 'h3' }
  );
  const { records } = await listAiObservatoryEntries(kv);
  assert.equal(records.length, 1);
  assert.equal(records[0].eventId, 'E12');
});
