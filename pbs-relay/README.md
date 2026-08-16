# pbs-relay

A minimal PBS (警廣) JSON relay/cache, meant to run on Render (Singapore
region). It proxies the official PBS road-data endpoint behind a bearer
token, with a short in-memory cache. It carries **no business logic** —
no parsing, no Hsinchu filtering, no dedup, no LINE. That all stays in
the Cloudflare Worker's own `src/pbs/*` pipeline.

**Not wired into production yet.** The Worker still fetches PBS directly
(`src/pbs/pbsConfig.js` / `src/pbs/client.js`); this Relay exists so it
can be evaluated on its own before anything is switched over.

## Endpoints

- `GET /health` — always `200 {"ok": true}`, no auth required.
- `GET /pbs` — requires `Authorization: Bearer <RELAY_TOKEN>`. Returns
  the official PBS endpoint's response body byte-for-byte (no field
  changes, no filtering, no re-parsing). Upstream timeout is 15s, with
  at most one retry (timeout/network-error/5xx only, never on 4xx),
  ~300–1000ms backoff between attempts.

Response headers on `/pbs`:
- `X-PBS-Cache`: `HIT` (served from the in-memory cache, <3 min old),
  `MISS` (freshly fetched from upstream), or `STALE` (upstream failed
  this request, but a previous successful response is being served
  instead of nothing).
- `X-PBS-Upstream-Duration-Ms`: how long the upstream call took, on
  MISS only.

If upstream fails and there's no cached data at all yet, `/pbs` returns
`502` (or `504` for a timeout) with a small structured JSON error body —
never fabricated data.

## Environment variables

- `PORT` — provided by Render automatically.
- `RELAY_TOKEN` — required. Set it in the Render dashboard (or your own
  host's secret store) — never commit it. If it's unset, `/pbs` fails
  closed (every request gets 401).

## Local dev

```
cd pbs-relay
npm start                 # listens on 0.0.0.0:${PORT:-3000}
npm test                  # node --test tests/
```

## Deploying to Render

See the repository's PR description / handoff notes for the exact
dashboard fields (Root Directory, Build Command, Start Command, Region,
env vars). `render.yaml` in this directory is an optional reference —
Render's automatic Blueprint scan only looks at the repo root, and this
repo's root is the unrelated Cloudflare Worker, so a manual Web Service
is the simplest path.
