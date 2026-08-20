#!/usr/bin/env node
// V1.8.6.5 — deterministic importer: raw/*.csv -> generated/*.js.
//
// Run via `npm run update:road-location-data`. Reads
// data/road-location/raw/**/*.csv (see raw/README.md for the exact input
// contract), validates/normalizes/compacts it, and atomically replaces
// data/road-location/generated/{provincial,freeway,freewayFacilities}.js
// — the ONLY files src/traffic/kmLocationResolver.js actually reads at
// runtime (bundled with the Worker, zero runtime fetches).
//
// Design rules this script must never violate:
//   - Never silently skip a bad row and still produce a generated file —
//     any schema problem (missing required column, unparsable value) is a
//     hard failure (non-zero exit, no file written), see raw/README.md §6.
//   - An EMPTY/missing raw directory is NOT an error — it produces a
//     genuine, real importer-generated file with recordCount:0. Never
//     hand-write a "placeholder" generated file outside this script.
//   - The whole build (all three datasets) is assembled in memory FIRST;
//     files are only written after every dataset builds successfully, and
//     each write is atomic (write to a temp path, then rename) — a failed
//     run must never leave a previously-good generated file half-written.
//   - Road names are normalized through the SAME canonicalizers
//     kmLocationResolver.js itself uses (roadIdentity.js) — the generated
//     data and the resolver's own road-matching must never drift apart.

import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalFreewayRoad, canonicalProvincialRoad } from '../src/traffic/roadIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'road-location', 'raw');
const GENERATED_DIR = path.join(ROOT, 'data', 'road-location', 'generated');

class SchemaError extends Error {}

function fail(message) {
  throw new SchemaError(message);
}

// Minimal RFC4180-ish CSV line splitter: handles double-quoted fields
// (with "" as an escaped quote) and plain comma-separated fields — no
// external dependency, and the datasets this importer targets don't need
// anything fancier (see raw/README.md's column contract). Exported (this
// script is otherwise a plain executable, not a module other code
// imports) so test/updateRoadLocationData.test.js can unit-test the CSV
// parsing in isolation, without touching any real raw/generated directory.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { pushRow(); continue; }
    field += c;
  }
  // Final field/row, if the file doesn't end with a trailing newline.
  if (field !== '' || row.length > 0) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function listCsvFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .map((name) => path.join(dir, name))
    .sort();
}

function readSourceMeta(dir) {
  const metaPath = path.join(dir, 'SOURCE_META.json');
  if (!existsSync(metaPath)) return { sourceName: null, sourceUrl: null, sourceAgency: null, datasetUpdatedAt: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (err) {
    fail(`${metaPath}: not valid JSON (${err.message})`);
  }
  // V1.8.6.5 — accepts both this project's own documented SOURCE_META.json
  // shape (raw/README.md §4: sourceName/sourceUrl/sourceAgency/
  // datasetUpdatedAt) AND the real-world shape the operator's own data-
  // collection tooling actually produced for raw/provincial/SOURCE_META.json
  // (dataset_title/source_portal/source_authority/dataset_modified) —
  // reading metadata robustly is a code decision, not a change to the raw
  // file's own content, so this file is never rewritten to match.
  return {
    sourceName: parsed.sourceName ?? parsed.dataset_title ?? null,
    sourceUrl: parsed.sourceUrl ?? parsed.source_portal ?? null,
    sourceAgency: parsed.sourceAgency ?? parsed.source_authority ?? null,
    datasetUpdatedAt: parsed.datasetUpdatedAt ?? parsed.dataset_modified ?? null,
  };
}

function parseNumber(value, file, rowNum, column) {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) fail(`${file}: row ${rowNum}: column "${column}" is not a valid number ("${value}")`);
  return n;
}

function readRows(file, requiredColumns) {
  const text = readFileSync(file, 'utf8');
  const table = parseCsv(text);
  if (table.length === 0) fail(`${file}: empty file (no header row)`);
  const header = table[0].map((h) => h.trim());
  for (const col of requiredColumns) {
    if (!header.includes(col)) fail(`${file}: missing required column "${col}" (header: ${header.join(', ')})`);
  }
  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    if (cells.length === 1 && cells[0].trim() === '') continue; // blank line
    const record = {};
    header.forEach((col, idx) => { record[col] = (cells[idx] ?? '').trim(); });
    rows.push({ record, rowNum: i + 1 });
  }
  return rows;
}

function sha256Of(strings) {
  const hash = createHash('sha256');
  for (const s of strings) hash.update(s, 'utf8');
  return hash.digest('hex');
}

// V1.8.6.5 — matches the REAL official schema (data.gov.tw dataset 7040,
// "省道里程坐標(里程牌標誌)"), confirmed once the operator actually
// committed the raw file — see data/road-location/raw/provincial/
// SOURCE_META.json for the full column list/provenance/notes. This
// REPLACES an earlier, pre-real-data guessed contract (公路編號/樁號KM/
// 設置位置/...) that turned out not to match the government file's own
// column names at all; see raw/README.md for the current documented
// contract.
const PROVINCIAL_REQUIRED_COLUMNS = ['route_raw', 'km_m', 'lon_wgs84', 'lat_wgs84'];
// Real-world chainage is as-installed, not idealised: every physical
// marker is published as a LEFT+RIGHT sign pair ~1m apart (install_
// position 左側/右側), or a single 中央 sign — see SOURCE_META.json's own
// notes. Bucketing to the nearest 10m collapses each such pair into one
// generated point (10m << the real ~100m/500m/1km marker spacing, so
// this can never merge two genuinely distinct markers) — cuts the
// generated dataset roughly in half without losing any resolvable
// precision (kmLocationResolver.js's own PROVINCIAL_TOLERANCE_KM is 0.6km,
// far coarser than 10m). Prefers a 中央 (single, bidirectional) sign over
// a 左側/右側 half of a pair when both exist in the same bucket.
const PROVINCIAL_DEDUPE_BUCKET_METERS = 10;

function buildProvincial() {
  const dir = path.join(RAW_DIR, 'provincial');
  const files = listCsvFiles(dir);
  const meta = readSourceMeta(dir);
  const rawTexts = files.map((f) => readFileSync(f, 'utf8'));

  const byBucket = new Map(); // "<road>|<bucket>" -> point, 中央-preferred
  for (const file of files) {
    const rows = readRows(file, PROVINCIAL_REQUIRED_COLUMNS);
    for (const { record, rowNum } of rows) {
      const road = canonicalProvincialRoad(record['route_raw']);
      if (!road) fail(`${file}: row ${rowNum}: "${record['route_raw']}" is not a recognizable provincial road (route_raw)`);
      const kmMeters = parseNumber(record['km_m'], file, rowNum, 'km_m');
      const km = kmMeters / 1000;

      const county = record['county'] || null;
      const township = record['township'] || null;
      // ~150 of 30,079 rows (all in `village` only) carry a literal "?"
      // where the real file has a rare CJK character that didn't survive
      // the source's own cp950->UTF-8 conversion (a raw-data encoding
      // artifact, confirmed present in the committed file itself — see
      // raw/provincial/SOURCE_META.json's own notes for the same class of
      // known issue). Never guessed/reconstructed (that would be exactly
      // the "不要猜" this project forbids) — just dropped, falling back to
      // the still-fully-accurate county+township label instead of
      // showing a driver a broken "?" glyph.
      const villageRaw = record['village'] || null;
      const village = villageRaw && villageRaw.includes('?') ? null : villageRaw;
      if (!(county && township)) {
        fail(`${file}: row ${rowNum}: needs both "county" and "township" to produce a usable label`);
      }

      const lat = parseNumber(record['lat_wgs84'], file, rowNum, 'lat_wgs84');
      const lng = parseNumber(record['lon_wgs84'], file, rowNum, 'lon_wgs84');
      const isCenter = record['install_position'] === '中央';

      const bucket = Math.round(kmMeters / PROVINCIAL_DEDUPE_BUCKET_METERS);
      const key = `${road}|${bucket}`;
      const existing = byBucket.get(key);
      if (!existing || (isCenter && !existing.isCenter)) {
        byBucket.set(key, { road, km, county, township, village, label: null, lat, lng, isCenter });
      }
    }
  }

  const points = [...byBucket.values()].map(({ isCenter, ...point }) => point);
  points.sort((a, b) => (a.road === b.road ? a.km - b.km : a.road.localeCompare(b.road)));

  return {
    metadata: {
      sourceName: meta.sourceName,
      sourceUrl: meta.sourceUrl,
      sourceAgency: meta.sourceAgency,
      fetchedAt: new Date().toISOString(),
      datasetUpdatedAt: meta.datasetUpdatedAt,
      recordCount: points.length,
      sha256: rawTexts.length ? sha256Of(rawTexts) : null,
    },
    points,
  };
}

function buildFreewayMilestones() {
  const dir = path.join(RAW_DIR, 'freeway', 'milestones');
  const files = listCsvFiles(dir);
  const meta = readSourceMeta(dir);
  const rawTexts = files.map((f) => readFileSync(f, 'utf8'));

  const points = [];
  for (const file of files) {
    const rows = readRows(file, ['路線名稱', '百公尺樁號KM', 'WGS84_E', 'WGS84_N']);
    for (const { record, rowNum } of rows) {
      const road = canonicalFreewayRoad(record['路線名稱']);
      if (!road) fail(`${file}: row ${rowNum}: "${record['路線名稱']}" is not a recognizable freeway route (路線名稱)`);
      const km = parseNumber(record['百公尺樁號KM'], file, rowNum, '百公尺樁號KM');
      const lng = parseNumber(record['WGS84_E'], file, rowNum, 'WGS84_E');
      const lat = parseNumber(record['WGS84_N'], file, rowNum, 'WGS84_N');
      points.push({ road, km, lat, lng });
    }
  }
  points.sort((a, b) => (a.road === b.road ? a.km - b.km : a.road.localeCompare(b.road)));

  return {
    metadata: {
      sourceName: meta.sourceName,
      sourceUrl: meta.sourceUrl,
      sourceAgency: meta.sourceAgency,
      fetchedAt: new Date().toISOString(),
      datasetUpdatedAt: meta.datasetUpdatedAt,
      recordCount: points.length,
      sha256: rawTexts.length ? sha256Of(rawTexts) : null,
    },
    points,
  };
}

function buildFreewayFacilities() {
  const dir = path.join(RAW_DIR, 'freeway', 'facilities');
  const files = listCsvFiles(dir);
  const meta = readSourceMeta(dir);
  const rawTexts = files.map((f) => readFileSync(f, 'utf8'));

  const facilities = [];
  for (const file of files) {
    const rows = readRows(file, ['路線名稱', '里程KM', '名稱']);
    for (const { record, rowNum } of rows) {
      const road = canonicalFreewayRoad(record['路線名稱']);
      if (!road) fail(`${file}: row ${rowNum}: "${record['路線名稱']}" is not a recognizable freeway route (路線名稱)`);
      const km = parseNumber(record['里程KM'], file, rowNum, '里程KM');
      const name = record['名稱'];
      if (!name) fail(`${file}: row ${rowNum}: "名稱" is required`);
      const type = record['類型'] || null;
      facilities.push({ road, km, name, type });
    }
  }
  facilities.sort((a, b) => (a.road === b.road ? a.km - b.km : a.road.localeCompare(b.road)));

  return {
    metadata: {
      sourceName: meta.sourceName,
      sourceUrl: meta.sourceUrl,
      sourceAgency: meta.sourceAgency,
      fetchedAt: new Date().toISOString(),
      datasetUpdatedAt: meta.datasetUpdatedAt,
      recordCount: facilities.length,
      sha256: rawTexts.length ? sha256Of(rawTexts) : null,
    },
    facilities,
  };
}

function renderModule(dataset) {
  return `// AUTO-GENERATED by scripts/updateRoadLocationData.mjs — do not hand-edit.
// Regenerate with: npm run update:road-location-data
// See data/road-location/raw/README.md for the input contract.
export default ${JSON.stringify(dataset, null, 2)};
`;
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, contents, 'utf8');
  renameSync(tmpPath, filePath);
}

function main() {
  let provincial;
  let freeway;
  let freewayFacilities;
  try {
    provincial = buildProvincial();
    freeway = buildFreewayMilestones();
    freewayFacilities = buildFreewayFacilities();
  } catch (err) {
    if (err instanceof SchemaError) {
      console.error(`update:road-location-data: SCHEMA ERROR — ${err.message}`);
      console.error('No generated file was touched.');
      process.exit(1);
    }
    throw err;
  }

  writeAtomic(path.join(GENERATED_DIR, 'provincial.js'), renderModule(provincial));
  writeAtomic(path.join(GENERATED_DIR, 'freeway.js'), renderModule(freeway));
  writeAtomic(path.join(GENERATED_DIR, 'freewayFacilities.js'), renderModule(freewayFacilities));

  console.log(
    `update:road-location-data: OK — provincial ${provincial.metadata.recordCount} points, ` +
      `freeway ${freeway.metadata.recordCount} milestones, ` +
      `freewayFacilities ${freewayFacilities.metadata.recordCount} facilities.`
  );
}

// Guarded so this file can be imported (e.g. by
// test/updateRoadLocationData.test.js, to unit-test parseCsv) without
// re-running the whole importer as a side effect of import.
if (import.meta.url === `file://${process.argv[1]}`) main();
