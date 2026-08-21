// V1.8.5 — dynamic, per-accident CCTV image preparation for the real
// LINE broadcast pipeline (src/traffic/broadcastPipeline.js).
//
// THE SAFETY RULE THIS MODULE EXISTS TO ENFORCE: hsinchuCctvProbe.js's
// four-quadrant selector was, until this round, only ever exercised
// against a single FIXED test target (國道一號 82K+100 — TARGET_ROAD_ID/
// TARGET_KM). Wiring that fixed target directly into the real broadcast
// pipeline would have made EVERY accident's LINE message carry a CCTV
// image of 國道一號 82K+100 — wrong information for any other location.
// This module is the layer that makes CCTV image generation genuinely
// per-accident: it resolves each accident's own road + KM, and only
// EVER proceeds when that resolution is fully reliable — otherwise it
// fails closed (text-only), never guesses.
//
// Reuses, unchanged, three already-ratified/tested pieces rather than
// re-deriving any of them:
//   - tdx/hsinchuCctvProbe.js's four-quadrant selector
//     (selectFourQuadrantCandidates — same ±2km/±4km/null distance
//     strategy, same service-area exclusion) and its shared
//     fetch-frames-and-compose core (composeCollageFromCandidates) —
//     now GENERALIZED (V1.8.5) to take roadId/roadNamePattern/targetKm
//     as parameters instead of hardcoded constants, specifically so this
//     module could exist without touching the selection ALGORITHM itself
//     at all.
//   - traffic/roadSectionLabel.js's resolveRoadKey/parseKM — the SAME
//     tested road-alias resolution and KM-string parser already used
//     throughout this app for corridor/section-label logic, not a new,
//     independent text parser.
//   - cctv/publishedImage.js's publishCollageImage — the V1.8.4 R2-backed
//     publish layer, completely unchanged.
//
// CCTV_SUPPORTED_ROADS (below) is deliberately a closed, tiny registry:
// only 國道一號 — its CCTV RoadID ('000010') and RoadName pattern were
// independently confirmed against a real Production TDX CCTV/Freeway
// response (V1.7). No other freeway's CCTV RoadID has ever been
// observed from this development sandbox (TDX network egress is
// blocked here) — adding another road (國道三號 included) requires first
// confirming ITS real CCTV RoadID from an actual Production response,
// never guessed from "the numbering probably follows the same scheme."
// An accident on any other road — or one whose road text doesn't even
// resolve via resolveRoadKey at all — falls through to text-only.
//
// Fail-closed, at every single stage, per instruction: no reliable KM,
// an unsupported/unresolvable road, a missing CCTV_IMAGES/TRAFFIC_KV
// binding, an unavailable metadata cache, zero matching cameras, all 4
// frame fetches failing, a JPEG decode/compose failure, an R2 publish
// failure, OR exceeding the hard time budget (see CCTV_PREPARE_BUDGET_MS
// below) are ALL just "this accident doesn't get a CCTV image this
// tick" — never a reason to withhold the accident text itself, never a
// reason to mark the event failed, never a retry-with-delay. See
// broadcastPipeline.js for how a {ok:false} result here maps to a
// plain text-only LINE push, functionally identical to V1.8.4-and-
// earlier's only-ever-text behavior.
//
// CORRECTION (post-review, two Production blockers fixed):
//
// 1. UNBOUNDED DELAY. The first version of this module awaited the
//    entire CCTV pipeline (metadata, up to 4 frame fetches, JPEG
//    encode/decode, R2 publish) with no overall ceiling before ever
//    reaching the LINE push — "never delays the text" was true only in
//    the sense that a CCTV FAILURE didn't block the text, but a CCTV
//    pipeline that was merely SLOW (a hung frame fetch, a slow R2 put)
//    could delay a real accident notification indefinitely. Fixed with
//    CCTV_PREPARE_BUDGET_MS: the whole prepareCctvImageForEvent call is
//    raced against a hard timeout; losing that race resolves
//    {ok:false, reason:'prepare-timeout'} immediately and the broadcast
//    proceeds text-only THIS SAME tick — never waits for next Cron.
//    Frame fetches (already parallel, unchanged) are additionally given
//    whatever's left of the budget as their own per-fetch timeout (see
//    composeCollageFromCandidates's frameTimeoutMs), so they fail fast
//    rather than each independently spending up to their own default
//    ~5s regardless of how much budget remains.
//
// 2. UNBOUNDED TDX USAGE. The first version's shared metadata cache
//    fell back to calling TDX itself on a cache miss — meaning the real
//    broadcast path could, in principle, add TDX CCTV metadata calls on
//    top of the already-budgeted RoadEvent schedule. Fixed: this module
//    is now CACHE-ONLY for metadata (see getFreewayCctvMetadata below) —
//    it NEVER calls TDX, enforced structurally by this file importing
//    nothing TDX-related at all (no tdx/auth.js, no tdx/client.js). A
//    cache miss/expiry is just another fail-closed reason
//    ('metadata-cache-unavailable') → text-only. The cache is instead
//    populated as a side effect of tdx/hsinchuCctvProbe.js's existing
//    Admin-Auth-gated one-time probe (which already makes its own,
//    separately-budgeted TDX call) — see
//    cctv/freewayCctvMetadataCache.js's module comment for the full
//    read/write split and why it's a separate module (avoids a circular
//    import between this file and hsinchuCctvProbe.js).
//
// 3. PER-EVENT BUDGET ACCUMULATING ACROSS A RUN. Round 2's fix above
//    bounded ONE event's CCTV prep to CCTV_PREPARE_BUDGET_MS — but
//    broadcastPipeline.js's per-event loop is sequential, so N eligible
//    accidents in the same Cron tick, each independently given a fresh
//    ~4s, could still accumulate to N*4s of possible delay before the
//    LAST event's text even gets considered. CCTV_PREPARE_BUDGET_MS is
//    now explicitly documented (see its own comment) as a PER-CALL
//    budget, and it's broadcastPipeline.js's job to compute ONE deadline
//    for the WHOLE run and pass each event only what's left of it —
//    this file has no concept of "the whole run" on its own. Also added
//    this round: withTimeout() actually clearTimeout()s the winning
//    side instead of leaving a bare Promise.race's loser's timer
//    dangling, and a deadline re-check immediately before the R2 publish
//    (the one truly expensive, side-effecting step) so a call that's
//    already blown its budget by the time it GETS to publishing doesn't
//    bother writing an object nothing will ever reference.


import {
  TARGET_ROAD_ID,
  TARGET_ROAD_NAME_PATTERN,
  selectFourQuadrantCandidates,
  selectSingleShoulderCandidate,
  composeCollageFromCandidates,
  buildCollageHeaderLines,
  extractFirstJpegFrame,
} from '../tdx/hsinchuCctvProbe.js';
import { resolveRoadKey, parseKM } from '../traffic/roadSectionLabel.js';
import { publishCollageImage } from './publishedImage.js';
import { readFreewayCctvMetadataCache } from './freewayCctvMetadataCache.js';

// See module comment: 國道一號 only, using the SAME Production-confirmed
// roadId/roadNamePattern hsinchuCctvProbe.js has used since V1.7 — no
// second, independently-guessed copy of these values.
const CCTV_SUPPORTED_ROADS = {
  國道一號: { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, shortName: '國1' },
};

// Hard time budget for ONE prepareCctvImageForEvent call — from "start
// preparing" to "have an imageUrl (or give up)". Exceeding this is
// treated exactly like any other CCTV failure: text-only, this same
// tick, never a delay carried into the next Cron run.
//
// CORRECTION (post-review): this is a PER-CALL budget, not an implicit
// "every event gets its own fresh 4s" — broadcastPipeline.js is
// sequential (one event's push loop finishes before the next event's
// CCTV prep even starts), so if this module's default were applied
// fresh to every event, N eligible accidents in one Cron tick could
// each independently spend up to CCTV_PREPARE_BUDGET_MS, accumulating
// to N*4s of possible delay before the LAST event's text even gets
// considered — exactly the "later accidents get delayed by earlier
// ones' slow CCTV" bug this correction fixes. broadcastPipeline.js is
// the one responsible for turning this per-call parameter into a
// whole-run guarantee: it computes ONE deadline
// (Date.now() + CCTV_PREPARE_BUDGET_MS, or the TEST-ONLY
// cctvPrepareBudgetMs override) ONCE before its per-event loop starts,
// and passes each event whatever's LEFT of that shared deadline as
// THIS function's budgetMs — see that module's own comment. This
// function itself has no concept of "the whole run"; it only ever
// bounds the one call it was given.
export const CCTV_PREPARE_BUDGET_MS = 4000;

// Never let a per-frame fetch timeout collapse to (near-)zero even if
// almost the whole budget is already spent by the time frame-fetching
// starts — a floor this small still fails fast and safely (straight
// into the existing 'no-frames'/partial-frame handling), it just avoids
// a degenerate 0ms AbortSignal.timeout.
const MIN_FRAME_TIMEOUT_MS = 300;

/**
 * Races `promise` against a `ms` timer, resolving to whichever settles
 * first — but, unlike a bare Promise.race, actually clearTimeout()s the
 * loser: if `promise` wins, the pending timer is cancelled instead of
 * being left to fire uselessly later (this matters here specifically
 * because dozens of these can run across a single Cron tick's several
 * accidents; a cancelled timer is one less thing lingering). If the
 * timer wins, `promise`'s eventual result (whenever it arrives) is
 * simply discarded by the caller — see prepareCctvImageForEvent's own
 * comment on why that's safe.
 *
 * Deliberately does NOT call .unref() on the timer — it must be allowed
 * to actually fire and keep whatever's awaiting it alive until it does;
 * unref'ing it previously let Node exit/move on before the timer ever
 * ran under `node --test`, silently "resolving" nothing (a real bug
 * caught and fixed in an earlier round of this same file).
 */
function withTimeout(promise, ms, timeoutValue) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, ms);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

// Fallback only — the real value should come from env.PUBLIC_BASE_URL
// (see wrangler.jsonc's `vars`). Kept here so a missing/misconfigured
// var degrades to the known real Production hostname rather than
// producing a broken/relative image URL. NOT a secret — this is the
// Worker's own public HTTPS origin, the same one LINE image messages
// already need to fetch from with no credential at all.
const FALLBACK_PUBLIC_BASE_URL = 'https://traffic-reporter.mr-happytan.workers.dev';

function publicImageUrl(env, id) {
  const base = String(env.PUBLIC_BASE_URL || FALLBACK_PUBLIC_BASE_URL).replace(/\/+$/, '');
  return `${base}/cctv/image/${id}`;
}

/**
 * A single representative KM point for the four-quadrant search: the
 * midpoint of startKM/endKM when both are present (an accident's
 * reported extent), otherwise whichever single one parses. Deliberately
 * NEVER reads `description`/free text for a KM guess ("禁止從
 * description 自由猜 KM") — only the same structured startKM/endKM
 * fields tdx/normalize.js already populates from TDX's own StartKM/
 * EndKM (already TDX-formatted "NNK+NNN" strings — see that module's
 * comment), parsed by the same tested parseKM this whole app already
 * relies on. Returns null (never a guess) when neither is usable.
 */
function eventTargetKm(event) {
  const start = parseKM(event.startKM);
  const end = parseKM(event.endKM);
  if (start !== null && end !== null) return (start + end) / 2;
  return start ?? end;
}

// V1.8.7.0 — true for an event that carries a real dynamic-shoulder
// classification (see dynamicShoulderClassification.js) — checked
// alongside `type === 'accident'` below so this module gains a SECOND
// CCTV-eligible event category without altering what "eligible" means
// for an accident at all. `event.dynamicShoulder` is only ever present
// when tdx/normalize.js's detectDynamicShoulder actually found real text
// evidence — see that module's own comment.
function isDynamicShoulderEvent(event) {
  return Boolean(event && event.dynamicShoulder && event.dynamicShoulder.state);
}

/**
 * Pure, synchronous, ZERO I/O — decides whether `event` is even a
 * candidate for CCTV enrichment, and if so, resolves the exact
 * road/KM target to search around. Safe to call from a dry-run/debug
 * path for a pure eligibility count (see broadcastPipeline.js's
 * cctvEligibleAccidentCount) without triggering any network activity.
 *
 * V1.8.7.0 — now covers TWO event categories, distinguished by
 * `imageStrategy` on the returned eligibility object:
 *   - accident            -> imageStrategy:'quad'   (unchanged behavior —
 *     see prepareCctvImageWork / the original 4-quadrant collage)
 *   - dynamic-shoulder     -> imageStrategy:'single' (see
 *     prepareSingleCctvImageWork below) — one representative camera for
 *     the event's own KM RANGE, never a 2x2 collage. `reason:
 *     'not-accident'` is deliberately UNCHANGED wording for "neither
 *     category" — existing callers/tests that check this exact string
 *     for a plain construction/closure/etc event keep working unchanged.
 *
 * @param {object} event
 * @returns {{eligible:true, imageStrategy:'quad', roadKey:string, roadId:string,
 *     roadNamePattern:RegExp, roadShortName:string, targetKm:number}
 *   |{eligible:true, imageStrategy:'single', roadKey:string, roadId:string,
 *     roadNamePattern:RegExp, roadShortName:string, direction:string,
 *     startKm:number|null, endKm:number|null, targetKm:number}
 *   |{eligible:false, reason:'not-accident'|'not-freeway-source'|'unresolvable-road'|'unsupported-road'|'no-reliable-km'}}
 */
export function resolveCctvEligibility(event) {
  const isAccident = Boolean(event && event.type === 'accident');
  const isDynamicShoulder = isDynamicShoulderEvent(event);
  if (!isAccident && !isDynamicShoulder) return { eligible: false, reason: 'not-accident' };

  // V1.8.5 V1: only TDX Freeway-sourced events (see tdx/sources.js —
  // source:'freeway' is the confirmed 國道 RoadEvent feed). Never PBS,
  // never 'highway' (省道) — those don't have a confirmed CCTV road
  // mapping in this round's registry either way, but gating on source
  // here keeps the reason distinct/observable from "road not supported."
  // Applies equally to accident and dynamic-shoulder — TDX's own dynamic
  // shoulder mechanism is itself a Freeway (國道) feature, so this was
  // never expected to need loosening for the new category.
  if (event.source !== 'freeway') return { eligible: false, reason: 'not-freeway-source' };

  const roadKey = resolveRoadKey(event.road);
  if (!roadKey) return { eligible: false, reason: 'unresolvable-road' };

  const supported = CCTV_SUPPORTED_ROADS[roadKey];
  if (!supported) return { eligible: false, reason: 'unsupported-road' };

  if (isDynamicShoulder) {
    const startKm = parseKM(event.startKM);
    const endKm = parseKM(event.endKM);
    if (startKm === null && endKm === null) return { eligible: false, reason: 'no-reliable-km' };
    const targetKm = startKm !== null && endKm !== null ? (startKm + endKm) / 2 : startKm ?? endKm;
    return {
      eligible: true,
      imageStrategy: 'single',
      roadKey,
      roadId: supported.roadId,
      roadNamePattern: supported.roadNamePattern,
      roadShortName: supported.shortName,
      direction: event.direction,
      startKm,
      endKm,
      targetKm,
    };
  }

  const targetKm = eventTargetKm(event);
  if (targetKm === null) return { eligible: false, reason: 'no-reliable-km' };

  return {
    eligible: true,
    imageStrategy: 'quad',
    roadKey,
    roadId: supported.roadId,
    roadNamePattern: supported.roadNamePattern,
    roadShortName: supported.shortName,
    targetKm,
  };
}

/**
 * CACHE-ONLY — see this module's correction note above. NEVER calls
 * TDX; a cache miss/expiry/corrupt entry is simply
 * {ok:false, reason:'metadata-cache-unavailable'}, the same as any other
 * CCTV failure (→ text-only). The cache itself is populated elsewhere —
 * see cctv/freewayCctvMetadataCache.js's module comment.
 */
async function readFreewayMetadataCacheOnly(env) {
  const records = await readFreewayCctvMetadataCache(env.TRAFFIC_KV);
  if (!records) return { ok: false, reason: 'metadata-cache-unavailable' };
  return { ok: true, records };
}

/**
 * Cache-only, and IN-FLIGHT-PROMISE-MEMOIZED via `runCache`, a plain
 * object the CALLER creates ONCE per Cron run and threads through every
 * accident this tick (see broadcastPipeline.js). This keeps N accidents
 * this tick down to at most 1 KV read for metadata, never N: the FIRST
 * accident to need metadata this run kicks off
 * readFreewayMetadataCacheOnly and stores the still-pending Promise on
 * runCache.metadataPromise; every subsequent accident this SAME tick
 * awaits that identical Promise instead of reading KV again. `runCache`
 * is deliberately NOT module-level/global state — a request-scoped
 * object avoids any cross-invocation staleness/concurrency concern
 * module-level mutable state would raise.
 */
function getFreewayCctvMetadata(env, runCache) {
  if (!runCache.metadataPromise) {
    runCache.metadataPromise = readFreewayMetadataCacheOnly(env);
  }
  return runCache.metadataPromise;
}

/** The actual (potentially slow) work — see prepareCctvImageForEvent, which races this against CCTV_PREPARE_BUDGET_MS. */
async function prepareCctvImageWork(env, eligibility, runCache, codecOverride, deadlineAt) {
  const metadata = await getFreewayCctvMetadata(env, runCache);
  if (!metadata.ok) return { ok: false, reason: metadata.reason };

  const candidates = selectFourQuadrantCandidates(metadata.records, {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    targetKm: eligibility.targetKm,
  });
  if (candidates.every((c) => c === null)) return { ok: false, reason: 'no-camera' };

  const headerLines = buildCollageHeaderLines(new Date(), {
    roadShortName: eligibility.roadShortName,
    targetKm: eligibility.targetKm,
  });

  // Give each (parallel) frame fetch whatever's left of the overall
  // budget, not always the full default — see module comment.
  const frameTimeoutMs = Math.max(MIN_FRAME_TIMEOUT_MS, deadlineAt - Date.now());
  const composed = await composeCollageFromCandidates(candidates, headerLines, {
    targetKm: eligibility.targetKm,
    codecOverride,
    frameTimeoutMs,
  });
  if (!composed.ok) return { ok: false, reason: composed.reason }; // 'no-frames' — all 4 frame fetch/decode attempts failed

  // Re-check the deadline right before the expensive, side-effecting R2
  // write — per correction: if we're already past the deadline (the
  // race in prepareCctvImageForEvent may not have "noticed" yet, since
  // that timer and this check are independent), don't bother creating a
  // new R2 object at all. The outer race would discard this result
  // either way, but this avoids the wasted write outright rather than
  // relying solely on the caller's race to make it moot.
  if (Date.now() >= deadlineAt) return { ok: false, reason: 'prepare-timeout' };

  const published = await publishCollageImage(env.CCTV_IMAGES, composed.bytes);
  if (!published.ok) return { ok: false, reason: 'r2-publish-failed' };

  // V57: imageExpiresAt comes straight from the R2 object's own
  // customMetadata (publishedImage.js), never recomputed here — a
  // recomputed value would drift LATER than the real expiry and could
  // hand a consumer a URL that stops resolving mid-delivery.
  return { ok: true, imageUrl: publicImageUrl(env, published.id), imageExpiresAt: published.expiresAt };
}

/**
 * V1.8.7.0 — Dynamic Shoulder single-camera CCTV work. Deliberately a
 * SEPARATE, much cheaper path from prepareCctvImageWork (quad) above —
 * see this module's own performance requirement: only 1 frame fetch, NO
 * 2x2 collage composition, and — the biggest saving — NO JPEG
 * decode/encode round-trip at all. A single already-JPEG-encoded frame
 * from freeway.gov.tw is published to R2 EXACTLY as fetched (raw bytes,
 * unchanged), the same way an accident's composed collage bytes are
 * published, just skipping the decode/re-encode/compose step entirely
 * since there is nothing to compose — one frame IS the final image.
 * Camera SELECTION still reuses the shared eligible-CCTV-pool builder
 * (selectSingleShoulderCandidate, see hsinchuCctvProbe.js) — never a
 * second metadata-filtering pass — and frame fetching still reuses the
 * SAME extractFirstJpegFrame this module's quad path uses (identical
 * trusted-hostname check, size cap, and per-fetch timeout handling) — no
 * second CCTV frame-fetch pipeline was built for this ("不要為 dynamic
 * shoulder 建第二套 CCTV pipeline").
 */
async function prepareSingleCctvImageWork(env, eligibility, runCache, deadlineAt) {
  const metadata = await getFreewayCctvMetadata(env, runCache);
  if (!metadata.ok) return { ok: false, reason: metadata.reason };

  const candidate = selectSingleShoulderCandidate(metadata.records, {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: eligibility.direction,
    startKm: eligibility.startKm,
    endKm: eligibility.endKm,
  });
  if (!candidate) return { ok: false, reason: 'no-camera' };

  const frameTimeoutMs = Math.max(MIN_FRAME_TIMEOUT_MS, deadlineAt - Date.now());
  const frame = await extractFirstJpegFrame(candidate.videoStreamUrl, { timeoutMs: frameTimeoutMs });
  if (!frame.ok) return { ok: false, reason: 'no-frames' }; // same reason as the quad path's own "every fetch failed" outcome

  // Same pre-publish deadline re-check as the quad path — see
  // prepareCctvImageWork's own comment for why this matters (avoid a
  // wasted R2 write for a result the outer race is about to discard
  // anyway).
  if (Date.now() >= deadlineAt) return { ok: false, reason: 'prepare-timeout' };

  const published = await publishCollageImage(env.CCTV_IMAGES, frame.bytes);
  if (!published.ok) return { ok: false, reason: 'r2-publish-failed' };

  return {
    ok: true,
    imageUrl: publicImageUrl(env, published.id),
    imageExpiresAt: published.expiresAt,
    // V1.8.7.0 — Pipeline Trace wants a MINIMAL camera reference (never
    // the full raw CCTV payload — see pipelineTrace.js's own whitelist
    // discipline): the device id plus its own KM, nothing else.
    selectedCamera: `${candidate.cctvId}@${candidate.locationMile}`,
  };
}

// V1.8.7.1 — root cause of "only the first dynamic-shoulder event this
// tick ever gets a CCTV image" (real Production evidence: 3 shoulder
// events one Cron tick, only the first got imagePrepared:true, the other
// two both read cctvSkippedByReason:'run-budget-exhausted'):
// prepareCctvImageForEvent's `budgetMs` parameter used to be computed
// EXCLUSIVELY from broadcastPipeline.js's own `cctvRunDeadlineAt` — ONE
// absolute deadline anchored once before the whole per-event loop starts
// and shared, sequentially, by every CCTV-eligible event in the run
// (quad AND single alike). Whichever event reached the CCTV block FIRST
// got however long its own real processing took out of that shared
// clock; every LATER event only ever got "whatever's left" — which, for
// a genuinely busy tick, is frequently at or below zero by the time a
// second or third event's turn comes, even though a single frame fetch
// is individually cheap and would easily have fit in its own small
// budget. This was never a TDX/PBS/classification/KM-resolver/LINE/
// Shared-Feed problem — Production's own Pipeline Trace already showed
// all three events fully classified, range-resolved, LINE-pushed, and
// CCTV-eligible; only the shared-clock CCTV budget allocation was wrong.
//
// FIX — single-strategy events stop sharing ANY clock with quad/
// accidents, and stop sharing a "whatever's left" clock with each
// OTHER: every eligible single event gets its OWN fixed, fresh
// SINGLE_CCTV_PER_EVENT_BUDGET_MS budget, anchored at THAT event's own
// turn (never inherited from an earlier event's elapsed time) — see
// prepareSingleCctvImageForEvent below. This is deliberately the
// simplest fix in the space the task laid out ("per-event single budget
// + global cap") — no queue, no dynamic re-allocation, no second CCTV
// pipeline: `prepareCctvImageForEvent`'s existing `withTimeout` race
// (already used by the quad path) is reused unchanged, just given a
// smaller, per-event-fresh budget instead of the shared run-wide one.
//
// A per-event budget alone would still let an unbounded NUMBER of
// single events add up to an unbounded total delay in one tick ("不能讓
// 無限多事件拖垮 Worker") — bounded instead by MAX_SINGLE_CCTV_EVENTS_PER_RUN,
// a hard cap on how many single-strategy events get ANY CCTV attempt
// per run, tracked on the SAME per-run `runCache` object every call
// already shares (see getFreewayCctvMetadata's own memoization above —
// same object, same "created once per Cron tick" lifecycle, both the
// main push loop AND the Shared-Feed-only top-up pass share this SAME
// object across ONE runLineBroadcast call, so the cap is correctly
// enforced against the WHOLE run's single-event total, not per-phase).
// Worst-case added wall-clock time this round's CCTV work can ever cost
// a tick is therefore a fixed, known bound:
// MAX_SINGLE_CCTV_EVENTS_PER_RUN * SINGLE_CCTV_PER_EVENT_BUDGET_MS —
// still a hard ceiling, just a larger (and now genuinely FAIR) one than
// the old single shared 4s window.
//
// Beyond the cap, an event gets `{ok:false, reason:'single-event-cap-
// reached'}` — deliberately a DIFFERENT reason string from
// 'prepare-timeout' (this per-event budget's own expiry) so an
// administrator reading Pipeline Trace can always tell "we deliberately
// stopped after N events this run" apart from "this specific event's
// own frame fetch/publish genuinely ran out of time" — see
// PRODUCT_DECISIONS.md for why 'prepare-timeout' (an existing reason
// string) was reused for the latter rather than inventing a third,
// redundant one.
//
// Numbers chosen conservatively, not tuned to exactly match Production's
// 3-event evidence: SINGLE_CCTV_PER_EVENT_BUDGET_MS (1500ms) is ample
// for one MJPEG frame capture + one small R2 PUT (a single frame fetch
// alone already has its own MIN_FRAME_TIMEOUT_MS/FRAME_TIMEOUT_MS floor/
// ceiling elsewhere in this pipeline — 1500ms sits comfortably inside
// that). MAX_SINGLE_CCTV_EVENTS_PER_RUN (5) comfortably covers real
// Production's own 3-event evidence with headroom for a busier day,
// while keeping the worst-case total (7.5s) a small, bounded addition
// next to this pipeline's own pre-existing accepted quad budget (4s) —
// see PRODUCT_DECISIONS.md for the full reasoning, including why quad's
// OWN budget window is deliberately kept on a completely SEPARATE clock
// (broadcastPipeline.js's own `cctvRunDeadlineAt`, now lazily anchored
// to the first accident this run actually reaches — see that file) so
// neither strategy can silently shrink the other's nominal allotment.
export const SINGLE_CCTV_PER_EVENT_BUDGET_MS = 1500;
export const MAX_SINGLE_CCTV_EVENTS_PER_RUN = 5;

/**
 * Wraps prepareSingleCctvImageWork with this event's OWN independent
 * budget + the per-run cap — see the module comment above for the full
 * fairness design. `runCache.singleEventsAttempted` is a plain counter
 * (not a Promise, unlike `runCache.metadataPromise`) — incremented
 * BEFORE the async work starts so two events awaited concurrently (never
 * actually happens today, this loop is sequential, but this is the
 * correct behavior either way) could never both slip in under the cap by
 * racing a stale read.
 *
 * @param {{budgetMs?:number, cap?:number}} [overrides] - TEST-ONLY (see
 *   e.g. broadcastPipeline.js's own `cctvPrepareBudgetMs` precedent) —
 *   lets a test exercise the timeout/cap boundaries in milliseconds
 *   instead of really waiting SINGLE_CCTV_PER_EVENT_BUDGET_MS, or with a
 *   cap smaller than MAX_SINGLE_CCTV_EVENTS_PER_RUN. Production
 *   (scheduled.js) never passes this — both default to the real module
 *   constants.
 */
async function prepareSingleCctvImageForEvent(env, eligibility, runCache, { budgetMs = SINGLE_CCTV_PER_EVENT_BUDGET_MS, cap = MAX_SINGLE_CCTV_EVENTS_PER_RUN } = {}) {
  const attemptedSoFar = runCache.singleEventsAttempted || 0;
  const slotIndex = attemptedSoFar + 1; // 1-based — this event's own attempt number this run, win or lose
  if (attemptedSoFar >= cap) {
    return { ok: false, reason: 'single-event-cap-reached', singleSlotIndex: slotIndex, singleSlotLimit: cap };
  }
  runCache.singleEventsAttempted = slotIndex;

  const deadlineAt = Date.now() + budgetMs;
  const work = prepareSingleCctvImageWork(env, eligibility, runCache, deadlineAt).catch(() => ({ ok: false, reason: 'prepare-error' }));
  // Same withTimeout race the quad path already uses — a slow frame
  // fetch/R2 publish for THIS event resolves 'prepare-timeout' at THIS
  // event's own budget boundary, never borrowing time from (or lending
  // time to) any other event this run.
  const result = await withTimeout(work, budgetMs, { ok: false, reason: 'prepare-timeout' });
  return { ...result, singleSlotIndex: slotIndex, singleSlotLimit: cap };
}

/**
 * Orchestrates the FULL dynamic CCTV pipeline for one accident event:
 * eligibility -> shared metadata (cache-only, memoized this run) ->
 * four-quadrant select (same ratified algorithm, this event's own
 * road/KM) -> fetch up to 4 frames + compose (same collage renderer) ->
 * publish to R2 — ALL bounded by a hard `budgetMs` time budget (see
 * CCTV_PREPARE_BUDGET_MS's doc comment: this is a PER-CALL budget: the
 * CALLER — broadcastPipeline.js — is responsible for turning it into a
 * whole-Cron-run guarantee by passing each event whatever's left of one
 * shared deadline, not a fresh budget every time). Called AT MOST ONCE
 * per accident event by broadcastPipeline.js (before that event's
 * per-target push loop) — the resulting imageUrl is then shared across
 * every pending target for that event; see this module's own doc note
 * in broadcastPipeline.js for why that's structurally guaranteed, not
 * just convention.
 *
 * @param {object} env
 * @param {object} event
 * @param {{metadataPromise?: Promise}} runCache - shared across this
 *   Cron run's accidents; see getFreewayCctvMetadata above.
 * @param {{decodeJpeg,encodeJpeg}} [codecOverride] - TEST-ONLY, threaded
 *   through to composeCollageFromCandidates — see that function's doc
 *   comment.
 * @param {number} [budgetMs] - how many ms THIS call gets, for the QUAD
 *   (accident) path only (defaults to the full CCTV_PREPARE_BUDGET_MS for
 *   a standalone call, e.g. in tests calling this function directly;
 *   broadcastPipeline.js always passes the run's REMAINING quad budget
 *   explicitly). <= 0 short-circuits immediately to
 *   'run-budget-exhausted' without starting any work — this is the same
 *   reason broadcastPipeline.js itself checks for before ever calling
 *   in, kept here too as a defensive floor.
 *
 *   V1.8.7.1 — this parameter is IGNORED for a `single` (dynamic-
 *   shoulder) event: see prepareSingleCctvImageForEvent's own comment for
 *   why single-strategy events use their own independent per-event
 *   budget + a per-run cap instead of a caller-supplied shared deadline
 *   (the root cause this round fixes — the old code passed the SAME
 *   shared-deadline-derived `budgetMs` to both strategies, which is
 *   exactly why a 2nd/3rd dynamic-shoulder event in one Cron tick used to
 *   read `run-budget-exhausted` before ever attempting a frame fetch).
 * @returns {Promise<{ok:true, imageUrl:string, imageExpiresAt:string}|{ok:false, reason:string}>}
 */
export async function prepareCctvImageForEvent(
  env,
  event,
  runCache,
  codecOverride,
  budgetMs = CCTV_PREPARE_BUDGET_MS,
  singleBudgetOverrides = {} // TEST-ONLY, single-strategy only — see prepareSingleCctvImageForEvent's own doc comment
) {
  const eligibility = resolveCctvEligibility(event);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };

  if (env.CCTV_IMAGES === undefined) return { ok: false, reason: 'no-r2-binding' };

  // V1.8.7.1 — strategy dispatch, decided ONCE by resolveCctvEligibility
  // above (never re-decided here). `single` (dynamic-shoulder) branches
  // off completely here, into its own independent per-event-budget +
  // per-run-cap wrapper — see that function's own comment for the full
  // fairness design and why this is no longer a shared-deadline
  // computation at all. `quad` (accident) keeps its EXACT pre-existing
  // shared-run-deadline behavior below, byte-for-byte unchanged — this
  // round never touches how an accident's own budget is computed
  // ("事故 quad 的現有保護機制不能被破壞").
  if (eligibility.imageStrategy === 'single') {
    return prepareSingleCctvImageForEvent(env, eligibility, runCache, singleBudgetOverrides);
  }

  if (budgetMs <= 0) return { ok: false, reason: 'run-budget-exhausted' };

  const deadlineAt = Date.now() + budgetMs;
  const work = prepareCctvImageWork(env, eligibility, runCache, codecOverride, deadlineAt).catch(() => ({
    ok: false,
    reason: 'prepare-error',
  }));

  // A timeout is NOT a LINE failure and is NEVER carried into the next
  // Cron run — losing this race just means text-only THIS tick. The
  // losing side (`work`, if the timer wins) keeps running in the
  // background rather than being forcibly aborted; its eventual result
  // (e.g. a late R2 publish, though the pre-publish deadline re-check
  // above makes that increasingly unlikely) is simply discarded —
  // harmless, since nothing ever hands that URL to a caller once the
  // race is lost. withTimeout (unlike a bare Promise.race) also cancels
  // the timer if `work` wins first, so a fast success doesn't leave a
  // stray timer running.
  return withTimeout(work, budgetMs, { ok: false, reason: 'prepare-timeout' });
}
