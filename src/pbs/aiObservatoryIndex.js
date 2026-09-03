// V2.0.1 — AI Decision Observatory. READ-ONLY OBSERVABILITY. This module
// exists to answer, from data already produced at decision time, "why did
// the AI judge this Windows PBS event the way it did, and what finally
// happened" — never to re-derive, re-generate, or re-guess any of it.
//
// HARD RULE (order section 一): opening/refreshing/searching the
// Observatory page must NEVER call Workers AI. This module only ever
// writes ONE small record per genuinely NEW (non-duplicate) Windows PBS
// event, at the exact moment src/pbs/debugPush.js already knows that
// event's final outcome — and only ever READS on the admin page side
// (aiObservatoryView.js). Nothing in this file calls env.AI.run().
//
// V2.2.0 — Four-Layer Event Lifecycle (order section 一/九). The SAME KV
// key is now written TWICE, never as two separate records: once at
// AI_OUTCOME.PROCESSING_STARTED the instant business processing begins
// (before candidate/AI/legacy work — a raw pseudo-candidate built
// straight from the Windows push payload, so this write can never be
// blocked by a normalize/candidate-build exception), and once more with
// the real final outcome once processing genuinely completes — both
// calls pass the identical (now, taipeiDate, idempotencyKeyHash) so the
// second `recordAiObservatoryEntry` call OVERWRITES the first at the
// same key rather than creating a second entry. This is what makes a
// crashed/never-completed event still show a card (frozen at
// PROCESSING_STARTED) instead of vanishing — see debugPush.js's own
// comment for the exact call sites — while keeping this round's own
// storage cost to exactly ONE extra KV put per accepted event (not a
// second index, not a second prefix).
//
// WHY A NEW KV PREFIX, NOT ZERO NEW WRITES (order section 三/四 — existing
// data first, minimal new storage, justify anything short of zero):
// surveyed before writing a line of this module —
//   - src/pbs/aiDecisionCache.js (debug:pbs-ai-decision-cache:v1:*) DOES
//     persist the validated {notify,impact,reason,confidence} for every
//     event that reached a VALID AI decision — but it is content-
//     addressed by SHA-256(eventId:fingerprint), has no PBS original
//     fields (road/direction/comment/etc — never needed for its own
//     purpose, which is dedup, not display) and no way to enumerate
//     "every event", only "the decision for a KNOWN eventId+fingerprint".
//     This module's list/detail page REUSES that cache directly (see
//     aiObservatoryView.js) rather than copying its payload — an
//     observatory record never stores notify/impact/reason/confidence
//     itself, only enough (eventId+fingerprint) to look the real decision
//     back up.
//   - debug:pbs-push-idempotency:v1:* stores only {firstAcceptedAt,
//     requestId} — no PBS fields, no AI outcome. Reused for its OWN key
//     hash below (idempotencyKeyHash), never re-hashed.
//   - AI_CALL_FAILED / AI_DECISION_INVALID / SERVICE_AREA_EXCLUDED /
//     AI_NOT_INVOKED_LEGACY_PATH events are never persisted ANYWHERE
//     today (console.log only) — there is no existing data to reuse for
//     them, and order section 五/六/九 explicitly require them to be
//     visible and filterable. A thin index is the minimum viable fix.
// Conclusion: EXISTING_DATA_FIRST holds for the AI decision content
// itself (never duplicated); a genuinely new, minimal, whitelist-only
// index is the smallest possible addition that can still answer "what
// happened to every event" including the outcomes nothing else records.

export const AI_OBSERVATORY_INDEX_KV_PREFIX = 'debug:pbs-ai-observatory-index:v1';
// Same TTL as its sibling debug KV records (idempotency, AI decision
// cache) — not a new number, matches the existing convention for
// short-lived Windows PBS debug/observability data.
export const AI_OBSERVATORY_INDEX_TTL_SECONDS = 48 * 60 * 60;

export const DEFAULT_LIST_LIMIT = 30;
export const MAX_LIST_LIMIT = 100;
// Same bounded-scan discipline as broadcastProvenance.js's own
// MAX_ENTRIES_SCANNED — this endpoint is Admin-triggered, on-demand,
// never on the hot POST /internal/pbs-debug-push path.
const MAX_ENTRIES_SCANNED = 300;

// The fixed, closed outcome vocabulary (order section 五's status list,
// minus the two states — LINE_ATTEMPTED/LINE_SENT — that are their own
// boolean fields, not outcomes). `cacheStatus` is tracked SEPARATELY
// (order section 七-D wants Cache: HIT/MISS shown distinct from
// notify:true/false) — never folded into this enum.
//
// V2.2.0 — PROCESSING_STARTED (order section 九). Written as soon as
// business processing genuinely begins (before any candidate/AI/legacy
// work — see debugPush.js's own early write), then OVERWRITTEN in place
// by whichever final outcome below actually happens. An event whose
// background processing crashes or never completes (the exact failure
// mode this order's own section 九 asks the Observatory to stop hiding)
// is therefore still visible as a card — its outcome simply never moves
// past PROCESSING_STARTED, rather than never having a card at all.
// V2.3.0 — PROCESSING_FAILED (order section 十). Written by the Queue
// Consumer ONLY when a genuinely-retried event still hasn't reliably
// completed after MAX_QUEUE_RETRIES attempts — the one new terminal
// state this round adds, deliberately not a larger state machine. Distinct
// from AI_CALL_FAILED (a single attempt's call didn't reliably complete —
// still retryable) and from AI_DECISION_INVALID (the call DID complete,
// with an invalid answer — an existing, unretried, fail-closed terminal
// outcome): PROCESSING_FAILED means retries were exhausted and business
// processing must stop, terminal, ack'd — never left stuck at
// PROCESSING_STARTED forever.
// V2.4.3 (order section 七/八) — STALE_AFTER_CLEARED: a NEW/UPDATED Queue
// message whose event has since been confirmed CLEARED by a later,
// separate CLEARED push (see debugPush.js's own `readPbsEventClearedAt`/
// `recordPbsEventCleared`) is cancelled BEFORE any further AI call —
// never retried, terminal, ACK'd. Deliberately a NEW, distinct outcome
// value (never reusing AI_CALL_FAILED/PROCESSING_FAILED) because it is
// reached and returned BEFORE the Queue Consumer's own AI_CALL_FAILED
// retry-eligibility check ever runs (see processQueuedPbsEvent's own
// comment) — it can never be mistaken for something that should still be
// retried.
export const AI_OUTCOME = {
  PROCESSING_STARTED: 'PROCESSING_STARTED',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  SERVICE_AREA_EXCLUDED: 'SERVICE_AREA_EXCLUDED',
  AI_NOT_INVOKED_LEGACY_PATH: 'AI_NOT_INVOKED_LEGACY_PATH',
  AI_CALL_FAILED: 'AI_CALL_FAILED',
  AI_DECISION_INVALID: 'AI_DECISION_INVALID',
  AI_NOTIFY_TRUE: 'AI_NOTIFY_TRUE',
  AI_NOTIFY_FALSE: 'AI_NOTIFY_FALSE',
  STALE_AFTER_CLEARED: 'STALE_AFTER_CLEARED',
  // V2.4.6 (order 路況工程部｜V2.4.6 查修頁資訊改版施工令, section 七/八) —
  // TDX events dropped at tdx/tdxQueueIngress.js's own Gate A, BEFORE any
  // Queue message is ever created (see that module's own V2.4.5 comment).
  // Before this round, a Gate A drop produced a `console.log` line only —
  // zero persisted record, so the event vanished from this Observatory
  // entirely (order section 七's own "為什麼這筆 TDX 不見了？卻完全沒有
  // 證據"). These six values are written ADDITIVELY by
  // tdxQueueIngress.js#enqueueTdxRoadEvents() itself, directly from the
  // ALREADY-COMPUTED resolveTdxHsinchuGeography()/
  // resolveTdxRoadManagementEligibility() return values — this module
  // never re-runs either judgment, and nothing about the actual Gate A
  // drop decision changes because these values now also get a KV record.
  GEO_EXCLUDED_OUTSIDE_HSINCHU: 'GEO_EXCLUDED_OUTSIDE_HSINCHU',
  GEO_EXCLUDED_UNKNOWN: 'GEO_EXCLUDED_UNKNOWN',
  ROAD_POLICY_EXCLUDED_SHOULDER_OPEN: 'ROAD_POLICY_EXCLUDED_SHOULDER_OPEN',
  ROAD_POLICY_EXCLUDED_SHOULDER_CLOSE: 'ROAD_POLICY_EXCLUDED_SHOULDER_CLOSE',
  ROAD_POLICY_EXCLUDED_INSUFFICIENT_LANES: 'ROAD_POLICY_EXCLUDED_INSUFFICIENT_LANES',
  ROAD_POLICY_EXCLUDED_UNKNOWN_LANES: 'ROAD_POLICY_EXCLUDED_UNKNOWN_LANES',
};

// V2.4.6 — the collapsed-card summary status this record ultimately
// represents (order section 二/十一's own "未展開就能知道為什麼發／不發").
// Kept as a SEPARATE, small closed enum from AI_OUTCOME itself — a status
// is a coarse grouping OF several outcomes, not a new outcome value.
export const FINAL_DECISION_STATUS = Object.freeze({
  SENT: 'SENT',
  NOT_SENT: 'NOT_SENT',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  PENDING: 'PENDING',
});

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

/**
 * Pure — no I/O, directly unit-testable. Every field here is either a
 * scalar the caller (debugPush.js) already has in memory by the time an
 * event finishes processing, or a boolean/enum computed from values it
 * already has. Never stores: a Secret, an Authorization header, the full
 * raw PBS payload, or a copy of the AI decision's notify/impact/reason/
 * confidence (see this module's own header comment for why).
 *
 * V2.2.0 (order section 一/二/七) — `rawComment`/`rawSourceDetail` are the
 * PBS original free-text fields, stored COMPLETE and UNTRUNCATED — the
 * order's own highest-priority rule ("原始文字都不得被改寫、摘要、截斷或
 * 刪減"). Previously this field (`commentSummary`) was truncated to 120
 * chars for a compact list preview; that preview never actually needed
 * the raw text (the list row shows road/direction/eventType instead — see
 * aiObservatoryView.js's renderRow), so truncation was serving no real UI
 * need and only violated the raw-text-immutability principle. `road`/
 * `direction`/`areaNm`/`displayKM` remain the SEPARATE, already-existing
 * parsed/formatted fields — never overwritten by or merged with the raw
 * text (order section 七: "原始欄位與解析欄位分離").
 *
 * @param {object} params
 * @param {object} params.candidate - pbs/aiCandidate.js#buildAiCandidate() output, or null (SERVICE_AREA_EXCLUDED / legacy path with no candidate, or the earliest PROCESSING_STARTED write's own minimal pseudo-candidate — see debugPush.js)
 * @param {string} params.eventId
 * @param {string} params.lifecycle
 * @param {string} params.fingerprint - needed to re-derive the AI decision cache key AND the transport idempotency key at READ time; never used to re-run anything here
 * @param {string} params.outcome - one of AI_OUTCOME's values
 * @param {'HIT'|'MISS'|null} [params.cacheStatus]
 * @param {boolean} [params.lineAttempted]
 * @param {boolean} [params.lineSent]
 * @param {boolean|null} [params.sharedFeedPersisted]
 * @param {boolean|null} [params.imageUrlPresent]
 * @param {Date} [params.now]
 */
export function buildAiObservatoryRecord({
  candidate,
  eventId,
  lifecycle,
  fingerprint,
  outcome,
  cacheStatus = null,
  lineAttempted = false,
  lineSent = false,
  sharedFeedPersisted = null,
  imageUrlPresent = null,
  now = new Date(),
  // V2.4.0 (order section 十六) — the minimal additional observability
  // fields for the shared PBS+TDX AI pipeline: which source this
  // candidate actually came from, how many Recent Incident Memory
  // candidates were handed to the AI, its sameIncident/materialChange
  // verdict, who currently owns primarySource for this incident family,
  // when it was last actually notified, and whether this event's own
  // memory sighting produced a real KV write. All optional/nullable —
  // every existing PBS call site that doesn't pass these keeps producing
  // the exact same record shape it always has (source still defaults to
  // 'pbs', every new field defaults to null/false).
  source = 'pbs',
  memoryCandidateCount = null,
  sameIncident = null,
  materialChange = null,
  primarySource = null,
  lastNotifiedAt = null,
  memoryWrite = false,
  // V2.4.3 (order section 十) — true ONLY for the new application-level
  // fail-fast timeout path (aiDecisionEngine.js's own AI_CALL_TIMEOUT_MS)
  // — never set for any other AI_CALL_FAILED cause (missing binding, a
  // genuine env.AI.run() rejection). Lets the Observatory view show
  // "AI 逾時" distinctly from a generic failure, on both a mid-retry
  // AI_CALL_FAILED record and a fully-exhausted PROCESSING_FAILED one —
  // see aiObservatoryView.js's own outcomeMeta().
  timedOut = false,
  // V2.4.6 (order section 三) — `suppressedForPhase` was ALREADY computed
  // by debugPush.js#runAiDecisionPath (TDX Phase B/C
  // TDX_ROADEVENT_PRODUCTION_NOTIFY_ENABLED gate — see that function's own
  // `suppressLineNotify`) and already returned to its caller, but was
  // silently dropped before this record was ever built (this function
  // never declared the parameter, so the object-destructuring simply
  // discarded it). Surfacing it here is purely additive: no new judgment,
  // just no longer throwing away a fact the runtime already produced —
  // this is what lets the trace page show "未發送：TDX通知開關關閉" instead
  // of a generic AI_NOT_INVOKED_LEGACY_PATH label. `blockedLanes` is the
  // SAME field pbs/aiCandidate.js#buildAiCandidate() has carried since
  // V2.4.5 (`candidate.blockedLanes`) — also never previously stored here.
  suppressedForPhase = false,
}) {
  return {
    timestamp: now.toISOString(),
    eventId: eventId || null,
    lifecycle: lifecycle || null,
    fingerprint: fingerprint || null,
    source,
    road: (candidate && candidate.road) || null,
    direction: (candidate && candidate.direction) || null,
    areaNm: (candidate && candidate.areaNm) || null,
    displayKM: candidate && typeof candidate.displayKM === 'number' ? candidate.displayKM : null,
    eventType: (candidate && candidate.eventType) || null,
    blockedLanes: candidate && typeof candidate.blockedLanes === 'number' ? candidate.blockedLanes : null,
    rawComment: (candidate && candidate.comment) || '',
    rawSourceDetail: (candidate && candidate.sourceDetail) || '',
    longitude: candidate && typeof candidate.longitude === 'number' ? candidate.longitude : null,
    latitude: candidate && typeof candidate.latitude === 'number' ? candidate.latitude : null,
    generatedAt: (candidate && candidate.generatedAt) || null,
    outcome,
    cacheStatus,
    lineAttempted: Boolean(lineAttempted),
    lineSent: Boolean(lineSent),
    sharedFeedPersisted,
    imageUrlPresent,
    memoryCandidateCount,
    sameIncident,
    materialChange,
    primarySource,
    lastNotifiedAt,
    memoryWrite: Boolean(memoryWrite),
    timedOut: Boolean(timedOut),
    suppressedForPhase: Boolean(suppressedForPhase),
  };
}

// V2.4.6 (order section 三) — the ONE canonical, pure composition of
// "why was this event finally sent or not sent", derived exclusively from
// fields this record ALREADY stores (outcome/eventType/blockedLanes/
// suppressedForPhase/lineSent/lineAttempted) — never a new judgment, never
// re-running geography/policy/AI. aiObservatoryView.js's collapsed-card
// summary line (order section 二/十一) and its TDX pipeline-stage strip
// both call this SAME function — one canonical reason, never two.
//
// The order's own example vocabulary (section 二): 壅塞／一般施工／機動路肩
// 開放／機動路肩關閉／施工僅封1車道／非新竹縣市／地理位置無法確認／AI判定
// 影響低／通知時段外／TDX通知開關關閉／AI處理失敗／背景重試失敗 — every
// branch below maps to one of these using only already-persisted data;
// "通知時段外" has no persisted signal in this record today (no existing
// outcome/field distinguishes it), so it is deliberately NOT guessed at —
// order section 三's own "UI 絕不可以自行猜測" — an event whose real
// upstream reason this record can't distinguish falls through to the
// nearest accurate existing label instead of a fabricated one.
export function deriveFinalDecisionReason(record) {
  if (!record || typeof record !== 'object') {
    return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: 'UNKNOWN / NOT RECORDED' };
  }
  if (record.lineSent) {
    return { status: FINAL_DECISION_STATUS.SENT, reason: '重大事故' };
  }
  switch (record.outcome) {
    case AI_OUTCOME.GEO_EXCLUDED_OUTSIDE_HSINCHU:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '非新竹縣市' };
    case AI_OUTCOME.GEO_EXCLUDED_UNKNOWN:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '地理位置無法確認' };
    case AI_OUTCOME.ROAD_POLICY_EXCLUDED_SHOULDER_OPEN:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '機動路肩開放' };
    case AI_OUTCOME.ROAD_POLICY_EXCLUDED_SHOULDER_CLOSE:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '機動路肩關閉' };
    case AI_OUTCOME.ROAD_POLICY_EXCLUDED_INSUFFICIENT_LANES:
      return {
        status: FINAL_DECISION_STATUS.NOT_SENT,
        reason: typeof record.blockedLanes === 'number' ? `施工僅封${record.blockedLanes}車道` : '施工封鎖車道資料不足',
      };
    case AI_OUTCOME.ROAD_POLICY_EXCLUDED_UNKNOWN_LANES:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '施工封鎖車道資料不足' };
    case AI_OUTCOME.SERVICE_AREA_EXCLUDED:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '非新竹縣市' };
    case AI_OUTCOME.AI_NOTIFY_FALSE:
      if (record.eventType === 'congestion') return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '壅塞' };
      if (record.eventType === 'construction') return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '一般施工' };
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: 'AI判定影響低' };
    case AI_OUTCOME.AI_CALL_FAILED:
    case AI_OUTCOME.AI_DECISION_INVALID:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: 'AI處理失敗' };
    case AI_OUTCOME.PROCESSING_FAILED:
      return { status: FINAL_DECISION_STATUS.PROCESSING_FAILED, reason: '背景重試失敗' };
    case AI_OUTCOME.STALE_AFTER_CLEARED:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '事件已解除（取消重試）' };
    case AI_OUTCOME.AI_NOT_INVOKED_LEGACY_PATH:
      if (record.suppressedForPhase) return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: 'TDX通知開關關閉' };
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: '既有規則判定不符合播報資格' };
    case AI_OUTCOME.PROCESSING_STARTED:
      return { status: FINAL_DECISION_STATUS.PENDING, reason: '處理中／未完成' };
    default:
      return { status: FINAL_DECISION_STATUS.NOT_SENT, reason: 'UNKNOWN / NOT RECORDED' };
  }
}

function opaqueSuffix(idempotencyKeyHash) {
  return (idempotencyKeyHash || '').slice(0, 16);
}

/**
 * Best-effort, fully isolated write — same isolation pattern as
 * broadcastProvenance.js's recordBroadcastProvenance / tdx/usageLedger.js.
 * NEVER throws. A failed write here must never change anything about the
 * real AI decision, LINE push, or transport-idempotency outcome, all of
 * which have already fully completed by the time this is ever called.
 *
 * @param {string} taipeiDate - caller-supplied `taipeiDateString(now)` (kept as a parameter rather than importing tdx/usageLedger.js's own version a second time — this module has no other reason to depend on that file)
 * @param {string} idempotencyKeyHash - the SAME hash debugPush.js already computed for transport idempotency; reused for the key here, never re-hashed
 */
export async function recordAiObservatoryEntry(kv, record, { taipeiDate, idempotencyKeyHash, now = new Date() } = {}) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const key = `${AI_OBSERVATORY_INDEX_KV_PREFIX}:${taipeiDate}:${now.getTime()}:${opaqueSuffix(idempotencyKeyHash)}`;
    await kv.put(key, JSON.stringify(record), { expirationTtl: AI_OBSERVATORY_INDEX_TTL_SECONDS });
    return { committed: true, key };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/**
 * Admin-only read (aiObservatoryView.js). Bounded KV list+get, newest
 * first — same shape as broadcastProvenance.js's listBroadcastProvenance.
 * ZERO calls to Workers AI, ZERO calls to any other upstream — pure KV
 * reads. Never throws — a KV outage degrades to an empty list with
 * `kvAvailable:false`.
 */
export async function listAiObservatoryEntries(kv, { limit = DEFAULT_LIST_LIMIT, outcome, road, eventId, q } = {}) {
  const boundedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || DEFAULT_LIST_LIMIT));
  if (!kv) return { records: [], kvAvailable: false };

  try {
    const keys = [];
    let cursor;
    for (;;) {
      const page = await kv.list({ prefix: `${AI_OBSERVATORY_INDEX_KV_PREFIX}:`, cursor });
      for (const k of page.keys || []) keys.push(k.name);
      if (page.list_complete || !page.cursor || keys.length >= MAX_ENTRIES_SCANNED) break;
      cursor = page.cursor;
    }

    // Keys embed <date>:<epochMs>:<hashSuffix> — lexicographic order
    // already matches chronological order (same construction as
    // broadcastProvenance.js's own keys), so list() returns oldest-first;
    // take the most recent slice, then reverse for newest-first display.
    const newestFirstKeys = keys.slice(-MAX_ENTRIES_SCANNED).reverse();

    const records = [];
    for (const key of newestFirstKeys) {
      if (records.length >= boundedLimit) break;
      const raw = await kv.get(key);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue; // corrupt entry — skip it, never let one bad record break the listing
      }
      if (!record || typeof record !== 'object') continue;
      if (outcome && record.outcome !== outcome) continue;
      if (road && record.road !== road) continue;
      if (eventId && record.eventId !== eventId) continue;
      if (q) {
        const haystack = `${record.road || ''} ${record.areaNm || ''} ${record.rawComment || ''} ${record.rawSourceDetail || ''} ${record.eventId || ''}`.toLowerCase();
        if (!haystack.includes(String(q).toLowerCase())) continue;
      }
      records.push(record);
    }

    return { records, kvAvailable: true };
  } catch (err) {
    return { records: [], kvAvailable: false, error: safeErrorMessage(err) };
  }
}
