// LINE user/group broadcast ON/OFF state, backed by TRAFFIC_KV. One key,
// no TTL (subscription preference should never silently expire).
//
// Each entry is { enabled, enabledAt }. enabledAt exists specifically so
// a brand-new subscriber never gets flooded with events that existed
// before they turned broadcasting on — see broadcastPipeline.js's
// "firstSeenAt < target.enabledAt -> skip" rule. Every transition TO
// enabled=true (first-ever enable, or re-enable after being off) stamps a
// fresh enabledAt; turning OFF leaves it alone (irrelevant while off).
//
// Backward compatible with the pre-V1.2B-patch schema, which stored a
// bare boolean (`{ "U123": true }`). readSubscriptions() normalizes that
// in memory to { enabled: true, enabledAt: <this read's `now`> } — i.e.
// "conservatively just-subscribed, no history to backfill" — WITHOUT
// writing anything (this function stays pure/read-only for /debug/status'
// sake). The Cron path calls persistSubscriptions() once it detects
// migrationNeeded, which pins that enabledAt permanently so it stops
// drifting forward on every subsequent read. See broadcastPipeline.js.

const SUBSCRIPTIONS_KEY = 'line:subscriptions';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

function normalizeEntry(raw, fallbackEnabledAtIso) {
  if (raw === true) {
    return { entry: { enabled: true, enabledAt: fallbackEnabledAtIso }, migrated: true };
  }
  if (!raw || typeof raw !== 'object') {
    return { entry: { enabled: false, enabledAt: null }, migrated: false };
  }
  if (raw.enabled === true && !raw.enabledAt) {
    // Shouldn't normally happen, but stay conservative if it does.
    return { entry: { enabled: true, enabledAt: fallbackEnabledAtIso }, migrated: true };
  }
  return { entry: { enabled: Boolean(raw.enabled), enabledAt: raw.enabledAt ?? null }, migrated: false };
}

function normalizeGroup(rawGroup, fallbackEnabledAtIso) {
  const out = {};
  let migrated = false;
  for (const [id, raw] of Object.entries(rawGroup || {})) {
    const { entry, migrated: entryMigrated } = normalizeEntry(raw, fallbackEnabledAtIso);
    out[id] = entry;
    if (entryMigrated) migrated = true;
  }
  return { entries: out, migrated };
}

/**
 * Read-only. Everyone defaults to OFF (enabled=false) unless explicitly
 * turned on. `now` supplies the fallback enabledAt for any legacy/corrupt
 * entries found — always pass the same `now` you're using for the rest of
 * this run so timestamps stay internally consistent.
 */
export async function readSubscriptions(kv, now = new Date()) {
  if (!kv) {
    return {
      kvAvailable: false,
      kvError: 'TRAFFIC_KV binding not configured',
      subscriptions: { users: {}, groups: {} },
      migrationNeeded: false,
    };
  }

  try {
    const raw = await kv.get(SUBSCRIPTIONS_KEY);
    let subscriptions = { users: {}, groups: {} };
    let migrationNeeded = false;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const users = normalizeGroup(parsed?.users, now.toISOString());
        const groups = normalizeGroup(parsed?.groups, now.toISOString());
        subscriptions = { users: users.entries, groups: groups.entries };
        migrationNeeded = users.migrated || groups.migrated;
      } catch {
        subscriptions = { users: {}, groups: {} }; // corrupt blob -> treat as empty
      }
    }

    return { kvAvailable: true, kvError: null, subscriptions, migrationNeeded };
  } catch (err) {
    return {
      kvAvailable: false,
      kvError: safeErrorMessage(err),
      subscriptions: { users: {}, groups: {} },
      migrationNeeded: false,
    };
  }
}

export function isUserEnabled(subscriptions, userId) {
  return Boolean(subscriptions.users[userId]?.enabled);
}

export function isGroupEnabled(subscriptions, groupId) {
  return Boolean(subscriptions.groups[groupId]?.enabled);
}

/** Writes back the already-normalized (new-schema) subscriptions object
 * as-is — used for the one-time legacy-format migration write. */
export async function persistSubscriptions(kv, subscriptions) {
  try {
    await kv.put(SUBSCRIPTIONS_KEY, JSON.stringify(subscriptions)); // no TTL
    return { committed: true };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}

async function setEnabled(kv, kind, id, enabled, now = new Date()) {
  const state = await readSubscriptions(kv, now);
  if (!state.kvAvailable) return { committed: false, error: state.kvError };

  const previous = state.subscriptions[kind][id];
  const next = {
    users: { ...state.subscriptions.users },
    groups: { ...state.subscriptions.groups },
  };
  next[kind][id] = {
    enabled,
    enabledAt: enabled ? now.toISOString() : (previous ? previous.enabledAt : null),
  };

  return persistSubscriptions(kv, next).then((result) => ({ ...result, subscriptions: next }));
}

export function setUserEnabled(kv, userId, enabled, now = new Date()) {
  return setEnabled(kv, 'users', userId, enabled, now);
}

export function setGroupEnabled(kv, groupId, enabled, now = new Date()) {
  return setEnabled(kv, 'groups', groupId, enabled, now);
}
