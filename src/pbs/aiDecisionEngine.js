// V1.9.9 Phase 3B — Workers AI Driver Impact Decision Integration.
//
// This is the ONE place a Windows PBS AI candidate (pbs/aiCandidate.js)
// becomes a validated notify/impact verdict. Fixed model, fixed short
// Traditional-Chinese prompt, strict structured-output validation, and a
// cache layer (pbs/aiDecisionCache.js) so the SAME real-world content
// never spends a second Workers AI call. See traffic/aiApprovedPbsBroadcast.js
// for what happens AFTER a validated notify:true verdict — this module
// itself has ZERO LINE/CCTV/Shared Feed side effects.
//
// MODEL — fixed, per order section 二: '@cf/zai-org/glm-4.7-flash', via
// env.AI.run(...), binding name 'AI'. No other AI provider, no AI
// Gateway, no external paid model.
//
// PROMPT — deliberately short and fixed (order section 三): judges ONLY
// "would this materially affect a working taxi/for-hire driver's ability
// to get through, right now" — never event-TYPE-based (accident/
// construction/control no longer pre-decide anything; see this module's
// own SYSTEM_PROMPT). The old MAJOR_ACCIDENT_ONLY/type-whitelist
// vocabulary is deliberately NOT reproduced in the prompt.
//
// OUTPUT — strict JSON: {notify:boolean, impact:'HIGH'|'LOW',
// reason:string, confidence:0..1}. Anything that fails validation
// (invalid JSON, missing/wrong-typed field, impact outside the enum,
// confidence out of range) is AI_DECISION_INVALID and NEVER reaches LINE
// — see validateAiDecisionResponse().

import { computeAiDecisionCacheKeyHash, buildAiDecisionCacheKvKey } from './aiCandidate.js';
import { readAiDecisionCache, persistAiDecisionCache } from './aiDecisionCache.js';
import { buildMemoryContextFingerprint } from '../traffic/incidentMemory.js';

export const PBS_AI_MODEL_ID = '@cf/zai-org/glm-4.7-flash';

const VALID_IMPACT_VALUES = new Set(['HIGH', 'LOW']);
const REASON_MAX_CHARS = 80;

// order section 三 — kept short and fixed on purpose (avoid burning
// tokens/neurons and avoid re-introducing the old event-type whitelist
// vocabulary this whole round exists to retire from the decision path).
const SYSTEM_PROMPT = `你是新竹縣市營業車路況判讀員。
判斷這則交通事件是否會對正在營運的計程車／營業車司機造成值得主動通知的實質通行影響。

重點考慮：
- 是否無法正常通行
- 是否需要繞路
- 是否會造成明顯延誤
- 是否封路／封閉車道／交流道／橋梁／隧道
- 是否屬長時間重大交通管制
- 是否會影響接送或營運動線

不要因為事件類型名稱是事故、施工、管制就直接決定。
短時間、影響輕微、很快可通行的事件通常不需要主動通知。

只能輸出一個 JSON 物件，格式如下，不要有任何其他文字：
{"notify": true 或 false, "impact": "HIGH" 或 "LOW", "reason": "繁體中文短句，不超過80字", "confidence": 0 到 1 之間的數字}`;

// V2.4.0 — appended to SYSTEM_PROMPT ONLY when the caller actually
// supplies recentIncidentContext (traffic/incidentMemory.js's own
// prefiltered candidates) — order section 十一's three questions, kept
// as close to the existing prompt's own plain-language style as
// possible, never a second/different vocabulary. When no context is
// supplied (every PBS call today, and any TDX/PBS call with nothing
// nearby in memory), this text is never appended and the JSON schema
// asked for is byte-for-byte the original four fields — see
// buildAiRequest's own comment for why that matters for cache-key
// compatibility.
const MEMORY_CONTEXT_PROMPT_SUFFIX = `

以下另外提供「近期同路段、同方向的既有事故記錄」（最多5筆，依最新時間排序），
每筆記錄包含來源、事件類型、首次發現時間、最後確認時間、最後通知時間、最近摘要。
請額外判斷這筆新事件與其中最相關的一筆是否為「同一起事故」，以及是否有「實質變化」
（例如：從單線事故惡化為全線封閉、從可通行變成無法通行、車道封閉數增加）。

輸出的 JSON 物件需多兩個欄位：
"sameIncident": true 或 false（是否與提供的近期記錄中最相關的一筆屬於同一起事故；
若近期記錄中沒有任何一筆看起來相關，請回答 false）
"materialChange": true 或 false（若 sameIncident 為 false，此欄位一律為 false；
若 sameIncident 為 true，判斷是否有上述實質變化，或距離上次通知已經過一段時間、
事故仍持續、值得再次提醒駕駛）`;

/**
 * Only the fields the model actually needs (order section 五) — never a
 * whole PBS batch, trace, KV state, LINE state, or CCTV metadata.
 */
function buildAiUserPrompt(candidate) {
  const summary = {
    road: candidate.road || '',
    direction: candidate.direction || '',
    areaNm: candidate.areaNm || '',
    displayKM: candidate.displayKM,
    eventType: candidate.eventType || '',
    comment: candidate.comment || '',
    sourceDetail: candidate.sourceDetail || '',
  };
  return JSON.stringify(summary);
}

// V2.4.0 — the exact (and ONLY) fields of an incidentMemory.js record
// the model ever sees. Deliberately excludes incidentKey/km/latitude/
// longitude/currentStatus — the model reasons about "same incident" from
// the same descriptive fields a human would (source/type/timing/
// summary), never from an internal storage id or raw coordinates it has
// no use for; road/direction are already implied (this candidate list is
// pre-filtered to the SAME road+direction group, see incidentMemory.js's
// selectMemoryCandidates).
function summarizeMemoryCandidateForPrompt(record) {
  return {
    source: record.primarySource || record.latestSource || '',
    eventType: record.eventType || '',
    firstSeenAt: record.firstSeenAt || null,
    lastSeenAt: record.lastSeenAt || null,
    lastNotifiedAt: record.lastNotifiedAt || null,
    summary: record.latestRawSummary || '',
  };
}

/**
 * Exported for tests — the exact request body sent to env.AI.run().
 *
 * @param {object} candidate
 * @param {{recentIncidentContext?: object[]}} [options] - V2.4.0.
 *   `recentIncidentContext` — incidentMemory.js#selectMemoryCandidates()'s
 *   own output (already prefiltered to <=5 same-road-direction, in-
 *   window, proximate records — this function never re-filters or
 *   re-queries anything). Omitted/empty -> the ORIGINAL prompt/schema,
 *   unchanged, so every existing PBS call site (which passes nothing)
 *   gets byte-for-byte the same request it always has.
 */
export function buildAiRequest(candidate, { recentIncidentContext = [] } = {}) {
  const hasContext = Array.isArray(recentIncidentContext) && recentIncidentContext.length > 0;
  const systemPrompt = hasContext ? `${SYSTEM_PROMPT}${MEMORY_CONTEXT_PROMPT_SUFFIX}` : SYSTEM_PROMPT;
  const userPromptObject = hasContext
    ? { event: JSON.parse(buildAiUserPrompt(candidate)), recentIncidents: recentIncidentContext.map(summarizeMemoryCandidateForPrompt) }
    : null;
  return {
    model: PBS_AI_MODEL_ID,
    input: {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: hasContext ? JSON.stringify(userPromptObject) : buildAiUserPrompt(candidate) },
      ],
    },
  };
}

/**
 * Workers AI response shapes vary a little by model family; this reads
 * the common ones defensively rather than assuming one. Never throws.
 */
function extractAiResponseText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.response === 'string') return result.response;
  if (Array.isArray(result.choices) && result.choices[0] && result.choices[0].message) {
    return String(result.choices[0].message.content || '');
  }
  if (typeof result.output_text === 'string') return result.output_text;
  return '';
}

/**
 * Pure — parses+validates a raw model response string against the
 * required schema (order section 四). Tolerates surrounding prose around
 * the JSON object (models occasionally wrap JSON in a sentence or code
 * fence despite instructions) by extracting the first `{...}` block
 * before parsing, but never loosens the SCHEMA itself.
 *
 * V2.4.0 — when `expectMemoryFields` is true (the caller supplied
 * recentIncidentContext to buildAiRequest — see resolveAiDecision below),
 * `sameIncident`/`materialChange` are now REQUIRED booleans, validated
 * with the exact same strictness as every other field ("但保持最小化" —
 * order section 十一 — two booleans, no incidentStatus enum, no free
 * text). When false (every existing PBS call, and any call with nothing
 * nearby in memory), these two fields are not required at all and are
 * simply absent from `decision` — the ORIGINAL four-field schema,
 * unchanged, so this validator's behavior for every pre-V2.4.0 caller is
 * byte-for-byte identical to before.
 *
 * @returns {{ok:true, decision:{notify:boolean, impact:'HIGH'|'LOW', reason:string, confidence:number, sameIncident?:boolean, materialChange?:boolean}}|{ok:false, reason:'AI_DECISION_INVALID', detail:string}}
 */
export function validateAiDecisionResponse(rawText, { expectMemoryFields = false } = {}) {
  const invalid = (detail) => ({ ok: false, reason: 'AI_DECISION_INVALID', detail });
  if (typeof rawText !== 'string' || !rawText.trim()) return invalid('empty-response');

  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) return invalid('no-json-object-found');

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return invalid('json-parse-error');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('not-an-object');

  if (typeof parsed.notify !== 'boolean') return invalid('notify-not-boolean');
  if (typeof parsed.impact !== 'string' || !VALID_IMPACT_VALUES.has(parsed.impact)) return invalid('impact-invalid');
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return invalid('reason-missing');
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    return invalid('confidence-out-of-range');
  }

  const decision = {
    notify: parsed.notify,
    impact: parsed.impact,
    reason: parsed.reason.length > REASON_MAX_CHARS ? `${parsed.reason.slice(0, REASON_MAX_CHARS)}…` : parsed.reason,
    confidence: parsed.confidence,
  };

  if (expectMemoryFields) {
    if (typeof parsed.sameIncident !== 'boolean') return invalid('sameIncident-not-boolean');
    if (typeof parsed.materialChange !== 'boolean') return invalid('materialChange-not-boolean');
    // sameIncident:false logically forces materialChange:false ("若
    // sameIncident 為 false，此欄位一律為 false" — the prompt's own
    // instruction). A model that violates its own instructed invariant
    // is exactly the kind of malformed-but-schema-valid response this
    // validator exists to catch — never silently accepted.
    if (!parsed.sameIncident && parsed.materialChange) return invalid('materialChange-true-without-sameIncident');
    decision.sameIncident = parsed.sameIncident;
    decision.materialChange = parsed.materialChange;
  }

  return { ok: true, decision };
}

/**
 * Calls Workers AI exactly once (no retry — order section 十二: "第一版
 * 保持簡單...不得做複雜retry queue"; a bounded single retry was
 * considered and deliberately not added — see this round's own final
 * report for the reasoning). Never throws — every failure mode (missing
 * binding, network/runtime error, HTTP-shaped error from env.AI.run)
 * becomes a uniform {ok:false} so the caller's fail-closed policy is the
 * ONLY branch that ever decides what happens next.
 */
async function callWorkersAi(env, candidate, { recentIncidentContext = [] } = {}) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    return { ok: false, reason: 'AI_CALL_FAILED', detail: 'ai-binding-missing' };
  }
  const request = buildAiRequest(candidate, { recentIncidentContext });
  try {
    const result = await env.AI.run(request.model, request.input);
    const rawText = extractAiResponseText(result);
    return { ok: true, rawText, usage: result && typeof result === 'object' ? result.usage : undefined };
  } catch (err) {
    return { ok: false, reason: 'AI_CALL_FAILED', detail: err && err.message ? err.message : 'unknown-error' };
  }
}

/**
 * The one orchestration entry point (order section 八's ordering, steps
 * 5-8): cache lookup -> (miss) call AI -> validate -> persist. Cache
 * read/write outages fail OPEN toward calling AI (never toward silently
 * reusing a stale/unreadable record, and never toward blocking the
 * decision this request already computed) — same fail-open philosophy as
 * debugPush.js's own V1.9.7 idempotency layer.
 *
 * @param {object} env
 * @param {object} candidate - pbs/aiCandidate.js#buildAiCandidate() output
 * @param {{eventId:string, fingerprint:string}} keyInput
 * @param {Date} now
 * @param {{recentIncidentContext?: object[]}} [options] - V2.4.0.
 *   `recentIncidentContext` — see buildAiRequest's own comment. Threaded
 *   through unchanged to the prompt, the schema validator (which fields
 *   become required), AND the cache key (via
 *   incidentMemory.js#buildMemoryContextFingerprint) — all three MUST
 *   agree on whether memory context was supplied, or a cache hit could
 *   return a decision shape the caller isn't expecting. Omitted (every
 *   existing PBS call site) reproduces the exact pre-V2.4.0 behavior in
 *   all three places.
 * @returns {Promise<{
 *   source: 'cache-hit'|'ai-call',
 *   ok: boolean,
 *   decision?: object,
 *   reason?: string,
 *   detail?: string,
 *   durationMs: number,
 *   usage?: object,
 * }>}
 */
export async function resolveAiDecision(env, candidate, { eventId, fingerprint }, now = new Date(), { recentIncidentContext = [] } = {}) {
  const startedAt = Date.now();
  const kv = env && env.TRAFFIC_KV;
  const expectMemoryFields = Array.isArray(recentIncidentContext) && recentIncidentContext.length > 0;
  const memoryContextFingerprint = expectMemoryFields ? buildMemoryContextFingerprint(recentIncidentContext) : undefined;
  const keyHash = await computeAiDecisionCacheKeyHash({ eventId, fingerprint, memoryContextFingerprint });
  const kvKey = buildAiDecisionCacheKvKey(keyHash);

  const cached = await readAiDecisionCache(kv, kvKey);
  if (cached.hit) {
    return { source: 'cache-hit', ok: true, decision: cached.decision, durationMs: Date.now() - startedAt };
  }

  const aiResult = await callWorkersAi(env, candidate, { recentIncidentContext });
  if (!aiResult.ok) {
    return { source: 'ai-call', ok: false, reason: aiResult.reason, detail: aiResult.detail, durationMs: Date.now() - startedAt };
  }

  const validation = validateAiDecisionResponse(aiResult.rawText, { expectMemoryFields });
  if (!validation.ok) {
    return { source: 'ai-call', ok: false, reason: validation.reason, detail: validation.detail, durationMs: Date.now() - startedAt, usage: aiResult.usage };
  }

  // Persist AFTER validation — an invalid response is never cached (a
  // future retry for the same content should get a fresh AI attempt, not
  // a cached invalid result).
  await persistAiDecisionCache(kv, kvKey, {
    eventId,
    fingerprint,
    decision: validation.decision,
    model: PBS_AI_MODEL_ID,
    decidedAt: now.toISOString(),
  });

  return { source: 'ai-call', ok: true, decision: validation.decision, durationMs: Date.now() - startedAt, usage: aiResult.usage };
}
