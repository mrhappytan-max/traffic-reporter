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
// binding, a CCTV metadata fetch failure, zero matching cameras, all 4
// frame fetches failing, a JPEG decode/compose failure, or an R2 publish
// failure are ALL just "this accident doesn't get a CCTV image this
// tick" — never a reason to withhold the accident text itself, never a
// reason to mark the event failed, never a retry-with-delay. See
// broadcastPipeline.js for how a {ok:false} result here maps to a
// plain text-only LINE push, functionally identical to V1.8.4-and-
// earlier's only-ever-text behavior.

import { getAccessToken } from '../tdx/auth.js';
import { fetchTdxJson } from '../tdx/client.js';
import {
  CCTV_URL,
  TARGET_ROAD_ID,
  TARGET_ROAD_NAME_PATTERN,
  selectFourQuadrantCandidates,
  composeCollageFromCandidates,
  buildCollageHeaderLines,
} from '../tdx/hsinchuCctvProbe.js';
import { resolveRoadKey, parseKM } from '../traffic/roadSectionLabel.js';
import { publishCollageImage } from './publishedImage.js';

// See module comment: 國道一號 only, using the SAME Production-confirmed
// roadId/roadNamePattern hsinchuCctvProbe.js has used since V1.7 — no
// second, independently-guessed copy of these values.
const CCTV_SUPPORTED_ROADS = {
  國道一號: { roadId: TARGET_ROAD_ID, roadNamePattern: TARGET_ROAD_NAME_PATTERN, shortName: '國1' },
};

// Shared CCTV metadata cache — a full TDX CCTV/Freeway response is the
// same regardless of which accident asks for it, so it's cached
// independently of any one accident. Own key (isolated from
// hsinchuCctvProbe.js's admin-probe CANDIDATES_KEY/PROBE_USED_KEY — see
// this project's module-isolation convention) so a bug in one can never
// affect the other. 6h TTL: generous enough that a normal Cron cadence
// (every 10 minutes) very rarely re-fetches, short enough that a camera
// added/removed/relocated in the real TDX feed shows up again within
// the same working day. KV's eventual consistency is explicitly
// ACCEPTABLE here (unlike the R2-backed published-image URL) — this is
// a metadata cache feeding a fresh compose, never a write-then-
// immediately-publicly-read link.
const FREEWAY_METADATA_KEY = 'cctv:freeway-metadata:v1';
const FREEWAY_METADATA_TTL_SECONDS = 6 * 60 * 60;

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

/**
 * Pure, synchronous, ZERO I/O — decides whether `event` is even a
 * candidate for CCTV enrichment, and if so, resolves the exact
 * road/KM target to search around. Safe to call from a dry-run/debug
 * path for a pure eligibility count (see broadcastPipeline.js's
 * cctvEligibleAccidentCount) without triggering any network activity.
 *
 * @param {object} event
 * @returns {{eligible:true, roadKey:string, roadId:string, roadNamePattern:RegExp, roadShortName:string, targetKm:number}
 *   |{eligible:false, reason:'not-accident'|'not-freeway-source'|'unresolvable-road'|'unsupported-road'|'no-reliable-km'}}
 */
export function resolveCctvEligibility(event) {
  if (!event || event.type !== 'accident') return { eligible: false, reason: 'not-accident' };
  // V1.8.5 V1: only TDX Freeway-sourced accidents (see tdx/sources.js —
  // source:'freeway' is the confirmed 國道 RoadEvent feed). Never PBS,
  // never 'highway' (省道) — those don't have a confirmed CCTV road
  // mapping in this round's registry either way, but gating on source
  // here keeps the reason distinct/observable from "road not supported."
  if (event.source !== 'freeway') return { eligible: false, reason: 'not-freeway-source' };

  const roadKey = resolveRoadKey(event.road);
  if (!roadKey) return { eligible: false, reason: 'unresolvable-road' };

  const supported = CCTV_SUPPORTED_ROADS[roadKey];
  if (!supported) return { eligible: false, reason: 'unsupported-road' };

  const targetKm = eventTargetKm(event);
  if (targetKm === null) return { eligible: false, reason: 'no-reliable-km' };

  return {
    eligible: true,
    roadKey,
    roadId: supported.roadId,
    roadNamePattern: supported.roadNamePattern,
    roadShortName: supported.shortName,
    targetKm,
  };
}

async function fetchFreewayCctvRecordsFromKvOrTdx(env) {
  if (env.TRAFFIC_KV) {
    try {
      const raw = await env.TRAFFIC_KV.get(FREEWAY_METADATA_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.records)) return { ok: true, records: parsed.records };
      }
    } catch {
      // A corrupt/unreadable cache entry must never itself become a hard
      // failure — fall through to a fresh TDX fetch, same as a cache miss.
    }
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(env);
  } catch {
    return { ok: false, reason: 'tdx-auth-failed' };
  }

  let json;
  try {
    json = await fetchTdxJson(CCTV_URL, accessToken, { source: 'cctv-dynamic-metadata' });
  } catch {
    return { ok: false, reason: 'tdx-fetch-failed' };
  }

  const records = Array.isArray(json) ? json : json.CCTVs || json.Data || [];

  if (env.TRAFFIC_KV) {
    try {
      await env.TRAFFIC_KV.put(FREEWAY_METADATA_KEY, JSON.stringify({ records, fetchedAt: new Date().toISOString() }), {
        expirationTtl: FREEWAY_METADATA_TTL_SECONDS,
      });
    } catch {
      // Best-effort cache write only — this run's own in-memory result is
      // already in hand and used regardless of whether the write lands.
    }
  }

  return { ok: true, records };
}

/**
 * Cache-first, and — critically — IN-FLIGHT-PROMISE-MEMOIZED via
 * `runCache`, a plain object the CALLER creates ONCE per Cron run and
 * threads through every accident this tick (see broadcastPipeline.js).
 * This is what guarantees "N accidents this tick -> at most 1 TDX CCTV
 * metadata call, never N": the FIRST accident to need metadata this run
 * kicks off fetchFreewayCctvRecordsFromKvOrTdx and stores the
 * still-pending Promise on runCache.metadataPromise; every subsequent
 * accident this SAME tick awaits that identical Promise instead of
 * calling fetchTdxJson again, regardless of call ordering/timing.
 * `runCache` is deliberately NOT module-level/global state — a
 * request-scoped object avoids any cross-invocation staleness/
 * concurrency concern module-level mutable state would raise.
 */
function getFreewayCctvMetadata(env, runCache) {
  if (!runCache.metadataPromise) {
    runCache.metadataPromise = fetchFreewayCctvRecordsFromKvOrTdx(env);
  }
  return runCache.metadataPromise;
}

/**
 * Orchestrates the FULL dynamic CCTV pipeline for one accident event:
 * eligibility -> shared metadata (cache-first, memoized this run) ->
 * four-quadrant select (same ratified algorithm, this event's own
 * road/KM) -> fetch up to 4 frames + compose (same collage renderer) ->
 * publish to R2. Called AT MOST ONCE per accident event by
 * broadcastPipeline.js (before that event's per-target push loop) — the
 * resulting imageUrl is then shared across every pending target for
 * that event; see this module's own doc note in broadcastPipeline.js
 * for why that's structurally guaranteed, not just convention.
 *
 * @param {object} env
 * @param {object} event
 * @param {{metadataPromise?: Promise}} runCache - shared across this
 *   Cron run's accidents; see getFreewayCctvMetadata above.
 * @param {{decodeJpeg,encodeJpeg}} [codecOverride] - TEST-ONLY, threaded
 *   through to composeCollageFromCandidates — see that function's doc
 *   comment.
 * @returns {Promise<{ok:true, imageUrl:string}|{ok:false, reason:string}>}
 */
export async function prepareCctvImageForEvent(env, event, runCache, codecOverride) {
  const eligibility = resolveCctvEligibility(event);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };

  if (env.CCTV_IMAGES === undefined) return { ok: false, reason: 'no-r2-binding' };

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

  const composed = await composeCollageFromCandidates(candidates, headerLines, { targetKm: eligibility.targetKm, codecOverride });
  if (!composed.ok) return { ok: false, reason: composed.reason }; // 'no-frames' — all 4 frame fetch/decode attempts failed

  const published = await publishCollageImage(env.CCTV_IMAGES, composed.bytes);
  if (!published.ok) return { ok: false, reason: 'r2-publish-failed' };

  return { ok: true, imageUrl: publicImageUrl(env, published.id) };
}
