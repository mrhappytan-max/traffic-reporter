// LINE user/group broadcast ON/OFF state, backed by TRAFFIC_KV. One key,
// no TTL (per explicit instruction — subscription preference should never
// silently expire).

const SUBSCRIPTIONS_KEY = 'line:subscriptions';

function safeErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return 'Unknown KV error';
}

function normalizeSubscriptions(parsed) {
  return {
    users: parsed && parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
    groups: parsed && parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
  };
}

/** Read-only. Everyone defaults to OFF (enabled=false) unless explicitly turned on. */
export async function readSubscriptions(kv) {
  if (!kv) {
    return { kvAvailable: false, kvError: 'TRAFFIC_KV binding not configured', subscriptions: { users: {}, groups: {} } };
  }

  try {
    const raw = await kv.get(SUBSCRIPTIONS_KEY);
    let subscriptions = { users: {}, groups: {} };
    if (raw) {
      try {
        subscriptions = normalizeSubscriptions(JSON.parse(raw));
      } catch {
        subscriptions = { users: {}, groups: {} }; // corrupt blob -> treat as empty, next write repairs it
      }
    }
    return { kvAvailable: true, kvError: null, subscriptions };
  } catch (err) {
    return { kvAvailable: false, kvError: safeErrorMessage(err), subscriptions: { users: {}, groups: {} } };
  }
}

export function isUserEnabled(subscriptions, userId) {
  return Boolean(subscriptions.users[userId]);
}

export function isGroupEnabled(subscriptions, groupId) {
  return Boolean(subscriptions.groups[groupId]);
}

async function setEnabled(kv, kind, id, enabled) {
  const state = await readSubscriptions(kv);
  if (!state.kvAvailable) return { committed: false, error: state.kvError };

  const next = {
    users: { ...state.subscriptions.users },
    groups: { ...state.subscriptions.groups },
  };
  next[kind][id] = enabled;

  try {
    await kv.put(SUBSCRIPTIONS_KEY, JSON.stringify(next)); // no TTL
    return { committed: true, subscriptions: next };
  } catch (err) {
    return { committed: false, error: safeErrorMessage(err) };
  }
}

export function setUserEnabled(kv, userId, enabled) {
  return setEnabled(kv, 'users', userId, enabled);
}

export function setGroupEnabled(kv, groupId, enabled) {
  return setEnabled(kv, 'groups', groupId, enabled);
}
