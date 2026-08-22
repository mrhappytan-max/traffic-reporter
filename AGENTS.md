# AGENTS.md — traffic-reporter（路況播報員）

Rules any AI agent working in this repo must follow. Where this file and `PROJECT_HANDOFF.md` overlap, they are meant to agree; `PROJECT_HANDOFF.md` carries the reasoning, this file carries the rule.

Start here: `meeting-room-export/00_CURRENT_STATE.md` (one page), then `meeting-room-export/02_PROJECT_HANDOFF.md` (concise handoff). Do **not** open the full `PROJECT_HANDOFF.md` (~320KB) unless you are actually chasing a historical root cause.

---

## 1. Meeting Room cloud sync: DELTA by default

```
NORMAL RELEASE = DELTA SYNC
FULL VERIFY    = EXCEPTION ONLY
```

A normal release compares each canonical file's sha256 against the last successful sync recorded in `.engineering/MEETING_ROOM_SYNC.json` and syncs **only** the files whose hash actually changed.

### UNCHANGED = SKIP (hard rule)

If a canonical file's sha256 matches its last synced hash, it is UNCHANGED and must receive **zero** Google Drive connector calls. Forbidden for an unchanged file:

- `search_files` for it
- `read_file_content` / `download_file_content` of it
- `create_file` of a new version
- archiving the old version
- byte-diffing it
- any other connector call naming it

### If nothing changed

`finalize:release` prints:

```
MEETING_ROOM_CLOUD_SYNC = NOT_REQUIRED
```

When you see that, **do not open the Google Drive Connector at all**. The cloud copy is already correct; the correct number of connector calls is zero. Re-verifying "just to be safe" is the exact waste this rule exists to prevent.

### Do not run a full verify on your own initiative

You may **not** re-run a 10/10 Drive audit because it feels safer, because the round was long, or because you want to be thorough. Full verify is allowed only for one of these seven reasons:

| Reason | When |
|---|---|
| `first-build` | nothing has ever been synced |
| `sync-architecture-change` | the sync mechanism itself changed |
| `connector-failure-recovery` | a failure may have left the cloud partially written |
| `canonical-structure-change` | the canonical file set changed |
| `archive-protocol-change` | the archive/replacement protocol changed |
| `manifest-evidence-untrustworthy` | hash evidence is missing/invalid, so a diff is meaningless |
| `human-explicit-audit-request` | a human explicitly asked for a full audit |

Only `manifest-evidence-untrustworthy` may be raised automatically (by `scripts/meeting-room-delta.mjs`). If you perform a full verify, your final report **must** contain:

```
FULL_VERIFY_REASON = <one of the reasons above>
```

`computeSyncPlan` throws on any reason outside that list, so an unlisted justification cannot be quietly accepted.

### Sync protocol for the files that DID change

Per changed file: **Create new → Verify (read-back + byte diff) → Archive old → Promote**. Never update a canonical file in place — this connector's `update_file` can only change title/parentId, never content. Never trash anything; superseded copies are *moved* into the archive folder recorded in the manifest.

---

## 2. Snapshot identity: never self-reference a commit

The exported machine state separates two different facts, and they must never be required to match:

- **`sourceMainHead`** — the official `main` commit the snapshot *describes*, read from `origin/main`.
- **`exportArtifactCommit`** — the commit that *contains* the artifact. It cannot exist at generation time.

Requiring these to be equal creates a loop: every export changes the file, which changes the commit, which invalidates the recorded head. Do not "fix" a snapshot by making its recorded head equal to the commit containing it.

Likewise, `sourceWorkingTree` deliberately excludes `meeting-room-export/`, because the generator dirties that directory by definition.

---

## 3. Authority boundary

- `traffic-reporter` is the **sole content authority** for the Shared Traffic Feed (Producer).
- Consumers (`hsinchu-thsr-line-bot` / `rail-traffic-consumer` / `rail-line-gateway`) are transparent relays. **Never modify them** — not their code, Cloudflare Dashboard, or LINE channels. Hand evidence across the boundary instead.
- Cross-department assets require a human first, **including read-only access**. "It's only a read" is not an exemption.
- Autonomous inside this repo's boundary: code, tests, docs, feature branches, commits, and its own verification.

---

## 4. Release discipline

- `main` is the only production source. Push to `main` → Cloudflare Workers Builds auto-deploys.
- Never force-push. Never rewrite history on a branch you did not create.
- Product code is out of scope for governance/tooling rounds: no TDX, PBS, CCTV, LINE, Shared Feed, Cron, Binding, or Secret changes unless that is the actual task.
- Known-failing test baseline is 3 tests (2 × `pbs-relay/tests/*`, 1 wall-clock-dependent `healthQuotaDashboard`). Anything beyond those three is a real regression.

---

## 5. Evidence rules

- Never guess a value that can be verified. If it cannot be verified from here, say so plainly rather than inferring it.
- Dashboard-only facts (real Cron schedule, production branch setting, whether a Secret holds the *correct* value, build history) are **not** verifiable from code. Mark them unverified; never fabricate.
- This sandbox has no production network egress (the proxy returns 403). A task needing live production evidence is "unable to prove", not "probably fine".
- Report failures as failures, including your own. A false PASS is worse than an honest blocker.
