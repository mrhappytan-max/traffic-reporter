// V1.9.2 — WRITE_ON_CHANGE shared primitive. Real Cloudflare account
// alert (see 07_KNOWN_ISSUES.md's V1.9.2 record): traffic-reporter-kv hit
// 733/1000 daily KV writes (97.9% of the whole account's budget), and the
// prior round's read-only forensic pass identified several KV keys that
// were re-written on EVERY Cron tick even when their real content had not
// changed at all (only a generated `updatedAt`/`lastSeenAt`-style
// timestamp differed). This module gives every WRITE_ON_CHANGE call site
// in this project (usageLedger.js, sharedFeed.js, incidentSuppression.js)
// exactly ONE definition of "did the real content change" — never a
// second, drifting copy of the same comparison.
//
// Deliberately order-independent: two objects built from spreads/
// Object.entries in a slightly different key order (a real risk any time
// a value is rebuilt from `{...existing, ...patch}`) must still compare
// equal if their actual data is the same. A plain `JSON.stringify(a) ===
// JSON.stringify(b)` does NOT guarantee that (JSON.stringify preserves
// insertion order) — this sorts every object's keys, recursively, before
// stringifying, so key order never matters.
//
// Scope: this project's own KV values only — plain JSON-shaped data
// (objects, arrays, strings, numbers, booleans, null). Never asked to
// compare a Date, a Map, a Set, a function, or anything else
// JSON.stringify itself can't already round-trip.

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic, key-order-independent JSON serialization. Exported mainly for tests. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/** True only when `a` and `b` carry the same real content, regardless of key order. `undefined`/`null` compare equal to each other only if both are exactly that — never loosely coerced. */
export function contentEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}
