import { readFileSync } from 'node:fs';

const boundary = JSON.parse(readFileSync(
  new URL('../data/hsinchu-city-county-boundary.geojson', import.meta.url),
  'utf8',
));

function pointOnSegment([x, y], [ax, ay], [bx, by]) {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (x - ax) * (x - bx) + (y - ay) * (y - by);
  return dot <= 1e-10;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    if (pointOnSegment(point, ring[j], ring[i])) return true;
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, rings) {
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

function pointInGeometry(point, geometry) {
  if (geometry?.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

export function findHsinchuAdministrativeArea(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const feature = boundary.features.find((candidate) => (
    pointInGeometry([longitude, latitude], candidate.geometry)
  ));
  return feature?.properties?.COUNTYNAME || null;
}

export const HSINCHU_BOUNDARY_SOURCE = Object.freeze({
  agency: 'National Science and Technology Center for Disaster Reduction',
  layer: 'WMS627/AdministrativeRegion/MapServer/1 (縣市界2024)',
  sourceAuthority: 'Ministry of the Interior county/city boundary data',
  spatialReference: 'EPSG:4326',
  includedAreas: ['新竹市', '新竹縣'],
});
