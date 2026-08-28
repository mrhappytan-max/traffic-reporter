// V1.9.9 Phase 3B — real KV-backed read/write for the AI decision cache
// key design Phase 2 reserved (pbs/aiCandidate.js's
// AI_DECISION_CACHE_KV_PREFIX / computeAiDecisionCacheKeyHash /
// buildAiDecisionCacheKvKey — imported, never redefined here).
//
// PURPOSE (order section 六/七)
// -------------------------------
// Same `eventId` + same `fingerprint` (Windows's own existing stable
// fingerprint, computed once per real-world content state — see
// debugPushClient.js) means the SAME real-world content: reuse the
// previously-validated AI decision instead of spending another Workers AI
// call. A genuine content change produces a different fingerprint, which
// hashes to a different key, which is naturally a cache miss — no NLP/
// semantic diff needed, exactly per the order's own instruction.
//
// TTL: 48 hours (AI_DECISION_CACHE_TTL_SECONDS) — the SAME VALUE, and the
// same "PBS event lifetime is far shorter than this" rationale, as
// pbs/debugPush.js's own IDEMPOTENCY_TTL_SECONDS (V1.9.7). Deliberately a
// separate constant (not an import of debugPush.js's) to avoid a circular
// import — debugPush.js is the caller of this module's own call chain —
// and because the two caches are conceptually independent even though
// they happen to share the same 48h figure per the order's own "除非現有
// lifecycle governance有更合理且更小的現成設定可直接重用" instruction.
export const AI_DECISION_CACHE_TTL_SECONDS = 48 * 60 * 60;

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

/**
 * @param {object} kv - env.TRAFFIC_KV
 * @param {string} keyHash - from computeAiDecisionCacheKeyHash()
 * @returns {Promise<{hit:true, decision:object, record:object}|{hit:false, kvOutage?:boolean}>}
 */
export async function readAiDecisionCache(kv, kvKey) {
  if (!kv) return { hit: false };
  let raw = null;
  try {
    raw = await kv.get(kvKey);
  } catch {
    return { hit: false, kvOutage: true }; // fail OPEN toward calling AI again — see resolveAiDecision's own comment
  }
  if (raw === null) return { hit: false };
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || !record.decision) return { hit: false };
    return { hit: true, decision: record.decision, record };
  } catch {
    return { hit: false }; // corrupt blob -> treat as a miss, never throw
  }
}

/**
 * @param {object} kv - env.TRAFFIC_KV
 * @param {string} kvKey - from buildAiDecisionCacheKvKey()
 * @param {{eventId:string, fingerprint:string, decision:object, model:string, decidedAt:string}} record
 * @returns {Promise<{committed:boolean, error?:string}>}
 */
export async function persistAiDecisionCache(kv, kvKey, record) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    await kv.put(kvKey, JSON.stringify(record), { expirationTtl: AI_DECISION_CACHE_TTL_SECONDS });
    return { committed: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) }; // fail OPEN — see resolveAiDecision's own comment: a cache-write outage never blocks the AI verdict already reached this request
  }
}
