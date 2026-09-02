#!/usr/bin/env node
// V2.4.5 — deterministic importer: raw/counties-10t.json -> generated/hsinchuBoundary.js.
//
// Run via `npm run update:hsinchu-boundary-data`. Reads
// data/hsinchu-boundary/raw/counties-10t.json (see raw/README.md for the
// exact input contract and provenance), decodes the TopoJSON, extracts
// ONLY the 新竹市/新竹縣 county-level polygons, validates them, and
// atomically replaces data/hsinchu-boundary/generated/hsinchuBoundary.js —
// the ONLY file src/tdx/hsinchuGeoResolver.js actually reads at runtime
// (bundled with the Worker, zero runtime fetches, zero runtime dependency
// on topojson-client — this script is the only consumer of that package).
//
// Design rules this script must never violate (same discipline as
// scripts/updateRoadLocationData.mjs):
//   - A missing/malformed Hsinchu feature is a hard failure (non-zero
//     exit, no file written) — never silently write an incomplete dataset.
//   - The generated file is only written after BOTH features (新竹市,
//     新竹縣) decode successfully in memory; the write is atomic (temp
//     path, then rename).
//   - Coordinates are copied through exactly as topojson-client decodes
//     them — no simplification, no rounding, no manual editing.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as topojson from 'topojson-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_PATH = path.join(ROOT, 'data', 'hsinchu-boundary', 'raw', 'counties-10t.json');
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
 * every ring is closed (first point === last point, standard GeoJSON/
 * TopoJSON convention) and has at least 4 points (a real polygon, not a
 * degenerate line/point).
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

function main() {
  if (!existsSync(RAW_PATH)) {
    fail(`raw input not found: ${RAW_PATH} — see raw/README.md`);
  }

  const rawBytes = readFileSync(RAW_PATH);
  const rawSha256 = createHash('sha256').update(rawBytes).digest('hex');
  const topology = JSON.parse(rawBytes.toString('utf8'));
  if (topology.type !== 'Topology') fail(`raw file is not a TopoJSON Topology (type=${topology.type})`);
  if (!topology.objects || !topology.objects.counties) fail('raw file has no objects.counties');

  const featureCollection = topojson.feature(topology, topology.objects.counties);
  if (!featureCollection || !Array.isArray(featureCollection.features)) {
    fail('topojson.feature() did not produce a FeatureCollection');
  }

  const sourceMeta = JSON.parse(readFileSync(SOURCE_META_PATH, 'utf8'));

  const counties = {};
  for (const target of TARGETS) {
    const feature = featureCollection.features.find(
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
// full provenance record (official source: 內政部國土測繪中心，
// 直轄市、縣市界線（TWD97經緯度）, data.gov.tw dataset 7442 — redistributed
// verbatim via the npm package taiwan-atlas@${sourceMeta.redistribution.npmVersion}).
//
// Coordinates are [longitude, latitude] pairs, TWD97 經緯度 (EPSG:3824) as
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
  npmPackage: ${JSON.stringify(sourceMeta.redistribution.npmPackage)},
  npmVersion: ${JSON.stringify(sourceMeta.redistribution.npmVersion)},
  npmTarballShasum: ${JSON.stringify(sourceMeta.redistribution.npmTarballShasum)},
  rawFileSha256: ${JSON.stringify(rawSha256)},
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

main();
