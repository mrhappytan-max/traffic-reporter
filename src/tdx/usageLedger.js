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
// Compaction (see compactTdxUsageSummaryRecentDays) is driven by the Cron
// path, once per tick, AFTER the real run already completed — never by
// /health itself. It only ever re-lists TODAY's and YESTERDAY's entries
// (a handful each — production makes at most ~42 batches/day, everything
// else is rare human-triggered traffic; yesterday is re-scanned too so a
// cross-midnight Debug/Admin invocation's late-arriving "yesterday" entry
// still gets folded in — see that function's own comment), never the
// full 40-day history, keeping the list() cost small and constant
// regardless of how much history has accumulated.

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

// V1.8.6.1 — TDX's own official "基礎服務" point conversion (confirmed
// against TDX's back-office dashboard, not guessed): 1500 calls = 1
// point, 150 MB transferred = 1 point. Centralized here — see
// PROJECT_HANDOFF.md §18 — so the numbers never get duplicated/drift
// across health.js's rendering code. `TDX_MONTHLY_POINT_BUDGET` defaults
// to 3, matching this project's current TDX 基礎會員方案 (3 points/month);
// if the plan is ever upgraded, this is the one constant to change.
export const TDX_CALLS_PER_POINT = 1500;
export const TDX_TRAFFIC_MB_PER_POINT = 150;
export const TDX_MONTHLY_POINT_BUDGET = 3;

// V1.8.6.1 CORRECTION (post-review) — the Local Usage Ledger only started
// accumulating on 2026-08-18 (V1.8.6's Production deploy). For August
// 2026 specifically, real TDX usage happened BEFORE that — this is NOT
// something the Ledger can retroactively know, and this project's own
// explicit rule is "不要回推猜測" (never guess/backfill historical local
// data). Instead, this is a hand-entered, one-time reference the user
// personally confirmed from TDX's own official back-office dashboard —
// NOT derived from anything this Worker measured itself:
//   2026-08-16: 1490 calls, 17016 KB
//   2026-08-17: 704 calls, 10534 KB
//   cumulative through 2026-08-17: 2194 calls, 27550 KB, 1.643 points
//     (TDX's own displayed cumulative point figure — not recomputed here
//     from calls/traffic, since TDX's own official rounding/conversion
//     may differ slightly from this Worker's local estimate formula)
// Only ever applied to the ONE month it was measured for. A month key
// with no entry here means "no pre-Ledger baseline for this month" —
// e.g. 2026-09 (and every month after) is fully covered by the Local
// Ledger from day 1, so it must NEVER inherit August's baseline; nothing
// in this module carries a baseline forward to a month it wasn't
// recorded for (see getOfficialUsageBaseline/estimateMonthUsage below —
// both do an exact "YYYY-MM" key lookup, no fallback).
//
// `throughDate` semantics, precisely (overlap-safe — see
// estimateMonthUsage's own comment for the double-counting bug this
// exists to prevent): "the official cumulative figures already fully
// cover every day up to AND INCLUDING this date." A Local Ledger day
// strictly AFTER `throughDate` is what adds on top of this baseline;
// Local Ledger day(s) ON OR BEFORE `throughDate` still exist and still
// render normally in the daily reconciliation table, but are excluded
// from the MONTH-quota total to avoid double-counting the same real TDX
// usage twice.
//
// KNOWN GAP as of this writing: `throughDate` is still 2026-08-17, but
// the Local Ledger's `trackingStartedAt` is mid-day on 2026-08-18 (V1.8.6
// deployed partway through that day) — so the stretch from 2026-08-18
// 00:00 to `trackingStartedAt` is covered by NEITHER the baseline NOR
// the Ledger. This is a real, currently-unresolved coverage gap — it is
// deliberately NOT estimated/guessed (see health.js's
// hasPendingBaselineCalibrationGap, which surfaces this as a "尚待官方日結
// 校正" warning rather than silently presenting a fully-reconciled
// number). Once TDX's own official 2026-08-18 cumulative figures are
// available, update ONLY this one entry — bump `throughDate` to
// `'2026-08-18'` and replace `calls`/`transferKB`/`officialPoints` with
// the new officially-confirmed cumulative-through-8/18 numbers. Nothing
// else in this module needs to change: the overlap-safe exclusion in
// estimateMonthUsage automatically starts excluding the 8/18 Local Ledger
// day from the month total the moment `throughDate` covers it, and the
// gap warning automatically clears itself.
export const TDX_OFFICIAL_USAGE_BASELINES = {
  '2026-08': {
    fromDate: '2026-08-16',
    throughDate: '2026-08-17',
    calls: 2194,
    transferKB: 27550,
    officialPoints: 1.643,
  },
};

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

/**
 * Floors a moment DOWN to the start of its own 20-minute Production
 * schedule window (e.g. 20:40:03 Asia/Taipei -> 20:40:00). Uses the same
 * "+8h, work in UTC fields, shift back" trick as toTaipeiParts/
 * toTaipeiHHMM elsewhere in this codebase. Only meaningful for a moment
 * within 08:00–22:00 — callers only ever use this on an already-recorded
 * Production data-call timestamp, which by construction only exists
 * inside that window.
 */
function windowStartFor(moment) {
  const shifted = new Date(moment.getTime() + 8 * 60 * 60 * 1000);
  const flooredMinute = Math.floor(shifted.getUTCMinutes() / 20) * 20;
  const flooredShifted = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(), flooredMinute, 0, 0)
  );
  return new Date(flooredShifted.getTime() - 8 * 60 * 60 * 1000);
}

/**
 * The earliest context='production-cron' `kind:'data'` record timestamp
 * found across a set of raw entry bodies (as returned by
 * listAllEntryBodies) — used only to seed `trackingStartedAt` on the
 * very first-ever compaction. Returns null if none found (e.g. the first
 * compaction happens on a PBS-only/skipped tick, before any Production
 * TDX call has ever been recorded).
 */
function earliestProductionDataTimestamp(entryBodies) {
  let earliest = null;
  for (const body of entryBodies || []) {
    if (!body || normalizeContext(body.context) !== 'production-cron' || !Array.isArray(body.records)) continue;
    for (const rec of body.records) {
      if (!rec || rec.kind !== 'data' || !rec.timestamp) continue;
      const t = new Date(rec.timestamp);
      if (!Number.isFinite(t.getTime())) continue;
      if (!earliest || t.getTime() < earliest.getTime()) earliest = t;
    }
  }
  return earliest;
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

/** Re-lists one date's raw entries and rebuilds its DayRow — the shared core of both compaction functions below. */
async function rebuildDayRow(kv, date) {
  const entryBodies = await listAllEntryBodies(kv, `${USAGE_ENTRY_KEY_PREFIX}:${date}:`);
  return { row: buildDayRowFromEntries(date, entryBodies), entryBodies };
}

/**
 * Determines `trackingStartedAt` for the FIRST-EVER compaction only
 * (`existing.trackingStartedAt` absent) — every later compaction just
 * preserves the existing value untouched, see the two exported
 * compaction functions below.
 *
 * V1.8.6 CORRECTION — if today's entries already contain a real
 * Production data call (the common case: this Worker's very first
 * compaction usually runs on the same tick as its first successful TDX
 * fetch), `trackingStartedAt` is seeded from that call's OWN window
 * start (floored — see windowStartFor), not the raw compaction-time
 * `now`. `now` is always a few ms/seconds AFTER the window actually
 * fired (Cron dispatch + fetch + normalize + compact all take real
 * time), so using it directly would place trackingStartedAt just after
 * that window's start and (via windowsBeforeTrackingStarted's strict-
 * before check) incorrectly exclude the very window that just produced
 * the data being compacted — undercounting the theoretical baseline by
 * one whole window (2 calls) on the very first tracked tick. If today
 * has no Production data call yet (e.g. the first-ever compaction lands
 * on a skipped-by-schedule/PBS-only tick), there is no window to anchor
 * to, so this falls back to the raw `now`, unchanged from before.
 */
function determineTrackingStartedAt(existing, now, todayEntryBodies) {
  if (existing && existing.trackingStartedAt) return existing.trackingStartedAt;
  const earliestProdTs = earliestProductionDataTimestamp(todayEntryBodies);
  return (earliestProdTs ? windowStartFor(earliestProdTs) : now).toISOString();
}

async function persistCompactedSummary(kv, now, dayRowsByDate, todayEntryBodiesForTracking) {
  const { summary: existing } = await readTdxUsageSummary(kv);
  const days = pruneOldDays({ ...((existing && existing.days) || {}), ...dayRowsByDate }, now);
  const trackingStartedAt = determineTrackingStartedAt(existing, now, todayEntryBodiesForTracking);
  const summary = { schemaVersion: 1, trackingStartedAt, updatedAt: now.toISOString(), days };
  await kv.put(USAGE_SUMMARY_KEY, JSON.stringify(summary));
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
 * Kept as its own narrow, single-day function (used directly by a few
 * tests) — the real Cron path calls compactTdxUsageSummaryRecentDays
 * below instead, which also re-compacts yesterday.
 */
export async function compactTdxUsageSummaryForToday(kv, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const date = taipeiDateString(now);
    const { row, entryBodies } = await rebuildDayRow(kv, date);
    await persistCompactedSummary(kv, now, { [date]: row }, entryBodies);
    return { committed: true, date };
  } catch (err) {
    return { committed: false, reason: 'kv-error', error: safeErrorMessage(err) };
  }
}

/**
 * V1.8.6 CORRECTION — the real Cron-driven compaction entry point.
 * Re-lists and rebuilds TODAY's DayRow unconditionally, and YESTERDAY's
 * DayRow too — but ONLY when yesterday genuinely has at least one raw
 * usage entry. Why: commitTdxUsageBatch already attributes each record
 * to its OWN timestamp's Asia/Taipei date (so a Debug/Admin call
 * spanning midnight correctly writes a separate "yesterday" entry) —
 * and if that write only completes AFTER midnight (invocation started
 * 23:59, resolved 00:00+), yesterday's summary row was already compacted
 * and frozen by the last Cron tick before midnight, and would never see
 * that late-arriving entry again without re-checking yesterday too.
 *
 * CORRECTION (post-review) — unconditionally overwriting the yesterday
 * key was itself a bug: on this Worker's very first day live, "yesterday"
 * has zero raw entries (the ledger didn't exist yet), and an
 * unconditional overwrite would have manufactured a fake
 * `0 calls / 84 theoretical / -84 diff` row for a day nothing was ever
 * tracked on — directly contradicting /health's own "nothing before
 * tracking started renders 尚無資料, never a fabricated number" rule.
 * Fixed: yesterday's rebuilt row only REPLACES what's in the summary
 * when `yesterdayEntryBodies.length > 0`. Every other case falls out
 * correctly on its own:
 *   - no ledger existed yesterday at all -> no key written, `/health`
 *     shows 尚無資料 (falls through to the `!days[date]` branch there).
 *   - yesterday genuinely had 0 calls but a summary row already existed
 *     for it (e.g. a prior tick's compaction) -> untouched, kept as-is
 *     (this function never DELETES an existing day row).
 *   - a genuine cross-midnight late entry exists -> rebuilt and folded in.
 *   - yesterday already had real calls (raw entries still inside their
 *     40-day TTL) -> rebuilt normally, unchanged from before.
 *
 * Still bounded/cheap: exactly 2 list() scans per Cron tick (today +
 * yesterday), never the full 35-40 day history — /health still only ever
 * reads the compacted summary key, never lists raw entries itself.
 */
export async function compactTdxUsageSummaryRecentDays(kv, now = new Date()) {
  if (!kv) return { committed: false, reason: 'no-kv' };
  try {
    const todayStr = taipeiDateString(now);
    const yesterdayStr = taipeiDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    const { row: todayRow, entryBodies: todayEntryBodies } = await rebuildDayRow(kv, todayStr);
    const { row: yesterdayRow, entryBodies: yesterdayEntryBodies } = await rebuildDayRow(kv, yesterdayStr);

    const dayRows = { [todayStr]: todayRow };
    if (yesterdayEntryBodies.length > 0) dayRows[yesterdayStr] = yesterdayRow;

    await persistCompactedSummary(kv, now, dayRows, todayEntryBodies);
    return { committed: true, dates: [yesterdayStr, todayStr] };
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
export function aggregateUsageForMonth(summary, now = new Date(), { afterDate } = {}) {
  const days = (summary && summary.days) || {};
  const { year, month } = toTaipeiParts(now);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return Object.entries(days)
    .filter(([date]) => date.startsWith(prefix))
    // V1.8.6.1 CORRECTION — `afterDate` (a "YYYY-MM-DD" string, exclusive)
    // lets estimateMonthUsage below exclude days already fully covered by
    // an official pre-Ledger baseline, so a Local Ledger DayRow for a day
    // the baseline already counted is never double-counted into the
    // month quota total. Every OTHER caller (no afterDate passed) is
    // completely unaffected — the filter is a no-op when omitted.
    .filter(([date]) => !afterDate || date > afterDate)
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
 * How many of the 42 daily windows have their scheduled moment STRICTLY
 * BEFORE `now` — unlike productionWindowsElapsedToday above (which is
 * inclusive: a window firing exactly AT `now` already counts), this one
 * excludes a window sitting exactly on the boundary. Needed specifically
 * for windowsBeforeTrackingStarted below: `trackingStartedAt` is (when
 * derived from a real Production record — see
 * earliestProductionDataTimestamp/windowStartFor) itself an EXACT window
 * start, and that window must count as trackable, not as "before
 * tracking started".
 *
 * Boundary examples (all Asia/Taipei): 08:00:00->0, 08:00:01->1,
 * 20:40:00->38, 20:40:01->39.
 */
export function productionWindowsStrictlyBefore(now = new Date()) {
  const { hour, minute, second } = toTaipeiParts(now);
  if (hour < 8) return 0;
  if (hour >= 22) return PRODUCTION_TDX_WINDOWS_PER_DAY;
  const msSinceDayStart = ((hour - 8) * 3600 + minute * 60 + second) * 1000;
  const windowIndex = msSinceDayStart / (20 * 60 * 1000);
  if (windowIndex <= 0) return 0;
  if (windowIndex >= PRODUCTION_TDX_WINDOWS_PER_DAY) return PRODUCTION_TDX_WINDOWS_PER_DAY;
  return Number.isInteger(windowIndex) ? windowIndex : Math.floor(windowIndex) + 1;
}

/**
 * How many of the 42 daily windows had ALREADY fired STRICTLY before the
 * moment tracking started — i.e. windows that can never be attributed to
 * this Worker's own ledger, because they happened before the ledger
 * existed. 0 if tracking hasn't started yet (no summary written) —
 * treated as "no correction needed", which correctly reduces to the
 * plain full-schedule baseline everywhere below.
 *
 * V1.8.6 CORRECTION — uses productionWindowsStrictlyBefore, NOT the
 * inclusive productionWindowsElapsedToday. compactTdxUsageSummaryForToday
 * seeds trackingStartedAt from a real Production record's OWN window
 * start (e.g. a call recorded at 20:40:03 sets trackingStartedAt to
 * 20:40:00 — see windowStartFor) specifically so that window counts as
 * tracked. Using the inclusive function here would have counted that
 * exact window as "already fired before tracking started" and swallowed
 * it, undercounting the theoretical baseline by one whole window (2
 * calls) on the very first tracked tick.
 */
function windowsBeforeTrackingStarted(trackingStartedAt) {
  if (!trackingStartedAt) return 0;
  const start = new Date(trackingStartedAt);
  if (!Number.isFinite(start.getTime())) return 0;
  return productionWindowsStrictlyBefore(start);
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

// --- V1.8.6.1: point-quota derived calculations, all pure/zero-I/O ---
// Every value here is explicitly "本地估算" throughout the health page —
// TDX's own official point accounting may use a different transfer-size
// or call-counting convention than this Worker's local estimate (see
// client.js's payloadBytesEstimate comment), so none of this is ever
// claimed to be byte-for-byte identical to TDX's real account balance —
// only good enough to long-term-calibrate against and catch gross
// anomalies early.

/**
 * `{ totalDataCalls, payloadBytesEstimate }` (a DayRow, or
 * aggregateUsageForMonth's return shape — both already carry exactly
 * these two fields) -> estimated TDX point cost, per TDX's own "基礎服務"
 * conversion (1500 calls = 1 point, 150MB = 1 point), additive.
 */
export function estimatePoints({ totalDataCalls, payloadBytesEstimate } = {}) {
  const callPoints = (totalDataCalls || 0) / TDX_CALLS_PER_POINT;
  const payloadMB = (payloadBytesEstimate || 0) / (1024 * 1024);
  const trafficPoints = payloadMB / TDX_TRAFFIC_MB_PER_POINT;
  return callPoints + trafficPoints;
}

/** Exact "YYYY-MM" key lookup into TDX_OFFICIAL_USAGE_BASELINES — no fallback to a neighboring month, no "sticky" default. A month with nothing recorded here (every month except 2026-08) simply has no baseline. */
export function getOfficialUsageBaseline(now = new Date()) {
  const { year, month } = toTaipeiParts(now);
  const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
  return TDX_OFFICIAL_USAGE_BASELINES[yearMonth] || null;
}

/**
 * V1.8.6.1 CORRECTION (post-review) — "本月已使用" must never be just
 * `aggregateUsageForMonth` (Local Ledger only) for a month that has a
 * pre-Ledger official baseline (see TDX_OFFICIAL_USAGE_BASELINES above):
 * the Local Usage Ledger only started accumulating on 2026-08-18, so for
 * August 2026 specifically, `aggregateUsageForMonth` alone silently
 * omits real TDX usage that genuinely happened (8/16–8/17) — making
 * "剩餘額度" look artificially larger than it really is. This combines
 * both: `estimated* = officialBaseline (if this month has one, else 0) +
 * local (Ledger-tracked, this month only)`. Every OTHER month (no
 * baseline entry) reduces to exactly the local-only totals, unchanged.
 *
 * Does NOT touch daily history — `summary.days` (and therefore the 7-day
 * reconciliation table) is completely untouched by this; 8/16–8/17 still
 * correctly render "尚無資料" as real Local Ledger DayRows, never
 * fabricated from the baseline. The baseline only ever feeds into
 * MONTH-level totals (this month card, remaining-quota card, and the
 * month-to-date component of the month-end projection) — see
 * projectEndOfMonthPoints below for the one place that also uses it.
 */
export function estimateMonthUsage(summary, now = new Date()) {
  const baseline = getOfficialUsageBaseline(now);
  // CORRECTION (post-review) — "overlap-safe": `baseline.throughDate`
  // means the official cumulative figure ALREADY fully covers every day
  // up to and including that date. Local Ledger rows for days ON OR
  // BEFORE `throughDate` must never also be summed into the month quota
  // total — that would double-count the exact same real TDX usage once
  // via the baseline and once via the Ledger. Only Local Ledger days
  // STRICTLY AFTER `throughDate` contribute here. This does NOT touch
  // `summary.days` itself — a Local DayRow on/before `throughDate` (e.g.
  // 2026-08-18, the Ledger's own partial first day) still exists exactly
  // as recorded and still renders normally in the 7-day daily
  // reconciliation table; it's excluded ONLY from this month-level
  // aggregation. When `baseline.throughDate` is later updated to also
  // cover that day (once TDX's own official 8/18 figures are available),
  // this same exclusion automatically starts covering it too — no
  // separate code change needed, just updating the constant.
  const localTotals = aggregateUsageForMonth(summary, now, { afterDate: baseline ? baseline.throughDate : undefined });
  const localPoints = estimatePoints(localTotals);

  const baselineCalls = baseline ? baseline.calls : 0;
  const baselineBytes = baseline ? baseline.transferKB * 1024 : 0;
  const baselinePoints = baseline ? baseline.officialPoints : 0;

  return {
    baseline, // null, or the raw TDX_OFFICIAL_USAGE_BASELINES entry — callers use this to decide whether to show the "含 X/XX–X/XX TDX 官方既有用量" note
    localTotals,
    localPoints,
    estimatedCalls: baselineCalls + (localTotals.totalDataCalls || 0),
    estimatedBytes: baselineBytes + (localTotals.payloadBytesEstimate || 0),
    estimatedPoints: baselinePoints + localPoints,
  };
}

/**
 * True only when there's a genuine, currently-unresolved coverage gap
 * between the official baseline (covers real TDX usage up through
 * `baseline.throughDate`, inclusive) and the Local Ledger (starts
 * tracking mid-day on `trackingStartedAt`'s date) for the SAME month —
 * i.e. some real stretch of time is covered by NEITHER source. This
 * never estimates/fills in what that uncovered usage might have been
 * (see TDX_OFFICIAL_USAGE_BASELINES' own comment) — it only flags that
 * the gap exists, so the UI can show a "尚待官方日結校正" warning instead
 * of silently presenting month/quota numbers as if they were fully
 * reconciled.
 *
 * False whenever: this month has no baseline at all; the Ledger's
 * tracking-start date is ON OR BEFORE `throughDate` (no gap — either the
 * baseline already covers that day, or there's nothing to reconcile);
 * or tracking started at EXACTLY 00:00:00 Asia/Taipei on the day right
 * after `throughDate` (the Ledger covers that entire day from its very
 * first second, so nothing is left uncovered).
 */
export function hasPendingBaselineCalibrationGap(summary, now = new Date()) {
  const baseline = getOfficialUsageBaseline(now);
  if (!baseline) return false;

  const trackingStartedAt = summary && summary.trackingStartedAt;
  if (!trackingStartedAt) return false;
  const start = new Date(trackingStartedAt);
  if (!Number.isFinite(start.getTime())) return false;

  const trackingStartDateStr = taipeiDateString(start);
  if (trackingStartDateStr <= baseline.throughDate) return false; // baseline already covers this day, or covers a later day — no gap

  const { hour, minute, second } = toTaipeiParts(start);
  const startedAtExactMidnight = hour === 0 && minute === 0 && second === 0;
  return !startedAtExactMidnight;
}

/** max(0, budget - used) — never negative, a maxed-out month reads as exactly 0 remaining, not a confusing negative number. */
export function remainingPoints(estimatedPoints, budget = TDX_MONTHLY_POINT_BUDGET) {
  return Math.max(0, budget - (estimatedPoints || 0));
}

/** estimatedPoints / budget, as a plain fraction (0.42, not "42%") — caller formats for display. 0 if budget is falsy (avoids a divide-by-zero NaN if this is ever misconfigured to 0). */
export function usagePercent(estimatedPoints, budget = TDX_MONTHLY_POINT_BUDGET) {
  if (!budget) return 0;
  return (estimatedPoints || 0) / budget;
}

/**
 * "月底預估" — projects this calendar month's total point cost from the
 * average points/day of already-COMPLETE tracked days (never today,
 * which is still accumulating, and never the tracking-start day, which
 * is a partial day by definition — see isPartialTrackingDay) times the
 * days still remaining in the month after today, plus points already
 * used month-to-date (which already includes today's partial usage).
 *
 * Requires at least 2 complete days of history before it will project
 * anything — a single day's usage can be a poor predictor of a whole
 * month (e.g. an unusually busy Admin/Debug day), and the explicit
 * instruction is "不要用第一個部分日亂推月底". Returns `{ ready: false }`
 * until then; the health page must render "資料累積中", never a number.
 */
export function projectEndOfMonthPoints(summary, now = new Date()) {
  const days = (summary && summary.days) || {};
  const todayStr = taipeiDateString(now);
  const trackingStartedAt = summary && summary.trackingStartedAt;

  // CORRECTION (post-review) — summary.days retains ~35 days of history,
  // which routinely spans a calendar-month boundary (e.g. on 09/03,
  // summary.days can still hold 08/10–08/31). Without this filter,
  // "本月月底預估" would silently average in LAST month's complete days
  // too — a real correctness bug, not just noise: last month's usage
  // pattern has no bearing on whether THIS month is on track to exceed
  // budget. Only days in the SAME Asia/Taipei calendar year+month as
  // `now` are eligible, same month-scoping already used by
  // aggregateUsageForMonth (monthToDatePoints below), so the projection
  // and the month-to-date actual it builds on are always talking about
  // the same month.
  const { year: nowYear, month: nowMonth } = toTaipeiParts(now);
  const monthPrefix = `${nowYear}-${String(nowMonth).padStart(2, '0')}`;

  const completeDayPoints = [];
  for (const [date, row] of Object.entries(days)) {
    if (!date.startsWith(monthPrefix)) continue; // a different calendar month — never eligible for THIS month's projection
    if (date === todayStr) continue; // still in progress, not a complete day
    if (isPartialTrackingDay(date, trackingStartedAt)) continue; // the tracking-start day is never "complete"
    completeDayPoints.push(estimatePoints(row));
  }

  if (completeDayPoints.length < 2) {
    return { ready: false, completeDayCount: completeDayPoints.length };
  }

  const avgPointsPerDay = completeDayPoints.reduce((a, b) => a + b, 0) / completeDayPoints.length;
  // CORRECTION (post-review) — month-to-date must include the official
  // pre-Ledger baseline when this month has one (see estimateMonthUsage),
  // not just Local-Ledger totals — otherwise the projection would start
  // from an artificially low base for a month like 2026-08. The DAILY
  // AVERAGE above is deliberately untouched by this: it must only ever
  // come from genuine Local Ledger complete-day rows, never from the
  // baseline (which isn't a set of daily rows at all, just one cumulative
  // pre-Ledger figure) — "不要把 8/16、8/17 官方歷史資料假裝成 Local
  // complete tracked days".
  const monthToDatePoints = estimateMonthUsage(summary, now).estimatedPoints;

  const { year, month, day } = toTaipeiParts(now);
  // Date.UTC's month param is 0-indexed, so passing the (1-indexed)
  // current month as-is refers to day 0 of the NEXT month — i.e. the
  // last day of THIS month. A small, well-known trick, not a bug.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const remainingDaysAfterToday = Math.max(0, daysInMonth - day);

  const projected = monthToDatePoints + avgPointsPerDay * remainingDaysAfterToday;
  return {
    ready: true,
    projected,
    avgPointsPerDay,
    remainingDaysAfterToday,
    monthToDatePoints,
    completeDayCount: completeDayPoints.length,
  };
}
