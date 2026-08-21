// V57 Shared Traffic Feed — read-only completed-product persistence.
//
// WHY THIS EXISTS
// ---------------
// Another project (雙鐵進站小幫手 / rail-traffic-consumer) re-broadcasts this
// Worker's *finished* traffic reports to its own LINE audience, WITHOUT ever
// calling TDX, PBS, freeway.gov.tw or the CCTV pipeline itself. Before V57 the
// finished text and the published collage URL were built inside
// runLineBroadcast and then discarded — nothing durable held a completed
// product. This module is the minimum persistence that closes that gap.
//
// HARD BOUNDARIES
// ---------------
// - This module NEVER fetches anything: no TDX, no PBS, no freeway.gov.tw
//   frames, no CCTV metadata, and it never composes or re-composes a collage.
//   It consumes `result.completedProducts` from broadcastPipeline.js, which is
//   built from work that run had already done for its own broadcast.
// - The CCTV image is only ever RECORDED, never REQUESTED. If this run's
//   broadcast did not compose one for an event, the feed carries text only.
//   Serving the feed therefore adds exactly zero CCTV compositions.
// - The original LINE broadcast does NOT depend on this module. Snapshot
//   persistence is a separate, isolated step at the very end of scheduled.js;
//   if it fails it logs and the Cron run carries on.
// - Nothing here writes to traffic:dedupe-state, traffic:baseline,
//   line:notified-state, line:subscriptions, the TDX usage ledger, the health
//   snapshot, or the R2 image bucket.
//
// WHY IT CONSUMES completedProducts RATHER THAN RE-FILTERING
// ----------------------------------------------------------
// Broadcast-worthiness on this Worker is the product of several independent
// gates: type/keyword eligibility (broadcastRules.js), the 60-minute relevance
// window (effectiveWindow.js), congestion clustering (congestionCluster.js) and
// accident-level incident suppression (incidentSuppression.js). Re-deriving
// that chain here would duplicate it and then silently drift from it — and a
// drift in the permissive direction means another project broadcasting things
// this one deliberately decided not to. So the feed mirrors exactly what the
// broadcast pipeline itself concluded, by construction.
//
// FIELD SEMANTICS (the consumer's contract depends on these)
// ----------------------------------------------------------
// eventId     `${source}:${rawId}` — the same key dedupe.js uses, stable across
//             content updates. Congestion clusters carry a deterministic
//             composite rawId (congestionCluster.js), so they are stable too.
// fingerprint SHA-256 (truncated) of dedupe.js#computeFingerprint, which
//             deliberately excludes updatedAt / publish timestamps. A
//             timestamp-only refresh does NOT change it, so a consumer keyed on
//             it will not re-push. This is the anti-jitter guarantee.
// updatedAt   NOT TDX's updatedAt. "When this fingerprint was first established
//             in the feed" — it only advances when the fingerprint actually
//             changes, and is therefore monotonic and jitter-free. The
//             consumer's push-eligibility window keys off this field.
// createdAt   When this eventId first entered the feed, carried forward
//             unchanged across content updates.
// text        The finished LINE broadcast text, byte-identical to what this
//             Worker sends its own subscribers. Consumers must not re-compose.
// imageUrl    The public R2-backed collage URL this run published, or null.
// imageExpiresAt
//             The EXACT expiry stored in that R2 object's customMetadata
//             (publishedImage.js), never a recomputed approximation. Published
//             images live PUBLISHED_IMAGE_TTL_SECONDS (15 minutes), so a
//             consumer must check this before handing the URL to LINE.
//
// RETENTION
// ---------
// An event that stops being broadcast-relevant — or a tick that produced
// nothing at all, e.g. outside 08:00–22:00 Asia/Taipei — leaves earlier entries
// in place for RETENTION_MINUTES with their updatedAt frozen, so a consumer's
// fixed-window read has a stable view and cannot miss an event that existed for
// only one producer tick. Because updatedAt is frozen, a retained event falls
// out of any sane push-eligibility window on its own.

import { computeFingerprint } from './dedupe.js';

export const SHARED_FEED_KEY = 'traffic:shared-feed';
export const SHARED_FEED_SCHEMA_VERSION = 1;

// Deliberately larger than the consumer's 90-minute read window so the window
// filter, not this number, is what a consumer actually sees.
const RETENTION_MINUTES = 180;

// Safety cap on the stored blob. Hsinchu-filtered, broadcast-eligible event
// counts are in the low tens, so this is a runaway guard, not an expected limit.
const MAX_STORED_EVENTS = 200;

const DEFAULT_WINDOW_MINUTES = 90;
const MAX_WINDOW_MINUTES = RETENTION_MINUTES;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

export function eventIdOf(event) {
  return `${event.source}:${event.rawId}`;
}

/**
 * Short, stable content hash built on dedupe.js#computeFingerprint, so the feed
 * and this Worker's own notified-state agree on what "the content changed"
 * means — there is exactly one definition of that in the codebase.
 */
export async function fingerprintOf(event) {
  const canonical = computeFingerprint(event);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

/**
 * V57.1 — "does this stored entry still carry an image a consumer could
 * legitimately hand to LINE right now?"
 *
 * The single definition of image validity for the whole producer side:
 * broadcastPipeline.js's Shared-Feed-only CCTV top-up uses it to decide
 * whether it is allowed to compose/publish a NEW collage, and
 * buildSharedFeedEvents below uses it to decide whether an existing one
 * may be carried forward. Having exactly one definition is what makes
 * "never re-compose an image the feed already has" and "never silently
 * drop an image the feed already has" the same rule seen from two sides.
 *
 * Requires a fingerprint match: a content change means the stored
 * collage belongs to the previous content, so it must not be presented
 * as this content's image. Any unparseable/absent expiry is invalid —
 * never optimistic.
 *
 * @param {object|null|undefined} entry - a previously stored feed entry
 * @param {string|null} fingerprint - this run's fingerprint for the same
 *   eventId, or null to skip the fingerprint check
 * @param {Date} now
 */
export function isStoredImageStillValid(entry, fingerprint, now = new Date()) {
  if (!entry || typeof entry.imageUrl !== 'string' || entry.imageUrl.length === 0) return false;
  if (typeof fingerprint === 'string' && entry.fingerprint !== fingerprint) return false;
  const expiresMs = new Date(entry.imageExpiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs > now.getTime();
}

function isUsableProduct(product) {
  if (!product || typeof product !== 'object') return false;
  if (!product.event || !product.event.source || !product.event.rawId) return false;
  return typeof product.text === 'string' && product.text.trim().length > 0;
}

/**
 * Pure apart from the SHA-256 digest. Given this run's completed products (from
 * runLineBroadcast) and the previously stored entries, returns the next stored
 * event list.
 *
 * `previousEvents` may be empty (first ever run, or a KV miss) — every product
 * then gets createdAt = updatedAt = now, which is correct: a consumer's own
 * delivery dedup and eligibility window are what stop a first run from
 * flooding, not this module.
 */
export async function buildSharedFeedEvents(completedProducts, previousEvents, now = new Date()) {
  const nowIso = now.toISOString();
  const previousById = new Map(
    (Array.isArray(previousEvents) ? previousEvents : [])
      .filter((entry) => entry && typeof entry.eventId === 'string')
      .map((entry) => [entry.eventId, entry])
  );

  const next = [];
  const seen = new Set();

  for (const product of Array.isArray(completedProducts) ? completedProducts : []) {
    if (!isUsableProduct(product)) continue;

    const event = product.event;
    const eventId = eventIdOf(event);
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const fingerprint = await fingerprintOf(event);
    const previous = previousById.get(eventId);
    const unchanged = previous && previous.fingerprint === fingerprint;

    // V57.1 — carry a STILL-VALID stored image forward when this run's
    // product has none. Without this, an event that keeps being
    // broadcast-relevant for several ticks lost its image on the very
    // next tick after it was composed (this rebuild overwrites the whole
    // entry), which in turn would make the top-up pass in
    // broadcastPipeline.js compose the same collage again and again.
    // Bounded strictly by the stored expiry and by a fingerprint match —
    // an expired or content-stale image is never carried forward, so
    // this can only ever preserve a URL that is genuinely still usable.
    const carriedImage = isStoredImageStillValid(previous, fingerprint, now) ? previous : null;

    next.push({
      eventId,
      fingerprint,
      text: product.text,
      // Recorded from the broadcast that already happened; never requested.
      imageUrl: product.imageUrl ?? (carriedImage ? carriedImage.imageUrl : null),
      imageExpiresAt: product.imageExpiresAt ?? (carriedImage ? carriedImage.imageExpiresAt : null),
      createdAt: (previous && previous.createdAt) || nowIso,
      // Only advances when the content actually changed. This is what makes a
      // consumer's eligibility window jitter-free.
      updatedAt: unchanged ? previous.updatedAt : nowIso,
      road: String(event.road || ''),
      type: String(event.type || 'other'),
      direction: event.direction ? String(event.direction) : null,
    });
  }

  // Retain entries this run did not produce, with updatedAt frozen, so a
  // short-lived event stays visible to a consumer whose tick lands after it
  // disappeared — and so a quiet tick (or a whole night outside broadcast
  // hours) does not wipe the feed.
  const retentionCutoffMs = now.getTime() - RETENTION_MINUTES * 60_000;
  for (const [eventId, entry] of previousById) {
    if (seen.has(eventId)) continue;
    const updatedMs = new Date(entry.updatedAt).getTime();
    if (!Number.isFinite(updatedMs) || updatedMs < retentionCutoffMs) continue;
    next.push(entry);
  }

  return sortNewestFirst(next).slice(0, MAX_STORED_EVENTS);
}

function sortNewestFirst(events) {
  return [...events].sort((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (diff !== 0) return diff;
    // Stable, deterministic tie-break — several events routinely share a
    // timestamp because they were established in the same Cron tick.
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
}

/** Read-only. Never writes; safe to call from any request handler. */
export async function readSharedFeed(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', events: [], updatedAt: null };
  }
  try {
    const raw = await kv.get(SHARED_FEED_KEY);
    if (!raw) return { kvAvailable: true, kvError: null, events: [], updatedAt: null };
    try {
      const parsed = JSON.parse(raw);
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      return { kvAvailable: true, kvError: null, events, updatedAt: parsed?.updatedAt ?? null };
    } catch {
      // A corrupt blob is "no feed yet", not an outage — the next Cron tick
      // overwrites it with valid JSON.
      return { kvAvailable: true, kvError: null, events: [], updatedAt: null };
    }
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), events: [], updatedAt: null };
  }
}

/** The only write in this module. Best-effort by design — see scheduled.js. */
export async function persistSharedFeed(kv, events, now = new Date()) {
  if (!kv) return { committed: false, error: 'TRAFFIC_KV binding not configured' };
  try {
    await kv.put(
      SHARED_FEED_KEY,
      JSON.stringify({ schemaVersion: SHARED_FEED_SCHEMA_VERSION, events, updatedAt: now.toISOString() })
    ); // no TTL — the retention rule inside the blob manages lifecycle
    return { committed: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}

export function clampWindowMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WINDOW_MINUTES;
  return Math.min(Math.floor(parsed), MAX_WINDOW_MINUTES);
}

/**
 * V57.3 — page offset into the window, newest-first.
 *
 * The window can legitimately hold more entries than MAX_LIMIT (a deploy that
 * changes message text or fingerprint shape re-broadcasts many events at once),
 * and a consumer that can only ever see the newest MAX_LIMIT of them silently
 * loses the rest: it never learns they exist, so it cannot even record that it
 * skipped them. Offset lets a consumer walk the whole window.
 *
 * Ordering is deterministic (updatedAt desc, then eventId asc), so an offset is
 * stable within one snapshot. Across snapshots it can shift by a page boundary;
 * that is harmless because a consumer re-reads the entire window every round
 * and dedups its own deliveries.
 */
export function clampOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MAX_STORED_EVENTS);
}

export function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

/**
 * Field whitelist. Anything not listed here — raw TDX/PBS payloads, CMS text,
 * CCTV camera metadata, internal bookkeeping, notified-state, subscriptions,
 * secrets — can never reach a consumer, because this is the only shape the
 * handler ever serialises.
 */
export function toPublicEvent(entry) {
  return {
    eventId: entry.eventId,
    fingerprint: entry.fingerprint,
    text: entry.text,
    imageUrl: entry.imageUrl ?? null,
    imageExpiresAt: entry.imageExpiresAt ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    road: entry.road ?? '',
    type: entry.type ?? 'other',
    direction: entry.direction ?? null,
  };
}

/** Pure. Newest-first window selection with truncation reporting. */
export function selectFeedWindow(events, { windowMinutes, limit, offset, now = new Date() } = {}) {
  const minutes = clampWindowMinutes(windowMinutes);
  const max = clampLimit(limit);
  const start = clampOffset(offset);
  const cutoffMs = now.getTime() - minutes * 60_000;

  const withinWindow = (Array.isArray(events) ? events : []).filter((entry) => {
    if (!entry || typeof entry.eventId !== 'string' || typeof entry.fingerprint !== 'string') return false;
    if (typeof entry.text !== 'string' || entry.text.length === 0) return false;
    const updatedMs = new Date(entry.updatedAt).getTime();
    return Number.isFinite(updatedMs) && updatedMs >= cutoffMs;
  });

  const sorted = sortNewestFirst(withinWindow);
  return {
    windowMinutes: minutes,
    limit: max,
    offset: start,
    // `total` is always the FULL window count, never the page size — it is how
    // a consumer knows there is more to fetch.
    total: sorted.length,
    // "there are entries beyond the end of this page", not "data was lost".
    truncated: sorted.length > start + max,
    events: sorted.slice(start, start + max).map(toPublicEvent),
  };
}

/**
 * Cron-side entry point. Reads the previous snapshot, rebuilds it from this
 * run's completed products, and writes it back. Callers MUST treat a rejection
 * or a committed:false result as non-fatal — the real broadcast has already
 * completed by the time this runs.
 */
export async function runSharedFeedPersist(env, { completedProducts, now = new Date() }) {
  const previous = await readSharedFeed(env.TRAFFIC_KV);
  if (!previous.kvAvailable) {
    return { committed: false, error: previous.kvError, eventCount: 0, withImageCount: 0 };
  }
  const events = await buildSharedFeedEvents(completedProducts, previous.events, now);
  const commit = await persistSharedFeed(env.TRAFFIC_KV, events, now);
  return {
    ...commit,
    eventCount: events.length,
    withImageCount: events.filter((entry) => entry.imageUrl).length,
  };
}
