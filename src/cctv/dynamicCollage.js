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
// CCTV_SUPPORTED_ROADS (below) is a registry — every entry's CCTV RoadID/
// RoadName pattern must be independently confirmed against a real
// Production TDX CCTV/Freeway response before being added; never guessed
// from "the numbering probably follows the same scheme." An accident on
// any other, still-unconfirmed road — or one whose road text doesn't
// even resolve via resolveRoadKey at all — falls through to text-only.
// 國道一號's entry ('000010') was confirmed this way in V1.7; 國道三號's
// entry ('000030') was confirmed this way in V1.8.7.5 (see below).
//
// V1.8.7.4 — 國3 support audit (real Production evidence: 國3 南向
// 102K+100～103K+070 dynamic-shoulder event had no image, reason
// 'unsupported-road' — motivated a full audit of whether 國3 CCTV
// metadata already exists somewhere in this codebase before assuming the
// program, not the road, is what's missing). That round's CONCLUSION was
// that no real, Production-confirmed CCTV RoadID/RoadName for 國道三號
// existed anywhere THIS CODEBASE could reach from its own dev sandbox —
// TDX network egress is blocked here, and that round was explicitly
// instructed not to make any upstream call — so 國3 was deliberately NOT
// added at that time (see git history / PROJECT_HANDOFF.md §31 for that
// round's own full writeup, including the confirmed fact that this
// module's metadata cache already stores the FULL unfiltered nationwide
// Freeway CCTV response, not just 國1's — meaning a real Production run
// of the admin probe was always going to already hold 國3's real records
// too, this codebase just couldn't read them from here).
//
// V1.8.7.5 — the gap V1.8.7.4 identified was closed by a separate,
// explicitly read-only inspection of Production's real TRAFFIC_KV
// `cctv:freeway-metadata:v1` cache (not made from this session's own dev
// sandbox — no TDX call, no admin probe triggered, no frame fetch; see
// PROJECT_HANDOFF.md §32 for the full provenance of this confirmation).
// That inspection confirmed, from REAL cached Production data (706 國3
// records, fetched 2026-08-18): RoadID `'000030'`, RoadName `'國道3號'`
// (arabic numeral, not `國道三號`) — now the confirmed values below. It
// also surfaced a real, small amount of dirty data worth recording here:
// a handful of records carry a RoadID that disagrees with their own
// RoadName (e.g. RoadID:'000030' paired with RoadName:'國道1號', or the
// reverse) — see tdx/hsinchuCctvProbe.js's `isTargetRoad` (V1.8.7.5) for
// the general (not road-specific) fix: RoadID is now authoritative
// whenever present, closing the real cross-road-contamination risk this
// created now that the registry covers more than one road.
//
// Fail-closed, at every single stage, per instruction: no reliable KM,
// an unsupported/unresolvable road, a missing CCTV_IMAGES/TRAFFIC_KV
// binding, an unavailable metadata cache, zero matching cameras, all 4
// frame fetches failing, a JPEG decode/compose failure, an R2 publish
// failure, a failed post-publish R2 read-back (see
// 'r2-readback-failed' below), OR exceeding the hard time budget (see
// CCTV_PREPARE_BUDGET_MS below) are ALL just "this accident doesn't get
// a CCTV image this tick" — never a reason to withhold the accident text
// itself, never a reason to mark the event failed, never a retry-with-
// delay. See broadcastPipeline.js for how a {ok:false} result here maps
// to a plain text-only LINE push, functionally identical to V1.8.4-and-
// earlier's only-ever-text behavior.
//
// 2026-08-31 — CCTV_R2_READBACK_VERIFY_BEFORE_LINE. A prior read-only
// audit (CCTV_IMAGE_READY_BEFORE_LINE_PUSH_AUDIT) confirmed this
// module's own await chain was already safe end-to-end — R2 put is
// fully awaited, the public URL is only ever built from a resolved
// publish, and the LINE push happens strictly after — so a real-world
// broken-image report could NOT be conclusively explained by an
// application-level race. Rather than continue open-ended forensics
// into LINE's own remote-fetch behavior (outside this codebase's
// visibility), this round adds one deterministic guarantee this
// codebase CAN own: after publishCollageImage() succeeds, the exact
// object just written is read back internally (R2 GET, never an HTTP
// call to this Worker's own public endpoint — see
// publishedImage.js#verifyPublishedImageReadable) and confirmed
// non-empty with Content-Type image/jpeg BEFORE imageUrl is ever
// returned to a caller. A failed read-back is 'r2-readback-failed' —
// exactly the same fail-closed, text-only-this-tick treatment as every
// other reason above, never a retry, never a second publish attempt.
// This does not change WHY an image might still, rarely, fail to render
// on LINE's own side (e.g. the pre-existing 15-minute published-image
// TTL — see 07_KNOWN_ISSUES.md — is a separate, explicitly out-of-scope
// concern this round does not touch); it only guarantees this codebase
// never hands LINE a URL for an object that isn't verifiably readable
// the moment it was published.
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
import { publishCollageImage, verifyPublishedImageReadable } from './publishedImage.js';
import { readFreewayCctvMetadataCache } from './freewayCctvMetadataCache.js';
import { isCctvImageEnabled } from '../traffic/sourceMode.js';

// See module comment: 國道一號 only, using the SAME Production-confirmed
// roadId/roadNamePattern hsinchuCctvProbe.js has used since V1.7 — no
// second, independently-guessed copy of these values.
// 2026-08-25 — see resolveCctvEligibility's own comment. Sources whose
// normalizer produces BOTH a canonical road name (roadSectionLabel.js's
// resolveRoadKey understands it) and a kilometre that came from a strict,
// already-shipped parser — never a free-text guess. Deliberately a
// positive allowlist so a future source is opted IN on purpose rather
// than inheriting camera access by default.
const CCTV_TRUSTED_EVENT_SOURCES = new Set(['freeway', 'highway', 'pbs']);

const CCTV_SUPPORTED_ROADS = {
  國道一號: { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, shortName: '國1' },
  // V1.8.7.5 — roadId/roadNamePattern confirmed from real Production
  // TRAFFIC_KV cctv:freeway-metadata:v1 data (706 real 國3 records, see
  // this module's own comment above for the full provenance) — not
  // guessed. RoadName is the arabic-numeral form '國道3號' in real
  // records; '國道三號' is kept in the pattern purely for symmetry with
  // 國1's own OR-pattern and as a defensive fallback, same idiom already
  // used there, even though no real 國3 record has been observed using
  // the Chinese-numeral spelling in RoadName.
  國道三號: { roadId: '000030', roadNamePattern: /國道3號|國道三號/, shortName: '國3' },
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
// Target kilometre for the accident (quad) path, in strict order of
// authority. Tiers 1-2 are unchanged: the source's own structured KM,
// midpointed when it is a range.
//
// 2026-08-25 — tier 3 (`displayKM`) is new, and is what lets a PBS 國道
// accident reach a camera at all: PBS records carry NO structured KM (see
// pbs/normalize.js's module comment — road/areaNm/direction/roadtype/
// comment/dates/x1/y1 is the entire raw shape), so tiers 1-2 are always
// empty for them and every PBS accident used to stop at 'no-reliable-km'.
//
// This is NOT a new parser and NOT a guess. `displayKM` is only ever set
// by pbs/normalize.js's extractDisplayKmMatch, which is deliberately
// strict — a bare number in unrelated text ("2車事故、3人受傷") can never
// become one; it requires an explicit "96.7公里" / "96K+700" / "96K" form.
// The same value has already been through traffic/locationQuality.js as
// this event's proof that it is placeable enough to broadcast at all, so
// by the time CCTV asks, a human has effectively already been told where
// the accident is. Reading anything ELSE out of the description here —
// a looser regex, a road-name heuristic — remains forbidden.
function eventTargetKm(event) {
  const start = parseKM(event.startKM);
  const end = parseKM(event.endKM);
  if (start !== null && end !== null) return (start + end) / 2;
  if (start !== null || end !== null) return start ?? end;
  return typeof event.displayKM === 'number' && Number.isFinite(event.displayKM) ? event.displayKM : null;
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

  // 2026-08-25 — WAS `event.source !== 'freeway'`, i.e. TDX-Freeway-only.
  //
  // That was written in V1.8.5 when TDX WAS the 國道 feed, and it silently
  // became wrong the moment TRAFFIC_SOURCE_MODE=PBS_ONLY turned TDX off:
  // a real 國3 南向 96K+700 accident on 2026-08-25 passed the service-area
  // gate, the accident policy and the location-quality gate, was pushed to
  // LINE with correct text — and lost its CCTV image here, at the very
  // first CCTV check, for no reason other than "PBS reported it". The
  // cameras it would have used are the same cameras, on the same road, at
  // the same kilometre.
  //
  // CCTV eligibility is now decided by whether the DATA is trustworthy —
  // a resolvable road that is in the confirmed registry, plus a reliable
  // target kilometre — not by which feed happened to report the incident.
  // Both of those are checked immediately below, and both still fail
  // closed.
  //
  // Still an allowlist, not an open door: only the three road-incident
  // feeds whose normalizers produce a canonical road name and a
  // parser-validated kilometre are admitted. A bus/CMS record has neither,
  // and must never reach a camera lookup on the strength of the word
  // "accident" alone. 'highway' (省道 TDX) is listed for symmetry — it can
  // never actually pass, because no 省道 is in CCTV_SUPPORTED_ROADS, and
  // it will correctly stop at 'unsupported-road' rather than here.
  if (!CCTV_TRUSTED_EVENT_SOURCES.has(event.source)) return { eligible: false, reason: 'unsupported-source' };

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

// V1.9.0 (root-cause forensics, 國3 96K+700 2026-08-26 — see
// test/cctvQuadPrepareForensics.test.js for the full writeup) — pulls
// only the plain-number/string fields off a stageTracker, never
// anything else that might get attached to it. This is the ONLY place
// that decides what "the trace" is allowed to contain, so a future
// field added to stageTracker can never leak something unintended by
// accident.
function snapshotStageTiming(stageTracker) {
  if (!stageTracker) return {};
  const {
    metadataElapsedMs,
    cameraSelectionElapsedMs,
    frameFetchElapsedMs,
    collageElapsedMs,
    successfulFrameCount,
    failedFrameCount,
    r2PublishElapsedMs,
    r2ReadbackElapsedMs,
  } = stageTracker;
  return {
    metadataElapsedMs,
    cameraSelectionElapsedMs,
    frameFetchElapsedMs,
    collageElapsedMs,
    successfulFrameCount,
    failedFrameCount,
    r2PublishElapsedMs,
    // 2026-08-31 — CCTV_R2_READBACK_VERIFY_BEFORE_LINE: additive only,
    // same "on every outcome" convention every other stage-timing field
    // here already follows (see V1.9.0's own note above) — undefined
    // whenever the readback stage was never reached, never fabricated.
    r2ReadbackElapsedMs,
  };
}

/**
 * The actual (potentially slow) work — see prepareCctvImageForEvent, which
 * races this against CCTV_PREPARE_BUDGET_MS.
 *
 * V1.9.0 — `stageTracker` (a plain {stage:string} object the CALLER
 * creates fresh per attempt, same idiom prepareSingleCctvImageWork
 * already used) is mutated at each stage boundary PURELY so the caller
 * can report `timeoutStage` — and now stage-level elapsed
 * times/frame counts — if the OUTER withTimeout race's timer wins while
 * this function is still mid-flight. Root cause of the 09:20 incident's
 * missing completion log: this function previously carried no
 * stageTracker at all, so a quad (accident) prepare-timeout NEVER
 * carried a stage, unlike the single (dynamic-shoulder) path, which
 * already had exactly this mechanism. See this module's own forensics
 * comment block at the top of test/cctvQuadPrepareForensics.test.js.
 */
async function prepareCctvImageWork(env, eligibility, runCache, codecOverride, deadlineAt, stageTracker) {
  if (stageTracker) stageTracker.stage = 'metadata';
  const metadataStartedAt = Date.now();
  const metadata = await getFreewayCctvMetadata(env, runCache);
  if (stageTracker) stageTracker.metadataElapsedMs = Date.now() - metadataStartedAt;
  if (!metadata.ok) return { ok: false, reason: metadata.reason, ...snapshotStageTiming(stageTracker) };

  if (stageTracker) stageTracker.stage = 'camera-selection';
  const cameraSelectionStartedAt = Date.now();
  const candidates = selectFourQuadrantCandidates(metadata.records, {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    targetKm: eligibility.targetKm,
  });
  if (stageTracker) stageTracker.cameraSelectionElapsedMs = Date.now() - cameraSelectionStartedAt;
  if (candidates.every((c) => c === null)) return { ok: false, reason: 'no-camera', ...snapshotStageTiming(stageTracker) };

  const headerLines = buildCollageHeaderLines(new Date(), {
    roadShortName: eligibility.roadShortName,
    targetKm: eligibility.targetKm,
  });

  // Give each (parallel) frame fetch whatever's left of the overall
  // budget, not always the full default — see module comment.
  //
  // V1.9.0 — `stage` is set to 'frame-fetch' for the ENTIRE combined
  // fetch+compose call below: composeCollageFromCandidates does both
  // steps behind one await with no yield point this function can
  // observe from outside. If the outer race times out during this
  // call, `timeoutStage` will read 'frame-fetch' whether the slow part
  // was actually the network fetch or the JPEG compose — an honestly
  // disclosed limit of this instrumentation, not a claim of
  // fetch/compose-level precision. frameFetchElapsedMs/collageElapsedMs
  // below DO separate the two, but only get attached to stageTracker
  // (and are only real numbers, not undefined) once this call actually
  // returns — which, if the outer race wins first, may never happen
  // before the trace is read. See composeCollageFromCandidates's own
  // V1.9.0 comment for how those two numbers are measured.
  if (stageTracker) stageTracker.stage = 'frame-fetch';
  const frameTimeoutMs = Math.max(MIN_FRAME_TIMEOUT_MS, deadlineAt - Date.now());
  const composed = await composeCollageFromCandidates(candidates, headerLines, {
    targetKm: eligibility.targetKm,
    codecOverride,
    frameTimeoutMs,
  });
  if (stageTracker) {
    stageTracker.frameFetchElapsedMs = composed.frameFetchElapsedMs;
    stageTracker.collageElapsedMs = composed.collageElapsedMs;
    stageTracker.successfulFrameCount = composed.successfulFrameCount;
    stageTracker.failedFrameCount = composed.failedFrameCount;
  }
  if (!composed.ok) return { ok: false, reason: composed.reason, ...snapshotStageTiming(stageTracker) }; // 'no-frames' — all 4 frame fetch/decode attempts failed

  if (stageTracker) stageTracker.stage = 'r2-publish';
  // Re-check the deadline right before the expensive, side-effecting R2
  // write — per correction: if we're already past the deadline (the
  // race in prepareCctvImageForEvent may not have "noticed" yet, since
  // that timer and this check are independent), don't bother creating a
  // new R2 object at all. The outer race would discard this result
  // either way, but this avoids the wasted write outright rather than
  // relying solely on the caller's race to make it moot.
  if (Date.now() >= deadlineAt) {
    return { ok: false, reason: 'prepare-timeout', timeoutStage: 'r2-publish', ...snapshotStageTiming(stageTracker) };
  }

  const r2PublishStartedAt = Date.now();
  const published = await publishCollageImage(env.CCTV_IMAGES, composed.bytes);
  if (stageTracker) stageTracker.r2PublishElapsedMs = Date.now() - r2PublishStartedAt;
  if (!published.ok) return { ok: false, reason: 'r2-publish-failed', ...snapshotStageTiming(stageTracker) };

  // 2026-08-31 — CCTV_R2_READBACK_VERIFY_BEFORE_LINE. R2's own
  // read-after-write consistency guarantee (see publishedImage.js's own
  // correction note) means this SHOULD always succeed immediately after
  // a successful put — but "should" is exactly the gap a real broken-
  // image incident could hide in. Read the object back HERE, before this
  // function is ever allowed to hand imageUrl to a caller: R2 GET
  // success + Content-Type really 'image/jpeg' + non-empty bytes. Only
  // this write's own object is checked — no CCTV selection/compose logic
  // above is touched, no extra TDX/frame-fetch/LINE call is made.
  if (stageTracker) stageTracker.stage = 'r2-readback';
  const r2ReadbackStartedAt = Date.now();
  const readback = await verifyPublishedImageReadable(env.CCTV_IMAGES, published.id);
  if (stageTracker) stageTracker.r2ReadbackElapsedMs = Date.now() - r2ReadbackStartedAt;
  if (!readback.ok) return { ok: false, reason: 'r2-readback-failed', ...snapshotStageTiming(stageTracker) };

  // V57: imageExpiresAt comes straight from the R2 object's own
  // customMetadata (publishedImage.js), never recomputed here — a
  // recomputed value would drift LATER than the real expiry and could
  // hand a consumer a URL that stops resolving mid-delivery.
  return {
    ok: true,
    imageUrl: publicImageUrl(env, published.id),
    imageExpiresAt: published.expiresAt,
    ...snapshotStageTiming(stageTracker),
  };
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
// V1.8.7.3 — `stageTracker` is a plain `{stage:string}` object the CALLER
// (prepareSingleCctvImageForEvent) creates fresh per attempt and mutates
// here as each stage starts, PURELY so the caller can report
// `timeoutStage` if the OUTER withTimeout race's timer wins while this
// function is still mid-flight — reading `stageTracker.stage` at that
// moment is the only way to know which stage was in progress, since the
// function itself never gets to return in that case (see
// prepareSingleCctvImageForEvent below). Never written to Pipeline Trace
// directly by this function — only the caller decides what to do with it.
// Per this round's own instruction ("不要存完整 CCTV payload"), the
// returned duration fields below are plain numbers only — never the frame
// bytes, the stream URL, or any other candidate/metadata payload.
async function prepareSingleCctvImageWork(env, eligibility, runCache, deadlineAt, stageTracker) {
  if (stageTracker) stageTracker.stage = 'metadata';
  const metadata = await getFreewayCctvMetadata(env, runCache);
  if (!metadata.ok) return { ok: false, reason: metadata.reason };

  if (stageTracker) stageTracker.stage = 'candidate-selection';
  const candidate = selectSingleShoulderCandidate(metadata.records, {
    roadId: eligibility.roadId,
    roadNamePattern: eligibility.roadNamePattern,
    direction: eligibility.direction,
    startKm: eligibility.startKm,
    endKm: eligibility.endKm,
  });
  if (!candidate) return { ok: false, reason: 'no-camera' };

  // V1.8.7.3 — frameFetchDurationMs covers BOTH "frame fetch" and "frame
  // response/body read" as one combined measurement, deliberately: they
  // happen inside one already-ratified, shared function
  // (extractFirstJpegFrame, also used unchanged by the quad path) that
  // reads the response body as a byte stream until a complete JPEG is
  // found, so the connect/fetch and the body-read are not two separable
  // awaits from this call site without modifying that shared function —
  // which this round does not do, per "不要為 dynamic shoulder 建第二套
  // CCTV pipeline" (a second, parallel frame-fetch implementation just to
  // split this one number in two would be exactly that).
  if (stageTracker) stageTracker.stage = 'frame-fetch';
  const frameFetchStartedAt = Date.now();
  const frameTimeoutMs = Math.max(MIN_FRAME_TIMEOUT_MS, deadlineAt - Date.now());
  const frame = await extractFirstJpegFrame(candidate.videoStreamUrl, { timeoutMs: frameTimeoutMs });
  const frameFetchDurationMs = Date.now() - frameFetchStartedAt;
  if (!frame.ok) return { ok: false, reason: 'no-frames', frameFetchDurationMs }; // same reason as the quad path's own "every fetch failed" outcome

  if (stageTracker) stageTracker.stage = 'r2-publish';
  // Same pre-publish deadline re-check as the quad path — see
  // prepareCctvImageWork's own comment for why this matters (avoid a
  // wasted R2 write for a result the outer race is about to discard
  // anyway). Now that we're past the frame fetch, `frameFetchDurationMs`
  // is already known, so it's still reported even on this path — an
  // admin reading Pipeline Trace can see "the frame fetch itself finished
  // in Xms, but only after the budget had already run out."
  if (Date.now() >= deadlineAt) return { ok: false, reason: 'prepare-timeout', timeoutStage: 'r2-publish', frameFetchDurationMs };

  const r2PublishStartedAt = Date.now();
  const published = await publishCollageImage(env.CCTV_IMAGES, frame.bytes);
  const r2PublishDurationMs = Date.now() - r2PublishStartedAt;
  if (!published.ok) return { ok: false, reason: 'r2-publish-failed', frameFetchDurationMs, r2PublishDurationMs };

  // 2026-08-31 — CCTV_R2_READBACK_VERIFY_BEFORE_LINE. Same internal R2
  // read-back check as the quad path above (see prepareCctvImageWork's
  // own comment and publishedImage.js#verifyPublishedImageReadable) —
  // this path publishes to the SAME R2 bucket via the SAME
  // publishCollageImage(), feeds the SAME LINE image-message construction
  // in broadcastPipeline.js/aiApprovedPbsBroadcast.js, so it gets the
  // same guarantee: no imageUrl is ever returned for an object that
  // didn't round-trip.
  if (stageTracker) stageTracker.stage = 'r2-readback';
  const r2ReadbackStartedAt = Date.now();
  const readback = await verifyPublishedImageReadable(env.CCTV_IMAGES, published.id);
  const r2ReadbackDurationMs = Date.now() - r2ReadbackStartedAt;
  if (!readback.ok) return { ok: false, reason: 'r2-readback-failed', frameFetchDurationMs, r2PublishDurationMs, r2ReadbackDurationMs };

  return {
    ok: true,
    imageUrl: publicImageUrl(env, published.id),
    imageExpiresAt: published.expiresAt,
    // V1.8.7.0 — Pipeline Trace wants a MINIMAL camera reference (never
    // the full raw CCTV payload — see pipelineTrace.js's own whitelist
    // discipline): the device id plus its own KM, nothing else.
    selectedCamera: `${candidate.cctvId}@${candidate.locationMile}`,
    // V1.8.7.3 — stage-level timing, see this function's own comment above.
    frameFetchDurationMs,
    r2PublishDurationMs,
    r2ReadbackDurationMs,
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
// V1.8.7.3 — CORRECTION: 1500ms confirmed too short by real Production
// evidence (2026-08-21 afternoon: eligible dynamic-shoulder events, e.g.
// 國1 南向 87K+290～90K+900, reading cctvSkippedByReason:'prepare-timeout'
// despite everything upstream — classification, range resolution, LINE
// push, Shared Feed — succeeding). This module has NO real-network
// sandbox access to re-measure the actual frame-fetch latency directly
// (TDX/freeway.gov.tw egress is blocked in dev, and this round is
// explicitly forbidden from making a real probe) — so the 1500ms->6000ms
// change below is grounded in the ONE piece of hard evidence already
// checked into this same codebase, not a guess:
// tdx/hsinchuCctvProbe.js's OWN FRAME_TIMEOUT_MS (5000ms) is the
// pre-existing, separately-established "how long a single real
// extractFirstJpegFrame call against a live freeway.gov.tw MJPEG stream
// may reasonably need" ceiling — used, unmodified, by that module's own
// admin single-frame probe endpoint (handleHsinchuCctvFrame) when
// invoked with no override. The old 1500ms single-event budget gave the
// SAME extractFirstJpegFrame call (this path reuses it verbatim, see
// prepareSingleCctvImageWork below) less than a third of that
// already-accepted baseline once metadata/candidate-selection overhead
// is subtracted — i.e. this path was, by the codebase's own prior
// standard, always going to spuriously timeout on a perfectly normal
// frame fetch, not just a genuinely slow one. R2 publish
// (publishCollageImage) is Cloudflare-internal, not the public internet
// hop to freeway.gov.tw, and metadata is cache-only (a single KV read,
// memoized once per run) — neither is expected to be the dominant cost,
// but both still need to fit inside whatever's left after the frame
// fetch, hence some added margin beyond FRAME_TIMEOUT_MS itself rather
// than setting the budget to exactly 5000ms.
//
// New value: SINGLE_CCTV_PER_EVENT_BUDGET_MS = 6000ms — comfortably
// covers a full FRAME_TIMEOUT_MS-class (5000ms) frame fetch PLUS margin
// for R2 publish and metadata/selection overhead, without being
// unbounded. MAX_SINGLE_CCTV_EVENTS_PER_RUN stays 5 (unchanged) — this
// round adjusts how long EACH event's own slot may take, not how many
// slots exist; Production's own evidence (3 shoulder events/tick) still
// fits with headroom, and lowering the cap was never asked for and would
// only make MORE events skip CCTV outright, the opposite of this fix's
// goal. Worst-case added wall-clock for the whole single-CCTV portion of
// one run is now 5 * 6000ms = 30s — CPU-time (the dimension Cloudflare
// Workers actually meters/limits) is unaffected by this change, since
// essentially all of that added time is spent awaiting network I/O
// (fetch/KV/R2), not executing JS; see PRODUCT_DECISIONS.md for the full
// writeup. All of A2's preserved-invariants are unaffected by this
// change since it only touches the two numeric constants below, not the
// independent-per-event-budget / per-run-cap / fail-fast-on-cap-reached
// architecture itself (unchanged from V1.8.7.1):
//   - independent per-event budget: unchanged (still a fresh deadline
//     anchored at THIS event's own turn, see prepareSingleCctvImageForEvent)
//   - first-event-slow never starves 2nd/3rd: unchanged (no shared clock)
//   - global safety cap: unchanged (MAX_SINGLE_CCTV_EVENTS_PER_RUN, same value)
//   - no unlimited image-fetching: unchanged (still a hard budgetMs ceiling)
//   - accident quad mechanism: untouched, byte-for-byte (separate constant,
//     separate clock — see CCTV_PREPARE_BUDGET_MS above)
//   - single-event failure isolation: unchanged (still per-event try/catch
//     + withTimeout, one event's outcome never affects another's)
//   - CCTV never blocks the LINE text push: unchanged (still fully async,
//     awaited only within this module's own budget, never gates the text)
//   - 0 extra TDX/PBS/Google calls: unchanged (still cache-only metadata,
//     still zero new imports of tdx/auth.js or tdx/client.js)
//   - CCTV metadata cache-only: unchanged (getFreewayCctvMetadata untouched)
export const SINGLE_CCTV_PER_EVENT_BUDGET_MS = 6000;
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
  // V1.8.7.3 — shared with prepareSingleCctvImageWork so that IF the
  // outer withTimeout race below is won by the timer (not by `work`
  // itself resolving), we can still report which stage was in flight at
  // that moment — see that function's own comment on stageTracker.
  const stageTracker = { stage: 'metadata' };
  const work = prepareSingleCctvImageWork(env, eligibility, runCache, deadlineAt, stageTracker).catch(() => ({ ok: false, reason: 'prepare-error' }));
  // Same withTimeout race the quad path already uses — a slow frame
  // fetch/R2 publish for THIS event resolves 'prepare-timeout' at THIS
  // event's own budget boundary, never borrowing time from (or lending
  // time to) any other event this run. A distinct sentinel (never
  // `stageTracker.stage` read HERE, at call time) is raced instead of a
  // pre-built result object — `stageTracker.stage` must be read LAZILY,
  // only once the timer has actually fired, or it would always capture
  // whatever stage was current at the moment this line ran (typically
  // still 'metadata', since `work` has barely started) rather than the
  // stage `work` had actually reached by the time it genuinely lost the
  // race. `timeoutStage` is only ever attached HERE (never by
  // prepareSingleCctvImageWork's own internal pre-publish recheck, which
  // already knows exactly where it is and sets its own 'r2-publish' value
  // directly) — this is specifically the "the outer race's timer won, and
  // stageTracker is our only window into where `work` was" case.
  const TIMED_OUT = Symbol('single-cctv-timed-out');
  const raced = await withTimeout(work, budgetMs, TIMED_OUT);
  const result = raced === TIMED_OUT ? { ok: false, reason: 'prepare-timeout', timeoutStage: stageTracker.stage } : raced;
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
  // One gate here covers BOTH CCTV entry points — the LINE push path and
  // topUpSharedFeedCctvImages — because every real CCTV attempt funnels
  // through this function. It is the first check on purpose: nothing
  // below it reads KV, fetches a frame, or writes to R2.
  //
  // 2026-08-23: this is no longer tied to the TDX quota gate. CCTV costs
  // zero TDX calls (metadata comes from the KV cache, frames from
  // freeway.gov.tw — see sourceMode.js's isCctvImageEnabled for the full
  // evidence), so it stays ON in PBS-only mode. What remains here is a
  // plain kill switch.
  //
  // Returning the established { ok:false, reason } shape rather than
  // throwing is what makes the degrade safe: every caller already treats
  // that as "text-only this tick", so a PBS event still produces its full
  // text product, the Cron run still succeeds, and the Shared Feed is
  // still written. No CCTV must ever be able to block a PBS broadcast.
  if (!isCctvImageEnabled(env)) return { ok: false, reason: 'cctv-image-disabled' };

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
  // V1.9.0 — same stageTracker idiom prepareSingleCctvImageForEvent
  // already used (see that function's own comment): mutated by `work`
  // as it progresses, read HERE only lazily, at the exact moment the
  // outer race's timer fires — never at call time, when it would just
  // always read 'metadata'. This is what fixes the confirmed root cause
  // of the 09:20 incident's missing completion log: prior to this
  // round, a quad (accident) prepare-timeout carried no stage at all.
  const stageTracker = { stage: 'metadata' };
  const work = prepareCctvImageWork(env, eligibility, runCache, codecOverride, deadlineAt, stageTracker).catch(() => ({
    ok: false,
    reason: 'prepare-error',
    ...snapshotStageTiming(stageTracker),
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
  //
  // V1.9.0 — a distinct sentinel is raced (not a pre-built result
  // object) so `stageTracker.stage`/timing fields are read ONLY once the
  // timer has actually fired, capturing whatever `work` had genuinely
  // reached by then — never re-reading it after this call resolves,
  // which is exactly the "禁止再出現 prepare-timeout 但 timeoutStage =
  // null" rule this round enforces on the quad path.
  const TIMED_OUT = Symbol('quad-cctv-timed-out');
  const raced = await withTimeout(work, budgetMs, TIMED_OUT);
  return raced === TIMED_OUT
    ? { ok: false, reason: 'prepare-timeout', timeoutStage: stageTracker.stage, ...snapshotStageTiming(stageTracker) }
    : raced;
}
