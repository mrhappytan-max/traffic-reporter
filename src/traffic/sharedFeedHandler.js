// V57 — GET /internal/shared-feed
//
// The ONLY externally reachable surface of the Shared Traffic Feed. Read-only
// by construction: it imports readSharedFeed/selectFeedWindow and has no access
// to any write path, so it cannot mutate producer state even by mistake.
//
// It also never fetches anything upstream. A KV miss returns an empty feed —
// never a re-fetch of TDX / PBS / CCTV, and never a collage composition. That
// guarantee is the whole reason the consuming project can claim "0 extra
// upstream calls".
//
// AUTH: its own bearer token (TRAFFIC_FEED_SECRET), deliberately NOT the
// Admin Basic Auth used by /health and the /debug//admin pages — this route is
// called machine-to-machine over a Service Binding, and Basic Auth would be
// both wrong for that caller and confusing to operate. It is therefore NOT in
// index.js's ADMIN_PATHS set, exactly like the public CCTV image route, but
// unlike that route it is credentialed.
//
// TRANSPORT: a Cloudflare Service Binding called with HTTP-style fetch
// (`env.TRAFFIC_FEED.fetch(...)` on the consumer side), NOT WorkerEntrypoint
// RPC. That keeps this handler a plain Request -> Response function, so the
// exact same code would serve an authenticated public HTTPS caller if the two
// Workers ever end up in different Cloudflare accounts.

import { readSharedFeed, selectFeedWindow, SHARED_FEED_SCHEMA_VERSION } from './sharedFeed.js';

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

export async function handleSharedFeed(request, env, now = new Date()) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
  }

  const secret = env.TRAFFIC_FEED_SECRET;
  if (!secret) {
    // Not configured is an operator error, not a caller error. 503 keeps it
    // distinguishable from a wrong token in logs, and keeps the route closed
    // rather than accidentally anonymous.
    return jsonResponse({ error: 'shared_feed_not_configured' }, 503);
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const feed = await readSharedFeed(env.TRAFFIC_KV);
  if (!feed.kvAvailable) {
    // A real storage outage. The consumer treats any non-200 as "feed
    // unavailable" and skips its round — it must never fall back to an
    // upstream source, so an honest error here is the correct answer.
    return jsonResponse({ error: 'feed_storage_unavailable' }, 503);
  }

  const selection = selectFeedWindow(feed.events, {
    windowMinutes: url.searchParams.get('windowMinutes'),
    limit: url.searchParams.get('limit'),
    now,
  });

  return jsonResponse({
    schemaVersion: SHARED_FEED_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    snapshotUpdatedAt: feed.updatedAt,
    windowMinutes: selection.windowMinutes,
    total: selection.total,
    truncated: selection.truncated,
    events: selection.events,
  });
}
