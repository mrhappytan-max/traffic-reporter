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

Never assume a key not in this table exists — `grep -rn "_KEY = " src/` to double check if you suspect drift.

---

## 8. Debug endpoints (all read-only, all safe to hit repeatedly)

**V1.6.3: every endpoint below, plus `GET /health`, now requires HTTP Basic Auth** (username `admin`, password from the `ADMIN_PASSWORD` Secret — see §6, `src/security/adminAuth.js`). Auth is checked before any handler runs, so an unauthenticated request never reaches TDX/PBS/KV. `POST /webhook` and the Cron `scheduled()` handler are unaffected (never gated by admin auth).

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

## V1.8.3 — 四宮格顯示文字全面中文化 (collage display text fully localized to Traditional Chinese)

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

## V1.8.5 — Dynamic per-accident CCTV + LINE「事故文字 + 1 張四宮格」

**Goal:** wire the V1.8/V1.8.3/V1.8.4 CCTV collage pipeline into the REAL LINE broadcast, without ever sending the wrong location's CCTV image. Until this round, `hsinchuCctvProbe.js`'s four-quadrant selector had only ever run against one fixed test target (國道一號 82K+100). Naively importing that fixed target into `broadcastPipeline.js` would have attached that same 82K+100 image to every accident's LINE message, regardless of where the accident actually was — this round exists specifically to prevent that.

**Scope, explicit:** only `type==='accident'` events get CCTV enrichment attempted. Not closure/control/construction/other/congestion/alert/PBS-only — "先把事故做好." Real LINE push for TEXT was already live (pre-existing); this round adds the IMAGE, sent in the SAME LINE API call as the text.

### Dynamic road/KM resolution — reuse, not reinvent

- **KM**: `cctv/dynamicCollage.js`'s `eventTargetKm(event)` uses ONLY the structured `startKM`/`endKM` fields `tdx/normalize.js` already populates from TDX's own `StartKM`/`EndKM` (already TDX-formatted `"NNK+NNN"` strings), parsed via `traffic/roadSectionLabel.js`'s existing, already-tested `parseKM`. Target KM = midpoint of start/end when both present, else whichever one parses. **Never reads `description`/free text for a KM guess.** No reliable KM → `no-reliable-km` → text-only.
- **Road**: `resolveRoadKey(event.road)` — the SAME alias-resolution table (`國道1號`/`中山高`/`中山高速公路`/etc → canonical `國道一號`) already used throughout this app for corridor/section-label logic, now also exported from `roadSectionLabel.js`. An event whose road doesn't resolve at all → `unresolvable-road` → text-only.
- **CCTV_SUPPORTED_ROADS** (`dynamicCollage.js`) is a closed, tiny registry — **only `國道一號`** — because its CCTV `RoadID` (`'000010'`) and `RoadName` pattern are the only ones ever independently confirmed against a real Production TDX CCTV/Freeway response (V1.7). No other freeway's CCTV RoadID has ever been observed from this dev sandbox (TDX egress is blocked here). A resolved-but-unsupported road (e.g. 國道三號, which V1.7/V1.8's `roadSectionLabel.js` DOES know for section labels, but which has no confirmed CCTV RoadID) → `unsupported-road` → text-only. Adding a road here requires confirming its real CCTV RoadID from an actual Production response first — never guessed from "the numbering probably matches."

### Selector generalization — same algorithm, now parameterized

`hsinchuCctvProbe.js`'s `selectFourQuadrantCandidates(records, {roadId, roadNamePattern, targetKm})` (was hardcoded module constants) and its extracted `composeCollageFromCandidates(candidates, headerLines, {targetKm, codecOverride})` are the SAME four-quadrant rule (±2km→±4km→null per quadrant, max 4 cameras, service-area exclusion via `isServiceAreaCctv` — completely untouched) and the SAME collage renderer (`cctv/collage.js`, untouched) — just no longer hardcoded to 82.1K. Every existing fixed-target admin endpoint (`/admin/cctv-hsinchu-probe`, `-collage`, `-publish-test`) keeps its exact original behavior via default parameter values (`TARGET_ROAD_ID`/`TARGET_ROAD_NAME_PATTERN`/`TARGET_KM`, now exported). `buildCollageHeaderLines(now, {roadShortName, targetKm})` similarly defaults to `'國1'`/`TARGET_KM` for those callers, and takes the accident's own road/KM for the dynamic path — e.g. a 國3 accident (once/if ever supported) would read "國3 95K+200 附近監視畫面."

### CCTV metadata cache — shared, not per-accident

`cctv:freeway-metadata:v1` on `TRAFFIC_KV`, 6h TTL. Cache hit → 0 TDX calls. Cache miss → 1 TDX call, normalized, cached. Within one Cron tick, N accidents share **at most 1** TDX CCTV metadata call via `runCache` — a plain `{}` object `broadcastPipeline.js` creates once per `runLineBroadcast` call and threads into every `prepareCctvImageForEvent` call; the first accident to need metadata stores the still-pending Promise on `runCache.metadataPromise`, every later accident this tick awaits that same Promise. Deliberately request-scoped, not module-global state (avoids cross-invocation staleness). KV's eventual consistency is explicitly ACCEPTABLE here — unlike the R2-backed published-image URL (V1.8.4), this cache never needs read-after-write.

### R2 publish — unchanged from V1.8.4

Same `CCTV_IMAGES` binding, same `cctv/published-image/<opaque-id>.jpg` key shape, same 128-bit opaque id, same 15-minute code-enforced `expiresAt` check on every read (never HTTP caching, never R2 lifecycle alone — R2's own 1-day lifecycle rule, confirmed enabled in Production, is a backstop only). Nothing in `publishedImage.js` changed this round.

### LINE transport — one call, text+image together

`line/pushMessage.js`: `pushLineMessages(env, to, messages)` is now the core (arbitrary LINE message array, 1 HTTP request); `pushLineMessage(env, to, text)` is a thin wrapper — `pushLineMessages(env, to, [{type:'text',text}])`, byte-for-byte the same request body it always sent, so no existing caller/test needed to change. `broadcastPipeline.js` builds `messages` as `[text]` or `[text, image]` **before** the per-target push loop and sends the exact same `messages` array to every pending target for that event — **one LINE API call per target, never a separate second call for the image.** A text-then-image two-call sequence was explicitly rejected: a second call failing after the first succeeded would leave notified-state semantics ambiguous (was this target notified or not), and risks a duplicate text send on a naive retry.

### Fail-closed CCTV, per instruction — CCTV failure is never a LINE failure

`prepareCctvImageForEvent` fails closed at every stage: `not-accident`/`not-freeway-source`/`unresolvable-road`/`unsupported-road`/`no-reliable-km` (eligibility), `no-r2-binding`, `tdx-auth-failed`/`tdx-fetch-failed` (metadata), `no-camera` (0 quadrants filled), `no-frames` (all 4 frame fetches/decodes failed), `r2-publish-failed`. **Every single one of these just means `messages` stays text-only** — computed and awaited entirely BEFORE the per-target push loop, so a CCTV failure can never partially-send, never delay the text, never mark the event failed, never duplicate the text, and never touches `notified-state` on its own (only the actual LINE push result does that, exactly as before this round).

### Multi-target: compose/publish once, share the URL

CCTV prep runs once per EVENT (not per target) — structurally, because it sits above the `for (const target of pendingTargets)` loop in `broadcastPipeline.js`, computed into a local `messages` variable that every target in that inner loop then reuses unchanged. Verified in `test/broadcastCctvIntegration.test.js`'s test 15: 3 targets (2 users + 1 group) on the same event → exactly 1 CCTV metadata call, exactly 1 R2 `put`, and all 3 LINE payloads carry the identical `imageUrl`.

### Interaction with V1.5.1 incident suppression / fingerprinting — untouched, verified compatible

- A suppressed re-tick (`resolveIncidentNotifications` → `suppressed:true`, same real incident, no material change) already yields `pendingTargets:[]` — CCTV prep is gated on `pendingTargets.length > 0`, so a suppressed tick triggers **zero** CCTV work, automatically (no special-case code needed).
- A material escalation (type change, new closure signal, more blocked lanes) yields non-empty `pendingTargets` again on its own — CCTV is freely recomposed/republished at that point, a brand-new image with a brand-new opaque id, exactly as intended ("material escalation 允許 rebroadcast 時：可重新產一次新的 CCTV collage") — again with zero special-case code, just the natural consequence of `pendingTargets` being non-empty.
- `notified.js`'s `computeNotificationFingerprint(event)` is derived purely from `type`/`road`/`direction`/`startKM`/`endKM`/`blockedLanes`/closure-signal — **never touched by this round, never fed anything CCTV/image-URL-derived.** The image URL's own randomness (a fresh opaque id every compose) therefore can never make an otherwise-identical event look "new."

### `GET /debug/status` — still 0 side effects

`resolveCctvEligibility(event)` is pure/synchronous/zero-I/O, so `result.cctvEligibleAccidentCount` is computed and populated even under `dryRun=true` (before the `if (dryRun) return result` early-return) — a legitimate stat, not a side effect. `result.cctvImagesAttachedCount`/`cctvSkippedByReason` are only ever populated on the real (non-dryRun) push path, since only that path actually attempts `prepareCctvImageForEvent`. `dryRun` never calls TDX CCTV metadata, never fetches a CCTV frame, never writes to R2, never calls LINE — enforced by construction (the CCTV block lives entirely after the dryRun early-return), verified in `test/broadcastCctvIntegration.test.js`'s test 22.

**Out of scope this round, unchanged:** `broadcastPipeline.js`'s non-CCTV logic, `scheduled.js`, Cron, PBS, `tdxSchedule.js`, `cctv/collage.js` (renderer), AI incident recognition, real LINE push testing, Production deploy, Production TDX probe.
