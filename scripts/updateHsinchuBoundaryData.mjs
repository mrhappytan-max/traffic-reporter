#!/usr/bin/env node
// V2.4.5 — deterministic importer: raw/nlsc-shp-2020/COUNTY_MOI_1090820.shp
// -> generated/hsinchuBoundary.js.
//
// Run via `npm run update:hsinchu-boundary-data`. Reads
// data/hsinchu-boundary/raw/nlsc-shp-2020/COUNTY_MOI_1090820.{shp,dbf} (see
// raw/README.md for the exact input contract and provenance — a direct
// official NLSC download, human-supplied into this session because this
// sandbox cannot reach data.gov.tw itself), decodes the shapefile, extracts
// ONLY the 新竹市/新竹縣 county-level polygons, validates them, and
// atomically replaces data/hsinchu-boundary/generated/hsinchuBoundary.js —
// the ONLY file src/tdx/hsinchuGeoResolver.js actually reads at runtime
// (bundled with the Worker, zero runtime fetches, zero runtime dependency
// on the `shapefile` package — this script is the only consumer of it).
//
// V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX_CONTINUE — this script
// previously read a TopoJSON mirror (raw/counties-10t.json, taiwan-atlas
// npm) via topojson-client. That source is preserved, unread, for
// historical comparison at raw/historical-taiwan-atlas-2021/ (see that
// directory's own README.md); topojson-client stays a devDependency only
// so a future round can decode it again if it ever needs to re-run the
// same geometry-diff-check methodology documented in SOURCE_META.json's
// geometryDiffCheck block — it is not imported anywhere in this repo
// right now.
//
// Design rules this script must never violate (same discipline as
// scripts/updateRoadLocationData.mjs):
//   - A missing/malformed Hsinchu feature is a hard failure (non-zero
//     exit, no file written) — never silently write an incomplete dataset.
//   - The generated file is only written after BOTH features (新竹市,
//     新竹縣) decode successfully in memory; the write is atomic (temp
//     path, then rename).
//   - Coordinates are copied through exactly as the `shapefile` package
//     decodes them — no simplification, no rounding, no manual editing.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shapefile from 'shapefile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'hsinchu-boundary', 'raw', 'nlsc-shp-2020');
const SHP_PATH = path.join(RAW_DIR, 'COUNTY_MOI_1090820.shp');
const DBF_PATH = path.join(RAW_DIR, 'COUNTY_MOI_1090820.dbf');
const SOURCE_META_PATH = path.join(ROOT, 'data', 'hsinchu-boundary', 'raw', 'SOURCE_META.json');
const GENERATED_PATH = path.join(ROOT, 'data', 'hsinchu-boundary', 'generated', 'hsinchuBoundary.js');

class SchemaError extends Error {}

function fail(message) {
  throw new SchemaError(message);
}

// The two features this project needs — see raw/README.md. Deliberately
// matched on BOTH COUNTYNAME and COUNTYCODE (not name alone) so a future
// upstream renumbering can't silently swap in the wrong county.
const TARGETS = [
  { key: 'HSINCHU_CITY', countyName: '新竹市', countyCode: '10018' },
  { key: 'HSINCHU_COUNTY', countyName: '新竹縣', countyCode: '10004' },
];

/**
 * A GeoJSON Polygon's coordinates is an array of linear rings; a
 * MultiPolygon is an array of those. This project only needs to KNOW
 * whether a point falls inside "any ring of any polygon that makes up
 * this county" — so both shapes are normalized to a flat array of rings
 * (each ring itself an array of [lon,lat] pairs), which is exactly what
 * src/tdx/hsinchuGeoResolver.js's ray-casting check consumes. Validates
 * every ring is closed (first point === last point, standard GeoJSON
 * convention — the `shapefile` package's own shp->geojson conversion
 * already closes rings per the shapefile spec, this just re-confirms it
 * rather than trusting silently) and has at least 4 points (a real
 * polygon, not a degenerate line/point).
 */
function normalizeToRings(geometry) {
  if (!geometry) fail('geometry missing');
  let polygons;
  if (geometry.type === 'Polygon') {
    polygons = [geometry.coordinates];
  } else if (geometry.type === 'MultiPolygon') {
    polygons = geometry.coordinates;
  } else {
    fail(`unexpected geometry type: ${geometry.type}`);
  }

  const rings = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) fail(`degenerate ring (${ring && ring.length} points)`);
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) fail('ring is not closed (first point != last point)');
      for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2) fail('malformed coordinate pair');
        const [lon, lat] = point;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) fail(`non-finite coordinate: [${lon}, ${lat}]`);
        // Sanity bounds — Taiwan's whole territory (main island + outer
        // islands) sits well within this box; catches a gross decode bug
        // (e.g. swapped lon/lat, which would put a Taiwan coordinate at
        // an obviously wrong latitude) without pretending to validate the
        // real Hsinchu-specific shape itself.
        if (lon < 118 || lon > 123 || lat < 20 || lat > 27) {
          fail(`coordinate outside plausible Taiwan bounds: [${lon}, ${lat}]`);
        }
      }
      rings.push(ring);
    }
  }
  if (rings.length === 0) fail('no rings produced');
  return rings;
}

async function main() {
  if (!existsSync(SHP_PATH) || !existsSync(DBF_PATH)) {
    fail(`raw shapefile input not found at ${RAW_DIR} — see raw/README.md`);
  }

  const shpBytes = readFileSync(SHP_PATH);
  const shpSha256 = createHash('sha256').update(shpBytes).digest('hex');

  const source = await shapefile.open(SHP_PATH, DBF_PATH, { encoding: 'utf-8' });
  const features = [];
  let result;
  while (!(result = await source.read()).done) {
    features.push(result.value);
  }
  if (features.length === 0) fail('shapefile produced 0 features');

  const sourceMeta = JSON.parse(readFileSync(SOURCE_META_PATH, 'utf8'));

  // Cross-check the raw shapefile's own SHA-256 against SOURCE_META.json's
  // recorded provenance value — catches a stale/mismatched raw file before
  // it silently gets baked into the generated output.
  if (sourceMeta.provenance && sourceMeta.provenance.stagedShpSha256 && sourceMeta.provenance.stagedShpSha256 !== shpSha256) {
    fail(
      `staged .shp SHA-256 (${shpSha256}) does not match SOURCE_META.json's recorded ` +
        `provenance.stagedShpSha256 (${sourceMeta.provenance.stagedShpSha256}) — the raw file changed without ` +
        `updating SOURCE_META.json, or vice versa. Update SOURCE_META.json to match before regenerating.`
    );
  }

  const counties = {};
  for (const target of TARGETS) {
    const feature = features.find(
      (f) => f.properties && f.properties.COUNTYNAME === target.countyName && f.properties.COUNTYCODE === target.countyCode
    );
    if (!feature) fail(`feature not found: COUNTYNAME=${target.countyName} COUNTYCODE=${target.countyCode}`);
    const rings = normalizeToRings(feature.geometry);
    counties[target.key] = {
      countyName: target.countyName,
      countyCode: target.countyCode,
      countyId: feature.properties.COUNTYID,
      countyEng: feature.properties.COUNTYENG,
      geometryType: feature.geometry.type,
      ringCount: rings.length,
      rings,
    };
  }

  const generatedAt = new Date().toISOString();
  const fileContent = `// AUTO-GENERATED by scripts/updateHsinchuBoundaryData.mjs — do not hand-edit.
// Regenerate with: npm run update:hsinchu-boundary-data
// See data/hsinchu-boundary/raw/README.md and raw/SOURCE_META.json for the
// full provenance record (official source: ${sourceMeta.sourceAgency}，
// ${sourceMeta.sourceName}, data.gov.tw dataset ${sourceMeta.datasetId} —
// downloaded directly by a human and staged verbatim, per
// V2_4_5_OFFICIAL_HSINCHU_BOUNDARY_DATA_HOTFIX_CONTINUE; see
// SOURCE_META.json's own "vintageHonesty" and "geometryDiffCheck" blocks
// for why this specific file, dated ${sourceMeta.provenance.isoMetadataDates.creation}, was adopted).
//
// Coordinates are [longitude, latitude] pairs, ${sourceMeta.sourceCrs} as
// published by the source — see SOURCE_META.json's own "notes" for this
// project's documented CRS determination (no transformation applied; TWD97
// and WGS84 differ by centimeters for Taiwan, far below TDX's own position
// accuracy). Each county's "rings" is a flat array of closed linear rings
// (already flattened from GeoJSON Polygon/MultiPolygon — see
// scripts/updateHsinchuBoundaryData.mjs's own normalizeToRings()); a point
// is inside the county if it is inside an odd number of these rings under
// standard ray-casting (src/tdx/hsinchuGeoResolver.js's own
// isPointInRings()) — this matters because 新竹縣's real shape can include
// an interior hole/enclave; do not "simplify" this into "any single ring".
export const HSINCHU_BOUNDARY_METADATA = {
  sourceAgency: ${JSON.stringify(sourceMeta.sourceAgency)},
  sourceName: ${JSON.stringify(sourceMeta.sourceName)},
  sourceUrl: ${JSON.stringify(sourceMeta.sourceUrl)},
  datasetId: ${JSON.stringify(sourceMeta.datasetId)},
  sourceCrs: ${JSON.stringify(sourceMeta.sourceCrs)},
  shapefileBaseName: ${JSON.stringify(sourceMeta.provenance.shapefileBaseName)},
  isoMetadataCreationDate: ${JSON.stringify(sourceMeta.provenance.isoMetadataDates.creation)},
  rawShpSha256: ${JSON.stringify(shpSha256)},
  generatedAt: ${JSON.stringify(generatedAt)},
};

export const HSINCHU_CITY = ${JSON.stringify(counties.HSINCHU_CITY, null, 2)};

export const HSINCHU_COUNTY = ${JSON.stringify(counties.HSINCHU_COUNTY, null, 2)};
`;

  const tmpPath = `${GENERATED_PATH}.tmp`;
  writeFileSync(tmpPath, fileContent, 'utf8');
  renameSync(tmpPath, GENERATED_PATH);

  console.log(`wrote ${path.relative(ROOT, GENERATED_PATH)}`);
  for (const target of TARGETS) {
    const c = counties[target.key];
    console.log(`  ${c.countyName} (${c.countyId}/${c.countyCode}): ${c.geometryType}, ${c.ringCount} ring(s), ${c.rings.map((r) => r.length).join('+')} points`);
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
