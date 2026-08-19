// V57 Shared Traffic Feed — read-only completed-product persistence.
//
// WHY THIS EXISTS
// ---------------
// Another project (雙鐵進站小幫手 / rail-traffic-consumer) needs to
// re-broadcast this Worker's *finished* traffic reports to its own LINE
// audience, WITHOUT ever calling TDX / PBS / CCTV itself. Before V57 the
// finished LINE text was computed inline inside runLineBroadcast() and
// then discarded — nothing durable ever held a completed product. This
// module is the minimum persistence needed to close that gap.
//
// HARD BOUNDARIES
// ---------------
// - This module NEVER fetches anything. It only formats events that the
//   existing pipeline already fetched, and reads/writes one KV key.
// - The original LINE broadcast (broadcastPipeline.js) does NOT depend on
//   this module in any way. Snapshot persistence is a separate, isolated
//   step in scheduled.js: if it fails, it logs and the Cron run carries on.
// - Nothing here is allowed to write to `traffic:dedupe-state`,
//   `traffic:baseline`, `line:notified-state` or `line:subscriptions`.
//
// FIELD SEMANTICS (the consumer's contract depends on these)
// ----------------------------------------------------------
// eventId    `${source}:${rawId}` — the same key dedupe.js already uses.
//            Stable across content updates for the lifetime of an event.
// fingerprint SHA-256 (truncated) of dedupe.js#computeFingerprint, which
//            deliberately excludes updatedAt / publish timestamps. So a
//            timestamp-only refresh does NOT change the fingerprint, and a
//            consumer keyed on it will not re-push. This is the anti-jitter
//            guarantee.
// updatedAt  NOT TDX's updatedAt. This is "when this fingerprint was first
//            established in the feed" — it only advances when the
//            fingerprint actually changes, and is therefore monotonic and
//            jitter-free. The consumer's push-eligibility window keys off
//            this field.
// createdAt  When this eventId first entered the feed; carried forward
//            unchanged across content updates.
// text       The finished LINE broadcast text, byte-identical to what this
//            Worker would send to its own subscribers. Consumers must not
//            re-compose it.
// imageUrl / imageExpiresAt
//            Always null in v1: this Worker has no CCTV / MJPEG / collage /
//            R2 capability yet (verified — zero such code in the repo).
//            The fields exist so a consumer written against schema v1 keeps
//            working unchanged the day images are added.
//
// RETENTION
// ---------
// An event that disappears from the live TDX feed is retained here for
// RETENTION_MINUTES with its updatedAt frozen, so the consumer's
// fixed-window read has a stable view and cannot miss an event that only
// existed for one producer tick. Because updatedAt is frozen, a retained
// event naturally falls out of the consumer's push-eligibility window
// without any extra bookkeeping.

import { computeEffectiveWindow } from './effectiveWindow.js';
import { isBroadcastRelevant } from './broadcastRules.js';
import { formatEventMessage } from './messageFormat.js';
import { computeFingerprint } from './dedupe.js';

export const SHARED_FEED_KEY = 'traffic:shared-feed';
export const SHARED_FEED_SCHEMA_VERSION = 1;

// Deliberately larger than the consumer's 90-minute read window so the
// window filter, not this number, is what the consumer actually sees.
const RETENTION_MINUTES = 180;

// Safety cap on the stored blob. Hsinchu-filtered event counts are in the
// tens, so this is a runaway guard, not an expected limit.
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
 * Short, stable content hash. Built on dedupe.js#computeFingerprint so the
 * feed and this Worker's own notified-state agree on what "the content
 * changed" means — there is exactly one definition in the codebase.
 */
export async function fingerprintOf(event) {
  const canonical = computeFingerprint(event);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

function isRenderableEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (!event.source || !event.rawId) return false;
  return true;
}

/**
 * Pure apart from the SHA-256 digest. Given this run's events and the
 * previously stored feed entries, returns the next stored event list.
 *
 * `previousEvents` may be an empty array (first ever run, or KV miss) —
 * in that case every relevant event gets createdAt = updatedAt = now,
 * which is correct: the consumer's own delivery dedup plus its
 * push-eligibility window are what stop a first run from flooding.
 */
export async function buildSharedFeedEvents(allEvents, previousEvents, now = new Date()) {
  const nowIso = now.toISOString();
  const previousById = new Map(
    (Array.isArray(previousEvents) ? previousEvents : [])
      .filter((entry) => entry && typeof entry.eventId === 'string')
      .map((entry) => [entry.eventId, entry])
  );

  const next = [];
  const seen = new Set();

  for (const event of Array.isArray(allEvents) ? allEvents : []) {
    if (!isRenderableEvent(event)) continue;

    const window = computeEffectiveWindow(event, now);
    if (!isBroadcastRelevant(window, now)) continue;

    const eventId = eventIdOf(event);
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const startMs = new Date(window.effectiveStart).getTime();
    const forecast = startMs > now.getTime();
    const minutesUntilStart = forecast ? Math.max(1, Math.round((startMs - now.getTime()) / 60000)) : null;
    const text = formatEventMessage(event, { forecast, minutesUntilStart });
    const fingerprint = await fingerprintOf(event);

    const previous = previousById.get(eventId);
    const unchanged = previous && previous.fingerprint === fingerprint;

    next.push({
      eventId,
      fingerprint,
      text,
      // No CCTV/collage capability in this Worker yet — see module header.
      imageUrl: null,
      imageExpiresAt: null,
      createdAt: (previous && previous.createdAt) || nowIso,
      // Only advances when the content actually changed. This is what makes
      // the consumer's eligibility window jitter-free.
      updatedAt: unchanged ? previous.updatedAt : nowIso,
      road: String(event.road || ''),
      type: String(event.type || 'other'),
      direction: event.direction ? String(event.direction) : null,
    });
  }

  // Retain events that vanished from the live feed this run, with their
  // updatedAt frozen, so a short-lived event is still visible to a
  // consumer whose tick lands after it disappeared.
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

/** Read-only. Never writes, safe to call from any request handler. */
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
      // Corrupt blob is treated as "no feed yet" rather than an outage —
      // the next Cron tick overwrites it with valid JSON.
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

export function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

/**
 * Field whitelist. Anything not listed here — raw TDX/PBS payloads, CMS
 * text, internal bookkeeping, notified-state, secrets — can never reach a
 * consumer, because this is the only shape the handler ever serialises.
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
export function selectFeedWindow(events, { windowMinutes, limit, now = new Date() } = {}) {
  const minutes = clampWindowMinutes(windowMinutes);
  const max = clampLimit(limit);
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
    total: sorted.length,
    truncated: sorted.length > max,
    events: sorted.slice(0, max).map(toPublicEvent),
  };
}

/**
 * Cron-side entry point. Reads the previous snapshot, rebuilds it from this
 * run's events, and writes it back. Callers MUST treat a rejection or a
 * committed:false result as non-fatal — the original LINE broadcast has
 * already completed by the time this runs.
 */
export async function runSharedFeedPersist(env, { allEvents, now = new Date() }) {
  const previous = await readSharedFeed(env.TRAFFIC_KV);
  if (!previous.kvAvailable) {
    return { committed: false, error: previous.kvError, eventCount: 0 };
  }
  const events = await buildSharedFeedEvents(allEvents, previous.events, now);
  const commit = await persistSharedFeed(env.TRAFFIC_KV, events, now);
  return { ...commit, eventCount: events.length };
}
