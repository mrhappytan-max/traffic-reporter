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

---

## 20. V1.8.6.4 — 省道 LINE message clarity + provenance audit + broadcast provenance log

**Status: built and tested on `fix/v1.8.6.4-provincial-road-message-clarity`, NOT merged to `main`, NOT deployed.** Four parts, same branch: (1) a 省道 (any non-國1/國3 road, reported against 台3線) LINE message-clarity fix, (2) a follow-up root-cause **provenance audit** of that same fix, requested specifically to verify how much of the round's own reasoning was actually confirmed vs. assumed, (3) a **broadcast provenance log** (proposed by the audit, then built on explicit approval) so a FUTURE "why did that message look like that" question never needs a fresh TDX/PBS query to answer, (4) an **origin-metadata gap fix** for that same log — WHICH raw upstream field actually decided `type`/`locationDescription`/`displayKM`, not just the already-normalized result. Read the audit subsection BEFORE trusting any "TDX confirmed X field" claim elsewhere in this file for RoadEvent-family location fields.

### Origin metadata — closing the "which raw field decided this" gap

The broadcast provenance log (above) could already show `classificationEvidence: ["normalizedType=construction", ...]` and `locationDescription: "關西－橫山路段"` — but not WHICH raw field produced them (`EventType` vs. `EventSubType` vs. `Category` vs. a description-keyword fallback; `LocationDescription` vs. `Location.Description` vs. `RoadSection`). Fixed by capturing that provenance at the exact moment of the SAME existing decision — never a second classification pass, never a change to `type`/`locationDescription`/`displayKM`'s own values.

- **`tdx/normalize.js`**: `mapRoadEventType(raw, description)` now returns `{type, classificationSource: {field, value, fallback}}` — `field` is `'EventType'`/`'EventSubType'`/`'Category'`/`'Description'` (whichever candidate actually decided the result, checked in the SAME existing order), `value` is that field's own text (truncated to 80 chars), `fallback:true` only on the final description-keyword branch (marks "nothing structured matched, this is our own keyword guess" even when the guess still lands on 'other'). `normalizeRoadEvent`'s location-description extraction is now a manual loop (was `firstDefined`) over the same 4 candidate fields, so it can capture `locationSource: {field, value}` for whichever one actually won — `null`/omitted when none are present (never fabricated). Both attach to a new `event.provenance = {classificationSource, locationSource?}` — debug-only, always present (classificationSource is never null for TDX), never read by anything except `broadcastProvenance.js`.
- **`pbs/classify.js`**: `classifyPbsEvent` now also returns `classificationSource: {field, value}|null` — `field` is `'roadtype'`/`'comment'`/`'roadtype+comment'` (tested by re-applying the SAME already-matched pattern against each field individually, purely for provenance — not a second decision), `value` is the matched substring itself (e.g. `"事故"`), never the full comment. `null` only when nothing matched at all (the final 'other'/'other' fallback) — 2 pre-existing tests (`test/pbsClassify.test.js`) updated from `deepEqual` against the OLD 2-field return shape to explicit field-by-field assertions, since the new 3rd field is additive but breaks strict deep-equality.
- **`pbs/normalize.js`**: `extractDisplayKmFromText` is now a thin wrapper around a new `extractDisplayKmMatch`, which returns `{value, matchedText}` — single source of truth, no duplicated regex logic. `normalizePbsEvent` attaches `event.provenance = {classificationSource, locationSource?, displayKMSource?}` — `locationSource` is always `{field:'areaNm', value}` when `raw.areaNm` is present (PBS has only the one location field, no "which one won" ambiguity like TDX), `displayKMSource` is `{field:'comment', value:matchedText}` when a KM was actually parsed — again, only the matched substring, never the full comment text.
- **`traffic/broadcastProvenance.js`**: `buildProvenanceRecord` gained `classificationSource`/`locationSource`/`displayKMSource` top-level fields, copied straight from `event.provenance` through a small `sanitizeSourceInfo` re-validation/re-truncation pass (belt-and-suspenders, never a second source of truth). `GET /admin/broadcast-provenance` can now answer, for a real 台3 construction event: `source=highway, classificationSource.field=EventSubType, classificationSource.value=道路施工, locationSource.field=LocationDescription, locationSource.value=關西－橫山路段` — not just the already-normalized result.
- **Confidence levels unchanged** — the location candidate field names (`LocationDescription`/`Location.Description`/`RoadSection`/`Location.RoadSection`) are still exactly as UNVERIFIED as documented in the provenance-audit subsection above; this round only records WHICH one fired when a real raw event happens to populate one, never upgrades any of them to "confirmed."
- **Verified untouched**: `event.type`/`formatEventMessage`'s output/`computeNotificationFingerprint`/`getBroadcastEligibility` are all byte-for-byte identical with or without `event.provenance` present (`test/broadcastProvenanceOrigin.test.js` tests 11-14 assert this directly) — `provenance` is a pure debug-only sibling field, read by nothing in the real broadcast path.
- **Tests**: `test/broadcastProvenanceOrigin.test.js` (new, 16 tests) — TDX EventType/EventSubType/Category/description-fallback provenance, TDX LocationDescription/Location.Description provenance and the no-human-location-at-all case (never fabricated), PBS classification/areaNm/displayKM provenance, `event.type`/`formattedOutput`/fingerprint/eligibility all unchanged with `provenance` present, an end-to-end `runLineBroadcast` run with full origin metadata making exactly 1 network call (the real LINE push — 0 extra TDX/PBS calls), and a provenance-KV-failure isolation re-check now that records carry the extra fields. Plus `test/pbsClassify.test.js`'s 2 updated assertions, and the full existing regression set (253 targeted+regression tests across this and prior V1.8.6.4 rounds) re-verified unaffected.

### The message-clarity fix itself

`src/tdx/normalize.js`'s `normalizeRoadEvent` now attaches an optional `event.locationDescription` — raw human-oriented location/section text from the raw record, preserved even when structured `startKM`/`endKM` is ALSO present (previously, `composeLocation()` unconditionally built `location` from road+direction+KM the instant KM existed, silently shadowing any such text before it ever reached the formatter — a genuine, confirmed structural bug, see the code's own comment for the exact mechanism). `src/traffic/messageFormat.js` now prefers that source text (filtered to reject anything that's just another KM string in disguise) over `getRoadSectionLabel()`'s curated anchor label — which still covers ONLY 國1/國3, unchanged; no fabricated anchor table was added for 台1/台3/etc, since this repo has no independently-confirmed KM-anchor data for them. Also added: a display-only `'other'`-type anomaly re-classification (積水/落石/坍方/樹倒/電線倒塌/掉落物/火災/橋梁異常/道路中斷, plus PBS's own structured `pbsCategory`) so a legitimately-eligible anomaly shows its real reason instead of a generic "路況異常"; and direction-aware impact wording for `direction==='雙向'` events, scoped to each event's own type (a 雙向 construction event reads "雙向施工管制", never "雙向封閉" — only `type==='closure'` ever says 封閉). None of this touches `event.type`, dedupe/fingerprint semantics (`notified.js` still reads the unchanged `location` field), or broadcast eligibility. See `test/provincialRoadMessageClarity.test.js` (18 tests) for the full regression coverage, plus 2 pre-existing `test/broadcastEligibility.test.js` assertions updated to match the new (intended) 淹水/落石 headline text.

### Provenance audit — what could and could not be confirmed

**The request:** verify, for the specific real-world 台3線 event that prompted this round, whether it genuinely had a human location field that got shadowed, and whether the upstream source actually provided richer type/impact information than what reached LINE — rather than assuming the fix's own narrative was correct.

**Finding: the actual historical raw event cannot be recovered from this environment, full stop.** Checked, in order:
1. This repo's own git history — no committed raw payload, log, or snapshot of any specific past production event exists anywhere in `traffic-reporter`.
2. Cloudflare credentials — **none available in this dev sandbox.** `npx wrangler whoami` returns "You are not authenticated"; no `CLOUDFLARE_*`/`CF_API_*`/`WRANGLER_*` environment variables are set. This matches this file's own long-standing §11 statement ("a normal dev sandbox... typically has no Cloudflare credentials anyway") — not a new limitation, just now explicitly re-verified for this specific ask.
3. This project's own KV design (§7) has **no** key that would retroactively preserve a specific historical broadcast event's raw content — `traffic:dedupe-state`/`pbs:lifecycle-state`/`line:notified-state` all track CURRENT dedupe/lifecycle/cooldown state, overwritten on every tick, never a historical log; `health:snapshot:v1`/`tdx:usage:summary:v1` are aggregate/rollup data, not per-event; nothing resembling a per-event provenance log existed before this round (see the proposed one below).
4. The user's own original bug-report message (start of this round's prior turn) described the PROBLEM PATTERN with illustrative example templates ("台3 雙向\n78K+500\n請留意路況" etc.) — it was never a verbatim copy of the actual raw LINE text or TDX/PBS response, so it cannot serve as raw evidence either.

**Conclusion: cannot prove 100% source/raw-content for the historical event.** Not source (TDX highway vs. PBS), not which raw fields were actually populated, not which EventType/EventSubType/Category/roadtype/comment value the upstream actually sent. This is stated plainly rather than "assumed confirmed" — see the correction below for where the round's own prior commit (`62367cca`, before this audit) overstated confidence on exactly this point.

**What IS confirmed vs. what is still only inferred, precisely:**
- **Confirmed** (by reading code, independent of any specific event): `composeLocation()`'s shadowing behavior is a real, reproducible structural bug — ANY RoadEvent record with both structured KM AND a populated `LocationDescription`/`Location.Description`/`RoadSection`-shaped field would have had that text discarded before V1.8.6.4. This is provable from the code alone; no live TDX call needed.
- **Confirmed** (by reading `messageFormat.js`'s pre-V1.8.6.4 code): a legitimately-eligible `'other'` anomaly always rendered the same generic "路況異常" regardless of which keyword made it eligible — also a pure code-reading fact.
- **NOT confirmed**: whether the ACTUAL reported 台3線 event's raw TDX (or PBS) response contained a populated `LocationDescription`/`Location.Description`/`RoadSection`/equivalent field that got shadowed. It is plausible (that's why the fix targets this exact mechanism) but not proven.
- **NOT confirmed, and previously overstated**: `LocationDescription`/`Location.Description` themselves being genuine, present-on-real-responses TDX RoadEvent fields. Traced via `git log -- src/tdx/normalize.js`: these are the **original, unverified V1.1 guessed field names** (commit `518d348`). The later correction commit `ebff9ffe` ("fix: correct TDX schema mapping against verified real responses," which DID confirm `title`/`road`/`direction`/`startKM`/`endKM`/`startTime`/`updatedAt`/`blockedLanes` against a real `/debug/tdx` response) explicitly did **not** touch or re-verify `LocationDescription`/`Location.Description`/`LocationMile` — its own diff shows them carried forward unchanged, merely demoted from the primary `location` source to a fallback-only role. They may or may not exist on a real RoadEvent response; no round since V1.1 has confirmed either way.
- **NOT confirmed**: `RoadSection`/`Location.RoadSection` on RoadEvent at all. Confirmed to exist only on TDX's separate CCTV metadata dataset (`Road/Traffic/CCTV/Freeway`, see `tdx/hsinchuCctvProbe.js`'s `isServiceAreaCctv`) — added to `normalizeRoadEvent`'s candidate list purely as a cross-dataset guess, on the unconfirmed assumption TDX's highway-family datasets share naming conventions.

**Correction applied to `62367cca`** (this round's own follow-up commit, "V1.8.6.4 provenance-audit correction," comment-only, zero behavior change): that commit's own comments read as if the historical 台3 event definitely had a genuine TDX-supplied human location field, and as if `LocationDescription`/`Location.Description` were established/confirmed RoadEvent fields on the same footing as `road`/`direction`/`startKM`/`endKM`. Both overstate what's actually known. Rewrote the comments in `tdx/normalize.js` and `traffic/messageFormat.js` to state plainly: (a) the shadowing bug is a confirmed CODE fact, independent of any one event; (b) whether it fired on the specific reported event is unconfirmed; (c) each candidate field's own confidence level, spelled out individually, so a future reader never mistakes "kept as a defensive fallback candidate" for "verified real-response field." **The code's actual runtime behavior was already fully correct and defensive before this correction** — `locationDescription` was always optional (`firstDefined(...) → ''` → conditionally spread only if non-empty), never assumed present, never fabricated. This was a documentation-precision fix only, not a functional bug fix. `62367cca`'s underlying logic remains recommended to keep — see the recommendation below.

### Broadcast provenance log — IMPLEMENTED (built on a follow-up round, same `fix/v1.8.6.4-provincial-road-message-clarity` branch)

Originally proposed-but-not-built by the provenance audit above; the design below was then implemented exactly as specced, on explicit approval. Answers "為什麼剛才這則長這樣" for a REAL, actually-sent event, entirely from a short-TTL, Admin-only KV log — never needing to re-query TDX/PBS.

- **New module**: `src/traffic/broadcastProvenance.js` — `buildProvenanceRecord` (pure), `recordBroadcastProvenance` (best-effort write), `listBroadcastProvenance` (bounded, filterable read), `describeClassificationEvidence`, `handleBroadcastProvenance` (the admin HTTP handler). See that module's own comment for the full boundary list.
- **KV key shape**, modeled directly on `tdx/usageLedger.js`'s already-proven-safe append-only pattern (§18): `debug:broadcast-provenance:v1:<date>:<epochMs>:<opaqueId>`. **Written ONLY when `successfulTargets.length > 0`** — i.e. an event that was ACTUALLY pushed to at least one LINE target this run, never an eligible-but-unsent, deduped, or 0-subscriber event (see `broadcastPipeline.js`'s `runLineBroadcast`, right after the existing `persistNotifiedState` call, inside that same `if` block). TTL = `PROVENANCE_TTL_SECONDS` = 48 hours (within the requested 24–72h range).
- **Record contents** — every field already existed on the normalized event or was already computed earlier in the SAME pipeline run: `timestamp, source, rawId, type, title, descriptionSummary (truncated to 80 chars), road, direction, startKM, endKM, displayKM, location, locationDescription, pbsCategory, classificationEvidence, eligibilityReason, formattedOutput (the EXACT LINE text sent), imageAttached, imageUrlPresent, imageExpiresAt`. `classificationEvidence` (`describeClassificationEvidence`) is a short human-readable string array (e.g. `["normalizedType=construction", "eligibilityReason=construction-impact-keyword"]`) built ENTIRELY from values already decided elsewhere — `eligibilityReason` is the exact string `getBroadcastEligibility(event)` already returned earlier in the same run (captured once into `eligibilityReasonByEvent`, a `Map` keyed by event object identity, never re-invoked), and `anomalyDetail` reuses `messageFormat.js`'s own exported `resolveOtherAnomalyDetail(event)` — the SAME rule the LINE message itself was rendered from, never a second/parallel classification pass. `imageExpiresAt` reuses `cctv/publishedImage.js`'s existing `PUBLISHED_IMAGE_TTL_SECONDS` (900s) constant when an image was attached — not a new/guessed number. Excludes, always: any Secret/token/Authorization header, LINE userId/groupId/target kind, and the full raw TDX/PBS JSON response.
- **Write isolation**: `recordBroadcastProvenance` never throws — any failure (missing KV, KV outage, serialize error) degrades to `{committed:false}`, exactly like `tdx/usageLedger.js`'s `commitTdxUsageBatch`. `test/broadcastProvenance.test.js`'s test 5 proves a provenance-only KV outage (put throws ONLY for `debug:broadcast-provenance:v1:*` keys) never affects the real push result or `notified-state` write, and the next run's dedup still works normally.
- **Read endpoint**: `GET /admin/broadcast-provenance` (`src/index.js`) — Admin-Basic-Auth-gated same as every other admin path, AND (a first for this project) explicitly answers **405** for any non-GET method (auth-checked first, so a wrong method never bypasses Admin Auth to even learn the route exists) — every other admin path in `ADMIN_PATHS` still just falls through to the generic 404 for a wrong method, unchanged; this one path alone got the special-cased 405 handling per this round's explicit requirement. `?limit=` (default 20, max 100, clamped), `?source=`/`?road=`/`?rawId=` optional filters. Zero TDX/PBS/LINE calls — pure bounded KV `list()`+`get()` (capped at `MAX_ENTRIES_SCANNED`=300 raw keys per request, same "bounded/cheap" principle as `usageLedger.js`'s compaction scans). `Cache-Control: no-store, private` via the existing `applyAdminSecurityHeaders` wrapper, same as every other admin response.
- **Explicitly untouched, verified by tests**: `event.type`, broadcast eligibility (the write happens strictly AFTER the decision, from a captured value, never feeds back into it), `notified.js`'s fingerprint (separate KV namespace, `computeNotificationFingerprint` untouched), Cron/TDX/PBS cadence, CCTV pipeline/metadata cache/R2, TDX usage ledger/quota dashboard.

**Tests**: `test/broadcastProvenance.test.js` (24 tests) — pure record-building, TTL/isolation/append-only-uniqueness at the `recordBroadcastProvenance` level, write-timing through `runLineBroadcast` (success/all-fail/no-subscriber/deduped-second-run/KV-outage-isolation), content-safety (no LINE target/user/group id, no Secret/token), TDX vs. PBS field coverage, `formattedOutput` exactly matching the real pushed text, `listBroadcastProvenance` filtering/bounding, and the admin endpoint's 401/200/405/0-network-calls behavior via the real `src/index.js` Worker entry point (same convention as `test/adminAuth.test.js`). Plus the full existing `broadcastPipeline`/`broadcastCctvIntegration`/`broadcastEligibility`/`notified`/`broadcastRules`/`messageFormat`/`provincialRoadMessageClarity`/`adminAuth` suites (168 tests total across this targeted run) re-verified unaffected.

---

## 21. V1.8.6.5 — KM Location Resolver (公里數 → 司機看得懂的位置 + 地圖)

**Status: merged to `main` (`ee0d159`), Production live.** Turns a raw event's KM value into a driver-readable official location — 省道: `縣市/鄉鎮/村里`; 國道: 前後交流道／服務區組成的路段名 — plus a coordinate and a Google Maps link, entirely from official government open data imported and compiled OFFLINE. Zero runtime network calls anywhere in this feature: no TDX/PBS/Google API lookups, ever. Display/provenance-only — see "What this round deliberately never touches" below.

### Architecture

Three layers, each independently testable:

1. **Raw data** (`data/road-location/raw/`) — the official files themselves (or a normalized reduction of them), never bundled into the Worker.
2. **Importer** (`scripts/updateRoadLocationData.mjs`, run via `npm run update:road-location-data`) — validates/normalizes/compacts raw → the 3 generated files. Deterministic, fail-loud on any schema mismatch (never silently drops a bad row), atomic replace (temp file + rename; a failed run never leaves a previously-good generated file half-written).
3. **Generated data** (`data/road-location/generated/{provincial,freeway,freewayFacilities}.js`) — the ONLY thing the Worker actually bundles/reads at runtime. Plain `export default {metadata, points|facilities}` modules, each carrying `sourceName`/`sourceUrl`/`sourceAgency`/`fetchedAt`/`datasetUpdatedAt`/`recordCount`/`sha256`.

`src/traffic/kmLocationResolver.js` exports `resolveKmLocation({road, direction, startKM, endKM, displayKM}, {datasetOverride}?)` — reads only the 3 generated files (0 I/O), never throws, and is called from exactly two places: `messageFormat.js` (to build the display label + map line) and `broadcastProvenance.js` (to build the debug-only `kmLocationResolution` evidence field) — same "call the pure function twice, once per consumer" pattern already established by `resolveOtherAnomalyDetail` (§20). `src/traffic/roadIdentity.js` provides `canonicalFreewayRoad`/`canonicalProvincialRoad` — data-driven (regex + Chinese-numeral conversion + a small nickname-alias table), not a hardcoded per-route special case; used by BOTH the importer (to normalize raw road names) and the resolver (to normalize an incoming event's road), so the two can never drift apart.

### Official dataset sources

| Dataset | Agency | Portal | What it gives |
|---|---|---|---|
| 7040 「省道里程坐標(里程牌標誌)」 | 交通部公路局 | data.gov.tw/dataset/7040 | Every provincial-road milepost sign: route, chainage, county/township/village, WGS84 |
| 95016 「國道百公尺里程樁」 | 交通部高速公路局 | data.gov.tw/dataset/95016 | Every 100m freeway marker: route, chainage, WGS84 (KML) |
| 166496 | 交通部高速公路局 | data.gov.tw/dataset/166496 | Freeway interchange (交流道) name + chainage, per route |
| 8161 「國道服務區簡介一覽表」 | 交通部高速公路局 | data.gov.tw/dataset/8161 | Freeway service area (服務區) name + chainage |

This dev sandbox has no outbound network access to any of these hosts (confirmed exhaustively, see the git history of `feature/v1.8.6.5-km-location-resolver`) — the raw files were downloaded by the project owner on a machine with real access and committed directly: `data/road-location/raw/provincial/provincial.csv` (dataset 7040, verbatim) and `data/road-location/archive/raw_official_sources.zip` (datasets 95016/166496/8161's raw materials — KML, CP950-encoded CSV, UTF-8 CSV, plus HTML mileage tables from freeway.gov.tw that were archived but NOT parsed this round). `data/road-location/archive/README_RAW_CONTRACT.md` and `VERIFY.json` document exactly what was collected, from where, with SHA-256s and QA notes (e.g. "chainage is as-installed, not idealised — a 9K sign is often 9K+015/9K+022 in practice").

### Importer / update flow

Two scripts, different jobs:

- **`scripts/prepareFreewayRawFromArchive.py`** (Python, not Node — deliberately: the archive's nested KML zip has CP950-encoded filenames under the legacy CP437 flag, and the 166496 CSVs are themselves CP950-encoded; Python's stdlib handles both cleanly). Reads `data/road-location/archive/raw_official_sources.zip`, writes `data/road-location/raw/freeway/{milestones,facilities}/*.csv` in this project's own simple CSV contract (`路線名稱,百公尺樁號KM,WGS84_E,WGS84_N` / `路線名稱,里程KM,名稱,類型`). Excludes 台26 (a provincial-road identity, out of freeway scope) and 南港聯絡道 (no numeral form to canonicalize) — logged, not silently dropped. Re-run this whenever the archive is refreshed.
- **`scripts/updateRoadLocationData.mjs`** (Node, `npm run update:road-location-data`) — the ONE deterministic importer that produces `data/road-location/generated/*.js`. `buildProvincial()` reads the REAL data.gov.tw 7040 column schema directly (`route_raw`/`km_m`/`lon_wgs84`/`lat_wgs84`/`county`/`township`/`village`/`install_position`) — an earlier, pre-real-data GUESSED contract (公路編號/樁號KM/設置位置) never matched the actual government file and was replaced once real data landed (see `data/road-location/raw/README.md` for the full current contract). Left/right sign pairs ~1m apart at the same physical marker are deduplicated (10m bucketing, prefers a 中央 sign) — 30,079 raw rows → 22,563 compact points. A `village` value containing a literal `"?"` (~150/30,079 rows — a confirmed source-side cp950→UTF-8 encoding artifact) is dropped, never guessed; falls back to county+township only.

Run it any time the raw files change: `npm run update:road-location-data`. It fails loudly (non-zero exit, no file touched) on a missing required column or an unparsable value — never silently produces a partial/wrong dataset that could be mistaken for a verified one.

### Generated data paths (what the Worker actually bundles)

```
data/road-location/generated/provincial.js        — 22,563 points
data/road-location/generated/freeway.js            — 10,035 points (100m milestones)
data/road-location/generated/freewayFacilities.js  — 227 facilities (207 IC + 20 SA)
```

### Resolver priority (`kmLocationResolver.js`)

Target-KM selection: structured `startKM`+`endKM` midpoint > a single structured end > `event.displayKM` (PBS-only, lowest priority — see "PBS displayKM" below). Then: `canonicalFreewayRoad` tried first (freeway dataset), else `canonicalProvincialRoad` (provincial dataset); a road neither canonicalizer recognizes fails closed with `reason:'unknown-road'`. Provincial: nearest point within `PROVINCIAL_TOLERANCE_KM` (0.6km); label = the point's own free-text `設置位置` if present, else composed `county+township+village`. Freeway: nearest 100m milestone within `FREEWAY_MILESTONE_TOLERANCE_KM` (0.15km) for the coordinate; nearest bracketing facilities (within `FREEWAY_FACILITY_MAX_GAP_KM`=60km) for the label, direction-aware ordering (南/東=ascending KM, 北/西=descending, unknown=neutral ascending — never guessed).

`messageFormat.js`'s label priority (full order, tier 2 is this round's addition): **1.** `event.locationDescription` (source's own human text, V1.8.6.4) **2.** `resolveKmLocation()`'s official label (this round) **3.** `getRoadSectionLabel()`'s old curated 國1/國3-only anchor table (pre-V1.8.6.4) **4.** raw KM (unchanged, its own line) **5.** nothing. A `📍 地圖 <url>` line is added independently whenever the resolver produced a coordinate, regardless of which tier won the label — the map is a separate concern from the label text, never a duplicate. Several pre-existing tests (`messageFormat.test.js`, `provincialRoadMessageClarity.test.js`) were updated where tier 2 now legitimately outranks tier 3 for roads/KMs the real dataset covers — the label text changed (e.g. old hand-typed "竹北－湖口" → official "竹北交流道－湖口服務區"), but every invariant those tests actually protect (KM always shown, a route-name-shaped `location` string never used as a label, a KM-shaped `LocationDescription` never used as a label) still holds and is still asserted.

### Fail-closed logic

`resolveKmLocation` wraps its entire body in try/catch and NEVER throws — every failure mode (unrecognized road, no dataset coverage for that road, nearest point outside tolerance, malformed input) converts to `{resolved:false, reason:'...'}`. A caller never needs its own try/catch. When `resolved` is false, `messageFormat.js`/`broadcastProvenance.js` fall back to exactly the V1.8.6.4 behavior — never a guess, never a blocked Cron tick. Verified directly: `test/kmLocationResolver.test.js` test 16 confirms a road genuinely outside the real dataset's coverage (`台99`, not a real route) still resolves `{resolved:false, reason:'no-data'}` against the REAL bundled data, not a mock.

### PBS `displayKM` does NOT gain CCTV authority

Unchanged from V1.8.5.1/V1.8.6.4 and still true after this round: `cctv/dynamicCollage.js`'s `eventTargetKm()` reads ONLY `startKM`/`endKM`, never `displayKM` — a PBS event can never become CCTV-eligible just because its free-text comment happened to mention a kilometer, and this round adds nothing that changes that. `resolveKmLocation` DOES accept `displayKM` as its own lowest-priority KM-selection input (so a PBS-sourced event can still get a resolved DISPLAY label/map line when it has no structured KM at all) — but this is purely a display/provenance decision inside `kmLocationResolver.js` itself; it never writes back to `event.startKM`/`event.endKM`, never touches `resolveCctvEligibility`, and CCTV eligibility's own KM-reliability boundary is completely untouched.

### fingerprint / eligibility / suppression — unaffected, by construction

`kmLocationResolver.js` is imported by exactly two files (`messageFormat.js`, `broadcastProvenance.js`) — neither `notified.js` (fingerprint), `incidentSuppression.js` (suppression), nor `broadcastRules.js` (eligibility) imports it or anything derived from it. `computeNotificationFingerprint`/`getBroadcastEligibility`/`resolveIncidentNotifications` all still read only `event.startKM`/`endKM`/`type`/`road`/`direction`/etc. exactly as before this round. This is a strict, verifiable display/provenance-only boundary, not just a convention.

### What this round deliberately never touches

TDX/PBS fetch cadence, Cron, TDX usage budget, subscriptions, notified-state semantics, accident/incident suppression semantics, CCTV eligibility/metadata-fetch policy/matching, R2 image policy, Shared Feed architecture, the 雙鐵 repos. Notification fingerprint / incident-suppression key / dedupe identity are all still computed exactly as before — this feature is strictly display/provenance enrichment layered on top.

### Bundle size — now a real, growing number to watch

Pre-real-data (scaffold only): 850.57 KiB / gzip 227.39 KiB. With the real dataset above bundled in: **7549.90 KiB / gzip 718.25 KiB** (`npx wrangler deploy --dry-run`). `provincial.js` alone is ~4.9MB uncompressed. Still comfortably within Cloudflare Workers' published script-size limits, but this is the real number the original spec's "storage decision made only after real measurement" was waiting for — re-measure whenever more official data is imported (more freeway routes, or the not-yet-parsed freeway.gov.tw cnid=1906 tables), and reconsider bundle-vs-KV if it keeps climbing. See `ENGINEERING_STATUS.md`'s "Watch items" for the standing reminder.

### Tests

`test/roadIdentity.test.js`, `test/kmLocationResolver.test.js` (incl. the two REQUIRED real acceptance resolutions, tests 17/18, run against the actual imported data — not a fixture), `test/kmLocationMessageIntegration.test.js`, `test/broadcastProvenanceKmLocation.test.js`, `test/updateRoadLocationData.test.js` (the importer's own `parseCsv` in isolation). Full suite: 819 tests, 816 pass, 3 fail — the same 3 pre-existing, unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `healthQuotaDashboard.test.js`).

V1.8.6.5 map URL 改為 maps.google.com/?q=lat,lng，座標 5 位小數；仍為純 URL、0 Google API calls。

## 22. Production branch split, discovery + repair — `integration/v57.2-v1.8.6.5-production`

**Status: branch merged, tested, committed, NOT deployed, NOT merged to `main`.** See `ENGINEERING_STATUS.md`'s branch-split section for the current-state summary; this section is the round-by-round detail.

### Root cause

Cloudflare's Worker was actually deploying from `claude/v57.2-tdx-gated-freeway-broadcast` (`9c0de1d`), not `main` — a lineage branch created for the V57 Shared Traffic Feed work that was never merged back. `main` kept moving independently (V1.8.6.4 provenance log, V1.8.6.5 KM Location Resolver — §20/§21 above), fully merged and documented as "Production live" in good faith, but never actually reaching users. Common ancestor `ba74d48`; `main` 10 commits ahead, the V57.2 branch 3 commits ahead. This is the actual mechanism behind the prior round's "main 已修好但 Production 看不到" symptom — not a caching issue, not a stale KV read, a genuinely different codebase running.

### Integration methodology

`integration/v57.2-v1.8.6.5-production` branched from latest `main`, then `git merge --no-ff origin/claude/v57.2-tdx-gated-freeway-broadcast` (a real 3-way merge — the histories had genuinely diverged, not a fast-forward relationship). Exactly 3 files conflicted:

- **`README.md`** — two independent additive doc sections (KM Location Resolver maintenance vs Shared Traffic Feed contract) inserted at the same point. Resolved by keeping both, back to back.
- **`src/index.js`** — dueling `import` lines only (`handleBroadcastProvenance` vs `handleSharedFeed`). Everything else in the file — route dispatch, `ADMIN_PATHS`, the `/admin/broadcast-provenance` 405 pre-check, the `/internal/shared-feed` route registration — had already merged cleanly with zero conflict markers.
- **`src/traffic/broadcastPipeline.js`** — dueling module-header comments and dueling imports only. Every function BODY (provenance recording, `kmLocationResolution`, `completedProducts`, `feedOnlyProducts`, `topUpSharedFeedCctvImages`) merged with zero conflict — main's V1.8.6.4/5 edits and V57's V57/V57.1/V57.2 edits landed in non-overlapping regions of the same functions, so git's 3-way merge spliced both feature sets into one coherent function body on its own.

Every other touched file (`src/pbs/roadName.js`, `src/pbs/crossSourceDedup.js`, `src/pbs/pipeline.js`, `src/pbs/debugPbs.js`, `test/pbsCrossSourceDedup.test.js`, `test/pbsOnlyCrossSourceDedup.test.js`, `test/tdxUsageReduction.test.js`) auto-merged with no conflict at all — the V57.2 branch never touched `src/pbs/normalize.js`/`src/pbs/classify.js`/`src/tdx/normalize.js`/`src/traffic/messageFormat.js` after the common ancestor, so main's V1.8.6.4/5 versions of those files carried through untouched.

No `ours`/`theirs` resolution was used anywhere — every conflict was resolved by reading both sides' actual content and keeping both.

### V1.8.6.6 — verified still needed, not assumed

`fix/v1.8.6.6-anomaly-classification-audit` (`d0012e1`) was NOT part of either `main` or the V57.2 lineage. Rather than merging it in on the assumption it was still required, it was verified empirically first: without it, a raw TDX record shaped like the real Fixture B incident (`EventType:'事故'`, `EventSubType:'其他異常告警－行人誤闖'`) still classifies as `accident` in the merged main+V57.2 code, because `mapRoadEventType()` stops at the first field matching the broad "事故" bucket, never re-checking a more specific field's non-collision-hazard signal. Confirmed genuinely still needed, then cherry-picked cleanly (0 conflicts against the integration branch — `d0012e1`'s own diff against `main` touches only `src/pbs/classify.js`, `src/pbs/normalize.js`, `src/tdx/normalize.js`, `src/traffic/anomalyClassification.js` (new), `src/traffic/broadcastRules.js`, `src/traffic/messageFormat.js`, and its own test file — none of which the V57.2 merge had touched).

### Regression fixtures — two real, named Production events

`test/productionIntegrationFixtures.test.js`, run through the real normalize/classify code and the real broadcast pipeline (`runLineBroadcast` + `runSharedFeedPersist`), with the real `@jsquash` JPEG codec for CCTV compose (not mocked away):

- **Fixture A** (rawId `A15040100H-01-20260820201348494100020`, 國1 北向 93K+500, genuine accident) — confirms type/direction/KM fidelity, the KM Location Resolver + short Google Maps URL are genuinely active in the merged broadcaster path, CCTV attaches, and the Shared Feed ends up carrying the exact same `imageUrl`/`imageExpiresAt` the LINE push carried (never `null` when R2 publish actually succeeded).
- **Fixture B** (rawId `A15040100H-01-20260820200616953100035`, 國1 南向 92K+800, "其他異常告警－行人誤闖") — confirms `type:'other'` (not `accident`), no "交通事故"/"事故影響通行" text, CCTV correctly ineligible, and the absence of an image never blocks or alters the text broadcast.

### CCTV image → Shared Feed handoff — root cause and finding

Traced per the task's explicit instruction (R2 publish result forward only — camera/frame/collage/R2-publish steps were already proven working and were not re-investigated): `completedProduct` is a single object, mutated in place (`completedProduct.imageUrl = cctv.imageUrl`) after a successful CCTV attach, and the SAME reference already sits inside `result.completedProducts` (pushed before the pending-target check, per V57's own design). `buildSharedFeedEvents` (`sharedFeed.js`) correctly copies `product.imageUrl` into the persisted entry. **The merged pipeline is structurally correct for this case.** The real gap was in test coverage: `sharedFeedCctvTopUp.test.js`'s existing test 5a confirmed the main push path attaches an image to `completedProducts`, but nothing previously ran that specific product through `runSharedFeedPersist` to confirm the image survives into the actually-persisted KV blob — only the `pendingTargets===0` (suppressed) path had that end-to-end check (test 7). Fixture A now closes that gap and passes on this branch, so as of this integration the historical Production symptom ("R2 image created, Shared Feed shows `imageUrl: null`") does not reproduce for a genuinely-pushed accident.

### A second regression, found while building Fixture B

`effectiveWindow.js`'s `LIVE_TYPES` only ever included `'accident'`/`'congestion'` — every other type (including `'other'`) requires a parseable Chinese date-range in its description to become broadcast-relevant at all (a deliberate, already-tested design — see `broadcastEligibility.test.js` test 5, for a genuinely pre-announced `'other'` event like a flooding advisory with a schedule). But V1.8.6.6's override downgrades `type` from `'accident'` to `'other'` for a live pedestrian/animal-intrusion report — exactly as "right now" as the collision report it was reclassified from, with no schedule text at all. Without a fix, the reclassification would have gone from "broadcast with the wrong text" to "never broadcast at all" — strictly worse. Fixed narrowly in `effectiveWindow.js`: an event carrying `nonCollisionAnomalyDetail` (the exact marker the V1.8.6.6 override attaches) is now also treated as live, leaving every other `'other'` event's existing "needs a schedule" requirement untouched.

### Verified unbroken

PBS 國道 gating (V57.2's `filteredFreewayEvents`), TDX authority, cross-source dedupe, subscriptions, notified-state, incident suppression, the Shared Feed contract (`sharedFeed.test.js`, `sharedFeedCctvTopUp.test.js`, `v572TdxGatedFreewayBroadcast.test.js`, `pbsCrossSourceDedup.test.js`, `pbsOnlyCrossSourceDedup.test.js` — 98 tests, all pass on this branch), the V1.8.6.4 provenance log + `/admin/broadcast-provenance` (`broadcastProvenance*.test.js` — 127 tests combined with KM-resolver/classification/message-format suites, all pass), and `dryRun` producing 0 side effects (existing coverage in `broadcastPipeline.test.js`/`sharedFeed.test.js`, unchanged).

### Full suite

889 tests, 886 pass, 3 known pre-existing failures (unchanged from every prior round): 2× `pbs-relay/tests/*` (missing `pbs-relay/src/cache.js`), 1× wall-clock-dependent `healthQuotaDashboard.test.js` test 6.

### What this round deliberately did not do

No merge into `main`. No deploy. No change to which branch Cloudflare's Worker actually watches. See `ENGINEERING_STATUS.md`'s "Next (safe actions)" for the proposed permanent fix (reunify Production's deploy source with `main`) — that decision needs a human to actually act on, not something to do autonomously mid-integration.

**Update (next round):** the human reviewer approved this branch and fast-forwarded `main` onto it directly (`git merge --ff-only`) — see `ENGINEERING_STATUS.md`'s branch-split section, now marked RESOLVED. `main` HEAD as of that fast-forward: `8cd97c3e61ac2eace7db66634a398450adb17e4b`.

## 23. V1.8.6.7 — 24h Pipeline Trace + 人工查修頁

**Status: on branch `feature/v1.8.6.7-pipeline-trace-view`, branched from the post-reunification `main` (§22). NOT merged, NOT deployed.**

### Purpose

Turns "為什麼這筆事件的播報結果長這樣" into something a non-programmer administrator can answer by looking at a web page, for ANY event that entered this run's pipeline — not just ones that actually reached LINE. Answers, per event: 上游抓到什麼 → normalize/classify 成什麼 → eligibility/dedupe/suppression/gating 做了什麼 → KM/CCTV enrichment 結果 → 最後 LINE/Shared Feed 送了什麼 — and automatically highlights where those disagree (see "Anomaly detection" below), instead of requiring someone to manually diff 20+ fields per event.

### Relationship to `broadcastProvenance.js` (V1.8.6.4) — both kept, different scope

| | `broadcastProvenance.js` | `pipelineTrace.js` (this round) |
|---|---|---|
| Scope | Only events ACTUALLY pushed to ≥1 LINE target | EVERY event that entered the pipeline this run, including rejected/deduped/suppressed/gated ones |
| Question answered | "為什麼那則已送出的 LINE 訊息長這樣" | "這筆事件到底發生了什麼事，不管有沒有送出" |
| TTL | 48h | 24h (deliberately shorter — see "Performance" below) |
| Write trigger | Only inside the `successfulTargets.length > 0` branch | Every event's lifecycle end, success or not |

Neither module re-implements the other's classification/eligibility/KM-resolution logic — `pipelineTrace.js` literally imports and reuses `broadcastProvenance.js`'s `describeClassificationEvidence`, never a second copy of that rule.

### Architecture — accumulate in memory, finalize once per event

Per the task's own instruction ("每一筆事件只寫一次 KV，不要每個 stage 各寫一次"): `broadcastPipeline.js`'s `runLineBroadcast` keeps a `Map<event, partialTraceInput>` (`traceInputByEvent`), mutated as the event moves through eligibility → clustering/relevance → incident suppression → CCTV → the LINE push loop → the Shared-Feed-only top-up pass. A `finalizeTrace()` closure builds the final, immutable `buildTraceEntry(...)` records from whatever partial input each event accumulated, called right before every one of `runLineBroadcast`'s 4 return points (fail-closed, dryRun, outside-broadcast-hours, and the normal end) — so an event whose lifecycle ends early (ineligible, not relevant) still gets a complete, honest record from whatever it actually went through, never a crash or a missing entry.

Two categories of event never reach `runLineBroadcast`'s `allEvents` at all, and get their own standalone trace entries built directly in `scheduled.js`, from arrays `dedupe.js`/`crossSourceDedup.js` already computed: a TDX-level duplicate (`summary.duplicateEvents`) and an unmatched 國道 PBS event (V57.2's own gate — `pbsSummary.freewayGatedEvents`).

`sharedFeedPersisted`/`sharedFeedWithImage` can only be known AFTER Shared Feed persistence runs (a separate, later step in `scheduled.js`) — these two fields are patched onto the already-built trace entries by reading the ACTUAL persisted feed back (one extra `readSharedFeed` `get`, never a `list`) and matching by `eventKey`/`eventId`, right before the final `persistPipelineTraceEntries` write. This is deliberate: it catches a genuine disagreement between "did `runSharedFeedPersist` report `committed:true`" and "does this SPECIFIC event's image actually appear in the persisted blob" — exactly the class of bug (§20-era Shared-Feed-image-loss) this trace exists to make visible.

### Schema

```
eventKey, status  (line-sent | eligible-no-target | suppressed | not-relevant |
                    ineligible | duplicate | gated | merged | line-failed)
identity:   timestamp, source, rawId, road
upstream:   EventType, EventSubType, Category, descriptionSummary (≤120 chars),
            rawDirection, rawStartKM, rawEndKM, upstreamUpdatedAt
normalized: type, direction, startKM, endKM, displayKM, location,
            classificationSource, classificationEvidence
decision:   eligibility, eligibilityReason, dedupeResult, suppressionResult, gatingResult
enrichment: kmLocationResolution (sanitized, no raw coordinate/mapUrl — same
            view broadcastProvenance.js already uses), cctvEligible,
            cctvSkippedByReason, imagePrepared, imageUrlPresent, imageExpiresAt
delivery:   lineAttempted, lineSucceeded, formattedOutput,
            sharedFeedPersisted, sharedFeedWithImage
```

`upstream` is captured ONCE, at normalize time (`tdx/normalize.js`/`pbs/normalize.js`), as a debug-only `event.pipelineTraceUpstream` field — same never-read-by-the-real-pipeline boundary already established by `event.provenance` (§20). `EventType`/`EventSubType`/`Category` reuse the SAME field names for both TDX and PBS (PBS's `roadtype` maps onto `EventType`; PBS has no analogue for the other two, so they stay `null`) so the schema never forks by source.

### 0 additional upstream calls

Every field is copied from data the SAME pipeline run already computed. Two specific reuses worth naming: `resolveKmLocation()` and `resolveCctvEligibility()`'s outcomes were previously only captured (for provenance) inside the `successfulTargets.length > 0` branch — this round hoists those exact same calls (same inputs, same event, same pure/0-I/O functions) slightly earlier in the per-event loop so a NON-pushed event's trace also gets them, without adding a second call site anywhere or changing what the successful-push branch itself computes. No new classification pass, no new KM resolution call beyond that hoist, no new CCTV query — verified by the full existing test suite passing unmodified (the 889 pre-existing tests) plus a dedicated "0 additional TDX/PBS/CCTV/LINE calls" test (scenario 26).

### Anomaly detection (`buildTraceAnomalies`) — display-only, pure

Given a trace record, returns `{severity, code, message}[]`, purely for the trace-view page and the JSON endpoint — never read by, or capable of influencing, the real pipeline. Checks implemented: `DIRECTION_CHANGED` (upstream vs normalized direction disagree), `TYPE_SEMANTIC_MISMATCH` (upstream subtype text reads like a non-collision hazard — reusing the same keyword categories `anomalyClassification.js` already encodes — while normalized `type` is still `accident`; this is exactly the class of bug V1.8.6.6 fixed, now with an early-warning display for a future recurrence), `KM_CHANGED`, `MAP_MISSING` (KM resolved but the formatted text has no `maps.google.com` link), `IMAGE_EXPECTED_BUT_MISSING` (CCTV prepared an image but the actual LINE push doesn't carry one), `LINE_FAILED`, `SHARED_FEED_IMAGE_LOST` (LINE has the image, the persisted Shared Feed doesn't).

### The 查修頁 (`GET /admin/pipeline-trace-view`)

Server-rendered HTML, zero client-side JavaScript — the existing Admin CSP (`security/adminAuth.js`'s `applyAdminSecurityHeaders`) is `default-src 'none'` with no `script-src` exception, and this page has no reason to ask for one: `<details>/<summary>` gives expand/collapse for the per-event 3-section (上游資料/系統處理/最終結果) breakdown, and filters are a plain GET `<form>` that reloads the page with new query params. Reuses `health.js`'s established mobile-first CSS conventions (card layout, pill badges, `-apple-system`/`PingFang TC` font stack) for visual consistency across the project's admin pages. Status/CCTV/map badges use the task's own fixed emoji vocabulary (✅⚠️❌📷🚫🗺️) so every page a human looks at uses the same small, learnable set throughout.

### Performance / KV impact

Trace volume is every Hsinchu-filtered event this run touched (typically low tens per tick), a meaningfully higher write rate than `broadcastProvenance.js`'s "successful pushes only" scope — this is WHY the TTL is 24h, not 48h: total stored volume is bounded by `events/tick × ticks/day`, self-limiting regardless of how long any single real-world event stays active, rather than by an unbounded growing history. The write path (`persistPipelineTraceEntries`) only ever calls `put`, one per event, never `list` — the Cron hot path never does a bounded/unbounded scan. The two read endpoints (`/admin/pipeline-trace`, `/admin/pipeline-trace-view`) both cap the KV `list` scan at `MAX_ENTRIES_SCANNED=500` and the response at `MAX_LIST_LIMIT=100`, same bounded-scan pattern as `broadcastProvenance.js`. `GET /health` was verified (structurally, via a source-grep test, not just behaviorally) to import nothing from `pipelineTrace.js` at all — it still only ever reads the pre-computed health snapshot.

### Privacy boundary

Never stores: the full raw TDX/PBS JSON payload, a Secret, an `Authorization` header, a LINE userId/groupId/subscriber target, an access token, or an admin credential. `descriptionSummary` is capped at 120 characters (vs. provenance's 80 — this log intentionally keeps a little more upstream text since its whole purpose is upstream-vs-normalized comparison, but still a hard cap, never the full text). Verified by a dedicated privacy test scanning a real persisted record's serialized JSON for every one of those terms.

### Tests

`test/pipelineTrace.test.js` (pure schema/anomaly-detection/KV read-write/admin-JSON-endpoint/privacy/TTL coverage, 29 tests), `test/pipelineTraceIntegration.test.js` (end-to-end through the real `runLineBroadcast`/`runScheduledTdxSync` — successful push, eligibility reject, dedupe duplicate, incident suppression, V57.2 freeway gating, no-subscriber, CCTV not-eligible/no-camera/success, LINE failure, Shared-Feed-with-image round trip, trace-write-failure isolation, 0-extra-calls, 13 tests), `test/pipelineTraceView.test.js` (the HTML page: Admin Auth, 405, mobile-readable rendering, anomaly banner display, GET-query filtering, empty state, 6 tests). Full suite: 937 tests (889 pre-existing + 48 new), 934 pass, the same 3 pre-existing unrelated failures as every prior round.

### What this round deliberately did not do

No merge into `main`. No deploy. No change to which branch Cloudflare's Worker actually watches. No real TDX/PBS/CCTV probe, no real LINE push — every test uses mock KV/R2/fetch, same conventions as the rest of this test suite.

## 24. V1.8.6.8 — Driver-Relevant Event Broadcast Time Policy

**Status: on branch `feature/v1.8.6.8-broadcast-time-policy`, branched from `main` (§23). NOT merged, NOT deployed.**

### Product principle

The Worker only actively broadcasts events that could really affect a driver's route/lane/road-passability DURING the product's own active hours, Asia/Taipei 08:00–22:00. Outside that window, ordinary construction/closure/event notices are not pushed — a genuine accident's own real-time-relevance logic is untouched (see below).

### Root cause / what was actually wrong

Two separate, pre-existing bugs, both in the "announced" (schedule-text-parsed) event branch of `effectiveWindow.js`:

1. **Cross-midnight arithmetic bug** — `parseChineseDate.js`'s `parseChineseDateRange` computed a schedule's end hour on the SAME calendar day as its start hour, unconditionally. For an overnight range like "21時至6時" (21:00 to 6:00 the next morning), this put `effectiveEnd` 15 hours BEFORE `effectiveStart` — so the moment the event started, `isBroadcastRelevant` immediately read it as already "ended" (`endMs <= nowMs`), even though the event was genuinely active. A real overnight closure would never broadcast at all, at any hour.
2. **No support for a multi-day date range with a nightly-recurring window** at all — text like "8月20日至8月25日每日21時至翌日6時" simply didn't match the existing single-occurrence regex (no `每日` handling), so `parseChineseDateRange` returned `null` for it — same fail-closed outcome as bug 1 (never broadcasts), for a different reason.

Neither bug is specific to any one event/road — both are structural gaps in the ONE authoritative date-text parser every non-live event type (construction/closure/control/other) already goes through via `effectiveWindow.js`'s "announced" branch.

A third, separate issue (not a broadcast-decision bug, but a Pipeline Trace display bug): `pipelineTrace.js`'s `directionChanged` anomaly check compared upstream and normalized direction text with plain string equality, so "北上" (upstream) vs "北向" (normalized) — the SAME real-world direction, two different words for it — was wrongly flagged as `DIRECTION_CHANGED`.

### Authoritative time-policy implementation — where, precisely

No second time system was created. Two existing modules were extended, one new shared classifier was factored out of an existing function:

- **`effectiveWindow.js`** — `parseChineseDate.js`'s cross-midnight arithmetic is now general (`occurrenceForAnchorDay`: whenever the same-day interpretation of `endHour` would put `end <= start`, roll `end` to the next calendar day — this applies whether or not the text explicitly says "翌日"/"次日", since it's pure date arithmetic, not a keyword-triggered special case), and a new `RECURRING_PATTERN` regex + `resolveRecurringOccurrence()` resolve a `每日`-tagged, optionally multi-day-ranged schedule to the ONE concrete occurrence relevant to `now` on every call (never a cached/stateful recurring schedule — `computeEffectiveWindow` is already called fresh every Cron tick, so this "resolve fresh each time" design needed zero changes to that calling convention).
- **`effectiveWindow.js`** also gained `classifyEventTimeStatus(window, now)` — the SAME comparison `isBroadcastRelevant` already made (started? ended?), just exposing the answer as `'no-data'|'not-started'|'active'|'ended'` instead of collapsing it to one boolean. `broadcastRules.js`'s `isBroadcastRelevant` was refactored to call this directly (its own 60-minute-forecast leniency layered on top, unchanged) — one authoritative classifier, two callers (the real gate, and Pipeline Trace's display), never two independent comparisons that could drift.
- **`broadcastHours.js`**'s `isWithinBroadcastHours` (08:00–22:00 Asia/Taipei) is completely unchanged — it was ALREADY the single authoritative product-broadcast-window gate, applied uniformly before any push, for every event type, since V1.6.1. This round did not touch its logic at all, only made its result (`result.withinBroadcastHours`, already computed once per run) visible per-event in Pipeline Trace as `broadcastWindowActive`.

### 08:00–22:00 — confirmed already correctly enforced, not re-implemented

Verified (not assumed) that `broadcastPipeline.js`'s existing `if (!result.withinBroadcastHours) { ...; return result; }` gate already runs strictly before ANY push attempt, for every event type including accidents — this was already true before this round. What this round adds is `eventActive`/`eventTimeStatus`/`broadcastWindowActive` as explicit, separately-visible Pipeline Trace fields (see below), not a new gate.

### Scheduled event / cross-midnight handling

`resolveRecurringOccurrence` (in `parseChineseDate.js`) evaluates, for `referenceDate`, whichever of "yesterday's" or "today's" daily occurrence (each independently checked against an optional `[rangeStart, rangeEnd]` calendar-date bound) actually contains `now`; if none does, the nearest FUTURE occurrence (for `isBroadcastRelevant`'s 60-minute-forecast leniency to still work correctly on an announced multi-day schedule); if none of those either, the range's own boundary occurrence (so a fully-past or fully-future range still resolves to an honest `effectiveEnd<=now` "ended" or `effectiveStart>now` "not started", never null/guessed). A completely date-less `每日` schedule (no month/day at all) resolves the same way, indefinitely recurring relative to whatever `now` currently is.

### Event types this rule applies to

Every type effectiveWindow.js already routes through its "announced" (non-live) branch — construction/closure/control/other — governed by whether the source's OWN description text carries a parseable Chinese date/time range, never by an event-name keyword list. 施工/車道封閉/道路封閉/單向封閉/改道/活動封路/遶境/廟會/路跑/遊行/大型活動 etc. are all already covered by this same mechanism as soon as their description matches `SINGLE_RANGE_PATTERN` or `RECURRING_PATTERN` — no per-event-name hardcoding was added or is needed. `accident`/`congestion` (and any event with `nonCollisionAnomalyDetail`, per V1.8.6.6/V1.8.6.7) stay on the LIVE branch, completely untouched by any of this round's changes.

### Direction semantic fix

`directionEquivalence.js` (new, tiny module) holds the single project-wide direction-equivalence table (北上=北向, 南下=南向, 東行=東向, 西行=西向, 南行=南向, 北行=北向— moved out of `pbs/normalize.js`, which still re-exports `normalizePbsDirection` unchanged for every existing importer, purely to avoid a circular import: `pbs/normalize.js` already imports `buildUpstreamSnapshot` FROM `pipelineTrace.js`, so `pipelineTrace.js` importing `normalizePbsDirection` back from `pbs/normalize.js` would have cycled). `pipelineTrace.js`'s `directionChanged` anomaly check now normalizes BOTH sides through this same table before comparing — a genuine change (e.g. 北向→南向) still flags `DIRECTION_CHANGED`; a same-direction synonym pair never does. The event's own `normalized.direction` value itself was never touched — only the TRACE'S comparison logic changed, per the task's own explicit instruction.

### Pipeline Trace improvements

`decision` now carries `eventActive` (boolean), `eventTimeStatus` ('no-data'|'not-started'|'active'|'ended'), `eventWindow` (the raw `{effectiveStart, effectiveEnd, timeSource}` `computeEffectiveWindow()` produced this run, shown verbatim), and `broadcastWindowActive` (boolean) — four fields where there used to be one opaque `relevant:false`. `status` gained three new values replacing the old single `not-relevant` catch-all: `not-started`, `event-ended`, `outside-broadcast-window` — `not-relevant` is kept only as a defensive fallback for a caller that doesn't supply `eventTimeStatus`. The trace-view page (`pipelineTraceView.js`) shows all four decision fields explicitly in the per-event detail (section B), with a Taipei-local-time-formatted `事件有效時間` range, so an administrator can see exactly why an event didn't broadcast without reading code.

### What was deliberately NOT changed

The pre-existing 60-minute forecast leniency (`isBroadcastRelevant`'s "starts within 60 minutes" allowance, `broadcastPipeline.test.js`'s own "forecast event crossing into the 60-minute window" test) applies identically to every event type, unchanged — a construction event announced to start within the next hour still gets its existing "60分鐘路況預報" pre-announcement, exactly as it did before this round. This round's `eventActive` is a NEW diagnostic/display dimension, not a tightened broadcast gate — no existing test's push/no-push outcome changed.

### Verified unbroken

Genuine accident real-time broadcast (structured `startTime`, LIVE branch, completely untouched — scenario 12), V57.2 PBS-freeway-gating (`crossSourceDedup.js`, not modified this round at all — scenario 13), CCTV, KM Location Resolver/Google Maps URL, Shared Feed, and the full pre-existing 937-test suite from V1.8.6.7 — all re-run and pass unmodified.

### Tests

`test/parseChineseDate.test.js` (+7: cross-midnight single, marker-optional rollover, multi-day recurring middle/last day, past/future range boundaries, date-less recurring), `test/effectiveWindow.test.js` (+6: `classifyEventTimeStatus`'s 4 states, confirming it's distinct from `isBroadcastRelevant`'s forecast leniency), `test/broadcastTimePolicy.test.js` (new, 15 tests — the task's own full scenario list, end-to-end through `runLineBroadcast`), `test/pipelineTraceView.test.js` (+1: the view page shows all three distinct new statuses, never one generic label). Full suite: 965 tests, 962 pass, the same 3 pre-existing unrelated failures as every prior round.

### What this round deliberately did not do

No merge into `main`. No deploy. No change to which branch Cloudflare's Worker actually watches. No real TDX/PBS/CCTV probe, no real LINE push. No change to the 60-minute forecast feature, to `isWithinBroadcastHours`'s own logic, or to any event's actual `normalized.direction`/`type` value.

## 25. V1.8.6.9 — Mobile-first Deployment Guard

**Status: on branch `feature/v1.8.6.9-mobile-deployment-guard`, branched from the post-V1.8.6.8 `main` (`462e217`). NOT merged, NOT deployed.**

### Purpose

Collapses "手機下指令 → Claude Code → merge main → push main → Cloudflare Auto Deploy → 自動驗 Production commit → 自動驗 health/routes → 回報完成" into an actually-automatable chain that does not require a human (or a Claude session) to open the Cloudflare Dashboard for a normal deploy — only for a genuine Dashboard-only exception (see below).

### The one hard rule

**GitHub `main` is the sole canonical Production source.** No feature branch, no integration branch, and no deploy hook may ever be treated as Production's real deploy source — this is the exact class of bug §22 already root-caused and fixed once (a stray lineage branch silently becoming Production's real deploy source). `scripts/check-deployment-policy.mjs`'s `no-legacy-branch-reference` and `canonical-deploy-flow-statement` checks are a standing regression guard against it recurring, not just documentation.

### Deployment identity — how a Worker instance can know its own commit/branch with 0 runtime network calls

The Worker CANNOT call GitHub or the Cloudflare API at runtime to learn what it's running (forbidden by the task, and would add a real external dependency to every deploy). The only place this information can come from is the build itself:

- `scripts/generateBuildMetadata.mjs` — runs automatically before every `npm run deploy` (wired via package.json's `predeploy` lifecycle hook, which npm invokes automatically — no Cloudflare Dashboard build-command change needed, since this project's `deploy` script IS the entry point Cloudflare Workers Builds is expected to invoke). Prefers a small list of plausible CI-provided env vars for commit/branch (`WORKERS_CI_COMMIT_SHA`/`CF_PAGES_COMMIT_SHA`/`GITHUB_SHA`/`CI_COMMIT_SHA` and their branch equivalents — none independently confirmed to exist in Cloudflare Workers Builds' own environment, since this repo has no way to inspect a real build), falling back to local `git` commands (guaranteed available, since any git-based CI necessarily checks out the real repository to build it). Every field records not just its value but its SOURCE (`commitSource`/`branchSource`/`expectedMainCommitSource`) — an honest `'unknown'`/`'assumed-same-as-deployed'` when neither an env var nor git resolved something, never a guess presented as fact.
- `src/generated/buildMetadata.js` — the generated output, a plain `export const BUILD_METADATA = {...}` object bundled straight into the Worker by wrangler. Checked into git as a PLACEHOLDER (`'not-yet-generated'` for every source field) purely so local dev/`node --test` always has something real to import — a real deploy always overwrites this file, in place, before wrangler ever bundles it.
- `src/version.js` — `APP_VERSION`/`SCHEMA_VERSION`, deliberately NOT build-time-injected: a human-controlled semantic marker (`'V1.8.6.9'`), bumped once per round like this project's own commit-message convention, separate from the git commit which changes every commit.

### The `expectedMainCommit` design — why the runtime comparison is honest, not tautological

At build time, `generateBuildMetadata.mjs` also resolves `git rev-parse origin/main` (independently from `git rev-parse HEAD`, which is what's actually being built) — if that ref is resolvable in the checkout, `expectedMainCommitSource` is tagged `'git:origin/main'` and the two values are genuinely comparable; if not (a truly shallow/detached checkout with no remote-tracking ref), it falls back to `expectedMainCommitSource: 'assumed-same-as-deployed'` and simply reuses `deployedCommit` — never fabricating a comparison it can't actually make. `src/traffic/deploymentStatus.js`'s `computeDriftReasons(m)` (pure, exported separately for direct unit testing) only ever flags a commit mismatch when `expectedMainCommitSource` starts with `'git:'` — an assumed value is, by construction, always equal to `deployedCommit` and can never fire this check.

### `GET /version` — public, unauthenticated, minimal

`{service, appVersion, deployedCommit, deployedBranch, buildTime}`, nothing else — no bindings, no secrets-presence, no routes, no drift reasons. Exists specifically so `scripts/verify-production-deploy.mjs` (or any automated caller) can confirm "Production SHA == main SHA" without an Admin password, which a Claude Code sandbox may not have (see §7 of the task, and the actual proxy-denial evidence below). `Cache-Control: no-store` set explicitly (not inherited from `applyAdminSecurityHeaders`, since this route is intentionally outside `ADMIN_PATHS`) so no intermediate cache can ever serve a stale version to an automated verifier.

### `GET /admin/deployment-status` / `GET /admin/deployment-status-view`

Admin-Basic-Auth-gated, same GET-only-with-explicit-405 treatment as `/admin/broadcast-provenance`/`/admin/pipeline-trace`. Full detail: `deployedCommit`/`deployedBranch`/`buildTime`/`appVersion`, `driftDetected`/`driftReasons[]`, `routes[]` (statically known from `src/index.js`'s own route table — 0 self-HTTP-probe), `bindings[]` (existence-only check against `env` — `TRAFFIC_KV`/`CCTV_IMAGES`/`PBS_RELAY_WINDOWS`, mirroring `wrangler.jsonc`'s declared set, never an external ping), `secrets[]` (presence-only booleans, never a value), `cron.expected` (mirrors `wrangler.jsonc`'s `triggers.crons`, explicitly labeled as "what the code expects", never a claim about reading the real Dashboard Trigger config), and `dashboardOnlyChecks[]` — an explicit, honest list of what this Worker structurally cannot verify about itself (the real Production branch pointer, the real Cron Trigger, real traffic split, whether a Secret's VALUE is correct, Cloudflare's own build/deploy logs). `-view` is the same data as a server-rendered, zero-client-JS mobile HTML page (same CSP-compatible convention as `health.js`/`pipelineTraceView.js`), showing a 🔴 VERSION DRIFT banner with Deployed/Expected/reasons when `driftDetected`, or a plain ✅ banner otherwise.

### `/health` integration — deliberately display-only

Section 9 of the task allowed (not required) folding deployment drift into `/health`'s severity tier. Checking the existing severity contract first (as the task itself instructed) found it tightly coupled to dozens of existing tests asserting an exact `'normal'`/🟢 tier for TDX-schedule-state scenarios (`skipped-by-schedule`, `sleeping`), using a bare `handleHealth(env)` call with no injectable "known-good deployment" override. Since this dev/test environment's checked-in placeholder metadata ALWAYS shows drift (by design — see test scenario 4), nudging `status` from drift would have flipped essentially every one of those pre-existing assertions, for a fact genuinely orthogonal to "is the TDX/PBS/LINE pipeline healthy right now." Chose the safer, still fully-compliant option: a new, clearly-separated "部署" card showing `appVersion`/`Commit`/`Branch`/`版本漂移`, computed at render time (0 extra I/O, same pattern already established by `applyStaleness`), that never touches `status`/`statusMeta`/the page's HTTP status code. Verified directly: a `'normal'` snapshot still renders 🟢/正常 and 200, a `'critical'` snapshot still returns 503, regardless of deployment drift state.

### `scripts/check-deployment-policy.mjs` — static, 0-network repo checks

Exported as a library (`checkDeploymentPolicy()`) specifically so `verify-production-deploy.mjs` reuses these EXACT checks as its own preflight step, never a second, potentially-drifting copy (per the task's own "複製相同規則到多個... 禁止"). Checks: `wrangler.jsonc`'s `crons` == `'*/10 * * * *'`; the three required bindings (`TRAFFIC_KV`/`CCTV_IMAGES`/`PBS_RELAY_WINDOWS`) declared; `ENGINEERING_STATUS.md`'s "## Current Production version" fenced block references no known-legacy Production branch and does state `main HEAD:` (deliberately scoped to just that one block — the rest of this project's docs legitimately mention retired branch names as historical record, see §22, and must never be scrubbed); the canonical deploy-flow marker string (`"Production 唯一正式來源"`) is present somewhere in the docs; the required npm scripts (`predeploy`/`deploy`/`check:deployment-policy`/`verify:production`/`deploy:verify`) exist in `package.json`.

### `scripts/verify-production-deploy.mjs` — the post-push verifier

`npm run verify:production` / `npm run deploy:verify` (both plain aliases — see package.json). Steps: (1) resolve local `main` HEAD via `git rev-parse origin/main` (fallback `main`); (2) run `checkDeploymentPolicy()`; (3) `GET /version` against `PUBLIC_BASE_URL` (read from `wrangler.jsonc`, never hardcoded) with an 8s timeout; (4) if reachable, compare `deployedCommit`/`deployedBranch` against the local `main` HEAD; (5) if reachable, smoke-test every `IMPORTANT_ROUTES` entry, treating `200`/`401` as "exists" and `404` as a real failure (same "未登入時 401 屬正常，但不能是 404" convention already established in this project's own manual verification rounds); (6) print `dashboardOnlyChecks` and a final `PASS`/`FAIL`/`PASS_NETWORK_VERIFICATION_BLOCKED` summary. This script does NOT merge or push anything — that decision stays explicitly with whoever/whatever is driving it (see the task's own "merge/push 仍由 Claude Code 明確執行").

**Real, concrete network-blocked evidence found while building this**: this environment's own egress proxy does not fail the connection outright for a not-allowlisted host — it returns a REAL HTTP response, status 403, header `x-deny-reason: host_not_allowed`, body `"Host not in allowlist: traffic-reporter.mr-happytan.workers.dev. ..."`. A naive check (`!res.ok` → fail) would have misread this as the Worker itself returning 403, a seemingly serious problem for a route that's supposed to be public. `isProxyDenialResponse()` detects this from the one unambiguous, documented signal (the `x-deny-reason` header, confirmed via this environment's own `$HTTPS_PROXY/__agentproxy/status` endpoint) rather than guessing from the status code alone; a thrown network error (a different sandbox's proxy might fail the connection outright instead) is caught separately by the same try/catch and also classified as blocked. Both paths converge on `PASS_NETWORK_VERIFICATION_BLOCKED`, never a hard `FAIL` — per the task's explicit "不要因網路被擋就把整個部署視為失敗".

### Privacy / cost

0 TDX/PBS/CCTV/LINE calls, 0 GitHub API calls, 0 Cloudflare API calls anywhere in this entire feature. `/version` never carries bindings/secrets/routes/drift-reasons. `/admin/deployment-status(-view)` never carries a Secret's VALUE, only presence booleans. No Admin credential is ever required by `verify-production-deploy.mjs` — that is the entire point of `/version` existing.

### Tests

`test/deploymentStatus.test.js` (22 — `computeDriftReasons` scenarios 1/2/2b/3, binding/secret presence, `/version`'s minimal shape and 0-leak guarantee, `/admin/deployment-status`'s Admin-Auth/405/full-detail, every `IMPORTANT_ROUTES` entry actually resolving through the real Worker), `test/deploymentStatusView.test.js` (5 — mobile-readable HTML, drift banner, missing-binding/secret display, 405), `test/deploymentPolicyAndVerify.test.js` (12 — static policy regression against this repo's real current state, legacy-branch detection against synthetic fixtures including a "historical mention must not false-positive" case, `generateBuildMetadata.mjs` run for real against this repo's own git state, `verify-production-deploy.mjs`'s PASS/FAIL/BLOCKED classification including the exact proxy-denial-header shape and a thrown-network-error shape), plus 4 new tests appended to `test/health.test.js` (deployment card display, drift never downgrading a `'normal'` snapshot, `'critical'` unaffected by drift, no Secret leak). 59 new tests total. Full suite: 1008 tests, 1005 pass, the same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `healthQuotaDashboard.test.js`).

### What this round deliberately did not do

No merge into `main`. No deploy. No Cloudflare Dashboard change of any kind. No real TDX/PBS/CCTV/LINE/GitHub/Cloudflare-API call anywhere, including inside the verify script (its network step is a plain unauthenticated `GET` to this Worker's own public routes, nothing more privileged).

## 26. V1.8.6.9a — Pipeline Trace Mobile UX / Taiwan Time / Dark Mode

**Status: on branch `feature/v1.8.6.9a-pipeline-trace-mobile-ux`, branched from the post-V1.8.6.9 `main` (`9af8d21`). NOT merged, NOT deployed.**

### Purpose

Three real-device findings against `/admin/pipeline-trace-view` (the §23 查修頁), reported from an actual phone, not a design review: raw-UTC times reading as a wall of identical "04:00"/"04:10" rows, closed-vocabulary filter fields presented as free-text inputs, and a pure-white background that's uncomfortable to read at night. Goal stated by the task itself, verbatim: 「管理者拿手機打開，10 秒內看懂：上游抓到什麼、系統怎麼判、最後有沒有播、問題在哪一層。」 This is a presentation-layer-only round — `src/traffic/pipelineTrace.js`'s KV read/write, classification, and anomaly-detection logic are untouched; only `src/traffic/pipelineTraceView.js` changed.

### Root cause of the time bug — and why it was only a PARTIAL bug

The page already had a correct Taipei-time helper (`formatTaipeiInstant`, from §24/V1.8.6.8) used for `事件有效時間` in the detail section. The per-row SUMMARY column, though, had its own separate, never-updated computation: `new Date(entry.identity.timestamp).toISOString().slice(11, 16)` — raw UTC, no offset applied. Since most real events happen mid-day Taipei time (UTC+8), their UTC hour is 8 less — an event at 12:00 Taipei (a normal daytime accident) is `04:00` UTC, and that's exactly the number that kept appearing. Fixed by factoring the existing UTC+8-shift arithmetic out of `formatTaipeiInstant` into a shared `taipeiParts()` helper, then adding `formatTaipeiHHMM()` (built on that same helper) for the summary column — one single definition of "what time is it in Taipei" now serves both the summary and the detail section, so this specific class of bug (one display spot silently left on the old/wrong path while another was already fixed) cannot recur here. A fixed banner was added at the top of the page stating explicitly: 「🕒 以下時間皆為 **Asia/Taipei（台灣時間，UTC+8）**，不是 UTC。」

### Filters — `<select>` reusing the existing label objects, not a new vocabulary

`source` and `status` are both genuinely closed sets — every value a row can ever show is a key of `SOURCE_LABELS` or `STATUS_META`, the same two objects already used to render each row's own badges. The fix builds each `<select>`'s `<option>` list directly from `Object.entries()` of those same objects (via a small shared `renderSelect()` helper), so: (a) the dropdown can never offer a value that wouldn't match any row, (b) it can never drift out of sync with what's actually displayed on a row, and (c) no second, hand-typed vocabulary was introduced anywhere (this project's own standing "不要複製相同規則到多個地方" principle). `road` and `rawId` deliberately stay free-text `<input>` — both are genuinely open-ended (a road name substring match, an upstream-assigned raw ID), and a dropdown would be actively wrong for either.

### Dark mode — belt-and-suspenders, no framework

`PAGE_STYLE`'s entire palette was rewritten around the task's own suggested hex bases (`#0f1115` page background, `#1b1f26` card background), with GitHub-Dark-inspired state colors chosen for solid, tested contrast against those darks rather than re-deriving contrast ratios by hand: green `#3fb950` (✅ normal), amber `#e3b341` (⚠️ warning/fallback), red `#f85149` (❌ fail/anomaly), teal `#2dd4bf` (📷 CCTV — a new `.badge-cctv` class, distinct from the generic `.badge`), blue `#58a6ff` (🗺️ map — a new `.badge-map` class). Primary text is near-white (`#e8e9ec`/`#f2f3f5`), never pure `#fff`, per the task's own "不要純白刺眼"; secondary text is muted gray (`#9aa1ac`). `:root { color-scheme: dark; }` plus `<meta name="color-scheme" content="dark">` nudge the BROWSER's own native form-control chrome (autofill, date pickers, scrollbars) toward dark by default — kept alongside, not instead of, explicit dark styling on every `input`/`select`/`button`/placeholder, since native control theming is inconsistent across engines and this page must render correctly on both iPhone Safari and Chrome. Placeholder color (`#6b7280`) was deliberately chosen visible-but-secondary, never so faint it disappears against the `#20242c` input background. `<details>` sections (expand/collapse) and their field rows share the exact same color tokens as the rest of the page — no separate light-mode leftover anywhere. No UI framework was introduced; the page remains plain server-rendered HTML + inline `<style>`, zero client-side JavaScript — same Admin CSP (`default-src 'none'`, no `script-src` exception) as before, unchanged and still enforced by `security/adminAuth.js`'s `applyAdminSecurityHeaders`.

### What this round deliberately did not do

No change to `pipelineTrace.js` (KV logic, `buildTraceEntry`, `buildTraceAnomalies`, `listPipelineTrace`, the JSON endpoint) — this round is presentation-only. No dark-mode toggle / `prefers-color-scheme` media query — the task asked for this page to BE dark, not to offer a choice, so the palette is unconditional. No change to any other admin page (`health.js`, `deploymentStatusView.js`) — out of scope, not requested. No merge into `main`. No deploy. No Cloudflare Dashboard change. No real TDX/PBS/CCTV/LINE call anywhere.

### Tests

`test/pipelineTraceView.test.js`: all 7 pre-existing tests pass unchanged against the rewritten file (none of them asserted an `<input>` shape for `source`/`status`, so the `<select>` conversion needed no test updates there). 6 new targeted tests added: a concrete UTC-vs-Taipei fixture (`2026-08-20T04:00:00.000Z` — 12:00 Taipei — asserting the row renders `12:00`, never `04:00`); the tz-banner text is present; `source`/`status` render as `<select>`, never `<input>`, while `road`/`rawId` remain `<input>`, and the `<option>` lists carry the exact same labels rendered on rows; a query-string value pre-selects the matching `<option>`; dark-mode CSS (`color-scheme: dark`, `#0f1115` background, no pure-white background rule, dark input/select styling, a visible placeholder color) is present; `.badge-cctv`/`.badge-map` render as distinct classes with their own teal/blue colors. `pipelineTrace.test.js` and `pipelineTraceIntegration.test.js` (JSON endpoint, KV logic, Cron integration) re-run unchanged, confirming this round touched presentation only. Full suite: 1014 tests, 1011 pass, the same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `/health` month-baseline test).

### Correction round (same branch, follow-up commit) — two acceptance gaps closed

A review of the first pass against the original acceptance criteria found two items genuinely unmet, both fixed on this same branch, no new version:

**1. List time needed to be a human-readable RELATIVE date, not a bare `HH:MM`.** `formatTaipeiHHMM()` was replaced with `formatTaipeiListTime(iso, now)`: 今天 HH:mm for the same Taipei calendar day as `now`, 昨天 HH:mm for the previous Taipei calendar day, `M/D HH:mm` for anything older. The day comparison is done on the Taipei-shifted y/m/d via `Date.UTC(...)`, deliberately NOT a raw millisecond/24h subtraction — a pair of timestamps only 20 real minutes apart but straddling Taipei midnight (23:50 yesterday vs 00:10 today) must say 昨天, while a pair nearly 24h apart but on the SAME Taipei calendar day (08:05 vs 23:55) must say 今天; a naive "elapsed hours" comparison gets both of these backwards. `now` is an explicit, injectable parameter on both `formatTaipeiListTime` and `handlePipelineTraceView` (a new, optional third argument defaulting to `new Date()`, never read by `index.js`'s route table) specifically so a test can pin "today" — this project's standing "no wall-clock-dependent test" rule, taken literally for a feature whose entire output depends on what day it currently is.

**2. A real "D. 事件時間軸" section was missing, and `upstream.upstreamUpdatedAt` was still shown as raw ISO.** Added `D. 事件時間軸（Asia/Taipei）` with 上游更新 (`upstream.upstreamUpdatedAt`) and 系統抓取 (`identity.timestamp`), both run through the existing `formatTaipeiInstant`. Also Taipei-formatted `UpdatedAt` (section A) and `imageExpiresAt` (section C), which were both still raw ISO strings in the first pass despite the round's own stated goal of converting every human-readable timestamp on this page.

**The LINE 播報 line — checked the schema before writing any UI text.** `pipelineTrace.js`'s `delivery` block (see that file's `buildTraceEntry`) has `lineAttempted`/`lineSucceeded` as per-run COUNTS only — there is no `lineSucceededAt`/`linePushAt`/`notifiedAt`, or any other timestamp field, anywhere in the trace schema. `identity.timestamp` is when this TRACE ENTRY was recorded (i.e. when this run's pipeline processed the event) — not necessarily the same instant a LINE push actually completed, and presenting it as if it were would be exactly the kind of fabricated precision this project's "不要猜" rule forbids. No schema change was made to add a real push timestamp this round (see `PRODUCT_DECISIONS.md` for why) — the UI instead reports honestly: `lineSucceeded > 0` with no stored timestamp → "已播報（未保存獨立時間）"; never sent → "未播報（<the existing status pill's own emoji+label>）", reusing `statusMeta()` rather than inventing new wording. `linePushTimestamp()` also checks a small list of plausible future field names (`linePushedAt`/`lineSucceededAt`/`notifiedAt`) first, so if the schema is ever genuinely extended with one, the UI picks it up automatically with no further UI change — verified directly with a test that seeds `delivery.linePushedAt` and confirms the timeline uses it instead of the fallback text.

**JSON API contract unchanged.** `/admin/pipeline-trace` still returns raw UTC ISO strings, untouched — the Taipei formatting is entirely inside `pipelineTraceView.js`'s HTML rendering, never the underlying trace record.

**Tests**: 13 new tests added to `test/pipelineTraceView.test.js` (now 26 total in that file) — `formatTaipeiListTime`'s 今天/昨天/M-D cases plus two explicit midnight-boundary tests (a 20-minutes-apart pair that crosses the boundary and must say 昨天; a ~16-hours-apart pair that does NOT cross it and must say 今天), the same relative labels actually rendered through the real page, the new D section showing 上游更新/系統抓取 in Taipei time, the three LINE-timeline branches (sent-no-timestamp / never-played / attempted-and-failed) plus the future-schema-field pickup case, `UpdatedAt`/`imageExpiresAt` no longer appearing as raw ISO anywhere in the rendered HTML, and the JSON API's raw-ISO contract confirmed unchanged. `pipelineTrace.test.js`, `pipelineTraceIntegration.test.js`, and `deploymentStatusView.test.js` re-run unchanged. Targeted regression only — no trace schema change was made, so a full-suite run was not required per this round's own instruction.

## 27. V1.8.7.0 — Dynamic Shoulder Broadcast + Single-CCTV Strategy

**Status: on branch `feature/v1.8.7.0-dynamic-shoulder-single-cctv`, branched from the post-V1.8.6.9a `main`. NOT merged, NOT deployed.**

### Purpose

TDX publishes a real, structured mechanism for 機動開放路肩 (temporarily opening the road shoulder to through-traffic) and its reverse — genuinely actionable for a professional/taxi driver (an extra lane of legal capacity, or its sudden removal), unlike this Worker's existing event types. This round puts it on the active broadcast path for the first time, and — because a shoulder event doesn't need four camera angles the way an accident does — introduces a second, cheaper CCTV strategy alongside the existing one. Every stage of the existing authoritative pipeline (normalize → classify → eligibility → range enrichment → CCTV → formatter → LINE → Shared Feed → trace) was extended additively; nothing was replaced, and no second/parallel broadcaster was built ("最終仍是一條 authoritative path").

### Classification — evidence-based, never a hardcoded `EventSubType=498`

The task's own instruction was explicit: don't hardcode a numeric TDX code. `dynamicShoulderClassification.js` is a new, small, data-driven module — the same shape as `anomalyClassification.js`'s existing `NON_COLLISION_ANOMALY_RULES` — scanning EventType/EventSubType/Category/Description (in that priority order, same "check every candidate field" idiom `tdx/normalize.js`'s own `mapRoadEventType` already uses) for OPEN patterns (機動開放路肩/路肩開放/開放路肩) and STOPPED patterns (機動路肩停止開放/路肩停止開放/停止開放路肩/恢復禁止通行或行駛路肩), STOPPED checked first so a closing announcement's own incidental "開放" substring can never be misread as OPEN. The real Production fixture this round's task names verbatim (`EventType:4`, `EventSubType:498`, Description "…機動開放路肩事件") classifies correctly from the Description text alone — the numeric codes carry no meaning in this codebase and are never matched directly. Wired into `tdx/normalize.js`'s `normalizeRoadEvent` as a purely ADDITIVE `event.dynamicShoulder = {state, evidence}` field, checked against the SAME raw fields `mapRoadEventType` already reads (no second parse) — `event.type` itself is completely untouched (still resolves 'control' via the existing keyword table, since the fixture's Description also contains 管制), so every other control-typed event (and `broadcastRules.js`'s existing `ALWAYS_ELIGIBLE_TYPES` inclusion of 'control') needed zero changes.

### OPEN/STOPPED state model — wired into the fingerprints that already gate re-push, not a new mechanism

Rather than build a new state-machine, the task's actual requirement ("OPEN→STOPPED 必須視為重要內容更新，重新推播；同一 state、同一內容：維持既有 dedupe") maps directly onto the TWO fingerprints this pipeline already computes on every event: `dedupe.js#computeFingerprint` (governs new/updated/duplicate KV-state classification) and `notified.js#computeNotificationFingerprint` (governs the actual per-target LINE re-push decision — see `broadcastPipeline.js`'s `targetNeedsNotification`). Both gained one conditional key, `dynamicShoulderState: event.dynamicShoulder.state`, appended ONLY when `event.dynamicShoulder` is present — every other event's fingerprint JSON is byte-for-byte identical to before this round, verified directly by a test asserting neither fingerprint's JSON ever contains the string `dynamicShoulderState` for a plain accident. This was deliberately NOT left to incidental description-text differences between an OPEN and a STOPPED report (which usually does differ, but relying on that would silently break if TDX ever republished the same rawId with unchanged wording but a genuinely different state) — the classified state itself is now always part of the comparison.

A second, easy-to-miss wiring point: `effectiveWindow.js`'s `computeEffectiveWindow` treats every event as either "live" (current-state, no schedule needed) or "announced" (requires a parseable Chinese date range in the description, else `effectiveStart:null` → never broadcasts). A dynamic-shoulder record's own `type` is still `'control'`, which is NOT a `LIVE_TYPE` — without an explicit check, EVERY dynamic-shoulder event would silently fall into the "announced" bucket (no schedule text on a real record) and never resolve a window at all, i.e. never broadcast under any circumstance. Fixed with `isLiveDynamicShoulder(event)`, added to the existing `isLive` OR-condition — the exact same shape as the already-existing `isLiveNonCollisionAnomaly` check this file already carries for the V1.8.6.6 pedestrian-intrusion reclassification, for the identical underlying reason (a type-downgraded-but-still-current-state event must stay on the LIVE path).

### KM range → official section name — `resolveKmRange`, a thin wrapper, not a second resolver

`kmLocationResolver.js`'s existing `resolveKmLocation` already does everything this needs: `selectTargetKm` averages `startKM`/`endKM` into the range's own midpoint when both are present, and `buildFreewaySegment` already brackets that midpoint with the nearest facility BEFORE it and the nearest facility AFTER it, direction-aware, from the real official generated `freewayFacilities.js` dataset — which is exactly "the two interchanges bracketing this whole range." `resolveKmRange({road, direction, startKM, endKM})` only RESHAPES that same result into this round's task-specified contract (`{resolved, road, direction, startKm, endKm, segmentFrom, segmentTo, locationLabel, representativeCoordinate, mapUrl}`), parsing `startKm`/`endKm` via the same `parseKM` already used everywhere else. Verified against the real fixture: `91K+590～93K+320` on 國道一號 南向 resolves to `竹北交流道－新竹交流道路段` (北向 reverses the pair, same direction-aware ordering `resolveKmLocation` already had). Zero new facility-matching logic, zero new direction logic, zero runtime Google/TDX calls (same guarantee `resolveKmLocation` already carried).

### LINE wording — one new branch, same road/KM/map-line construction

`messageFormat.js` gained `DYNAMIC_SHOULDER_DISPLAY` (OPEN: 🛣️ 機動開放路肩 / STOPPED: ⛔ 路肩停止開放), checked FIRST in `formatEventMessage` (ahead of congestion/anomaly-detail/generic-type wording) whenever `event.dynamicShoulder` is set — but `buildRoadLines()` (road/direction/section-label/KM-range/map-URL) is completely unchanged and still runs for every event, dynamic-shoulder included. Wording keeps this round's two explicit safety constraints: never implies unconditional permission (STOPPED still can't be written as "禁止通行" without qualification, and OPEN's impact line is "請依現場標誌及號誌行駛", never "一定可以走"), and STOPPED explicitly tells the driver where to go ("請回主線車道"), not just "be aware."

### CCTV strategy — `quad` vs `single`, one pipeline, not two

`dynamicCollage.js#resolveCctvEligibility` now recognizes TWO CCTV-eligible categories — `event.type === 'accident'` (unchanged) OR a real `event.dynamicShoulder` (new) — distinguished by a new `imageStrategy` field on the returned eligibility object (`'quad'`/`'single'`). The `reason:'not-accident'` string for "neither category" is deliberately UNCHANGED (an existing test asserts this exact string for a plain 'other'-classified event), so no existing caller/test needed updating.

Camera SELECTION reuses the SAME eligible-CCTV-pool builder the 4-quadrant selector has always used — `hsinchuCctvProbe.js`'s inline pool-building loop was extracted, unchanged, into `buildEligibleCctvPool()` (same road-match, same service-area exclusion checked BEFORE any distance comparison, same required-field checks) specifically so the new `selectSingleShoulderCandidate()` never re-implements that filtering. Its own ranking rule, per the task's own priority: (1) same-direction AND physically inside `[startKm, endKm]` → closest to the range MIDPOINT wins ("最具代表性的一支"); (2) nothing in-range → the SAME nearest-by-radius fallback (±2km, then ±4km) already used throughout this module, ranked against the midpoint; (3) still nothing → `null`, and the caller treats that exactly like any other CCTV failure — text-only push, never a reason to withhold the notification.

`single` mode's actual work (`prepareSingleCctvImageWork`, new) is genuinely cheaper than `quad`'s, not just differently shaped: ONE frame fetch (via the SAME `extractFirstJpegFrame` the quad path already uses — same trusted-hostname check, same size cap, same per-fetch timeout), then the raw fetched JPEG bytes are published to R2 EXACTLY AS FETCHED — no `composeQuadrantCollage`, no JPEG decode, no re-encode at all. Verified directly: a test asserts the published R2 object's bytes are byte-identical to the mocked frame response. `prepareCctvImageForEvent`'s dispatch is a one-line branch on `eligibility.imageStrategy`, sharing the exact same budget/deadline/timeout machinery both strategies already needed — no second orchestration function.

### Downstream — same storage, same delivery, same trace, just gated open to a second event category

`broadcastPipeline.js`'s two `event.type === 'accident'` CCTV gates became `isCctvCandidateEvent(event)` (accident OR dynamic-shoulder) — R2 publish (`publishCollageImage`, byte-content-agnostic, reused completely unchanged), the LINE `[text, image]` message shape, `completedProducts`/`imageUrl`/`imageExpiresAt` (Shared Feed's own contract, unaffected — a dynamic-shoulder event just now sometimes has an `imageUrl` where it never could before), and `topUpSharedFeedCctvImages`' own eligibility filter (already `resolveCctvEligibility(...).eligible`, so it picked up the new category with zero code change) are ALL the same code paths accident CCTV always used.

Pipeline Trace gained: `normalized.eventSemantic`/`normalized.shoulderState`/`normalized.dynamicShoulderEvidence` — derived directly from `event.dynamicShoulder` INSIDE `buildTraceEntry` itself (no new caller-supplied parameter needed, same pattern `identity.road` already uses) — and `enrichment.imageStrategy`/`enrichment.selectedCamera`/`enrichment.rangeResolution`, which ARE new parameters (pipeline-computed outcomes for this run, can't be derived from `event` alone), threaded in by `broadcastPipeline.js` exactly like `imagePrepared`/`imageUrlPresent` already are. `selectedCamera` is a minimal `` `${cctvId}@${locationMile}` `` string — never the raw CCTV metadata record, same whitelist-only discipline `buildUpstreamSnapshot` already enforces. `rangeResolution` is deliberately NOT a second `resolveKmRange()` call — it's picked straight out of the SAME `kmLocationResolution` object the event's own LINE text was already built from (one resolution, two display consumers), populated only when `event.dynamicShoulder` is set.

### What this round deliberately did not do

No change to `event.type`/`broadcastRules.js`'s eligibility table (a dynamic-shoulder event rides the existing `control` → always-eligible rule). No new broadcast-hours policy — the same single 08:00–22:00 Asia/Taipei gate (`broadcastHours.js`, unchanged) applies, verified directly. No second CCTV pipeline, no second metadata cache, no second R2/LINE/Shared-Feed code path. No over-classification — a plain `EventType=4` control event with no shoulder-open/stop text (e.g. routine 車道管制作業) is verified to never get `event.dynamicShoulder` set at all, keeping its exact pre-existing behavior. No merge into `main`, no deploy, no Cloudflare Dashboard change, no real TDX/PBS/CCTV/LINE call anywhere (every test mocks `fetch`, throwing loudly on anything other than a `freeway.gov.tw` frame URL or, in full-pipeline tests, a mocked LINE endpoint).

### Tests

`test/dynamicShoulder.test.js` (new, 22 tests, covering all 28 acceptance items from this round's own task spec — several items are naturally covered together by one integration-style test, e.g. items 8–12's five-step OPEN→duplicate→STOPPED→duplicate→OPEN push sequence run against the real `runLineBroadcast` with a shared in-memory KV across sequential ticks, and items 20–22 verified together against one full-pipeline `runLineBroadcast` call). Covers: the real EventSubType-498 fixture classifying OPEN and never being keyed off the numeric code alone; a self-built STOPPED fixture; an ordinary control event never misclassified; `resolveKmRange` against the real fixture plus direction-reversal, fail-closed-unknown-road, and the short map-URL format; fingerprint identity/change across OPEN/STOPPED transitions at both the dedupe.js and notified.js layers, plus a real push-count assertion through all 5 states; CCTV eligibility/imageStrategy; single-camera selection (in-range, midpoint-priority, radius fallback, no-camera fail-closed); a byte-identical R2 publish proving no collage/decode/re-encode; a full pipeline run confirming LINE gets `[text, image]`, the Shared Feed's `completedProduct` carries the identical `imageUrl`, and Pipeline Trace records `imageStrategy:'single'`/`selectedCamera`/`eventSemantic`/`shoulderState`/`rangeResolution`; accident regression (`imageStrategy:'quad'`, still a real 4-frame composed collage, never accidentally falling through to the single-frame path); construction regression (unaffected eligibility/wording, never CCTV-eligible); a V57.2 cross-source-gating smoke test (module untouched this round); the 08:00–22:00 gate applying identically; and a fetch-mock that throws on anything other than a `freeway.gov.tw` frame URL, proving 0 TDX/Google calls. Full suite: 1049 tests, 1046 pass, the same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `/health` month-baseline test).

## 28. V1.8.7.1 — Multi-event Single CCTV Budget / Fairness Fix

**Status: on branch `fix/v1.8.7.1-single-cctv-budget-fairness`, branched from the post-V1.8.7.0 `main`. NOT merged, NOT deployed.**

### The bug, from real Production evidence

The very first busy Cron tick after V1.8.7.0 shipped (~14:00 Asia/Taipei) carried 3 real TDX dynamic-shoulder events at once (84K+500～86K+200 / 87K+290～90K+900 / 91K+590～93K+320, all 國道一號 南向). Pipeline Trace showed all three fully classified (`eventSemantic:'dynamic-shoulder'`), range-resolved, LINE-pushed, and `cctvEligible:true` — but only the FIRST got `imagePrepared:true`; the other two both read `cctvSkippedByReason:'run-budget-exhausted'`, having never even attempted a frame fetch. Per this round's own instruction, the task treated this as fully located by Production's own Pipeline Trace and explicitly forbade re-investigating TDX/PBS/classification/KM-resolver/LINE/Shared-Feed — the fix was scoped entirely to CCTV run-budget/scheduling.

### Root cause, traced end to end

`runLineBroadcast → prepareCctvImageForEvent → dynamicCollage.js`'s budget mechanism, exactly as it stood after V1.8.7.0: `broadcastPipeline.js` computed ONE `cctvRunDeadlineAt = Date.now() + CCTV_PREPARE_BUDGET_MS` (4000ms) BEFORE its per-event loop started, and every CCTV-eligible event that tick — quad (accident) AND single (dynamic-shoulder) alike — was passed `remainingRunBudgetMs = cctvRunDeadlineAt - Date.now()` as its OWN `budgetMs`. This loop is sequential (one event's whole CCTV attempt finishes before the next event's even starts), so:
- Event A (first in the loop — dynamic-shoulder events are always ordered before accidents in `perEventPending`, see its own construction: `[...otherRelevant, ...accidentRelevant]`) got close to the full ~4000ms, and its real single-frame-fetch-plus-R2-publish work (a few hundred ms in Production) consumed a real, non-trivial slice of that shared clock.
- Event B's turn came with only whatever was LEFT — in the real Production tick, apparently already at or near zero.
- Event C's turn came even later, with the pre-check `if (remainingRunBudgetMs <= 0)` now true — 0 attempt made, immediate `'run-budget-exhausted'`.

This was NEVER a genuine "not enough total time" problem — a single frame fetch is cheap (a few hundred ms), and B/C's own attempts, had they been given ANY reasonable independent budget, would very likely have succeeded. The bug was structural: the V1.8.7.0 design (correct and deliberate for accident-vs-accident budget sharing, see V1.8.5's own original correction notes) was reused unmodified for single-strategy events, which have a fundamentally different cost profile (cheap, ~constant-time) that doesn't need — and is actively harmed by — sharing one clock with however many events happen to precede it.

### Fix — per-event single budget + a global cap, exactly the shape the task's own menu offered

`cctv/dynamicCollage.js` gained `SINGLE_CCTV_PER_EVENT_BUDGET_MS` (1500ms) and `MAX_SINGLE_CCTV_EVENTS_PER_RUN` (5), and a new `prepareSingleCctvImageForEvent(env, eligibility, runCache, overrides)` wrapper: every eligible single-strategy event gets its OWN fresh `deadlineAt = Date.now() + SINGLE_CCTV_PER_EVENT_BUDGET_MS`, computed at THAT event's own turn — never derived from, or clamped by, any other event's elapsed time. `prepareCctvImageForEvent`'s existing `budgetMs` parameter (and the caller-supplied `remainingRunBudgetMs` it used to carry) is now IGNORED entirely for a `single`-strategy event; `broadcastPipeline.js` calls `prepareCctvImageForEvent(env, event, cctvRunCache, cctvCodecOverride)` for single with no 5th argument at all, letting `dynamicCollage.js` own its own budget decision internally.

A per-event budget alone would still let an unbounded NUMBER of events add up to unbounded total delay — bounded by `runCache.singleEventsAttempted`, a plain counter on the SAME per-run `runCache` object every call already shares (the identical object `getFreewayCctvMetadata`'s own metadata-memoization already uses — see that function's doc comment), incremented BEFORE each attempt starts. Beyond `MAX_SINGLE_CCTV_EVENTS_PER_RUN`, an event gets `{ok:false, reason:'single-event-cap-reached'}` immediately, 0 cost, 0 attempt — a reason string deliberately DIFFERENT from `'prepare-timeout'` (a single event's own budget genuinely expiring mid-attempt), verified directly with a test that produces BOTH reasons in the same run so an administrator reading Pipeline Trace can always tell them apart (see PRODUCT_DECISIONS.md for the full reasoning on why a third reason string wasn't invented).

Worst-case total added CCTV wall-clock time this design can ever cost one Cron tick is therefore a fixed, known ceiling: `MAX_SINGLE_CCTV_EVENTS_PER_RUN × SINGLE_CCTV_PER_EVENT_BUDGET_MS` = 5 × 1.5s = 7.5s — larger than the old shared 4s window, but now a GENUINELY FAIR one (every one of those 5 slots gets a real, equal-sized chance), and still a small, bounded, known number next to this pipeline's own pre-existing accepted quad budget.

### Quad's own protection — lazily anchored, not widened

Task instruction §8/§4-point-5 was explicit: don't touch accident's existing protection, and don't widen its deadline for dynamic-shoulder's sake. The actual risk identified while tracing the mechanism: since dynamic-shoulder events are always processed BEFORE accidents in the SAME sequential loop, and `cctvRunDeadlineAt` used to be an absolute timestamp anchored at LOOP START (before either strategy is even considered), real wall-clock time spent on several single events ahead of an accident would silently erode how much of `cctvRunDeadlineAt`'s nominal 4000ms window was actually left BY THE TIME the loop reached that accident — a genuine, new regression risk this round's own change would otherwise have introduced, in the direction opposite to the one the task explicitly worried about (§9's "quad starving single") but just as real.

Fixed by making `cctvRunDeadlineAt` LAZY: `let cctvRunDeadlineAt = null;` before the loop (was: computed unconditionally there), and `if (cctvRunDeadlineAt === null) cctvRunDeadlineAt = Date.now() + (cctvPrepareBudgetMs ?? CCTV_PREPARE_BUDGET_MS);` right before the FIRST accident's own CCTV attempt. The budget NUMBER (4000ms / `CCTV_PREPARE_BUDGET_MS`) is completely untouched — only WHEN the clock starts ticking changed, from "whenever this loop happened to start" to "whenever accident-CCTV processing itself actually begins." Multiple accidents in one run still share this one (now lazily-anchored) deadline exactly as before — that pre-existing, deliberate accident-vs-accident budget-sharing behavior (documented since V1.8.5's own correction notes) is completely unchanged. The identical lazy-anchor treatment was applied to `topUpSharedFeedCctvImages`'s own separate quad deadline for the same reason.

### Deterministic priority between quad and single (§9)

The two strategies no longer compete for ANY shared resource at all — quad's clock and single's budget-plus-cap are now fully independent mechanisms, each anchored/counted from its own strategy's own first touch. This is the simplest possible resolution to "不能因 quad 完全餓死所有 single" (and its unstated inverse, "single must not silently shrink quad"): removing the shared resource removes the starvation question entirely, rather than trying to arbitrate a priority order over a resource both still had to divide. Processing ORDER (single-strategy events first, since they're always in `otherRelevant`, ahead of `accidentRelevant`) was left exactly as the pre-existing array construction already had it — no new ordering logic was added; verified directly with a mixed-event test (1 accident + 3 shoulders, one tick) confirming all 4 get their own images.

### CCTV top-up pass — same fix, zero additional code

`topUpSharedFeedCctvImages` (the V57.1 Shared-Feed-only pass for already-notified/incident-suppressed events) calls `prepareCctvImageForEvent` with the SAME `cctvRunCache` object threaded through from `runLineBroadcast` — since the single-event cap counter lives on that shared object, the fix applies to the top-up pass automatically, with no code change needed there beyond routing its own single-strategy calls around ITS OWN accident-only deadline pre-check (the identical shape of bug existed there too, on a second, separate quad-only deadline this pass has always kept for itself — fixed the same way, lazily anchored). Verified directly with a test: 3 already-notified (0 subscribers) shoulder duplicates, all going through the top-up path exclusively, all 3 still get independent images.

### Pipeline Trace — 4 minimal fields, chosen over the task's own broader example list

The task offered `imageStrategy` / `cctvBudgetClass` / `budgetAtStartMs` / `budgetRemainingMs` / `processingDurationMs` / `singleSlotIndex` / `singleSlotLimit` as candidates, explicitly asking for the smallest, highest-value subset. Added: `cctvBudgetClass` (`'quad-shared'`/`'single-per-event'` — which regime this attempt used), `processingDurationMs` (wall-clock ms this attempt actually took, win or lose), `singleSlotIndex`/`singleSlotLimit` (this event's own attempt number this run, out of the cap). Deliberately did NOT add `budgetAtStartMs`/`budgetRemainingMs` — see PRODUCT_DECISIONS.md for why the slot-index framing is more immediately legible than a bare millisecond count. `imageStrategy`/`selectedCamera`/`rangeResolution` (V1.8.7.0) are unchanged.

### What this round deliberately did not do

Did not blindly raise `CCTV_PREPARE_BUDGET_MS` (quad's own constant is untouched). Did not remove the global safety cap — `MAX_SINGLE_CCTV_EVENTS_PER_RUN` bounds worst-case total delay to a fixed, known number, same "bounded, not unbounded" principle as the pre-existing quad mechanism. Did not let unlimited events attempt CCTV — beyond the cap, 0-cost immediate skip. Did not revert dynamic-shoulder back to `quad`. Did not call TDX again, or the CCTV metadata endpoint again (still cache-only, verified with a 0-extra-upstream-calls test). Did not build a second CCTV pipeline — `prepareSingleCctvImageWork` (the actual frame-fetch/publish work, V1.8.7.0) is completely unchanged; this round only changed HOW MUCH TIME/how many attempts get allocated to it. No merge into `main`, no deploy, no Cloudflare Dashboard change, no real TDX/PBS/CCTV/LINE call anywhere (every test mocks `fetch`).

### Tests

`test/singleCctvBudgetFairness.test.js` (new, 20 tests covering all 24 acceptance items from this round's task spec, several sharing one test): the exact real 3-event Production regression fixture (all 3 now `imagePrepared:true`, distinct `imageUrl`s, exactly 1 frame fetch each); 1/5-single stress cases; a slow first event (exceeds its own tiny test-overridden budget) timing out on its own while siblings each still get their FULL fresh budget; a failed first frame fetch and a failed first R2 publish, both leaving siblings unaffected and the run never aborting; a no-camera event still pushing text; a global-cap-exhausted scenario producing BOTH `'prepare-timeout'` (within cap) and `'single-event-cap-reached'` (beyond cap) distinctly in the same run; `imageStrategy`/frame-count invariants; accident-quad regression (still `imageStrategy:'quad'`, still a real composed 4-frame collage); a mixed 1-accident+3-shoulder run where all 4 get their own images; one event's LINE push failing without blocking its siblings; Shared Feed carrying 3 distinct `imageUrl`/`imageExpiresAt` pairs; Pipeline Trace's 4 new fields; the Shared-Feed-only top-up pass applying the identical fairness with 0 extra code; and smoke-test regressions for V57.2 gating, classification, OPEN/STOPPED fingerprints, and plain accident wording — none of which this round touched. Targeted suite (this file + the directly-affected existing files) confirmed first; then, per this round's own instruction ("這輪涉及 broadcast/CCTV/resource budget，合理跑一次 full suite"), the full suite: 1069 tests, 1066 pass, the same 3 pre-existing unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× wall-clock-dependent `/health` month-baseline test).

## 29. V1.8.7.2 — Dynamic Shoulder Message Simplification

**Status: on branch `fix/v1.8.7.2-dynamic-shoulder-message-short`, branched from the post-V1.8.7.1 `main`. NOT merged, NOT deployed.**

### Purpose

Product feedback on the (correctly-delivered) V1.8.7.0/V1.8.7.1 dynamic-shoulder broadcast: the LINE message itself was too long for what it's actually telling a driver. A dynamic-shoulder OPEN/STOPPED report is a real-time status flip — not an incident narrative needing a map link, a safety-reminder sentence, and an "updated at" timestamp — and it's ALREADY accompanied by a single CCTV photo (V1.8.7.0's own `imageStrategy:'single'`) that shows current conditions directly. This round's entire scope is the LINE text for this one event category; nothing else.

### What changed — `messageFormat.js` only

`formatEventMessage` gained a dedicated early-return short-circuit for a dynamic-shoulder event (`event.dynamicShoulder && DYNAMIC_SHOULDER_DISPLAY[event.dynamicShoulder.state]`), checked FIRST — ahead of congestion/anomaly-detail/generic-type wording — and returning IMMEDIATELY with exactly 4 lines: `${emoji} ${label}` / `firstLine` (road ＋ official section label) / `secondLine` (KM range) / `stateLine` (a single short state sentence). `buildRoadLines()` itself — the function that resolves road/direction/official-section-label/KM-range, including its own fail-closed "no facility resolves → bare road＋direction" fallback tier — is completely UNCHANGED; the short-circuit reuses its `firstLine`/`secondLine` output exactly as every other event type already does, and simply never appends the `mapLine`/updated-time line that used to follow. `DYNAMIC_SHOULDER_DISPLAY`'s `impactLines` field (formerly a two-line safety-reminder pair, "路肩目前開放通行\n請依現場標誌及號誌行駛" / "路肩恢復禁止行駛\n請回主線車道") was renamed `stateLine` and shortened to one line each ("路肩開放通行" / "路肩停止開放") — the removed reminder sentences described a driver's OBLIGATION under the physical signage, which the task's own instruction says is no longer necessary TEXT for this message (not that the underlying legal reality changed — see PRODUCT_DECISIONS.md).

The now-dead `dynamicShoulderDisplay` branches inside the generic congestion/anomaly/emoji/label/impactLines computation further down the function were removed (not just left unreachable) — since the new early-return means a dynamic-shoulder event can never reach that code, keeping the guard conditions there would have been confusing dead code, not a safety net.

### What deliberately did NOT change

- `kmLocationResolver.js` (`resolveKmLocation`/`resolveKmRange`) — completely untouched. The official section-label resolution, the map-URL/coordinate computation, and the fail-closed reasons are all exactly as V1.8.6.5/V1.8.7.0 left them. Other event types (accident/construction) still call the same function and still show their own 📍 地圖 line — this round only removed ONE display line from ONE event type's LINE text, never the underlying data or its availability to other consumers.
- `broadcastPipeline.js`'s own `rangeResolution` trace field (computed from `kmLocationResolution`, independent of `formatEventMessage`) — unaffected; verified directly.
- `dynamicShoulderClassification.js` / `dedupe.js` / `notified.js` (OPEN/STOPPED fingerprinting) — untouched.
- `cctv/dynamicCollage.js` (`imageStrategy:'single'`, camera selection, per-event budget fairness from V1.8.7.1, R2 publish) — untouched; the shorter text and the single CCTV image are still sent together in the same `[text, image]` LINE message shape.
- `pipelineTrace.js` — untouched; `eventSemantic`/`shoulderState`/`rangeResolution`/`imageStrategy`/`selectedCamera`/the V1.8.7.1 budget-diagnostic fields are all still populated exactly as before.
- accident/construction/congestion/other formatters — byte-identical output, verified directly against the exact same fixtures used in prior rounds' own regression tests.

### Tests

`test/dynamicShoulderMessageShort.test.js` (new, 14 tests covering all 15 acceptance items from this round's task spec — items 3/4 share one test): exact 4-line output for both OPEN and STOPPED against the real Production fixture; absence of `maps.google.com`/📍, the two removed safety-reminder sentences, and any 🕒/更新 line; the official section label and KM range both still present; a resolver-failure fixture (KM far outside the facility table) still producing a normal, valid 4-line message rather than being withheld; CCTV single-strategy eligibility unaffected; a full `runLineBroadcast` run confirming Shared Feed still carries the shoulder event's own `imageUrl`/`imageExpiresAt` and LINE still receives `[text, image]` with the new short text; byte-identical accident and construction formatter output; and Pipeline Trace's `rangeResolution`/`eventSemantic`/`shoulderState` still correctly populated. Targeted regression (this file plus every directly-affected existing test file — `dynamicShoulder.test.js`, `singleCctvBudgetFairness.test.js`, `messageFormat.test.js`, `dynamicCollage.test.js`, `broadcastPipeline.test.js`, `pipelineTrace.test.js`, `pipelineTraceIntegration.test.js`, `sharedFeed*.test.js`, `hsinchuCctvProbe*.test.js`, `nonCollisionAnomalyClassification.test.js`, `productionIntegrationFixtures.test.js` — 251 tests total) passed cleanly with 0 regressions. Full suite was NOT re-run this round, per the task's own instruction ("formatter-only 小修改，不需要再跑整套 full suite，除非發現影響範圍超出預期") — the targeted sweep confirmed the change's impact was exactly as scoped, with no surprise ripple into any other subsystem.
