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
// V2.4.2 — V2_4_2_PBS_AI_LINE_INFORMATION_FIDELITY_AND_POLICY_FIX (order
// section 十一/十二/十三/十四). Production review of one day's real
// decisions found the prompt's original single question — "會不會造成
// 明顯壅塞" (will this cause noticeable congestion) — was too narrow a
// proxy for the product's actual goal: a credible accident notify:false'd
// because "一般事故，短時間壅堵機率大" (a plain accident, unlikely to jam
// for long); a road hazard (輪胎皮/掉落物) notify:false'd for the same
// congestion-only reasoning despite real predictive safety value even
// with NO congestion yet; and, in the other direction, plain 車多 (normal
// traffic volume, no incident) notify:true'd on "車流喘不過氣" reasoning
// that would flood real subscribers with routine-congestion noise and
// bury genuinely important accident/collapse/obstruction messages under
// it. The fix is a PROMPT rewrite only (order: "不要回到大量 hard-coded
// keyword rules...優先透過 AI prompt理解語意") — reframing the central
// question from "會不會壅塞" to "值不值得營業駕駛提前知道", plus three
// named semantic anchors (accident/predictive-hazard/normal-congestion)
// stated in plain language, NOT a new regex/keyword gate anywhere in code
// — `buildAiRequest`'s schema, `validateAiDecisionResponse`'s validation,
// and every call site are all byte-for-byte unchanged; only the text
// inside SYSTEM_PROMPT below changed.
//
// V2.4.4 — V2_4_4_TDX_SCOPE_POLICY_AND_MESSAGE_FIDELITY_FIX (order
// section 二). Production review of real TDX events after Phase C found
// routine road-management notices (例行施工/機動路肩開放/機動路肩關閉)
// notify:true'd on the SAME "would this affect a driver's ability to get
// through" reasoning that correctly covers real events — "道路管理狀態"
// is a different question from "值得立即通知的突發安全事件". Fourth
// semantic anchor added (PROMPT TEXT ONLY, same discipline as V2.4.2 —
// no new code-level keyword whitelist/blacklist anywhere): routine
// construction/shoulder-open/shoulder-close/general closure maintenance
// -> notify=false by default, UNLESS the event's own content states an
// accident/major obstruction/complete closure/major collapse/rockfall/
// large debris/sudden lane closure/other clear safety risk — judged on
// content, never on the event-type label alone.
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

// V2.4.8 — V2_4_8_AI_LINE_MESSAGE_EDITOR_AND_UNIFIED_PRESENTATION (order
// section 二/四). `cleanSummary` is a TEXT-EDITING product, not a decision
// explanation — never confused with `reason` (which stays exactly what it
// always was: the AI's justification for its notify verdict, still never
// shown to a driver — see messageFormat.js's own "THREE-LAYER
// ARCHITECTURE" comment, unchanged this round). Nominal target is ~20-60
// Chinese characters (order section 四); this cap is deliberately generous
// slack above that so a normal-length real answer is never rejected, while
// still catching a genuinely runaway/invalid response — anything over this
// falls back to the existing deterministic formatter (order section
// 十五), never truncated and shown half-cut.
export const CLEAN_SUMMARY_MAX_CHARS = 100;

// order section 三 — kept short and fixed on purpose (avoid burning
// tokens/neurons and avoid re-introducing the old event-type whitelist
// vocabulary this whole round exists to retire from the decision path).
const SYSTEM_PROMPT = `你是新竹縣市營業車路況判讀員。
判斷這則交通事件是否「值得正在營運的計程車／營業車司機提前知道」，
而不是單純判斷「這件事情會不會造成明顯壅塞」——兩者不是同一個問題，
下面三類原則說明差異（請理解語意後套用，不是逐字比對關鍵字）：

一、明確可信的事故／車禍／碰撞／追撞：
原則上 notify=true。不需要先證明會造成重大壅塞才通知——事故本身就是
駕駛應該提前知道的資訊，讓駕駛自己判斷是否繞行、減速或提高警覺。
impact 可以判斷為 LOW 或 HIGH，但不要只因為「看起來是一般事故、短時間
應該可以通過」就 notify=false。除非事件明顯無效／測試資料／不是道路
事件／不在服務區域內，才可以 notify=false。

二、預防性駕駛安全風險（即使目前還沒有明顯壅塞）：
道路掉落物、輪胎皮、大型異物、道路障礙、落石、坍方、土石、道路中斷、
封閉、車道阻斷等——原則上 notify=true。即使現在還沒塞車，這類資訊仍
有提前減速、換道、提高警覺的安全價值，不需要等到造成壅塞才通知。

三、單純車流量大／一般壅塞（沒有事故、坍方、掉落物等具體事件）：
單純的車多、車流略多、尖峰時段的一般壅塞、下雨天可預期的車流，原則上
notify=false，避免這類日常、可預期的車流資訊，把真正重要的事故／坍方／
掉落物／道路阻斷等訊息淹沒。除非明顯異常嚴重、長距離回堵、確定是由
重大事故或封閉造成、長時間完全停滯、或道路功能明顯下降，才 notify=true。

四、一般道路管理狀態（例行施工、機動路肩開放／關閉、一般封閉維護等）：
單純的例行施工、機動路肩開放、機動路肩關閉、一般封閉維護資訊，原則上
notify=false——「道路管理狀態」不等於「值得營業駕駛立即收到通知的突發
安全事件」，這類資訊通常是計畫中、可預期的管制，不需要主動打擾駕駛。
除非事件內容本身包含以下任一項，才由你依語意判斷是否 notify=true：
- 事故／車禍／碰撞
- 重大障礙、道路完全中斷
- 重大坍方、落石、大型掉落物
- 車道突發封閉（非原本計畫中的管制）
- 其他明顯的駕駛安全風險
判斷依據是事件「內容本身」是否已經超出例行管理範圍，而不是因為事件類型
名稱剛好是「施工」或「路肩」就自動排除或自動通知。

以上四類以外的其他事件（一般管制等），重點考慮：
- 是否無法正常通行
- 是否需要繞路
- 是否會造成明顯延誤
- 是否封路／封閉車道／交流道／橋梁／隧道
- 是否屬長時間重大交通管制
- 是否會影響接送或營運動線

不要因為事件類型名稱是事故、施工、管制就直接決定，也不要單純以「會不會
造成壅塞」作為唯一判斷依準——上面一、二類即使不塞車也可能值得通知。
短時間、影響輕微、很快可通行，且不屬於一、二、四類例外的事件，通常不
需要主動通知。

另外，無論 notify 判斷結果為何，都請同時完成一項文字編輯工作——產生 cleanSummary：
把這則事件原始通報文字（comment／description）整理成 1～2 句、約 20～60 個繁體中文字
的乾淨事件摘要，只描述「發生了什麼事」。你在做的是文字編輯，不是事實生成：
- 可以：修正錯字、修正標點、刪除重複詞句、刪除行政贅語、重整語序、把落落長的原文濃縮成
  精簡的中文句子。
- 絕對禁止：捏造原文沒有提到的事故細節、傷亡、壅塞長度，或自己猜測地點。
- 絕對禁止：在 cleanSummary 裡重複寫出道路名稱、方向、公里數、封閉車道數字——這些一律由
  系統直接從既有結構化資料顯示，不需要你重複生成，你只需要描述事件本身的性質（例如「發生
  兩車追撞」「路肩有故障車輛」「路面散落物」）。

只能輸出一個 JSON 物件，格式如下，不要有任何其他文字：
{"notify": true 或 false, "impact": "HIGH" 或 "LOW", "reason": "繁體中文短句，不超過80字", "confidence": 0 到 1 之間的數字, "cleanSummary": "繁體中文事件摘要，約20~60字，禁止提及道路/方向/公里數/封閉車道數字，禁止捏造原文沒有的細節"}`;

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
 *
 * V2.4.5 (V2_4_5_TDX_ROAD_MANAGEMENT_POLICY_GATE, order section 七/八) —
 * `blockedLanes` added as a structured, deterministic fact (same
 * "always present, null when unknown" shape `displayKM` already uses)
 * so the model sees the SAME lane-count roadManagementPolicyGate.js's
 * own gate already used, never a re-derivation from whether `comment`
 * happens to mention a number. Lane-count counting itself stays
 * deterministic code (that gate); this is the only remaining AI
 * question for an already-gate-eligible event — "is this specific event
 * worth notifying a driver about" — never "does this count as many
 * lanes". PBS candidates always carry `blockedLanes: null` here (PBS
 * never sets it) — purely additive, never a behavior change to PBS's
 * own decision.
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
    blockedLanes: typeof candidate.blockedLanes === 'number' ? candidate.blockedLanes : null,
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

  // V2.4.8 (order section 十五) — `cleanSummary` is validated SEPARATELY
  // from the four fields above, and its own invalidity NEVER invalidates
  // the whole response ("文字美容不能成為通知單點故障...不得因 cleanSummary
  // 出問題，把原本應該發送的重大事故整筆吞掉"). A missing/empty/non-string/
  // too-long cleanSummary simply resolves to `null` here — the caller
  // (messageFormat.js) already falls back to its own pre-existing
  // deterministic formatting whenever `cleanSummary` is null, so this is
  // the ONE place that decides "clean enough to use" vs "fall back",
  // never a second/different check downstream.
  decision.cleanSummary =
    typeof parsed.cleanSummary === 'string' && parsed.cleanSummary.trim() && parsed.cleanSummary.trim().length <= CLEAN_SUMMARY_MAX_CHARS
      ? parsed.cleanSummary.trim()
      : null;

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

// V2.4.8 (order section 十六) — "AI cleanSummary 不得與 canonical facts
// 矛盾...最安全原則：road/direction/KM/blockedLanes 盡可能不要讓 AI 重複生
// 成，讓 formatter 固定顯示，AI 只整理發生什麼事情". The prompt already
// instructs the model never to restate these (see SYSTEM_PROMPT's own
// V2.4.8 addition) — this is the code-level safety net for when a model
// ignores that instruction anyway. Pure, synchronous, no I/O. Deliberately
// narrow: only checks the two facts a free-text sentence could plausibly
// state a WRONG number/word for (a lane count, a direction word) — it
// does not attempt to parse or verify open-ended prose against every
// possible fact, which would just be a second, unreliable judgment layer.
// A false negative (a contradiction this check misses) degrades to
// "cleanSummary shown as-is", the same risk already accepted by trusting
// the model's own prompt-level instruction; a false positive (flagging a
// clean summary that didn't actually contradict anything) degrades to
// "fell back to the deterministic formatter" — never a broadcast
// correctness problem either way.
//
// @param {string|null} cleanSummary
// @param {{direction?: string, blockedLanes?: number|null}} candidate
// @returns {boolean} true if cleanSummary is safe to use, false if it
//   contradicts an already-known canonical fact (caller should treat this
//   exactly like an invalid/missing cleanSummary — fall back).
export function cleanSummaryContradictsFacts(cleanSummary, candidate) {
  if (!cleanSummary || typeof cleanSummary !== 'string') return false; // nothing to contradict
  const text = cleanSummary;

  // Lane-count contradiction — "封閉N車道"/"N車道封閉"/"N線道封閉" shapes.
  if (typeof candidate?.blockedLanes === 'number' && Number.isFinite(candidate.blockedLanes)) {
    const laneMatch = text.match(/封閉\s*(\d+)\s*(?:車|線)道|(\d+)\s*(?:車|線)道(?:封閉|受阻)/);
    if (laneMatch) {
      const stated = Number(laneMatch[1] ?? laneMatch[2]);
      if (Number.isFinite(stated) && stated !== candidate.blockedLanes) return true;
    }
  }

  // Direction contradiction — any of the four cardinal/bidirectional
  // words appearing in the summary that is NOT the candidate's own
  // direction is treated as a contradiction (a genuine mention of the
  // correct direction is harmless and not flagged).
  const DIRECTION_WORDS = ['北向', '南向', '東向', '西向', '雙向'];
  if (candidate?.direction) {
    for (const word of DIRECTION_WORDS) {
      if (word !== candidate.direction && text.includes(word)) return true;
    }
  }

  return false;
}

// V2.4.3 — V2_4_3_AI_TIMEOUT_AND_STALE_RETRY_RELIABILITY_FIX (order
// section 五). Production evidence (EVENT_ID 11509010029-5, 2026-09-01):
// three consecutive Workers AI attempts each ran ~236 seconds
// (235877ms/235829ms/235621ms) before rejecting with "3046: Request
// timeout" — this repo had NO application-level timeout of any kind
// (confirmed by reading this function before this round: a bare `await
// env.AI.run(...)`, no AbortController/AbortSignal/Promise.race) — so
// that ~236s ceiling and error code are platform-side (Workers AI
// binding), not anything this repo's own code configured. Three retries
// at that pace cost ~12 minutes end to end for one event, unacceptable
// for real-time traffic — order's own fail-fast requirement.
//
// TIMEOUT VALUE — order's own suggested 30-60s evaluation window;
// 45000ms (midpoint) chosen as a documented ENGINEERING JUDGMENT, not a
// measured value: this repo has no recorded telemetry for a genuinely
// SUCCESSFUL AI call's typical latency (every real Production sample
// with timing evidence this round is a FAILURE, ~236s each) — the model
// itself ('@cf/zai-org/glm-4.7-flash', a "flash"-class model) answers a
// short, fixed small JSON schema from a short prompt, which should
// normally complete in low single-digit seconds; 45s leaves generous
// headroom above that expectation while cutting a genuine platform-side
// stall down from ~236s/attempt to a bounded, retry-friendly window.
//
// SAFETY OF A CALLER-SIDE RACE (order's own explicit warning: "不得做表
// 面 Promise.race timeout 但背景 AI 仍持續執行造成隱形資源浪費/重複 side
// effect") — this session has NO way to independently confirm whether
// env.AI.run() honors any cancellation signal (no live Cloudflare
// binding docs access from this sandbox); TRUE underlying cancellation
// is therefore NOT confirmed, and is reported honestly as such in this
// round's own final report. This is still safe to ship: this function
// has ZERO side effects of its own — no KV/LINE/CCTV write happens
// inside callWorkersAi or inside env.AI.run() itself (see this module's
// own header comment — this is "ZERO LINE/CCTV/Shared Feed side
// effects" territory). A slow call that keeps running in the background
// after this function has already returned AI_CALL_FAILED has nothing
// left to do with its eventual result: nothing downstream ever awaits or
// reads it, so a late resolution can never produce a duplicate LINE push
// or a duplicate KV write. The only real cost of no true cancellation is
// continued platform-side compute on Cloudflare's own inference backend
// (a resource question, not a correctness/duplicate-side-effect one),
// which this repo cannot control from application code either way.
export const AI_CALL_TIMEOUT_MS = 45000;

/**
 * Calls Workers AI exactly once (no retry — order section 十二: "第一版
 * 保持簡單...不得做複雜retry queue"; a bounded single retry was
 * considered and deliberately not added — see this round's own final
 * report for the reasoning). Never throws — every failure mode (missing
 * binding, network/runtime error, HTTP-shaped error from env.AI.run,
 * application-level fail-fast timeout) becomes a uniform {ok:false} so
 * the caller's fail-closed policy is the ONLY branch that ever decides
 * what happens next. `timedOut:true` is set ONLY for the new V2.4.3
 * fail-fast path (never for a genuine env.AI.run() rejection) — purely
 * additive observability, read by debugPush.js's Observatory recording,
 * never by any retry-eligibility decision (AI_CALL_FAILED itself is
 * unchanged and still the one signal the Queue Consumer's retry check
 * uses — see that module's own comment).
 */
async function callWorkersAi(env, candidate, { recentIncidentContext = [], aiCallTimeoutMs = AI_CALL_TIMEOUT_MS } = {}) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    return { ok: false, reason: 'AI_CALL_FAILED', detail: 'ai-binding-missing' };
  }
  const request = buildAiRequest(candidate, { recentIncidentContext });
  // See this module's own V2.4.3 comment above for the full safety
  // analysis. `.catch(() => {})` on the raw call promise prevents an
  // unhandled-rejection warning if it loses the race and later rejects
  // on its own — its outcome, success or failure, is simply discarded
  // once the timeout has already been returned to the caller.
  const aiCallPromise = env.AI.run(request.model, request.input);
  aiCallPromise.catch(() => {});
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ __v243TimedOut: true }), aiCallTimeoutMs);
  });
  try {
    const raced = await Promise.race([aiCallPromise, timeoutPromise]);
    if (raced && raced.__v243TimedOut) {
      return {
        ok: false,
        reason: 'AI_CALL_FAILED',
        detail: `application-level fail-fast timeout after ${aiCallTimeoutMs}ms (underlying Workers AI call may still be running server-side; see this module's own V2.4.3 comment)`,
        timedOut: true,
      };
    }
    const rawText = extractAiResponseText(raced);
    return { ok: true, rawText, usage: raced && typeof raced === 'object' ? raced.usage : undefined };
  } catch (err) {
    return { ok: false, reason: 'AI_CALL_FAILED', detail: err && err.message ? err.message : 'unknown-error' };
  } finally {
    clearTimeout(timeoutHandle);
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
export async function resolveAiDecision(env, candidate, { eventId, fingerprint }, now = new Date(), { recentIncidentContext = [], aiCallTimeoutMs = AI_CALL_TIMEOUT_MS } = {}) {
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

  const aiResult = await callWorkersAi(env, candidate, { recentIncidentContext, aiCallTimeoutMs });
  if (!aiResult.ok) {
    // V2.4.3 — `timedOut` forwarded unchanged when present (the fail-fast
    // path only); omitted otherwise, exactly as before this round.
    return {
      source: 'ai-call',
      ok: false,
      reason: aiResult.reason,
      detail: aiResult.detail,
      durationMs: Date.now() - startedAt,
      ...(aiResult.timedOut ? { timedOut: true } : {}),
    };
  }

  const validation = validateAiDecisionResponse(aiResult.rawText, { expectMemoryFields });
  if (!validation.ok) {
    return { source: 'ai-call', ok: false, reason: validation.reason, detail: validation.detail, durationMs: Date.now() - startedAt, usage: aiResult.usage };
  }

  // V2.4.8 (order section 十六) — checked here, with `candidate` (the
  // structured facts) in scope, which validateAiDecisionResponse() itself
  // never has. A contradicting cleanSummary is nulled out — same "fall
  // back, never invalidate the whole decision" treatment as any other
  // cleanSummary invalidity (order section 十五) — the notify/impact/
  // reason/confidence verdict this AI call already reached is completely
  // unaffected either way.
  if (cleanSummaryContradictsFacts(validation.decision.cleanSummary, candidate)) {
    validation.decision.cleanSummary = null;
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
