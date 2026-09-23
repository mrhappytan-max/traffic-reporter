// 路況-080: additive-only file-based operational logging for the PBS
// Relay's own process (server.js). Until now server.js had zero file
// logging — every signal (server start time, health-check outcomes,
// uncaught crashes, termination signals) only ever went to
// console.log/console.error, which is lost the moment the hosting
// console window closes or the process is relaunched. That gap has left
// all three Relay outages (2026-09-13, 09-22, 09-23) fundamentally
// unverifiable after the fact from log evidence alone.
//
// This module is modeled on localRuntime.js's writeSuccessLog/
// writeFailureLog pattern (Taipei-date-named JSONL files, 7-day
// rotation), but writes to its own logs/relay/ subdirectory — kept
// separate from LocalMonitor's logs/*.jsonl so the two processes'
// operational histories never interleave in the same file.
//
// Sync fs calls are used deliberately here (not the async fs/promises
// API localRuntime.js uses): the highest-value records this module
// writes are exactly the ones written right before the process exits
// (an uncaught exception, a termination signal) — an async write racing
// process.exit() can be lost entirely. A handful of low-frequency sync
// writes has no measurable effect on an HTTP server that otherwise does
// no disk I/O per request.
//
// Every public function here is defensive: a logging failure (e.g. the
// log directory is unwritable) is caught and reported via console.error
// only — exactly the visibility level that existed before this module —
// and never thrown, so operational logging can never itself take down
// the Relay or change its existing request-handling/API behavior.

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_LOG_RETENTION_DAYS = 7;

function taipeiDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function purgeOldRelayLogs(logDirectory, { now = new Date(), retentionDays = DEFAULT_LOG_RETENTION_DAYS } = {}) {
  mkdirSync(logDirectory, { recursive: true });
  const cutoff = new Date(now.getTime() - (retentionDays - 1) * 24 * 60 * 60 * 1000);
  const cutoffDate = taipeiDate(cutoff);
  for (const entry of readdirSync(logDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
    if (entry.name.slice(0, 10) < cutoffDate) unlinkSync(join(logDirectory, entry.name));
  }
}

function writeRelayLog(logDirectory, record, now = new Date()) {
  try {
    purgeOldRelayLogs(logDirectory, { now });
    const full = { timestamp: now.toISOString(), taipeiDate: taipeiDate(now), ...record };
    appendFileSync(join(logDirectory, `${full.taipeiDate}.jsonl`), `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  } catch (error) {
    console.error(`[pbs-relay] failed to write operational log: ${error && error.message}`);
    return null;
  }
}

export function logServerStart(logDirectory, { port }, now = new Date()) {
  return writeRelayLog(logDirectory, { event: 'server_start', port }, now);
}

// Health-endpoint logging is intentionally throttled, not per-request:
// /health is polled by health-watchdog.ps1 roughly once a minute, and
// logging every single call would dominate the log with pure noise. A
// record is written only when the outcome differs from the last one
// recorded (state change) or when at least minIntervalMs has passed
// since the last record (low-frequency heartbeat) — whichever comes
// first. This matches 路況-080's "低頻率/狀態變化可接受" allowance.
//
// State lives in the closure returned per call, not module-level
// globals, so two independent createHealthCheckLogger() calls (e.g. one
// per createServer() instance in tests) never share or leak state into
// each other.
export const DEFAULT_HEALTH_LOG_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function createHealthCheckLogger(logDirectory, { minIntervalMs = DEFAULT_HEALTH_LOG_MIN_INTERVAL_MS } = {}) {
  let lastLoggedAt = 0;
  let lastStatus = null;
  return function logHealthCheck(status = 'ok', now = new Date()) {
    const elapsed = now.getTime() - lastLoggedAt;
    if (status === lastStatus && elapsed < minIntervalMs) return null;
    lastLoggedAt = now.getTime();
    lastStatus = status;
    return writeRelayLog(logDirectory, { event: 'health_check', status }, now);
  };
}

export function logUncaughtException(logDirectory, error, now = new Date()) {
  return writeRelayLog(logDirectory, {
    event: 'uncaught_exception',
    errorName: error?.name || 'unknown',
    message: error?.message || String(error),
    stack: error?.stack || null,
  }, now);
}

export function logUnhandledRejection(logDirectory, reason, now = new Date()) {
  const error = reason instanceof Error ? reason : null;
  return writeRelayLog(logDirectory, {
    event: 'unhandled_rejection',
    errorName: error?.name || 'unknown',
    message: error?.message || String(reason),
    stack: error?.stack || null,
  }, now);
}

export function logSignal(logDirectory, signal, now = new Date()) {
  return writeRelayLog(logDirectory, { event: 'signal', signal }, now);
}
