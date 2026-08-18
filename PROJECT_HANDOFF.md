# PROJECT_HANDOFF.md — traffic-reporter (路況播報員)

**Read this file before touching the repo.** It exists so a new AI/agent session can operate correctly without re-scanning the whole codebase or re-investigating history that is already solved. If something below conflicts with what you find in the code, trust the code and treat this file as stale — but update it once you understand why.

```
STATUS: V1.8.5 Production live
MAIN:   97756a8805b52acb8746aa7d14bbf89be51ee267
DATE:   2026-08-18
PHASE:  Production operation. No speculative feature work; only real-world bug fixes.
```

See `RELEASE_SUMMARY_V1.8.5.md` for the human-readable version of what shipped in this round.

---

## 1. What this project is

A Cloudflare Worker that fetches road-condition data from two independent official sources (TDX, PBS), normalizes/dedupes/merges them, and pushes LINE messages to enabled subscribers for events that might force a professional driver (taxi/for-hire) to change route *right now*. Ordinary traffic congestion is deliberately excluded — the target audience already has Google Maps / 1968 for that. Since V1.8.5, a qualifying 國道一號 accident's LINE message also carries a 4-camera CCTV collage image, sent in the same push as the text — see §17.

Repo: `mrhappytan-max/traffic-reporter`. Single Worker, no D1, no queues — everything lives in one Cloudflare KV namespace (plus one R2 bucket for published CCTV images, since V1.8.4).

Cron runs **every 10 minutes, 24/7** (`*/10 * * * *`, UTC). PBS runs every single tick. TDX only runs on every 2nd tick (minute 00/20/40) and only during the 08:00–22:00 Asia/Taipei broadcast window — see §2a for the full current cadence. This is a correction of an earlier "every 5 minutes" claim that no longer matches the deployed Cron trigger.

---

## 2. Architecture at a glance

```
                    ┌─────────────────────────────────────────────┐
                    │         Cloudflare Worker (this repo)         │
                    │                                               │
TDX API ──HTTPS──▶  │  fetchAllSources()  ──▶  normalize/classify   │
(Production only    │                              │                 │
 fetches 2 of the   │                              ▼                 │
 5 defined sources:  │                     Hsinchu geo-filter         │
 freeway + highway;  │                              │                 │
 cms/2×bus-alert are │                              ▼                 │
 defined in code but │              KV dedupe (traffic:dedupe-state,  │
 never fetched in    │              traffic:baseline)                 │
 the live Cron path) │                              │                 │
                    │                              ▼                 │
Windows PBS Relay   │                              ▼                 │
(off-Cloudflare) ──▶│ crossSourceDedup.mergeForBroadcast()           │
  via Cloudflare     │  (PBS active events + TDX events -> canonical) │
  Tunnel + Workers   │                              │                 │
  VPC Service ───────┤                              ▼                 │
                    │       broadcastRules.getBroadcastEligibility() │
                    │              (the V1.5 whitelist gate)         │
                    │                              │                 │
                    │                              ▼                 │
                    │        congestionCluster (dead code path —     │
                    │        congestion never reaches here anymore)  │
                    │                              │                 │
                    │                              ▼                 │
                    │      broadcastPipeline: subscriptions +        │
                    │      per-target notified-state +                │
                    │      CCTV enrichment (accident/freeway only,   │
                    │      cache-only, V1.8.5 — see §17) + LINE push │
                    └──────────────────┬────────────────────────────┘
                                        │
                                        ▼
                                  LINE Messaging API
```

**V1.6.1 correction, still true today:** `congestionValidation`/VD (Vehicle Detector) speed-check is **not** part of the live Cron path above. V1.5 already excludes every congestion event from broadcast regardless of severity, so an extra TDX VD API call to validate congestion severity was removed from `scheduled.js` entirely — "VD 不再具有正式播報用途，不得再因 congestion 額外呼叫任何 VD API." `congestionValidation.js`/`vdSpeed.js` still exist, are still unit-tested, and `GET /debug/status` still runs its own read-only preview of this same check — but neither is part of what actually runs on a real Cron tick. Don't re-add it to the diagram above without checking `scheduled.js` first.

Two entry points share almost all of this logic:
- **`scheduled.js`** (`runScheduledTdxSync`) — the real Cron path. Writes KV, pushes LINE.
- **`debugStatus.js`** (`handleDebugStatus`, `GET /debug/status`) — the read-only preview. Runs the exact same pipeline in `dryRun` mode (restricted to the same `PRODUCTION_TDX_SOURCE_IDS`, mirroring production's fetch scope): computes everything, writes nothing, never calls LINE, never touches CCTV/R2.

---

## 2a. Production core — current facts (as of V1.8.5, `97756a8`)

This section exists so an agent never has to re-derive these numbers from the code — they were re-verified against `wrangler.jsonc`/`scheduled.js`/`sources.js`/`broadcastHours.js` as part of sealing V1.8.5.

**TDX**
- Production fetches only `freeway` + `highway` (`PRODUCTION_TDX_SOURCE_IDS` in `src/tdx/sources.js`) — the other 3 defined sources (`cms`, `bus-hsinchu`, `bus-hsinchu-county`) exist in `SOURCES` but are never fetched by `scheduled.js` or `debugStatus.js`.
- Only fetched on every 2nd Cron tick (minute 00/20/40 — `src/traffic/tdxSchedule.js`'s `getTdxScheduleState`), and only within the 08:00–22:00 Asia/Taipei broadcast window (`src/traffic/broadcastHours.js`'s `isWithinBroadcastHours`).
- Net: ~84 TDX RoadEvent calls/day (14 broadcast hours × 3 fetches/hour × 2 sources).

**PBS**
- Runs on **every** Cron tick, 24/7, unconditionally — via the Windows Relay (§6), not gated by broadcast hours or the TDX schedule.

**LINE**
- Broadcast window: 08:00–22:00 Asia/Taipei (Cron itself still runs 24/7; LINE just doesn't push outside this window).
- V1.5 eligibility rule (§4) plus V1.5.1 incident suppression (`line:incident-suppression-state` — see §7) both still fully in force, unchanged by V1.8.x CCTV work.

**CCTV (full version lineage, all still true today)**
- V1.7: four-quadrant camera-selection rule (§14) — S前/S後/N前/N後, ±2km→±4km→null, max 4 cameras, zero extra TDX calls beyond the one metadata lookup.
- V1.8: 2×2 JPEG collage compositing (§15), Admin-Auth-gated preview only, not yet wired to real LINE push.
- V1.8.1/V1.8.2: 服務區/休息站/服務站 camera exclusion, narrowed to siting-only evidence fields after a false-positive review (§15).
- V1.8.3: collage display text fully localized to Traditional Chinese, real-font (`@fontsource/noto-sans-tc`) rasterized to a pre-baked grayscale alpha-mask bitmap at build time — never a runtime font parser, never hand-drawn CJK glyphs (superseded after Production visual review).
- V1.8.4: R2-backed public image publishing (`CCTV_IMAGES` bucket), 15-minute **code-enforced** expiry checked on every read from each object's own `customMetadata.expiresAt` — never relies on HTTP caching or R2's own lifecycle rule alone (that's a 1-day backstop only).
- V1.8.5: wired into the **real** LINE broadcast — dynamic per-accident road/KM resolution (§17). Scope: **國道一號 only** (`CCTV_SUPPORTED_ROADS`), **accident type only**, **structured TDX startKM/endKM only** (never guessed from free text). Broadcast path reads CCTV camera-inventory metadata **cache-only** (`cctv:freeway-metadata:v1`, 7-day TTL) and makes **zero** additional TDX calls of its own — the cache is seeded as a side effect of the Admin Hsinchu probe's existing one-time TDX call. Whole-run CCTV enrichment budget is **4 seconds total per Cron tick** (`cctvRunDeadlineAt`, shared across every eligible accident in that tick — not 4 seconds each). LINE text+image are sent in exactly **one** push API call (`pushLineMessages`). Any CCTV failure/timeout/cache-miss at any stage fails closed to text-only and never affects whether the accident itself is broadcast.

---

## 3. Data flow, in commit order (why things are shaped the way they are)

1. **V1.1–V1.2A**: TDX fetch/normalize/Hsinchu-filter/KV-dedupe/baseline. `src/tdx/*`, `src/traffic/pipeline.js`, `src/traffic/dedupe.js`.
2. **V1.2B–V1.2C**: LINE broadcast pipeline (`broadcastPipeline.js`), per-target notified-state (`notified.js`), driver-readable road section labels (`roadSectionLabel.js`), congestion clustering to stop repeat-tick spam (`congestionCluster.js`).
3. **V1.2C.1**: TDX OAuth token caching (memory → KV → real OAuth) to stop 429s from isolate churn. `src/tdx/auth.js`.
4. **V1.3 → VPC rollout**: PBS as a second, initially observation-only source. Direct `fetch()` to `rtr.pbs.gov.tw` from Cloudflare **does not work** (TCP connect timeout from Cloudflare's network — confirmed, not a code bug). Solved by standing up a relay on a Windows machine, reachable via **Cloudflare Tunnel + Workers VPC Service** (binding `PBS_RELAY_WINDOWS`, path-token auth). **Do not re-investigate this history (400/401/token issues, tunnel/VPC setup) unless production actually breaks again** — it's solved and stable as of V1.4/V1.4.1.
5. **V1.4 Alpha**: PBS merged into the real broadcast (`crossSourceDedup.mergeForBroadcast`), `PBS_BROADCAST_ENABLED` flipped to `true`.
6. **V1.4.1**: congestion severity tiers (moderate/congested/severe — `congestionSeverity.js`), corrected 國1 頭份/新竹系統 mileage anchors (`roadSectionLabel.js`), VD (Vehicle Detector) real-time speed as a second opinion before ever calling something "severe" (`vdSpeed.js`, `congestionValidation.js`).
7. **V1.5**: product repositioning — pure congestion is **never** broadcast-eligible regardless of severity; `construction`/`other` became keyword-conditional; `alert` defaults off. `broadcastRules.js`'s `getBroadcastEligibility()`.
8. **V1.5.1 → V1.6.x → V1.7 → V1.8 → V1.8.5**: incident-fingerprint suppression across re-ticks (`incidentSuppression.js`); Cron/TDX cadence tightened and VD removed from the live path (§2, §2a); then a full CCTV-collage feature line (four-quadrant camera selection → 2×2 image compositing → Traditional-Chinese labels → R2-backed public publishing → dynamic per-accident wiring into the real LINE broadcast). See §2a for the current-state summary and §14/§15/§16/§17 for the full per-round detail — this numbered list intentionally stops summarizing at V1.5; treat §2a as the up-to-date continuation, not this list.

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
- `CCTV_IMAGES` — R2 bucket binding (bucket name `traffic-reporter-cctv-images`), added V1.8.4 for the published-collage-image layer (`src/cctv/publishedImage.js`). R2 chosen over KV specifically for strongly-consistent read-after-write (KV is only eventually consistent, unacceptable for incident-time delivery). Confirmed created in Production; R2's own lifecycle rule auto-deletes objects after 1 day as a backstop only — the real 15-minute expiry is enforced in code on every read, never by R2 lifecycle or HTTP caching alone.
- `PUBLIC_BASE_URL` — a plain `vars` entry (**not** a secret), added V1.8.5. This Worker's own public HTTPS origin, used only because the Cron-triggered dynamic CCTV path (`cctv/dynamicCollage.js`) has no incoming `Request` to derive an origin from the way the Admin HTTP endpoints do. Falls back safely to this same value if the var is ever absent/misconfigured.
- Cron trigger: `*/10 * * * *` (every 10 minutes, UTC — Cloudflare Cron is always UTC). See §2a for the full production cadence (PBS every tick, TDX gated to every 2nd tick within broadcast hours).

Configured as Cloudflare Secrets (outside this repo, set via dashboard/`wrangler secret`):
- `TDX_CLIENT_ID`, `TDX_CLIENT_SECRET` — TDX OAuth client credentials.
- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` — LINE Messaging API.
- `PBS_RELAY_TOKEN` — path-token auth for the Windows PBS Relay (appended to the request path, see `src/pbs/client.js`).
- `ADMIN_PASSWORD` — V1.6.3, HTTP Basic Auth password gating every admin/debug GET endpoint (`/health`, `/debug/status`, `/debug/tdx`, `/debug/pbs`, `/debug/pbs-vpc-probe`) — see `src/security/adminAuth.js`. The username is a fixed constant (`admin`) in code, not a Secret. If `ADMIN_PASSWORD` is missing, those endpoints fail closed with 503 (never become public). No first-run setup page, no Cookie session, no password ever stored in KV.

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
| `line:incident-suppression-state` | `src/traffic/incidentSuppression.js` | V1.5.1 — tracks the same real-world incident across ticks (road/direction group + KM within `INCIDENT_MAX_KM_DIFF`) so an unchanged re-tick doesn't re-notify |
| `cctv:freeway-metadata:v1` | `src/cctv/freewayCctvMetadataCache.js` | V1.8.5 — shared, broadcast-facing CCTV camera-inventory cache (RoadID/RoadDirection/LocationMile/VideoStreamURL), 7-day TTL. Written only as a side effect of the Admin Hsinchu probe's own TDX call; read cache-only by the real broadcast path — **never** written or triggered by `scheduled.js`/`broadcastPipeline.js` itself |
| `admin:cctv-probe-used:v1` | `src/tdx/hsinchuCctvProbe.js` | V1.7 — one-time PRE-ARM guard for the general/fixed-target admin CCTV probe's own TDX call |
| `admin:cctv-hsinchu-probe-used:v1` | `src/tdx/hsinchuCctvProbe.js` | V1.7/V1.8.5 — PRE-ARM guard specific to the Hsinchu admin probe; currently `completed`. Don't reset/rerun during normal Production operation — see §13 |
| `admin:cctv-hsinchu-candidates:v1` | `src/tdx/hsinchuCctvProbe.js` | V1.7 — the fixed-target (82.1K) admin probe's persisted 4-quadrant candidate list, 1-hour TTL. Used only by the manual `/admin/cctv-hsinchu-*` preview endpoints, unrelated to the real broadcast path's own cache above |
| `tdx:usage:entry:v1:<date>:<epochMs>:<opaqueId>` | `src/tdx/usageLedger.js` | V1.8.6 (branch, not yet merged) — append-only, one entry per invocation that made ≥1 real TDX call (Cron tick / `/debug/status` / `/debug/tdx` / an admin CCTV probe). 40-day TTL. See §18 |
| `tdx:usage:summary:v1` | `src/tdx/usageLedger.js` | V1.8.6 (branch, not yet merged) — compacted daily rollup (last ~35 days), the ONLY usage-ledger key `/health` ever reads. Recompacted by the Cron path after each real run — never by `/health` itself. See §18 |

Never assume a key not in this table exists — `grep -rn "_KEY = " src/` to double check if you suspect drift.

---

## 8. Debug endpoints (all read-only, all safe to hit repeatedly)

**V1.6.3: every endpoint below, plus `GET /health`, now requires HTTP Basic Auth** (username `admin`, password from the `ADMIN_PASSWORD` Secret — see §6, `src/security/adminAuth.js`). Auth is checked before any handler runs, so an unauthenticated request never reaches TDX/PBS/KV. `POST /webhook` and the Cron `scheduled()` handler are unaffected (never gated by admin auth).

- `GET /debug/status` — the full pipeline preview: TDX fetch/normalize/dedupe stats, `sourceHealth`, the LINE broadcast-readiness fields (`broadcastRelevantCount`, `typeIneligibleCount`, `ineligibleByReason`, `pendingTargetCount`, `lineReady`, ...), PBS stats (`pbsOk`, `pbsActiveCount`/`pbsClearedCount`/`pbsStaleCount`, `crossSourceDuplicateCount`, `canonicalEventCount`), `tdxTokenCache` (which tier served the token — never the token itself). **This is the primary tool for diagnosing "why didn't/did this event broadcast."**
- `GET /debug/tdx` — raw per-source TDX fetch results (freeway/highway/cms/bus-hsinchu/bus-hsinchu-county), independent of PBS/broadcast logic.
- `GET /debug/pbs` — PBS-focused: `pbsTransport: "vpc-relay"`, `relayConfigured`/`relayOk`/`relayStatus`/`relayCache`/`relayUpstreamDurationMs`, lifecycle counts, cross-source samples.
- `GET /debug/pbs-vpc-probe` — the lowest-level check: hits the Relay's `/health` and `/pbs` directly through the VPC binding and returns redacted status/body previews. Use this first if PBS itself looks broken (before assuming it's a code bug in this repo).

None of these ever include: TDX client id/secret, LINE token/secret, PBS relay token, full LINE user/group IDs (targets are counts only), or the TDX OAuth access token.

**CCTV admin surface (V1.7/V1.8.x), all also Admin-Basic-Auth-gated, same as above:**
- `GET /admin/cctv-probe` — V1.7 general one-time probe (guarded by `admin:cctv-probe-used:v1`).
- `GET /admin/cctv-hsinchu-probe` — the Hsinchu-specific one-time probe; its TDX response is also what seeds the broadcast-facing `cctv:freeway-metadata:v1` cache (§7) as a side effect. Guarded by `admin:cctv-hsinchu-probe-used:v1`. **Don't rerun during normal Production operation** — see §13.
- `GET /admin/cctv-hsinchu-frame/0..3` — fetches one quadrant's live frame directly from `*.freeway.gov.tw`, no TDX call.
- `GET /admin/cctv-hsinchu-collage` — composes the 2×2 preview JPEG from the cached candidate list, no TDX call.
- `GET /admin/cctv-hsinchu-publish-test` — manual R2 publish-and-read-back test for the fixed 82.1K target.

**One deliberately unauthenticated public route:** `GET /cctv/image/:id` (`src/cctv/publishedImage.js`) — serves a published collage image to LINE's own servers, which fetch it with no credential. Security here is via a 128-bit opaque id (unguessable) plus the code-enforced 15-minute `expiresAt` check on every read, not HTTP Basic Auth — this route is intentionally excluded from the Admin-Auth gate that covers every other endpoint in this section.

---

## 9. The "v1-bootstrap" trap

`GET /` returns a hardcoded literal:
```js
{ service: 'traffic-reporter', status: 'ok', version: 'v1-bootstrap' }
```
This string has **never been updated since the original bootstrap commit** and does **not** reflect the actual deployed code version. Do not use it to diagnose "is the new code live" — check `GET /debug/status`'s behavior (e.g. presence of `typeIneligibleCount`/`ineligibleByReason`) or the deployed commit hash via Cloudflare's own dashboard instead. If you're asked to fix this, it's a one-line change in `src/index.js`, but no round so far has considered it worth the churn — ask before changing it, it might be intentionally left alone.

---

## 10. Known issues / unverified things (as of `97756a8`, V1.8.5)

Current full-suite test baseline: **636/638 passing.** The 2 failures are the pre-existing, unrelated `pbs-relay/tests/*` failures in item 5 below — don't fix them as a drive-by while working on something else; ask first if they ever seem in scope.

1. **VD (Vehicle Detector) schema is unverified against a live TDX response.** `src/tdx/vdSpeed.js` fetches `v2/Road/Traffic/VD/Freeway` (static metadata) and `v2/Road/Traffic/Live/VD/Freeway` (live speed) and joins them. Every session that built this feature had its network egress blocked from `tdx.transportdata.tw`, so field names are best-effort against TDX's established naming conventions, deliberately read via multiple candidate names so a mismatch degrades to "no usable reading" rather than crashing (see `vdSpeed.js`'s own module comment for the full reasoning). **This currently has near-zero user-visible impact**: since V1.5, congestion is never broadcast regardless of VD outcome, so a wrong VD schema silently means "congestion severity in `/debug/status` never shows 'severe'" — nothing breaks, nothing over- or under-broadcasts. Only worth fixing if congestion broadcasting is ever re-enabled for a future round.
2. **The `construction`/`other` keyword lists (§4) are a first pass**, not derived from real 新竹 incident text. Expect false negatives (a real impassable-road report using different wording) more than false positives. Tune the pattern lists in `broadcastRules.js` directly as real cases surface — that's expected, ongoing maintenance, not a bug to "fix" architecturally.
3. **Only one subscriber exists** (the Alpha tester). Multi-subscriber behavior (the `enabledAt` backfill guard, per-target notified-state, partial-push-failure retry) is unit/integration tested but not exercised by real multi-user traffic yet.
4. **Congestion clustering (`congestionCluster.js`) and the congestion-specific cooldown (`notified.js`'s `targetNeedsCongestionNotification`) are effectively dead code in the live broadcast path** since V1.5 — congestion is filtered out before either ever runs. Both are kept (not deleted) and still unit-tested, in case a future round re-admits some congestion tier to broadcast. Don't be surprised that they exist but never fire; don't delete them without asking.
5. **`pbs-relay/tests/`** (a separate, not-wired-in sub-project for an alternate Render-hosted relay, superseded by the Windows Relay + VPC approach) has 2 failing tests due to a missing `pbs-relay/src/cache.js` file. This predates all V1.2C+ work in this document and is unrelated to the live Worker — `git stash` was used to confirm it fails identically on a clean `origin/main` checkout, multiple rounds ago. Not a regression, not urgent, not in scope unless someone asks about `pbs-relay/` specifically.
6. **CCTV auto-image support is 國道一號 only (V1.8.5).** Other roads TDX/`roadSectionLabel.js` already know for section labels (e.g. 國道三號) still have no confirmed CCTV `RoadID`, since TDX egress has never been reachable from any dev sandbox this project was built in — every CCTV RoadID/pattern in `CCTV_SUPPORTED_ROADS` was confirmed only from a real Production response. Not a bug — just scope, see §13 before expanding it.
7. **`cctv:freeway-metadata:v1` has a 7-day TTL and does not refresh itself.** Once it expires, the broadcast path's CCTV enrichment fails closed to `metadata-cache-unavailable` (text-only) until a human manually reruns the Admin Hsinchu probe. This is a known, accepted operational rhythm, not a bug — see §13.

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
- Don't rerun/reset the Admin Hsinchu CCTV probe (`admin:cctv-hsinchu-probe-used:v1`) during normal Production operation — it's a one-time-use guard, and rerunning it makes a real, separately-budgeted TDX call. Only reset+rerun it if `cctv:freeway-metadata:v1` has actually expired (7-day TTL, §7/§10 item 7) and the broadcast-facing CCTV cache genuinely needs a refresh — not to test something, not "just to check it still works."
- Don't add another road (e.g. 國3) to `CCTV_SUPPORTED_ROADS` without first confirming its real CCTV `RoadID`/`RoadName` pattern from an actual Production TDX CCTV response (§10 item 6) — never from "the numbering probably matches 國1's."

---

## 14. V1.7 CCTV 四象限選鏡規則 (4-camera cross-direction search)

**Status: ratified rule, official baseline for any future CCTV-selection implementation.** Supersedes the earlier "nearest 5 CCTV by KM distance" approach used in the V1.7 exploratory probes (`src/tdx/hsinchuCctvProbe.js`'s original `selectNearestCandidates`) — that approach is retired; do not reintroduce a plain nearest-N selector without being explicitly told to.

**Why nearest-5 was wrong:** a plain KM-distance sort can return 5 cameras all facing the same direction, or all on one side of the incident, and can easily miss the camera that actually has eyes on the scene. National freeway PTZ CCTV units are steerable and are frequently panned by the 交控中心 to point at an incident regardless of which carriageway they're physically mounted on — a southbound (S) incident may in practice be best seen by a northbound (N) camera that's been turned to face across the median. Any selection rule that only looks at one direction, or only at "closest," can silently pick 5 cameras that never show the incident at all.

**The rule**, given a fixed incident point `targetKm`:

Search **exactly 4 fixed quadrants**, never more, in a single first pass:

1. **S, km < targetKm** — nearest southbound camera *before* the incident (approaching from the low-KM side).
2. **S, km > targetKm** — nearest southbound camera *after* the incident.
3. **N, km < targetKm** — nearest northbound camera *before* the incident.
4. **N, km > targetKm** — nearest northbound camera *after* the incident.

Distance strategy per quadrant, applied independently:
- Prefer a candidate within **±2 km** of `targetKm`.
- If that quadrant has no candidate within ±2 km, widen to **±4 km** for that quadrant only.
- If still nothing within ±4 km, **leave that quadrant empty** — never reach further just to fill the slot. A missing camera is honest; a camera 15km away mislabeled as "nearby" is not.

Result: **at most 4 cameras**, one per quadrant, each quadrant independently empty-or-filled. Never fetch a 5th camera in this first pass. (A later round may add a second pass / fallback tier for empty quadrants — not part of this baseline; ask before adding one.)

**Confirmed feasibility (V1.7 probe rounds, live-tested):** a CCTV's `VideoStreamURL` from TDX metadata is a direct `*.freeway.gov.tw` MJPEG stream; fetching a frame from it requires **no TDX Authorization header at all** and is a completely separate request from the TDX CCTV metadata API. So all 4 quadrant images together cost **zero additional TDX API calls** beyond the one metadata lookup that found their `VideoStreamURL`s in the first place — see `src/tdx/hsinchuCctvProbe.js`'s `extractFirstJpegFrame`/frame-endpoint design (hostname-allowlisted to `*.freeway.gov.tw`, https-only, 2MB/~5s caps, single-JPEG-then-stop) for the mechanics, which this rule reuses unchanged — only the *selection* logic changes from nearest-5 to four-quadrant.

**Out of scope for this rule / do not bundle in:** AI incident recognition, LINE delivery of CCTV images, any change to the Cron schedule, any change to the real broadcast pipeline. This is a manual, Admin-Auth-gated diagnostic selection rule only, same one-time-use PRE-ARM TDX-quota guard as the rest of the V1.7 probe work (§ see `tdx/hsinchuCctvProbe.js`'s own module comment) — not wired into `scheduled.js`/`broadcastPipeline.js` in any way as of this writing.

---

## 15. V1.8 CCTV 四宮格事故播報 (2x2 collage compositing)

**Status: first stage complete — collage-generation engine + Admin-Auth-gated preview. Not yet wired into the real LINE broadcast.**

**Goal:** stop sending the 4 quadrant CCTV images (§14) as 4 separate LINE messages. Instead, composite S前/S後/N前/N後 into a **single 2x2 JPEG** server-side, so a future incident broadcast can send exactly **1 text message + 1 image** — never 4 images "洗版" (flooding the chat).

**Endpoint:** `GET /admin/cctv-hsinchu-collage` (Admin Auth-gated, same as every other `/admin/*` page — see `security/adminAuth.js`). Strictly **read-only** against `admin:cctv-hsinchu-candidates:v1` — reads whatever the four-quadrant probe (§14) already cached, fetches each candidate's frame directly from `*.freeway.gov.tw` (reusing the same `extractFirstJpegFrame` mechanics: https-only, hostname-allowlisted, no Authorization header, 2MB/~5s caps, single-JPEG-then-stop), and composites them. **Never** calls `getAccessToken`/`fetchTdxJson`/any TDX endpoint, **never** triggers `/admin/cctv-hsinchu-probe`, **never** rebuilds the candidate list — if the candidates KV is missing/expired, it responds with a clear `CCTV candidate cache unavailable` message rather than silently calling TDX to repopulate it. **0 TDX API calls**, same guarantee as the frame endpoint, enforced the same way (the handler's own code path never calls those functions).

**Layout — fixed, matches §14 exactly, never reordered:**

```
┌────────────┬────────────┐
│   S前      │   S後      │   index 0        index 1
├────────────┼────────────┤
│   N前      │   N後      │   index 2        index 3
└────────────┴────────────┘
```

1200×900 JPEG. Each cell: the photo (or a placeholder), plus a label bar showing the quadrant name, LocationMile, and distance from the incident. A cell with **no candidate at all** (§14's "leave it empty") shows an explicit **"NO CAMERA"** placeholder; a cell whose candidate existed but whose frame fetch failed (timeout, too-large, etc.) shows a visually distinct **"NO SIGNAL"** placeholder — never silently omitted, never a fake/blank tile passed off as real footage. **1–4 successful frames is enough to produce a valid collage**; only when all 4 quadrants have neither a candidate nor a successfully fetched frame does the endpoint decline to produce an image at all (502 with a clear message) — never a collage built entirely from placeholders.

**Concurrency:** all (up to 4) candidate frames are fetched in parallel via `Promise.all` — never sequential (which could push total latency toward ~20s) — and never more than 4, since there is exactly one fetch attempt per quadrant slot by construction.

**In-image labels are ASCII-only** (e.g. "S BEFORE", "82K+020", "0.10KM", "NO SIGNAL", "NO CAMERA") — a deliberate, documented scope decision, not an oversight:
- A real Traditional-Chinese glyph set legible at label-bar scale needs either a genuine font-rasterization pipeline (a WASM SVG renderer + a subsetted CJK font — realistically another 1–3MB in the bundle, plus more CPU per request) or a hand-authored CJK bitmap font. Unlike the Latin/digit set actually shipped, CJK glyphs are dense enough that hand-authoring them correctly — with no way to proof each character at a glance — is a real correctness risk, not just a style shortcut.
- The ASCII font (`src/cctv/bitmapFont.js`) actually shipped is self-authored (no dependency), tiny, and was visually verified end-to-end (rendered to a real JPEG, inspected) as part of this change.
- The full Chinese narrative belongs in the LINE **text message** that will accompany this image in a future round — the image label is a compact, unambiguous cross-reference, not the primary description. Adding real CJK glyphs to the image itself is a legitimate, explicitly deferred follow-up — ask before starting it, and budget for the font-subsetting/rasterization pipeline it needs.

**Image compositing approach — how it was chosen (and corrected):**
- **Cloudflare Workers has no Canvas API and no native `sharp`/libvips bindings** — image compositing must be pure JS/WASM.
- **[`@jsquash/jpeg`](https://github.com/jamsinclair/jSquash)** (mozjpeg compiled to WASM, zero npm dependencies of its own) was selected for JPEG decode/encode — it's the same codec family used by Squoosh, has an official Cloudflare Workers example, and was smoke-tested end to end in this repo before being adopted. Only `@jsquash/jpeg` was added — **not** `@jsquash/png` — since every CCTV frame is already a JPEG and the collage output is JPEG too, so a PNG codec is simply never needed.
- **WASM loading — CORRECTED after review.** The first version of this round embedded the WASM binaries as base64 string constants, decoded via `atob()` + `WebAssembly.compile()` at runtime. That does **not** work in Production: Cloudflare Workers' runtime explicitly disallows `WebAssembly.compile()`, `WebAssembly.compileStreaming()`, `WebAssembly.instantiate(bufferSource)`, and `WebAssembly.instantiateStreaming()` — anything that COMPILES WASM inside the isolate at request time. It was a mistake made in a sandbox with no way to live-verify wrangler's `.wasm`-import bundling against a real Cloudflare deploy, caught by review before merge. **Fixed shape:** `src/cctv/jpegCodecWorker.js` does a genuine static `import module from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'` (and the encoder equivalent) — the only WASM-loading mechanism Workers actually supports, where the platform precompiles the module at deploy time and hands the Worker an already-compiled `WebAssembly.Module`. @jsquash/jpeg's own `init(module)` then does `new WebAssembly.Instance(module, imports)` internally (see `node_modules/@jsquash/jpeg/utils.js`'s `initEmscriptenModule`) — instantiating an already-compiled module, never compiling one. `src/cctv/generated/jpegWasmAssets.js` (the base64 asset) has been deleted.
- **Node/Workers split, made necessary by the fix:** plain `node --test` has no ESM loader for `.wasm` files, and even `--experimental-wasm-modules` wouldn't help — Node's WASM-ESM integration auto-instantiates a module and exposes *its own* exports directly, a fundamentally different shape than the raw `WebAssembly.Module` `@jsquash/jpeg`'s `init()` needs to instantiate itself. Since every test file imports `src/index.js` at the top, `jpegCodecWorker.js` (containing the static `.wasm` import) is **never imported at the top level of anything reachable from a test** — `tdx/hsinchuCctvProbe.js`'s `handleHsinchuCctvCollage` loads it lazily via `import()`, and only when at least one candidate actually fetched successfully (nothing to decode → no need to touch the codec at all). Tests that need a real decoded image pass `test/testJpegCodec.js`'s Node-compatible codec (same `decodeJpeg`/`encodeJpeg` shape, loaded via `fs.readFileSync` + `WebAssembly.compile()` — legitimate here since this file never ships to Production, so the Workers restriction doesn't apply to it) as `handleHsinchuCctvCollage`'s second, TEST-ONLY `codecOverride` argument. `src/cctv/collage.js` itself is untouched by any of this — it was already pure dependency injection (`decodeJpeg`/`encodeJpeg` passed in as options) and needed no change.
- Compositing itself (resize/crop, rectangle fills, the bitmap-font text renderer) is 100% hand-written plain JS in `src/cctv/collage.js` / `src/cctv/bitmapFont.js` — no canvas library, no extra dependency.
- **Bundle impact:** the deleted base64 asset (~558KB source, ~168KB gzipped) is gone; the real cost is now just the two `.wasm` binaries themselves as bundled by wrangler (~166KB + ~246KB ≈ 412KB raw) plus ~80KB of `@jsquash/jpeg`'s own plain-JS emscripten glue — smaller than the base64 approach and, unlike it, actually deployable. Comfortably inside Cloudflare Workers' compressed-bundle limits on both Free and Paid plans.
- **Real workerd runtime verification:** `scripts/wranglerSmoke/collageWasmSmoke.js` is a minimal standalone Worker entry (never bundled into Production, never touched by `node --test`) that exercises `jpegCodecWorker.js`'s real encode/decode round-trip. `npm run smoke:wasm` (`scripts/wranglerSmoke/runWasmSmoke.mjs`) boots it under a real local `wrangler dev --local` (genuine `workerd`, no Cloudflare credentials needed for local-only execution), hits it once, and asserts success — confirmed passing in this sandbox: `{"ok":true,"isJpeg":true,"dimsMatch":true,"colorClose":true,...}`. This is the "does the real Workers runtime actually load this WASM" check that plain `node --test` structurally cannot provide.
- **CPU cost note (not independently measured beyond the smoke test above):** decoding up to 4 small JPEGs, compositing, and re-encoding one 1200×900 JPEG is expected to be a low-double-digit-millisecond operation based on mozjpeg WASM's typical performance; the smoke test confirms it *works*, not its exact CPU-ms cost under Workers' billing model. Worth a quick real-world timing check after the first live deploy of this endpoint.

**Two real bugs found and fixed during this round, worth remembering:**
1. `src/cctv/bitmapFont.js`'s `drawText` originally trusted its caller's `x`/`y` to already be integers. `src/cctv/collage.js`'s placeholder-tile label math (`y + h/2 - GLYPH_HEIGHT*1.5`) produces a value that always ends in `.5`. Writing to a `Uint8ClampedArray` at a **non-integer index is normally a silent no-op** — except that `idx = (py * canvasWidth + px) * 4` can land on a perfectly valid **integer** `idx` whenever `canvasWidth` is even (because `0.5 * canvasWidth` is then itself a whole number), which silently **wraps the write into a completely different, valid-looking row/column** instead of failing loudly or no-op'ing. Caught by actually rendering test output to a JPEG and visually inspecting it. `drawText` now rounds `x`/`y` internally as defense-in-depth; `test/cctvCollage.test.js`'s test 9 is a regression test.
2. `composeQuadrantCollage`'s `filledCount` was originally computed from **fetch status alone, before decode was ever attempted** — so "4 candidates fetched a 200 response, but all 4 turned out to be undecodable garbage" could still return `ok:true, filledCount:4` with a collage that was secretly 4 "NO SIGNAL" placeholders wearing a JPEG extension. Caught by review. Fixed: `filledCount` (returned as `successfulDecodedFrames`) is now only incremented after `decodeJpeg` **and** the subsequent draw genuinely succeed; the function only proceeds to `encodeJpeg`/returns `ok:true` if at least one cell actually decoded — an all-fetched-but-all-undecodable input now correctly returns `ok:false, reason:'no-frames'`, exactly like an all-fetch-failed input. `test/cctvCollage.test.js`'s test 7b is the regression test (4 fetched OK, 4 fail to decode → no collage produced).

**V1.8.1/V1.8.2 hard rule (added after real Production testing found a bad selection, then narrowed after review found a false-positive risk): 服務區／休息站／服務站 CCTV 不得用於主線事故判斷.** Live testing at 國1 82K+100 found the N後 quadrant selecting a camera sited AT 湖口服務區 (86K+000) — a KM-proximity match, but a camera that can point at a parking lot, gas station, or the service area's own internal road, never guaranteed to show the freeway mainline at all. A nearby KM number does not mean mainline visibility.

- **The exclusion runs BEFORE distance ranking, not after.** `selectFourQuadrantCandidates` (`tdx/hsinchuCctvProbe.js`) builds an "eligible mainline CCTV pool" first (wrong-road AND service-area records both excluded at pool-construction time), and only THEN runs the four-quadrant nearest-in-radius search over that pool. Excluding after picking "nearest" was explicitly rejected — a service-area camera must never even be able to compete for a quadrant slot, regardless of how close its KM is.
- **V1.8.2 correction — WHICH fields count as evidence was narrowed after review.** The V1.8.1 version scanned every string-valued field on the record, including `RoadSection` — and that produced real false positives: a genuine **mainline** camera's `RoadSection` can legitimately read `湖口交流道-湖口服務區` or `湖口服務區-竹北交流道` (naming a service area as one *endpoint of the road segment* the camera covers), without the camera being physically inside that service area at all. `isServiceAreaCctv()` now checks **only**:
  1. **`CCTVID`/`CCTVId`/`ID`** — the device's own identifier. The real Production feed was observed to encode a camera's own siting directly in this field, e.g. `CCTV-N1-N-86-R-湖口(北)服務區-停車場-1` ("停車場" = parking lot) unambiguously names what the device itself is/is at.
  2. **`LocationType`** — but *only* if its value is itself literal, human-readable text naming a service area/rest stop. `RoadSection`/`RoadName` are **deliberately excluded** from the check now — they describe a road *segment*, not the device's own siting, and a segment can legitimately border or span a service area without the camera being inside it.
- **`LocationType`'s real enum semantics still could not be verified** — TDX's live API and documentation remain unreachable from this development sandbox (network egress to `tdx.transportdata.tw` is blocked, reconfirmed via both `curl` and `WebFetch` this round). So `LocationType` is only ever matched as literal text, exactly like `CCTVID` — never as a guessed numeric/enum code ("不要猜 LocationType 數值代表什麼"). If a future round confirms from a real response that `LocationType` is a reliable numeric/enum service-area marker, prefer switching to that structured check instead — ask before doing so.
- **Deliberately narrow scope**, unchanged from V1.8.1: only 服務區/休息站/服務站. Interchanges (交流道), ramps (匝道), system interchanges (系統交流道), tunnels (隧道), and bridges (橋梁) are **not** excluded by this rule — whether those are appropriate for incident CCTV is a separate, not-yet-made decision.
- **A quadrant whose only in-radius candidates are all service-area cameras is left `null`**, exactly like a quadrant with no candidates at all — a service-area camera is never used to "fill" a slot just because nothing else is nearby.
- Zero impact on TDX call count (same single metadata response, filtered locally) or the four-quadrant rule's shape (S前/S後/N前/N後 order, ±2km→±4km→null strategy, max 4 cameras) — both unchanged. See `test/hsinchuCctvProbe.test.js`'s tests 2d–2h for the regression coverage: 2d (the real-world CCTVID-siting case), 2e/2e2 (mainline cameras kept despite `RoadSection` mentioning a service area at either segment endpoint — the exact false positive V1.8.2 fixed), 2f (proximity never overrides exclusion), 2g (`LocationType`-as-literal-text exclusion, with `RoadSection` mentioning a service area on the *kept* mainline candidate in the same test), 2h (an all-service-area quadrant left `null`, never backfilled).

**Out of scope for this round / do not bundle in:** AI incident recognition, a second CCTV search pass/fallback tier, any change to `scheduled.js`/`broadcastPipeline.js`, any real LINE push of this image, any Cron change, any automatic Production TDX call. **This stage does not send anything to LINE** — `/admin/cctv-hsinchu-collage` is a manual, Admin-Auth-gated preview endpoint only, exactly like the four-quadrant probe page it builds on.

---

## 16. V1.8.3 — 四宮格顯示文字全面中文化 (collage display text fully localized to Traditional Chinese)

**Goal:** a taxi/for-hire driver reading the collage in LINE should understand it at a glance ("讓計程車／營業車司機在 LINE 上一眼就看懂"). This round changes ONLY the collage's on-image text and layout — selection logic, TDX calls, CCTV fetch behavior, and the collage endpoint's own orchestration are all unchanged.

**Display text changes:**
- Title: `國1 82K+100 附近監視畫面` (was `NH1 82K+100 CCTV`).
- Subtitle: `更新 HH:MM` (was `UPDATED HH:MM`).
- Quadrant labels: `南前`/`南後`/`北前`/`北後` (was `S BEFORE`/`S AFTER`/`N BEFORE`/`N AFTER`) — **fixed positions unchanged**: top-left/top-right/bottom-left/bottom-right, exactly the ratified V1.7 order.
- Per-cell info collapses from two lines (LocationMile, then distance) into **one line**: `82K+900 / 距事故 0.800 公里` — distance is **always 3 decimal places** (`toFixed(3)`), per instruction.
- Placeholders: `無符合鏡頭` (was "NO CAMERA", empty quadrant) and `暫無畫面` (was "NO SIGNAL", failed fetch/decode) — still visually distinct backgrounds (gray vs. red-tinted), same semantics as V1.8.
- `src/tdx/hsinchuCctvProbe.js` exports three small pure string-builders specifically so this display text is unit-testable without OCR-ing the rendered JPEG: `buildCollageHeaderLines(now)`, `candidateDistanceLabelForCollage(candidate)`, and the `CJK_QUADRANT_LABELS` array.

**Chinese font approach, original V1.8.3 attempt (SUPERSEDED — see the correction subsection below):** the first version of this round hand-authored a 16×16 1-bit bitmap font for the closed 24-character CJK set, the same technique already proven for the ASCII glyphs. **Production visual review rejected this.** Kept here only as history — do not resurrect hand-drawn CJK glyphs; see the correction below for what replaced it and why.

---

### V1.8.3 CORRECTION — hand-drawn CJK glyphs replaced with real-font rasterization

**Why:** Production visual review of the hand-drawn 16×16 font found it insufficiently legible — the title ("國1 82K+100 附近監視畫面") and several info-line/placeholder strings (距事故…, 無符合鏡頭) were reported hard to read. Diagnosis, confirmed by the reviewer: **not an encoding or rendering-pipeline bug** — this is a hand-authored *glyph quality* ceiling. A 16×16 1-bit dot-matrix approximation of stroke-dense CJK characters (附/近/監/距/鏡/暫 especially) cannot convey real stroke shape or anti-aliased edges no matter how many hand-tuning passes it gets. The fix is a different technique, not another round of manual glyph editing.

**Direction (explicit instruction):** stop hand-authoring CJK glyphs entirely. Use a real Traditional Chinese font, rasterized to a pre-baked bitmap/mask **at development/build time only**; Production ships only the rasterized data, never the font file, never a runtime font parser.

**Font source:** `@fontsource/noto-sans-tc` (npm, OFL-1.1 licensed) — real Google Fonts "Noto Sans TC," Regular/400 weight. This was the user's explicitly first-preferred option ("優先使用 Noto Sans CJK TC / Noto Sans TC"). It was installed **only** in an isolated scratch npm project outside this repository (`npm install --no-save` in a throwaway directory), purely as a rasterization input — **it is not, and must never become, a project dependency**; `package.json`/`package-lock.json` are untouched by this round (verify with `git diff package.json package-lock.json` — empty). The font file itself was never committed and was never sent to the user in any form.

**Rasterization pipeline (build-time only, not part of the deployed Worker):**
1. A throwaway HTML page (kept only in the scratch directory, never in this repo) loads the real webfont via `@font-face` and exposes a `rasterize(char, width, height, fontPx, baselineFrac)` function that renders one character with Canvas 2D `fillText()`, then extracts its **alpha channel** via `getImageData()` — this alpha channel IS the anti-aliased glyph mask; no separate anti-aliasing step is needed.
2. A Playwright script drives this page in the pre-installed headless Chromium (`/opt/pw-browsers/chromium`, already available in this environment — no browser download performed), rasterizing all 24 required CJK characters and all 16 required digit/symbol/space characters, and writes the results to scratch JSON files.
3. A one-off Node script converts those JSON files into `src/cctv/generated/cjkGlyphRaster.js` — the only artifact from this whole pipeline that is committed. Its header comment documents the font, license, tool, and exactly what was/wasn't committed, so the process is reproducible without needing to re-derive it from scratch.
4. **None of the scratch tooling (HTML page, Playwright driver script, raw JSON, the font package itself) is part of this repository** — only the derived alpha-mask data file is.

**Raster format:** grayscale alpha mask (one byte per pixel, 0–255), not 1-bit and not full RGBA — the user's explicitly preferred option ("優先考慮 grayscale alpha，讓中文字邊緣有 anti-aliasing"), since color is supplied by the caller at draw time and only the blend weight needs to vary per pixel. CJK glyphs are 32×32 ("full-width"); digits/K/+/:/ /./space are 16×32 ("half-width") — both share a 32px row height so mixed CJK+ASCII text (`82K+900 / 距事故 0.800 公里`) lines up on one baseline. **Deliberate deviation from a literal reading of the instruction:** the instruction said digits/symbols *could* keep the old hand-drawn half-width bitmap, provided it stayed visually proportionate. All 40 glyphs (24 CJK + 16 half-width) were rasterized through the same real-font pipeline instead, so mixed CJK+digit strings have visually consistent anti-aliasing rather than crisp hand-drawn digits sitting next to soft real-font CJK strokes.

**Runtime cost (unchanged constraint, honored):** `src/cctv/bitmapFont.js` at Worker runtime only ever does `atob()` (standard, universally available — not the WASM-loading path that has separate Workers-runtime concerns elsewhere in this project) plus per-pixel linear alpha blending into a plain `Uint8ClampedArray`. **No TTF/OTF/WOFF parsing of any kind happens at runtime.** Each glyph's decoded alpha bytes are memoized on first use (lazy per-glyph `Map` cache), so a collage request only pays the decode cost for characters it actually draws.

**Layout — recalculated, not preserved as-is (explicitly authorized: "不強制維持目前 scale=3 / scale=2"):** real-font glyphs are 32px tall natively, double the old hand-drawn font's 16px, so the old scale values would have roughly doubled the effective on-screen text size and overflowed the old header/label heights. The new values were **not picked by eye at native 1200×900 resolution** — they were validated by rendering full-size proof images AND phone-thumbnail-downsampled (375px-wide) simulations of the same renders, then visually inspecting the downsampled versions, since native-resolution legibility overstates what a phone chat thumbnail actually shows (this is exactly the gap the old hand-drawn round's rejection came from). Final values:
- `HEADER_HEIGHT`: 100 → 120. Title at scale 2 (64px-tall glyphs), subtitle at scale 1 (32px).
- `LABEL_HEIGHT`: 110 → 116. Quadrant label (南前/南後/北前/北後) at scale 2 (64px), the combined info line at scale 1 (32px) — scale 2 was measured to overflow the 600px cell width for the longest realistic info-line string, so scale 1 there is both the phone-legible AND the only-fitting choice.
- `IMAGE_AREA_HEIGHT`: 290 → 274 — a ~5.5% reduction, essentially preserving the original image-to-text area ratio (the CCTV photo area was explicitly not to be crowded out: "CCTV 畫面區域不能被文字吃掉太多").
- Placeholder tile text (無符合鏡頭/暫無畫面) stays at scale 3, unchanged — its centering formula (`drawPlaceholderTile`) is already parameterized off `LINE_HEIGHT`, so it needed no code changes, only benefiting from the new constant's value.

**Bundle impact:** the old hand-drawn `bitmapFont.js` was ~18.5KB (glyph data inline as JS literals). The new `bitmapFont.js` is ~7.1KB (pure logic, no glyph data) plus a new `src/cctv/generated/cjkGlyphRaster.js` at ~46.5KB (base64 alpha-mask data) — net growth ≈ 35.6KB total, negligible against Cloudflare Workers' compressed-bundle limits, and still zero new npm dependencies, zero new WASM modules, zero change to the existing `@jsquash/jpeg` codec path.

**Verification — visual proof, not just "glyph !== glyph" (explicit instruction: "不要只做「glyph 不相同」測試"):** a dedicated JPEG proof sheet was rendered through the real production `bitmapFont.js`/`collage.js` code path containing every string the instruction listed (title, subtitle, all 4 quadrant labels, all 3 example distance-info lines, both placeholders), plus a full realistic 1200×900 collage preview generated through the actual `composeQuadrantCollage()` production function (not a standalone mockup). **Both were also downsampled to 375px-wide (phone-thumbnail scale) and re-inspected at that size** — the requirement was legibility "正常手機縮放觀看仍能快速辨識，不是放大才能猜出文字," which native-resolution inspection alone cannot confirm.

`test/cctvCollage.test.js`'s test 10 was rewritten to match the new format: it now asserts directly against the raw `CJK_RASTER` alpha-mask data (correct dimensions, sufficient ink coverage per character, no two characters byte-identical) rather than inspecting exact-255 blended pixel color — the old check's binary assumption doesn't hold for genuinely anti-aliased glyphs, where most edge pixels carry partial alpha. A new companion test 10b exercises the real `drawText()` pipeline end-to-end (base64 decode → alpha blend) for every required character, catching a character-to-raster lookup bug that a direct-data-only check wouldn't.

---

## 17. V1.8.5 — Dynamic per-accident CCTV + LINE「事故文字 + 1 張四宮格」

**Goal:** wire the V1.8/V1.8.3/V1.8.4 CCTV collage pipeline into the REAL LINE broadcast, without ever sending the wrong location's CCTV image. Until this round, `hsinchuCctvProbe.js`'s four-quadrant selector had only ever run against one fixed test target (國道一號 82K+100). Naively importing that fixed target into `broadcastPipeline.js` would have attached that same 82K+100 image to every accident's LINE message, regardless of where the accident actually was — this round exists specifically to prevent that.

**Scope, explicit:** only `type==='accident'` events get CCTV enrichment attempted. Not closure/control/construction/other/congestion/alert/PBS-only — "先把事故做好." Real LINE push for TEXT was already live (pre-existing); this round adds the IMAGE, sent in the SAME LINE API call as the text.

### Dynamic road/KM resolution — reuse, not reinvent

- **KM**: `cctv/dynamicCollage.js`'s `eventTargetKm(event)` uses ONLY the structured `startKM`/`endKM` fields `tdx/normalize.js` already populates from TDX's own `StartKM`/`EndKM` (already TDX-formatted `"NNK+NNN"` strings), parsed via `traffic/roadSectionLabel.js`'s existing, already-tested `parseKM`. Target KM = midpoint of start/end when both present, else whichever one parses. **Never reads `description`/free text for a KM guess.** No reliable KM → `no-reliable-km` → text-only.
- **Road**: `resolveRoadKey(event.road)` — the SAME alias-resolution table (`國道1號`/`中山高`/`中山高速公路`/etc → canonical `國道一號`) already used throughout this app for corridor/section-label logic, now also exported from `roadSectionLabel.js`. An event whose road doesn't resolve at all → `unresolvable-road` → text-only.
- **CCTV_SUPPORTED_ROADS** (`dynamicCollage.js`) is a closed, tiny registry — **only `國道一號`** — because its CCTV `RoadID` (`'000010'`) and `RoadName` pattern are the only ones ever independently confirmed against a real Production TDX CCTV/Freeway response (V1.7). No other freeway's CCTV RoadID has ever been observed from this dev sandbox (TDX egress is blocked here). A resolved-but-unsupported road (e.g. 國道三號, which V1.7/V1.8's `roadSectionLabel.js` DOES know for section labels, but which has no confirmed CCTV RoadID) → `unsupported-road` → text-only. Adding a road here requires confirming its real CCTV RoadID from an actual Production response first — never guessed from "the numbering probably matches."

### Selector generalization — same algorithm, now parameterized

`hsinchuCctvProbe.js`'s `selectFourQuadrantCandidates(records, {roadId, roadNamePattern, targetKm})` (was hardcoded module constants) and its extracted `composeCollageFromCandidates(candidates, headerLines, {targetKm, codecOverride})` are the SAME four-quadrant rule (±2km→±4km→null per quadrant, max 4 cameras, service-area exclusion via `isServiceAreaCctv` — completely untouched) and the SAME collage renderer (`cctv/collage.js`, untouched) — just no longer hardcoded to 82.1K. Every existing fixed-target admin endpoint (`/admin/cctv-hsinchu-probe`, `-collage`, `-publish-test`) keeps its exact original behavior via default parameter values (`TARGET_ROAD_ID`/`TARGET_ROAD_NAME_PATTERN`/`TARGET_KM`, now exported). `buildCollageHeaderLines(now, {roadShortName, targetKm})` similarly defaults to `'國1'`/`TARGET_KM` for those callers, and takes the accident's own road/KM for the dynamic path — e.g. a 國3 accident (once/if ever supported) would read "國3 95K+200 附近監視畫面."

### CCTV metadata cache — shared, CACHE-ONLY for the broadcast path

**CORRECTION (post-review):** the first version of this cache fell back to calling TDX itself on a miss — meaning the broadcast path could, in principle, add TDX CCTV metadata calls on top of the already-budgeted RoadEvent schedule (Production: freeway+highway, every 20 min, 08:00–22:00, ~84 calls/day). Fixed: `src/cctv/freewayCctvMetadataCache.js` (`cctv:freeway-metadata:v1` on `TRAFFIC_KV`, **7-day TTL** — camera inventory is near-static; the live frame is still always fetched fresh from freeway.gov.tw on every use, never cached) is now a standalone module with a read side and a write side, and `cctv/dynamicCollage.js` (the broadcast path) imports **only the read side** — it no longer imports anything TDX-related at all (no `tdx/auth.js`, no `tdx/client.js`), so "0 TDX calls from broadcast" is a structural, import-graph guarantee, not just convention. Cache hit → CCTV proceeds. Cache miss/expired/corrupt → `metadata-cache-unavailable` → text-only, exactly like any other CCTV failure — **never** a TDX call.

The cache is instead refreshed as a side effect of `tdx/hsinchuCctvProbe.js`'s existing Admin-Auth-gated one-time probe (`GET /admin/cctv-hsinchu-probe`), which already makes its own, separately-budgeted TDX call for its own purpose — `handleHsinchuCctvProbe` now also calls `writeFreewayCctvMetadataCache(env.TRAFFIC_KV, records, now)` with the SAME already-fetched `records`, zero additional TDX calls. A human re-running that probe periodically (or a future round adding a dedicated Admin-only refresh endpoint — never Cron/broadcast-triggered) is how the cache actually stays populated in Production.

Within one Cron tick, N accidents still share **at most 1 KV read** via `runCache` — a plain `{}` object `broadcastPipeline.js` creates once per `runLineBroadcast` call and threads into every `prepareCctvImageForEvent` call; the first accident to need metadata stores the still-pending Promise on `runCache.metadataPromise`, every later accident this tick awaits that same Promise. Deliberately request-scoped, not module-global state (avoids cross-invocation staleness).

### R2 publish — unchanged from V1.8.4

Same `CCTV_IMAGES` binding, same `cctv/published-image/<opaque-id>.jpg` key shape, same 128-bit opaque id, same 15-minute code-enforced `expiresAt` check on every read (never HTTP caching, never R2 lifecycle alone — R2's own 1-day lifecycle rule, confirmed enabled in Production, is a backstop only). Nothing in `publishedImage.js` changed this round.

### LINE transport — one call, text+image together

`line/pushMessage.js`: `pushLineMessages(env, to, messages)` is now the core (arbitrary LINE message array, 1 HTTP request); `pushLineMessage(env, to, text)` is a thin wrapper — `pushLineMessages(env, to, [{type:'text',text}])`, byte-for-byte the same request body it always sent, so no existing caller/test needed to change. `broadcastPipeline.js` builds `messages` as `[text]` or `[text, image]` **before** the per-target push loop and sends the exact same `messages` array to every pending target for that event — **one LINE API call per target, never a separate second call for the image.** A text-then-image two-call sequence was explicitly rejected: a second call failing after the first succeeded would leave notified-state semantics ambiguous (was this target notified or not), and risks a duplicate text send on a naive retry.

### Fail-closed CCTV, per instruction — CCTV failure (or timeout) is never a LINE failure

`prepareCctvImageForEvent` fails closed at every stage: `not-accident`/`not-freeway-source`/`unresolvable-road`/`unsupported-road`/`no-reliable-km` (eligibility), `no-r2-binding`, `metadata-cache-unavailable` (cache miss/expired — see above, never a TDX call), `no-camera` (0 quadrants filled), `no-frames` (all 4 frame fetches/decodes failed), `r2-publish-failed`, `prepare-timeout`, `run-budget-exhausted`. **Every single one of these just means `messages` stays text-only** — never marks the event failed, never duplicates the text, and never touches `notified-state` on its own (only the actual LINE push result does that).

**CORRECTION round 1 (post-review) — bounded, not unbounded:** the first version awaited the entire CCTV pipeline with no overall ceiling before ever reaching the LINE push — a CCTV FAILURE didn't block the text, but a merely-SLOW CCTV pipeline (a hung frame fetch, a slow R2 put) could delay a real accident notification indefinitely. Fixed with `CCTV_PREPARE_BUDGET_MS` (4000ms, overridable per-call): `prepareCctvImageForEvent`'s entire body races against this budget; losing resolves `{ok:false, reason:'prepare-timeout'}` immediately. Frame fetches (already parallel, unchanged) additionally receive whatever's left of the budget as their own per-fetch timeout (`composeCollageFromCandidates`'s `frameTimeoutMs` option, floored at 300ms).

**CORRECTION round 2 (post-review) — PER-CALL budget accumulating across a run:** round 1's fix bounded ONE event's CCTV prep, but `broadcastPipeline.js`'s per-event loop is sequential — N eligible accidents in the same Cron tick, each independently given a fresh ~4s, could still accumulate to N×4s of delay before the LAST event's text is even considered. `CCTV_PREPARE_BUDGET_MS` is explicitly a PER-CALL budget; `broadcastPipeline.js` is what turns it into a whole-run guarantee: it computes ONE deadline (`cctvRunDeadlineAt = Date.now() + budget`) ONCE before its per-event loop starts, and each event's `prepareCctvImageForEvent` call is passed only `cctvRunDeadlineAt - Date.now()` — whatever's left. Once that hits ≤0, every remaining event in the tick skips CCTV entirely (`run-budget-exhausted`, zero wait, not even an attempt) rather than each getting its own fresh budget. Two further correctness fixes landed alongside this: (1) the race helper (`withTimeout`) now actually `clearTimeout()`s the pending timer when the real work wins, instead of a bare `Promise.race` leaving the loser's timer to fire uselessly later; (2) `prepareCctvImageWork` re-checks the deadline immediately before the R2 publish (the one truly expensive, side-effecting step) so a call that's already blown its budget by the time it reaches publishing doesn't bother writing an R2 object nothing will reference. In both correction rounds, the race's losing side is never forcibly aborted — it keeps running in the background and its eventual result is simply discarded, which is harmless since nothing ever hands that URL to a caller once the race is lost.

### Multi-target: compose/publish once, share the URL

CCTV prep runs once per EVENT (not per target) — structurally, because it sits above the `for (const target of pendingTargets)` loop in `broadcastPipeline.js`, computed into a local `messages` variable that every target in that inner loop then reuses unchanged. Verified in `test/broadcastCctvIntegration.test.js`'s test 15: 3 targets (2 users + 1 group) on the same event → exactly 1 R2 `put`, and all 3 LINE payloads carry the identical `imageUrl`.

### Interaction with V1.5.1 incident suppression / fingerprinting — untouched, verified compatible

- A suppressed re-tick (`resolveIncidentNotifications` → `suppressed:true`, same real incident, no material change) already yields `pendingTargets:[]` — CCTV prep is gated on `pendingTargets.length > 0`, so a suppressed tick triggers **zero** CCTV work, automatically (no special-case code needed).
- A material escalation (type change, new closure signal, more blocked lanes) yields non-empty `pendingTargets` again on its own — CCTV is freely recomposed/republished at that point, a brand-new image with a brand-new opaque id, exactly as intended ("material escalation 允許 rebroadcast 時：可重新產一次新的 CCTV collage") — again with zero special-case code, just the natural consequence of `pendingTargets` being non-empty.
- `notified.js`'s `computeNotificationFingerprint(event)` is derived purely from `type`/`road`/`direction`/`startKM`/`endKM`/`blockedLanes`/closure-signal — **never touched by this round, never fed anything CCTV/image-URL-derived.** The image URL's own randomness (a fresh opaque id every compose) therefore can never make an otherwise-identical event look "new."

### `GET /debug/status` — still 0 side effects

`resolveCctvEligibility(event)` is pure/synchronous/zero-I/O, so `result.cctvEligibleAccidentCount` is computed and populated even under `dryRun=true` (before the `if (dryRun) return result` early-return) — a legitimate stat, not a side effect. `result.cctvImagesAttachedCount`/`cctvSkippedByReason` are only ever populated on the real (non-dryRun) push path, since only that path actually attempts `prepareCctvImageForEvent`. `dryRun` never reads the CCTV metadata cache, never fetches a CCTV frame, never writes to R2, never calls LINE — enforced by construction (the CCTV block lives entirely after the dryRun early-return), verified in `test/broadcastCctvIntegration.test.js`'s test 8/22.

**Out of scope this round, unchanged:** `broadcastPipeline.js`'s non-CCTV logic, `scheduled.js`, Cron, PBS, `tdxSchedule.js`, `cctv/collage.js` (renderer), AI incident recognition, real LINE push testing, Production deploy, Production TDX probe.

---

## 18. V1.8.6 — TDX 用量對帳健康頁 (usage reconciliation ledger)

**Status: built and tested on `feature/v1.8.6-tdx-usage-ledger`, NOT merged to `main`, NOT deployed.** Purpose: let a human reconcile this Worker's own record of "how many real TDX data API calls did we actually make today" against TDX's own official back-office dashboard, and immediately spot an unexpected excess or shortfall — without `/health` ever costing a TDX call itself.

**Core safety rule, unchanged from every prior round's telemetry work:** `/health` still makes **0 TDX/0 PBS/0 LINE calls** — it only gained one extra read-only KV read (`tdx:usage:summary:v1`). Recording usage is best-effort/isolated throughout: every write in `src/tdx/usageLedger.js` is wrapped so a KV outage there degrades to "this batch/day's numbers are temporarily incomplete," never to a broken Cron run (see `test/tdxUsageLedger.test.js`'s test 16 — a usage-ledger KV that always throws still lets the real Cron tick commit dedupe state and run the LINE broadcast normally).

**All TDX call paths, inventoried before this round's changes** (`fetchTdxJson` in `src/tdx/client.js` is the single choke point every one of these goes through):
- `src/tdx/sources.js`'s `fetchSource` (called from `fetchAllSources` → `runTdxPipelinePreview`/`runTdxPipelineAndCommit`) — Production Cron (`scheduled.js`, `sourceIds: PRODUCTION_TDX_SOURCE_IDS` = freeway+highway only), `GET /debug/status`, `GET /debug/tdx` (both ALSO restricted to freeway+highway since V1.6.2 — see the correction below).
- `src/tdx/hsinchuCctvProbe.js`'s `handleHsinchuCctvProbe` (`GET /admin/cctv-hsinchu-probe`) — 1 CCTV metadata call.
- `src/tdx/cctvProbe.js`'s `handleCctvProbe` (`GET /admin/cctv-probe`) — 1 CCTV metadata call.
- `src/tdx/vdSpeed.js` (via `congestionValidation.js`) — **not reachable from any live Production/debug/admin path today** (V1.6.1 removed it from the Cron path; V1.6.2 also removed `/debug/status`'s own VD preview — see the corrections below). Only its own unit tests exercise it. Left uninstrumented for context tagging; if it's ever wired back in, it already gets recorded generically (no context = `'other'`) since it shares `fetchTdxJson`.
- `src/tdx/auth.js`'s `getAccessToken`/`requestNewToken` — OAuth, counted completely separately (see below).

**Two stale-documentation corrections found during this inventory** (fixed in the code comments this round, not just here): `src/tdx/sources.js`'s `PRODUCTION_TDX_SOURCE_IDS` comment used to claim `/debug/tdx`/`/debug/status` still fetch all 5 sources for diagnostics — wrong since V1.6.2, both are restricted to freeway+highway (≤2 TDX calls/request). `scheduled.js`'s V1.6.1 comment used to claim `/debug/status` "keeps its own read-only preview" of the VD confirmation step — also wrong since V1.6.2 removed that preview too. `vdSpeed.js`'s TDX calls are dead code on every live path, full stop.

### How a call gets counted

`fetchTdxJson(url, accessToken, { source, usageSink })` — `usageSink` is a plain in-memory array threaded down from the top-level caller. Every real `fetch()` attempt (network error, non-2xx, or success) pushes exactly one `{kind:'data', timestamp, source, attempted:true, success, httpStatus, payloadBytesEstimate}` record — **only an actually-attempted HTTP request is ever counted**, never a scheduling estimate. `src/tdx/auth.js`'s `getAccessToken(env, usageSink)` similarly records a `{kind:'oauth', ...}` record, but **only** in the tier-C branch (`acquireToken`'s `requestNewToken()` call) — a memory-cache or shared-KV-cache token hit records nothing, so OAuth volume genuinely reflects real network requests to TDX's token endpoint, not every `getAccessToken()` call.

**Concurrency — no lost-update risk, by construction, not by locking.** `fetchAllSources()` fires multiple sources via `Promise.all`; a naive "read today's total, +1, write today's total" counter would lose increments under that concurrency. This design never does that: each invocation collects its own in-memory array (`.push()` is synchronous and non-interleaving in JS — safe across concurrent in-flight promises without a lock), and only once the WHOLE invocation finishes does it write **one** append-only KV entry (`commitTdxUsageBatch`) under a fresh unique key (`tdx:usage:entry:v1:<date>:<epochMs>:<opaqueId>`, 40-day TTL). Two invocations "at the same time" just produce two independent keys — nothing to race.

**Contexts:** `production-cron` | `debug-status` | `debug-tdx` | `admin-cctv` | `other` (anything unrecognized). **Source buckets** (`normalizeSourceBucket`): `freeway` | `highway` | `cms` | `bus-hsinchu` | `bus-hsinchu-county` | `cctv` (both `cctv-probe` and `cctv-hsinchu-probe` collapse into this one bucket) | `other`.

### Payload bytes — "本地估算傳輸量", not a claim of TDX's own billing figure

`fetchTdxJson` reads the response body **once** via `response.arrayBuffer()` (exact byte length, no second request), decodes that same buffer with `TextDecoder` for `JSON.parse` — never `response.json()` directly, which would give no way to also measure size without a duplicate read. This measures bytes **after** the Workers runtime's own gzip decompression (`Accept-Encoding: gzip` is still sent), so it will not exactly match TDX's own transfer/billing figure if TDX uses a different compression or metering convention — the health page explicitly labels this "本地估算傳輸量", never claims exact parity, but it's good enough to long-term-calibrate against.

### Compaction and the theoretical baseline

`compactTdxUsageSummaryForToday(kv, now)` — Cron-driven (called from `scheduled.js` after every real run, best-effort), re-lists **only today's** raw entries (`kv.list({prefix: 'tdx:usage:entry:v1:<today>:'})`, paginated) and rebuilds that one day's row from scratch (idempotent — safe to call every tick, never double-counts), merging it into the persisted `tdx:usage:summary:v1` alongside every other day's already-frozen row (last `USAGE_SUMMARY_RETENTION_DAYS`=35 days kept). `/health` never lists/scans — it only ever reads this one compacted key.

`theoreticalProductionCallsToday(now)` is **pure date math, zero I/O** — 08:00–22:00 Asia/Taipei, every 20 minutes, 2 sources/window (mirrors `tdxSchedule.js`'s real gate) — computed live at `/health` render time so it stays accurate even between Cron ticks. Full-day theoretical = `PRODUCTION_TDX_CALLS_PER_DAY` = 84 (42 windows × 2 sources).

### `/health` additions

Below the existing TDX card: **TDX 用量對帳** (today's calls / today's theoretical / diff / today's estimated bytes / manual extra calls), **來源拆解（今日）** (Production freeway/highway + manual debug-status/debug-tdx/admin-cctv breakdown), **本月總覽** (`aggregateUsageForMonth` — sums whatever day-rows are already in the retained summary, no extra KV read), **每日對帳表（近 30 天）** (a day with no ledger entry at all — e.g. any day before this round's deploy — renders `尚無資料`, **never a fabricated 0**), and a clearly-separate, statically-labeled **TDX 官方歷史參考（非本機統計）** card carrying the two officially-reported reference points the user supplied by hand (2026-08-16: 1490 calls/17016KB; 2026-08-17: 704 calls/10534KB; month-to-date: 2194 calls/~27MB) — explicitly captioned as official-dashboard numbers, not this app's own telemetry, since the Local Usage Ledger only starts accumulating from this round's Production deploy onward.

### Deliberately NOT done this round

Backfilling 2026-08-16/17/18 with fabricated "local" numbers (explicitly forbidden by the round's own instructions). A per-day source-breakdown table for the full 30-day history (only TODAY gets the detailed source/context breakdown card — the daily reconciliation table's Production/Manual columns already cover the historical case; expand only if asked). Reusing `incidentSuppression.js`'s own separate free-text KM parser or any other unrelated module — this round touched only `src/tdx/{client,auth,fetchAll,sources,debug,hsinchuCctvProbe,cctvProbe}.js`, `src/traffic/{pipeline,scheduled,debugStatus,health}.js`, and the new `src/tdx/usageLedger.js`.

**Tests:** `test/tdxUsageLedger.test.js` (recording, batching/no-lost-update, Cron gating, context/source breakdown, OAuth separation, failed-call recording, payload-byte estimation, `/health`'s 0-TDX-calls guarantee, Taipei day rollover, monthly rollup, the theoretical baseline at several points in the day, multi-page-safe idempotent compaction, and the KV-failure isolation guarantee) plus two pre-existing `/debug/status` "read-only" tests (`test/pipeline.test.js`, `test/debugStatusLine.test.js`) updated to allow the new, deliberate, append-only usage-ledger writes while still proving genuine traffic/dedupe state is untouched.

### CORRECTION (post-review) — 3 reconciliation-correctness blockers fixed

1. **`trackingStartedAt` — no false negative diff on a mid-day first tracking day.** `theoreticalProductionCallsToday`/the 30-day table used to always assume a full `08:00`-onward baseline, so a Worker deployed mid-day (e.g. `20:32`) would immediately show a large, false negative diff for windows that fired before the ledger even existed. Fixed: `tdx:usage:summary:v1` now carries an immutable `trackingStartedAt` (ISO timestamp), set ONCE on the very first `compactTdxUsageSummaryForToday` call and preserved byte-for-byte on every compaction after that — never reset. `theoreticalProductionCallsToday(now, trackingStartedAt)` and the new `theoreticalProductionCallsForDay(dateStr, trackingStartedAt)` both subtract however many of the 42 daily windows had already fired before `trackingStartedAt`, but ONLY on the exact calendar day tracking began (`isPartialTrackingDay`) — every later day is a normal, complete 84-call baseline. `/health`'s daily table labels that one day "部分日" and shows the Taipei start time in the today-card's hint text, never displaying it as if it were a normal complete day.
2. **`byContextSource` — Production and Debug/Admin source counts no longer mix.** `bySource`/`byContext` were two independent 1D aggregates, so a human running `/debug/status` once (+1 freeway, +1 highway) silently inflated what `/health`'s "Production" block displayed as `bySource.freeway`/`bySource.highway` — a real accounting bug, not just a display nit. Fixed: `buildDayRowFromEntries` now also produces a 2D `byContextSource: { context: { sourceBucket: count } }`, and `/health`'s "Production" source rows read ONLY `byContextSource['production-cron']` — `bySource`/`byContext` are kept (useful marginal totals for other purposes) but the module comment now explicitly warns never to label `bySource` as "Production" again.
3. **Cross-midnight attribution by each record's OWN timestamp, not the invocation's `now`.** `commitTdxUsageBatch` used to key its single KV entry's `date` off the invocation's `now`, so a human-triggered Debug/Admin call spanning Asia/Taipei midnight (started `23:59`, resolved `00:00`) could misattribute a late-night call to the wrong calendar day — a real source of 1-2 call drift against TDX's own official per-day dashboard. Fixed: records are grouped by `taipeiDateString(record.timestamp)` and written as up to 2 separate append-only entries when an invocation genuinely straddles midnight — still append-only, still no shared counter. The overwhelmingly common case (any single invocation entirely within one calendar day — every real Production Cron tick, by construction) still writes exactly ONE entry, unchanged.

Nothing else changed in that round — `fetchTdxJson`'s single choke point, the single `arrayBuffer()` read, OAuth/data-call separation, append-only design, 40-day raw TTL, 35-day summary retention, `/health`'s 0 TDX/0 PBS/0 LINE guarantee, TDX cadence, LINE, CCTV, PBS, and incident suppression are all untouched. Also fixed: a stale `src/tdx/debug.js` header comment that still claimed "Never touches KV/D1" — corrected to describe the one deliberate, isolated, append-only usage-telemetry write this handler now makes (comment-only change, no behavior change).

### CORRECTION ROUND 2 (post-review) — 2 daily-reconciliation boundary bugs fixed

1. **The first Production window itself must never be swallowed by `trackingStartedAt`.** If the ledger's very first-ever compaction happens on the SAME tick as the first real Production TDX call (e.g. a fresh deploy whose first tick is exactly `20:40`), the naive fix from the previous correction round still undercounted: `trackingStartedAt` was set to the raw compaction-time `now` (always a few ms/seconds AFTER `20:40:00`, since Cron dispatch + fetch + normalize + compact all take real time), and the OLD `windowsBeforeTrackingStarted` was inclusive of a window sitting exactly on `now`'s boundary — together this meant the `20:40` window that had JUST produced the 2 calls being compacted was itself counted as "already fired before tracking started," undercounting the theoretical baseline by one whole window (2 calls) and showing a false `+2` on the very first tracked tick. Fixed two ways, together: (a) `compactTdxUsageSummaryRecentDays`/`compactTdxUsageSummaryForToday` now seed `trackingStartedAt`, on the very first compaction only, from the EARLIEST `production-cron` data-call timestamp already present in today's entries (if any), floored DOWN to that call's own 20-minute window start (`windowStartFor` — e.g. a call timestamped `20:40:03` sets `trackingStartedAt` to `20:40:00`, not `20:40:03`); if today has no Production data call yet (the first compaction landed on a skipped/PBS-only tick), this still falls back to the raw `now`, unchanged. (b) `windowsBeforeTrackingStarted` now uses a NEW `productionWindowsStrictlyBefore(moment)` (excludes a window sitting exactly on the boundary) instead of the inclusive `productionWindowsElapsedToday` — so a window-start-aligned `trackingStartedAt` correctly counts as the FIRST tracked window, not the last untracked one. Boundary examples: `08:00:00`→0, `08:00:01`→1, `20:40:00`→38, `20:40:01`→39.
2. **A cross-midnight invocation's "yesterday" entry must be picked up by the NEXT Cron compaction.** The previous correction round already fixed `commitTdxUsageBatch` to attribute each record to its own timestamp's Asia/Taipei date (so a Debug/Admin call spanning midnight correctly writes a separate `tdx:usage:entry:v1:<yesterday>:...` entry) — but compaction only ever re-listed TODAY's prefix. If that "yesterday" entry finished writing AFTER midnight (invocation started `23:59`, resolved `00:00+`), yesterday's summary row had already been frozen by the last Cron tick before midnight and would never see it again — a permanent 1-call drift against TDX's own official per-day dashboard. Fixed: the real Cron path now calls a new `compactTdxUsageSummaryRecentDays(kv, now)` instead of the narrower `compactTdxUsageSummaryForToday` — it re-lists and rebuilds BOTH today's and yesterday's `DayRow`s every tick (still bounded/cheap: exactly 2 `list()` scans, never the full 35-40 day history), merges both into the persisted summary alongside every other already-frozen day, and still preserves `trackingStartedAt`/35-day retention exactly as before. `compactTdxUsageSummaryForToday` (today-only) is kept as its own narrower function, still used directly by a few unit tests. `/health` still only ever reads the compacted summary key — it never lists raw entries itself, unchanged.

Nothing else changed this round either — everything listed as untouched in round 1 remains untouched, plus `byContextSource`, OAuth/data separation, and byte estimation from round 1 itself are all unchanged here too.

### CORRECTION ROUND 3 (post-review) — 1 small isolated fix

`compactTdxUsageSummaryRecentDays` (round 2) unconditionally overwrote the summary's yesterday-key with a freshly rebuilt row every tick — including on this Worker's very FIRST day live, when yesterday genuinely has zero raw ledger entries (the ledger didn't exist yet). That manufactured a fake `0 calls / 84 theoretical / -84 diff` row for a day nothing was ever tracked on, directly contradicting `/health`'s own "nothing before tracking started renders 尚無資料, never a fabricated number" rule. Fixed: yesterday's rebuilt row now only REPLACES what's in the summary when `yesterdayEntryBodies.length > 0` (today's row is still written unconditionally, unchanged). This correctly covers all four cases: no ledger existed yesterday at all → no key written, `/health` shows 尚無資料; yesterday genuinely had 0 calls but a summary row already existed → left untouched (this function never deletes an existing row); a genuine cross-midnight late entry exists → rebuilt and folded in, unchanged from round 2; yesterday already had real calls → rebuilt normally, unchanged. `test/tdxUsageLedger.test.js` covers both the fabricated-row-must-not-appear case and confirms the cross-midnight regression from round 2 still passes.

---

## 19. V1.8.6.1 — `/health` UI 瘦身＋TDX 額度儀表板 (quota-first mobile dashboard)

**Status: built and tested on `ui/v1.8.6.1-health-quota-dashboard`, NOT merged to `main`, NOT deployed. UI/derived-calculation only — no change to Production TDX cadence, no new TDX request of any kind, no change to `scheduled.js`/the pipeline.**

**Goal:** the V1.8.6 usage ledger's *data* was already correct — this round is purely about making `/health` answer "今天用了多少／本月用了多少／還剩多少額度／月底會不會爆" in 3 seconds on a phone, instead of reading like an engineering debug dump. All numbers still come from the same single `tdx:usage:summary:v1` read `handleHealth` already made — **zero new KV reads, zero TDX/PBS/LINE calls** (verified by `test/healthQuotaDashboard.test.js`'s test 12, which makes `fetch()` itself throw and confirms `/health` still renders normally).

### TDX 官方基礎服務點數換算 (`src/tdx/usageLedger.js`)

Confirmed against TDX's own back-office dashboard, not guessed: **1500 calls = 1 point, 150 MB transferred = 1 point**, additive (`estimatePoints({totalDataCalls, payloadBytesEstimate})` → `callPoints + trafficPoints`). Centralized as `TDX_CALLS_PER_POINT`/`TDX_TRAFFIC_MB_PER_POINT` — never duplicated/hardcoded in `health.js`. Every place this number is shown is explicitly labeled "本地估算點數" — TDX's own official point accounting may use a different transfer-size/call-counting convention than this Worker's local `payloadBytesEstimate` (see `client.js`), so this is never claimed to be byte-for-byte identical to TDX's real account balance.

**`TDX_MONTHLY_POINT_BUDGET`** — a single centralized constant, default **3** (this project's current TDX 基礎會員方案: 3 points/month). If the plan is ever upgraded, this is the one constant to change — nothing else references a hardcoded budget number. `remainingPoints(estimatedPoints, budget)` = `max(0, budget - estimatedPoints)` (never negative — a maxed-out month reads as exactly 0 remaining). `usagePercent(estimatedPoints, budget)` = plain fraction, unclamped (the UI clamps only the progress-bar *width*, not the underlying number, so an over-budget month still shows a true >100% figure in the raw percent text).

### `/health` layout, top to bottom

1. **TDX 今日** — big number (today's total calls) + 流量／估算點數／Production／人工額外 rows + a partial-tracking-day notice when applicable.
2. **TDX 本月** — big number (month-to-date total calls) + 流量／估算點數.
3. **剩餘額度** — big `X.XXX / 3.000 點` + a progress bar + 已使用%／剩餘% + a status line: **<70% → ✅ 額度充足, 70–90% → ⚠️ 注意用量, ≥90% → 🔴 接近上限**. This is a quota WARNING only — it never promotes `/health`'s own `status` (normal/degraded/critical, driven by `healthSnapshot.js`/staleness) to a worse tier; a near-exhausted TDX point budget is a usage anomaly to watch, not a pipeline failure.
4. **月底預估** (`projectEndOfMonthPoints`) — projects the month's total point cost from the average points/day of already-**complete** tracked days (excludes today, which is still accumulating, and excludes the tracking-start day, which is partial by definition — `isPartialTrackingDay`) × remaining days in the month, plus points already used month-to-date. Requires **≥2 complete tracked days** before projecting anything — fewer than that renders "資料累積中", never a number computed off a single (possibly unrepresentative) day.
5. **來源拆解（今日）** — Production now shows **only 國道／省道** (freeway/highway — the two sources actually live in Production since V1.6.1); 人工／管理 shows CCTV／Debug Status／Debug TDX／其他, **hides any zero row**, and shows "今日無人工額外呼叫" when all four are zero.
6. **⚠️ 發現已停用 TDX 來源** — a separate card, rendered ONLY when today's CMS/公車市/公車縣 counts (the marginal `bySource` total, across every context) are collectively nonzero — i.e. someone called TDX in a way that touched a source retired from Production in V1.6.1 (most likely a full-5-source `/debug/tdx`/`fetchAllSources` call). Fully absent on a normal day. The backend ledger buckets for these 3 sources are **not removed** — `usageLedger.js`'s `KNOWN_SOURCE_BUCKETS` still records them if any context ever calls them, preserving history/anomaly-detection capability even though the default Production display no longer shows them as fixed zero rows.
7. **每日對帳（近 7 天）** — simplified to 日期／呼叫／流量／估算點數／差額 (dropped the old Production/人工/理論 columns from the compact view — that breakdown is already visible in card 1/5 for today). No JS interaction added; the full 30-day history remains in `tdx:usage:summary:v1`, just not rendered as a wide table by default.
8. **進階資訊** — a native `<details>` disclosure (zero JS): 今日 Production 理論／OAuth 真實刷新（今日／本月）／the point-conversion formula spelled out／and the same "TDX 官方歷史參考（非本機統計）" reference block from V1.8.6, all moved out of the primary scroll.

### CCTV accounting — confirmed to count, confirmed never mislabeled

TDX's own back-office has confirmed "高速公路閉路電視攝影機資料" (the CCTV **metadata** API — `GET /Road/Traffic/CCTV/Freeway`, called by the two Admin CCTV probes, source tags `cctv-probe`/`cctv-hsinchu-probe`) counts toward TDX's own call/traffic/point accounting. This ledger already reflected that by construction before this round (both probes go through `fetchTdxJson` like every other TDX call, tagged `context='admin-cctv'`) — this round only changes *where* it's displayed: under "人工／管理" (labeled "CCTV"), never folded into the "Production" block, while still being fully counted in 今日/本月/estimated points/剩餘額度 totals (`test/healthQuotaDashboard.test.js` tests 10/11 assert both halves of this directly). **Not counted, and must never be**: the real-time CCTV **frame** fetch (`extractFirstJpegFrame`, direct MJPEG pull from `*.freeway.gov.tw`) used by the actual LINE broadcast image (V1.8.5) — that's a plain unauthenticated HTTPS GET to a different host entirely, never goes through `fetchTdxJson`, and was never TDX API traffic to begin with.

**Out of scope this round, unchanged:** `scheduled.js`, the TDX/PBS/LINE pipeline, Production Cron cadence, any new TDX request, `commitTdxUsageBatch`/compaction logic, `byContextSource`'s underlying data shape (only how `/health` reads/displays it changed).

**Tests:** `test/healthQuotaDashboard.test.js` (new, 13 tests — the point conversion, budget/remaining/percent math, partial-day exclusion from the month-end projection, the ≥2-complete-days gate, retired-source hide/warn, CCTV counted-but-never-Production, and `/health`'s continued 0-TDX-calls guarantee) plus one pre-existing `test/tdxUsageLedger.test.js` assertion updated to match the redesigned page's new top heading ("TDX 今日" instead of the old "TDX 用量對帳" card).

### CORRECTION (post-review) — month-end projection could leak in last month's days

`projectEndOfMonthPoints` iterated every "complete" day in `summary.days` with no month filter — but the summary retains ~35 days, which routinely spans a calendar-month boundary (e.g. on `09/03`, `summary.days` can still hold `08/10`–`08/31`). Without a filter, "本月月底預估" would silently average LAST month's complete days into THIS month's projection — a real correctness bug (last month's usage pattern has no bearing on whether this month is on track), not just noise. Fixed: `completeDayPoints` now only considers days whose date string starts with the same `YYYY-MM` prefix as `now`'s Asia/Taipei calendar year+month — the same month-scoping `aggregateUsageForMonth` (which `monthToDatePoints` already builds on) uses, so the projection and the month-to-date actual it's added to always talk about the same month. Everything else — excluding today, excluding the tracking-start partial day, the ≥2-complete-days gate, `remainingDaysAfterToday` — unchanged. Also reworded the retired-source-anomaly hint text: it used to suggest "manual debug calls" as the likely cause, which is misleading since `/debug/tdx`/`/debug/status` have been restricted to freeway+highway since V1.6.2 and can't produce a CMS/Bus hit through normal use — now reads "代表有未預期程式路徑呼叫到已停用來源" (comment/text-only, no behavior change). New test: a cross-month scenario (two very-high-usage August days + two low-usage September days) confirms only the September days are averaged.

### CORRECTION (post-review) — a 2026-08 pre-Ledger official usage baseline

The Local Usage Ledger only started accumulating on **2026-08-18** (V1.8.6's Production deploy). For August 2026 specifically, real TDX usage genuinely happened BEFORE that (the user's own confirmed TDX official back-office figures: `2026-08-16` = 1490 calls/17016 KB, `2026-08-17` = 704 calls/10534 KB, cumulative through 8/17 = 2194 calls / 27550 KB / **1.643 points** — TDX's own displayed cumulative point figure, not recomputed locally). Without accounting for this, `剩餘額度`/`本月` were computed from `aggregateUsageForMonth` alone (Local Ledger only) — silently omitting that real pre-Ledger usage and making remaining quota look artificially larger than it actually is for August.

**Fixed with a hand-entered, one-time reference** — `TDX_OFFICIAL_USAGE_BASELINES` (`src/tdx/usageLedger.js`), keyed by exact `"YYYY-MM"` string:
```js
{ '2026-08': { fromDate: '2026-08-16', throughDate: '2026-08-17', calls: 2194, transferKB: 27550, officialPoints: 1.643 } }
```
Explicitly NOT derived from anything this Worker measured — a human-confirmed TDX-dashboard figure, same "不要回推猜測" principle as everywhere else in this ledger. `getOfficialUsageBaseline(now)` does an **exact key lookup, no fallback** — a month with no entry (every month except 2026-08, as of this writing) simply has no baseline; nothing carries August's baseline forward to September or any later month automatically.

`estimateMonthUsage(summary, now)` = `{baseline, localTotals, localPoints, estimatedCalls: baseline.calls + local.totalDataCalls, estimatedBytes: baseline.transferKB×1024 + local.payloadBytesEstimate, estimatedPoints: baseline.officialPoints + localPoints}` (baseline fields treated as 0 when this month has none). `/health`'s **TDX 本月**/**剩餘額度**/**月底預估** cards all now read from this instead of raw `aggregateUsageForMonth` — the 本月 card shows a small note ("含 8/16–8/17 TDX 官方既有用量 1.643 點...") only on a month that actually has a baseline. `projectEndOfMonthPoints`'s `monthToDatePoints` now also comes from `estimateMonthUsage` (baseline + local MTD) — but its **daily average** (`avgPointsPerDay`) is deliberately untouched, computed ONLY from genuine Local Ledger complete-day rows, exactly as before — the baseline is one cumulative pre-Ledger figure, not a set of daily rows, and must never be treated as if it were 8/16/8/17's own Local Ledger entries.

**Daily history is completely untouched by this correction** — `summary.days` (and therefore the 7-day reconciliation table) never gets baseline data written into it; `2026-08-16`/`2026-08-17` still correctly render `尚無資料` as genuine Local Ledger rows, never fabricated from the baseline (`test/healthQuotaDashboard.test.js` test 5 asserts the exact `尚無資料` table row for both dates).

**Tests added** (`test/healthQuotaDashboard.test.js`, 6 new): August with 0/0.200 local points → correct baseline-inclusive remaining (1.357/1.157); September → baseline never applies; month-end projection combining baseline + local MTD + local-only daily average; 8/16–8/17 daily rows still `尚無資料`; `/health` still 0 TDX/PBS/LINE calls with a baseline in effect.

### CORRECTION (post-review) — overlap-safe baseline + the real, currently-unresolved 8/18 coverage gap

The previous correction added `estimatedCalls = baseline.calls + localTotals.totalDataCalls` unconditionally — but `localTotals` summed **every** Local Ledger day in the month, including days already fully counted inside the baseline's own cumulative figure. Concretely: `baseline.throughDate` (`'2026-08-17'`) means the official cumulative numbers already cover every day up to and including the 17th — but the Local Ledger's `trackingStartedAt` is mid-day on the 18th (V1.8.6 deployed partway through that day), so there's currently a real, unresolved gap (`2026-08-18 00:00` through `trackingStartedAt`) covered by **neither** source, and any Local Ledger row landing on/before `throughDate` would have been double-counted if summed naively.

**Fixed, "overlap-safe":**
- `aggregateUsageForMonth(summary, now, { afterDate })` (`src/tdx/usageLedger.js`) gained an optional `afterDate` ("YYYY-MM-DD", exclusive) filter — every pre-existing caller (no `afterDate` passed) is completely unaffected.
- `estimateMonthUsage` now calls it with `afterDate: baseline.throughDate` whenever this month has a baseline — so a Local Ledger day **on or before** `throughDate` no longer contributes to the month quota total (the baseline already counts it), while a day **strictly after** `throughDate` still adds on top, exactly as intended. This does **not** touch `summary.days` itself — a Local DayRow on/before `throughDate` (e.g. 2026-08-18, the Ledger's own partial first day) still exists exactly as recorded and still renders normally in the 7-day daily reconciliation table; it's excluded only from this one month-level aggregation.
- `TDX_OFFICIAL_USAGE_BASELINES`' `throughDate` is now explicitly documented as inclusive-coverage, overlap-safe by construction: once TDX's own official 2026-08-18 cumulative figures become available, the ONLY change needed is bumping that one entry's `throughDate` to `'2026-08-18'` and updating `calls`/`transferKB`/`officialPoints` — the exclusion (and the gap warning below) both automatically adjust, no other code changes.

**New: `hasPendingBaselineCalibrationGap(summary, now)`** — true only when this month has a baseline AND the Ledger's `trackingStartedAt` date is strictly after `throughDate` AND tracking didn't start at exactly `00:00:00` Asia/Taipei that day (which would mean the Ledger already covers that whole day, no gap). Never estimates/fills the uncovered stretch — only flags that it exists. `/health`'s **TDX 本月**/**剩餘額度** card headings show a **"（暫估）"** badge and the 剩餘額度 card gets an extra warning line ("⚠️ {該日期} Ledger 啟用前用量尚待 TDX 官方日結校正（目前為暫估，非已完整校正的剩餘額度）") whenever this is true — currently true in Production, since `throughDate` is still `2026-08-17`.

**Tests added** (`test/healthQuotaDashboard.test.js`, 5 new): baseline-through-8/17 with local rows on 8/18+8/19 → both add (neither on/before `throughDate`); a hypothetical baseline-through-8/18 with the same two rows → only 8/19 adds (8/18 not double-counted, tested directly against `aggregateUsageForMonth`'s new `afterDate` option); the 8/18 daily row still renders its real numbers in the reconciliation table even though excluded from the month total; the real current gap (`throughDate=8/17`, `trackingStartedAt` mid-day 8/18) is detected and surfaces both the warning text and the "（暫估）" badge; no false-positive gap when tracking started on/before `throughDate` or at exact midnight.
