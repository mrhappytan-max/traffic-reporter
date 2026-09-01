// V2.4.0 — TDX_FREEWAY_PROVINCIAL_TO_UNIFIED_AI_PIPELINE. Cross-source
// (PBS + TDX freeway/highway), multi-hour "Recent Incident Memory" —
// order section 九/十/十四's own design, directly extending
// incidentSuppression.js's already-proven shape (single flat KV key,
// road+direction group key, in-memory TTL pruning on every touch, WRITE_
// ON_CHANGE) rather than inventing a new storage idiom. See the read-only
// V2.4.0 architecture audit (TDX_FREEWAY_PROVINCIAL_TO_AI_MAIN_AUDIT,
// section 九) for the full reasoning behind KV over D1/Durable Object —
// this project has zero D1/Durable Object bindings today (wrangler.jsonc
// only declares kv_namespaces/r2_buckets/queues), and the event volume
// this whole codebase already estimates itself by (50/100/200 events/
// day, see 07_KNOWN_ISSUES.md's V2.3.0/V2.2.0 KV-cost writeups) has no
// need for a relational store.
//
// WHAT THIS IS FOR (order section 十一): "AI 不自己記憶，Cloudflare 保存
// 短期事故狀態，每次新事件進來時，只找可能相關的近期紀錄，一起交給 AI" —
// this module is ONLY the candidate-retrieval/bookkeeping layer. It never
// decides sameIncident/materialChange/notify itself — that is
// aiDecisionEngine.js's job, now given this module's candidates as extra
// prompt context (see that module's own V2.4.0 comment). This module is
// pure I/O + pure candidate-selection math, zero AI awareness.
//
// WHY A SEPARATE KEY FROM incidentSuppression.js, NOT A REPLACEMENT
// -------------------------------------------------------------------
// incidentSuppression.js stays completely unchanged (order section
// 十三 — "不要大拆，保留現有 incidentSuppression 作短時間重複推播 safety
// net"). It is a defense-in-depth code-level suppression check,
// independent of whatever the AI itself concludes from this module's
// memory context. The two intentionally do not share storage: this
// module's job is "give the AI enough context to reason well," not "be
// the thing that blocks a push" — that responsibility still belongs to
// incidentSuppression.js (for accident type) and to the AI's own
// `notify` field (informed by this module's candidates).
//
// SCOPE — unlike incidentSuppression.js (accident type only), this
// module records EVERY event type reaching runAiApprovedPbsBroadcast/
// its TDX equivalent, because a TDX/PBS closure or control event three
// hours later is exactly as valid a "same incident, still going" case as
// an accident is (order's own CASE E/F use no type restriction).
//
// KV COST — gets=1/event (one read of the single flat key), puts<=1/event
// (WRITE_ON_CHANGE via util/contentEqual.js — a sighting that changes
// nothing real, e.g. an unrelated event in a different group, still
// writes because THIS event's own record is always upserted; but two
// back-to-back identical re-reports of the exact same content produce
// byte-identical next-state and skip the write). Order section 十四's
// hard limits (<=1 get, <=1 put per event) are enforced by construction:
// exactly one readIncidentMemory() call and exactly one
// persistIncidentMemory() call per event, never a loop, never a
// per-candidate KV op. No KV list, no KV delete anywhere in this module.

import { parseKM } from './roadSectionLabel.js';
import { contentEqual, canonicalJson } from '../util/contentEqual.js';

export const INCIDENT_MEMORY_KV_KEY = 'traffic:incident-memory:v1';

// order section 九 — "落在 6-12 小時建議區間中段".
export const INCIDENT_MEMORY_TTL_HOURS = 8;
export const INCIDENT_MEMORY_TTL_MS = INCIDENT_MEMORY_TTL_HOURS * 60 * 60 * 1000;

// order section 十 — candidate prefilter thresholds. Deliberately the
// SAME real-world values this codebase has already shipped and tested
// for an equivalent "is this plausibly the same incident" question:
// crossSourceDedup.js's own CROSS_SOURCE_MAX_DISTANCE_METERS (1000m) and
// incidentSuppression.js's own INCIDENT_MAX_KM_DIFF (1.5km) — not
// independently re-derived, so a future reader tuning "how close is
// close enough" only has one precedent to reconcile, not three.
export const INCIDENT_MEMORY_MAX_DISTANCE_METERS = 1000;
export const INCIDENT_MEMORY_MAX_KM_DIFF = 1.5;

// order section 十 — "最多交 AI：3~5 筆". Upper bound; a group with fewer
// eligible records simply hands over fewer.
export const MAX_MEMORY_CANDIDATES = 5;

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

/** Same `${road}|${direction}` group-key idiom incidentSuppression.js already uses — exported here (unlike that module's private copy) because callers (aiApprovedPbsBroadcast.js, debugPush.js's TDX branch) need it to build a candidate's own group before ever touching KV. */
export function incidentMemoryGroupKey(road, direction) {
  return `${road || ''}|${direction || ''}`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * A single representative KM/coordinate description for a candidate
 * event — the same shape both a fresh incoming event and an already-
 * stored IncidentRecord expose, so proximity matching below needs only
 * one comparison function for both directions.
 */
function proximityMatch(a, b) {
  const aHasCoords = typeof a.latitude === 'number' && typeof a.longitude === 'number';
  const bHasCoords = typeof b.latitude === 'number' && typeof b.longitude === 'number';
  if (aHasCoords && bHasCoords) {
    return haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude) <= INCIDENT_MEMORY_MAX_DISTANCE_METERS;
  }
  const aKm = typeof a.km === 'number' ? a.km : null;
  const bKm = typeof b.km === 'number' ? b.km : null;
  if (aKm === null || bKm === null) return false; // no shared positional signal on either side -> don't guess
  return Math.abs(aKm - bKm) <= INCIDENT_MEMORY_MAX_KM_DIFF;
}

/**
 * Read-only. Mirrors incidentSuppression.js#readIncidentSuppressionState's
 * exact shape/fail-open discipline: a KV outage or corrupt blob degrades
 * to {} (no candidates handed to AI this event — never a reason to block
 * the event itself), not a thrown error.
 */
export async function readIncidentMemory(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', groups: {}, existed: false };
  }
  try {
    const raw = await kv.get(INCIDENT_MEMORY_KV_KEY);
    let groups = {};
    let existed = false;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.groups && typeof parsed.groups === 'object') {
          groups = parsed.groups;
          existed = true;
        }
      } catch {
        groups = {};
      }
    }
    return { kvAvailable: true, kvError: null, groups, existed };
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), groups: {}, existed: false };
  }
}

/**
 * Pure, zero I/O — order section 十一's two-stage prefilter: (1) exact
 * road+direction group lookup (O(1) map access, never a KV list/scan),
 * (2) within that one group, TTL age + KM-or-coordinate proximity,
 * newest-first, capped at MAX_MEMORY_CANDIDATES. This is the ONLY thing
 * that ever gets handed to the AI as "recent incident context" — never
 * the raw `groups` object, never a different group's records.
 *
 * @param {object} groups - readIncidentMemory()'s own `groups` output
 * @param {{road:string, direction:string, km?:number|null, latitude?:number|null, longitude?:number|null}} eventLocation
 * @param {Date} now
 * @param {{excludeEventId?:string|null}} [options] - `excludeEventId`
 *   (the CURRENT event's own `source:rawId`-style identity) filters out
 *   any candidate record whose most recent sighting was THIS SAME event
 *   content (see buildIncidentMemoryUpdate's own `lastEventId` field) —
 *   without this, a NEW->UPDATED lifecycle transition for the identical
 *   underlying event would "discover" its own immediately-prior sighting
 *   as if it were a separate nearby incident, which is never useful
 *   context (an event is never a meaningful sameIncident/materialChange
 *   comparison against itself) and would otherwise force a fresh AI call
 *   on every such transition purely because the memory-context cache-key
 *   fingerprint (aiDecisionEngine.js's own V2.4.0 mechanism) changed from
 *   empty to "itself".
 * @returns {object[]} up to MAX_MEMORY_CANDIDATES IncidentRecord, newest lastSeenAt first
 */
export function selectMemoryCandidates(groups, eventLocation, now, { excludeEventId = null } = {}) {
  const key = incidentMemoryGroupKey(eventLocation.road, eventLocation.direction);
  const records = (groups && groups[key]) || [];
  return records
    .filter((r) => r && r.lastSeenAt && now.getTime() - new Date(r.lastSeenAt).getTime() < INCIDENT_MEMORY_TTL_MS)
    .filter((r) => !excludeEventId || r.lastEventId !== excludeEventId)
    .filter((r) => proximityMatch(eventLocation, r))
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
    .slice(0, MAX_MEMORY_CANDIDATES);
}

/**
 * Deterministic, key-order-independent fingerprint of a candidate list —
 * reused as an EXTRA input to aiDecisionEngine.js's AI decision cache key
 * (see that module's own V2.4.0 comment) so a genuinely different memory
 * context (a new nearby sighting appeared since the last identical-
 * content call) produces a different cache key instead of silently
 * replaying a stale cached decision. Deliberately only `incidentKey` +
 * `lastSeenAt` per candidate — enough to detect "the context changed",
 * never the full record (keeps the cache key short and never leaks
 * latestRawSummary/PBS text into a hash nobody reads back).
 */
export function buildMemoryContextFingerprint(candidates) {
  if (!candidates || candidates.length === 0) return '';
  return canonicalJson(candidates.map((c) => ({ incidentKey: c.incidentKey, lastSeenAt: c.lastSeenAt })));
}

/**
 * A single, source-agnostic {road, direction, km, latitude, longitude}
 * description of WHERE an event is — the one shape every function in
 * this module (selectMemoryCandidates/buildIncidentMemoryUpdate) needs,
 * built from whichever fields the caller's normalized event actually
 * carries. Mirrors dynamicCollage.js's own eventTargetKm() precedent
 * (midpoint of startKM/endKM when both present, otherwise whichever one
 * parses, otherwise displayKM) — not re-derived from scratch, same
 * "structured fields only, never a free-text guess" discipline. Works
 * unchanged for both a PBS-normalized event (displayKM + latitude/
 * longitude, no startKM/endKM — see pbs/normalize.js's own header
 * comment) and a TDX-normalized event (startKM/endKM, no coordinates —
 * see tdx/normalize.js#normalizeRoadEvent's own return shape).
 */
export function deriveEventLocationForMemory(event) {
  const start = typeof event.startKM === 'number' ? event.startKM : parseKM(event.startKM);
  const end = typeof event.endKM === 'number' ? event.endKM : parseKM(event.endKM);
  let km = null;
  if (start !== null && end !== null) km = (start + end) / 2;
  else if (start !== null || end !== null) km = start ?? end;
  else if (typeof event.displayKM === 'number' && Number.isFinite(event.displayKM)) km = event.displayKM;
  return {
    road: event.road || '',
    direction: event.direction || '',
    km,
    latitude: typeof event.latitude === 'number' ? event.latitude : null,
    longitude: typeof event.longitude === 'number' ? event.longitude : null,
  };
}

function generateIncidentKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pure, zero I/O. Builds the NEXT `groups` state after one event's own
 * sighting: (1) age out every record past INCIDENT_MEMORY_TTL_MS across
 * ALL groups (same "prune on every touch, no separate sweep job" idiom
 * incidentSuppression.js already uses — order section 十四's "讀取後記憶
 * 體裁剪，下次必要寫回時自然移除"), (2) upsert this event's own record —
 * either update the matched candidate (if `matchedIncidentKey` is given,
 * from the AI's own sameIncident verdict) or append a brand-new record
 * with a fresh incidentKey.
 *
 * @param {object} groups - the CURRENT (pre-prune) groups, from readIncidentMemory
 * @param {{road:string, direction:string, km?:number|null, latitude?:number|null,
 *   longitude?:number|null, eventType:string, source:string,
 *   eventId?:string, rawSummary?:string}} event - `eventId` (this event's
 *   own `source:rawId`-style identity) is stored as the record's
 *   `lastEventId` purely so a LATER call's selectMemoryCandidates can
 *   exclude "itself" — see that function's own `excludeEventId` doc.
 * @param {{matchedIncidentKey?:string|null, notified:boolean, now:Date}} options
 *   `matchedIncidentKey` — set by the caller when the AI verdict said
 *   sameIncident:true against one of selectMemoryCandidates()'s own
 *   results; that record is updated IN PLACE (lastSeenAt/latestSource/
 *   latestRawSummary always refresh, lastNotifiedAt/primarySource only
 *   when `notified` is true this event). Omitted/null -> a new incident
 *   family starts.
 * @returns {object} the next `groups` object (new object — caller diffs
 *   it against the original via contentEqual before writing, see
 *   persistIncidentMemory below)
 */
export function buildIncidentMemoryUpdate(groups, event, { matchedIncidentKey = null, notified = false, now = new Date() } = {}) {
  const nextGroups = {};
  for (const [group, records] of Object.entries(groups || {})) {
    const alive = (records || []).filter(
      (r) => r && r.lastSeenAt && now.getTime() - new Date(r.lastSeenAt).getTime() < INCIDENT_MEMORY_TTL_MS
    );
    if (alive.length > 0) nextGroups[group] = alive;
  }

  const key = incidentMemoryGroupKey(event.road, event.direction);
  const groupRecords = nextGroups[key] ? [...nextGroups[key]] : [];
  const nowIso = now.toISOString();

  const matchIndex = matchedIncidentKey ? groupRecords.findIndex((r) => r.incidentKey === matchedIncidentKey) : -1;

  if (matchIndex >= 0) {
    const previous = groupRecords[matchIndex];
    groupRecords[matchIndex] = {
      ...previous,
      km: typeof event.km === 'number' ? event.km : previous.km,
      latitude: typeof event.latitude === 'number' ? event.latitude : previous.latitude,
      longitude: typeof event.longitude === 'number' ? event.longitude : previous.longitude,
      eventType: event.eventType || previous.eventType,
      lastSeenAt: nowIso,
      lastNotifiedAt: notified ? nowIso : previous.lastNotifiedAt,
      // 誰最近確認了這個事故還在，誰就是 latestSource；primarySource只在
      // 這次真的觸發通知時才交接（order CASE A/B：「不再LINE→更新
      // primarySource=TDX」是指已通知過的事故被更權威的來源接手，不是
      // 每次任何來源看到都交接）。
      latestSource: event.source,
      primarySource: notified ? event.source : previous.primarySource,
      currentStatus: 'active',
      latestRawSummary: event.rawSummary || previous.latestRawSummary,
      lastEventId: event.eventId || previous.lastEventId || null,
    };
  } else {
    groupRecords.push({
      incidentKey: generateIncidentKey(),
      road: event.road || '',
      direction: event.direction || '',
      km: typeof event.km === 'number' ? event.km : null,
      latitude: typeof event.latitude === 'number' ? event.latitude : null,
      longitude: typeof event.longitude === 'number' ? event.longitude : null,
      eventType: event.eventType || '',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      lastNotifiedAt: notified ? nowIso : null,
      primarySource: event.source,
      latestSource: event.source,
      currentStatus: 'active',
      latestRawSummary: event.rawSummary || '',
      lastEventId: event.eventId || null,
    });
  }

  nextGroups[key] = groupRecords;
  return nextGroups;
}

/**
 * WRITE_ON_CHANGE, same pattern as incidentSuppression.js#persistIncidentSuppressionState
 * (see that function — this is deliberately byte-for-byte the same
 * shape, just a different KV key/field name). Exactly one KV put at
 * most, never a list, never a delete.
 */
export async function persistIncidentMemory(kv, nextGroups, { previousGroups, previousStateExisted = false } = {}, now = new Date()) {
  try {
    if (previousStateExisted && contentEqual(previousGroups, nextGroups)) {
      return { committed: true, written: false };
    }
    await kv.put(INCIDENT_MEMORY_KV_KEY, JSON.stringify({ groups: nextGroups, updatedAt: now.toISOString() }));
    return { committed: true, written: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}
