# PROJECT_HANDOFF.md — traffic-reporter (路況播報員)

**Read this file before touching the repo.** It exists so a new AI/agent session can operate correctly without re-scanning the whole codebase or re-investigating history that is already solved. If something below conflicts with what you find in the code, trust the code and treat this file as stale — but update it once you understand why.

```
STATUS:  V1.5 Alpha sealed, in production observation
MAIN:    4efb9e5
DATE:    2026-08-16
PHASE:   No new features. Only fix what real road testing surfaces.
```

---

## 1. What this project is

A Cloudflare Worker that, every 5 minutes, fetches road-condition data from two independent official sources (TDX, PBS), normalizes/dedupes/merges them, and pushes LINE messages to enabled subscribers for events that might force a professional driver (taxi/for-hire) to change route *right now*. Ordinary traffic congestion is deliberately excluded — the target audience already has Google Maps / 1968 for that.

Repo: `mrhappytan-max/traffic-reporter`. Single Worker, no D1, no queues — everything lives in one Cloudflare KV namespace.

---

## 2. Architecture at a glance

```
                    ┌─────────────────────────────────────────────┐
                    │         Cloudflare Worker (this repo)         │
                    │                                               │
TDX API ──HTTPS──▶  │  fetchAllSources()  ──▶  normalize/classify   │
(5 sources:         │                              │                 │
 freeway/highway/   │                              ▼                 │
 CMS/2×bus-alert)   │                     Hsinchu geo-filter         │
                    │                              │                 │
                    │                              ▼                 │
                    │              KV dedupe (traffic:dedupe-state,  │
                    │              traffic:baseline)                 │
                    │                              │                 │
Windows PBS Relay   │                              ▼                 │
(off-Cloudflare) ──▶│ crossSourceDedup.mergeForBroadcast()           │
  via Cloudflare     │  (PBS active events + TDX events -> canonical) │
  Tunnel + Workers   │                              │                 │
  VPC Service ───────┤                              ▼                 │
                    │        congestionValidation (VD speed check,   │
                    │        only affects congestionSeverity field)  │
                    │                              │                 │
                    │                              ▼                 │
                    │       broadcastRules.getBroadcastEligibility() │
                    │              (the V1.5 whitelist gate)         │
                    │                              │                 │
                    │                              ▼                 │
                    │        congestionCluster (dead code path now — │
                    │        congestion never reaches here anymore)  │
                    │                              │                 │
                    │                              ▼                 │
                    │      broadcastPipeline: subscriptions +        │
                    │      per-target notified-state + LINE push     │
                    └──────────────────┬────────────────────────────┘
                                        │
                                        ▼
                                  LINE Messaging API
```

Two entry points share almost all of this logic:
- **`scheduled.js`** (`runScheduledTdxSync`) — the real Cron path. Writes KV, pushes LINE.
- **`debugStatus.js`** (`handleDebugStatus`, `GET /debug/status`) — the read-only preview. Runs the exact same pipeline in `dryRun` mode: computes everything, writes nothing, never calls LINE.

---

## 3. Data flow, in commit order (why things are shaped the way they are)

1. **V1.1–V1.2A**: TDX fetch/normalize/Hsinchu-filter/KV-dedupe/baseline. `src/tdx/*`, `src/traffic/pipeline.js`, `src/traffic/dedupe.js`.
2. **V1.2B–V1.2C**: LINE broadcast pipeline (`broadcastPipeline.js`), per-target notified-state (`notified.js`), driver-readable road section labels (`roadSectionLabel.js`), congestion clustering to stop repeat-tick spam (`congestionCluster.js`).
3. **V1.2C.1**: TDX OAuth token caching (memory → KV → real OAuth) to stop 429s from isolate churn. `src/tdx/auth.js`.
4. **V1.3 → VPC rollout**: PBS as a second, initially observation-only source. Direct `fetch()` to `rtr.pbs.gov.tw` from Cloudflare **does not work** (TCP connect timeout from Cloudflare's network — confirmed, not a code bug). Solved by standing up a relay on a Windows machine, reachable via **Cloudflare Tunnel + Workers VPC Service** (binding `PBS_RELAY_WINDOWS`, path-token auth). **Do not re-investigate this history (400/401/token issues, tunnel/VPC setup) unless production actually breaks again** — it's solved and stable as of V1.4/V1.4.1.
5. **V1.4 Alpha**: PBS merged into the real broadcast (`crossSourceDedup.mergeForBroadcast`), `PBS_BROADCAST_ENABLED` flipped to `true`.
6. **V1.4.1**: congestion severity tiers (moderate/congested/severe — `congestionSeverity.js`), corrected 國1 頭份/新竹系統 mileage anchors (`roadSectionLabel.js`), VD (Vehicle Detector) real-time speed as a second opinion before ever calling something "severe" (`vdSpeed.js`, `congestionValidation.js`).
7. **V1.5**: product repositioning — pure congestion is **never** broadcast-eligible regardless of severity; `construction`/`other` became keyword-conditional; `alert` defaults off. `broadcastRules.js`'s `getBroadcastEligibility()`.

---

## 4. The V1.5 broadcast eligibility rule (the thing most likely to need tuning)

Lives in `src/traffic/broadcastRules.js`, applied inside `broadcastPipeline.js`'s `runLineBroadcast()` **before** clustering/relevance/pending-target computation, so an ineligible event never even reaches those stages.

```js
ALWAYS_ELIGIBLE_TYPES = accident, closure, control
NEVER_ELIGIBLE_TYPES  = congestion, alert

construction -> eligible ONLY if title+description matches one of:
  封閉 / 車道封閉 / 占用車道 / 佔用車道 / 禁止通行 / 無法通行 / 改道 / 交通管制

other -> eligible ONLY if title+description matches one of:
  淹水 / 積水 / 涵洞 / 落石 / 坍方 / 路基流失 / 樹倒 / 電線掉落 / 電線桿倒 /
  掉落物 / 貨物散落 / 火災 / 橋梁封閉 / 橋梁異常 / 河川暴漲 / 溪水暴漲 /
  道路中斷 / 無法通行

anything else (a type this rule doesn't recognize) -> fails closed, not broadcast
```

`getBroadcastEligibility(event)` returns `{ eligible, reason }`. `broadcastPipeline.js` aggregates exclusion reasons into `result.ineligibleByReason` (keys: `congestion-excluded`, `alert-excluded`, `construction-no-impact-keyword`, `other-no-anomaly-keyword`, `unrecognized-type`) and a plain count `result.typeIneligibleCount`. Both surface in `GET /debug/status`. **This is where to look first if the real-world complaint is "an event should have/shouldn't have broadcast."**

Important: this gate does **not** touch data collection. TDX/PBS still fetch/normalize/classify/cluster/VD-validate every event regardless of eligibility — congestion is still fully visible in `/debug/status`, it just never reaches LINE. If the same real incident is reported as both congestion and accident/closure (two different source records — same-source-different-type records are never merged), the congestion record is dropped here and the accident/closure record broadcasts normally, so the incident still reaches LINE exactly once.

If asked to tune the keyword lists, edit `CONSTRUCTION_IMPACT_PATTERNS` / `OTHER_ANOMALY_PATTERNS` in `broadcastRules.js` directly — that's the single source of truth, nothing else needs to change.

---

## 5. Fail-safe guarantees (verified by tests, don't assume — check `test/` if in doubt)

- **PBS failure never affects TDX.** `scheduled.js` wraps the PBS pipeline call in its own try/catch; on failure, `mergeForBroadcast` receives empty canonical/unique arrays and returns TDX's own event list completely unchanged.
- **TDX failure never affects PBS.** If TDX's OAuth token fails, `allEvents` is empty but `TRAFFIC_KV` itself (and therefore `dedupeAvailable`) is unaffected, so PBS's own active/unique events still merge in and broadcast normally.
- **VD (speed validation) failure never blocks any event.** `congestionValidation.js`'s `applyCongestionSeverityValidation` is lazy (skips the VD fetch entirely if no congestion event is present this run) and fail-safe (any fetch/parse/no-match outcome leaves severity exactly as keyword-classified, never blocks, never affects non-congestion events at all — those never call this path in the first place).
- **A single LINE push target failing never blocks other targets** or the rest of the run (`broadcastPipeline.js`'s per-target try/catch, partial-failure retry via notified-state).
- **Missing LINE token / unavailable subscriptions / unavailable notified-state** → fail-closed to 0 pushes for everyone, never a guess.
- **`GET /debug/status` and `GET /debug/pbs` are provably read-only** — `dryRun: true` unconditionally; see `test/pipeline.test.js` / `test/debugStatusLine.test.js` for the "repeated calls never touch KV traffic state" tests. (One narrow, intentional exception: the TDX OAuth token cache in `TRAFFIC_KV` — key `tdx:oauth-token-v1` — may get written once by a debug call if no isolate has a cached token yet. That's an auth-optimization write, not traffic state, and doesn't defeat the read-only guarantee for anything a human would call "state.")

---

## 6. Cloudflare bindings & secrets (names only — never write actual values into this repo)

Declared in `wrangler.jsonc`:
- `TRAFFIC_KV` — KV namespace binding, id `a763ccea75b0481aa4da99fa43f8341a`. Single namespace for all state.
- `PBS_RELAY_WINDOWS` — Workers VPC Service binding (service id `01a008ab-4cc4-7c22-a747-4e27cdcc83c8`), reaches the Windows PBS Relay through a Cloudflare Tunnel. Called as `env.PBS_RELAY_WINDOWS.fetch(...)`, never a plain global `fetch()` to a public PBS URL (that path is known-broken from Cloudflare's network — see §3).
- Cron trigger: `*/5 * * * *` (every 5 minutes, UTC — Cloudflare Cron is always UTC).

Configured as Cloudflare Secrets (outside this repo, set via dashboard/`wrangler secret`):
- `TDX_CLIENT_ID`, `TDX_CLIENT_SECRET` — TDX OAuth client credentials.
- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` — LINE Messaging API.
- `PBS_RELAY_TOKEN` — path-token auth for the Windows PBS Relay (appended to the request path, see `src/pbs/client.js`).
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — V1.6.3, HTTP Basic Auth credentials gating every admin/debug GET endpoint (`/health`, `/debug/status`, `/debug/tdx`, `/debug/pbs`, `/debug/pbs-vpc-probe`) — see `src/security/adminAuth.js`. If either is missing, those endpoints fail closed with 503 (never become public).

If any of these are missing, the affected subsystem fails closed (see §5) — the Worker itself never crashes.

---

## 7. KV keys (all under the single `TRAFFIC_KV` namespace)

| Key | Owner | Purpose |
|---|---|---|
| `traffic:baseline` | `src/traffic/dedupe.js` | first-run baseline marker so day-one TDX data doesn't flood-broadcast as "all new" |
| `traffic:dedupe-state` | `src/traffic/dedupe.js` | TDX per-event new/updated/duplicate/absence tracking |
| `line:subscriptions` | `src/traffic/subscriptions.js` | enabled users/groups + `enabledAt` (for the backfill guard) |
| `line:notified-state` | `src/traffic/notified.js` | per-(event, target) "already pushed this fingerprint" state |
| `pbs:lifecycle-state` | `src/pbs/lifecycle.js` | PBS-specific active/cleared/stale tracking, deliberately separate from TDX's dedupe-state |
| `tdx:oauth-token-v1` | `src/tdx/auth.js` | shared TDX OAuth access token cache (memory → this KV key → real OAuth), cuts token-request volume across isolates |

Never assume a key not in this table exists — `grep -rn "_KEY = " src/` to double check if you suspect drift.

---

## 8. Debug endpoints (all read-only, all safe to hit repeatedly)

**V1.6.3: every endpoint below, plus `GET /health`, now requires HTTP Basic Auth** (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, see §6) — see `src/security/adminAuth.js`. Auth is checked before any handler runs, so an unauthenticated request never reaches TDX/PBS/KV. `POST /webhook` and the Cron `scheduled()` handler are unaffected (never gated by admin auth).

- `GET /debug/status` — the full pipeline preview: TDX fetch/normalize/dedupe stats, `sourceHealth`, the LINE broadcast-readiness fields (`broadcastRelevantCount`, `typeIneligibleCount`, `ineligibleByReason`, `pendingTargetCount`, `lineReady`, ...), PBS stats (`pbsOk`, `pbsActiveCount`/`pbsClearedCount`/`pbsStaleCount`, `crossSourceDuplicateCount`, `canonicalEventCount`), `tdxTokenCache` (which tier served the token — never the token itself). **This is the primary tool for diagnosing "why didn't/did this event broadcast."**
- `GET /debug/tdx` — raw per-source TDX fetch results (freeway/highway/cms/bus-hsinchu/bus-hsinchu-county), independent of PBS/broadcast logic.
- `GET /debug/pbs` — PBS-focused: `pbsTransport: "vpc-relay"`, `relayConfigured`/`relayOk`/`relayStatus`/`relayCache`/`relayUpstreamDurationMs`, lifecycle counts, cross-source samples.
- `GET /debug/pbs-vpc-probe` — the lowest-level check: hits the Relay's `/health` and `/pbs` directly through the VPC binding and returns redacted status/body previews. Use this first if PBS itself looks broken (before assuming it's a code bug in this repo).

None of these ever include: TDX client id/secret, LINE token/secret, PBS relay token, full LINE user/group IDs (targets are counts only), or the TDX OAuth access token.

---

## 9. The "v1-bootstrap" trap

`GET /` returns a hardcoded literal:
```js
{ service: 'traffic-reporter', status: 'ok', version: 'v1-bootstrap' }
```
This string has **never been updated since the original bootstrap commit** and does **not** reflect the actual deployed code version. Do not use it to diagnose "is the new code live" — check `GET /debug/status`'s behavior (e.g. presence of `typeIneligibleCount`/`ineligibleByReason`) or the deployed commit hash via Cloudflare's own dashboard instead. If you're asked to fix this, it's a one-line change in `src/index.js`, but no round so far has considered it worth the churn — ask before changing it, it might be intentionally left alone.

---

## 10. Known issues / unverified things (as of `4efb9e5`)

1. **VD (Vehicle Detector) schema is unverified against a live TDX response.** `src/tdx/vdSpeed.js` fetches `v2/Road/Traffic/VD/Freeway` (static metadata) and `v2/Road/Traffic/Live/VD/Freeway` (live speed) and joins them. Every session that built this feature had its network egress blocked from `tdx.transportdata.tw`, so field names are best-effort against TDX's established naming conventions, deliberately read via multiple candidate names so a mismatch degrades to "no usable reading" rather than crashing (see `vdSpeed.js`'s own module comment for the full reasoning). **This currently has near-zero user-visible impact**: since V1.5, congestion is never broadcast regardless of VD outcome, so a wrong VD schema silently means "congestion severity in `/debug/status` never shows 'severe'" — nothing breaks, nothing over- or under-broadcasts. Only worth fixing if congestion broadcasting is ever re-enabled for a future round.
2. **The `construction`/`other` keyword lists (§4) are a first pass**, not derived from real 新竹 incident text. Expect false negatives (a real impassable-road report using different wording) more than false positives. Tune the pattern lists in `broadcastRules.js` directly as real cases surface — that's expected, ongoing maintenance, not a bug to "fix" architecturally.
3. **Only one subscriber exists** (the Alpha tester). Multi-subscriber behavior (the `enabledAt` backfill guard, per-target notified-state, partial-push-failure retry) is unit/integration tested but not exercised by real multi-user traffic yet.
4. **Congestion clustering (`congestionCluster.js`) and the congestion-specific cooldown (`notified.js`'s `targetNeedsCongestionNotification`) are effectively dead code in the live broadcast path** since V1.5 — congestion is filtered out before either ever runs. Both are kept (not deleted) and still unit-tested, in case a future round re-admits some congestion tier to broadcast. Don't be surprised that they exist but never fire; don't delete them without asking.
5. **`pbs-relay/tests/`** (a separate, not-wired-in sub-project for an alternate Render-hosted relay, superseded by the Windows Relay + VPC approach) has 2 failing tests due to a missing `pbs-relay/src/cache.js` file. This predates all V1.2C+ work in this document and is unrelated to the live Worker — `git stash` was used to confirm it fails identically on a clean `origin/main` checkout, multiple rounds ago. Not a regression, not urgent, not in scope unless someone asks about `pbs-relay/` specifically.

---

## 11. Rollback

Every round in this project's history landed as its own commit (see `git log --oneline` for the full sequence — no rebasing/squashing has been used). To roll back to a known-good prior state:

```bash
git log --oneline   # find the target commit
git checkout -B rollback-<reason> <target-commit>
git push -u origin rollback-<reason>
# then fast-forward main to it the same way every deploy in this project's
# history has been done: git switch main && git merge --ff-only <target-commit> && git push origin main
```

Cloudflare auto-deploys on every push to `main` (confirmed working throughout V1.4/V1.4.1/V1.5's rollout — no manual `wrangler deploy` step needed from a normal dev sandbox, which typically has no Cloudflare credentials anyway).

Key rollback points if a specific round's change is suspect:
- Revert to `340374b` to undo V1.5's broadcast-eligibility whitelist (back to "only congestion excluded, everything else broadcasts").
- Revert to `2345461` to undo V1.4.1's severity/VD/road-anchor work entirely.
- Revert to `6b50cb9` to undo PBS ever reaching LINE at all (`PBS_BROADCAST_ENABLED` back to `false`, PBS fully observation-only).

---

## 12. Testing

`npm test` runs the whole repo's Node test-runner suite (`node --test`), including the separate `pbs-relay/` sub-project (see §10 item 5 for its 2 known-unrelated failures). Before trusting a change, prefer running the specific test files you touched, then one full `npm test` pass at the end — that's the pattern every round in this project's history has followed, and it keeps iteration cheap. Test files mirror `src/` module names closely (e.g. `src/traffic/broadcastRules.js` ↔ `test/broadcastRules.test.js`); integration-style tests that exercise the real Cron path go through `runScheduledTdxSync` directly (see `test/broadcastEligibility.test.js`, `test/pbsLineBroadcast.test.js` for the established mocking style — fake `fetch` per endpoint, fake KV via a `Map`-backed object).

---

## 13. What NOT to do without asking

- Don't merge to `main` or run `wrangler deploy` unless explicitly asked — Cloudflare auto-deploys on `main` push, so a merge **is** a production deploy.
- Don't touch Cloudflare secrets, the Workers VPC Service, the Cloudflare Tunnel, or the Windows PBS Relay's own code/config without being explicitly asked — this integration took multiple rounds to stabilize (§3) and is currently working.
- Don't re-investigate the VPC/Tunnel/PBS-relay-auth history (400s, 401s, token format) — it's solved. Only revisit if production actually shows a new failure there.
- Don't flip `PBS_BROADCAST_ENABLED` or expand who's subscribed without explicit instruction — both are deliberate, narrow Alpha-stage choices.
- Don't delete `congestionCluster.js`/`notified.js`'s congestion-cooldown code just because it's currently unreachable (§10 item 4).
