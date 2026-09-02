// V1.9.9 Phase 2 — AI-ready Business Pipeline Simplification.
//
// WHAT THIS MODULE IS, AND ISN'T
// -------------------------------
// This is PREPARATION for a future Workers AI decision stage (Phase 3),
// not an integration with one. Nothing in this file calls any AI model,
// writes any KV key, or has any LINE/CCTV/Shared Feed side effect. It has
// exactly one job: turn a Windows-sourced, already-normalized PBS event
// into a minimal, clean "AI candidate" object — a snapshot of the event
// as-is, with none of today's content-judgment hard rules (MAJOR_ACCIDENT_
// ONLY, the V1.5 type/keyword whitelist, location-quality hard-reject)
// applied to decide whether the candidate even gets built.
//
// WHY THIS EXISTS (order section 一/二)
// --------------------------------------
// The target future flow is:
//   PBS -> Windows service-area filter -> lifecycle -> Cloudflare ingress
//   -> auth -> validation -> persistent idempotency -> AI Decision (Phase 3)
//   -> LINE execution
// Today's ACTUAL decision of "is this worth a LINE push" is made by
// traffic/broadcastPolicy.js's MAJOR_ACCIDENT_ONLY policy and traffic/
// broadcastRules.js's type/keyword whitelist, layered inside traffic/
// broadcastPipeline.js#runLineBroadcast. Those are content-judgment rules
// — exactly the kind of decision a future AI stage should make instead.
// This round does NOT touch, bypass, or weaken them for the real LINE
// decision (src/pbs/debugPush.js's existing call into runLineBroadcast is
// completely unmodified — see that module's own comment) — they remain
// the full, active, "legacy policy" gatekeeper of every real LINE push
// this round, exactly as before. This module only builds a SEPARATE,
// side-effect-free preview of what an AI candidate list would look like
// once those rules are retired for the Windows PBS path in a future
// round — observable via a log line only, per PBS_AI_DECISION_MODE below.
//
// WHAT STILL GATES CANDIDATE CONSTRUCTION (order section 三)
// -------------------------------------------------------------
// Only the things this project's own order calls out as NOT a "content
// hard rule": service-area (Windows already restricts to Hsinchu — see
// isWindowsPbsAiCandidateEligible, reusing the SAME canonical service-area
// resolver runLineBroadcast itself uses, never a second implementation)
// and persistent idempotency / duplicate protection (already enforced by
// debugPush.js's own V1.9.7 layer, upstream of this module's call site —
// a duplicate never reaches buildAiCandidate at all). Event TYPE (accident
// vs. construction vs. control vs. congestion vs. other) is deliberately
// NOT a gate here — see CASE 2/3/4/5 in test/pbsAiCandidate.test.js.
//
// LOCATION QUALITY (order section 四)
// -------------------------------------
// traffic/locationQuality.js's resolveLocationQuality() is reused
// UNMODIFIED and READ-ONLY here — never as a gate, only as metadata
// attached to the candidate (`locationQuality` field) so a future AI
// stage (or a human) can still see the signal without it silently
// eliminating an event before AI ever sees it. This is intentionally
// SCOPED to this module only: runLineBroadcast's own use of
// resolveLocationQuality as a hard gate for every other source (TDX, and
// the real LINE decision for PBS events too) is completely untouched.
//
// SAFETY STATE (order section 六)
// ----------------------------------
// PBS_AI_DECISION_MODE = 'PREPARED_NOT_ACTIVE' — the pipeline described
// above is prepared (this module exists, is called, and logs a real
// candidate) but NOT ACTIVE (the candidate is never used to decide
// anything, never reaches LINE, and no AI model is ever called). This is
// the literal safe-transition state order section 六 asks for.

import { resolveServiceAreaEligibility } from '../traffic/serviceArea.js';
import { resolveLocationQuality } from '../traffic/locationQuality.js';

// Self-describing status constants — same convention as debugPush.js's own
// PBS_DEBUG_PUSH_IDEMPOTENCY_MODE etc.: exported so the final report, the
// Engineering Memory record, and any future reader/test cite the SAME
// literal this module itself asserts, never a second hand-typed copy.
export const PBS_AI_DECISION_MODE = 'PREPARED_NOT_ACTIVE';
export const AI_INTEGRATION = 'NOT_STARTED';
export const AI_MODEL = 'NOT_SELECTED_IN_RUNTIME';
export const LINE_AI_DECISION = 'NOT_ACTIVE';

// Debug-only prefix RESERVED for Phase 3's AI decision cache — same
// dedicated-prefix discipline as debugPush.js's own IDEMPOTENCY_KV_PREFIX
// (structurally distinct from every business KV prefix in this project).
// NOT used for any actual KV read/write in this round — see
// computeAiDecisionCacheKeyHash's own comment. Defined now purely so
// Phase 3 has a stable, already-reviewed key shape to adopt without
// inventing one under time pressure once a real AI call exists.
export const AI_DECISION_CACHE_KV_PREFIX = 'debug:pbs-ai-decision-cache:v1';

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same technique as debugPush.js's own sha256Hex — duplicated locally per
 * this project's established "each module stays independently readable"
 * convention (see debugPushAuth.js's own module comment for the
 * precedent). */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bufferToHex(digest);
}

/**
 * The key Phase 3 will use to decide "have I already AI-judged the exact
 * same real-world content for this event, or has it actually changed" —
 * order section 八's "eventId + semantic fingerprint" authority. Reuses
 * the SAME stable `fingerprint` Windows already computes and sends on
 * every debug-push payload (V1.9.5) — deliberately NOT a new NLP/semantic
 * fingerprint (order: "不要加入複雜 NLP fingerprint。先沿用現有穩定
 * fingerprint 能力即可"). `eventId` alone would collapse NEW and UPDATED
 * (and any future genuine content change) into the same key; fingerprint
 * alone would collide across unrelated events that happen to produce the
 * same text. Both together is the minimum that satisfies "same event +
 * same real content -> reuse; real content changed -> re-judge".
 *
 * NEVER READS OR WRITES KV — this is schema/helper only, per order
 * section 八 ("本階段可以只實作最小 schema / helper，不得真的呼叫 AI").
 * Phase 3 is the first round allowed to actually put/get
 * AI_DECISION_CACHE_KV_PREFIX.
 *
 * V2.4.0 — optional third input `memoryContextFingerprint`
 * (traffic/incidentMemory.js#buildMemoryContextFingerprint's output).
 * Omitted (every pre-V2.4.0 caller, and every PBS call site today —
 * aiApprovedPbsBroadcast.js does not thread this through) produces the
 * EXACT SAME hash as before — byte-for-byte, since the string being
 * hashed is unchanged when this argument is absent/empty. This matters
 * for correctness, not just compatibility: once an AI decision's prompt
 * can include nearby Recent Incident Memory candidates (see
 * aiDecisionEngine.js's own V2.4.0 comment), "same eventId + same
 * fingerprint" alone no longer guarantees "same prompt, same decision" —
 * the SAME event content asked twice with a genuinely different memory
 * context (a new nearby sighting appeared in between) must not silently
 * replay a stale cached sameIncident/notify verdict. Folding the memory
 * fingerprint into the key is the minimal fix: a changed context produces
 * a different key -> a real cache miss -> a fresh, context-aware AI call.
 */
export async function computeAiDecisionCacheKeyHash({ eventId, fingerprint, memoryContextFingerprint }) {
  return sha256Hex(memoryContextFingerprint ? `${eventId}:${fingerprint}:${memoryContextFingerprint}` : `${eventId}:${fingerprint}`);
}

export function buildAiDecisionCacheKvKey(keyHash) {
  return `${AI_DECISION_CACHE_KV_PREFIX}:${keyHash}`;
}

/**
 * Is this Windows-sourced, already-normalized event even in scope for an
 * AI candidate at all? Reuses the EXACT SAME canonical service-area
 * resolver traffic/broadcastPipeline.js#runLineBroadcast itself calls
 * (traffic/serviceArea.js#resolveServiceAreaEligibility) — never a second,
 * parallel service-area implementation. This is the one and only gate;
 * event type, LINE policy, and location quality are deliberately NOT
 * checked here — see this module's own header comment.
 */
export function isWindowsPbsAiCandidateEligible(normalizedEvent) {
  return resolveServiceAreaEligibility(normalizedEvent).eligible;
}

/**
 * Builds the minimal AI candidate object (order section 七) from a
 * Windows-sourced event already run through pbs/normalize.js's
 * normalizePbsEvent() — the SAME normalized shape debugPush.js already
 * builds for the real runLineBroadcast call, never a second parsing pass.
 * Pure, synchronous, zero I/O, zero side effects — safe to call for every
 * accepted NEW/UPDATED event regardless of what a future AI stage would
 * eventually decide.
 *
 * Deliberately does NOT include `notify`/`impact` or any other AI-decision
 * field — order section 七: "不要在這個 object 裡提前產生 notify=true/false／
 * impact HIGH/LOW，那些是 Phase 3 AI 的工作."
 *
 * @param {object} normalizedEvent - pbs/normalize.js#normalizePbsEvent() output
 * @param {{lifecycle: string, generatedAt: string}} pushMeta - the two
 *   fields the Windows push payload carries that normalizedEvent itself
 *   doesn't (lifecycle is push-specific, not part of the unified event
 *   shape; generatedAt is passed through verbatim rather than re-derived
 *   from normalizedEvent.happenedAt/updatedAt, so the candidate always
 *   carries the exact instant Windows itself reported).
 */
export function buildAiCandidate(normalizedEvent, { lifecycle, generatedAt }) {
  return {
    source: normalizedEvent.source,
    eventId: normalizedEvent.rawId,
    lifecycle,
    road: normalizedEvent.road,
    direction: normalizedEvent.direction,
    areaNm: normalizedEvent.location,
    comment: normalizedEvent.description,
    longitude: normalizedEvent.longitude,
    latitude: normalizedEvent.latitude,
    generatedAt,
    // Optional / additive fields (order section 七's "以及有的話"):
    displayKM: typeof normalizedEvent.displayKM === 'number' ? normalizedEvent.displayKM : null,
    eventType: normalizedEvent.type,
    sourceDetail: normalizedEvent.sourceDetail || '',
    // V2.4.5 (V2_4_5_TDX_ROAD_MANAGEMENT_POLICY_GATE, order section 七/八)
    // — a TDX event that reaches this point has already passed
    // roadManagementPolicyGate.js's own deterministic lane-count gate
    // (tdxQueueIngress.js's Gate A); the AI's only remaining job for a
    // routine-construction event is "is this specific already-eligible
    // event worth notifying a driver about", and it must see the same
    // deterministic blockedLanes fact the gate itself used — never
    // re-derived from whether the free-text description happens to
    // mention a lane count. PBS never sets normalizedEvent.blockedLanes,
    // so this is always null there (same "always present, null when
    // absent" shape this file's own pre-existing `displayKM` field
    // already uses) — a purely additive JSON field in the AI prompt, per
    // buildAiUserPrompt's own V2.4.5 comment, never a behavior change to
    // PBS's own decision.
    blockedLanes: typeof normalizedEvent.blockedLanes === 'number' ? normalizedEvent.blockedLanes : null,
    // order section 四 — metadata / signal, never a gate. Reuses the
    // existing, unmodified resolver read-only; see this module's header
    // comment for the exact scoping.
    locationQuality: resolveLocationQuality(normalizedEvent),
  };
}
