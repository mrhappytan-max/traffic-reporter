// V1.7 next stage — one-time Production CCTV feasibility probe, targeted
// at a fixed incident location: 國道1號 82K+100 (targetKm = 82.1).
// Admin Auth gated (see index.js's ADMIN_PATHS / security/adminAuth.js).
// Same PRE-ARM one-time-use principle as tdx/cctvProbe.js, but scoped to
// its own independent KV keys so a bug here can never affect that
// module's guard (or vice versa) — see module-isolation convention used
// throughout this project (dedupe.js vs. notified.js vs. pbs lifecycle
// vs. tdxEventCache.js, etc.).
//
// Three endpoints, three concerns, cleanly separated:
//   - GET /admin/cctv-hsinchu-probe        — STEP 1+2+4: the ONE allowed
//     TDX CCTV metadata call (only on the very first, never-attempted
//     request), local four-quadrant selection, persisting up to 4
//     candidates to KV, and rendering the mobile HTML page. On every
//     later request it only ever reads the candidates KV — see below,
//     this file's import graph makes a second TDX call structurally
//     impossible once the guard is armed/completed.
//   - GET /admin/cctv-hsinchu-frame/0..3    — STEP 3: fetches ONE JPEG
//     frame from the CCTV's own VideoStreamURL (a freeway.gov.tw MJPEG
//     stream), never touching TDX at all. This handler does not import
//     getAccessToken/fetchTdxJson/anything TDX-related — "0 TDX calls"
//     is enforced by the import graph itself, not just by convention.
//   - GET /admin/cctv-hsinchu-collage       — V1.8: composes the (up to)
//     4 quadrant frames into a single 2x2 collage JPEG (see
//     cctv/collage.js). Strictly read-only against the candidates KV —
//     never triggers /admin/cctv-hsinchu-probe, never rebuilds the
//     candidate list, and (like the frame endpoint above) never calls
//     getAccessToken/fetchTdxJson: 0 TDX calls, same guarantee, same
//     reasoning. If the candidates KV is absent/expired, responds with a
//     clear "CCTV candidate cache unavailable" message rather than
//     silently calling TDX to repopulate it.
//
// V1.7 CCTV 四象限選鏡規則 / 4-camera cross-direction search — RATIFIED,
// see PROJECT_HANDOFF.md section 14 for the full rationale. Supersedes
// the earlier "nearest 5 CCTV by KM distance" approach. Given the fixed
// incident point TARGET_KM, this module searches exactly 4 fixed
// quadrants — never more, single first pass, never a second TDX call:
//   1. S, km < TARGET_KM — nearest southbound camera BEFORE the incident.
//   2. S, km > TARGET_KM — nearest southbound camera AFTER the incident.
//   3. N, km < TARGET_KM — nearest northbound camera BEFORE the incident.
//   4. N, km > TARGET_KM — nearest northbound camera AFTER the incident.
// Rationale: national freeway PTZ CCTV units are steerable and are
// frequently panned by 交控中心 to point at an incident regardless of
// which carriageway they're physically mounted on — a southbound
// incident may in practice be best seen by a northbound camera turned to
// face across the median. A same-direction-only or plain-nearest-N
// selector can silently miss the camera that actually shows the scene.
// Distance strategy per quadrant, independently: prefer a candidate
// within +/-2km of TARGET_KM; if none, widen to +/-4km for that quadrant
// only; if still none, leave that quadrant empty (index stays null) —
// never reach further just to fill the slot, and never exceed 4 cameras
// total in this first pass.
//
// V1.8.1 hard rule (post-Production-testing fix): the four-quadrant
// search runs ONLY over an "eligible mainline CCTV pool" — records
// inside a service area/rest stop (服務區/休息站/服務站) are excluded
// BEFORE distance ranking, never merely deprioritized after the fact.
// See isServiceAreaCctv's own comment for the full rationale and why
// LocationType's numeric semantics are deliberately NOT assumed.
//
// PRE-ARM guard (admin:cctv-hsinchu-probe-used:v1) — identical ordering
// principle to tdx/cctvProbe.js's V1.7 fix:
//   1. Read KV state before any TDX call at all. 'armed' or 'completed'
//      -> stop, 0 TDX calls.
//   2. (absent) -> write 'armed' BEFORE getAccessToken(). Write failure
//      -> fail closed 503, 0 TDX calls, no retry.
//   3. OAuth failure -> KV stays 'armed', locked, no auto-retry.
//   4. The ONE CCTV metadata call. Failure -> KV stays 'armed', locked,
//      no retry.
//   5. Success -> four-quadrant select (at most 4 candidates, some slots
//      possibly null) -> persist candidates (own key, 1h TTL) -> flip
//      'armed' -> 'completed'. If that last write fails, KV simply stays
//      'armed' (a failed put never partially commits) — still fully
//      locked either way.
// No auto-reset, no reset endpoint — a human must manually delete
// admin:cctv-hsinchu-probe-used:v1 (and, if desired,
// admin:cctv-hsinchu-candidates:v1) to run this again.
//
// Never placed anywhere in any response: TDX_CLIENT_ID/TDX_CLIENT_SECRET
// /the OAuth access token/any Authorization header value.

import { getAccessToken } from './auth.js';
import { fetchTdxJson, TdxApiError } from './client.js';
import { parseKM } from '../traffic/roadSectionLabel.js';
import { toTaipeiParts } from '../traffic/broadcastHours.js';
import { composeQuadrantCollage } from '../cctv/collage.js';

// cctv/jpegCodecWorker.js does a top-level `import ... from '*.wasm'` —
// the only WASM-loading mechanism Cloudflare Workers actually supports
// (see that file's module comment). Plain Node has no ESM loader for
// `.wasm` files, and every test file in this project imports
// src/index.js (which imports this file) at the top level — so a static
// top-level import of jpegCodecWorker.js here would break the ENTIRE
// test suite the instant any test file loads, not just the new
// collage tests. Loaded lazily instead, via dynamic import() ONLY
// inside handleHsinchuCctvCollage, and only when actually needed (see
// below) — merely parsing/loading this file never touches it. Tests
// exercise the real orchestration logic either via the `codecOverride`
// parameter (see handleHsinchuCctvCollage's own doc comment) or via
// paths that never need a codec at all (0 successful fetches).
function loadProductionJpegCodec() {
  return import('../cctv/jpegCodecWorker.js');
}

// ASCII-only quadrant labels for the V1.8 collage image (see
// bitmapFont.js's module comment for why no CJK glyphs are embedded).
// Index-aligned with QUADRANTS below — never reordered.
const ASCII_QUADRANT_LABELS = ['S BEFORE', 'S AFTER', 'N BEFORE', 'N AFTER'];

export const PROBE_USED_KEY = 'admin:cctv-hsinchu-probe-used:v1';
export const CANDIDATES_KEY = 'admin:cctv-hsinchu-candidates:v1';
const CANDIDATES_TTL_SECONDS = 3600; // 1 hour

// Full freeway CCTV list — deliberately NO $top here (unlike
// tdx/cctvProbe.js's $top=1) because four-quadrant selection needs to
// compare across every 國道1號 record to find the nearest candidate in
// each of the 4 quadrants around TARGET_KM; filtering happens locally in
// this Worker, per spec.
const CCTV_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$format=JSON';

const TARGET_ROAD_ID = '000010';
const TARGET_KM = 82.1; // 國道1號 82K+100
const NEAR_RADIUS_KM = 2; // preferred radius per quadrant
const WIDE_RADIUS_KM = 4; // fallback radius per quadrant if the near radius is empty
const CANDIDATE_COUNT = 4; // fixed: S-before, S-after, N-before, N-after — never more

// Quadrant slot definitions, index-aligned with the persisted candidates
// array and with /admin/cctv-hsinchu-frame/<index>. `direction` matches
// against a normalized S/N form of the record's RoadDirection/Direction
// field; `side` picks which side of TARGET_KM this slot covers.
const QUADRANTS = [
  { label: 'S前', direction: 'S', side: 'before' },
  { label: 'S後', direction: 'S', side: 'after' },
  { label: 'N前', direction: 'N', side: 'before' },
  { label: 'N後', direction: 'N', side: 'after' },
];

const TRUSTED_IMAGE_HOST_SUFFIX = 'freeway.gov.tw';
export const MAX_FRAME_BYTES = 2 * 1024 * 1024; // 2 MB
export const FRAME_TIMEOUT_MS = 5000; // ~5 seconds

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function firstDefinedField(record, candidateNames) {
  for (const name of candidateNames) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name];
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isTargetRoad(record) {
  const roadId = firstDefinedField(record, ['RoadID', 'RoadId']);
  if (roadId === TARGET_ROAD_ID) return true;
  const roadName = firstDefinedField(record, ['RoadName']);
  return typeof roadName === 'string' && /國道1號|國道一號/.test(roadName);
}

// V1.8.1 hard rule (post-Production-testing fix): a CCTV physically
// inside a service area / rest stop (服務區/休息站/服務站 — e.g.
// 湖口服務區, real-world observed at 86K+000 on 國道1號) must NEVER be
// selected as an incident camera, no matter how close its KM is to the
// incident. These cameras typically point at a parking lot, gas
// station, or the service area's own internal road — not the freeway
// mainline — so a nearby KM number does not mean mainline visibility.
// See PROJECT_HANDOFF.md's V1.8 section for the full rationale.
//
// LocationType semantics could NOT be verified for this fix: TDX's live
// API and documentation are both unreachable from this sandbox (network
// egress to tdx.transportdata.tw is blocked), so this deliberately does
// NOT hardcode any LocationType enum-value assumption ("不要猜
// LocationType 數值代表什麼"). Instead it scans every string-valued
// field on the raw TDX record (RoadSection, RoadName, LocationType if
// it happens itself to be textual, or any other descriptive field) for
// the keywords below — a guess-free check grounded in whatever the
// field's own text actually says, that works regardless of which exact
// field name carries the description in the real payload, and doesn't
// silently stop working if TDX renames/adds a field. If a future round
// confirms (from a real response) that LocationType is a reliable
// numeric/enum service-area marker, prefer switching to that structured
// check instead — ask before doing so, since it changes what "service
// area" detection actually keys off.
//
// Deliberately narrow: only 服務區/休息站/服務站. Interchanges, ramps,
// system interchanges, tunnels, and bridges are NOT excluded by this
// rule — whether those are appropriate for incident CCTV is a separate
// decision, not part of this fix.
const SERVICE_AREA_KEYWORDS = ['服務區', '休息站', '服務站'];

function isServiceAreaCctv(record) {
  for (const value of Object.values(record)) {
    if (typeof value !== 'string') continue;
    if (SERVICE_AREA_KEYWORDS.some((keyword) => value.includes(keyword))) return true;
  }
  return false;
}

/** Normalizes a raw RoadDirection/Direction field value to 'S', 'N', or
 * null (unrecognized). Accepts TDX's short codes ('S'/'N') as well as
 * common textual variants defensively — TDX field content has been
 * observed to vary in casing/verbosity across endpoints. */
function normalizeDirection(rawDirection) {
  if (typeof rawDirection !== 'string') return null;
  const value = rawDirection.trim().toUpperCase();
  if (value === 'S' || value === '南' || value === '南向' || value.startsWith('SOUTH')) return 'S';
  if (value === 'N' || value === '北' || value === '北向' || value.startsWith('NORTH')) return 'N';
  return null;
}

/**
 * V1.7 four-quadrant selector — see module comment and
 * PROJECT_HANDOFF.md section 14 for the ratified rule. Returns a fixed
 * CANDIDATE_COUNT-length array, index-aligned to QUADRANTS (S前/S後/N前/
 * N後); any quadrant with no eligible candidate within +/-WIDE_RADIUS_KM
 * is `null` at that index — never omitted, never backfilled from another
 * quadrant, never more than 4 entries total.
 */
function selectFourQuadrantCandidates(records) {
  // Step 1: build the eligible MAINLINE CCTV pool first — wrong-road and
  // service-area records are excluded here, BEFORE any distance
  // comparison happens. This ordering is deliberate and required: if
  // exclusion happened AFTER picking "nearest," a nearby service-area
  // camera could still win a quadrant before being caught — see
  // isServiceAreaCctv's module comment.
  const usable = [];
  for (const record of records) {
    if (!isTargetRoad(record)) continue;
    if (isServiceAreaCctv(record)) continue; // 服務區/休息站/服務站 — never a mainline incident camera, regardless of KM proximity
    const cctvId = firstDefinedField(record, ['CCTVID', 'CCTVId', 'ID']);
    const videoStreamUrl = firstDefinedField(record, ['VideoStreamURL']);
    const locationMile = firstDefinedField(record, ['LocationMile']);
    if (!cctvId || !videoStreamUrl) continue; // unusable without an ID or an image URL
    const km = parseKM(locationMile);
    if (km === null) continue; // can't place into a quadrant without a parseable KM
    const direction = normalizeDirection(firstDefinedField(record, ['RoadDirection', 'Direction']));
    if (direction === null) continue; // can't place into a quadrant without a known direction
    usable.push({
      cctvId,
      roadDirection: direction,
      locationMile,
      positionLon: firstDefinedField(record, ['PositionLon']),
      positionLat: firstDefinedField(record, ['PositionLat']),
      videoStreamUrl,
      km,
      distanceKm: Math.abs(km - TARGET_KM),
    });
  }

  return QUADRANTS.map((quadrant) => {
    const inDirection = usable.filter((c) => c.roadDirection === quadrant.direction);
    const inSide = inDirection.filter((c) => (quadrant.side === 'before' ? c.km < TARGET_KM : c.km > TARGET_KM));

    const nearest = (maxRadiusKm) => {
      const withinRadius = inSide.filter((c) => c.distanceKm <= maxRadiusKm);
      if (withinRadius.length === 0) return null;
      return withinRadius.reduce((best, c) => (c.distanceKm < best.distanceKm ? c : best));
    };

    return nearest(NEAR_RADIUS_KM) ?? nearest(WIDE_RADIUS_KM);
  });
}

// Only these 6 fields are ever persisted — per spec, "只保存". distanceKm
// is re-derived from locationMile at render time instead (same "derive
// human-readable info at render time, not bake-time" convention this
// project already uses — see health.js). `null` (an empty quadrant slot)
// passes through unchanged so the persisted array stays a fixed
// CANDIDATE_COUNT-length, index-aligned-to-quadrant array.
function toStorableCandidate(c) {
  if (c === null) return null;
  return {
    cctvId: c.cctvId,
    roadDirection: c.roadDirection,
    locationMile: c.locationMile,
    positionLon: c.positionLon,
    positionLat: c.positionLat,
    videoStreamUrl: c.videoStreamUrl,
  };
}

async function persistCandidates(kv, candidates, now) {
  try {
    await kv.put(
      CANDIDATES_KEY,
      JSON.stringify({ generatedAt: now.toISOString(), candidates: candidates.map(toStorableCandidate) }),
      { expirationTtl: CANDIDATES_TTL_SECONDS }
    );
    return { committed: true };
  } catch {
    return { committed: false };
  }
}

/** Read-only. Never calls TDX. Returns null on missing/expired/corrupt (KV's own TTL already expires the key server-side). */
async function readCandidates(kv) {
  if (!kv) return null;
  try {
    const raw = await kv.get(CANDIDATES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.candidates)) return null;
    return parsed.candidates;
  } catch {
    return null;
  }
}

function candidateDistanceLabel(candidate) {
  const km = parseKM(candidate.locationMile);
  return km === null ? '未知' : `${Math.abs(km - TARGET_KM).toFixed(3)} 公里`;
}

/** ASCII-only distance label for the V1.8 collage image, e.g. "0.10KM". */
function candidateDistanceLabelAscii(candidate) {
  const km = parseKM(candidate.locationMile);
  return km === null ? null : `${Math.abs(km - TARGET_KM).toFixed(2)}KM`;
}

/** Formats a KM float as TDX-style ASCII, e.g. 82.1 -> "82K+100". */
function formatKmAscii(km) {
  const whole = Math.floor(km);
  const meters = Math.round((km - whole) * 1000);
  return `${whole}K+${String(meters).padStart(3, '0')}`;
}

function renderPage(bodyHtml) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>國1 82K+100 CCTV Test</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; max-width: 700px; margin-left: auto; margin-right: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    font-size: 17px; line-height: 1.5; background: #f4f5f7; color: #1a1a1a;
  }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .card { background: #fff; border-radius: 12px; padding: 14px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .card h2 { font-size: 16px; margin: 0 0 8px; }
  img { max-width: 100%; border-radius: 8px; display: block; background: #eee; }
  .stats { font-size: 14px; color: #333; white-space: pre-line; }
  .note { font-size: 14px; color: #1a7f37; margin-top: 8px; }
  .warn { font-size: 14px; color: #c31c1c; }
</style>
</head>
<body>
  <h1>國1 82K+100 CCTV Test</h1>
  ${bodyHtml}
</body>
</html>`;
}

// Four fixed quadrant cards, index-aligned with QUADRANTS/CANDIDATE_COUNT
// and /admin/cctv-hsinchu-frame/<index>. An empty quadrant is rendered
// explicitly ("無符合鏡頭") rather than being silently skipped — per the
// ratified rule (PROJECT_HANDOFF.md section 14), a missing camera is an
// honest, visible result, not something to hide or backfill.
function renderCandidateCards(candidates) {
  return QUADRANTS.map((quadrant, i) => {
    const c = candidates[i];
    if (!c) {
      return `<div class="card">
    <h2>${escapeHtml(quadrant.label)}</h2>
    <p class="warn">此象限 &plusmn;${WIDE_RADIUS_KM}km 內無符合鏡頭。</p>
  </div>`;
    }
    return `<div class="card">
    <h2>${escapeHtml(quadrant.label)} / ${escapeHtml(c.locationMile || '未知里程')} / 距事故 ${candidateDistanceLabel(c)}</h2>
    <img src="/admin/cctv-hsinchu-frame/${i}" alt="CCTV ${escapeHtml(c.cctvId)}" loading="lazy">
  </div>`;
  }).join('\n');
}

function renderStats({ metadataCalls, candidates }) {
  const filledCount = candidates.filter(Boolean).length;
  const note = `${filledCount} 張 CCTV 圖片皆直接由高速公路局影像主機取得，未呼叫 TDX CCTV API。`;
  return `<div class="card">
    <h2>統計</h2>
    <div class="stats">TDX CCTV metadata calls: ${metadataCalls}
CCTV quadrants filled: ${filledCount} / ${CANDIDATE_COUNT}
CCTV image fetches: ${filledCount}
CCTV image TDX Authorization: none
CCTV image source: *.freeway.gov.tw</div>
    <p class="note">${escapeHtml(note)}</p>
  </div>`;
}

export async function handleHsinchuCctvProbe(env) {
  // 0. Read the current KV state — BEFORE any TDX call whatsoever.
  if (env.TRAFFIC_KV === undefined) {
    return htmlResponse(renderPage('<div class="card"><p class="warn">TRAFFIC_KV binding not configured; refusing to call TDX.</p></div>'), 503);
  }

  let state;
  try {
    state = await env.TRAFFIC_KV.get(PROBE_USED_KEY);
  } catch {
    return htmlResponse(renderPage('<div class="card"><p class="warn">Could not verify one-time-use state; refusing to call TDX.</p></div>'), 503);
  }

  if (state === 'armed') {
    return htmlResponse(
      renderPage('<div class="card"><p class="warn">Probe locked; a previous attempt has already been armed. Manual reset required.</p></div>'),
      200
    );
  }

  if (state === 'completed') {
    const candidates = await readCandidates(env.TRAFFIC_KV);
    if (!candidates || candidates.length === 0) {
      return htmlResponse(
        renderPage(
          '<div class="card"><p class="warn">Probe already completed, but the cached candidate list has expired (1h TTL). The one-time-use guard remains locked — no further TDX calls will be made.</p></div>'
        ),
        200
      );
    }
    return htmlResponse(renderPage(renderCandidateCards(candidates) + renderStats({ metadataCalls: 0, candidates })), 200);
  }

  // 1. PRE-ARM — write 'armed' BEFORE any TDX-related call at all.
  try {
    await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'armed');
  } catch {
    return htmlResponse(renderPage('<div class="card"><p class="warn">Could not arm the one-time-use guard; refusing to call TDX.</p></div>'), 503);
  }

  // 2. OAuth token — reuses the project's existing cache-first flow.
  // On failure, KV stays 'armed' — never auto-cleared, never auto-retried.
  let accessToken;
  try {
    accessToken = await getAccessToken(env);
  } catch {
    return htmlResponse(
      renderPage('<div class="card"><p class="warn">probe locked after failed attempt; manual reset required (OAuth failed)</p></div>'),
      502
    );
  }

  // 3. The ONE allowed CCTV metadata call. No retry, no pagination, no
  // second call. On failure, KV stays 'armed'.
  let cctvJson;
  try {
    cctvJson = await fetchTdxJson(CCTV_URL, accessToken, { source: 'cctv-hsinchu-probe' });
  } catch (err) {
    return htmlResponse(
      renderPage(
        `<div class="card"><p class="warn">probe locked after failed attempt; manual reset required (CCTV metadata failed${err instanceof TdxApiError && err.status ? `, HTTP ${err.status}` : ''})</p></div>`
      ),
      502
    );
  }

  const records = Array.isArray(cctvJson) ? cctvJson : cctvJson.CCTVs || cctvJson.Data || [];
  const candidates = selectFourQuadrantCandidates(records);

  await persistCandidates(env.TRAFFIC_KV, candidates, new Date());

  // Metadata call genuinely succeeded — flip armed -> completed. If this
  // write fails, KV simply stays 'armed' — still fully locked either way.
  try {
    await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'completed');
  } catch {
    // completionWriteFailed — guard stays 'armed', which is still fully
    // locked (0 TDX calls on every future request) — see module comment.
  }

  // Always render all 4 quadrant slots (renderCandidateCards already
  // shows an explicit "no candidate" state per empty slot) — an all-empty
  // result is still shown honestly rather than replaced with a single
  // generic warning, per the ratified rule.
  return htmlResponse(renderPage(renderCandidateCards(candidates) + renderStats({ metadataCalls: 1, candidates })), 200);
}

// --- STEP 3: single-frame MJPEG capture. Imports NOTHING TDX-related. ---

function isTrustedImageUrl(url) {
  if (url.protocol !== 'https:') return false;
  return url.hostname === TRUSTED_IMAGE_HOST_SUFFIX || url.hostname.endsWith(`.${TRUSTED_IMAGE_HOST_SUFFIX}`);
}

function findMarker(buf, b1, b2, from = 0) {
  for (let i = from; i < buf.length - 1; i += 1) {
    if (buf[i] === b1 && buf[i + 1] === b2) return i;
  }
  return -1;
}

function concatChunks(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function isAbortLike(err) {
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Fetches the MJPEG stream directly — deliberately NO Authorization
 * header, no TDX call of any kind. Reads at most MAX_FRAME_BYTES, waits
 * at most ~FRAME_TIMEOUT_MS, and stops (cancels the stream) the instant
 * a complete JPEG frame (FFD8 ... FFD9) is found. Never reads further —
 * this is a single-frame capture, not an MJPEG player.
 */
export async function extractFirstJpegFrame(streamUrl, { timeoutMs = FRAME_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = new URL(streamUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!isTrustedImageUrl(url)) {
    return { ok: false, reason: 'untrusted-hostname' };
  }

  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) }); // no Authorization header, intentionally
  } catch (err) {
    return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'network-error' };
  }

  if (!res.ok || !res.body) {
    try {
      res.body?.cancel?.();
    } catch {
      // best-effort
    }
    return { ok: false, reason: 'http-error', httpStatus: res.status };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let soiIndex = -1;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;

      if (totalBytes > MAX_FRAME_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too-large' };
      }

      const buf = concatChunks(chunks);
      if (soiIndex === -1) soiIndex = findMarker(buf, 0xff, 0xd8);
      if (soiIndex !== -1) {
        const eoiIndex = findMarker(buf, 0xff, 0xd9, soiIndex + 2);
        if (eoiIndex !== -1) {
          await reader.cancel().catch(() => {});
          return { ok: true, bytes: buf.slice(soiIndex, eoiIndex + 2), contentType: res.headers.get('content-type') };
        }
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
    return { ok: false, reason: isAbortLike(err) ? 'timeout' : 'stream-error' };
  }

  return { ok: false, reason: 'no-complete-frame' };
}

const FRAME_ERROR_STATUS = {
  'invalid-url': 400,
  'untrusted-hostname': 400,
};

export async function handleHsinchuCctvFrame(env, index) {
  if (!Number.isInteger(index) || index < 0 || index >= CANDIDATE_COUNT) {
    return jsonResponse({ status: 'error', message: 'Invalid CCTV frame index.' }, 404);
  }

  const candidates = await readCandidates(env.TRAFFIC_KV);
  if (!candidates || !candidates[index]) {
    return jsonResponse(
      { status: 'error', message: 'No cached CCTV candidate at this index. Run /admin/cctv-hsinchu-probe first.' },
      404
    );
  }

  const result = await extractFirstJpegFrame(candidates[index].videoStreamUrl);
  if (!result.ok) {
    return jsonResponse(
      { status: 'error', reason: result.reason, httpStatus: result.httpStatus ?? null },
      FRAME_ERROR_STATUS[result.reason] ?? 502
    );
  }

  return new Response(result.bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
  });
}

// --- V1.8: STEP 5 — compose the 4 quadrant frames into one collage. ---
// Strictly read-only against the candidates KV; never touches TDX (no
// getAccessToken/fetchTdxJson import above is ever called from this
// function), never triggers the probe, never rebuilds the candidate
// list. See module comment and PROJECT_HANDOFF.md's V1.8 section.

/**
 * Fetches all (up to 4) candidate frames in parallel — capped at 4 by
 * construction (exactly one fetch attempt per quadrant slot, never
 * more) — and composes them into a single 2x2 collage JPEG via
 * cctv/collage.js. One or more successfully DECODED frames is enough to
 * produce a valid collage (collage.js's own successfulDecodedFrames
 * count is the source of truth — a 200 response that isn't actually a
 * valid JPEG does not count); only when every quadrant has neither a
 * candidate nor a usable frame does this respond without an image.
 *
 * @param {object} env
 * @param {{decodeJpeg: Function, encodeJpeg: Function}} [codecOverride] —
 *   TEST-ONLY. Production (index.js's routeAdminGet) never passes this;
 *   the real Workers WASM codec is lazily loaded on demand (see
 *   loadProductionJpegCodec above). Tests that need a real decoded
 *   image pass test/testJpegCodec.js's Node-compatible codec here
 *   instead of going through the real `.wasm` import, which plain Node
 *   cannot load — see this file's module comment.
 */
export async function handleHsinchuCctvCollage(env, codecOverride) {
  if (env.TRAFFIC_KV === undefined) {
    return jsonResponse({ status: 'error', message: 'TRAFFIC_KV binding not configured.' }, 503);
  }

  const candidates = await readCandidates(env.TRAFFIC_KV);
  if (!candidates) {
    return jsonResponse({ status: 'error', message: 'CCTV candidate cache unavailable' }, 404);
  }

  const frameResults = await Promise.all(
    candidates.map(async (candidate) => {
      if (!candidate) return null;
      try {
        return await extractFirstJpegFrame(candidate.videoStreamUrl);
      } catch {
        // extractFirstJpegFrame never throws in practice (every failure
        // path returns a typed {ok:false,...} result) — this catch is
        // defense-in-depth only, so one unexpected error can never take
        // down the whole collage (see module comment: 1-4 successes
        // still produce a valid collage).
        return { ok: false, reason: 'stream-error' };
      }
    })
  );

  const cells = QUADRANTS.map((quadrant, i) => {
    const candidate = candidates[i];
    const slotLabel = ASCII_QUADRANT_LABELS[i];
    if (!candidate) {
      return { slotLabel, locationLabel: null, distanceLabel: null, jpegBytes: null, status: 'empty' };
    }
    const locationLabel = candidate.locationMile || null;
    const distanceLabel = candidateDistanceLabelAscii(candidate);
    const frame = frameResults[i];
    if (frame && frame.ok) {
      return { slotLabel, locationLabel, distanceLabel, jpegBytes: frame.bytes, status: 'ok' };
    }
    return { slotLabel, locationLabel, distanceLabel, jpegBytes: null, status: 'failed' };
  });

  const { hour, minute } = toTaipeiParts(new Date());
  const titleLine = `NH1 ${formatKmAscii(TARGET_KM)} CCTV`;
  const subtitleLine = `UPDATED ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // Only load a real codec when there's at least one fetched frame to
  // decode — composeQuadrantCollage's own pre-check short-circuits to
  // ok:false/no-frames without ever calling decodeJpeg/encodeJpeg when
  // nothing fetched successfully, so there's no need to pay the WASM
  // init cost (or, in tests with no override, hit the Node-incompatible
  // dynamic import) for a request that can't produce an image anyway.
  const anyFetchedOk = cells.some((c) => c.status === 'ok' && c.jpegBytes);
  const codec = anyFetchedOk ? codecOverride || (await loadProductionJpegCodec()) : { decodeJpeg: undefined, encodeJpeg: undefined };

  const result = await composeQuadrantCollage(cells, { decodeJpeg: codec.decodeJpeg, encodeJpeg: codec.encodeJpeg, titleLine, subtitleLine });
  if (!result.ok) {
    return jsonResponse({ status: 'error', message: 'No CCTV footage available for any quadrant.' }, 502);
  }

  return new Response(result.bytes, {
    status: 200,
    headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' },
  });
}
