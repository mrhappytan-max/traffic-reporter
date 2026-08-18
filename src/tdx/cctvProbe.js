// V1.7 — one-time Production CCTV feasibility probe. GET /admin/cctv-probe
// (Admin Auth gated — see index.js's ADMIN_PATHS / security/adminAuth.js).
// Purely diagnostic: answers "does actually FETCHING a CCTV image go
// through tdx.transportdata.tw / consume TDX quota, once we already have
// its URL from one metadata lookup?" — nothing here is wired into the
// real Cron/broadcast pipeline, and this module is never imported by
// scheduled.js or any broadcast code path.
//
// PRE-ARM design (this round's fix — see the round's own comment below
// for why): the guiding principle is "寧可一次測試失敗，也不能因
// refresh/retry 意外再次消耗 TDX" — a test that fails safely is fine; a
// test that silently re-spends quota on a browser refresh is not.
//
// admin:cctv-probe-used:v1 (own isolated KV key, same TRAFFIC_KV
// namespace as everything else in this project) has three states:
//   - (absent)  — never attempted. The only state that proceeds to TDX.
//   - 'armed'   — an attempt is in flight or failed partway through.
//     LOCKED. No further TDX calls, ever, until a human manually
//     deletes this KV key — there is deliberately no auto-reset and no
//     /admin/cctv-probe-reset endpoint.
//   - 'completed' — the CCTV metadata call genuinely succeeded once.
//     LOCKED, same as 'armed' (0 further TDX calls), but reported with
//     different, clearer wording.
//
// Ordering, enforced by construction:
//   1. Read the KV state. 'armed' or 'completed' -> stop immediately,
//      0 TDX calls (not even token acquisition).
//   2. (absent) -> write 'armed' BEFORE doing anything TDX-related at
//      all, including getAccessToken(). If this write itself fails,
//      fail closed with 503 — 0 TDX calls, no retry.
//   3. Only after 'armed' is durably written does getAccessToken() run.
//      If OAuth fails, KV stays 'armed' — never auto-cleared, never
//      auto-retried. The probe is now permanently locked until a human
//      resets it.
//   4. Only after OAuth succeeds does the ONE allowed CCTV metadata
//      call happen. If it fails, same as step 3: KV stays 'armed',
//      locked, no retry.
//   5. Only after the metadata call genuinely succeeds does KV flip
//      'armed' -> 'completed'. If THAT write itself fails, the KV value
//      simply remains 'armed' (a failed put never partially commits) —
//      still fully locked, still 0 TDX calls on the next request either
//      way. Reported via `completionWriteFailed: true`, but this never
//      re-opens the guard.
//
// Also still true from the original design:
//   - Exactly one call to the CCTV metadata endpoint per invocation — a
//     single fetchTdxJson() call, no loop, no pagination, no second
//     CCTV, no VD/CMS/Bus Alert call anywhere in this module.
//   - The image URL fetch (STEP 2) sends NO Authorization header at
//     all, never re-calls the CCTV metadata endpoint, and never
//     acquires a new/another TDX token — it is a completely separate,
//     anonymous HTTP request to whatever URL the metadata response
//     itself contained.
//   - TDX_CLIENT_ID / TDX_CLIENT_SECRET / the OAuth access token / any
//     Authorization header value are NEVER placed in the response body.

import { getAccessToken } from './auth.js';
import { fetchTdxJson, TdxApiError } from './client.js';
import { commitTdxUsageBatch } from './usageLedger.js';

const CCTV_PROBE_USED_KEY = 'admin:cctv-probe-used:v1';
const CCTV_URL = 'https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/Freeway?$top=1&$format=JSON';
const MAX_REDIRECTS = 5;

// Not guessed — this is the full candidate list scanned against the
// REAL response from STEP 1; whichever key actually exists in the real
// record is reported back as `imageUrlField`, never assumed in advance.
const CANDIDATE_IMAGE_FIELDS = [
  'VideoStreamURL', 'VideoImageURL', 'ImageURL', 'URL', 'StreamURL', 'VideoURL', 'PictureURL', 'SnapshotURL',
];

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function firstDefinedField(record, candidateNames) {
  for (const name of candidateNames) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') return record[name];
  }
  return null;
}

/**
 * STEP 2 — fetch the image URL directly. Deliberately sends NO
 * Authorization header (that's the whole point of the probe) and never
 * touches the TDX token/metadata endpoints. Follows redirects manually,
 * up to MAX_REDIRECTS hops, each fetched exactly once (not a retry loop
 * — a redirect chain is one logical navigation, same as a browser
 * following Location headers once each). Never reads the response body
 * (no image bytes ever enter this process's memory beyond headers).
 */
async function probeImageUrl(initialUrl) {
  let currentUrl = initialUrl;
  const hopHostnames = [currentUrl.hostname];
  let redirectCount = 0;
  let finalRes = null;

  while (true) {
    let res;
    try {
      res = await fetch(currentUrl.toString(), { redirect: 'manual' }); // no Authorization header, intentionally
    } catch {
      break; // network error -> fall through to the "no finalRes" branch below
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && redirectCount < MAX_REDIRECTS) {
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        finalRes = res; // malformed Location -> stop here, report what we have
        break;
      }
      hopHostnames.push(currentUrl.hostname);
      redirectCount += 1;
      continue;
    }

    finalRes = res;
    break;
  }

  const touchesTdxHost = hopHostnames.some((h) => h.includes('tdx.transportdata.tw'));

  if (!finalRes) {
    return {
      attempted: true,
      imageFetchOk: false,
      httpStatus: null,
      contentType: null,
      originalHostname: initialUrl.hostname,
      finalHostname: currentUrl.hostname,
      redirectCount,
      touchesTdxHost,
      wwwAuthenticatePresent: false,
    };
  }

  // Release the connection without reading any body bytes — see module
  // comment: image binary must never enter this response.
  try {
    finalRes.body?.cancel?.();
  } catch {
    // best-effort only
  }

  return {
    attempted: true,
    imageFetchOk: finalRes.status >= 200 && finalRes.status < 300,
    httpStatus: finalRes.status,
    contentType: finalRes.headers.get('content-type'),
    originalHostname: initialUrl.hostname,
    finalHostname: currentUrl.hostname,
    redirectCount,
    touchesTdxHost,
    wwwAuthenticatePresent: Boolean(finalRes.headers.get('www-authenticate')),
  };
}

/**
 * STEP 3 — verdict. Deliberately hedged language only ("預期"/"unknown")
 * — this NEVER claims to have verified TDX's actual billing/quota
 * backend, only what this one HTTP probe observed.
 */
function buildVerdict(step2) {
  let imageRequiresTdxAuthorization = 'unknown';
  if (step2.attempted) {
    if (step2.wwwAuthenticatePresent) imageRequiresTdxAuthorization = true;
    else if (step2.imageFetchOk) imageRequiresTdxAuthorization = false;
  }

  const imageTrafficTouchesTdxHost = step2.attempted ? step2.touchesTdxHost : false;

  let likelyExtraTdxApiQuotaPerImage = 'unknown';
  if (step2.attempted) {
    if (imageTrafficTouchesTdxHost) likelyExtraTdxApiQuotaPerImage = 'likely yes';
    else if (step2.imageFetchOk) likelyExtraTdxApiQuotaPerImage = 0;
  }

  let candidateArchitecture = null;
  if (step2.attempted && step2.imageFetchOk && imageRequiresTdxAuthorization === false && !imageTrafficTouchesTdxHost) {
    candidateArchitecture = 'TDX metadata 可快取，事故時直接抓 CCTV 影像，預期不需要額外 TDX API data call';
  }

  return {
    cctvMetadataCalls: 1,
    imageRequiresTdxAuthorization,
    imageTrafficTouchesTdxHost,
    likelyExtraTdxApiQuotaPerImage,
    candidateArchitecture,
  };
}

export async function handleCctvProbe(env) {
  // 0. Read the current KV state — BEFORE any TDX call whatsoever
  // (including token acquisition). A read failure fails CLOSED: refuse
  // to proceed rather than risk spending quota with no way to track it.
  if (env.TRAFFIC_KV === undefined) {
    return jsonResponse(
      { status: 'error', stage: 'kv-guard', message: 'TRAFFIC_KV binding not configured; refusing to call TDX.' },
      503
    );
  }

  let state;
  try {
    state = await env.TRAFFIC_KV.get(CCTV_PROBE_USED_KEY);
  } catch {
    return jsonResponse(
      { status: 'error', stage: 'kv-guard', message: 'Could not verify one-time-use state; refusing to call TDX.' },
      503
    );
  }

  if (state === 'armed') {
    return jsonResponse(
      { status: 'locked', message: 'Probe locked; a previous attempt has already been armed. Manual reset required.' },
      200
    );
  }
  if (state === 'completed') {
    return jsonResponse({ status: 'already-completed', message: 'Probe already completed.' }, 200);
  }

  // 1. PRE-ARM — write 'armed' BEFORE any TDX-related call at all,
  // including token acquisition. If this write itself fails, fail
  // closed: 0 TDX calls, no retry, nothing proceeds.
  try {
    await env.TRAFFIC_KV.put(CCTV_PROBE_USED_KEY, 'armed');
  } catch {
    return jsonResponse(
      { status: 'error', stage: 'pre-arm', message: 'Could not arm the one-time-use guard; refusing to call TDX.' },
      503
    );
  }

  // 2. OAuth token — reuses the project's existing cache-first flow
  // (memory -> KV -> real OAuth). Separate from the CCTV metadata call
  // budget, same convention as every other TDX-calling code path in
  // this project (see tdx/fetchAll.js's tokenOk vs. per-source calls).
  // Never surfaced in any response below. On failure, KV stays 'armed'
  // — never auto-cleared, never auto-retried; a human must delete
  // admin:cctv-probe-used:v1 to try again.
  // V1.8.6: exactly ONE invocation for usage-ledger purposes — one
  // in-memory batch, committed context='admin-cctv' at every exit point
  // below that could have made a real TDX call. Best-effort; see
  // usageLedger.js.
  const tdxUsageSink = [];

  let accessToken;
  try {
    accessToken = await getAccessToken(env, tdxUsageSink);
  } catch (err) {
    await commitTdxUsageBatch(env.TRAFFIC_KV, { context: 'admin-cctv', records: tdxUsageSink });
    return jsonResponse(
      {
        status: 'locked',
        stage: 'oauth',
        cctvMetadataCalls: 0,
        message: 'probe locked after failed attempt; manual reset required',
        error: err && err.message ? err.message : 'TDX token acquisition failed',
      },
      502
    );
  }

  // 3. STEP 1 — the ONE allowed CCTV metadata call. No retry on
  // failure. On failure, KV stays 'armed' — same manual-reset-only
  // policy as the OAuth failure path above.
  let cctvJson;
  try {
    cctvJson = await fetchTdxJson(CCTV_URL, accessToken, { source: 'cctv-probe', usageSink: tdxUsageSink });
  } catch (err) {
    await commitTdxUsageBatch(env.TRAFFIC_KV, { context: 'admin-cctv', records: tdxUsageSink });
    return jsonResponse(
      {
        status: 'locked',
        stage: 'cctv-metadata',
        cctvMetadataCalls: 1,
        httpStatus: err instanceof TdxApiError ? err.status : null,
        message: 'probe locked after failed attempt; manual reset required',
        error: err && err.message ? err.message : 'TDX CCTV metadata request failed',
      },
      502
    );
  }
  await commitTdxUsageBatch(env.TRAFFIC_KV, { context: 'admin-cctv', records: tdxUsageSink });

  // Metadata call genuinely succeeded — flip armed -> completed. If
  // THIS write itself fails, the KV value simply stays 'armed' (a
  // failed put never partially commits an old value) — still fully
  // locked, still 0 TDX calls on the next request either way.
  let completionWriteFailed = false;
  try {
    await env.TRAFFIC_KV.put(CCTV_PROBE_USED_KEY, 'completed');
  } catch {
    completionWriteFailed = true; // see comment above — the guard is still intact regardless
  }

  const records = Array.isArray(cctvJson) ? cctvJson : cctvJson.CCTVs || cctvJson.Data || [];
  const topLevelFields = Array.isArray(cctvJson) ? null : Object.keys(cctvJson);
  const record = records[0] || null;

  if (!record) {
    return jsonResponse(
      {
        status: 'ok',
        cctvMetadataCalls: 1,
        completionWriteFailed,
        topLevelFields,
        recordCount: records.length,
        message: 'No CCTV records returned in this response — nothing further to probe.',
      },
      200
    );
  }

  const recordFields = Object.keys(record);
  const imageUrlField = CANDIDATE_IMAGE_FIELDS.find((f) => typeof record[f] === 'string' && record[f]) || null;
  const imageUrlRaw = imageUrlField ? record[imageUrlField] : null;

  const step1 = {
    topLevelFields,
    recordFields,
    cctvId: firstDefinedField(record, ['CCTVID', 'CCTVId', 'ID']),
    roadName: firstDefinedField(record, ['RoadName']),
    roadId: firstDefinedField(record, ['RoadID', 'RoadId']),
    direction: firstDefinedField(record, ['RoadDirection', 'Direction']),
    location: firstDefinedField(record, ['LocationDescription', 'LocationMile', 'Mile']),
    positionLon: firstDefinedField(record, ['PositionLon']),
    positionLat: firstDefinedField(record, ['PositionLat']),
    imageUrlField,
    imageUrlHostname: null,
    hasSensitiveQuery: false,
  };

  let imageUrl = null;
  if (imageUrlRaw) {
    try {
      imageUrl = new URL(imageUrlRaw);
      step1.imageUrlHostname = imageUrl.hostname;
      step1.hasSensitiveQuery = /token|signature|sig=|expire|auth/i.test(imageUrl.search);
    } catch {
      step1.imageUrlHostname = null;
    }
  }

  const step2 = imageUrl ? await probeImageUrl(imageUrl) : { attempted: false };
  const step3 = buildVerdict(step2);

  return jsonResponse(
    {
      status: 'ok',
      cctvMetadataCalls: 1,
      completionWriteFailed,
      step1,
      step2,
      step3,
    },
    200
  );
}
