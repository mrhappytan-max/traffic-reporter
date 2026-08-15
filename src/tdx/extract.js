// Pulls the actual list of records out of a TDX response envelope.
//
// We do not have live-verified schemas for every endpoint in this batch
// (see TDX_SOURCE_AUDIT.md), so this is deliberately defensive: try the
// candidate array-property names first, then fall back to "the first
// array-valued property on the object" so a slightly different envelope
// shape doesn't break the whole source.

export function extractArray(json, candidateKeys = []) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];

  for (const key of candidateKeys) {
    if (Array.isArray(json[key])) return json[key];
  }

  for (const value of Object.values(json)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

/** Dot-path getter, e.g. get(obj, "Location.StartLocationMile"). */
export function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** First non-empty value among several candidate dot-paths. */
export function firstDefined(raw, paths, fallback = '') {
  for (const path of paths) {
    const value = get(raw, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}
