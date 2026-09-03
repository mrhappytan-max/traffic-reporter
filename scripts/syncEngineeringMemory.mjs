import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const APP_PROPERTY = "trafficReporterCanonicalPath";

export function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

export function escapeDriveQuery(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function buildLookupQuery(folderId, canonicalPath) {
  return [
    `'${escapeDriveQuery(folderId)}' in parents`,
    "trashed = false",
    `name = '${escapeDriveQuery(path.basename(canonicalPath))}'`,
  ].join(" and ");
}

async function driveRequest(fetchImpl, accessToken, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Drive API ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

// 2026-09-04 (ENGINEERING_MEMORY_KNOWN_ISSUES_VOLUME_02_CREATE) -- REAL
// FAILURE, ROOT-CAUSED (not a flake): the GitHub Actions run for this
// exact commit failed with `Drive API 403: Service Accounts do not have
// storage quota. Leverage shared drives ... or use OAuth delegation ...`
// on createRemoteFile() specifically -- every pre-existing file's
// find/update call succeeded (skipped/updated normally), only the CREATE
// call for the brand-new 07_KNOWN_ISSUES_02.md failed. This is the
// documented Drive API v3 behavior: a service account has zero personal
// "My Drive" storage quota, and `files.create`/`files.update`/`files.list`
// against a Shared Drive folder must pass `supportsAllDrives=true` (list
// calls should also pass `includeItemsFromAllDrives=true`) or Drive
// silently evaluates the operation against the caller's own (quota-less)
// storage instead of the Shared Drive's. Reads/updates on files that
// already existed happened to keep working without the flag in this
// specific folder's configuration, which is why this bug was never
// caught until the very first time this sync tried to CREATE a new file
// under the current governance regime. Fixed by adding
// `supportsAllDrives=true` to every Drive API v3 call this module makes
// (and `includeItemsFromAllDrives=true` to the list/search call) --
// harmless no-op if the destination folder is ever not a Shared Drive.
const SHARED_DRIVE_PARAMS = { supportsAllDrives: "true" };

async function findRemoteFile({ fetchImpl, accessToken, folderId, canonicalPath }) {
  const params = new URLSearchParams({
    q: buildLookupQuery(folderId, canonicalPath),
    fields: "files(id,name,md5Checksum,appProperties)",
    spaces: "drive",
    pageSize: "2",
    includeItemsFromAllDrives: "true",
    ...SHARED_DRIVE_PARAMS,
  });
  const response = await driveRequest(fetchImpl, accessToken, `${DRIVE_API}/files?${params}`);
  const { files = [] } = await response.json();
  if (files.length > 1) throw new Error(`Duplicate mirror entries for ${canonicalPath}`);
  return files[0] ?? null;
}

async function createRemoteFile({ fetchImpl, accessToken, folderId, canonicalPath, content }) {
  const boundary = `traffic-reporter-${Date.now()}`;
  const metadata = {
    name: path.basename(canonicalPath),
    parents: [folderId],
    mimeType: "text/markdown",
    appProperties: { [APP_PROPERTY]: canonicalPath },
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const params = new URLSearchParams({ uploadType: "multipart", fields: "id", ...SHARED_DRIVE_PARAMS });
  await driveRequest(fetchImpl, accessToken, `${DRIVE_UPLOAD_API}/files?${params}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function updateRemoteFile({ fetchImpl, accessToken, fileId, content }) {
  const params = new URLSearchParams({ uploadType: "media", ...SHARED_DRIVE_PARAMS });
  await driveRequest(fetchImpl, accessToken, `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?${params}`, {
    method: "PATCH",
    headers: { "content-type": "text/markdown; charset=UTF-8" },
    body: content,
  });
}

export async function syncEngineeringMemory({ rootDir, manifest, folderId, accessToken, fetchImpl = fetch }) {
  const summary = { checked: 0, created: 0, updated: 0, skipped: 0 };
  for (const canonicalPath of manifest.files) {
    const content = await readFile(path.join(rootDir, canonicalPath));
    const localMd5 = md5(content);
    const remote = await findRemoteFile({ fetchImpl, accessToken, folderId, canonicalPath });
    summary.checked += 1;
    if (!remote) {
      await createRemoteFile({ fetchImpl, accessToken, folderId, canonicalPath, content });
      summary.created += 1;
      console.log(`created ${canonicalPath}`);
    } else if (remote.md5Checksum === localMd5) {
      summary.skipped += 1;
      console.log(`skipped ${canonicalPath}`);
    } else {
      await updateRemoteFile({ fetchImpl, accessToken, fileId: remote.id, content });
      summary.updated += 1;
      console.log(`updated ${canonicalPath}`);
    }
  }
  console.log(`summary checked=${summary.checked} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped}`);
  return summary;
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(rootDir, "scripts", "drive-sync-manifest.json"), "utf8"));
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID is required");
  if (!accessToken) throw new Error("GOOGLE_OAUTH_ACCESS_TOKEN is required");
  await syncEngineeringMemory({ rootDir, manifest, folderId, accessToken });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
