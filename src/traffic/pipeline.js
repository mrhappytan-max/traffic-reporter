// Full V1.2A/B pipeline: fetch all 5 TDX sources (Hsinchu geo-filter and
// noise filters already applied per-source, see src/tdx/sources.js) ->
// read dedup state -> classify new/updated/duplicate -> (Cron only) commit.
//
// Two entry points share the same read+classify core on purpose:
//   - runTdxPipelinePreview: read-only, used by GET /debug/status. Never
//     calls commitDedupeState — by construction, not by convention.
//   - runTdxPipelineAndCommit: used by the Cron scheduled handler. Reads,
//     classifies, and (if KV is reliably available) commits.
//
// This module still doesn't send anything anywhere itself — the LINE
// broadcast layer (src/traffic/broadcastPipeline.js) consumes its output
// (`allEvents`, `kvAvailable`) separately, see src/traffic/scheduled.js.

import { fetchAllSources } from '../tdx/fetchAll.js';
import { readDedupeState, classifyEvents, commitDedupeState } from './dedupe.js';

async function runCore(env) {
  const { tokenOk, results } = await fetchAllSources(env);
  const allEvents = results.flatMap((r) => r.events);
  const sourceHealth = Object.fromEntries(results.map((r) => [r.source, r.ok]));
  const dedupeState = await readDedupeState(env.TRAFFIC_KV); // read-only, always

  // Fail-closed: if we can't reliably read dedup state, don't classify
  // anything as new/updated/pushable — better to miss a broadcast than to
  // risk re-flooding every 5 minutes because we lost track of what was
  // already seen.
  const classification = dedupeState.kvAvailable
    ? classifyEvents(allEvents, { ...dedupeState, sourceHealth })
    : {
        baselineSeedEvents: [],
        newEvents: [],
        updatedEvents: [],
        duplicateEvents: [],
        pushableEvents: [],
        missingKeys: [],
      };

  return { tokenOk, results, allEvents, sourceHealth, dedupeState, classification };
}

function buildSummary(core, commitResult) {
  const prunedKeys = (commitResult && commitResult.prunedKeys) || [];
  const { tokenOk, results, allEvents, sourceHealth, dedupeState, classification } = core;

  const kvWriteFailed = Boolean(commitResult && commitResult.reason === 'kv-error');
  // A write failure mid-run means we can't trust that anything got
  // recorded — fail closed for THIS run's output too, same as a read
  // failure, even though the read itself may have succeeded.
  const effectiveKvAvailable = dedupeState.kvAvailable && !kvWriteFailed;
  const effective = effectiveKvAvailable
    ? classification
    : { newEvents: [], updatedEvents: [], duplicateEvents: [], pushableEvents: [] };

  const baselineInitialized =
    dedupeState.baselineInitialized || Boolean(commitResult && commitResult.baselineJustInitialized);

  const failedSources = results
    .filter((r) => !r.ok)
    .map((r) => ({ source: r.source, label: r.label, status: r.status, error: r.error }));

  const errors = [...failedSources.map((f) => `${f.source}: ${f.error}`)];
  const kvError = dedupeState.kvError || (kvWriteFailed ? commitResult.error : null);
  if (kvError) errors.push(`kv: ${kvError}`);

  return {
    lastRunAt: new Date().toISOString(),
    tokenOk,
    baselineInitialized,
    kvAvailable: effectiveKvAvailable,
    kvError,
    sourceHealth,
    rawCounts: Object.fromEntries(results.map((r) => [r.source, r.rawCount])),
    normalizedCount: results.reduce((sum, r) => sum + r.normalizedCount, 0),
    hsinchuFilteredCount: allEvents.length,
    newEventsCount: effective.newEvents.length,
    updatedEventsCount: effective.updatedEvents.length,
    duplicateCount: effective.duplicateEvents.length,
    pushableEventsCount: effective.pushableEvents.length,
    baselineSeedCount: classification.baselineSeedEvents.length,
    // Informational only — stored keys absent from this run's fetch.
    // Never affects newEventsCount/pushableEventsCount.
    missingKeysCount: classification.missingKeys.length,
    failedSources,
    errors,
    sources: results.map((r) => ({
      source: r.source,
      label: r.label,
      ok: r.ok,
      rawCount: r.rawCount,
      normalizedCount: r.normalizedCount,
      count: r.count,
      status: r.status,
      error: r.error,
    })),
    sample: {
      new: effective.newEvents.slice(0, 3),
      updated: effective.updatedEvents.slice(0, 3),
      duplicate: effective.duplicateEvents.slice(0, 2),
    },
    // Full lists too, for internal/test use and for the LINE broadcast
    // layer — /debug/status truncates `pending` before responding and
    // never surfaces `allEvents`/`dedupeMapSnapshot` directly, see
    // debugStatus.js.
    pending: effective.pushableEvents,
    allEvents,
    newEvents: effective.newEvents,
    updatedEvents: effective.updatedEvents,
    duplicateEvents: effective.duplicateEvents,
    // The dedupe-state map AS READ at the start of this run (before any
    // commit). broadcastPipeline.js uses this + newEvents/updatedEvents to
    // work out "when was this event's current content first established"
    // for its enabledAt backfill guard, without duplicating dedupe.js's
    // own lastSeenAt bookkeeping.
    dedupeMapSnapshot: dedupeState.dedupeMap,
    // Event keys (source:rawId) genuinely, healthily pruned from
    // dedupe-state THIS run — notified-state cleanup piggybacks on this
    // same lifecycle decision rather than tracking its own absence clock,
    // see broadcastPipeline.js.
    prunedKeys,
  };
}

/** Read-only preview — GET /debug/status. Never writes to KV. */
export async function runTdxPipelinePreview(env) {
  const core = await runCore(env);
  return buildSummary(core, null);
}

/**
 * Cron path — reads, classifies, and commits dedup state if possible.
 * `now` defaults to the real clock; tests pass an explicit Date so
 * multi-hour scenarios (source outages, absence windows) don't need to
 * sleep.
 */
export async function runTdxPipelineAndCommit(env, now = new Date()) {
  const core = await runCore(env);

  let commitResult = { committed: false, reason: 'kv-unavailable' };
  if (core.dedupeState.kvAvailable) {
    commitResult = await commitDedupeState(
      env.TRAFFIC_KV,
      {
        baselineInitialized: core.dedupeState.baselineInitialized,
        dedupeMap: core.dedupeState.dedupeMap,
        classification: core.classification,
      },
      now
    );
  }

  return buildSummary(core, commitResult);
}
