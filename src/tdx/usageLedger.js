// V1.8.6 — TDX usage reconciliation ledger ("TDX 用量對帳"). Lets a human
// compare this Worker's own record of "how many real TDX data API calls
// did we actually make today" against TDX's own official back-office
// dashboard, and immediately spot an unexpected excess (or an unexpected
// shortfall, which usually means a Cron tick silently failed to run).
//
// CORE SAFETY RULE, non-negotiable: recording usage must never itself
// cost a TDX/PBS/LINE call, and must never be able to block or fail the
// real pipeline it's observing. Every write in this module is wrapped so
// a KV outage here degrades to "this batch/day's numbers are temporarily
// incomplete", never to a broken Cron run or a broken /health page. GET
// /health itself (see ../traffic/health.js) only ever reads the compacted
// summary key below — it NEVER lists/scans raw entries, and it NEVER
// calls fetchTdxJson/getAccessToken itself, so opening or refreshing the
// health page costs exactly 0 TDX calls, same guarantee as before this
// round.
//
// --- Why one append-only KV entry per INVOCATION, not a shared counter ---
// fetchAllSources() fires multiple sources concurrently via Promise.all.
// A naive "read today's total, +1, write today's total" counter is a
// classic lost-update race under that concurrency: two sources can both
// read the same stale total and each write back total+1, silently
// dropping one increment. This module never does that. Instead, each
// call site collects its OWN in-memory array of per-call records (a
// plain JS array — safe to .push() from multiple in-flight promises
// because JavaScript itself is single-threaded; a `.push()` call is a
// synchronous operation that can never interleave with another one, only
// `await` points yield control — see MDN's concurrency model), and only
// once that whole invocation (one Cron tick's TDX phase, one /debug/tdx
// request, one admin CCTV probe) finishes does it write ONE KV entry
// containing every record from that invocation, under a fresh, globally
// unique key. Two invocations writing at "the same time" simply produce
// two independent keys — never a read-modify-write on shared state, so
// there is nothing to race.
//
// --- KV shape ---
//   tdx:usage:entry:v1:<YYYY-MM-DD>:<epochMs>:<opaqueId>  (append-only,
//     one per invocation that made >=1 real TDX call, TTL 40 days)
//     { context, date, createdAt, records: [ {kind:'data', timestamp,
//       source, attempted, success, httpStatus, payloadBytesEstimate},
//       {kind:'oauth', timestamp, success, httpStatus}, ... ] }
//   tdx:usage:summary:v1  (compacted rollup, last ~35 days, the ONLY key
//     GET /health reads)
//     { schemaVersion, updatedAt, days: { "<YYYY-MM-DD>": <DayRow> } }
//
// Compaction (see compactTdxUsageSummaryForToday) is driven by the Cron
// path, once per tick, AFTER the real run already completed — never by
// /health itself. It only ever re-lists TODAY's entries (a handful —
// production makes at most ~42 batches/day, everything else is rare
// human-triggered traffic), never the full 40-day history, keeping the
// list() cost small and constant regardless of how much history has
// accumulated.

import { toTaipeiParts } from '../traffic/broadcastHours.js';

export const USAGE_ENTRY_KEY_PREFIX = 'tdx:usage:entry:v1';
export const USAGE_SUMMARY_KEY = 'tdx:usage:summary:v1';
export const USAGE_ENTRY_TTL_SECONDS = 40 * 24 * 60 * 60; // 40 days
export const USAGE_SUMMARY_RETENTION_DAYS = 35;

// The Production theoretical baseline (see tdxSchedule.js for the real
// gating logic this mirrors — 08:00–21:59:59 Asia/Taipei, every 20
// minutes, freeway+highway only): 14 broadcast hours x 3 windows/hour x 2
// sources/window = 84 calls on a full, uneventful day.
export const PRODUCTION_TDX_WINDOWS_PER_DAY = 42;
export const PRODUCTION_TDX_SOURCES_PER_WINDOW = 2;
export const PRODUCTION_TDX_CALLS_PER_DAY = PRODUCTION_TDX_WINDOWS_PER_DAY * PRODUCTION_TDX_SOURCES_PER_WINDOW;

const KNOWN_CONTEXTS = ['production-cron', 'debug-status', 'debug-tdx', 'admin-cctv'];
const KNOWN_SOURCE_BUCKETS = ['freeway', 'highway', 'cms', 'bus-hsinchu', 'bus-hsinchu-county', 'cctv'];

// Maps a raw fetchTdxJson `source` tag to one of the health-page's fixed
// display buckets. cctv-probe/cctv-hsinchu-probe (the two Admin CCTV
// probe endpoints) both collapse into 'cctv' — the health page cares
// "how much did CCTV metadata probing cost", not which of the two admin
// endpoints was used. vd-static/vd-live (congestionValidation.js's VD
// lookup, dead code on every live path today — see PROJECT_HANDOFF.md
// §2) fall into 'other' rather than inventing a bucket for a path that
// never actually runs in production/debug/admin.
function normalizeSourceBucket(rawSource) {
  if (rawSource === 'cctv-probe' || rawSource === 'cctv-hsinchu-probe') return 'cctv';
  if (KNOWN_SOURCE_BUCKETS.includes(rawSource)) return rawSource;
  return 'other';
}

function normalizeContext(context) {
  return KNOWN_CONTEXTS.includes(context) ? context : 'other';
}

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

/** "2026-08-18" in Asia/Taipei — the day boundary this whole ledger keys on. */
export function taipeiDateString(now = new Date()) {
  const p = toTaipeiParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function opaqueId() {
  const bytes = new Uint8Array(8); // 64 bits — uniqueness only, not a security boundary
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Recording: pure, synchronous, in-memory only — see module comment ---

/**
 * Records one real (attempted) TDX data-API call into the invocation's
 * own in-memory batch. `usageSink` is a plain array threaded down from
 * the top-level caller (scheduled.js / debugStatus.js / debug.js /
 * hsinchuCctvProbe.js / cctvProbe.js) through fetchAllSources ->
 * fetchSource -> fetchTdxJson (or called directly by a single-call
 * admin probe). A falsy/missing usageSink is always a silent no-op —
 * every existing caller that doesn't pass one (every test that predates
 * this round, and any future dead-code path like vdSpeed.js today) keeps
 * working completely unchanged.
 */
export function recordTdxDataCall(usageSink, { source, success, httpStatus = null, payloadBytesEstimate = 0, now = new Date() } = {}) {
  if (!Array.isArray(usageSink)) return;
  usageSink.push({
    kind: 'data',
    timestamp: now.toISOString(),
    source: source || 'other',
    attempted: true, // this function is only ever called once a real fetch() was actually attempted
    success: Boolean(success),
    httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
    payloadBytesEstimate: Number.isFinite(payloadBytesEstimate) ? payloadBytesEstimate : 0,
  });
}

/**
 * Records one real TDX OAuth token-endpoint request — ONLY ever called
 * from the branch of auth.js's acquireToken() that actually reaches
 * requestNewToken() (tier C: neither the isolate's memory cache nor the
 * shared TRAFFIC_KV cache had a fresh token). A memory-hit or KV-hit
 * token reuse is NEVER recorded here — see auth.js.
 */
export function recordTdxOAuthCall(usageSink, { success, httpStatus = null, now = new Date() } = {}) {
  if (!Array.isArray(usageSink)) return;
  usageSink.push({
    kind: 'oauth',
    timestamp: now.toISOString(),
    success: Boolean(success),
    httpStatus: typeof httpStatus === 'number' ? httpStatus : null,
  });
}

// --- Commit: one append-only write per invocation ---

/**
 * The only WRITE most callers ever perform directly. Best-effort: a
 * failure here is reported back but never throws — every caller wraps
 * this in the same try/catch isolation pattern already used for
 * persistHealthSnapshot/persistProductionTdxEventCache (see
 * scheduled.js), so a usage-ledger outage can never affect the real
 * TDX/PBS/LINE pipeline it's observing.
 *
 * V1.8.6 CORRECTION — daily attribution by each record's OWN timestamp,
 * not the invocation's `now`. A human-triggered Debug/Admin call that
 * happens to straddle Asia/Taipei midnight (started 23:59, a slow
 * request resolves at 00:00) would otherwise misattribute a late-night
 * call to the wrong calendar day, throwing off the daily reconciliation
 * against TDX's own official PER-DAY dashboard by 1-2 calls. Records are
 * grouped by `taipeiDateString(record.timestamp)` and written as
 * SEPARATE append-only entries — still append-only, still one entry per
 * (invocation, date) pair, never a shared counter. The overwhelmingly
 * common case (an invocation entirely within one calendar day, which is
 * every Production Cron tick by construction — a single tick can't
 * itself take 24h) still writes exactly ONE entry.
 */
export async function commitTdxUsageBatch(kv, { context, now = new Date(), records }) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  if (!Array.isArray(records) || records.length === 0) return { committed: false, reason: 'no-records' };
  try {
    const byDate = new Map();
    for (const rec of records) {
      const recordMoment = rec && rec.timestamp ? new Date(rec.timestamp) : now;
      const date = taipeiDateString(Number.isFinite(recordMoment.getTime()) ? recordMoment : now);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(rec);
    }

    const keys = [];
    for (const [date, dateRecords] of byDate) {
      const key = `${USAGE_ENTRY_KEY_PREFIX}:${date}:${now.getTime()}:${opaqueId()}`;
      const body = { context: normalizeContext(context), date, createdAt: now.toISOString(), records: dateRecords };
      await kv.put(key, JSON.stringify(body), { expirationTtl: USAGE_ENTRY_TTL_SECONDS });
      keys.push(key);
    }
    return { committed: true, key: keys[0], keys };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

// --- Compaction: Cron-driven, today-only, cheap ---

function emptySourceCounts() {
  return Object.fromEntries([...KNOWN_SOURCE_BUCKETS, 'other'].map((s) => [s, 0]));
}

function emptyDayRow(date) {
  return {
    date,
    // V1.8.6 CORRECTION — bySource/byContext are kept for backward-
    // compatible/simple totals, but they are marginal aggregates:
    // bySource mixes Production and Debug/Admin calls for the same
    // source together (a human running /debug/status DOES add to
    // bySource.freeway), so the health page must NEVER read bySource and
    // label it "Production" — see byContextSource below, which is the
    // only correct source of a per-context, per-source breakdown.
    bySource: emptySourceCounts(),
    byContext: Object.fromEntries([...KNOWN_CONTEXTS, 'other'].map((c) => [c, 0])),
    // { context: { sourceBucket: count } } — the 2D breakdown the health
    // page's "Production" block must read from (byContextSource['production-cron']),
    // so a manually-triggered /debug/status call can never silently
    // inflate what's displayed as Production's own freeway/highway count.
    byContextSource: Object.fromEntries([...KNOWN_CONTEXTS, 'other'].map((c) => [c, emptySourceCounts()])),
    totalDataCalls: 0,
    productionDataCalls: 0,
    manualDataCalls: 0,
    oauthRequests: 0,
    payloadBytesEstimate: 0,
  };
}

/** Pure — folds every entry body for one day into a single DayRow. */
export function buildDayRowFromEntries(date, entryBodies) {
  const row = emptyDayRow(date);
  for (const body of entryBodies || []) {
    if (!body || !Array.isArray(body.records)) continue;
    const context = normalizeContext(body.context);
    for (const rec of body.records) {
      if (!rec) continue;
      if (rec.kind === 'oauth') {
        row.oauthRequests += 1;
        continue;
      }
      if (rec.kind !== 'data') continue;
      const bucket = normalizeSourceBucket(rec.source);
      row.bySource[bucket] = (row.bySource[bucket] || 0) + 1;
      row.byContext[context] = (row.byContext[context] || 0) + 1;
      if (!row.byContextSource[context]) row.byContextSource[context] = emptySourceCounts();
      row.byContextSource[context][bucket] = (row.byContextSource[context][bucket] || 0) + 1;
      row.totalDataCalls += 1;
      if (context === 'production-cron') row.productionDataCalls += 1;
      else row.manualDataCalls += 1;
      row.payloadBytesEstimate += Number.isFinite(rec.payloadBytesEstimate) ? rec.payloadBytesEstimate : 0;
    }
  }
  return row;
}

async function listAllEntryBodies(kv, prefix) {
  const bodies = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys || []) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') bodies.push(parsed);
      } catch {
        // corrupt entry — skip it, never let one bad record break compaction
      }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return bodies;
}

function pruneOldDays(days, now) {
  const cutoff = new Date(now.getTime() - USAGE_SUMMARY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffDate = taipeiDateString(cutoff);
  const kept = {};
  for (const [date, row] of Object.entries(days)) {
    if (date >= cutoffDate) kept[date] = row;
  }
  return kept;
}

/** Read-only. The ONLY thing GET /health is allowed to read from this module. */
export async function readTdxUsageSummary(kv) {
  if (!kv) return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', summary: null };
  try {
    const raw = await kv.get(USAGE_SUMMARY_KEY);
    if (!raw) return { kvAvailable: true, kvError: null, summary: null };
    try {
      const parsed = JSON.parse(raw);
      return { kvAvailable: true, kvError: null, summary: parsed && typeof parsed === 'object' ? parsed : null };
    } catch {
      return { kvAvailable: true, kvError: null, summary: null }; // corrupt blob -> "no summary yet"
    }
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), summary: null };
  }
}

/**
 * Cron-driven compaction: re-lists ONLY today's raw entries (cheap — see
 * module comment), recomputes today's DayRow from scratch (idempotent —
 * safe to call every single Cron tick, never double-counts because it
 * always rebuilds the row from the underlying entries rather than
 * incrementing anything), and merges it into the persisted summary
 * alongside every other day's already-frozen row. Best-effort: never
 * throws, never affects the caller's real Cron run either way.
 *
 * V1.8.6 CORRECTION — `trackingStartedAt`: set ONCE, on the very first
 * compaction this Worker ever runs (`existing.trackingStartedAt` absent),
 * and preserved byte-for-byte on every compaction after that — never
 * reset by a later Cron tick. This exists so a Worker deployed mid-day
 * (e.g. 20:32) doesn't compare "calls so far today" against the FULL
 * 08:00-onward theoretical baseline, which would immediately show a
 * large, false negative diff for windows that fired before the ledger
 * even existed — see theoreticalProductionCallsToday/
 * theoreticalProductionCallsForDay below, which both take this value.
 */
export async function compactTdxUsageSummaryForToday(kv, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const date = taipeiDateString(now);
    const prefix = `${USAGE_ENTRY_KEY_PREFIX}:${date}:`;
    const entryBodies = await listAllEntryBodies(kv, prefix);
    const todayRow = buildDayRowFromEntries(date, entryBodies);

    const { summary: existing } = await readTdxUsageSummary(kv);
    const days = pruneOldDays({ ...((existing && existing.days) || {}), [date]: todayRow }, now);
    const trackingStartedAt = (existing && existing.trackingStartedAt) || now.toISOString();

    const summary = { schemaVersion: 1, trackingStartedAt, updatedAt: now.toISOString(), days };
    await kv.put(USAGE_SUMMARY_KEY, JSON.stringify(summary));
    return { committed: true, date };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/**
 * Pure — sums every day-row already present in `summary.days` (at most
 * USAGE_SUMMARY_RETENTION_DAYS entries) whose date falls in the SAME
 * Asia/Taipei calendar month as `now`. No I/O, no extra KV read — the
 * summary object is already fully in memory by the time this is called
 * (see health.js). Factored out of health.js's rendering so it has its
 * own direct unit test coverage.
 */
export function aggregateUsageForMonth(summary, now = new Date()) {
  const days = (summary && summary.days) || {};
  const { year, month } = toTaipeiParts(now);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return Object.entries(days)
    .filter(([date]) => date.startsWith(prefix))
    .reduce(
      (acc, [, row]) => ({
        totalDataCalls: acc.totalDataCalls + (row.totalDataCalls || 0),
        productionDataCalls: acc.productionDataCalls + (row.productionDataCalls || 0),
        manualDataCalls: acc.manualDataCalls + (row.manualDataCalls || 0),
        oauthRequests: acc.oauthRequests + (row.oauthRequests || 0),
        payloadBytesEstimate: acc.payloadBytesEstimate + (row.payloadBytesEstimate || 0),
      }),
      { totalDataCalls: 0, productionDataCalls: 0, manualDataCalls: 0, oauthRequests: 0, payloadBytesEstimate: 0 }
    );
}

// --- Theoretical baseline: pure date math, zero I/O, safe to call from /health at render time ---

/**
 * How many of the 42 daily Production TDX fetch windows (08:00–21:40,
 * every 20 minutes Asia/Taipei — see tdxSchedule.js for the live gate
 * this mirrors) have their scheduled moment at or before `now`. Purely a
 * function of wall-clock time — 0 before 08:00, 42 from 22:00 onward.
 */
export function productionWindowsElapsedToday(now = new Date()) {
  const { hour, minute } = toTaipeiParts(now);
  if (hour < 8) return 0;
  if (hour >= 22) return PRODUCTION_TDX_WINDOWS_PER_DAY;
  const hoursCompleted = hour - 8;
  const windowsThisHour = Math.floor(minute / 20) + 1; // the current 20-min window has already fired
  return hoursCompleted * 3 + windowsThisHour;
}

/**
 * How many of the 42 daily windows had ALREADY fired by the moment
 * tracking started — i.e. windows that can never be attributed to this
 * Worker's own ledger, because they happened before the ledger existed.
 * 0 if tracking hasn't started yet (no summary written) — treated as "no
 * correction needed", which correctly reduces to the plain full-schedule
 * baseline everywhere below.
 */
function windowsBeforeTrackingStarted(trackingStartedAt) {
  if (!trackingStartedAt) return 0;
  const start = new Date(trackingStartedAt);
  if (!Number.isFinite(start.getTime())) return 0;
  return productionWindowsElapsedToday(start);
}

/**
 * Theoretical Production TDX data-call count "so far today", live-
 * computed — see module comment above. `trackingStartedAt` (from
 * tdx:usage:summary:v1, immutable once set — see
 * compactTdxUsageSummaryForToday) makes this tracking-aware: on the
 * calendar day tracking began, only windows AT OR AFTER that moment
 * count toward the theoretical baseline — a Worker that started tracking
 * at 20:32 must never be compared against the full 08:00-onward
 * baseline, which would show a large false negative diff for windows
 * that fired before the ledger existed. On every subsequent day (or when
 * trackingStartedAt is absent/unknown), this is unchanged from the plain
 * full-schedule baseline.
 */
export function theoreticalProductionCallsToday(now = new Date(), trackingStartedAt = null) {
  const windowsNow = productionWindowsElapsedToday(now);
  if (trackingStartedAt && taipeiDateString(new Date(trackingStartedAt)) === taipeiDateString(now)) {
    const windowsAtStart = windowsBeforeTrackingStarted(trackingStartedAt);
    return Math.max(0, windowsNow - windowsAtStart) * PRODUCTION_TDX_SOURCES_PER_WINDOW;
  }
  return windowsNow * PRODUCTION_TDX_SOURCES_PER_WINDOW;
}

/**
 * Theoretical Production TDX data-call count for a COMPLETE calendar day
 * (used by /health's 30-day reconciliation table for every day except
 * today, which uses theoreticalProductionCallsToday above instead) — the
 * full PRODUCTION_TDX_CALLS_PER_DAY (84), UNLESS `dateStr` is the exact
 * calendar day tracking started, in which case only the windows from
 * that moment through end-of-day are theoretically trackable. See
 * isPartialTrackingDay — the health page must label that one day as a
 * partial day, never display it as if it were a normal complete 84.
 */
export function theoreticalProductionCallsForDay(dateStr, trackingStartedAt) {
  if (isPartialTrackingDay(dateStr, trackingStartedAt)) {
    const windowsAtStart = windowsBeforeTrackingStarted(trackingStartedAt);
    return Math.max(0, PRODUCTION_TDX_WINDOWS_PER_DAY - windowsAtStart) * PRODUCTION_TDX_SOURCES_PER_WINDOW;
  }
  return PRODUCTION_TDX_CALLS_PER_DAY;
}

/** True only for the single Asia/Taipei calendar day tracking began on. */
export function isPartialTrackingDay(dateStr, trackingStartedAt) {
  if (!trackingStartedAt) return false;
  const start = new Date(trackingStartedAt);
  if (!Number.isFinite(start.getTime())) return false;
  return taipeiDateString(start) === dateStr;
}
