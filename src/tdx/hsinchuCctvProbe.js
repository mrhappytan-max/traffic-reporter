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
//     request), local KM-based filtering/ranking, persisting the top 5
//     candidates to KV, and rendering the mobile HTML page. On every
//     later request it only ever reads the candidates KV — see below,
//     this file's import graph makes a second TDX call structurally
//     impossible once the guard is armed/completed.
//   - GET /admin/cctv-hsinchu-frame/0..4    — STEP 3: fetches ONE JPEG
//     frame from the CCTV's own VideoStreamURL (a freeway.gov.tw MJPEG
//     stream), never touching TDX at all. This handler does not import
//     getAccessToken/fetchTdxJson/anything TDX-related — "0 TDX calls"
//     is enforced by the import graph itself, not just by convention.
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
//   5. Success -> filter/rank/select top 5 -> persist candidates (own
//      key, 1h TTL) -> flip 'armed' -> 'completed'. If that last write
//      fails, KV simply stays 'armed' (a failed put never partially
//      commits) — still fully locked either way.
// No auto-reset, no reset endpoint — a human must manually delete
// admin:cctv-hsinchu-probe-used:v1 (and, if desired,
// admin:cctv-hsinchu-candidates:v1) to run this again.
//
// Never placed anywhere in any response: TDX_CLIENT_ID/TDX_CLIENT_SECRET
// /the OAuth access token/any Authorization header value.

import { getAccessToken } from './auth.js';
import { fetchTdxJson, TdxApiError } from './client.js';
import { parseKM } from '../traffic/roadSectionLabel.js';

export const PROBE_USED_KEY = 'admin:cctv-hsinchu-probe-used:v1';
export const CANDIDATES_KEY = 'admin:cctv-hsinchu-candidates:v1';
const CANDIDATES_TTL_SECONDS = 3600; // 1 hour

// Full freeway CCTV list — deliberately NO $top here (unlike
// tdx/cctvProbe.js's $top=1) because candidate selection needs to
// compare across every 國道1號 record to find the 5 nearest to
// TARGET_KM; filtering happens locally in this Worker, per spec.
const CCTV_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$format=JSON';

const TARGET_ROAD_ID = '000010';
const TARGET_KM = 82.1; // 國道1號 82K+100
const CANDIDATE_COUNT = 5;

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

/**
 * Local filter + KM-distance ranking. Both directions kept — a PTZ
 * camera on the opposite carriageway may still be aimed at the incident
 * side, so direction is never used to exclude a candidate, only KM
 * distance decides the ranking, per spec.
 */
function selectNearestCandidates(records) {
  const withDistance = [];
  for (const record of records) {
    if (!isTargetRoad(record)) continue;
    const cctvId = firstDefinedField(record, ['CCTVID', 'CCTVId', 'ID']);
    const videoStreamUrl = firstDefinedField(record, ['VideoStreamURL']);
    const locationMile = firstDefinedField(record, ['LocationMile']);
    if (!cctvId || !videoStreamUrl) continue; // unusable without an ID or an image URL
    const km = parseKM(locationMile);
    if (km === null) continue; // can't rank without a parseable KM
    withDistance.push({
      cctvId,
      roadDirection: firstDefinedField(record, ['RoadDirection', 'Direction']),
      locationMile,
      positionLon: firstDefinedField(record, ['PositionLon']),
      positionLat: firstDefinedField(record, ['PositionLat']),
      videoStreamUrl,
      distanceKm: Math.abs(km - TARGET_KM),
    });
  }
  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
  return withDistance.slice(0, CANDIDATE_COUNT);
}

// Only these 6 fields are ever persisted — per spec, "只保存". distanceKm
// is re-derived from locationMile at render time instead (same "derive
// human-readable info at render time, not bake-time" convention this
// project already uses — see health.js).
function toStorableCandidate(c) {
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

function renderCandidateCards(candidates) {
  return candidates
    .map(
      (c, i) => `<div class="card">
    <h2>${i + 1}. ${escapeHtml(c.roadDirection || '未知方向')} / ${escapeHtml(c.locationMile || '未知里程')} / 距事故 ${candidateDistanceLabel(c)}</h2>
    <img src="/admin/cctv-hsinchu-frame/${i}" alt="CCTV ${escapeHtml(c.cctvId)}" loading="lazy">
  </div>`
    )
    .join('\n');
}

function renderStats({ metadataCalls, candidateCount }) {
  const note = `${candidateCount} 張 CCTV 圖片皆直接由高速公路局影像主機取得，未呼叫 TDX CCTV API。`;
  return `<div class="card">
    <h2>統計</h2>
    <div class="stats">TDX CCTV metadata calls: ${metadataCalls}
CCTV candidates: ${candidateCount}
CCTV image fetches: ${candidateCount}
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
    return htmlResponse(renderPage(renderCandidateCards(candidates) + renderStats({ metadataCalls: 0, candidateCount: candidates.length })), 200);
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
  const candidates = selectNearestCandidates(records);

  await persistCandidates(env.TRAFFIC_KV, candidates, new Date());

  // Metadata call genuinely succeeded — flip armed -> completed. If this
  // write fails, KV simply stays 'armed' — still fully locked either way.
  try {
    await env.TRAFFIC_KV.put(PROBE_USED_KEY, 'completed');
  } catch {
    // completionWriteFailed — guard stays 'armed', which is still fully
    // locked (0 TDX calls on every future request) — see module comment.
  }

  if (candidates.length === 0) {
    return htmlResponse(
      renderPage('<div class="card"><p class="warn">No 國道1號 CCTV candidates found near 82K+100 in this response.</p></div>' + renderStats({ metadataCalls: 1, candidateCount: 0 })),
      200
    );
  }

  return htmlResponse(renderPage(renderCandidateCards(candidates) + renderStats({ metadataCalls: 1, candidateCount: candidates.length })), 200);
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
