<!-- title: 完整工程歷史 8/8 -->

# PROJECT_HANDOFF（完整工程歷史）— 第 8 段／共 8 段

> 非 canonical。這是 Repo 內未經刪減的 `PROJECT_HANDOFF.md` 依章節切分後的第 8 段，
> 僅供追查歷史 Root Cause 時閱讀；日常接班請讀 `02_PROJECT_HANDOFF.md`。
> 完整且權威的版本永遠是 Repo 內的 `PROJECT_HANDOFF.md`。

---

## 35. V1.8.7.7 — CCTV Gray Broken Image Fix (Dynamic-Shoulder Frame Truncation)

### Trigger

Real Production evidence, self-directed full-autonomy troubleshooting authorization (08:00 Asia/Taipei incident report): LINE text broadcast normally for two 國3 南向 dynamic-shoulder events —

```
國3 南向 關西服務區－關西交流道 77K+150～78K+570
國3 南向 關西交流道－竹林交流道 79K+250～89K+830
```

— but the attached CCTV image rendered as a gray broken-image icon on the recipient's phone in both cases.

### Environment constraint acknowledged up front

This session's sandbox has **zero network egress** — confirmed this round via `curl` to both the Production Worker's own hostname and general internet hosts, both returning a hard `403` from the environment's own outbound proxy — and **no Cloudflare API token/credential of any kind** is present (`env | grep -i cloudflare` empty, no `~/.wrangler` config). Real Production KV, R2, `wrangler tail`, and Pipeline Trace were therefore all **unreachable from this session**, unlike the read-only Production KV inspection §32 relied on (which was explicitly conducted OUTSIDE this dev sandbox). Root cause here had to be established entirely from static code analysis — reading the full CCTV pipeline chain end to end, cross-referencing this codebase's OWN prior engineering comments/decisions, and constructing precise, hand-built test fixtures that reproduce the failure mode directly against the real `extractFirstJpegFrame` function — never by guessing. This is disclosed here in the same spirit as every other round's evidence-provenance note (§32, §33's own "this module has no real-network sandbox access" disclosure): the reasoning chain below is auditable and falsifiable (12 new tests fail on the pre-fix code and pass on the fix), but it does not carry a live Production log/trace citation the way some earlier rounds' findings did.

### Full-chain trace (what was ruled out, with evidence, not by assumption)

Traced: Traffic Event → `resolveCctvEligibility` (dynamic-shoulder, `imageStrategy:'single'`) → `selectSingleShoulderCandidate` (camera selection) → `extractFirstJpegFrame` (frame fetch) → `prepareSingleCctvImageWork` (R2 publish, raw bytes, no decode/encode) → `publicImageUrl` → LINE image message (`originalContentUrl`/`previewImageUrl`, both the same URL) → `GET /cctv/image/:id` (`publishedImage.js`'s read path).

- **Not LINE blocking the image, not R2 corruption, not the read path**: `publishedImage.js`'s write (`publishCollageImage`) and read (`handlePublicCctvImage`/`readPublishedImage`) paths are unchanged, shared unmodified by both the quad and single CCTV strategies, and read/write exactly the bytes they're given — R2 provides strong read-after-write consistency (the reason this module moved off KV in an earlier round), so whatever bytes `prepareSingleCctvImageWork` handed to `publishCollageImage` are exactly what a later `GET /cctv/image/:id` returns, byte-for-byte.
- **Not TTL/URL expiry (this round's task explicitly warned against defaulting to this)**: `PUBLISHED_IMAGE_TTL_SECONDS = 900` (15 minutes) is unchanged, shared unmodified by every CCTV image (quad and single, any road) since V1.8.4, and the push loop in `broadcastPipeline.js` prepares the image and pushes to LINE within the SAME synchronous per-event iteration — no batching delay, no queued cross-tick gap that could plausibly burn 15 minutes before the push itself. This explanation was considered and set aside on code-level evidence, not simply excluded because the task said not to assume it.
- **Not camera mis-selection**: `selectSingleShoulderCandidate` (shared, unmodified, reused by both 國1 and 國3) picks a real, in-range or nearest camera; a wrong-but-real camera would produce a valid, renderable (if visually incorrect) image — not a broken-image icon. Symptom specificity (broken render, not wrong content) points at the BYTES themselves, not the selection.
- **The one real difference from every previously-working case**: 國3's dynamic-shoulder CCTV path was enabled in §32 (V1.8.7.5) and had not yet carried real Production traffic before this incident — these two events are its first real-world exercise. That narrowed the search to code specifically exercised by the SINGLE-camera path that the QUAD (accident) path does not share.

### Root cause

`extractFirstJpegFrame` (`src/tdx/hsinchuCctvProbe.js`) located a fetched MJPEG frame's end by scanning raw bytes for the FIRST `0xFFD9` (JPEG End-Of-Image marker) anywhere after the first `0xFFD8` (Start-Of-Image marker) — `findMarker(buf, 0xff, 0xd9, soiIndex + 2)`. This is unsafe: a real IP camera JPEG very commonly embeds a complete EXIF thumbnail — itself a small, fully self-contained nested SOI...EOI JPEG — inside its APP1 metadata segment, near the very start of the file, well before the real image's own compressed scan data even begins. The naive scan finds the THUMBNAIL's own EOI first and returns a tiny, truncated slice of the real frame (file headers + thumbnail only) — a 200 HTTP response, a "successful" R2 publish, a real `imageUrl`, but corrupt, incomplete JPEG bytes. That is precisely what a phone renders as a gray broken-image icon.

**Why this was never observed on the quad (accident) path, and why it was equally latent for 國1**: `composeQuadrantCollage` (`src/cctv/collage.js`) decodes every fetched frame through a real JPEG decoder (`@jsquash/jpeg`, via `cctv/jpegCodecWorker.js`) before ever drawing it into the collage — and that module's own PRE-EXISTING comment already anticipates exactly this case ("a cell can fetch a 200 response that isn't actually a valid/decodable JPEG… must render as a `暫無畫面` placeholder"). A truncated/corrupt frame simply fails to decode and silently becomes a placeholder tile — never reaches a real user as broken bytes. The V1.8.7.0 dynamic-shoulder SINGLE-camera path (`prepareSingleCctvImageWork`, `src/cctv/dynamicCollage.js`) was deliberately built to skip that decode/encode round-trip entirely for performance — its own module comment states "one frame IS the final image," raw bytes published exactly as fetched — which also meant it had never validated that `extractFirstJpegFrame`'s output was a genuinely complete JPEG. This defect was therefore always equally present for 國1's own dynamic-shoulder traffic; 國3 is not a special case, it is simply the first real camera hardware (of either road) whose frames happen to embed a thumbnail early/large enough in the file to trigger the bug in practice.

### Fix

Replaced the naive scan with `findJpegImageEnd`/`walkJpegMarkers` (`src/tdx/hsinchuCctvProbe.js`, both module-private, reached only through the existing public `extractFirstJpegFrame`): a proper JPEG marker-segment walker.

- Starting at SOI, it walks each header segment (APPn/EXIF, DQT, DHT, SOFn, COM, DRI, …) by that segment's OWN declared 2-byte length field — skipping OVER an embedded thumbnail's internal SOI/EOI bytes entirely, rather than scanning into them — until it reaches SOS (Start of Scan).
- SOS itself has a length-prefixed header, followed by entropy-coded scan data that is NOT length-prefixed. Once past the SOS header, the walker scans that scan data for the next GENUINE marker using the JPEG spec's own mandatory byte-stuffing guarantee: a compliant encoder always follows a literal `0xFF` byte inside scan data with either a `0x00` stuff byte or a restart marker (`0xD0`-`0xD7`) — never anything else. So once correctly positioned AFTER the header segments (not right after SOI, which was the original bug), a plain "next `0xFF` followed by something else" scan is provably safe and correctly finds the real terminal EOI, never a coincidental byte pair.
- Operates correctly on a still-growing STREAMED buffer (this function is called on every new chunk while the stream is being read): returns `{complete:false}` — never throws, never guesses — whenever it needs bytes that haven't arrived yet, so the existing read loop (`MAX_FRAME_BYTES` cap, `FRAME_TIMEOUT_MS` timeout, both completely unchanged) simply tries again on the next chunk.
- Never reads past the SAME frame's own real EOI — the pre-existing "stop and cancel the stream the instant a complete frame is found, never peek into the next MJPEG frame" behavior and its own regression test are fully preserved (verified: still stops after the same 2-pull pattern the original test proves).
- **Fallback for non-marker-structured input**: `findJpegImageEnd` falls back to the EXACT pre-fix "first FFD9 after SOI" scan whenever the buffer does not decode as real marker-segment structure at an already-fully-received position (`walkJpegMarkers` returns `null` specifically for that case — never for "more data is still arriving," which always resolves to `{complete:false}` instead). This exists because this module's own EXISTING test suite (`test/hsinchuCctvProbe.test.js`) uses a deliberately simplified, non-marker-structured byte sequence (`[0xff,0xd8, 1,2,3,4,5, 0xff,0xd9]`) to stand in abstractly for "a complete JPEG frame" without needing real marker structure — real freeway.gov.tw camera output is always well-formed and marker-aligned, so this fallback path is not expected to ever fire in Production; it exists purely so the existing test suite's lighter-weight fixture convention keeps working unchanged, rather than forcing every existing/future test to construct byte-perfect real JPEG structure just to test unrelated behavior (timeouts, size caps, hostname trust, etc.).

### Scope discipline (self-checked against every constraint in the authorization)

Touches ONLY `extractFirstJpegFrame`'s internal frame-boundary detection in `src/tdx/hsinchuCctvProbe.js` (a new `findJpegImageEnd`/`walkJpegMarkers` pair, and the single call site inside `extractFirstJpegFrame`'s own read loop that now calls it instead of the old inline `findMarker` call). Did not touch: camera selection (`selectFourQuadrantCandidates`/`selectSingleShoulderCandidate`), service-area exclusion, road/RoadID matching, CCTV budget/fairness constants or logic, R2 publish (`publishCollageImage`), the public image read path, LINE image message construction, the accident quad collage/decode pipeline, dedupe/suppression, Shared Traffic Feed, or Pipeline Trace. No new upstream (TDX/PBS/LINE/Google) call anywhere. No image re-broadcast/re-push logic — this only affects the BYTES of a frame that was already going to be fetched and published, never whether/how often an image is sent. `hsinchu-thsr-line-bot`/雙鐵 was not touched, consulted, or reasoned about — this defect and its fix are entirely internal to `traffic-reporter`'s own CCTV frame-fetch code, upstream of anything the Shared Traffic Feed exposes.

### Tests

12 new targeted tests, `test/cctvFrameEoiTruncation.test.js`, driving the REAL public `extractFirstJpegFrame` through a mocked streaming `fetch` (never calling the module-private walker functions directly):

1. Embedded-thumbnail JPEG (single chunk) — extracts the real terminal EOI, not the thumbnail's own.
2. Embedded-thumbnail JPEG — explicit non-regression proof the result is NOT truncated at the thumbnail's own (earlier) EOI, with a fixture-sanity assertion that the bug scenario is actually being exercised.
3. Same embedded-thumbnail case delivered across many small streamed chunks (5-byte chunks) — proves correctness on a still-growing buffer, not just a fully-buffered one.
4. Plain JPEG with no embedded thumbnail — exact byte-for-byte regression (the common case is untouched).
5. Byte-stuffed `0xFF00` inside scan data is never mistaken for a marker/EOI.
6. Restart marker (`0xFFD0`) inside scan data is never mistaken for EOI.
7. The existing test suite's own simplified, non-marker-structured fixture shape still falls back correctly to plain scanning (backward compatibility with `test/hsinchuCctvProbe.test.js`'s existing fixtures).
8. No EOI ever arrives before the stream ends — still fails closed with `no-complete-frame`, never hangs.
9. `MAX_FRAME_BYTES` cap still enforced unchanged when marker-walking never finds an EOI.
10. A malformed segment length (`< 2`) inside a header falls back to plain scanning rather than hanging.
11. Still stops reading the stream the instant the complete frame is found — never peeks into the next MJPEG frame (mirrors `hsinchuCctvProbe.test.js` test 7's own proven two-pull tolerance pattern exactly).
12. R2-publish-path integration check — confirms the exact bytes `prepareSingleCctvImageWork` would hand to `publishCollageImage` are the full, untruncated frame, not merely a unit check of the extraction function in isolation.

**Verified both directions**: all 12 new tests correctly FAIL against the pre-fix code (confirmed by stashing the fix and re-running) and PASS against the fix — proving the tests actually exercise the bug, not merely exercise the new code path.

Full suite: 1153 tests, 1150 pass, 3 fail — the SAME 3 pre-existing, unrelated failures as every prior round (2× `pbs-relay/tests/*`, 1× `healthQuotaDashboard.test.js`'s wall-clock-dependent test), confirmed byte-for-byte identical (same failing test names) on unmodified `main` before this round's change, run first as a baseline.

### What this round deliberately did not do

Did not assume LINE blocking, R2 corruption, or URL/TTL expiry as the cause — each was actively investigated and ruled out on code-level evidence, per the authorization's explicit instruction not to default to any of them. Did not build a second, parallel CCTV frame-fetch pipeline for the fix (reused the single, shared `extractFirstJpegFrame` both strategies already call). Did not add a decode/re-encode round-trip to the single-camera path to "solve" this by brute force (would have reintroduced the exact JPEG-codec cost V1.8.7.0 deliberately avoided, and would have been symptom-masking rather than a root-cause fix of the frame-boundary detection itself). Did not touch any Production configuration, KV data, or R2 objects (no credentials/network access existed to do so from this sandbox regardless). Did not make any real TDX/PBS/LINE network call. Did not touch `hsinchu-thsr-line-bot` or any consumer repository.

**Addendum, same round, after separate explicit merge/deploy authorization**: the sentence above ("did not merge into `main`, deploy") described this round's state as written DURING investigation/fix, before a follow-up authorization explicitly granted commit/push/merge/deploy authority for this specific incident (full autonomous-troubleshooting order, distinct from the standing multi-department BASELINE FREEZE otherwise in effect at the time). Once granted: `npm run check:deployment-policy` passed (local, 0 network); fast-forward merge (`fix/v1.8.7.7-cctv-frame-eoi-truncation` → `main`, no merge commit, no rebase, no force push) landed at `main` HEAD `a3d660917ee5149acdba620d2304a25db40713e6`, pushed to `origin/main`; Cloudflare's existing push-to-`main` auto-deploy picked it up; `npm run verify:production` returned `PASS_NETWORK_VERIFICATION_BLOCKED` (this sandbox's egress proxy denies all outbound hosts — not a deploy failure, identical handling to every prior round's network-blocked verification).

### Release record (封版) — for future maintainers

**Formally CLOSED as an engineering record; REAL-WORLD UNCONFIRMED.** Every mechanism available to this session (targeted tests failing pre-fix/passing post-fix, full-suite regression parity, static deployment policy, fast-forward merge, push-triggered auto-deploy) is complete and green. What is explicitly NOT yet true: no session in this lineage has observed a real Production LINE message, for a real subsequent dynamic-shoulder event, actually render a correct (non-broken) CCTV image after this deploy — this sandbox has zero network egress and cannot check `GET /cctv/image/:id` or a real LINE delivery itself.

**If you are a future Claude session or engineer picking this up**: check whether a real-world confirmation has since been recorded (search this file and `ENGINEERING_STATUS.md` for `REAL_WORLD_CONFIRMED`). If the status is still `REAL_WORLD_CONFIRMATION_PENDING` and you have evidence either way (a real Pipeline Trace entry, a real screenshot, a real R2 object fetched and byte-inspected), update the status in both `ENGINEERING_STATUS.md`'s "Latest completed work — V1.8.7.7" section and here — a plain status-line edit, not a new fix version or branch, unless the evidence actually shows the fix DIDN'T work, in which case treat it as a new incident (new root-cause investigation, don't assume this round's fix was simply incomplete without re-checking).

## 36. Meeting Room Engineering Memory v1

### Purpose

A future ChatGPT (路況播報員 Project), Claude, or any other engineering Agent should be able to bootstrap this project — who am I, what's the current version, what's Production, what can I change, what's the current task — without re-reading this repo's full history from scratch. `scripts/export-meeting-room.mjs` generates a small, closed set of files (`meeting-room-export/`) that answers exactly that, and `scripts/sync-meeting-room.mjs` best-effort-copies it to a local filesystem path outside the repo (typically a Google Drive Desktop-mounted folder) so it's readable by tools that never clone this git repo at all.

### Source of Truth discipline

Per this round's own explicit instruction, chat history is never a source of truth. Priority order actually followed: current `main`/`origin/main` → git history → `ENGINEERING_STATUS.md`/`PROJECT_HANDOFF.md`/`PRODUCT_DECISIONS.md` → `wrangler.jsonc`/`package.json` → deployment/verification scripts → actual source code → tests. Where a doc and the code disagreed, code won — see the docs-vs-code drift check below.

### Two content strategies, deliberately different

- **02_PROJECT_HANDOFF.md and 04_PRODUCT_DECISIONS.md are COPIED VERBATIM** from this repo's own real files at export time — never a separate, hand-authored duplicate. These files already ARE the canonical Source of Truth for history/rationale; a second hand-written copy would immediately start drifting from the real one.
- **00/01/03/05/06/07 are hand-authored templates** (`scripts/meeting-room-templates/*.md`) with `{{PLACEHOLDER}}` substitution for volatile fields only. There is no existing single repo file with exactly this scope for governance-summary/architecture/cross-project-boundary/version-history/known-issues, so these are curated content, refreshed by whoever runs the next `finalize:release` when something materially changes — not auto-generated from a parser, since summarizing/curating is inherently a judgment call a script can't safely make.

### Volatile vs. narrative fields

Git HEAD/branch/`origin/main`/working-tree-status/`package.json` version/latest-git-tagged-version are derived MECHANICALLY, every run, from `git`/`fs` calls — never hand-typed (see `00_CURRENT_STATE.md`'s own "容易變動的欄位由 script 自動取得" instruction). Narrative fields (current task, next action, known blocker, current phase, production status/verification, real-world-confirmation status) default to sensible, evidence-grounded values computed once and can be overridden per-run via env vars (`EXPORT_CURRENT_TASK`, `EXPORT_NEXT_ACTION`, `EXPORT_KNOWN_BLOCKER`, `EXPORT_CURRENT_PHASE`, `EXPORT_PRODUCTION_STATUS`, `EXPORT_PRODUCTION_VERIFICATION`, `EXPORT_REAL_WORLD_CONFIRMATION`) — so a future `finalize:release` invocation can set them accurately for that round without editing the script.

### Docs-vs-code drift check (built, not just documented)

`export-meeting-room.mjs` compares the version label named in `ENGINEERING_STATUS.md`'s own "Latest completed work" heading against the newest version-labeled commit subject on the current branch. A mismatch prints an explicit `⚠️ DOCS DRIFT` warning and treats the git-derived value as the fact used in the export — never silently resolved either way, per this round's own instruction ("以目前 main 可驗證事實為準，並標記文件 Drift").

### Secret scan and allowlist

Output is a CLOSED allowlist of exactly 10 files (`OUTPUT_FILES` in `export-meeting-room.mjs`) — nothing else is ever written into `meeting-room-export/`. Every generated/copied file is scanned (case-insensitive regex) for `TDX_CLIENT_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`/`LINE_CHANNEL_SECRET`/`ADMIN_PASSWORD`/`TRAFFIC_FEED_SECRET`/`CLOUDFLARE_API_TOKEN`-shaped assignments, PEM private key headers, OpenAI-shaped `sk-` tokens, and bare `Bearer <token>` strings before the script reports success — an abort, not a silent skip, if anything matches. The script never reads `.env`/`.dev.vars`/any real Cloudflare Secret value in the first place (it has no access to them), so this is defense-in-depth against a future template accidentally embedding something, not the only line of defense. Verified this round with an independent `grep` pass over the real generated output (0 matches) in addition to the script's own inline scan.

### A real bug caught while building this (documented, not hypothetical)

`sync-meeting-room.mjs` was tested this round with the ACTUAL target value (`H:\我的雲端硬碟\路況播報員_工程記憶`) in this Linux sandbox. Node's `fs` calls do NOT reject a Windows-style path on a non-Windows process — `mkdirSync`/`copyFileSync` treated the entire string, backslashes included, as one literal directory NAME and created it inside the current working directory, and would have reported `GOOGLE_DRIVE_SYNC=SUCCESS` despite never touching anything resembling the user's real Google Drive. Caught by actually running the script against the real value rather than only testing the "unset" case, fixed with an explicit `looksLikeWindowsPath && process.platform !== 'win32'` guard that refuses and reports `FAILED` with the reason spelled out. The bogus test directory this created was deleted before commit — never shipped.

### Why Drive sync can never fail a release

Per this round's own explicit instruction, `finalize-release.mjs`'s exit code is driven ONLY by `check:deployment-policy` + the export step — `sync-meeting-room.mjs`'s result is printed but never affects `RELEASE_SEALED`/`RELEASE_SEAL_FAILED`. The repo-side `meeting-room-export/` (committed to git) is the durable record either way; Drive is a convenience mirror for tools that can't clone the repo, not the source of truth itself.

### Structural limitation, disclosed honestly (not worked around)

This session runs in a cloud execution sandbox with no filesystem access to the user's actual local machine — confirmed this round (no Windows drive, no Google Drive Desktop mount, `TRAFFIC_MEETING_ROOM_SYNC_DIR` unset). `GOOGLE_DRIVE_SYNC=PENDING`/`FAILED` is the correct, honest result from THIS environment — not a bug to "fix" by faking success. The scripts are written to work correctly wherever they're actually run with real access to that path (the user's own machine, a self-hosted runner, or a future environment with the Drive mounted). See `ENGINEERING_STATUS.md`'s "Latest completed work — Meeting Room Engineering Memory v1" for the exact result this round.

### Bootstrap validation (real, not asserted)

A fresh general-purpose subagent — genuinely no prior context of this project — was given read access to exactly `00_CURRENT_STATE.md`, `SYSTEM_STATE.json`, `PRODUCTION_MANIFEST.json`, and `01_FOUR_DEPARTMENT_GOVERNANCE.md` and asked the 11 required bootstrap questions (project identity, latest version, main, Production status, Producer/Consumer role, what it can/cannot modify, current task, next action, V1.8.7.7 status, when to stop and ask a human). Result: **PASS** — all 11 answered correctly and consistently across the files, with two disclosed minor gaps (the exact reason `PASS_NETWORK_VERIFICATION_BLOCKED` occurred lives in `07_KNOWN_ISSUES.md`, outside the 4-file test scope, so the subagent correctly said it couldn't explain the root cause from what it was given; and `packageJsonVersion` vs. the release version label are two different numbers the files don't reconcile — neither is a defect, both are honest boundaries of what a LEVEL 1/2 read should and shouldn't need to answer).

### What this round deliberately did not do

Did not touch any functional pipeline code (classification/eligibility/CCTV/LINE/Shared Feed/Pipeline Trace all untouched — 0 new/changed test files beyond this round's own tooling). Did not merge to `main`, did not deploy. Did not attempt to reach Cloudflare or any external API for this feature (no such access exists from this sandbox, and none was needed — everything is git/filesystem-local). Did not fabricate a Google Drive sync success. Did not touch `hsinchu-thsr-line-bot`/雙鐵 in any way — the governance/architecture docs describe the boundary, they don't cross it.

### Addendum — merged into main (same round, separate explicit merge authorization)

**Diff-scope verification performed before merging** (per the merge authorization's own explicit instruction not to assume, but to confirm): `git diff --name-only main feature/meeting-room-engineering-memory-v1 | grep -E "^src/"` returned zero matches — confirmed 0 files under `src/` (and equally, 0 under `test/`, 0 `wrangler.jsonc` changes beyond none) were part of this branch's diff. The full file list was exactly: `ENGINEERING_STATUS.md`, `PROJECT_HANDOFF.md`, `PRODUCT_DECISIONS.md`, `package.json` (additive script entries only, diffed and visually confirmed no existing script was altered), `meeting-room-export/*` (10 files), `scripts/export-meeting-room.mjs`, `scripts/sync-meeting-room.mjs`, `scripts/finalize-release.mjs`, `scripts/meeting-room-templates/*` (8 files). No TDX/PBS/CCTV/LINE/Shared Feed/classification/broadcast logic anywhere in the diff — safe to merge as a pure governance/tooling change.

Fast-forward merge (`feature/meeting-room-engineering-memory-v1` → `main`, no merge commit, no rebase, no force push) landed at `main` HEAD `56753bff98e975341d7c67cce6d750d188050767`, pushed to `origin/main`. `npm run check:deployment-policy` re-run post-merge: PASS. `meeting-room-export/` regenerated post-merge (`npm run finalize:release`) so it reflects "this governance tooling now exists on `main`" as its own source commit, rather than the pre-merge feature-branch snapshot — only the self-referential volatile fields (git HEAD, generated-at timestamp) changed; every curated/copied content file came out byte-identical, which is the expected, correct behavior for re-exporting with no underlying content change. Google Drive sync result: unchanged `GOOGLE_DRIVE_SYNC=PENDING` (`TRAFFIC_MEETING_ROOM_SYNC_DIR` still unset in this sandbox — explicitly NOT treated as a release failure, per this round's own instruction to mark it `WINDOWS_GOOGLE_DRIVE_SYNC = PENDING` and defer to a future Windows Sync Bridge stage).

If Cloudflare's push-to-`main` auto-deploy fired as a platform-level consequence of this push, that is standing, pre-existing platform behavior for any push to `main` (documented since V1.8.6.9 — see this file's "正式發布流程" reference in `ENGINEERING_STATUS.md`) — this round made no deliberate Production change (no Cron/Binding/Secret/KV/R2/Worker setting edit), and the merged diff contains no code capable of altering runtime behavior.

## 37. Google Drive Connector Direct Sync V1 — permanent Agent Rule

### Background — why this exists

A real-machine test (see §36's own "real bug caught while building this" entry for the earlier Windows-local-fs fallback) confirmed a live, connected Claude Google Drive Connector (`mcp__Google_Drive__*` tools) is available to this project's Claude Code Remote sessions, pointed at a real, pre-existing Drive folder `路況播報員_工程記憶` (id `1rbPC23-OqO9X9ebhm5398Dx0wM_n_l_o`, owner `mr.happytan@gmail.com`). That test also established a hard capability limit: the Connector's `update_file` tool supports ONLY `title`/`parentId` — it has NO content-update parameter at all. Confirmed empirically, not just from the tool's schema description: an `update_file` call against a real test file changed `modifiedTime` but left `fileSize` byte-identical to the original, proving content genuinely did not change.

**Consequence**: an existing canonical file in the Drive folder can never be safely "updated in place." Any sync design that tries risks either silently failing to update content (looking like success while actually being a no-op) or requires a delete-then-recreate sequence that has a real window where the canonical file simply doesn't exist if anything fails mid-sequence. Neither is acceptable for a file other tools (a future ChatGPT Project) may be reading at any time.

### The permanent protocol: Create → Verify → Archive Old → Promote New

For each of the 10 allowlisted canonical files (see `.engineering/MEETING_ROOM_SYNC.json`'s own `allowlist`), a sync NEVER touches the existing canonical file until a verified-good replacement already exists:

1. Create the new file's content as a NEW Drive file (temporary name) in the target folder.
2. Read the new file back via the Connector and verify its content matches what was uploaded (byte-for-byte, or at minimum the SHA-256 recorded in `.engineering/MEETING_ROOM_SYNC_REQUEST.json` — see `scripts/prepare-connector-sync-request.mjs`).
3. Only once verified: if an old canonical file with that name already exists, rename it with a `<timestamp>__<original filename>` prefix (e.g. `20260822T115500+0800__00_CURRENT_STATE.md`) and move it into the `_archive` subfolder — never overwritten, never deleted; archive is historical evidence, not something to prune automatically.
4. Rename the new (now-verified) temporary file to the real canonical filename — it is now promoted to the live `CURRENT` copy.
5. Re-search the target folder to confirm exactly ONE file per canonical name exists (no duplicates left behind by a partial run) and that it is the newly-promoted version.

This ordering is deliberate and non-negotiable: CREATE NEW must always happen and be VERIFIED before anything touches the OLD file — so a failure at any point during the sync leaves the PREVIOUS canonical file still fully intact and readable, never a gap where "CURRENT" briefly doesn't exist.

### Division of responsibility (script vs. Agent) — and why

`scripts/finalize-release.mjs` (a plain Node process) structurally CANNOT call Claude's Google Drive Connector — that's an MCP tool reachable only from inside a Claude Agent session's own tool-call loop, never from a spawned `node` child process. So the script's job stops at PREPARING the sync: it runs `scripts/prepare-connector-sync-request.mjs` to write `.engineering/MEETING_ROOM_SYNC_REQUEST.json` (per-file SHA-256 + byte length, target folder ID, `mainHead`) and prints the literal string `GOOGLE_DRIVE_CONNECTOR_SYNC_REQUIRED` — that string is the hand-off signal. The Claude Agent session itself must then perform the real Connector calls following the Create→Verify→Archive→Promote protocol above, using the hashes in that request file to verify each round-trip, and ONLY the Agent (never the script) may subsequently record a successful cloud sync into `.engineering/MEETING_ROOM_SYNC.json`'s `lastSync` field. The script's own summary output explicitly labels the pre-existing Windows Drive-Desktop local-fs fallback (`scripts/sync-meeting-room.mjs`, kept, never removed) as a SEPARATE, informational-only result — never conflated with, and never substituting for, a real Connector sync.

### Permanent Agent Rule (binding on any future Claude session working this repo)

```
npm run finalize:release completes
  ↓
if .engineering/MEETING_ROOM_SYNC.json's provider == "google-drive-connector"
  ↓
Claude MUST perform the Connector sync itself:
  - read .engineering/MEETING_ROOM_SYNC_REQUEST.json
  - for each of the 10 allowlisted files: Create → Verify (read-back,
    compare to the recorded SHA-256) → Archive old (if present) →
    Promote new
  - confirm exactly 10/10 canonical files exist, no duplicates
  - record the result (success or partial/failure detail) back into
    .engineering/MEETING_ROOM_SYNC.json's lastSync field, as its OWN
    terminal commit -- never re-triggering export/sync/commit in a loop
  ↓
if the Connector is unavailable to this session at the time
  ↓
the release still seals (RELEASE_SEALED from finalize:release is
unaffected), but cloud-sync status must be explicitly recorded as
MEETING_ROOM_CLOUD_SYNC=PENDING -- never silently skipped, never
reported as if it succeeded
```

An Agent must never claim a Connector sync succeeded without having actually performed real `search_files`/`create_file`/`read_file_content` calls and verified the content round-trip — the whole point of building this hash-verified, archive-before-promote protocol is to make "did the cloud copy actually update correctly" a checkable fact, not an assumption.

### Anti-loop design (why recording sync evidence doesn't re-trigger a release)

`finalize:release` → export → connector-sync-request is a ONE-WAY pipeline that terminates once the Agent finishes the real Connector calls and writes the result into `.engineering/MEETING_ROOM_SYNC.json`. That write is a single, standalone commit recording "as of `mainHead` X, the cloud copy was last synced at timestamp Y with result Z" — it is NOT itself treated as new engineering work requiring another `finalize:release` run. A future round's `finalize:release` will naturally pick up whatever `main` HEAD it's run from at that time; there is no mechanism (and none should ever be built) that automatically re-triggers export/sync/commit off of a `MEETING_ROOM_SYNC.json` write itself.

---

## 38. V1.1 — DELTA SYNC is the default; FULL VERIFY is exception-only

**Permanent rule, binding on every future release and every future Agent:**

```
NORMAL RELEASE = DELTA SYNC
FULL VERIFY    = EXCEPTION ONLY
```

### Why this exists

The Create→Verify→Archive→Promote protocol in §37 is correct, but applying it to all ten canonical files on every release is enormously wasteful. In practice a normal release changes only the handful of files that embed volatile state (`00_CURRENT_STATE.md`, `02_PROJECT_HANDOFF.md`, `SYSTEM_STATE.json`, `PRODUCTION_MANIFEST.json`); the governance/architecture/decision documents are usually byte-identical from one release to the next. Re-uploading and re-verifying those unchanged files burns Claude quota and Google Drive connector calls to re-prove something a hash comparison already proved for free.

### The normal release path

```
finalize:release
  → export (regenerates meeting-room-export/)
  → sha256 each of the 10 canonical files
  → diff against .engineering/MEETING_ROOM_SYNC.json's lastSync.files[]
  → changed files ONLY:
        Create new → Verify (read-back + byte diff) → Archive old → Promote
  → update sync evidence
  → done
```

If `changedFiles` is empty, `finalize:release` prints `MEETING_ROOM_CLOUD_SYNC = NOT_REQUIRED` and the Google Drive Connector **must not be opened at all**.

### UNCHANGED = SKIP (hard rule)

If a canonical file's sha256 equals its last successfully synced sha256, it is UNCHANGED, and it must receive **zero** Google Drive connector calls. Specifically forbidden for an unchanged file: `search_files`, `read_file_content`, `download_file_content`, `create_file`, archiving the old copy, and byte-diffing. Not "prefer not to" — forbidden.

### FULL VERIFY exceptions (closed list)

Full verify is permitted **only** for one of these seven reasons:

1. `first-build` — nothing has ever been synced, so there is no baseline.
2. `sync-architecture-change` — the sync mechanism itself changed.
3. `connector-failure-recovery` — a failure may have left the cloud partially written.
4. `canonical-structure-change` — the canonical file set changed.
5. `archive-protocol-change` — the archive/replacement protocol changed.
6. `manifest-evidence-untrustworthy` — the hash evidence can't be trusted, so a diff would be meaningless.
7. `human-explicit-audit-request` — a human explicitly asked for a complete audit.

Reason 6 is the only one that may be raised **automatically** (by `scripts/meeting-room-delta.mjs`, when the manifest is missing, not marked successful, or lacks a valid sha256 for every canonical file). Every other reason requires a deliberate decision.

Any run that performs a full verify **must** state `FULL_VERIFY_REASON = <reason>` in its final report. An Agent may **not** start a full verify for its own reassurance — "just to be safe, let me re-check all ten" is precisely the behaviour this section forbids. `computeSyncPlan` throws on any reason outside the list, so an unlisted justification cannot be quietly accepted.

### Why the export had to become byte-stable first

Delta sync is worthless if the export changes bytes on every run for reasons nobody cares about. Two sources of false delta were removed:

- **Generation timestamp.** Content identity is now hashed with the timestamp masked (`__EXPORT_GENERATED_AT__`); when every file's masked content matches the last synced export, the previous timestamp is reused verbatim, so a no-op export is byte-identical to the last one.
- **Transient checkout fields.** `SYSTEM_STATE.json` no longer records the branch/HEAD/date the export happened to run from, and `PRODUCTION_MANIFEST.json`'s `verifiedFromCommit` now records `sourceMainHead` rather than the checkout HEAD. Those fields changed on literally every commit and said nothing about the snapshot; the snapshot is identified by `sourceMainHead` alone (see §37's self-reference discussion). The checkout is still recorded in local `.engineering/` sync evidence for auditing.

Net effect: re-running `finalize:release` without changing anything produces zero changed files and therefore zero connector calls.

### Where this is implemented

| Concern | Location |
|---|---|
| Delta decision (pure, unit tested) | `scripts/meeting-room-delta.mjs` |
| Machine-readable policy + per-file synced hashes | `.engineering/MEETING_ROOM_SYNC.json` |
| Release wiring + `NOT_REQUIRED` output | `scripts/finalize-release.mjs` |
| Changed-files-only sync request | `scripts/prepare-connector-sync-request.mjs` |
| Byte-stable export | `scripts/export-meeting-room.mjs` |
| Tests | `test/meetingRoomDeltaSync.test.js` |
| Agent-facing rule | `AGENTS.md` |

