<!-- title: 完整工程歷史 1/8 -->

# PROJECT_HANDOFF（完整工程歷史）— 第 1 段／共 8 段

> 非 canonical。這是 Repo 內未經刪減的 `PROJECT_HANDOFF.md` 依章節切分後的第 1 段，
> 僅供追查歷史 Root Cause 時閱讀；日常接班請讀 `02_PROJECT_HANDOFF.md`。
> 完整且權威的版本永遠是 Repo 內的 `PROJECT_HANDOFF.md`。

---

# PROJECT_HANDOFF.md — traffic-reporter (路況播報員)

**Read this file before touching the repo.** It exists so a new AI/agent session can operate correctly without re-scanning the whole codebase or re-investigating history that is already solved. If something below conflicts with what you find in the code, trust the code and treat this file as stale — but update it once you understand why.

```
STATUS: V1.8.6.5 Production live
MAIN:   ee0d159b65e703fec3d7fe16690228bea433d5fb
DATE:   2026-08-20
PHASE:  Production operation. No speculative feature work; only real-world bug fixes.
```

See `RELEASE_SUMMARY_V1.8.5.md` for the human-readable version of the V1.8.5 round, and `ENGINEERING_STATUS.md` for the current-state snapshot (Production version, known issues, watch items) — this file stays the round-by-round "why" history; that one stays a single current-truth page.

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
| `debug:broadcast-provenance:v1:<date>:<epochMs>:<opaqueId>` | `src/traffic/broadcastProvenance.js` | V1.8.6.4 (branch, not yet merged) — append-only, one entry per event ACTUALLY pushed to ≥1 LINE target this run (never eligible-but-unsent/deduped/0-subscriber). 48-hour TTL. Read only by `GET /admin/broadcast-provenance` (§8/§20) — never by the real broadcast path itself |

Never assume a key not in this table exists — `grep -rn "_KEY = " src/` to double check if you suspect drift.

---

## 8. Debug endpoints (all read-only, all safe to hit repeatedly)

**V1.6.3: every endpoint below, plus `GET /health`, now requires HTTP Basic Auth** (username `admin`, password from the `ADMIN_PASSWORD` Secret — see §6, `src/security/adminAuth.js`). Auth is checked before any handler runs, so an unauthenticated request never reaches TDX/PBS/KV. `POST /webhook` and the Cron `scheduled()` handler are unaffected (never gated by admin auth).

- `GET /debug/status` — the full pipeline preview: TDX fetch/normalize/dedupe stats, `sourceHealth`, the LINE broadcast-readiness fields (`broadcastRelevantCount`, `typeIneligibleCount`, `ineligibleByReason`, `pendingTargetCount`, `lineReady`, ...), PBS stats (`pbsOk`, `pbsActiveCount`/`pbsClearedCount`/`pbsStaleCount`, `crossSourceDuplicateCount`, `canonicalEventCount`), `tdxTokenCache` (which tier served the token — never the token itself). **This is the primary tool for diagnosing "why didn't/did this event broadcast."**
- `GET /debug/tdx` — raw per-source TDX fetch results (freeway/highway/cms/bus-hsinchu/bus-hsinchu-county), independent of PBS/broadcast logic.
- `GET /debug/pbs` — PBS-focused: `pbsTransport: "vpc-relay"`, `relayConfigured`/`relayOk`/`relayStatus`/`relayCache`/`relayUpstreamDurationMs`, lifecycle counts, cross-source samples.
- `GET /debug/pbs-vpc-probe` — the lowest-level check: hits the Relay's `/health` and `/pbs` directly through the VPC binding and returns redacted status/body previews. Use this first if PBS itself looks broken (before assuming it's a code bug in this repo).
- `GET /admin/broadcast-provenance` — V1.8.6.4 (§20): the last N ACTUALLY-pushed LINE events' provenance (source/type/road/direction/KM/location/classificationEvidence/eligibilityReason/formattedOutput), 48h TTL. **Answers "為什麼剛才這則長這樣" without re-querying TDX/PBS.** `?limit=`/`?source=`/`?road=`/`?rawId=` optional. The one path in this section that also explicitly answers 405 for any non-GET method (every other path here just 404s on a wrong method, unchanged).

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

