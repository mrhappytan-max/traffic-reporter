import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLookupQuery, md5, syncEngineeringMemory } from "../scripts/syncEngineeringMemory.mjs";

test("lookup is restricted to the target folder and canonical path", () => {
  const query = buildLookupQuery("folder-id", "engineering-memory/PROJECT_HANDOFF.md");
  assert.match(query, /'folder-id' in parents/);
  assert.match(query, /trashed = false/);
  assert.match(query, /name = 'PROJECT_HANDOFF.md'/);
});

test("sync creates missing, updates changed, skips unchanged, and never deletes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "traffic-drive-sync-"));
  await writeFile(path.join(rootDir, "missing.md"), "new");
  await writeFile(path.join(rootDir, "changed.md"), "changed");
  await writeFile(path.join(rootDir, "same.md"), "same");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" });
    if ((options.method ?? "GET") === "GET") {
      const q = new URL(url).searchParams.get("q");
      const files = q.includes("missing.md") ? []
        : q.includes("changed.md") ? [{ id: "changed-id", md5Checksum: "different" }]
          : [{ id: "same-id", md5Checksum: md5(Buffer.from("same")) }];
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  };
  const summary = await syncEngineeringMemory({
    rootDir,
    manifest: { files: ["missing.md", "changed.md", "same.md"] },
    folderId: "folder-id",
    accessToken: "test-token",
    fetchImpl,
  });
  assert.deepEqual(summary, { checked: 3, created: 1, updated: 1, skipped: 1 });
  assert.equal(calls.some((call) => call.method === "DELETE"), false);

  // 2026-09-04 (ENGINEERING_MEMORY_KNOWN_ISSUES_VOLUME_02_CREATE) --
  // regression lock for a real GitHub Actions failure: the destination
  // Drive folder is a Shared Drive, and Drive API v3 silently evaluates
  // create/update/list calls against the (quota-less) service account's
  // own storage instead of the Shared Drive unless `supportsAllDrives=true`
  // is passed -- createRemoteFile() failed in Production CI with exactly
  // "Service Accounts do not have storage quota" the first time this sync
  // ever needed to create a brand-new file. Every call this module makes
  // must carry supportsAllDrives=true; the list/search call must also
  // carry includeItemsFromAllDrives=true.
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get("supportsAllDrives"), "true", `${call.method} ${call.url} must set supportsAllDrives=true`);
    if (call.method === "GET") {
      assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true", `${call.url} must set includeItemsFromAllDrives=true`);
    }
  }
});
