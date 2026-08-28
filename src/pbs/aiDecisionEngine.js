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

/** Exported for tests — the exact request body sent to env.AI.run(). */
export function buildAiRequest(candidate) {
  return {
    model: PBS_AI_MODEL_ID,
    input: {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildAiUserPrompt(candidate) },
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
 * @returns {{ok:true, decision:{notify:boolean, impact:'HIGH'|'LOW', reason:string, confidence:number}}|{ok:false, reason:'AI_DECISION_INVALID', detail:string}}
 */
export function validateAiDecisionResponse(rawText) {
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

  return {
    ok: true,
    decision: {
      notify: parsed.notify,
      impact: parsed.impact,
      reason: parsed.reason.length > REASON_MAX_CHARS ? `${parsed.reason.slice(0, REASON_MAX_CHARS)}…` : parsed.reason,
      confidence: parsed.confidence,
    },
  };
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
async function callWorkersAi(env, candidate) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    return { ok: false, reason: 'AI_CALL_FAILED', detail: 'ai-binding-missing' };
  }
  const request = buildAiRequest(candidate);
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
export async function resolveAiDecision(env, candidate, { eventId, fingerprint }, now = new Date()) {
  const startedAt = Date.now();
  const kv = env && env.TRAFFIC_KV;
  const keyHash = await computeAiDecisionCacheKeyHash({ eventId, fingerprint });
  const kvKey = buildAiDecisionCacheKvKey(keyHash);

  const cached = await readAiDecisionCache(kv, kvKey);
  if (cached.hit) {
    return { source: 'cache-hit', ok: true, decision: cached.decision, durationMs: Date.now() - startedAt };
  }

  const aiResult = await callWorkersAi(env, candidate);
  if (!aiResult.ok) {
    return { source: 'ai-call', ok: false, reason: aiResult.reason, detail: aiResult.detail, durationMs: Date.now() - startedAt };
  }

  const validation = validateAiDecisionResponse(aiResult.rawText);
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
