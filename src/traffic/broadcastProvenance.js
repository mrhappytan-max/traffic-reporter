// V1.8.6.4 — Broadcast Provenance Log. Best-effort, debug-only, Admin-Auth
// read. Purpose: answer "why did that LINE message look like that" for a
// REAL, actually-sent event, entirely from a short-lived KV record — never
// needing to re-query TDX/PBS to reconstruct what happened.
//
// Hard boundaries this module exists under (see PROJECT_HANDOFF.md's
// "V1.8.6.4 — broadcast provenance" section for the full design writeup):
//   - A record is written ONLY for an event that was ACTUALLY pushed to
//     >=1 LINE target this run — never an eligible-but-unsent event, a
//     deduped/suppressed one, or a run with 0 subscribers. The write site
//     (broadcastPipeline.js) enforces this by only calling
//     recordBroadcastProvenance() inside the `successfulTargets.length > 0`
//     branch, AFTER the real push already succeeded.
//   - Writing here can NEVER affect whether the real LINE push succeeded,
//     notified-state got written, or any other pipeline outcome —
//     recordBroadcastProvenance() never throws; a KV failure here
//     degrades to "this one event's provenance is missing," exactly like
//     tdx/usageLedger.js's own recording functions (same isolation
//     pattern, deliberately reused).
//   - Zero TDX/PBS/CCTV calls anywhere in this module. Every field in a
//     record comes from data the pipeline already computed/holds in
//     memory by the time a message was formatted and pushed.
//   - Never stores: a Secret, an Authorization header, a LINE userId/
//     groupId, or the full raw TDX/PBS JSON response. Only the
//     already-normalized event fields, the already-decided classification
//     evidence, and the exact LINE text that was actually sent.
//   - This module never re-derives eligibility or type classification —
//     `eligibilityReason` and `anomalyDetail` are threaded in by the
//     caller from values the SAME pipeline run already computed
//     (getBroadcastEligibility, messageFormat.js's own
//     resolveOtherAnomalyDetail) — see describeClassificationEvidence.

import { taipeiDateString } from '../tdx/usageLedger.js';

export const PROVENANCE_KEY_PREFIX = 'debug:broadcast-provenance:v1';
export const PROVENANCE_TTL_SECONDS = 48 * 60 * 60; // 48h, per instruction — debug-only, short-lived
const DESCRIPTION_SUMMARY_MAX_CHARS = 80;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
// Bounds how many raw KV entries a single admin request will ever fetch/
// parse, even if more exist within the 48h TTL window. This endpoint is
// Admin-triggered, on-demand, never on the hot broadcast path — but still
// kept bounded/cheap, same principle as usageLedger.js's compaction scans.
const MAX_ENTRIES_SCANNED = 300;

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

// 64 bits of randomness for key uniqueness only — never a security
// boundary (this KV key is never handed to anyone; unlike
// cctv/publishedImage.js's public opaque id, nothing external ever
// dereferences this one directly). Same construction as
// tdx/usageLedger.js's own opaqueId(), duplicated locally rather than
// exported/shared — both modules are meant to be independently readable,
// matching this project's existing pattern (see e.g.
// broadcastPipeline.js's own local safeErrorMessage).
function opaqueId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function truncate(text, maxChars) {
  if (typeof text !== 'string' || !text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Human-readable "why was this classified this way" trail, built ENTIRELY
 * from values the caller already has — never a second classification
 * pass. `eligibilityReason` must be the exact string
 * getBroadcastEligibility(event).reason already produced earlier in this
 * SAME pipeline run; `anomalyDetail` must be messageFormat.js's own
 * resolveOtherAnomalyDetail(event) result (or null) — the SAME rule the
 * LINE message itself was rendered from.
 *
 * @returns {string[]} short evidence lines, e.g.
 *   ["normalizedType=construction", "eligibilityReason=construction-impact-keyword"]
 *   ["normalizedType=other", "pbsCategory=obstruction", "eligibilityReason=other-anomaly-keyword"]
 *   ["normalizedType=other", "anomalyDetail=道路積水", "eligibilityReason=other-anomaly-keyword"]
 */
export function describeClassificationEvidence(event, eligibilityReason, anomalyDetail) {
  const evidence = [`normalizedType=${(event && event.type) || 'unknown'}`];
  if (event && event.pbsCategory) evidence.push(`pbsCategory=${event.pbsCategory}`);
  if (anomalyDetail && anomalyDetail.label) evidence.push(`anomalyDetail=${anomalyDetail.label}`);
  if (eligibilityReason) evidence.push(`eligibilityReason=${eligibilityReason}`);
  return evidence;
}

/**
 * Pure — builds the record to persist. No I/O, so it's directly unit-
 * testable independent of any KV mock. `image` describes the CCTV
 * attachment OUTCOME only (never the image bytes, never the R2 object
 * itself) — `urlPresent`/`expiresAt` describe the exact same public,
 * already-LINE-visible URL the message itself carried, nothing more
 * sensitive than that.
 *
 * @param {object} params
 * @param {object} params.event - the normalized event actually pushed
 * @param {string} params.formattedOutput - the EXACT text formatEventMessage produced (what was actually sent)
 * @param {string} [params.eligibilityReason] - see describeClassificationEvidence
 * @param {{emoji:string,label:string}|null} [params.anomalyDetail] - see describeClassificationEvidence
 * @param {{attached:boolean, urlPresent:boolean, expiresAt:string|null}} [params.image]
 * @param {Date} [params.now]
 */
export function buildProvenanceRecord({ event, formattedOutput, eligibilityReason, anomalyDetail, image, now = new Date() }) {
  return {
    timestamp: now.toISOString(),
    source: (event && event.source) || null,
    rawId: (event && event.rawId) || null,
    type: (event && event.type) || null,
    title: (event && event.title) || null,
    descriptionSummary: truncate(event && event.description, DESCRIPTION_SUMMARY_MAX_CHARS),
    road: (event && event.road) || null,
    direction: (event && event.direction) || null,
    startKM: event && event.startKM !== undefined ? event.startKM : null,
    endKM: event && event.endKM !== undefined ? event.endKM : null,
    displayKM: event && typeof event.displayKM === 'number' ? event.displayKM : null,
    location: (event && event.location) || null,
    locationDescription: (event && event.locationDescription) || null,
    pbsCategory: (event && event.pbsCategory) || null,
    classificationEvidence: describeClassificationEvidence(event, eligibilityReason, anomalyDetail),
    eligibilityReason: eligibilityReason || null,
    formattedOutput: formattedOutput || '',
    imageAttached: Boolean(image && image.attached),
    imageUrlPresent: Boolean(image && image.urlPresent),
    imageExpiresAt: (image && image.expiresAt) || null,
  };
}

/**
 * Best-effort, fully isolated write — see module comment. NEVER throws;
 * any failure (missing KV binding, KV outage, JSON.stringify failure on a
 * malformed record) degrades to `{committed:false}`, exactly like
 * tdx/usageLedger.js's commitTdxUsageBatch. The caller (broadcastPipeline.js)
 * does not need to check the result — a failed write here must never
 * change anything about the real LINE push or notified-state outcome,
 * both of which already completed before this is ever called.
 */
export async function recordBroadcastProvenance(kv, record, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const date = taipeiDateString(now);
    const key = `${PROVENANCE_KEY_PREFIX}:${date}:${now.getTime()}:${opaqueId()}`;
    await kv.put(key, JSON.stringify(record), { expirationTtl: PROVENANCE_TTL_SECONDS });
    return { committed: true, key };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/**
 * Admin-only read (GET /admin/broadcast-provenance, Admin-Basic-Auth-
 * gated at the route level — see index.js). Bounded KV list+get, newest
 * first, optional source/road/rawId filters — never touches TDX/PBS/LINE,
 * pure KV reads only. Never throws — a KV outage here degrades to an
 * empty list with `kvAvailable:false`, same fail-safe shape as
 * tdx/usageLedger.js's readTdxUsageSummary.
 */
export async function listBroadcastProvenance(kv, { limit = DEFAULT_LIST_LIMIT, source, road, rawId } = {}) {
  const boundedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || DEFAULT_LIST_LIMIT));
  if (!kv) return { records: [], kvAvailable: false };

  try {
    const keys = [];
    let cursor;
    for (;;) {
      const page = await kv.list({ prefix: `${PROVENANCE_KEY_PREFIX}:`, cursor });
      for (const k of page.keys || []) keys.push(k.name);
      if (page.list_complete || !page.cursor || keys.length >= MAX_ENTRIES_SCANNED) break;
      cursor = page.cursor;
    }

    // Keys embed <date>:<epochMs>:<opaqueId> — lexicographic order already
    // matches chronological order (13-digit epochMs for the foreseeable
    // future, same construction as usageLedger.js's own entry keys), so
    // list() returns oldest-first; take the most recent slice, then
    // reverse for newest-first display.
    const newestFirstKeys = keys.slice(-MAX_ENTRIES_SCANNED).reverse();

    const records = [];
    for (const key of newestFirstKeys) {
      if (records.length >= boundedLimit) break;
      const raw = await kv.get(key);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue; // corrupt entry — skip it, never let one bad record break the listing
      }
      if (!record || typeof record !== 'object') continue;
      if (source && record.source !== source) continue;
      if (road && record.road !== road) continue;
      if (rawId && record.rawId !== rawId) continue;
      records.push(record);
    }

    return { records, kvAvailable: true };
  } catch (err) {
    return { records: [], kvAvailable: false, error: safeErrorMessage(err) };
  }
}

/**
 * GET /admin/broadcast-provenance (Admin-Basic-Auth-gated and method-
 * restricted at the route level — see index.js, which returns 405 for
 * every non-GET method on this path BEFORE this handler is ever reached).
 * Zero TDX/PBS/LINE calls — pure KV read via listBroadcastProvenance.
 * `?limit=` (default 20, max 100), `?source=`/`?road=`/`?rawId=` optional
 * filters, matched via listBroadcastProvenance's own bounded scan.
 */
export async function handleBroadcastProvenance(env, request) {
  const url = new URL(request.url);
  const { records, kvAvailable, error } = await listBroadcastProvenance(env.TRAFFIC_KV, {
    limit: url.searchParams.get('limit'),
    source: url.searchParams.get('source') || undefined,
    road: url.searchParams.get('road') || undefined,
    rawId: url.searchParams.get('rawId') || undefined,
  });

  return Response.json(
    { kvAvailable, count: records.length, records, ...(error ? { error } : {}) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
