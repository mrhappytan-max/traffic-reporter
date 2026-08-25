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

async function findRemoteFile({ fetchImpl, accessToken, folderId, canonicalPath }) {
  const params = new URLSearchParams({
    q: buildLookupQuery(folderId, canonicalPath),
    fields: "files(id,name,md5Checksum,appProperties)",
    spaces: "drive",
    pageSize: "2",
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
  await driveRequest(fetchImpl, accessToken, `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function updateRemoteFile({ fetchImpl, accessToken, fileId, content }) {
  await driveRequest(fetchImpl, accessToken, `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
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
