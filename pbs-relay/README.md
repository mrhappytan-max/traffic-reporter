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

## Windows-only PBS edge-filter prototype

This prototype is separate from the HTTP relay and from every Cloudflare,
KV, Cron, LINE, CCTV, TDX, and production path. It fetches the official PBS
payload locally, keeps only accident records relevant to Hsinchu City,
Hsinchu County, Zhubei, Zhunan, and Toufen, compares them with the prior
local baseline, and prints `NEW`, `UPDATED`, `CLEARED`, `UNCHANGED`, plus
`SHOULD_PUSH=YES|NO`. With `PBS_DEBUG_PUSH_ENABLED=true`, confirmed changes
are sent one event at a time to the Cloudflare debug-only endpoint after
the local state write succeeds. The switch defaults to false; this path
never calls LINE, CCTV, Shared Feed, Business KV, or the production business
pipeline.

```powershell
npm.cmd run prototype        # one fetch/compare/state-write cycle
npm.cmd run prototype:watch  # repeat every 3 minutes in this terminal
```

The first successful run is a quiet baseline (`SHOULD_PUSH=NO`). State is
written atomically to `data/relevant-state.json`; override it for testing
with `PBS_LOCAL_STATE_PATH`. Watch interval can be overridden with
`PBS_LOCAL_INTERVAL_MS` (minimum 10000 ms). A failed fetch does not alter
state and always reports `SHOULD_PUSH=NO`.

### Windows scheduled monitor

`scripts/install-local-monitor-task.ps1` creates the user-logon task
`TrafficReporter-PBS-LocalMonitor`. It runs Node directly with
`src/localMonitor.js --watch`, keeps the existing three-minute interval,
ignores duplicate Task Scheduler starts, and retries an abnormal exit up
to five times at one-minute intervals. A one-minute Task Scheduler watchdog
also attempts a start; `IgnoreNew` makes those attempts no-ops while the
monitor is healthy, but restores it after a forced exit. This does not
change the monitor's three-minute PBS fetch interval. The installer refuses
to overwrite an existing task.

The monitor also uses `data/local-monitor.lock` to reject a second manual
or scheduled instance. A dead PID makes the lock stale and recoverable on
the next start. Minimal JSONL operational records are written by Taipei
date under `logs/`; only seven dates are retained. Logs never include
tokens, Authorization values, credentials, or full event payloads.

### Debug-only push

`src/debugPushClient.js` reads `PBS_DEBUG_PUSH_SECRET` only at runtime and
uses a five-second timeout with at most two total attempts. Only timeout,
network errors, and eligible 5xx responses retry. Authentication failures
fail closed. `src/localDebugPush.js` dispatches only `NEW`, `UPDATED`, and
confirmed `CLEARED` events; baseline, `UNCHANGED`, and
`MISSING_PENDING_CLEAR` never push. Request IDs are deterministic for the
same event, lifecycle, and fingerprint.

Manual debug fixtures remain available without connecting real events:

```powershell
npm.cmd run debug-push-test -- NEW
npm.cmd run debug-push-test -- UPDATED
npm.cmd run debug-push-test -- CLEARED
npm.cmd run debug-push-test -- DUPLICATE
```

Secrets, runtime state, lock files, and `logs/` must never be committed.
